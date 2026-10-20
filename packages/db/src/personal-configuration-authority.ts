import type pg from "pg";
import {
  verifyPersonalConfigurationRecord,
  type PersonalConfigurationRecord
} from "@koed/shared";
import { lockPersonalSourceContextOwner } from "./personal-source-binding-state.js";

export const lockPersonalConfigurationGroup = async (
  client: pg.PoolClient,
  input: { userId: string; groupId: string }
) => {
  await lockPersonalSourceContextOwner(client, input.userId);
  const group = await client.query<{
    id: string;
    current_epoch: string;
    head_hash: string;
  }>(
    `select g.id,g.current_epoch,g.head_hash from personal_device_groups g
    join local_personal_identities i on i.id=g.local_personal_identity_id
    join users u on u.id=i.owner_user_id and u.disabled_at is null and u.deleted_at is null
    where i.owner_user_id=$1 and g.group_id=$2 and g.state='active' for update of g`,
    [input.userId, input.groupId]
  );
  if (!group.rows[0])
    throw new TypeError("PdsCryptoConfigurationGroupAuthorityError");
  return group.rows[0];
};
/** Revalidate current local membership inside the mutation, after secure transport verification. */
export const verifyCurrentPersonalConfigurationAuthor = async (
  client: pg.PoolClient,
  input: {
    groupDbId: string;
    groupId: string;
    record: PersonalConfigurationRecord;
  }
) => {
  const author = await client.query<{
    signing_key_id: string;
    signing_public_key: string;
  }>(
    "select signing_key_id,signing_public_key from personal_device_group_members where group_id=$1 and device_id=$2 and status='active' for share",
    [input.groupDbId, input.record.revision.authorDeviceId]
  );
  const current = author.rows[0];
  if (!current)
    throw new TypeError("PdsCryptoConfigurationAuthorAuthorityError");
  return verifyPersonalConfigurationRecord(input.record, {
    groupId: input.groupId,
    deviceId: input.record.revision.authorDeviceId,
    signingKeyId: current.signing_key_id,
    publicKey: current.signing_public_key
  });
};

export type PersonalConfigurationPublicationScope = {
  userId: string;
  groupId: string;
  authorDeviceId: string;
  authorSigningKeyId: string;
  expectedEpoch: string;
  expectedAuthorityHead: string;
};
/** Local candidate preparation uses the current physical device, independently of historical authors. */
export const withPersonalConfigurationPublication = async <T>(
  pool: pg.Pool,
  input: PersonalConfigurationPublicationScope,
  empty: T,
  run: (client: pg.PoolClient) => Promise<T>,
  options: { allowPublicationPause?: boolean } = {}
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const group = await lockPersonalConfigurationGroup(client, input);
    if (
      group.current_epoch !== input.expectedEpoch ||
      group.head_hash !== input.expectedAuthorityHead
    )
      throw new Error("PdsConfigurationLifecycleChangedError");
    const member = await client.query(
      "select 1 from personal_device_group_members where group_id=$1 and device_id=$2 and signing_key_id=$3 and status='active' for share",
      [group.id, input.authorDeviceId, input.authorSigningKeyId]
    );
    if (!member.rowCount)
      throw new TypeError("PdsCryptoConfigurationAuthorAuthorityError");
    const policy = await client.query(
      "select 1 from personal_sync_policies where group_id=$1 and enabled=true and ($2::boolean or publication_paused=false) and enabled_at is not null and enabled_at<=now() for share",
      [group.id, options.allowPublicationPause === true]
    );
    const result = policy.rowCount ? await run(client) : empty;
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};
