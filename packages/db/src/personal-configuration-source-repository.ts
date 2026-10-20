import type pg from "pg";
import {
  PdsConfigurationCompatibilityError,
  type PersonalSourceContextSnapshot
} from "@koed/shared";
import { lockPersonalConfigurationGroup } from "./personal-configuration-authority.js";
import { readPersonalSourceBinding } from "./personal-source-binding-state.js";
import { readBoundPersonalSourceContextSnapshot } from "./personal-source-context-snapshot.js";
import { preparePersonalSourceContextSnapshot } from "./personal-source-context-export.js";

/** Candidate paging continues independently of capture and never depends on provider path identity. */
export const createPersonalConfigurationSourceRepository = (pool: pg.Pool) => ({
  async listPersonalConfigurationSourceSnapshots(input: {
    userId: string;
    groupId: string;
    originatingDeploymentId: string;
    authorDeviceId: string;
    authorSigningKeyId: string;
    expectedEpoch: string;
    expectedAuthorityHead: string;
    afterSessionId?: string;
    limit?: number;
  }): Promise<{
    snapshots: PersonalSourceContextSnapshot[];
    nextSessionId: string | null;
  }> {
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
        "select 1 from personal_sync_policies where group_id=$1 and enabled=true and publication_paused=false and enabled_at is not null and enabled_at<=now() for share",
        [group.id]
      );
      if (!policy.rowCount) {
        await client.query("commit");
        return { snapshots: [], nextSessionId: null };
      }
      const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
      const rows = await client.query<{ id: string }>(
        `select s.id from sessions s left join personal_source_bindings b on b.owner_user_id=s.owner_user_id and b.local_session_id=s.id
         where s.owner_user_id=$1 and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
          and ($2::uuid is null or s.id>$2) and (
            (b.context_version=1 and b.availability='available' and (
              b.originating_device_id=$3 or exists(select 1 from personal_source_context_revisions c where c.binding_id=b.binding_id and c.local_change_revision_id is not null)
            )) or (b.binding_id is null and exists(select 1 from personal_source_context_changes c where c.owner_user_id=s.owner_user_id and c.logical_session_id=s.logical_session_id)
              and not exists(select 1 from pds_logical_replicas r where r.local_session_id=s.id))
          ) order by s.id limit $4`,
        [
          input.userId,
          input.afterSessionId ?? null,
          input.authorDeviceId,
          limit
        ]
      );
      const snapshots: PersonalSourceContextSnapshot[] = [];
      for (const row of rows.rows) {
        await client.query("savepoint personal_source_snapshot");
        try {
          const binding = await readPersonalSourceBinding(
            client,
            input.userId,
            row.id,
            true
          );
          snapshots.push(
            binding
              ? await readBoundPersonalSourceContextSnapshot(client, binding)
              : await preparePersonalSourceContextSnapshot(client, {
                  ownerUserId: input.userId,
                  localSessionId: row.id,
                  originatingDeploymentId: input.originatingDeploymentId,
                  originatingDeviceId: input.authorDeviceId
                })
          );
          await client.query("release savepoint personal_source_snapshot");
        } catch (error) {
          await client.query("rollback to savepoint personal_source_snapshot");
          await client.query("release savepoint personal_source_snapshot");
          if (!(error instanceof PdsConfigurationCompatibilityError))
            throw error;
          // A conflict or a legacy edit remains pending without blocking other sources.
        }
      }
      await client.query("commit");
      return {
        snapshots,
        nextSessionId: rows.rows.length === limit ? rows.rows.at(-1)!.id : null
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
});
