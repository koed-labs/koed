import { createHash } from "node:crypto";
import pg from "pg";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

/** Lifecycle ledger stores opaque identifiers only. No source IDs or fingerprints are persisted here. */
export const createPersonalDeviceSyncLifecycleRepository = (pool: pg.Pool) => ({
  async commitPdsTombstone(input: {
    userId: string;
    groupId: string;
    expectedHeadHash: string;
    sequence: string;
    statementHash: string;
    canonicalStatement: string;
    tombstoneHash: string;
    tombstoneSequence: string;
    logicalMemoryId: string;
    deletionFloorToken: string;
    activeDeviceSnapshot: string[];
    issuedAt: Date;
    encryptedRecord: unknown;
    authorizationKeyId: string;
  }): Promise<"accepted" | "idempotent" | "conflict" | "missing"> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        input.groupId
      ]);
      const group = await client.query<{
        id: string;
        head_hash: string;
        head_sequence: string;
      }>(
        `select g.id,g.head_hash,g.head_sequence from personal_device_groups g
         join local_personal_identities i on i.id=g.local_personal_identity_id
         where g.group_id=$1 and i.owner_user_id=$2 and g.state='active' and g.pending_epoch is null for update`,
        [input.groupId, input.userId]
      );
      if (!group.rowCount) {
        await client.query("rollback");
        return "missing";
      }
      const current = group.rows[0]!;
      const existing = await client.query<{ tombstone_hash: string }>(
        "select tombstone_hash from pds_tombstone_ledger where group_id=$1 and deletion_floor_token=$2 for update",
        [current.id, input.deletionFloorToken]
      );
      if (existing.rowCount) {
        await client.query("commit");
        return existing.rows[0]!.tombstone_hash === input.tombstoneHash
          ? "idempotent"
          : "conflict";
      }
      if (
        current.head_hash !== input.expectedHeadHash ||
        BigInt(current.head_sequence) + 1n !== BigInt(input.sequence)
      ) {
        await client.query("rollback");
        return "conflict";
      }
      const updated = await client.query(
        `update personal_device_groups set head_hash=$1,head_sequence=$2,updated_at=now()
         where id=$3 and head_hash=$4 returning id`,
        [
          input.statementHash,
          input.sequence,
          current.id,
          input.expectedHeadHash
        ]
      );
      if (!updated.rowCount) {
        await client.query("rollback");
        return "conflict";
      }
      await client.query(
        `insert into personal_device_group_statements (group_id,sequence,previous_hash,statement_hash,kind,canonical_statement,redacted_metadata)
         values ($1,$2,$3,$4,'tombstone',$5,$6)`,
        [
          current.id,
          input.sequence,
          input.expectedHeadHash,
          input.statementHash,
          input.canonicalStatement,
          {
            protocol: "koed/pds/v1",
            kind: "tombstone",
            sequence: input.sequence,
            groupIdHash: hash(input.groupId),
            actorKeyId: input.authorizationKeyId
          }
        ]
      );
      const ledger = await client.query<{ id: string }>(
        `insert into pds_tombstone_ledger
         (group_id,logical_memory_id,deletion_floor_token,tombstone_hash,tombstone_sequence,statement_hash,encrypted_record,active_device_snapshot,issued_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) returning id`,
        [
          current.id,
          input.logicalMemoryId,
          input.deletionFloorToken,
          input.tombstoneHash,
          input.tombstoneSequence,
          input.statementHash,
          JSON.stringify(input.encryptedRecord),
          input.activeDeviceSnapshot,
          input.issuedAt
        ]
      );
      await client.query(
        `insert into pds_deletion_floors (group_id,logical_memory_id,deletion_floor_token,tombstone_hash)
         values ($1,$2,$3,$4)`,
        [
          current.id,
          input.logicalMemoryId,
          input.deletionFloorToken,
          input.tombstoneHash
        ]
      );
      await client.query(
        `insert into personal_device_group_audit_events (group_id,transition_kind,actor_key_id,outcome,head_sequence,head_hash)
         values ($1,'tombstone',$2,'accepted',$3,$4)`,
        [
          current.id,
          input.authorizationKeyId,
          input.sequence,
          input.statementHash
        ]
      );
      await client.query("commit");
      void ledger;
      return "accepted";
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getPdsDeletionFloors(input: { userId: string; groupId: string }) {
    const result = await pool.query<{
      logical_memory_id: string;
      deletion_floor_token: string;
      tombstone_hash: string;
    }>(
      `select f.logical_memory_id,f.deletion_floor_token,f.tombstone_hash from pds_deletion_floors f
       join personal_device_groups g on g.id=f.group_id join local_personal_identities i on i.id=g.local_personal_identity_id
       where i.owner_user_id=$1 and g.group_id=$2 order by f.created_at`,
      [input.userId, input.groupId]
    );
    return result.rows.map((item) => ({
      logicalMemoryId: item.logical_memory_id,
      deletionFloorToken: item.deletion_floor_token,
      tombstoneHash: item.tombstone_hash
    }));
  },

  async getPdsLifecycleForRelay(input: { groupDbId: string; groupId: string }) {
    const result = await pool.query<{
      logical_memory_id: string;
      deletion_floor_token: string;
      tombstone_hash: string;
    }>(
      `select f.logical_memory_id,f.deletion_floor_token,f.tombstone_hash from pds_deletion_floors f
       join personal_device_groups g on g.id=f.group_id where g.id=$1 and g.group_id=$2 order by f.created_at`,
      [input.groupDbId, input.groupId]
    );
    return result.rows.map((item) => ({
      logicalMemoryId: item.logical_memory_id,
      deletionFloorToken: item.deletion_floor_token,
      tombstoneHash: item.tombstone_hash
    }));
  },

  async getPdsTombstoneAckBinding(input: {
    groupDbId: string;
    tombstoneHash: string;
  }) {
    const result = await pool.query<{ statement_hash: string }>(
      "select statement_hash from pds_tombstone_ledger where group_id=$1 and tombstone_hash=$2",
      [input.groupDbId, input.tombstoneHash]
    );
    return result.rows[0] ?? null;
  },

  async acknowledgePdsTombstone(input: {
    userId?: string;
    groupId: string;
    groupDbId?: string;
    tombstoneHash: string;
    deviceId: string;
    canonicalAck: string;
    ackedAt: Date;
  }): Promise<"accepted" | "idempotent" | "missing"> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        input.groupId
      ]);
      const found = await client.query<{
        id: string;
        active_device_snapshot: string[];
      }>(
        `select t.id,t.active_device_snapshot from pds_tombstone_ledger t join personal_device_groups g on g.id=t.group_id
         left join local_personal_identities i on i.id=g.local_personal_identity_id
         where g.group_id=$1 and t.tombstone_hash=$2 and ($3::uuid is null or i.owner_user_id=$3)
           and ($4::uuid is null or g.id=$4) for update`,
        [
          input.groupId,
          input.tombstoneHash,
          input.userId ?? null,
          input.groupDbId ?? null
        ]
      );
      if (
        !found.rowCount ||
        !found.rows[0]!.active_device_snapshot.includes(input.deviceId)
      ) {
        await client.query("rollback");
        return "missing";
      }
      const ackHash = hash(input.canonicalAck);
      const inserted = await client.query(
        `insert into pds_tombstone_acks (tombstone_id,device_id,canonical_ack,ack_hash,acked_at)
         values ($1,$2,$3,$4,$5) on conflict (tombstone_id,device_id) do nothing`,
        [
          found.rows[0]!.id,
          input.deviceId,
          input.canonicalAck,
          ackHash,
          input.ackedAt
        ]
      );
      if (!inserted.rowCount) {
        const prior = await client.query<{ ack_hash: string }>(
          "select ack_hash from pds_tombstone_acks where tombstone_id=$1 and device_id=$2",
          [found.rows[0]!.id, input.deviceId]
        );
        await client.query("commit");
        return prior.rows[0]?.ack_hash === ackHash ? "idempotent" : "missing";
      }
      const pending = await client.query<{ count: string }>(
        `select count(*)::text as count from unnest($2::text[]) device_id
         left join pds_tombstone_acks a on a.tombstone_id=$1 and a.device_id=device_id
         where a.acked_at is null and a.waived_at is null`,
        [found.rows[0]!.id, found.rows[0]!.active_device_snapshot]
      );
      if (pending.rows[0]!.count === "0")
        await client.query(
          "update pds_tombstone_ledger set quorum_completed_at=coalesce(quorum_completed_at,now()),retain_until=coalesce(retain_until,now()+interval '30 days') where id=$1",
          [found.rows[0]!.id]
        );
      await client.query("commit");
      return "accepted";
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async resolvePdsConflict(input: {
    userId: string;
    groupId: string;
    sourceFingerprint: string;
    resolutionHash: string;
    statementHash: string;
    expectedHeadHash: string;
    sequence: string;
    canonicalStatement: string;
    authorizationKeyId: string;
    resolution: "select" | "distinct";
    selectedClosureHash: string | null;
    candidateClosureHashes: string[];
    canonicalRecord: string;
    issuedAt: Date;
  }): Promise<"accepted" | "idempotent" | "missing"> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        input.groupId
      ]);
      const group = await client.query<{
        id: string;
        head_hash: string;
        head_sequence: string;
      }>(
        `select g.id,g.head_hash,g.head_sequence from personal_device_groups g join local_personal_identities i on i.id=g.local_personal_identity_id
         where g.group_id=$1 and i.owner_user_id=$2 and g.state='active' and g.pending_epoch is null for update`,
        [input.groupId, input.userId]
      );
      if (!group.rowCount) {
        await client.query("rollback");
        return "missing";
      }
      if (
        group.rows[0]!.head_hash !== input.expectedHeadHash ||
        BigInt(group.rows[0]!.head_sequence) + 1n !== BigInt(input.sequence)
      ) {
        await client.query("rollback");
        return "missing";
      }
      const existing = await client.query<{ resolution_hash: string }>(
        "select resolution_hash from pds_conflict_resolution_records where group_id=$1 and source_fingerprint=$2 for update",
        [group.rows[0]!.id, input.sourceFingerprint]
      );
      if (existing.rowCount) {
        await client.query("commit");
        return existing.rows[0]!.resolution_hash === input.resolutionHash
          ? "idempotent"
          : "missing";
      }
      const variants = await client.query<{ closure_hash: string }>(
        "select closure_hash from pds_logical_replicas where group_id=$1 and source_fingerprint=$2 for update",
        [group.rows[0]!.id, input.sourceFingerprint]
      );
      const observed = variants.rows.map((item) => item.closure_hash).sort();
      if (
        JSON.stringify(observed) !==
        JSON.stringify([...input.candidateClosureHashes].sort())
      )
        throw new Error(
          "PDS conflict candidates no longer match observed closures"
        );
      const advanced = await client.query(
        "update personal_device_groups set head_hash=$1,head_sequence=$2,updated_at=now() where id=$3 and head_hash=$4 returning id",
        [
          input.statementHash,
          input.sequence,
          group.rows[0]!.id,
          input.expectedHeadHash
        ]
      );
      if (!advanced.rowCount) {
        await client.query("rollback");
        return "missing";
      }
      await client.query(
        `insert into personal_device_group_statements (group_id,sequence,previous_hash,statement_hash,kind,canonical_statement,redacted_metadata)
         values ($1,$2,$3,$4,'resolve-conflict',$5,$6)`,
        [
          group.rows[0]!.id,
          input.sequence,
          input.expectedHeadHash,
          input.statementHash,
          input.canonicalStatement,
          {
            protocol: "koed/pds/v1",
            kind: "resolve-conflict",
            sequence: input.sequence,
            groupIdHash: hash(input.groupId),
            actorKeyId: input.authorizationKeyId
          }
        ]
      );
      await client.query(
        `insert into pds_conflict_resolution_records (group_id,source_fingerprint,resolution_hash,statement_hash,resolution,selected_closure_hash,candidate_closure_hashes,canonical_record,issued_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          group.rows[0]!.id,
          input.sourceFingerprint,
          input.resolutionHash,
          input.statementHash,
          input.resolution,
          input.selectedClosureHash,
          input.candidateClosureHashes,
          input.canonicalRecord,
          input.issuedAt
        ]
      );
      await client.query(
        `update pds_conflicts set state='resolved',resolution_statement_hash=$3,resolved_at=now() where group_id=$1 and source_fingerprint=$2`,
        [group.rows[0]!.id, input.sourceFingerprint, input.statementHash]
      );
      if (input.resolution === "select") {
        await client.query(
          `update pds_logical_replicas set materialization_state=case when closure_hash=$3 then 'processing' else 'quarantined' end,conflict_id=null,updated_at=now()
           where group_id=$1 and source_fingerprint=$2`,
          [
            group.rows[0]!.id,
            input.sourceFingerprint,
            input.selectedClosureHash
          ]
        );
      } else {
        await client.query(
          `update pds_logical_replicas set materialization_state='processing',conflict_id=null,updated_at=now()
           where group_id=$1 and source_fingerprint=$2`,
          [group.rows[0]!.id, input.sourceFingerprint]
        );
      }
      await client.query("commit");
      return "accepted";
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async reconcilePdsRestore(input: {
    groupId: string;
    deviceId: string;
    authorityHead: string;
    authoritySequence: string;
    lifecycleHighWater: string;
  }) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        input.groupId
      ]);
      const prior = await client.query<{
        authority_sequence: string;
        lifecycle_high_water: string;
        restore_high_water: string;
      }>(
        `select authority_sequence,lifecycle_high_water,restore_high_water from pds_replica_lifecycle_state s
         join personal_device_groups g on g.id=s.group_id where g.group_id=$1 and s.device_id=$2 for update`,
        [input.groupId, input.deviceId]
      );
      const rollback =
        prior.rowCount &&
        (BigInt(input.authoritySequence) <
          BigInt(prior.rows[0]!.authority_sequence) ||
          BigInt(input.lifecycleHighWater) <
            BigInt(prior.rows[0]!.lifecycle_high_water));
      const group = await client.query<{ id: string }>(
        "select id from personal_device_groups where group_id=$1",
        [input.groupId]
      );
      if (!group.rowCount) throw new Error("PDS group is unavailable");
      const outcome = rollback ? "rollback_rejected" : "accepted";
      await client.query(
        `insert into pds_restore_reconciliations (group_id,device_id,authority_head,authority_sequence,lifecycle_high_water,outcome)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          group.rows[0]!.id,
          input.deviceId,
          input.authorityHead,
          input.authoritySequence,
          input.lifecycleHighWater,
          outcome
        ]
      );
      if (!rollback)
        await client.query(
          `insert into pds_replica_lifecycle_state (group_id,device_id,authority_head,authority_sequence,lifecycle_high_water,restore_high_water)
         values ($1,$2,$3,$4,$5,$5) on conflict (group_id,device_id) do update set authority_head=excluded.authority_head,authority_sequence=excluded.authority_sequence,lifecycle_high_water=excluded.lifecycle_high_water,restore_high_water=greatest(pds_replica_lifecycle_state.restore_high_water::numeric,excluded.restore_high_water::numeric)::text,updated_at=now()`,
          [
            group.rows[0]!.id,
            input.deviceId,
            input.authorityHead,
            input.authoritySequence,
            input.lifecycleHighWater
          ]
        );
      await client.query("commit");
      return { accepted: !rollback };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
});

export type PersonalDeviceSyncLifecycleRepository = ReturnType<
  typeof createPersonalDeviceSyncLifecycleRepository
>;
