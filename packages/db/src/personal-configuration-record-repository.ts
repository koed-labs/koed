import { applyVerifiedConfigurationProjectDefault } from "./personal-configuration-project-defaults.js";
import { retainPersonalMembershipLocalDevice } from "./personal-membership-local-device.js";
import {
  applyVerifiedConfigurationMembership,
  type PersonalConfigurationLocalDevice
} from "./personal-configuration-membership.js";
import type pg from "pg";
import {
  personalConfigurationRecordSchema,
  personalConfigurationRecordHash,
  personalOwnerIdSchema,
  type PersonalConfigurationRecord
} from "@koed/shared";
import {
  lockPersonalConfigurationGroup,
  verifyCurrentPersonalConfigurationAuthor
} from "./personal-configuration-authority.js";
import { applyVerifiedConfigurationSourceContext } from "./personal-configuration-source.js";

type Scope = { userId: string; groupId: string };
/** Encrypted signed archives survive delivery and replay; plaintext is never stored in this journal. */
export const createPersonalConfigurationRecordRepository = (pool: pg.Pool) => ({
  async retainPersonalConfiguration(
    input: Scope & {
      record: PersonalConfigurationRecord;
      encryptedEnvelope: unknown;
      direction: "local" | "inbound";
      localDevice?: PersonalConfigurationLocalDevice;
      expectedEpoch?: string;
      expectedAuthorityHead?: string;
    }
  ): Promise<{ id: string; applied: boolean; recordHash: string }> {
    const record = personalConfigurationRecordSchema.parse(input.record),
      hash = personalConfigurationRecordHash(record);
    const userId = personalOwnerIdSchema.parse(input.userId),
      client = await pool.connect();
    try {
      await client.query("begin");
      const group = await lockPersonalConfigurationGroup(client, {
        ...input,
        userId
      });
      if (
        (input.expectedEpoch !== undefined &&
          group.current_epoch !== input.expectedEpoch) ||
        (input.expectedAuthorityHead !== undefined &&
          group.head_hash !== input.expectedAuthorityHead)
      )
        throw new TypeError("PdsCryptoConfigurationLifecycleChangedError");
      await verifyCurrentPersonalConfigurationAuthor(client, {
        groupDbId: group.id,
        groupId: input.groupId,
        record
      });
      if (
        record.revision.payload.kind !== "source_context" &&
        input.localDevice
      ) {
        const local = await client.query(
          "select 1 from personal_device_group_members where group_id=$1 and device_id=$2 and signing_key_id=$3 and status='active' for share",
          [group.id, input.localDevice.deviceId, input.localDevice.signingKeyId]
        );
        if (
          !local.rowCount ||
          (input.direction === "local" &&
            (record.revision.authorDeviceId !== input.localDevice.deviceId ||
              record.revision.authorSigningKeyId !==
                input.localDevice.signingKeyId))
        )
          throw new TypeError(
            "PdsCryptoConfigurationLocalDeviceAuthorityError"
          );
      }
      if (
        record.revision.payload.kind !== "source_context" &&
        input.localDevice
      )
        await retainPersonalMembershipLocalDevice(
          client,
          userId,
          input.localDevice
        );
      const inserted = await client.query<{
        id: string;
        record_hash: string;
        direction: string;
        application_state: string;
      }>(
        `insert into personal_configuration_records(owner_user_id,group_id,author_device_id,author_signing_key_id,record_id,record_hash,payload_kind,direction,encrypted_envelope)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict(group_id,author_device_id,record_id) do update set updated_at=personal_configuration_records.updated_at
        returning id,record_hash,direction,application_state`,
        [
          userId,
          group.id,
          record.revision.authorDeviceId,
          record.revision.authorSigningKeyId,
          record.revision.recordId,
          hash,
          record.revision.payload.kind,
          input.direction,
          input.encryptedEnvelope
        ]
      );
      const retained = inserted.rows[0]!;
      if (retained.record_hash !== hash)
        throw new TypeError("PdsCryptoConfigurationEquivocationError");
      let applied = retained.application_state === "applied";
      const policy = await client.query(
        "select 1 from personal_sync_policies where group_id=$1 and enabled=true and enabled_at is not null and enabled_at<=now() for share",
        [group.id]
      );
      if (!applied) {
        const apply =
          record.revision.payload.kind === "source_context"
            ? applyVerifiedConfigurationSourceContext
            : record.revision.payload.kind === "project_membership"
              ? applyVerifiedConfigurationMembership
              : applyVerifiedConfigurationProjectDefault;
        const result = await apply(client, {
          ownerUserId: userId,
          record,
          recordHash: hash,
          localDevice: input.localDevice,
          allowApplication: Boolean(policy.rowCount)
        });
        applied = result.applied;
        await client.query(
          "update personal_configuration_records set source_binding_id=$2,application_state=$3,updated_at=now() where id=$1",
          [retained.id, result.bindingId, applied ? "applied" : "pending"]
        );
      }
      // A received record never becomes a locally authored delivery merely by replay.
      if (input.direction === "local" && retained.direction === "local") {
        const queued = await client.query(
          `insert into personal_configuration_outbox(record_row_id,dispatch_epoch) values($1,$2)
           on conflict(record_row_id) do nothing returning id`,
          [retained.id, group.current_epoch]
        );
        if (queued.rowCount)
          await client.query(
            "select pg_notify('koed_pds_local_sync','personal_configuration_changed')"
          );
      }
      await client.query("commit");
      return { id: retained.id, applied, recordHash: hash };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },
  async deferPendingPersonalConfiguration(
    input: Scope & { id: string; recordHash: string }
  ): Promise<void> {
    await pool.query(
      `update personal_configuration_records r set retry_at=now()+interval '30 seconds',attempt_count=attempt_count+1,updated_at=now()
       from personal_device_groups g,local_personal_identities i where g.id=r.group_id and i.id=g.local_personal_identity_id
         and r.id=$1 and r.record_hash=$2 and r.owner_user_id=$3 and i.owner_user_id=$3 and g.group_id=$4 and r.application_state='pending'`,
      [input.id, input.recordHash, input.userId, input.groupId]
    );
  },
  async hasLocalPersonalConfiguration(
    input: Scope & { recordHash: string }
  ): Promise<boolean> {
    const result = await pool.query(
      `select 1 from personal_configuration_records r join personal_device_groups g on g.id=r.group_id
       join local_personal_identities i on i.id=g.local_personal_identity_id
       where r.owner_user_id=$1 and i.owner_user_id=$1 and g.group_id=$2 and r.record_hash=$3 and r.direction='local'`,
      [input.userId, input.groupId, input.recordHash]
    );
    return Boolean(result.rowCount);
  },
  async listPendingPersonalConfiguration(
    input: Scope & { afterId?: string; limit?: number }
  ): Promise<
    Array<{ id: string; recordHash: string; encryptedEnvelope: unknown }>
  > {
    const result = await pool.query<{
      id: string;
      record_hash: string;
      encrypted_envelope: unknown;
    }>(
      `select r.id,r.record_hash,r.encrypted_envelope from personal_configuration_records r
       join personal_device_groups g on g.id=r.group_id join local_personal_identities i on i.id=g.local_personal_identity_id
       join personal_sync_policies p on p.group_id=g.id and p.enabled=true and p.enabled_at is not null and p.enabled_at<=now()
       left join personal_source_bindings b on b.binding_id=r.source_binding_id and b.context_version=1 and b.availability='available'
       left join sessions s on s.id=b.local_session_id and s.owner_user_id=r.owner_user_id and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
       join personal_device_group_members m on m.group_id=g.id and m.device_id=r.author_device_id and m.signing_key_id=r.author_signing_key_id and m.status='active'
       where r.owner_user_id=$1 and i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
         and (r.payload_kind in ('project_membership','project_default') or (r.payload_kind='source_context' and s.id is not null))
         and r.application_state='pending' and r.retry_at<=now() and ($3::uuid is null or r.id>$3)
       order by r.id limit $4`,
      [
        input.userId,
        input.groupId,
        input.afterId ?? null,
        Math.max(1, Math.min(input.limit ?? 50, 100))
      ]
    );
    return result.rows.map((row) => ({
      id: row.id,
      recordHash: row.record_hash,
      encryptedEnvelope: row.encrypted_envelope
    }));
  }
});
