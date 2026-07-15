import pg from "pg";

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
  externalSessionId: string;
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

export interface PdsClaimedInboxEntry {
  id: string;
  groupId: string;
  packageId: string;
  sourceManifestHash: string;
  attemptCount: number;
}

export interface PdsLocalSyncStatus {
  enabled: boolean;
  paused: boolean;
  workerReady: boolean;
  outbox: Record<string, number>;
  inbox: Record<string, number>;
  replicas: Record<string, number>;
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
  getPdsClosureSource(input: {
    userId: string;
    groupId: string;
    sessionId: string;
  }): Promise<PdsClosureSource | null>;
  /**
   * Holds source Session, items, policy, pause state, and origin sequence in
   * one transaction. Builder failure rolls back sequence allocation too.
   */
  closePdsSourceSession(input: {
    userId: string;
    groupId: string;
    sessionId: string;
    originDeploymentId: string;
    originDeviceId: string;
    build(input: {
      source: PdsClosureSource;
      sourceSequence: string;
      closedAt: Date;
    }): Promise<{
      sourceClosureHash: string;
      packageId: string;
      sourceManifestHash: string;
      encryptedEnvelope: unknown;
    }>;
  }): Promise<PdsLocalClosureRecord>;
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
  retainPdsInboundPackage(input: {
    userId: string;
    groupId: string;
    inboxId: string;
    packageId: string;
    sourceManifestHash: string;
    originDeploymentId: string;
    originDeviceId: string;
    sourceSequence: string;
    encryptedEnvelope: unknown;
  }): Promise<{ retainedPackageId: string; state: PdsMaterializationState }>;
  materializePdsReplica(input: {
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

export const createPersonalDeviceSyncLocalRepository = (
  pool: pg.Pool
): PersonalDeviceSyncLocalRepository => ({
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
      source_kind: string;
      source_adapter_version: string;
      created_at: Date;
    }>(
      `select id,external_session_id,source_kind,source_adapter_version,created_at
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
      externalSessionId: sourceSession.external_session_id,
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
        publication_paused: boolean;
      }>(
        `select g.id,g.group_id,p.publication_paused
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
      const session = await client.query<{
        id: string;
        external_session_id: string | null;
        source_kind: string;
        source_adapter_version: string;
        created_at: Date;
      }>(
        `select id,external_session_id,source_kind,source_adapter_version,created_at
         from sessions where id=$1 and owner_user_id=$2 and visibility='personal'
           and invalidated_at is null and personal_deleted_at is null for update`,
        [input.sessionId, input.userId]
      );
      const sourceSession = session.rows[0];
      if (!sourceSession?.external_session_id)
        throw new Error(
          "PDS source Session is unavailable or lacks native identity"
        );
      const existing = await client.query(
        "select 1 from pds_session_closures where group_id=$1 and source_session_id=$2 for update",
        [groupRow.id, input.sessionId]
      );
      if (existing.rowCount)
        throw new Error("PDS source Session is unavailable or already closed");
      const items = await client.query<{
        id: string;
        external_item_id: string | null;
        event_time: Date | null;
        observed_at: Date;
        raw_json: unknown;
        raw_text: string | null;
        source_kind: string;
        source_record_type: string;
        source_event_type: string | null;
        metadata: unknown;
      }>(
        `select id,external_item_id,event_time,observed_at,raw_json,raw_text,
                source_kind,source_record_type,source_event_type,metadata
         from conversation_items where owner_user_id=$1 and session_id=$2
           and visibility='personal' and personal_deleted_at is null
         order by source_sequence asc nulls last, observed_at asc, id asc for update`,
        [input.userId, input.sessionId]
      );
      if (!items.rowCount || items.rows.some((item) => !item.external_item_id))
        throw new Error("PDS source Session has no stable source items");
      const source: PdsClosureSource = {
        groupDbId: groupRow.id,
        groupId: groupRow.group_id,
        sessionId: sourceSession.id,
        externalSessionId: sourceSession.external_session_id,
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
      const built = await input.build({ source, sourceSequence, closedAt });
      const closure = await client.query<Record<string, unknown>>(
        `insert into pds_session_closures
         (group_id,owner_user_id,source_session_id,source_sequence,terminal_cursor,terminal_item_count,source_closure_hash,package_id,source_manifest_hash,closed_at)
         values ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9) returning *`,
        [
          groupRow.id,
          input.userId,
          input.sessionId,
          sourceSequence,
          String(source.items.length),
          built.sourceClosureHash,
          built.packageId,
          built.sourceManifestHash,
          closedAt
        ]
      );
      const closureRow = closure.rows[0]!;
      await client.query(
        `insert into pds_retained_packages
         (group_id,owner_user_id,package_id,source_manifest_hash,origin_deployment_id,origin_device_id,source_sequence,encrypted_envelope)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          groupRow.id,
          input.userId,
          built.packageId,
          built.sourceManifestHash,
          input.originDeploymentId,
          input.originDeviceId,
          sourceSequence,
          JSON.stringify(built.encryptedEnvelope)
        ]
      );
      for (const [ordinal, item] of source.items.entries()) {
        await client.query(
          `insert into pds_source_item_mappings (closure_id,conversation_item_id,source_ordinal)
           values ($1,$2,$3)`,
          [closureRow.id, item.id, String(ordinal)]
        );
      }
      await client.query(
        `insert into pds_outbox_entries (closure_id,idempotency_key)
         values ($1,$2)`,
        [closureRow.id, `pds:${input.groupId}:${built.packageId}`]
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
         where o.state in ('pending','uploading','committed') and o.retry_at<=now()
           and (o.lease_until is null or o.lease_until<now()) and p.enabled=true
           and p.publication_paused=false
         order by o.retry_at,o.id for update of o,p skip locked limit $1
       ) update pds_outbox_entries o set state='uploading',lease_owner=$2,
         lease_until=now()+($3::text || ' seconds')::interval,attempt_count=o.attempt_count+1,updated_at=now()
       from claimed c join pds_session_closures s on s.id=o.closure_id
       join personal_device_groups g on g.id=s.group_id
       where o.id=c.id returning o.id,g.group_id as "groupId",o.closure_id as "closureId",s.package_id as "packageId",s.source_manifest_hash as "sourceManifestHash",o.attempt_count as "attemptCount"`,
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
      `select c.group_id,c.owner_user_id,r.encrypted_envelope
       from pds_outbox_entries o join pds_session_closures c on c.id=o.closure_id
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
       from claimed c join personal_device_groups g on g.id=i.group_id
       where i.id=c.id returning i.id,g.group_id as "groupId",i.package_id as "packageId",i.source_manifest_hash as "sourceManifestHash",i.attempt_count as "attemptCount"`,
      [limit, input.workerId, leaseSeconds]
    );
    return rows.rows;
  },

  async retainPdsInboundPackage(input) {
    mustDecimal(input.sourceSequence, "source sequence");
    const client = await pool.connect();
    try {
      await client.query("begin");
      const group = await client.query<{ id: string }>(
        `select g.id from personal_device_groups g join local_personal_identities i on i.id=g.local_personal_identity_id
         where i.owner_user_id=$1 and g.group_id=$2`,
        [input.userId, input.groupId]
      );
      const groupId = group.rows[0]?.id;
      if (!groupId) throw new Error("PDS group is unavailable");
      const retained = await client.query<{
        id: string;
        state: PdsMaterializationState;
      }>(
        `insert into pds_retained_packages
         (group_id,owner_user_id,package_id,source_manifest_hash,origin_deployment_id,origin_device_id,source_sequence,encrypted_envelope)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         on conflict (group_id,package_id) do update set updated_at=now()
         returning id,state`,
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
        `pds-materialize:${input.groupId}:${input.sourceFingerprint ?? input.closureHash}`
      ]);
      const group = await client.query<{ id: string }>(
        `select g.id from personal_device_groups g join local_personal_identities i on i.id=g.local_personal_identity_id
         where i.owner_user_id=$1 and g.group_id=$2`,
        [input.userId, input.groupId]
      );
      const groupId = group.rows[0]?.id;
      if (!groupId) throw new Error("PDS group is unavailable");
      let conflict = false;
      if (input.sourceFingerprint) {
        const variants = await client.query<{ closure_hash: string }>(
          "select closure_hash from pds_logical_replicas where group_id=$1 and source_fingerprint=$2 for update",
          [groupId, input.sourceFingerprint]
        );
        if (
          variants.rows.some((row) => row.closure_hash !== input.closureHash)
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
        `insert into pds_logical_replicas (group_id,owner_user_id,source_fingerprint,closure_hash,local_session_id,materialization_state)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (group_id,source_fingerprint,closure_hash) do update set local_session_id=coalesce(pds_logical_replicas.local_session_id,excluded.local_session_id),updated_at=now()
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
      await client.query(
        `update pds_inbox_entries set state=$2,lease_owner=null,lease_until=null,updated_at=now()
         where retained_package_id=$1`,
        [input.retainedPackageId, state]
      );
      await client.query("commit");
      return { replicaId, state, conflict };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
    return result.rowCount ?? 0;
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
           and (($3 and o.state in ('pending','uploading','committed')) or (not $3 and o.state='paused'))`,
        [group.id, input.userId, input.paused]
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
    const [outbox, inbox, replicas, heartbeat] = await Promise.all([
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
      )
    ]);
    const counts = (rows: Array<{ state: string; count: string }>) =>
      Object.fromEntries(rows.map((item) => [item.state, Number(item.count)]));
    const outboxCounts = counts(outbox.rows);
    return {
      enabled: row.enabled,
      paused: row.publication_paused,
      workerReady: Boolean(heartbeat.rowCount),
      outbox: outboxCounts,
      inbox: counts(inbox.rows),
      replicas: counts(replicas.rows)
    };
  }
});
