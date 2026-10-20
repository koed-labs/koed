import type pg from "pg";
import { lockPersonalConfigurationGroup } from "./personal-configuration-authority.js";

type Scope = {
  userId: string;
  groupId: string;
  authorDeviceId: string;
  authorSigningKeyId: string;
  expectedEpoch: string;
  expectedAuthorityHead: string;
};
type Lease = { workerId: string; outboxId: string };
export const createPersonalConfigurationDeliveryRepository = (
  pool: pg.Pool
) => ({
  async deferPersonalConfigurationDelivery(
    input: Pick<
      Scope,
      "userId" | "groupId" | "authorDeviceId" | "authorSigningKeyId"
    >
  ): Promise<void> {
    await pool.query(
      `update personal_configuration_outbox o set retry_at=greatest(o.retry_at,now()+interval '30 seconds'),updated_at=now()
       from personal_configuration_records r,personal_device_groups g,local_personal_identities i
       where r.id=o.record_row_id and g.id=r.group_id and i.id=g.local_personal_identity_id
       and r.owner_user_id=$1 and i.owner_user_id=$1 and g.group_id=$2 and r.author_device_id=$3 and r.author_signing_key_id=$4
       and o.state in ('pending','committed') and (o.lease_until is null or o.lease_until<=now())`,
      [
        input.userId,
        input.groupId,
        input.authorDeviceId,
        input.authorSigningKeyId
      ]
    );
  },
  async claimPersonalConfigurationDelivery(
    input: Scope & { workerId: string; limit?: number }
  ): Promise<
    Array<{
      id: string;
      recordHash: string;
      encryptedEnvelope: unknown;
      state: "pending" | "committed";
      transportId: string | null;
      attemptCount: number;
    }>
  > {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const group = await lockPersonalConfigurationGroup(client, input);
      if (
        group.current_epoch !== input.expectedEpoch ||
        group.head_hash !== input.expectedAuthorityHead
      )
        throw new Error("PdsConfigurationLifecycleChangedError");
      const policy = await client.query(
        "select 1 from personal_sync_policies where group_id=$1 and enabled=true and publication_paused=false and enabled_at is not null and enabled_at<=now() for share",
        [group.id]
      );
      if (!policy.rowCount) {
        await client.query("commit");
        return [];
      }
      const member = await client.query(
        "select 1 from personal_device_group_members where group_id=$1 and device_id=$2 and signing_key_id=$3 and status='active' for share",
        [group.id, input.authorDeviceId, input.authorSigningKeyId]
      );
      if (!member.rowCount)
        throw new TypeError("PdsCryptoConfigurationAuthorAuthorityError");
      await client.query(
        `update personal_configuration_outbox o set state='superseded',lease_owner=null,lease_until=null,updated_at=now()
         from personal_configuration_records r where r.id=o.record_row_id and r.group_id=$1 and r.author_device_id=$2
           and r.author_signing_key_id<>$3 and o.state<>'superseded'`,
        [group.id, input.authorDeviceId, input.authorSigningKeyId]
      );
      await client.query(
        `update personal_configuration_outbox o set state='pending',dispatch_epoch=$2,transport_id=null,retry_at=now(),lease_owner=null,lease_until=null,updated_at=now()
         from personal_configuration_records r where r.id=o.record_row_id and r.group_id=$1 and r.author_device_id=$3
         and r.author_signing_key_id=$4 and o.dispatch_epoch<>$2 and (o.lease_until is null or o.lease_until<=now())`,
        [
          group.id,
          group.current_epoch,
          input.authorDeviceId,
          input.authorSigningKeyId
        ]
      );
      const result = await client.query<{
        id: string;
        record_hash: string;
        encrypted_envelope: unknown;
        state: "pending" | "committed";
        transport_id: string | null;
        attempt_count: number;
      }>(
        `with selected as(
          select o.id from personal_configuration_outbox o join personal_configuration_records r on r.id=o.record_row_id
          where r.group_id=$1 and r.owner_user_id=$2 and r.direction='local' and r.author_device_id=$3 and r.author_signing_key_id=$4
            and o.state in ('pending','committed') and o.dispatch_epoch=$5 and o.retry_at<=now() and (o.lease_until is null or o.lease_until<=now())
          order by o.retry_at,o.id limit $6 for update of o skip locked
        ) update personal_configuration_outbox o set lease_owner=$7,lease_until=now()+interval '2 minutes',attempt_count=o.attempt_count+1,updated_at=now()
        from selected s,personal_configuration_records r where o.id=s.id and r.id=o.record_row_id
        returning o.id,r.record_hash,r.encrypted_envelope,o.state,o.transport_id,o.attempt_count`,
        [
          group.id,
          input.userId,
          input.authorDeviceId,
          input.authorSigningKeyId,
          group.current_epoch,
          Math.max(1, Math.min(input.limit ?? 20, 100)),
          input.workerId
        ]
      );
      await client.query("commit");
      return result.rows.map((row) => ({
        id: row.id,
        recordHash: row.record_hash,
        encryptedEnvelope: row.encrypted_envelope,
        state: row.state,
        transportId: row.transport_id,
        attemptCount: row.attempt_count
      }));
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },
  async beginPersonalConfigurationDelivery(
    input: Scope & Lease
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const group = await lockPersonalConfigurationGroup(client, input);
      const lease = await client.query(
        `select 1 from personal_configuration_outbox o join personal_configuration_records r on r.id=o.record_row_id
         join personal_sync_policies p on p.group_id=r.group_id
         join personal_device_groups g on g.id=r.group_id
         join personal_device_group_members m on m.group_id=g.id and m.device_id=r.author_device_id and m.signing_key_id=r.author_signing_key_id
         where o.id=$1 and o.lease_owner=$2 and o.lease_until>=now() and r.owner_user_id=$3 and r.group_id=$4
           and r.direction='local' and r.author_device_id=$5 and r.author_signing_key_id=$6 and m.status='active'
           and o.dispatch_epoch=$7 and g.current_epoch=$7 and g.head_hash=$8 and g.state='active'
           and p.enabled=true and p.publication_paused=false and p.enabled_at is not null and p.enabled_at<=now() for share of g,p,m`,
        [
          input.outboxId,
          input.workerId,
          input.userId,
          group.id,
          input.authorDeviceId,
          input.authorSigningKeyId,
          input.expectedEpoch,
          input.expectedAuthorityHead
        ]
      );
      await client.query("commit");
      return Boolean(lease.rowCount);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },
  async settlePersonalConfigurationDelivery(
    input: Lease & {
      state: "pending" | "committed" | "acked";
      transportId?: string;
      retryAt: Date;
    }
  ): Promise<boolean> {
    const result = await pool.query(
      "update personal_configuration_outbox set state=$3,transport_id=$4,retry_at=$5,lease_owner=null,lease_until=null,updated_at=now() where id=$1 and lease_owner=$2 and lease_until>=now()",
      [
        input.outboxId,
        input.workerId,
        input.state,
        input.transportId ?? null,
        input.retryAt
      ]
    );
    return result.rowCount === 1;
  }
});
