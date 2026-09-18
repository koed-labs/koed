import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  createCapturedSessionRepository,
  type CapturedSessionRepository
} from "./captured-session-repository.js";
import {
  createConversationItemRepository,
  type ConversationItemRepositoryOptions
} from "./conversation-item-repository.js";
import type { ConversationItemInput } from "./types.js";
import { invalidateDerivedMemoryForMemoryEvents } from "./derived-memory-invalidation.js";

export type PdsMaterializationState =
  | "pending"
  | "downloading"
  | "verifying"
  | "processing"
  | "ready"
  | "stale"
  | "failed"
  | "quarantined"
  | "revoked";

export interface PdsClosureSource {
  groupDbId: string;
  groupId: string;
  sessionId: string;
  logicalSessionId: string;
  externalSessionId: string;
  forkedFromExternalThreadId: string | null;
  sourceRuntime?: string;
  title?: string;
  sourceAdapter: string;
  sourceAdapterVersion: string;
  sourceCreatedAt: string;
  items: Array<{
    id: string;
    externalItemId: string;
    sourceSequence: number;
    eventTime: string;
    observedAt: string;
    rawJson: unknown;
    rawText: string | null;
    sourceKind: string;
    sourceRecordType: string;
    sourceEventType: string | null;
    metadata: Record<string, unknown>;
  }>;
}

export interface PdsLocalClosureRecord {
  id: string;
  groupId: string;
  sessionId: string;
  sourceSequence: string;
  packageId: string;
  sourceManifestHash: string;
  state: "ready" | "quarantined" | "revoked";
  closedAt: string;
}

export interface PdsClaimedOutboxEntry {
  id: string;
  groupId: string;
  closureId: string;
  packageId: string;
  sourceManifestHash: string;
  attemptCount: number;
}

export interface PdsClaimedCommittedOutboxEntry {
  id: string;
  groupId: string;
  transportId: string;
}

export interface PdsClaimedInboxEntry {
  id: string;
  groupId: string;
  packageId: string;
  sourceManifestHash: string;
  attemptCount: number;
}

export interface PdsCheckpointSessionInput {
  logicalSessionId: string;
  externalSessionId: string;
  forkedFromExternalThreadId?: string;
  sourceKind: string;
  sourceAdapterVersion: string;
  sourceRuntime: Parameters<
    CapturedSessionRepository["createCapturedSession"]
  >[1]["sourceRuntime"];
  sourceTitle?: string;
  captureMethod: "transcript";
  sourceCreatedAt: string;
}

export interface PdsReplicaCheckpointInput {
  version: "1";
  ordinal: string;
  previousClosureHash: string | null;
  itemCount: string;
}

export interface PdsCheckpointConversationItem extends ConversationItemInput {
  sourceSequence: number;
  externalItemId: string;
  sourceHash: string;
}

export interface PdsLocalSyncStatus {
  enabled: boolean;
  paused: boolean;
  workerReady: boolean;
  pendingPublication: number;
  outbox: Record<string, number>;
  inbox: Record<string, number>;
  replicas: Record<string, number>;
  semanticWork: {
    authorityTier: "hosted_personal" | "personal_device_group";
    claims: {
      active: number;
      completed: number;
      expired: number;
      nearestExpirySeconds: number | null;
    };
    lcmIntents: Record<string, number>;
    acceptedArtifacts: number;
  };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const iso = (value: Date): string => value.toISOString();

const mustDecimal = (value: string, name: string): void => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`PDS ${name} must be canonical decimal`);
  }
};

const safeErrorClass = (errorClass: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(errorClass)) {
    throw new TypeError("PDS error class is invalid");
  }
  return errorClass;
};

const recordClosure = (
  row: Record<string, unknown>
): PdsLocalClosureRecord => ({
  id: row.id as string,
  groupId: row.group_id as string,
  sessionId: row.source_session_id as string,
  sourceSequence: row.source_sequence as string,
  packageId: row.package_id as string,
  sourceManifestHash: row.source_manifest_hash as string,
  state: row.state as PdsLocalClosureRecord["state"],
  closedAt: iso(row.closed_at as Date)
});

/** Local data plane. It never accepts PDS private/group keys or plaintext packages. */
export interface PersonalDeviceSyncLocalRepository {
  wakePdsLocalSync(reason: string): Promise<void>;
  getPdsLocalSyncWakeAt(): Promise<string | null>;
  getPdsClosureSource(input: {
    userId: string;
    groupId: string;
    sessionId: string;
  }): Promise<PdsClosureSource | null>;
  /**
   * Holds source Session, items, policy, pause state, and origin sequence in
   * one transaction. Builder failure rolls back sequence allocation too.
   */
  closePdsSourceSession(
    input: PdsCheckpointPublicationInput
  ): Promise<PdsLocalClosureRecord>;
  checkpointPdsSourceSession(
    input: PdsCheckpointPublicationInput
  ): Promise<PdsLocalClosureRecord | null>;
  listPdsCheckpointCandidates(input?: {
    afterSessionId?: string;
  }): Promise<Array<{ userId: string; groupId: string; sessionId: string }>>;
  reservePdsSourceSequence(input: {
    userId: string;
    groupId: string;
    originDeploymentId: string;
    originDeviceId: string;
  }): Promise<string>;
  persistPdsSourceClosure(input: {
    userId: string;
    groupId: string;
    originDeploymentId: string;
    originDeviceId: string;
    sourceSequence: string;
    sessionId: string;
    terminalCursor: string;
    terminalItemCount: string;
    sourceClosureHash: string;
    packageId: string;
    sourceManifestHash: string;
    encryptedEnvelope: unknown;
    closedAt: Date;
  }): Promise<PdsLocalClosureRecord>;
  claimPdsOutbox(input: {
    workerId: string;
    limit?: number;
    leaseSeconds?: number;
  }): Promise<PdsClaimedOutboxEntry[]>;
  claimPdsCommittedOutbox(input: {
    workerId: string;
    limit?: number;
    leaseSeconds?: number;
  }): Promise<PdsClaimedCommittedOutboxEntry[]>;
  beginPdsOutboxNetworkAction(input: {
    workerId: string;
    outboxId: string;
  }): Promise<boolean>;
  renewPdsOutboxLease(input: {
    workerId: string;
    outboxId: string;
    leaseSeconds?: number;
  }): Promise<boolean>;
  completePdsOutbox(input: {
    workerId: string;
    outboxId: string;
    state: "committed" | "acked" | "paused";
    transportId?: string;
  }): Promise<boolean>;
  releasePdsCommittedOutbox(input: {
    workerId: string;
    outboxId: string;
  }): Promise<boolean>;
  requeuePdsExpiredCheckpointOutbox(input: {
    workerId: string;
    outboxId: string;
    transportId: string;
  }): Promise<boolean>;
  retryPdsOutbox(input: {
    workerId: string;
    outboxId: string;
    errorClass: string;
    retryAt: Date;
  }): Promise<boolean>;
  receivePdsInbox(input: {
    userId: string;
    groupId: string;
    packageId: string;
    sourceManifestHash: string;
    transportId?: string;
  }): Promise<"new" | "idempotent" | "quarantined">;
  getPdsOutboxEncryptedEnvelope(input: {
    workerId: string;
    outboxId: string;
  }): Promise<{
    groupId: string;
    userId: string;
    encryptedEnvelope: unknown;
  } | null>;
  getPdsInboundTransport(input: {
    groupId: string;
    packageId: string;
  }): Promise<string | null>;
  claimPdsInbox(input: {
    workerId: string;
    limit?: number;
    leaseSeconds?: number;
  }): Promise<PdsClaimedInboxEntry[]>;
  applyPdsDeletionFloors(input: {
    userId: string;
    groupId: string;
    floors: Array<{ logicalMemoryId: string; deletionFloorToken: string }>;
  }): Promise<number>;
  retainPdsInboundPackage(input: {
    userId: string;
    groupId: string;
    inboxId: string;
    packageId: string;
    sourceManifestHash: string;
    originDeploymentId: string;
    originDeviceId: string;
    sourceSequence: string;
    logicalMemoryId?: string;
    deletionFloorToken?: string;
    sourceProfile?: "closed_v1" | "cumulative_checkpoint";
    sourceFingerprint?: string;
    sourceClosureHash?: string;
    checkpoint?: PdsReplicaCheckpointInput;
    encryptedEnvelope: unknown;
  }): Promise<{ retainedPackageId: string; state: PdsMaterializationState }>;
  materializePdsReplica(input: {
    workerId: string;
    inboxId: string;
    userId: string;
    groupId: string;
    retainedPackageId: string;
    localSessionId: string;
    sourceFingerprint: string | null;
    closureHash: string;
    originDeploymentId: string;
    originDeviceId: string;
    sourceSequence: string;
    sourceClosedAt: Date;
    observedAt: Date;
    sourceItemIds: string[];
  }): Promise<{
    replicaId: string;
    state: PdsMaterializationState;
    conflict: boolean;
  }>;
  materializePdsSessionCheckpoint(input: {
    workerId: string;
    inboxId: string;
    userId: string;
    groupId: string;
    retainedPackageId: string;
    packageId: string;
    sourceManifestHash: string;
    sourceFingerprint: string;
    closureHash: string;
    logicalMemoryId: string;
    deletionFloorToken: string;
    originDeploymentId: string;
    originDeviceId: string;
    sourceSequence: string;
    sourceCheckpointAt: Date;
    observedAt: Date;
    checkpoint: PdsReplicaCheckpointInput;
    sourceSession: PdsCheckpointSessionInput;
    sourceItems: PdsCheckpointConversationItem[];
  }): Promise<{
    replicaId: string;
    localSessionId: string;
    state: PdsMaterializationState;
    conflict: boolean;
    deferred: boolean;
  }>;
  completePdsInbox(input: {
    workerId: string;
    inboxId: string;
    retainedPackageId?: string;
    state: "ready" | "quarantined";
  }): Promise<boolean>;
  markPdsInboxFailure(input: {
    workerId: string;
    inboxId: string;
    errorClass: string;
    retryAt: Date;
    permanent?: boolean;
  }): Promise<boolean>;
  requestPdsOutboxRetry(input: {
    userId: string;
    groupId: string;
  }): Promise<number>;
  refreshPdsCheckpointRecipients(input: {
    userId: string;
    groupId: string;
  }): Promise<number>;
  setPdsPublicationPaused(input: {
    userId: string;
    groupId: string;
    paused: boolean;
  }): Promise<number>;
  heartbeatPdsWorker(input: {
    groupId: string;
    workerId: string;
    capability: "source_publication" | "receiver_materialization";
  }): Promise<void>;
  getPdsLocalSyncStatus(input: {
    userId: string;
    groupId: string;
  }): Promise<PdsLocalSyncStatus | null>;
  isPdsWorkerReady(): Promise<boolean>;
}

export type PersonalDeviceSyncLocalRepositoryOptions = Omit<
  ConversationItemRepositoryOptions,
  "transactionClient"
>;

export const createPersonalDeviceSyncLocalRepository = (
  pool: pg.Pool,
  options: PersonalDeviceSyncLocalRepositoryOptions = {}
): PersonalDeviceSyncLocalRepository => ({
  async wakePdsLocalSync(reason) {
    await pool.query("select pg_notify('koed_pds_local_sync', $1)", [
      safeErrorClass(reason)
    ]);
  },

  async getPdsLocalSyncWakeAt() {
    const result = await pool.query<{ wake_at: Date | null }>(
      `select min(wake_at) as wake_at from (
         select greatest(o.retry_at,coalesce(o.lease_until,o.retry_at)) as wake_at
         from pds_outbox_entries o
         join pds_session_closures c on c.id=o.closure_id
         join personal_sync_policies p on p.group_id=c.group_id
         where o.state in ('pending','uploading')
           and p.enabled=true and p.publication_paused=false
         union all
         select greatest(i.retry_at,coalesce(i.lease_until,i.retry_at)) as wake_at
         from pds_inbox_entries i
         where i.state in ('pending','downloading','verifying','processing','failed')
           and i.attempt_count<8
       ) work`
    );
    return result.rows[0]?.wake_at?.toISOString() ?? null;
  },
  async getPdsClosureSource(input) {
    const group = await pool.query<{
      id: string;
      group_id: string;
      enabled: boolean;
    }>(
      `select g.id,g.group_id,p.enabled from personal_device_groups g
       join local_personal_identities i on i.id=g.local_personal_identity_id
       join personal_sync_policies p on p.group_id=g.id
       where i.owner_user_id=$1 and g.group_id=$2 and p.enabled=true
         and p.enabled_at is not null and p.enabled_at<=now()`,
      [input.userId, input.groupId]
    );
    const groupRow = group.rows[0];
    if (!groupRow) return null;
    const session = await pool.query<{
      id: string;
      external_session_id: string | null;
      logical_session_id: string;
      forked_from_external_thread_id: string | null;
      source_kind: string;
      source_runtime: string | null;
      metadata: unknown;
      source_adapter_version: string;
      created_at: Date;
    }>(
      `select id,external_session_id,logical_session_id,forked_from_external_thread_id,
              source_kind,source_runtime,source_adapter_version,created_at,metadata
       from sessions where id=$1 and owner_user_id=$2 and visibility='personal'
       and invalidated_at is null and personal_deleted_at is null`,
      [input.sessionId, input.userId]
    );
    const sourceSession = session.rows[0];
    if (!sourceSession?.external_session_id) return null;
    const existing = await pool.query(
      "select 1 from pds_session_closures where group_id=$1 and source_session_id=$2",
      [groupRow.id, input.sessionId]
    );
    if (existing.rowCount) return null;
    const items = await pool.query<{
      id: string;
      external_item_id: string | null;
      source_sequence: number | null;
      event_time: Date | null;
      observed_at: Date;
      raw_json: unknown;
      raw_text: string | null;
      source_kind: string;
      source_record_type: string;
      source_event_type: string | null;
      metadata: unknown;
    }>(
      `select id,external_item_id,source_sequence,event_time,observed_at,raw_json,raw_text,
              source_kind,source_record_type,source_event_type,metadata
       from conversation_items where owner_user_id=$1 and session_id=$2
         and visibility='personal' and personal_deleted_at is null
       order by source_sequence asc nulls last, observed_at asc, id asc`,
      [input.userId, input.sessionId]
    );
    if (!items.rowCount || items.rows.some((item) => !item.external_item_id)) {
      return null;
    }
    return {
      groupDbId: groupRow.id,
      groupId: groupRow.group_id,
      sessionId: sourceSession.id,
      logicalSessionId: sourceSession.logical_session_id,
      externalSessionId: sourceSession.external_session_id,
      forkedFromExternalThreadId: sourceSession.forked_from_external_thread_id,
      sourceRuntime: sourceSession.source_runtime ?? undefined,
      ...(pdsSourceTitle(sourceSession.metadata)
        ? { title: pdsSourceTitle(sourceSession.metadata) }
        : {}),
      sourceAdapter: sourceSession.source_kind,
      sourceAdapterVersion: sourceSession.source_adapter_version,
      sourceCreatedAt: iso(sourceSession.created_at),
      items: items.rows.map((item, index) => ({
        id: item.id,
        externalItemId: item.external_item_id!,
        sourceSequence: index,
        eventTime: iso(item.event_time ?? item.observed_at),
        observedAt: iso(item.observed_at),
        rawJson: item.raw_json,
        rawText: item.raw_text,
        sourceKind: item.source_kind,
        sourceRecordType: item.source_record_type,
        sourceEventType: item.source_event_type,
        metadata: asRecord(item.metadata)
      }))
    };
  },

  async closePdsSourceSession(input) {
    return (await publishPdsSource(pool, input, false))!;
  },
  async checkpointPdsSourceSession(input) {
    return publishPdsSource(pool, input, true);
  },
  async listPdsCheckpointCandidates(input = {}) {
    const result = await pool.query<{
      user_id: string;
      group_id: string;
      session_id: string;
    }>(
      `
      select i.owner_user_id as user_id,g.group_id,s.id as session_id
      from personal_device_groups g
      join local_personal_identities i on i.id=g.local_personal_identity_id
      join personal_sync_policies p on p.group_id=g.id
      join sessions s on s.owner_user_id=i.owner_user_id
      where g.state='active' and p.enabled and not p.publication_paused
        and ($1::uuid is null or s.id>$1::uuid) and p.enabled_at<=now()
        and p.enabled_at is not null and s.created_at>=p.enabled_at
        and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
        and s.external_session_id is not null
        and not exists (select 1 from pds_logical_replicas r where r.local_session_id=s.id)
        and not exists (select 1 from pds_session_closures c where c.source_session_id=s.id and c.publication_kind='closed')
        and exists (select 1 from conversation_items ci where ci.session_id=s.id
          and ci.personal_deleted_at is null and (${pdsCompletionSql})
          and not exists (select 1 from pds_source_item_mappings m where m.conversation_item_id=ci.id))
      order by s.id limit 50`,
      [input.afterSessionId ?? null]
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      groupId: row.group_id,
      sessionId: row.session_id
    }));
  },

  async reservePdsSourceSequence(input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `pds-sequence:${input.groupId}:${input.originDeploymentId}:${input.originDeviceId}`
      ]);
      const group = await client.query<{ id: string }>(
        `select g.id from personal_device_groups g join local_personal_identities i on i.id=g.local_personal_identity_id
         join personal_sync_policies p on p.group_id=g.id
         where i.owner_user_id=$1 and g.group_id=$2 and p.enabled=true
           and p.enabled_at is not null and p.enabled_at<=now() and p.publication_paused=false
         for update of g,p`,
        [input.userId, input.groupId]
      );
      if (!group.rows[0])
        throw new Error("PDS Personal Sync Policy is not enabled");
      const allocated = await client.query<{ next_sequence: string }>(
        `insert into pds_origin_sequences (group_id,origin_deployment_id,origin_device_id,next_sequence)
         values ($1,$2,$3,'1')
         on conflict (group_id,origin_deployment_id,origin_device_id)
         do update set next_sequence=(pds_origin_sequences.next_sequence::numeric + 1)::text,updated_at=now()
         returning next_sequence`,
        [group.rows[0].id, input.originDeploymentId, input.originDeviceId]
      );
      await client.query("commit");
      return (BigInt(allocated.rows[0]!.next_sequence) - 1n).toString();
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async persistPdsSourceClosure(input) {
    for (const [name, value] of [
      ["terminal cursor", input.terminalCursor],
      ["terminal item count", input.terminalItemCount]
    ] as const)
      mustDecimal(value, name);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `pds-close:${input.groupId}:${input.sessionId}`
      ]);
      const group = await client.query<{ id: string }>(
        `select g.id from personal_device_groups g
         join local_personal_identities i on i.id=g.local_personal_identity_id
         join personal_sync_policies p on p.group_id=g.id
         where i.owner_user_id=$1 and g.group_id=$2 and p.enabled=true
           and p.enabled_at is not null and p.enabled_at<=now() and p.publication_paused=false
         for update of g,p`,
        [input.userId, input.groupId]
      );
      const groupId = group.rows[0]?.id;
      if (!groupId) throw new Error("PDS Personal Sync Policy is not enabled");
      mustDecimal(input.sourceSequence, "source sequence");
      const closure = await client.query<Record<string, unknown>>(
        `insert into pds_session_closures
         (group_id,owner_user_id,source_session_id,source_sequence,terminal_cursor,terminal_item_count,source_closure_hash,package_id,source_manifest_hash,closed_at)
         select $1,$2,s.id,$3,$4,$5,$6,$7,$8,$9 from sessions s
         where s.id=$10 and s.owner_user_id=$2 and s.visibility='personal'
           and s.invalidated_at is null and s.personal_deleted_at is null
         returning *`,
        [
          groupId,
          input.userId,
          input.sourceSequence,
          input.terminalCursor,
          input.terminalItemCount,
          input.sourceClosureHash,
          input.packageId,
          input.sourceManifestHash,
          input.closedAt,
          input.sessionId
        ]
      );
      const closureRow = closure.rows[0];
      if (!closureRow)
        throw new Error("PDS source Session is unavailable or already closed");
      await client.query(
        `insert into pds_retained_packages
         (group_id,owner_user_id,package_id,source_manifest_hash,origin_deployment_id,origin_device_id,source_sequence,encrypted_envelope)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          groupId,
          input.userId,
          input.packageId,
          input.sourceManifestHash,
          input.originDeploymentId,
          input.originDeviceId,
          input.sourceSequence,
          JSON.stringify(input.encryptedEnvelope)
        ]
      );
      await client.query(
        `insert into pds_source_item_mappings (closure_id,conversation_item_id,source_ordinal)
         select $1,ci.id,(row_number() over (order by ci.source_sequence asc nulls last,ci.observed_at asc,ci.id asc)-1)::text
         from conversation_items ci where ci.owner_user_id=$2 and ci.session_id=$3 and ci.visibility='personal'
           and ci.personal_deleted_at is null`,
        [closureRow.id, input.userId, input.sessionId]
      );
      await client.query(
        `insert into pds_outbox_entries (closure_id,idempotency_key)
         values ($1,$2)`,
        [closureRow.id, `pds:${input.groupId}:${input.packageId}`]
      );
      await client.query(
        "select pg_notify('koed_pds_local_sync', 'source_closed')"
      );
      await client.query("commit");
      return recordClosure(closureRow);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async claimPdsOutbox(input) {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 60, 5), 3600);
    const rows = await pool.query<PdsClaimedOutboxEntry>(
      `with claimed as (
         select o.id from pds_outbox_entries o
         join pds_session_closures s on s.id=o.closure_id
         join personal_sync_policies p on p.group_id=s.group_id
         where o.state in ('pending','uploading') and o.retry_at<=now()
           and (o.lease_until is null or o.lease_until<now()) and p.enabled=true
           and p.publication_paused=false
         order by o.retry_at,o.id for update of o,p skip locked limit $1
       ) update pds_outbox_entries o set state='uploading',lease_owner=$2,
         lease_until=now()+($3::text || ' seconds')::interval,attempt_count=o.attempt_count+1,updated_at=now()
       from claimed c,pds_session_closures s,personal_device_groups g
       where o.id=c.id and s.id=o.closure_id and g.id=s.group_id
       returning o.id,g.group_id as "groupId",o.closure_id as "closureId",s.package_id as "packageId",s.source_manifest_hash as "sourceManifestHash",o.attempt_count as "attemptCount"`,
      [limit, input.workerId, leaseSeconds]
    );
    return rows.rows;
  },

  async claimPdsCommittedOutbox(input) {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 60, 5), 3600);
    const rows = await pool.query<PdsClaimedCommittedOutboxEntry>(
      `with claimed as (
         select o.id from pds_outbox_entries o
         join pds_session_closures s on s.id=o.closure_id
         join personal_sync_policies p on p.group_id=s.group_id
         where o.state='committed' and o.transport_id is not null
           and (o.lease_until is null or o.lease_until<now()) and p.enabled=true
         order by o.updated_at,o.id for update of o,p skip locked limit $1
       ) update pds_outbox_entries o
       set lease_owner=$2,lease_until=now()+($3::text || ' seconds')::interval,updated_at=now()
       from claimed c,pds_session_closures s,personal_device_groups g
       where o.id=c.id and s.id=o.closure_id and g.id=s.group_id
       returning o.id,g.group_id as "groupId",o.transport_id as "transportId"`,
      [limit, input.workerId, leaseSeconds]
    );
    return rows.rows;
  },

  async beginPdsOutboxNetworkAction(input) {
    const result = await pool.query(
      `update pds_outbox_entries o set updated_at=now()
       from pds_session_closures c join personal_sync_policies p on p.group_id=c.group_id
       where o.id=$1 and o.lease_owner=$2 and o.lease_until>=now()
         and o.closure_id=c.id and p.enabled=true and p.publication_paused=false`,
      [input.outboxId, input.workerId]
    );
    return result.rowCount === 1;
  },

  async renewPdsOutboxLease(input) {
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 60, 5), 3600);
    const result = await pool.query(
      `update pds_outbox_entries set lease_until=now()+($3::text || ' seconds')::interval,updated_at=now()
       where id=$1 and lease_owner=$2 and lease_until>=now()`,
      [input.outboxId, input.workerId, leaseSeconds]
    );
    return result.rowCount === 1;
  },

  async completePdsOutbox(input) {
    const result = await pool.query(
      `update pds_outbox_entries set state=$3,transport_id=coalesce($4,transport_id),lease_owner=null,lease_until=null,updated_at=now()
       where id=$1 and lease_owner=$2 and lease_until>=now()`,
      [input.outboxId, input.workerId, input.state, input.transportId ?? null]
    );
    return result.rowCount === 1;
  },

  async releasePdsCommittedOutbox(input) {
    const result = await pool.query(
      `update pds_outbox_entries set lease_owner=null,lease_until=null,updated_at=now()
       where id=$1 and state='committed' and lease_owner=$2 and lease_until>=now()`,
      [input.outboxId, input.workerId]
    );
    return result.rowCount === 1;
  },

  async requeuePdsExpiredCheckpointOutbox(input) {
    const result = await pool.query(
      `update pds_outbox_entries o set state='pending',attempt_count=0,
         last_error_class=null,retry_at=now(),transport_id=null,
         lease_owner=null,lease_until=null,updated_at=now()
       from pds_session_closures c
       join pds_retained_packages r on r.group_id=c.group_id and r.package_id=c.package_id
       where o.id=$1 and o.closure_id=c.id and o.state='committed'
         and o.transport_id=$3 and o.lease_owner=$2 and o.lease_until>=now()
         and c.publication_kind='checkpoint' and c.state='ready' and r.state='ready'`,
      [input.outboxId, input.workerId, input.transportId]
    );
    if (result.rowCount)
      await pool.query(
        "select pg_notify('koed_pds_local_sync','checkpoint_transport_expired')"
      );
    return result.rowCount === 1;
  },

  async retryPdsOutbox(input) {
    const result = await pool.query(
      `update pds_outbox_entries set state=case when attempt_count >= 8 then 'quarantined' else 'pending' end,last_error_class=$3,retry_at=$4,lease_owner=null,lease_until=null,updated_at=now()
       where id=$1 and lease_owner=$2 and lease_until>=now()`,
      [
        input.outboxId,
        input.workerId,
        safeErrorClass(input.errorClass),
        input.retryAt
      ]
    );
    return result.rowCount === 1;
  },

  async getPdsOutboxEncryptedEnvelope(input) {
    const result = await pool.query<{
      group_id: string;
      owner_user_id: string;
      encrypted_envelope: unknown;
    }>(
      `select g.group_id,c.owner_user_id,r.encrypted_envelope
       from pds_outbox_entries o join pds_session_closures c on c.id=o.closure_id
       join personal_device_groups g on g.id=c.group_id
       join pds_retained_packages r on r.group_id=c.group_id and r.package_id=c.package_id
       where o.id=$1 and o.lease_owner=$2 and o.lease_until>=now()`,
      [input.outboxId, input.workerId]
    );
    const row = result.rows[0];
    return row
      ? {
          groupId: row.group_id,
          userId: row.owner_user_id,
          encryptedEnvelope: row.encrypted_envelope
        }
      : null;
  },

  async getPdsInboundTransport(input) {
    const result = await pool.query<{ transport_id: string }>(
      `select m.transport_id from pds_transport_mappings m
       join personal_device_groups g on g.id=m.group_id
       where g.group_id=$1 and m.package_id=$2 and m.direction='inbound' limit 1`,
      [input.groupId, input.packageId]
    );
    return result.rows[0]?.transport_id ?? null;
  },

  async receivePdsInbox(input) {
    const existing = await pool.query<{ source_manifest_hash: string }>(
      "select source_manifest_hash from pds_inbox_entries where group_id=(select id from personal_device_groups where group_id=$1) and package_id=$2",
      [input.groupId, input.packageId]
    );
    if (existing.rowCount) {
      if (existing.rows[0]!.source_manifest_hash === input.sourceManifestHash) {
        if (input.transportId) {
          await pool.query(
            `insert into pds_transport_mappings (group_id,package_id,transport_id,direction)
             select g.id,$2,$3,'inbound' from personal_device_groups g where g.group_id=$1
             on conflict (group_id,package_id,direction) do update set transport_id=excluded.transport_id`,
            [input.groupId, input.packageId, input.transportId]
          );
        }
        return "idempotent";
      }
      await pool.query(
        `update pds_inbox_entries set state='quarantined',last_error_class='replay_identity_conflict',updated_at=now()
         where group_id=(select id from personal_device_groups where group_id=$1) and package_id=$2`,
        [input.groupId, input.packageId]
      );
      return "quarantined";
    }
    const result = await pool.query(
      `insert into pds_inbox_entries (group_id,owner_user_id,package_id,source_manifest_hash)
       select g.id,$1,$3,$4 from personal_device_groups g
       join local_personal_identities i on i.id=g.local_personal_identity_id
       where i.owner_user_id=$1 and g.group_id=$2`,
      [input.userId, input.groupId, input.packageId, input.sourceManifestHash]
    );
    if (!result.rowCount) throw new Error("PDS group is unavailable");
    if (input.transportId) {
      await pool.query(
        `insert into pds_transport_mappings (group_id,package_id,transport_id,direction)
         select g.id,$2,$3,'inbound' from personal_device_groups g where g.group_id=$1
         on conflict (group_id,package_id,direction) do update set transport_id=excluded.transport_id`,
        [input.groupId, input.packageId, input.transportId]
      );
    }
    return "new";
  },

  async claimPdsInbox(input) {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 60, 5), 3600);
    const rows = await pool.query<PdsClaimedInboxEntry>(
      `with claimed as (
         select id from pds_inbox_entries where state in ('pending','downloading','verifying','processing','failed')
           and retry_at<=now() and (lease_until is null or lease_until<now()) and attempt_count < 8
         order by retry_at,id for update skip locked limit $1
       ) update pds_inbox_entries i set state='downloading',lease_owner=$2,
         lease_until=now()+($3::text || ' seconds')::interval,attempt_count=i.attempt_count+1,updated_at=now()
       from claimed c,personal_device_groups g
       where i.id=c.id and g.id=i.group_id
       returning i.id,g.group_id as "groupId",i.package_id as "packageId",i.source_manifest_hash as "sourceManifestHash",i.attempt_count as "attemptCount"`,
      [limit, input.workerId, leaseSeconds]
    );
    return rows.rows;
  },

  async applyPdsDeletionFloors(input) {
    if (!input.floors.length) return 0;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `pds-lifecycle:${input.groupId}`
      ]);
      const affected = await client.query<{ local_session_id: string | null }>(
        `update pds_retained_packages p set state='revoked',updated_at=now()
         from personal_device_groups g join local_personal_identities i on i.id=g.local_personal_identity_id
         where p.group_id=g.id and i.owner_user_id=$1 and g.group_id=$2
           and (p.logical_memory_id,p.deletion_floor_token) in (select x.logical_memory_id,x.deletion_floor_token from unnest($3::text[],$4::text[]) x(logical_memory_id,deletion_floor_token))
         returning p.id`,
        [
          input.userId,
          input.groupId,
          input.floors.map((floor) => floor.logicalMemoryId),
          input.floors.map((floor) => floor.deletionFloorToken)
        ]
      );
      await client.query(
        `update pds_logical_replicas r set materialization_state='revoked',updated_at=now()
         from pds_replica_observations o join pds_retained_packages p on p.id=o.retained_package_id
         where o.replica_id=r.id and p.state='revoked' and r.group_id=(select id from personal_device_groups where group_id=$1)`,
        [input.groupId]
      );
      const invalidatedEvents = await client.query<{ id: string }>(
        `update memory_events set invalidated_at=coalesce(invalidated_at,now()),invalidation_reason=coalesce(invalidation_reason,'pds_tombstone'),updated_at=now()
         where session_id in (select local_session_id from pds_logical_replicas where group_id=(select id from personal_device_groups where group_id=$1) and materialization_state='revoked' and local_session_id is not null)
         returning id`,
        [input.groupId]
      );
      await invalidateDerivedMemoryForMemoryEvents(
        client,
        invalidatedEvents.rows.map((item) => item.id),
        "pds_tombstone"
      );
      await client.query("commit");
      return affected.rowCount ?? 0;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async retainPdsInboundPackage(input) {
    mustDecimal(input.sourceSequence, "source sequence");
    if (input.sourceProfile === "cumulative_checkpoint") {
      if (
        !input.checkpoint ||
        !input.sourceFingerprint ||
        !input.sourceClosureHash
      ) {
        throw new TypeError("PDS checkpoint retention metadata is incomplete");
      }
      mustDecimal(input.checkpoint.ordinal, "checkpoint ordinal");
      mustDecimal(input.checkpoint.itemCount, "checkpoint item count");
      if (input.checkpoint.itemCount === "0") {
        throw new TypeError("PDS checkpoint item count must be positive");
      }
    } else if (input.checkpoint) {
      throw new TypeError(
        "PDS closed profile cannot retain checkpoint metadata"
      );
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `pds-lifecycle:${input.groupId}`
      ]);
      const group = await client.query<{ id: string }>(
        `select g.id from personal_device_groups g join local_personal_identities i on i.id=g.local_personal_identity_id
         where i.owner_user_id=$1 and g.group_id=$2 for update of g`,
        [input.userId, input.groupId]
      );
      const groupId = group.rows[0]?.id;
      if (!groupId) throw new Error("PDS group is unavailable");
      const retained = await client.query<{
        id: string;
        state: PdsMaterializationState;
      }>(
        `insert into pds_retained_packages
         (group_id,owner_user_id,package_id,source_manifest_hash,source_profile,origin_deployment_id,origin_device_id,source_sequence,logical_memory_id,deletion_floor_token,source_fingerprint,source_closure_hash,checkpoint_ordinal,checkpoint_previous_closure_hash,checkpoint_item_count,encrypted_envelope,state)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
           case when exists (select 1 from pds_deletion_floors f where f.group_id=$1 and f.logical_memory_id=$9 and f.deletion_floor_token=$10) then 'revoked' else 'ready' end)
         on conflict (group_id,package_id) do update set updated_at=now()
         returning id,state`,
        [
          groupId,
          input.userId,
          input.packageId,
          input.sourceManifestHash,
          input.sourceProfile ?? "closed_v1",
          input.originDeploymentId,
          input.originDeviceId,
          input.sourceSequence,
          input.logicalMemoryId ?? null,
          input.deletionFloorToken ?? null,
          input.sourceFingerprint ?? null,
          input.sourceClosureHash ?? null,
          input.checkpoint?.ordinal ?? null,
          input.checkpoint?.previousClosureHash ?? null,
          input.checkpoint?.itemCount ?? null,
          JSON.stringify(input.encryptedEnvelope)
        ]
      );
      const record = retained.rows[0]!;
      await client.query(
        `update pds_inbox_entries set state='verifying',retained_package_id=$3,updated_at=now()
         where id=$1 and group_id=$2 and state not in ('quarantined','revoked')`,
        [input.inboxId, groupId, record.id]
      );
      await client.query("commit");
      return { retainedPackageId: record.id, state: record.state };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async materializePdsReplica(input) {
    mustDecimal(input.sourceSequence, "source sequence");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `pds-lifecycle:${input.groupId}`
      ]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `pds-materialize:${input.groupId}:${input.sourceFingerprint ?? input.closureHash}`
      ]);
      const group = await client.query<{ id: string }>(
        `select g.id from personal_device_groups g join local_personal_identities i on i.id=g.local_personal_identity_id
         where i.owner_user_id=$1 and g.group_id=$2`,
        [input.userId, input.groupId]
      );
      const groupId = group.rows[0]?.id;
      if (!groupId) throw new Error("PDS group is unavailable");
      const retained = await client.query<{ state: PdsMaterializationState }>(
        `select p.state from pds_retained_packages p
         left join pds_deletion_floors f on f.group_id=p.group_id
           and f.logical_memory_id=p.logical_memory_id
           and f.deletion_floor_token=p.deletion_floor_token
         where p.id=$1 and p.group_id=$2 for update of p`,
        [input.retainedPackageId, groupId]
      );
      if (!retained.rowCount || retained.rows[0]!.state === "revoked")
        throw new Error("PdsCryptoFloorError");
      const floored = await client.query(
        `select 1 from pds_retained_packages p join pds_deletion_floors f
           on f.group_id=p.group_id and f.logical_memory_id=p.logical_memory_id
           and f.deletion_floor_token=p.deletion_floor_token
         where p.id=$1 for share`,
        [input.retainedPackageId]
      );
      if (floored.rowCount) {
        await client.query(
          "update pds_retained_packages set state='revoked',updated_at=now() where id=$1",
          [input.retainedPackageId]
        );
        throw new Error("PdsCryptoFloorError");
      }
      let conflict = false;
      if (input.sourceFingerprint) {
        const variants = await client.query<{
          materialization_profile: string;
          closure_hash: string;
        }>(
          "select materialization_profile,closure_hash from pds_logical_replicas where group_id=$1 and source_fingerprint=$2 for update",
          [groupId, input.sourceFingerprint]
        );
        if (
          variants.rows.some(
            (row) =>
              row.materialization_profile !== "closed_v1" ||
              row.closure_hash !== input.closureHash
          )
        ) {
          conflict = true;
          const conflictRow = await client.query<{ id: string }>(
            `insert into pds_conflicts (group_id,source_fingerprint) values ($1,$2)
             on conflict (group_id,source_fingerprint) do update set state='quarantined'
             returning id`,
            [groupId, input.sourceFingerprint]
          );
          await client.query(
            `update pds_logical_replicas set materialization_state='quarantined',conflict_id=$3,updated_at=now()
             where group_id=$1 and source_fingerprint=$2`,
            [groupId, input.sourceFingerprint, conflictRow.rows[0]!.id]
          );
          await client.query(
            `update memory_events set invalidated_at=coalesce(invalidated_at,now()),
               invalidation_reason=coalesce(invalidation_reason,'pds_conflict_quarantine'),updated_at=now()
             where session_id in (
               select local_session_id from pds_logical_replicas
               where group_id=$1 and source_fingerprint=$2 and local_session_id is not null
             )`,
            [groupId, input.sourceFingerprint]
          );
          await client.query(
            `update memory_nodes set invalidated_at=coalesce(invalidated_at,now()),
               invalidation_reason=coalesce(invalidation_reason,'pds_conflict_quarantine'),updated_at=now()
             where exists (
               select 1 from memory_node_sources ns join memory_events me on me.id=ns.memory_event_id
               where ns.memory_node_id=memory_nodes.id and me.invalidation_reason='pds_conflict_quarantine'
             )`
          );
        }
      }
      const state: PdsMaterializationState = conflict ? "quarantined" : "ready";
      const replica = await client.query<{ id: string }>(
        `insert into pds_logical_replicas (group_id,owner_user_id,materialization_profile,source_fingerprint,closure_hash,local_session_id,materialization_state)
         values ($1,$2,'closed_v1',$3,$4,$5,$6)
         on conflict (group_id,source_fingerprint,closure_hash) where materialization_profile='closed_v1' do update set local_session_id=coalesce(pds_logical_replicas.local_session_id,excluded.local_session_id),updated_at=now()
         returning id`,
        [
          groupId,
          input.userId,
          input.sourceFingerprint,
          input.closureHash,
          input.localSessionId,
          state
        ]
      );
      const replicaId = replica.rows[0]!.id;
      await client.query(
        `insert into pds_replica_observations (replica_id,retained_package_id,origin_deployment_id,origin_device_id,source_sequence,source_closed_at,observed_at)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
        [
          replicaId,
          input.retainedPackageId,
          input.originDeploymentId,
          input.originDeviceId,
          input.sourceSequence,
          input.sourceClosedAt,
          input.observedAt
        ]
      );
      for (const [ordinal, itemId] of input.sourceItemIds.entries()) {
        await client.query(
          `insert into pds_source_item_mappings (replica_id,conversation_item_id,source_ordinal)
           values ($1,$2,$3) on conflict (conversation_item_id) do nothing`,
          [replicaId, itemId, String(ordinal)]
        );
      }
      await client.query(
        `insert into pds_origin_high_water_marks (group_id,origin_deployment_id,origin_device_id,accepted_sequence,served_sequence)
         values ($1,$2,$3,$4,'0') on conflict (group_id,origin_deployment_id,origin_device_id)
         do update set accepted_sequence=greatest(pds_origin_high_water_marks.accepted_sequence::numeric,excluded.accepted_sequence::numeric)::text,updated_at=now()`,
        [
          groupId,
          input.originDeploymentId,
          input.originDeviceId,
          input.sourceSequence
        ]
      );
      const processing = await client.query(
        `update pds_inbox_entries set state='processing',updated_at=now()
         where id=$1 and retained_package_id=$2 and lease_owner=$3
           and lease_until>=now()`,
        [input.inboxId, input.retainedPackageId, input.workerId]
      );
      if (processing.rowCount !== 1)
        throw new Error("PdsInboxLeaseUnavailableError");
      await client.query("commit");
      return { replicaId, state, conflict };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async materializePdsSessionCheckpoint(input) {
    const { checkpoint } = input;
    mustDecimal(input.sourceSequence, "source sequence");
    mustDecimal(checkpoint.ordinal, "checkpoint ordinal");
    mustDecimal(checkpoint.itemCount, "checkpoint item count");
    if (
      checkpoint.version !== "1" ||
      checkpoint.itemCount === "0" ||
      input.sourceItems.length !== Number(checkpoint.itemCount) ||
      input.sourceItems.some(
        (item, index) =>
          item.sourceSequence !== index ||
          !item.externalItemId ||
          !item.sourceHash ||
          !item.eventTime ||
          !item.observedAt
      ) ||
      (checkpoint.ordinal === "0"
        ? checkpoint.previousClosureHash !== null
        : !checkpoint.previousClosureHash)
    ) {
      throw new TypeError(
        "PDS checkpoint materialization input is inconsistent"
      );
    }
    const itemCount = BigInt(checkpoint.itemCount);
    const terminalSequence = Number(itemCount);
    if (!Number.isSafeInteger(terminalSequence)) {
      throw new TypeError(
        "PDS checkpoint item count exceeds local ordering limits"
      );
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `pds-lifecycle:${input.groupId}`
      ]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `pds-materialize:${input.groupId}:${input.sourceFingerprint}`
      ]);
      const group = await client.query<{ id: string }>(
        `select g.id from personal_device_groups g
         join local_personal_identities i on i.id=g.local_personal_identity_id
         where i.owner_user_id=$1 and g.group_id=$2 for update of g`,
        [input.userId, input.groupId]
      );
      const groupId = group.rows[0]?.id;
      if (!groupId) throw new Error("PDS group is unavailable");

      const retained = await client.query<{
        state: PdsMaterializationState;
        source_profile: string;
        source_fingerprint: string | null;
        source_closure_hash: string | null;
        checkpoint_ordinal: string | null;
        checkpoint_previous_closure_hash: string | null;
        checkpoint_item_count: string | null;
        origin_deployment_id: string;
        origin_device_id: string;
        source_sequence: string;
        logical_memory_id: string | null;
        deletion_floor_token: string | null;
      }>(
        `select p.state,p.source_profile,p.source_fingerprint,p.source_closure_hash,
                p.checkpoint_ordinal,p.checkpoint_previous_closure_hash,p.checkpoint_item_count,
                p.origin_deployment_id,p.origin_device_id,p.source_sequence,
                p.logical_memory_id,p.deletion_floor_token
         from pds_retained_packages p
         where p.id=$1 and p.group_id=$2 for update`,
        [input.retainedPackageId, groupId]
      );
      const retainedPackage = retained.rows[0];
      if (
        !retainedPackage ||
        retainedPackage.state === "revoked" ||
        retainedPackage.source_profile !== "cumulative_checkpoint" ||
        retainedPackage.source_fingerprint !== input.sourceFingerprint ||
        retainedPackage.source_closure_hash !== input.closureHash ||
        retainedPackage.checkpoint_ordinal !== checkpoint.ordinal ||
        retainedPackage.checkpoint_previous_closure_hash !==
          checkpoint.previousClosureHash ||
        retainedPackage.checkpoint_item_count !== checkpoint.itemCount ||
        retainedPackage.origin_deployment_id !== input.originDeploymentId ||
        retainedPackage.origin_device_id !== input.originDeviceId ||
        retainedPackage.source_sequence !== input.sourceSequence ||
        retainedPackage.logical_memory_id !== input.logicalMemoryId ||
        retainedPackage.deletion_floor_token !== input.deletionFloorToken
      ) {
        throw new Error("PdsCryptoIdentityError");
      }
      const floored = await client.query(
        `select 1 from pds_deletion_floors f
         where f.group_id=$1 and f.logical_memory_id=$2 and f.deletion_floor_token=$3
         for share`,
        [groupId, input.logicalMemoryId, input.deletionFloorToken]
      );
      if (floored.rowCount) {
        await client.query(
          "update pds_retained_packages set state='revoked',updated_at=now() where id=$1",
          [input.retainedPackageId]
        );
        throw new Error("PdsCryptoFloorError");
      }

      const variants = await client.query<{
        id: string;
        materialization_profile: string;
        closure_hash: string;
        checkpoint_ordinal: string | null;
        checkpoint_item_count: string | null;
        local_session_id: string | null;
        materialization_state: PdsMaterializationState;
      }>(
        `select id,materialization_profile,closure_hash,checkpoint_ordinal,
                checkpoint_item_count,local_session_id,materialization_state
         from pds_logical_replicas where group_id=$1 and source_fingerprint=$2
         for update`,
        [groupId, input.sourceFingerprint]
      );
      let replica = variants.rows.find(
        (row) => row.materialization_profile === "cumulative_checkpoint"
      );
      let conflictId: string | null = null;
      const quarantine = async (replicaId?: string): Promise<string> => {
        const conflict = await client.query<{ id: string }>(
          `insert into pds_conflicts (group_id,source_fingerprint)
           values ($1,$2) on conflict (group_id,source_fingerprint)
           do update set state='quarantined' returning id`,
          [groupId, input.sourceFingerprint]
        );
        const id = conflict.rows[0]!.id;
        await client.query(
          `update pds_logical_replicas set materialization_state='quarantined',
             conflict_id=$3,updated_at=now()
           where group_id=$1 and source_fingerprint=$2`,
          [groupId, input.sourceFingerprint, id]
        );
        const invalidated = await client.query<{ id: string }>(
          `update memory_events set invalidated_at=coalesce(invalidated_at,now()),
             invalidation_reason=coalesce(invalidation_reason,'pds_conflict_quarantine'),updated_at=now()
           where session_id in (
             select local_session_id from pds_logical_replicas
             where group_id=$1 and source_fingerprint=$2 and local_session_id is not null
           ) returning id`,
          [groupId, input.sourceFingerprint]
        );
        await invalidateDerivedMemoryForMemoryEvents(
          client,
          invalidated.rows.map((row) => row.id),
          "pds_conflict_quarantine"
        );
        await client.query(
          `update pds_retained_packages set state='quarantined',updated_at=now()
           where group_id=$1 and source_fingerprint=$2 and state='ready'`,
          [groupId, input.sourceFingerprint]
        );
        conflictId = id;
        return replicaId ?? "";
      };

      if (
        variants.rows.some(
          (row) => row.materialization_profile !== "cumulative_checkpoint"
        )
      ) {
        await quarantine();
        const processing = await client.query(
          `update pds_inbox_entries set state='processing',updated_at=now()
           where id=$1 and retained_package_id=$2 and lease_owner=$3 and lease_until>=now()`,
          [input.inboxId, input.retainedPackageId, input.workerId]
        );
        if (processing.rowCount !== 1)
          throw new Error("PdsInboxLeaseUnavailableError");
        await client.query("commit");
        return {
          replicaId: "",
          localSessionId: "",
          state: "quarantined",
          conflict: true,
          deferred: false
        };
      }

      const headOrdinal = replica?.checkpoint_ordinal;
      const headCount = replica?.checkpoint_item_count;
      const requestedOrdinal = BigInt(checkpoint.ordinal);
      const expectedOrdinal = headOrdinal ? BigInt(headOrdinal) + 1n : 0n;
      if (requestedOrdinal > expectedOrdinal) {
        const deferred = await client.query(
          `update pds_inbox_entries set state='awaiting_predecessor',
             attempt_count=greatest(attempt_count-1,0),lease_owner=null,lease_until=null,
             last_error_class=null,updated_at=now()
           where id=$1 and retained_package_id=$2 and lease_owner=$3 and lease_until>=now()`,
          [input.inboxId, input.retainedPackageId, input.workerId]
        );
        if (deferred.rowCount !== 1)
          throw new Error("PdsInboxLeaseUnavailableError");
        await client.query("commit");
        return {
          replicaId: replica?.id ?? "",
          localSessionId: replica?.local_session_id ?? "",
          state: replica?.materialization_state ?? "pending",
          conflict: false,
          deferred: true
        };
      }

      let localSessionId = replica?.local_session_id ?? "";
      let previousCount = 0n;
      if (replica) {
        if (replica.materialization_state === "quarantined") {
          const processing = await client.query(
            `update pds_inbox_entries set state='processing',updated_at=now()
             where id=$1 and retained_package_id=$2 and lease_owner=$3 and lease_until>=now()`,
            [input.inboxId, input.retainedPackageId, input.workerId]
          );
          if (processing.rowCount !== 1)
            throw new Error("PdsInboxLeaseUnavailableError");
          await client.query("commit");
          return {
            replicaId: replica.id,
            localSessionId: localSessionId ?? "",
            state: "quarantined",
            conflict: true,
            deferred: false
          };
        }
        previousCount = BigInt(headCount!);
        const predecessor = await client.query<{
          origin_deployment_id: string;
          origin_device_id: string;
          logical_memory_id: string | null;
          deletion_floor_token: string | null;
          logical_session_id: string;
          external_session_id: string | null;
          forked_from_external_thread_id: string | null;
          source_runtime: string | null;
          source_kind: string | null;
          source_adapter_version: string | null;
          source_sequence: string;
          metadata: unknown;
        }>(
          `select o.origin_deployment_id,o.origin_device_id,o.source_sequence,p.logical_memory_id,p.deletion_floor_token,
                  s.logical_session_id,s.external_session_id,s.forked_from_external_thread_id,
                  s.source_runtime,s.source_kind,s.source_adapter_version,s.metadata
           from pds_replica_checkpoints c
           join pds_replica_observations o on o.replica_id=c.replica_id and o.retained_package_id=c.retained_package_id
           join pds_retained_packages p on p.id=c.retained_package_id
           join sessions s on s.id=$2
           where c.replica_id=$1 and c.checkpoint_ordinal='0'`,
          [replica.id, localSessionId]
        );
        const original = predecessor.rows[0];
        if (
          !original ||
          original.origin_deployment_id !== input.originDeploymentId ||
          original.origin_device_id !== input.originDeviceId ||
          original.logical_memory_id !== input.logicalMemoryId ||
          original.deletion_floor_token !== input.deletionFloorToken ||
          original.logical_session_id !==
            input.sourceSession.logicalSessionId ||
          original.external_session_id !==
            input.sourceSession.externalSessionId ||
          original.forked_from_external_thread_id !==
            (input.sourceSession.forkedFromExternalThreadId ?? null) ||
          original.source_runtime !== input.sourceSession.sourceRuntime ||
          original.source_kind !== input.sourceSession.sourceKind ||
          original.source_adapter_version !==
            input.sourceSession.sourceAdapterVersion ||
          (asRecord(asRecord(original.metadata).pds).sourceCreatedAt !==
            undefined &&
            asRecord(asRecord(original.metadata).pds).sourceCreatedAt !==
              input.sourceSession.sourceCreatedAt) ||
          (requestedOrdinal > BigInt(headOrdinal!) &&
            BigInt(input.sourceSequence) <= BigInt(original.source_sequence))
        ) {
          await quarantine(replica.id);
          const processing = await client.query(
            `update pds_inbox_entries set state='processing',updated_at=now()
             where id=$1 and retained_package_id=$2 and lease_owner=$3 and lease_until>=now()`,
            [input.inboxId, input.retainedPackageId, input.workerId]
          );
          if (processing.rowCount !== 1)
            throw new Error("PdsInboxLeaseUnavailableError");
          await client.query("commit");
          return {
            replicaId: replica.id,
            localSessionId,
            state: "quarantined",
            conflict: true,
            deferred: false
          };
        }

        const acceptedReplay =
          requestedOrdinal <= BigInt(headOrdinal!)
            ? await client.query<{
                source_closure_hash: string;
                item_count: string;
                previous_closure_hash: string | null;
                source_manifest_hash: string;
              }>(
                `select source_closure_hash,item_count,previous_closure_hash,source_manifest_hash
                 from pds_replica_checkpoints where replica_id=$1 and checkpoint_ordinal=$2`,
                [replica.id, checkpoint.ordinal]
              )
            : null;
        if (
          acceptedReplay &&
          (!acceptedReplay.rows[0] ||
            acceptedReplay.rows[0]!.source_closure_hash !== input.closureHash ||
            acceptedReplay.rows[0]!.item_count !== checkpoint.itemCount ||
            acceptedReplay.rows[0]!.previous_closure_hash !==
              checkpoint.previousClosureHash ||
            acceptedReplay.rows[0]!.source_manifest_hash !==
              input.sourceManifestHash)
        ) {
          await quarantine(replica.id);
          const processing = await client.query(
            `update pds_inbox_entries set state='processing',updated_at=now()
             where id=$1 and retained_package_id=$2 and lease_owner=$3 and lease_until>=now()`,
            [input.inboxId, input.retainedPackageId, input.workerId]
          );
          if (processing.rowCount !== 1)
            throw new Error("PdsInboxLeaseUnavailableError");
          await client.query("commit");
          return {
            replicaId: replica.id,
            localSessionId,
            state: "quarantined",
            conflict: true,
            deferred: false
          };
        }

        const prefixLimit =
          requestedOrdinal <= BigInt(headOrdinal!) ? itemCount : previousCount;
        const prefix = await client.query<{
          source_ordinal: string;
          external_item_id: string | null;
          source_hash: string;
          source_sequence: number | null;
          event_time: Date | null;
          observed_at: Date;
        }>(
          `select m.source_ordinal,ci.external_item_id,ci.source_hash,ci.source_sequence,
                  ci.event_time,ci.observed_at
           from pds_source_item_mappings m join conversation_items ci on ci.id=m.conversation_item_id
           where m.replica_id=$1 and m.source_ordinal::numeric < $2
           order by m.source_ordinal::numeric`,
          [replica.id, prefixLimit.toString()]
        );
        const prefixMatches =
          BigInt(prefix.rowCount ?? 0) === prefixLimit &&
          prefix.rows.every((row, index) => {
            const source = input.sourceItems[index];
            return Boolean(
              source &&
              row.source_ordinal === String(index) &&
              row.external_item_id === source.externalItemId &&
              row.source_hash === source.sourceHash &&
              row.source_sequence === source.sourceSequence &&
              row.event_time?.getTime() === Date.parse(source.eventTime!) &&
              row.observed_at.getTime() === Date.parse(source.observedAt!)
            );
          });
        if (!prefixMatches) {
          await quarantine(replica.id);
          const processing = await client.query(
            `update pds_inbox_entries set state='processing',updated_at=now()
             where id=$1 and retained_package_id=$2 and lease_owner=$3 and lease_until>=now()`,
            [input.inboxId, input.retainedPackageId, input.workerId]
          );
          if (processing.rowCount !== 1)
            throw new Error("PdsInboxLeaseUnavailableError");
          await client.query("commit");
          return {
            replicaId: replica.id,
            localSessionId,
            state: "quarantined",
            conflict: true,
            deferred: false
          };
        }

        if (acceptedReplay) {
          await client.query(
            `insert into pds_replica_observations
             (replica_id,retained_package_id,origin_deployment_id,origin_device_id,source_sequence,source_closed_at,observed_at)
             values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
            [
              replica.id,
              input.retainedPackageId,
              input.originDeploymentId,
              input.originDeviceId,
              input.sourceSequence,
              input.sourceCheckpointAt,
              input.observedAt
            ]
          );
          const processing = await client.query(
            `update pds_inbox_entries set state='processing',updated_at=now()
             where id=$1 and retained_package_id=$2 and lease_owner=$3 and lease_until>=now()`,
            [input.inboxId, input.retainedPackageId, input.workerId]
          );
          if (processing.rowCount !== 1)
            throw new Error("PdsInboxLeaseUnavailableError");
          await client.query("commit");
          return {
            replicaId: replica.id,
            localSessionId,
            state: replica.materialization_state,
            conflict: false,
            deferred: false
          };
        }

        if (
          requestedOrdinal !== expectedOrdinal ||
          checkpoint.previousClosureHash !== replica.closure_hash ||
          itemCount <= previousCount
        ) {
          await quarantine(replica.id);
          const processing = await client.query(
            `update pds_inbox_entries set state='processing',updated_at=now()
             where id=$1 and retained_package_id=$2 and lease_owner=$3 and lease_until>=now()`,
            [input.inboxId, input.retainedPackageId, input.workerId]
          );
          if (processing.rowCount !== 1)
            throw new Error("PdsInboxLeaseUnavailableError");
          await client.query("commit");
          return {
            replicaId: replica.id,
            localSessionId,
            state: "quarantined",
            conflict: true,
            deferred: false
          };
        }
      } else {
        if (
          checkpoint.ordinal !== "0" ||
          checkpoint.previousClosureHash !== null
        ) {
          const deferred = await client.query(
            `update pds_inbox_entries set state='awaiting_predecessor',
               attempt_count=greatest(attempt_count-1,0),lease_owner=null,lease_until=null,
               last_error_class=null,updated_at=now()
             where id=$1 and retained_package_id=$2 and lease_owner=$3 and lease_until>=now()`,
            [input.inboxId, input.retainedPackageId, input.workerId]
          );
          if (deferred.rowCount !== 1)
            throw new Error("PdsInboxLeaseUnavailableError");
          await client.query("commit");
          return {
            replicaId: "",
            localSessionId: "",
            state: "pending",
            conflict: false,
            deferred: true
          };
        }
      }

      if (
        replica &&
        requestedOrdinal === BigInt(headOrdinal!) &&
        replica.closure_hash === input.closureHash
      ) {
        throw new Error(
          "PDS checkpoint replay was not present in its immutable ledger"
        );
      }

      if (!replica) {
        const { sourceTitle, sourceCreatedAt, sourceKind, ...sessionSource } =
          input.sourceSession;
        const preexistingSession = await client.query<{ id: string }>(
          `select id from sessions where owner_user_id=$1 and external_session_id=$2
           for update`,
          [input.userId, input.sourceSession.externalSessionId]
        );
        if (preexistingSession.rowCount) {
          await quarantine();
          const processing = await client.query(
            `update pds_inbox_entries set state='processing',updated_at=now()
             where id=$1 and retained_package_id=$2 and lease_owner=$3 and lease_until>=now()`,
            [input.inboxId, input.retainedPackageId, input.workerId]
          );
          if (processing.rowCount !== 1)
            throw new Error("PdsInboxLeaseUnavailableError");
          await client.query("commit");
          return {
            replicaId: "",
            localSessionId: "",
            state: "quarantined",
            conflict: true,
            deferred: false
          };
        }
        const sourceSessionMetadata = {
          ...(sourceTitle
            ? {
                threadName: sourceTitle,
                threadNameSource: "pds_source"
              }
            : {}),
          pds: {
            groupId: input.groupId,
            originDeploymentId: input.originDeploymentId,
            originDeviceId: input.originDeviceId,
            sourceFingerprint: input.sourceFingerprint,
            sourceProfile: "cumulative_checkpoint",
            sourceCreatedAt
          }
        };
        const session = await createCapturedSessionRepository(pool, {
          transactionClient: client
        }).createCapturedSession(
          { userId: input.userId },
          {
            ...sessionSource,
            idempotencyKey: `pds-session:${input.groupId}:${input.sourceFingerprint}`,
            sourceHash: `pds:${input.sourceFingerprint}`,
            sourceFingerprint: input.sourceFingerprint,
            sourceKind,
            sourceAdapterVersion: input.sourceSession.sourceAdapterVersion,
            metadata: sourceSessionMetadata
          }
        );
        localSessionId = session.id;
        replica = {
          id: randomUUID(),
          materialization_profile: "cumulative_checkpoint",
          closure_hash: input.closureHash,
          checkpoint_ordinal: "0",
          checkpoint_item_count: checkpoint.itemCount,
          local_session_id: localSessionId,
          materialization_state: "ready"
        };
        await client.query(
          `select set_config('koed.pds_replica_append_id',$1,true),
                  set_config('koed.pds_replica_append_start','0',true),
                  set_config('koed.pds_replica_append_end',$2,true)`,
          [replica.id, checkpoint.itemCount]
        );
        await client.query(
          `insert into pds_logical_replicas
           (id,group_id,owner_user_id,materialization_profile,source_fingerprint,closure_hash,
            checkpoint_ordinal,checkpoint_item_count,local_session_id,materialization_state)
           values ($1,$2,$3,'cumulative_checkpoint',$4,$5,$6,$7,$8,'ready')`,
          [
            replica.id,
            groupId,
            input.userId,
            input.sourceFingerprint,
            input.closureHash,
            checkpoint.ordinal,
            checkpoint.itemCount,
            localSessionId
          ]
        );
      } else {
        await client.query(
          `select set_config('koed.pds_replica_append_id',$1,true),
                  set_config('koed.pds_replica_append_start',$2,true),
                  set_config('koed.pds_replica_append_end',$3,true)`,
          [replica.id, String(previousCount), checkpoint.itemCount]
        );
        await client.query(
          `update pds_logical_replicas set closure_hash=$2,checkpoint_ordinal=$3,
             checkpoint_item_count=$4,materialization_state='ready',updated_at=now()
           where id=$1`,
          [
            replica.id,
            input.closureHash,
            checkpoint.ordinal,
            checkpoint.itemCount
          ]
        );
      }

      if (input.sourceSession.sourceTitle) {
        await client.query(
          `update sessions set
             metadata=metadata || jsonb_build_object(
               'threadName',$2::text,'threadNameSource','pds_source'
             ),updated_at=now()
           where id=$1 and (
             metadata->>'threadNameSource' is null or
             metadata->>'threadNameSource'='pds_source'
           )`,
          [localSessionId, input.sourceSession.sourceTitle]
        );
      }

      const sourceSessionId = localSessionId;
      const suffix = input.sourceItems
        .slice(Number(previousCount))
        .map((item) => ({
          ...item,
          sessionId: sourceSessionId
        }));
      const terminalItem: ConversationItemInput = {
        sessionId: sourceSessionId,
        sourceKind: input.sourceSession.sourceKind,
        sourceAdapterVersion: input.sourceSession.sourceAdapterVersion,
        sourceTransport: "pds_relay",
        externalSessionId: input.sourceSession.externalSessionId,
        externalThreadId: input.sourceSession.externalSessionId,
        sourceRecordType: "pds_turn_completed",
        sourceEventType: "pds_turn_completed",
        sourceSequence: terminalSequence,
        externalItemId: `pds-checkpoint-terminal:${input.sourceFingerprint}:${checkpoint.ordinal}`,
        eventTime: input.sourceCheckpointAt.toISOString(),
        observedAt: input.sourceCheckpointAt.toISOString(),
        observationKind: "control",
        observationComponent: "control",
        rawJson: { type: "pds_turn_completed", role: "system", content: "" },
        sourceHash: input.closureHash,
        idempotencyKey: `pds-checkpoint-terminal:${input.groupId}:${input.sourceFingerprint}:${checkpoint.ordinal}`,
        metadata: {
          transcriptType: "pds_turn_completed",
          sourceRole: "system",
          pds: {
            originDeviceId: input.originDeviceId,
            sourceSequence: input.sourceSequence,
            checkpointOrdinal: checkpoint.ordinal
          }
        }
      };
      const storedItems = await createConversationItemRepository(pool, {
        ...options,
        transactionClient: client
      }).createConversationItems(
        { userId: input.userId },
        { items: [...suffix, terminalItem] }
      );
      if (storedItems.length !== suffix.length + 1) {
        throw new Error(
          "PDS checkpoint append did not materialize every source item"
        );
      }
      for (let index = 0; index < suffix.length; index += 1) {
        await client.query(
          `insert into pds_source_item_mappings (replica_id,conversation_item_id,source_ordinal)
           values ($1,$2,$3)`,
          [
            replica!.id,
            storedItems[index]!.id,
            String(Number(previousCount) + index)
          ]
        );
      }
      await client.query(
        `insert into pds_replica_checkpoints
         (replica_id,retained_package_id,checkpoint_ordinal,previous_closure_hash,
          source_closure_hash,item_count,source_manifest_hash,accepted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          replica!.id,
          input.retainedPackageId,
          checkpoint.ordinal,
          checkpoint.previousClosureHash,
          input.closureHash,
          checkpoint.itemCount,
          input.sourceManifestHash,
          input.observedAt
        ]
      );
      await client.query(
        `insert into pds_replica_observations
         (replica_id,retained_package_id,origin_deployment_id,origin_device_id,
          source_sequence,source_closed_at,observed_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          replica!.id,
          input.retainedPackageId,
          input.originDeploymentId,
          input.originDeviceId,
          input.sourceSequence,
          input.sourceCheckpointAt,
          input.observedAt
        ]
      );
      await client.query(
        `insert into pds_origin_high_water_marks
         (group_id,origin_deployment_id,origin_device_id,accepted_sequence,served_sequence)
         values ($1,$2,$3,$4,'0')
         on conflict (group_id,origin_deployment_id,origin_device_id)
         do update set accepted_sequence=greatest(
           pds_origin_high_water_marks.accepted_sequence::numeric,
           excluded.accepted_sequence::numeric
         )::text,updated_at=now()`,
        [
          groupId,
          input.originDeploymentId,
          input.originDeviceId,
          input.sourceSequence
        ]
      );
      await client.query(
        `update pds_inbox_entries set state='pending',retry_at=now(),updated_at=now()
         where group_id=$1 and state='awaiting_predecessor' and id<>$2
           and exists (
             select 1 from pds_retained_packages p
             where p.id=pds_inbox_entries.retained_package_id
               and p.source_profile='cumulative_checkpoint'
               and p.source_fingerprint=$3
               and p.checkpoint_previous_closure_hash=$4
           )`,
        [groupId, input.inboxId, input.sourceFingerprint, input.closureHash]
      );
      const processing = await client.query(
        `update pds_inbox_entries set state='processing',updated_at=now()
         where id=$1 and retained_package_id=$2 and lease_owner=$3 and lease_until>=now()`,
        [input.inboxId, input.retainedPackageId, input.workerId]
      );
      if (processing.rowCount !== 1)
        throw new Error("PdsInboxLeaseUnavailableError");
      await client.query(
        "select pg_notify('koed_pds_local_sync','checkpoint_predecessor_accepted')"
      );
      await client.query("commit");
      return {
        replicaId: replica!.id,
        localSessionId,
        state: conflictId ? "quarantined" : "ready",
        conflict: Boolean(conflictId),
        deferred: false
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async completePdsInbox(input) {
    const result = await pool.query(
      `update pds_inbox_entries
       set state=$4,lease_owner=null,lease_until=null,last_error_class=null,updated_at=now()
       where id=$1
         and (($2::uuid is null and retained_package_id is null)
           or retained_package_id=$2)
         and lease_owner=$3
         and lease_until>=now() and state='processing'`,
      [input.inboxId, input.retainedPackageId, input.workerId, input.state]
    );
    return result.rowCount === 1;
  },

  async markPdsInboxFailure(input) {
    const result = await pool.query(
      `update pds_inbox_entries set
         state=case when $5 or attempt_count >= 8 then 'quarantined' else 'failed' end,
         last_error_class=$3,retry_at=$4,lease_owner=null,lease_until=null,updated_at=now()
       where id=$1 and lease_owner=$2 and lease_until>=now()`,
      [
        input.inboxId,
        input.workerId,
        safeErrorClass(input.errorClass),
        input.retryAt,
        input.permanent === true
      ]
    );
    return result.rowCount === 1;
  },

  async requestPdsOutboxRetry(input) {
    const result = await pool.query(
      `update pds_outbox_entries o set state='pending',retry_at=now(),last_error_class=null,lease_owner=null,lease_until=null,updated_at=now()
       from pds_session_closures c join personal_device_groups g on g.id=c.group_id
       join local_personal_identities i on i.id=g.local_personal_identity_id
       where o.closure_id=c.id and i.owner_user_id=$1 and g.group_id=$2 and o.state in ('failed','paused')`,
      [input.userId, input.groupId]
    );
    if (result.rowCount)
      await pool.query(
        "select pg_notify('koed_pds_local_sync', 'manual_retry')"
      );
    return result.rowCount ?? 0;
  },

  async refreshPdsCheckpointRecipients(input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `pds-lifecycle:${input.groupId}`
      ]);
      const group = await client.query<{
        id: string;
        current_epoch: string;
      }>(
        `select g.id,g.current_epoch from personal_device_groups g
         join local_personal_identities i on i.id=g.local_personal_identity_id
         join personal_sync_policies p on p.group_id=g.id
         where i.owner_user_id=$1 and g.group_id=$2 and g.state='active'
           and p.enabled=true and p.publication_paused=false
         for update of g,p`,
        [input.userId, input.groupId]
      );
      const groupRow = group.rows[0];
      if (!groupRow) {
        await client.query("commit");
        return 0;
      }
      const updated = await client.query(
        `update pds_outbox_entries o set
           state='pending',attempt_count=0,last_error_class=null,
           lease_owner=null,lease_until=null,transport_id=null,dispatch_epoch=$2,
           retry_at=now(),updated_at=now()
         from pds_session_closures c
         join pds_retained_packages source_package on source_package.group_id=c.group_id and source_package.package_id=c.package_id
         join personal_device_group_members origin on origin.group_id=c.group_id
           and origin.device_id=source_package.origin_device_id and origin.status='active'
         where o.closure_id=c.id and c.group_id=$1
           and c.publication_kind='checkpoint' and c.state='ready'
           and source_package.state='ready'
           and o.dispatch_epoch is distinct from $2
           and (o.lease_until is null or o.lease_until<=now())`,
        [groupRow.id, groupRow.current_epoch]
      );
      if (updated.rowCount) {
        await client.query(
          "select pg_notify('koed_pds_local_sync','checkpoint_recipient_epoch_changed')"
        );
      }
      await client.query("commit");
      return updated.rowCount ?? 0;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async setPdsPublicationPaused(input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `pds-publication:${input.groupId}`
      ]);
      const policy = await client.query<{ id: string }>(
        `update personal_sync_policies p set publication_paused=$3,updated_by_user_id=$1,updated_at=now()
         from personal_device_groups g join local_personal_identities i on i.id=g.local_personal_identity_id
         where p.group_id=g.id and i.owner_user_id=$1 and g.group_id=$2 returning g.id`,
        [input.userId, input.groupId, input.paused]
      );
      const group = policy.rows[0];
      if (!group) {
        await client.query("rollback");
        return 0;
      }
      const result = await client.query(
        `update pds_outbox_entries o set state=case when $3 then 'paused' else 'pending' end,
          retry_at=case when $3 then retry_at else now() end,lease_owner=null,lease_until=null,updated_at=now()
         from pds_session_closures c where o.closure_id=c.id and c.group_id=$1
           and (($3 and o.state in ('pending','uploading')) or (not $3 and o.state='paused'))`,
        [group.id, input.userId, input.paused]
      );
      if (!input.paused && result.rowCount)
        await client.query(
          "select pg_notify('koed_pds_local_sync', 'publication_resumed')"
        );
      await client.query("commit");
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async heartbeatPdsWorker(input) {
    await pool.query(
      `insert into pds_worker_heartbeats (group_id,worker_id,capability)
       select id,$2,$3 from personal_device_groups where group_id=$1
       on conflict (group_id,worker_id,capability) do update set heartbeat_at=now()`,
      [input.groupId, input.workerId, input.capability]
    );
  },

  async isPdsWorkerReady() {
    const result = await pool.query(
      `select group_id from pds_worker_heartbeats
       where heartbeat_at>now()-interval '2 minutes'
       group by group_id having count(distinct capability)=2 limit 1`
    );
    return result.rowCount === 1;
  },

  async getPdsLocalSyncStatus(input) {
    const group = await pool.query<{
      id: string;
      enabled: boolean;
      publication_paused: boolean;
    }>(
      `select g.id,p.enabled,p.publication_paused from personal_device_groups g
       join local_personal_identities i on i.id=g.local_personal_identity_id
       join personal_sync_policies p on p.group_id=g.id
       where i.owner_user_id=$1 and g.group_id=$2`,
      [input.userId, input.groupId]
    );
    const row = group.rows[0];
    if (!row) return null;
    const [
      outbox,
      inbox,
      replicas,
      heartbeat,
      semanticClaims,
      lcmIntents,
      acceptedArtifacts,
      sourceReplicationPolicy,
      pendingPublication
    ] = await Promise.all([
      pool.query<{ state: string; count: string }>(
        `select o.state,count(*)::text from pds_outbox_entries o
         join pds_session_closures c on c.id=o.closure_id
         where c.group_id=$1 group by o.state`,
        [row.id]
      ),
      pool.query<{ state: string; count: string }>(
        "select state,count(*)::text from pds_inbox_entries where group_id=$1 group by state",
        [row.id]
      ),
      pool.query<{ state: string; count: string }>(
        "select materialization_state as state,count(*)::text from pds_logical_replicas where group_id=$1 group by materialization_state",
        [row.id]
      ),
      pool.query(
        "select 1 from pds_worker_heartbeats where group_id=$1 and heartbeat_at>now()-interval '2 minutes' limit 1",
        [row.id]
      ),
      pool.query<{
        active: string;
        completed: string;
        expired: string;
        nearest_expiry_seconds: string | null;
      }>(
        `select
           count(*) filter (where state='active' and expires_at>now())::text as active,
           count(*) filter (where state='completed')::text as completed,
           count(*) filter (where state='active' and expires_at<=now())::text as expired,
           ceil(extract(epoch from
             min(expires_at) filter (where state='active' and expires_at>now())
             - now()))::text as nearest_expiry_seconds
         from pds_semantic_work_claims
         where group_id=$1`,
        [row.id]
      ),
      pool.query<{ state: string; count: string }>(
        "select state,count(*)::text from pds_lcm_work_intents where group_id=$1 group by state",
        [row.id]
      ),
      pool.query<{ count: string }>(
        `select count(*)::text as count from pds_portable_artifacts
         where group_id=$1 and semantic_claim_completed_at is not null
           and state not in ('quarantined','revoked')`,
        [row.id]
      ),
      pool.query<{ enabled: boolean; mode: string }>(
        `select enabled,mode from personal_source_replication_policies
         where owner_user_id=$1`,
        [input.userId]
      ),
      pool.query<{ count: string }>(
        `
        select count(*)::text as count from sessions s
        join personal_sync_policies p on p.group_id=$1
        where s.owner_user_id=$2 and s.visibility='personal' and s.created_at>=p.enabled_at
          and s.invalidated_at is null and s.personal_deleted_at is null and s.external_session_id is not null
          and not exists(select 1 from pds_logical_replicas r where r.local_session_id=s.id)
          and not exists(select 1 from pds_session_closures c where c.source_session_id=s.id and c.publication_kind='closed')
          and exists(select 1 from conversation_items ci where ci.session_id=s.id and ci.personal_deleted_at is null
            and (${pdsCompletionSql}) and not exists(select 1 from pds_source_item_mappings m where m.conversation_item_id=ci.id))`,
        [row.id, input.userId]
      )
    ]);
    const counts = (rows: Array<{ state: string; count: string }>) =>
      Object.fromEntries(rows.map((item) => [item.state, Number(item.count)]));
    const outboxCounts = counts(outbox.rows);
    const claims = semanticClaims.rows[0]!;
    const nearestExpirySeconds = claims.nearest_expiry_seconds;
    return {
      enabled: row.enabled,
      paused: row.publication_paused,
      workerReady: Boolean(heartbeat.rowCount),
      pendingPublication: Number(pendingPublication.rows[0]?.count ?? 0),
      outbox: outboxCounts,
      inbox: counts(inbox.rows),
      replicas: counts(replicas.rows),
      semanticWork: {
        authorityTier:
          sourceReplicationPolicy.rows[0]?.enabled &&
          sourceReplicationPolicy.rows[0]?.mode === "hosted_personal"
            ? "hosted_personal"
            : "personal_device_group",
        claims: {
          active: Number(claims.active),
          completed: Number(claims.completed),
          expired: Number(claims.expired),
          nearestExpirySeconds:
            nearestExpirySeconds === null
              ? null
              : Math.max(0, Number(nearestExpirySeconds))
        },
        lcmIntents: counts(lcmIntents.rows),
        acceptedArtifacts: Number(acceptedArtifacts.rows[0]?.count ?? 0)
      }
    };
  }
});

export interface PdsCheckpointPublicationInput {
  userId: string;
  groupId: string;
  sessionId: string;
  originDeploymentId: string;
  originDeviceId: string;
  build(input: {
    source: PdsClosureSource;
    sourceSequence: string;
    closedAt: Date;
    checkpoint?: {
      version: "1";
      ordinal: string;
      previousClosureHash: string | null;
    };
  }): Promise<{
    sourceClosureHash: string;
    packageId: string;
    sourceManifestHash: string;
    sourceFingerprint: string;
    logicalMemoryId: string;
    deletionFloorToken: string;
    encryptedEnvelope: unknown;
  }>;
}

const pdsCompletionSql = `
  (ci.source_adapter_version='pi-session-v1' and ci.metadata->>'semanticControl'='turn_completed')
  or (ci.source_adapter_version='codex-transcript-v1' and ci.source_event_type in ('task_complete','turn_aborted'))
  or (ci.source_adapter_version='codex-app-server-conversation-v1' and ci.source_event_type='turn/completed')
  or (ci.source_adapter_version='claude-code-hook-signal-v1' and ci.source_event_type='turn_completed')`;

const pdsItemCompletesTurn = (item: {
  raw_json: unknown;
  source_adapter_version?: string;
  source_event_type: string | null;
  source_kind: string;
  metadata: unknown;
}): boolean => {
  return (
    (item.source_adapter_version === "pi-session-v1" &&
      asRecord(item.metadata).semanticControl === "turn_completed") ||
    (item.source_adapter_version === "codex-transcript-v1" &&
      ["task_complete", "turn_aborted"].includes(
        item.source_event_type ?? ""
      )) ||
    (item.source_adapter_version === "codex-app-server-conversation-v1" &&
      item.source_event_type === "turn/completed") ||
    (item.source_adapter_version === "claude-code-hook-signal-v1" &&
      item.source_event_type === "turn_completed")
  );
};
async function publishPdsSource(
  pool: pg.Pool,
  input: PdsCheckpointPublicationInput,
  checkpointMode: boolean
): Promise<PdsLocalClosureRecord | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Shared with conversation-item trigger. Later ingestion waits, then sees closure.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `pds-session:${input.sessionId}`
    ]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `pds-close:${input.groupId}:${input.sessionId}`
    ]);
    const group = await client.query<{
      id: string;
      group_id: string;
      current_epoch: string;
      publication_paused: boolean;
      enabled_at: Date;
    }>(
      `select g.id,g.group_id,g.current_epoch,p.publication_paused,p.enabled_at
         from personal_device_groups g
         join local_personal_identities i on i.id=g.local_personal_identity_id
         join personal_sync_policies p on p.group_id=g.id
         where i.owner_user_id=$1 and g.group_id=$2 and g.state='active' and p.enabled=true
           and p.enabled_at is not null and p.enabled_at<=now()
         for update of g,p`,
      [input.userId, input.groupId]
    );
    const groupRow = group.rows[0];
    if (!groupRow) throw new Error("PDS Personal Sync Policy is not enabled");
    if (groupRow.publication_paused)
      throw new Error("PDS publication is paused");
    const member = await client.query(
      "select 1 from personal_device_group_members where group_id=$1 and device_id=$2 and status='active' for share",
      [groupRow.id, input.originDeviceId]
    );
    if (!member.rowCount) throw new Error("PdsPublicationMembershipError");
    const session = await client.query<{
      id: string;
      external_session_id: string | null;
      logical_session_id: string;
      forked_from_external_thread_id: string | null;
      source_kind: string;
      source_runtime: string | null;
      metadata: unknown;
      source_adapter_version: string;
      created_at: Date;
    }>(
      `select id,external_session_id,logical_session_id,forked_from_external_thread_id,
                source_kind,source_runtime,source_adapter_version,created_at,metadata
         from sessions where id=$1 and owner_user_id=$2 and visibility='personal'
           and invalidated_at is null and personal_deleted_at is null for update`,
      [input.sessionId, input.userId]
    );
    const sourceSession = session.rows[0];
    if (!sourceSession?.external_session_id)
      throw new Error(
        "PDS source Session is unavailable or lacks native identity"
      );
    if (checkpointMode && sourceSession.created_at < groupRow.enabled_at) {
      await client.query("commit");
      return null;
    }
    const replica = await client.query(
      "select 1 from pds_logical_replicas where local_session_id=$1",
      [input.sessionId]
    );
    if (replica.rowCount)
      throw new Error(
        "PDS received Sessions cannot be published as local sources"
      );
    const existing = await client.query<{
      publication_kind: string;
      checkpoint_ordinal: string | null;
      source_closure_hash: string;
      terminal_item_count: string;
      origin_device_id: string | null;
      origin_deployment_id: string | null;
    }>(
      "select c.publication_kind,c.checkpoint_ordinal,c.source_closure_hash,c.terminal_item_count,r.origin_device_id,r.origin_deployment_id from pds_session_closures c left join pds_retained_packages r on r.group_id=c.group_id and r.package_id=c.package_id where c.group_id=$1 and c.source_session_id=$2 order by c.source_sequence::numeric desc for update of c",
      [groupRow.id, input.sessionId]
    );
    if (
      existing.rowCount &&
      (!checkpointMode ||
        existing.rows.some((row) => row.publication_kind !== "checkpoint"))
    )
      throw new Error("PDS source Session is unavailable or already closed");
    if (
      checkpointMode &&
      existing.rows[0] &&
      (existing.rows[0].origin_device_id !== input.originDeviceId ||
        existing.rows[0].origin_deployment_id !== input.originDeploymentId)
    )
      throw new Error("PdsCheckpointOriginConflict");
    const items = await client.query<{
      id: string;
      external_item_id: string | null;
      event_time: Date | null;
      observed_at: Date;
      raw_json: unknown;
      raw_text: string | null;
      source_kind: string;
      source_adapter_version: string;
      source_record_type: string;
      source_event_type: string | null;
      metadata: unknown;
    }>(
      `select id,external_item_id,event_time,observed_at,raw_json,raw_text,
                source_kind,source_adapter_version,source_record_type,source_event_type,metadata
         from conversation_items where owner_user_id=$1 and session_id=$2
           and visibility='personal' and personal_deleted_at is null
         order by source_sequence asc nulls last, observed_at asc, id asc for update`,
      [input.userId, input.sessionId]
    );
    if (!items.rowCount || items.rows.some((item) => !item.external_item_id))
      throw new Error("PDS source Session has no stable source items");
    if (checkpointMode) {
      let terminalIndex = -1;
      items.rows.forEach((item, index) => {
        if (pdsItemCompletesTurn(item)) terminalIndex = index;
      });
      const previousCount = Number(
        existing.rows[0]?.terminal_item_count ?? "0"
      );
      if (terminalIndex < 0 || terminalIndex + 1 <= previousCount) {
        await client.query("commit");
        return null;
      }
      items.rows.splice(terminalIndex + 1);
      const published = await client.query<{
        conversation_item_id: string;
        source_ordinal: string;
      }>(
        `select m.conversation_item_id,m.source_ordinal from pds_source_item_mappings m
           join pds_session_closures c on c.id=m.closure_id
           where c.group_id=$1 and c.source_session_id=$2 order by m.source_ordinal::numeric`,
        [groupRow.id, input.sessionId]
      );
      if (
        published.rows.some(
          (row) =>
            items.rows[Number(row.source_ordinal)]?.id !==
            row.conversation_item_id
        )
      )
        throw new Error("PdsCheckpointPrefixConflict");
    }
    const source: PdsClosureSource = {
      groupDbId: groupRow.id,
      groupId: groupRow.group_id,
      sessionId: sourceSession.id,
      logicalSessionId: sourceSession.logical_session_id,
      externalSessionId: sourceSession.external_session_id,
      forkedFromExternalThreadId: sourceSession.forked_from_external_thread_id,
      sourceRuntime: sourceSession.source_runtime ?? undefined,
      ...(pdsSourceTitle(sourceSession.metadata)
        ? { title: pdsSourceTitle(sourceSession.metadata) }
        : {}),
      sourceAdapter: sourceSession.source_kind,
      sourceAdapterVersion: sourceSession.source_adapter_version,
      sourceCreatedAt: iso(sourceSession.created_at),
      items: items.rows.map((item, index) => ({
        id: item.id,
        externalItemId: item.external_item_id!,
        sourceSequence: index,
        eventTime: iso(item.event_time ?? item.observed_at),
        observedAt: iso(item.observed_at),
        rawJson: item.raw_json,
        rawText: item.raw_text,
        sourceKind: item.source_kind,
        sourceRecordType: item.source_record_type,
        sourceEventType: item.source_event_type,
        metadata: asRecord(item.metadata)
      }))
    };
    const allocated = await client.query<{ next_sequence: string }>(
      `insert into pds_origin_sequences (group_id,origin_deployment_id,origin_device_id,next_sequence)
         values ($1,$2,$3,'1')
         on conflict (group_id,origin_deployment_id,origin_device_id)
         do update set next_sequence=(pds_origin_sequences.next_sequence::numeric + 1)::text,updated_at=now()
         returning next_sequence`,
      [groupRow.id, input.originDeploymentId, input.originDeviceId]
    );
    const sourceSequence = (
      BigInt(allocated.rows[0]!.next_sequence) - 1n
    ).toString();
    const closedAt = new Date();
    const checkpoint = checkpointMode
      ? {
          version: "1" as const,
          ordinal: (
            BigInt(existing.rows[0]?.checkpoint_ordinal ?? "-1") + 1n
          ).toString(),
          previousClosureHash: existing.rows[0]?.source_closure_hash ?? null
        }
      : undefined;
    const built = await input.build({
      source,
      sourceSequence,
      closedAt,
      ...(checkpoint ? { checkpoint } : {})
    });
    const closure = await client.query<Record<string, unknown>>(
      `insert into pds_session_closures
         (group_id,owner_user_id,source_session_id,source_sequence,terminal_cursor,terminal_item_count,source_closure_hash,package_id,source_manifest_hash,closed_at,publication_kind,checkpoint_ordinal)
         values ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [
        groupRow.id,
        input.userId,
        input.sessionId,
        sourceSequence,
        String(source.items.length),
        built.sourceClosureHash,
        built.packageId,
        built.sourceManifestHash,
        closedAt,
        checkpointMode ? "checkpoint" : "closed",
        checkpoint?.ordinal ?? null
      ]
    );
    const closureRow = closure.rows[0]!;
    await client.query(
      `insert into pds_retained_packages
         (group_id,owner_user_id,package_id,source_manifest_hash,origin_deployment_id,origin_device_id,source_sequence,logical_memory_id,deletion_floor_token,source_fingerprint,source_closure_hash,encrypted_envelope,source_profile,checkpoint_ordinal,checkpoint_previous_closure_hash,checkpoint_item_count)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)`,
      [
        groupRow.id,
        input.userId,
        built.packageId,
        built.sourceManifestHash,
        input.originDeploymentId,
        input.originDeviceId,
        sourceSequence,
        built.logicalMemoryId,
        built.deletionFloorToken,
        built.sourceFingerprint,
        built.sourceClosureHash,
        JSON.stringify(built.encryptedEnvelope),
        checkpointMode ? "cumulative_checkpoint" : "closed_v1",
        checkpoint?.ordinal ?? null,
        checkpoint?.previousClosureHash ?? null,
        checkpointMode ? String(source.items.length) : null
      ]
    );
    for (const [ordinal, item] of source.items.entries()) {
      await client.query(
        `insert into pds_source_item_mappings (closure_id,conversation_item_id,source_ordinal)
           values ($1,$2,$3) on conflict (conversation_item_id) do nothing`,
        [closureRow.id, item.id, String(ordinal)]
      );
    }
    await client.query(
      `insert into pds_outbox_entries (closure_id,idempotency_key,dispatch_epoch)
         values ($1,$2,$3)`,
      [
        closureRow.id,
        `pds:${input.groupId}:${built.packageId}`,
        checkpointMode ? groupRow.current_epoch : null
      ]
    );
    await client.query(
      "select pg_notify('koed_pds_local_sync', 'source_closed')"
    );
    await client.query("commit");
    return recordClosure(closureRow);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const pdsSourceTitle = (metadata: unknown): string | undefined => {
  const title = asRecord(metadata).threadName;
  if (typeof title !== "string") return undefined;
  for (const character of title) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return undefined;
    }
  }
  let result = "";
  for (const character of title) {
    if (character.length === 1 && /[\ud800-\udfff]/u.test(character))
      return undefined;
    if (result.length + character.length > 240) break;
    result += character;
  }
  return result || undefined;
};
