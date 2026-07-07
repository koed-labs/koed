import pg from "pg";
import type { ActorContext } from "./types.js";

const timestampIso = (value: Date | string | null): string | null =>
  value
    ? (value instanceof Date ? value : new Date(value)).toISOString()
    : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const forbiddenSyncPackageManifestKeys = new Set([
  "apiKey",
  "ciphertext",
  "credential",
  "credentials",
  "dataEncryptionKey",
  "dek",
  "memoryText",
  "password",
  "plaintext",
  "rawDek",
  "secret",
  "sourcePayload",
  "sourceText",
  "token",
  "wrappedDek"
]);

const includesForbiddenManifestKey = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => includesForbiddenManifestKey(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, nested]) =>
      forbiddenSyncPackageManifestKeys.has(key) ||
      includesForbiddenManifestKey(nested)
  );
};

const validateEncryptedSyncPackageManifest = (
  manifest: Record<string, unknown>
): void => {
  const payload = manifest.payload;
  if (
    (manifest.objectClass !== "sync_package" &&
      manifest.objectClass !== "offload_package") ||
    !isRecord(payload) ||
    !isNonEmptyString(payload.checksumSha256) ||
    !isNonEmptyString(payload.providerMode) ||
    !isNonEmptyString(payload.keyId) ||
    typeof payload.keyVersion !== "number" ||
    typeof payload.envelopeVersion !== "number"
  ) {
    throw new Error(
      "Sync package upload sessions require an encrypted package manifest"
    );
  }
  if (includesForbiddenManifestKey(manifest)) {
    throw new Error("Sync package upload session manifests must be redacted");
  }
};

export type DeploymentProfile =
  | "developer_local"
  | "local_personal"
  | "private_vps"
  | "team_self_hosted"
  | "koed_managed_cloud";

export type SyncSourceBoundary = "captured_session";

export type SyncReplicaRole = "source" | "target";

export type SyncMode = "live" | "offload";

export type SyncRelationshipState =
  | "created"
  | "uploading"
  | "uploaded"
  | "verified"
  | "processing"
  | "partially_available"
  | "ready"
  | "stale"
  | "failed"
  | "revoked"
  | "purge_pending";

export type SyncPackageState =
  | "created"
  | "uploading"
  | "uploaded"
  | "verified"
  | "processing"
  | "completed"
  | "failed";

export type SyncQueueEntryState =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface DeploymentIdentityRecord {
  id: string;
  ownerUserId: string;
  deploymentKey: string;
  profile: DeploymentProfile;
  displayName: string | null;
  baseUrl: string | null;
  upstreamBackendId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
  disabledReason: string | null;
}

export interface LogicalMemoryRecord {
  id: string;
  ownerUserId: string;
  sourceBoundary: SyncSourceBoundary;
  sourceSessionId: string;
  logicalKey: string;
  lineage: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export interface MemoryReplicaRecord {
  id: string;
  logicalMemoryId: string;
  deploymentIdentityId: string;
  ownerUserId: string;
  replicaRole: SyncReplicaRole;
  sourceBoundary: SyncSourceBoundary;
  sourceSessionId: string;
  externalReplicaId: string | null;
  freshnessStatus: "unknown" | "fresh" | "stale" | "revoked" | "failed";
  cursorManifest: Record<string, unknown>;
  policyManifest: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
  staleAfter: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
}

export interface CrossIdentitySyncRelationshipRecord {
  id: string;
  logicalMemoryId: string;
  sourceReplicaId: string;
  targetReplicaId: string;
  sourceDeploymentIdentityId: string;
  targetDeploymentIdentityId: string;
  sourceOwnerUserId: string;
  targetUserId: string;
  targetTeamId: string | null;
  sourceBoundary: SyncSourceBoundary;
  sourceSessionId: string;
  syncMode: SyncMode;
  state: SyncRelationshipState;
  idempotencyKey: string;
  policyManifest: Record<string, unknown>;
  consentManifest: Record<string, unknown>;
  cursorManifest: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastPackageId: string | null;
  lastSyncedAt: string | null;
  failedAt: string | null;
  lastErrorMessage: string | null;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
}

export interface SyncPackageUploadSessionRecord {
  id: string;
  syncRelationshipId: string;
  logicalMemoryId: string;
  sourceReplicaId: string;
  targetReplicaId: string;
  state: SyncPackageState;
  packageFormatVersion: number;
  packageManifest: Record<string, unknown>;
  packageChecksum: string;
  totalBytes: number;
  uploadedBytes: number;
  chunkCount: number;
  verifiedChunkCount: number;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  uploadedAt: string | null;
  verifiedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  lastErrorMessage: string | null;
}

export interface SyncPackageChunkRecord {
  id: string;
  uploadSessionId: string;
  chunkIndex: number;
  chunkChecksum: string;
  byteCount: number;
  storageRef: string | null;
  receivedAt: string;
}

export interface SyncQueueEntryRecord {
  id: string;
  syncRelationshipId: string;
  uploadSessionId: string | null;
  state: SyncQueueEntryState;
  idempotencyKey: string;
  payloadManifest: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  lockedAt: string | null;
  processedAt: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrossIdentitySyncRepository {
  upsertDeploymentIdentity(
    actor: ActorContext,
    input: {
      deploymentKey: string;
      profile: DeploymentProfile;
      displayName?: string | null;
      baseUrl?: string | null;
      upstreamBackendId?: string | null;
      metadata?: Record<string, unknown>;
    }
  ): Promise<DeploymentIdentityRecord>;
  upsertCapturedSessionLogicalMemory(
    actor: ActorContext,
    input: {
      sessionId: string;
      deploymentIdentityId: string;
      logicalKey?: string;
      externalReplicaId?: string | null;
      lineage?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      cursorManifest?: Record<string, unknown>;
      policyManifest?: Record<string, unknown>;
    }
  ): Promise<{
    logicalMemory: LogicalMemoryRecord;
    sourceReplica: MemoryReplicaRecord;
  } | null>;
  upsertCrossIdentitySyncRelationship(
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      sourceReplicaId: string;
      targetDeploymentIdentityId: string;
      idempotencyKey: string;
      targetUserId?: string;
      targetTeamId?: string | null;
      targetExternalReplicaId?: string | null;
      syncMode?: SyncMode;
      policyManifest?: Record<string, unknown>;
      consentManifest?: Record<string, unknown>;
      cursorManifest?: Record<string, unknown>;
    }
  ): Promise<{
    relationship: CrossIdentitySyncRelationshipRecord;
    targetReplica: MemoryReplicaRecord;
  } | null>;
  createSyncPackageUploadSession(
    actor: ActorContext,
    input: {
      syncRelationshipId: string;
      idempotencyKey: string;
      packageManifest: Record<string, unknown>;
      packageChecksum: string;
      totalBytes?: number;
      packageFormatVersion?: number;
    }
  ): Promise<SyncPackageUploadSessionRecord | null>;
  recordSyncPackageChunk(
    actor: ActorContext,
    input: {
      uploadSessionId: string;
      chunkIndex: number;
      chunkChecksum: string;
      byteCount: number;
      storageRef?: string | null;
    }
  ): Promise<SyncPackageChunkRecord | null>;
  enqueueSyncOutboxEntry(
    actor: ActorContext,
    input: {
      syncRelationshipId: string;
      idempotencyKey: string;
      uploadSessionId?: string | null;
      payloadManifest?: Record<string, unknown>;
      maxAttempts?: number;
      availableAt?: Date;
    }
  ): Promise<SyncQueueEntryRecord | null>;
  recordSyncInboxEntry(
    actor: ActorContext,
    input: {
      syncRelationshipId: string;
      idempotencyKey: string;
      uploadSessionId?: string | null;
      payloadManifest?: Record<string, unknown>;
      maxAttempts?: number;
      availableAt?: Date;
    }
  ): Promise<SyncQueueEntryRecord | null>;
  transitionCrossIdentitySyncRelationship(
    actor: ActorContext,
    input: {
      syncRelationshipId: string;
      state: Exclude<SyncRelationshipState, "revoked">;
      cursorManifest?: Record<string, unknown>;
      lastPackageId?: string | null;
      lastErrorMessage?: string | null;
    }
  ): Promise<CrossIdentitySyncRelationshipRecord | null>;
  revokeCrossIdentitySyncRelationship(
    actor: ActorContext,
    input: {
      syncRelationshipId: string;
      reason?: string | null;
    }
  ): Promise<CrossIdentitySyncRelationshipRecord | null>;
  getCrossIdentitySyncRelationship(
    actor: ActorContext,
    syncRelationshipId: string
  ): Promise<CrossIdentitySyncRelationshipRecord | null>;
}

type DeploymentIdentityRow = {
  id: string;
  owner_user_id: string;
  deployment_key: string;
  profile: DeploymentProfile;
  display_name: string | null;
  base_url: string | null;
  upstream_backend_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  disabled_at: Date | null;
  disabled_reason: string | null;
};

type LogicalMemoryRow = {
  id: string;
  owner_user_id: string;
  source_boundary: SyncSourceBoundary;
  source_session_id: string;
  logical_key: string;
  lineage: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
};

type MemoryReplicaRow = {
  id: string;
  logical_memory_id: string;
  deployment_identity_id: string;
  owner_user_id: string;
  replica_role: SyncReplicaRole;
  source_boundary: SyncSourceBoundary;
  source_session_id: string;
  external_replica_id: string | null;
  freshness_status: "unknown" | "fresh" | "stale" | "revoked" | "failed";
  cursor_manifest: Record<string, unknown>;
  policy_manifest: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  last_synced_at: Date | null;
  stale_after: Date | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
};

type SyncRelationshipRow = {
  id: string;
  logical_memory_id: string;
  source_replica_id: string;
  target_replica_id: string;
  source_deployment_identity_id: string;
  target_deployment_identity_id: string;
  source_owner_user_id: string;
  target_user_id: string;
  target_team_id: string | null;
  source_boundary: SyncSourceBoundary;
  source_session_id: string;
  sync_mode: SyncMode;
  state: SyncRelationshipState;
  idempotency_key: string;
  policy_manifest: Record<string, unknown>;
  consent_manifest: Record<string, unknown>;
  cursor_manifest: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  last_package_id: string | null;
  last_synced_at: Date | null;
  failed_at: Date | null;
  last_error_message: string | null;
  revoked_at: Date | null;
  revoked_by_user_id: string | null;
  revocation_reason: string | null;
};

type SyncPackageUploadSessionRow = {
  id: string;
  sync_relationship_id: string;
  logical_memory_id: string;
  source_replica_id: string;
  target_replica_id: string;
  state: SyncPackageState;
  package_format_version: number;
  package_manifest: Record<string, unknown>;
  package_checksum: string;
  total_bytes: string | number;
  uploaded_bytes: string | number;
  chunk_count: number;
  verified_chunk_count: number;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
  uploaded_at: Date | null;
  verified_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  last_error_message: string | null;
};

type SyncPackageChunkRow = {
  id: string;
  upload_session_id: string;
  chunk_index: number;
  chunk_checksum: string;
  byte_count: number;
  storage_ref: string | null;
  received_at: Date;
};

type SyncQueueEntryRow = {
  id: string;
  sync_relationship_id: string;
  upload_session_id: string | null;
  state: SyncQueueEntryState;
  idempotency_key: string;
  payload_manifest: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  available_at: Date;
  locked_at: Date | null;
  processed_at: Date | null;
  last_error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

const mapDeploymentIdentity = (
  row: DeploymentIdentityRow
): DeploymentIdentityRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  deploymentKey: row.deployment_key,
  profile: row.profile,
  displayName: row.display_name,
  baseUrl: row.base_url,
  upstreamBackendId: row.upstream_backend_id,
  metadata: row.metadata ?? {},
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  disabledAt: timestampIso(row.disabled_at),
  disabledReason: row.disabled_reason
});

const mapLogicalMemory = (row: LogicalMemoryRow): LogicalMemoryRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  sourceBoundary: row.source_boundary,
  sourceSessionId: row.source_session_id,
  logicalKey: row.logical_key,
  lineage: row.lineage ?? {},
  metadata: row.metadata ?? {},
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  invalidatedAt: timestampIso(row.invalidated_at),
  invalidationReason: row.invalidation_reason
});

const mapMemoryReplica = (row: MemoryReplicaRow): MemoryReplicaRecord => ({
  id: row.id,
  logicalMemoryId: row.logical_memory_id,
  deploymentIdentityId: row.deployment_identity_id,
  ownerUserId: row.owner_user_id,
  replicaRole: row.replica_role,
  sourceBoundary: row.source_boundary,
  sourceSessionId: row.source_session_id,
  externalReplicaId: row.external_replica_id,
  freshnessStatus: row.freshness_status,
  cursorManifest: row.cursor_manifest ?? {},
  policyManifest: row.policy_manifest ?? {},
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  lastSyncedAt: timestampIso(row.last_synced_at),
  staleAfter: timestampIso(row.stale_after),
  disabledAt: timestampIso(row.disabled_at),
  disabledReason: row.disabled_reason
});

const mapSyncRelationship = (
  row: SyncRelationshipRow
): CrossIdentitySyncRelationshipRecord => ({
  id: row.id,
  logicalMemoryId: row.logical_memory_id,
  sourceReplicaId: row.source_replica_id,
  targetReplicaId: row.target_replica_id,
  sourceDeploymentIdentityId: row.source_deployment_identity_id,
  targetDeploymentIdentityId: row.target_deployment_identity_id,
  sourceOwnerUserId: row.source_owner_user_id,
  targetUserId: row.target_user_id,
  targetTeamId: row.target_team_id,
  sourceBoundary: row.source_boundary,
  sourceSessionId: row.source_session_id,
  syncMode: row.sync_mode,
  state: row.state,
  idempotencyKey: row.idempotency_key,
  policyManifest: row.policy_manifest ?? {},
  consentManifest: row.consent_manifest ?? {},
  cursorManifest: row.cursor_manifest ?? {},
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  lastPackageId: row.last_package_id,
  lastSyncedAt: timestampIso(row.last_synced_at),
  failedAt: timestampIso(row.failed_at),
  lastErrorMessage: row.last_error_message,
  revokedAt: timestampIso(row.revoked_at),
  revokedByUserId: row.revoked_by_user_id,
  revocationReason: row.revocation_reason
});

const mapSyncPackageUploadSession = (
  row: SyncPackageUploadSessionRow
): SyncPackageUploadSessionRecord => ({
  id: row.id,
  syncRelationshipId: row.sync_relationship_id,
  logicalMemoryId: row.logical_memory_id,
  sourceReplicaId: row.source_replica_id,
  targetReplicaId: row.target_replica_id,
  state: row.state,
  packageFormatVersion: row.package_format_version,
  packageManifest: row.package_manifest ?? {},
  packageChecksum: row.package_checksum,
  totalBytes: Number(row.total_bytes),
  uploadedBytes: Number(row.uploaded_bytes),
  chunkCount: row.chunk_count,
  verifiedChunkCount: row.verified_chunk_count,
  idempotencyKey: row.idempotency_key,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  uploadedAt: timestampIso(row.uploaded_at),
  verifiedAt: timestampIso(row.verified_at),
  completedAt: timestampIso(row.completed_at),
  failedAt: timestampIso(row.failed_at),
  lastErrorMessage: row.last_error_message
});

const mapSyncPackageChunk = (
  row: SyncPackageChunkRow
): SyncPackageChunkRecord => ({
  id: row.id,
  uploadSessionId: row.upload_session_id,
  chunkIndex: row.chunk_index,
  chunkChecksum: row.chunk_checksum,
  byteCount: row.byte_count,
  storageRef: row.storage_ref,
  receivedAt: row.received_at.toISOString()
});

const mapSyncQueueEntry = (row: SyncQueueEntryRow): SyncQueueEntryRecord => ({
  id: row.id,
  syncRelationshipId: row.sync_relationship_id,
  uploadSessionId: row.upload_session_id,
  state: row.state,
  idempotencyKey: row.idempotency_key,
  payloadManifest: row.payload_manifest ?? {},
  attemptCount: row.attempt_count,
  maxAttempts: row.max_attempts,
  availableAt: row.available_at.toISOString(),
  lockedAt: timestampIso(row.locked_at),
  processedAt: timestampIso(row.processed_at),
  lastErrorMessage: row.last_error_message,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

const normalizeKey = (value: string, field: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty`);
  }
  return normalized;
};

const assertNonNegativeInteger = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
};

const assertPositiveInteger = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
};

const getRelationshipForActor = async (
  pool: pg.Pool,
  actor: ActorContext,
  relationshipId: string
): Promise<SyncRelationshipRow | null> => {
  const rows = await pool.query<SyncRelationshipRow>(
    `
      select *
      from cross_identity_sync_relationships
      where id = $1
        and (source_owner_user_id = $2 or target_user_id = $2)
      limit 1
    `,
    [relationshipId, actor.userId]
  );
  return rows.rows[0] ?? null;
};

const insertSyncQueueEntry = async (
  pool: pg.Pool,
  table: "sync_outbox_entries" | "sync_inbox_entries",
  actor: ActorContext,
  input: {
    syncRelationshipId: string;
    idempotencyKey: string;
    uploadSessionId?: string | null;
    payloadManifest?: Record<string, unknown>;
    maxAttempts?: number;
    availableAt?: Date;
  }
): Promise<SyncQueueEntryRecord | null> => {
  const relationship = await getRelationshipForActor(
    pool,
    actor,
    input.syncRelationshipId
  );
  if (!relationship || relationship.revoked_at) {
    return null;
  }

  const maxAttempts = assertPositiveInteger(
    input.maxAttempts ?? 5,
    "maxAttempts"
  );
  const rows = await pool.query<SyncQueueEntryRow>(
    `
      insert into ${table} (
        sync_relationship_id,
        upload_session_id,
        idempotency_key,
        payload_manifest,
        max_attempts,
        available_at
      )
      values ($1, $2, $3, $4::jsonb, $5, coalesce($6::timestamptz, now()))
      on conflict (sync_relationship_id, idempotency_key)
      do update set
        payload_manifest = ${table}.payload_manifest,
        updated_at = ${table}.updated_at
      returning *
    `,
    [
      input.syncRelationshipId,
      input.uploadSessionId ?? null,
      normalizeKey(input.idempotencyKey, "idempotencyKey"),
      JSON.stringify(input.payloadManifest ?? {}),
      maxAttempts,
      input.availableAt ?? null
    ]
  );
  return rows.rows[0] ? mapSyncQueueEntry(rows.rows[0]) : null;
};

export const createCrossIdentitySyncRepository = (
  pool: pg.Pool
): CrossIdentitySyncRepository => ({
  async upsertDeploymentIdentity(actor, input) {
    const rows = await pool.query<DeploymentIdentityRow>(
      `
        insert into deployment_identities (
          owner_user_id,
          deployment_key,
          profile,
          display_name,
          base_url,
          upstream_backend_id,
          metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        on conflict (owner_user_id, deployment_key)
        do update set
          profile = excluded.profile,
          display_name = excluded.display_name,
          base_url = excluded.base_url,
          upstream_backend_id = excluded.upstream_backend_id,
          metadata = deployment_identities.metadata || excluded.metadata,
          disabled_at = null,
          disabled_reason = null,
          updated_at = now()
        returning *
      `,
      [
        actor.userId,
        normalizeKey(input.deploymentKey, "deploymentKey"),
        input.profile,
        input.displayName ?? null,
        input.baseUrl ?? null,
        input.upstreamBackendId ?? null,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return mapDeploymentIdentity(rows.rows[0]!);
  },

  async upsertCapturedSessionLogicalMemory(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const sessionRows = await client.query<{
        id: string;
        owner_user_id: string;
      }>(
        `
          select id, owner_user_id
          from sessions
          where id = $1
            and owner_user_id = $2
            and visibility = 'personal'
            and invalidated_at is null
            and personal_deleted_at is null
          limit 1
          for update
        `,
        [input.sessionId, actor.userId]
      );
      const session = sessionRows.rows[0];
      if (!session) {
        await client.query("rollback");
        return null;
      }

      const deploymentRows = await client.query<{ id: string }>(
        `
          select id
          from deployment_identities
          where id = $1
            and owner_user_id = $2
            and disabled_at is null
          limit 1
        `,
        [input.deploymentIdentityId, actor.userId]
      );
      if (!deploymentRows.rows[0]) {
        await client.query("rollback");
        return null;
      }

      const logicalKey = normalizeKey(
        input.logicalKey ?? `captured-session:${session.id}`,
        "logicalKey"
      );
      const logicalRows = await client.query<LogicalMemoryRow>(
        `
          insert into logical_memories (
            owner_user_id,
            source_boundary,
            source_session_id,
            logical_key,
            lineage,
            metadata
          )
          values ($1, 'captured_session', $2, $3, $4::jsonb, $5::jsonb)
          on conflict (owner_user_id, source_session_id)
          where source_session_id is not null
          do update set
            logical_key = logical_memories.logical_key,
            lineage = logical_memories.lineage || excluded.lineage,
            metadata = logical_memories.metadata || excluded.metadata,
            updated_at = now()
          returning *
        `,
        [
          actor.userId,
          session.id,
          logicalKey,
          JSON.stringify(input.lineage ?? {}),
          JSON.stringify(input.metadata ?? {})
        ]
      );
      const logicalMemory = logicalRows.rows[0]!;

      const replicaRows = await client.query<MemoryReplicaRow>(
        `
          insert into memory_replicas (
            logical_memory_id,
            deployment_identity_id,
            owner_user_id,
            replica_role,
            source_boundary,
            source_session_id,
            external_replica_id,
            cursor_manifest,
            policy_manifest
          )
          values ($1, $2, $3, 'source', 'captured_session', $4, $5, $6::jsonb, $7::jsonb)
          on conflict (logical_memory_id, deployment_identity_id, replica_role)
          do update set
            external_replica_id = coalesce(memory_replicas.external_replica_id, excluded.external_replica_id),
            cursor_manifest = memory_replicas.cursor_manifest || excluded.cursor_manifest,
            policy_manifest = memory_replicas.policy_manifest || excluded.policy_manifest,
            disabled_at = null,
            disabled_reason = null,
            updated_at = now()
          returning *
        `,
        [
          logicalMemory.id,
          input.deploymentIdentityId,
          actor.userId,
          session.id,
          input.externalReplicaId ?? null,
          JSON.stringify(input.cursorManifest ?? {}),
          JSON.stringify(input.policyManifest ?? {})
        ]
      );

      await client.query("commit");
      return {
        logicalMemory: mapLogicalMemory(logicalMemory),
        sourceReplica: mapMemoryReplica(replicaRows.rows[0]!)
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async upsertCrossIdentitySyncRelationship(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const sourceRows = await client.query<
        MemoryReplicaRow & {
          source_deployment_identity_id: string;
          logical_owner_user_id: string;
        }
      >(
        `
          select
            mr.*,
            mr.deployment_identity_id as source_deployment_identity_id,
            lm.owner_user_id as logical_owner_user_id
          from memory_replicas mr
          join logical_memories lm on lm.id = mr.logical_memory_id
          where mr.id = $1
            and mr.logical_memory_id = $2
            and mr.owner_user_id = $3
            and mr.replica_role = 'source'
            and mr.disabled_at is null
            and lm.invalidated_at is null
          limit 1
          for update
        `,
        [input.sourceReplicaId, input.logicalMemoryId, actor.userId]
      );
      const sourceReplica = sourceRows.rows[0];
      if (!sourceReplica) {
        await client.query("rollback");
        return null;
      }

      const targetUserId = input.targetUserId ?? actor.userId;
      const targetDeploymentRows = await client.query<{ id: string }>(
        `
          select id
          from deployment_identities
          where id = $1
            and owner_user_id = $2
            and disabled_at is null
          limit 1
        `,
        [input.targetDeploymentIdentityId, targetUserId]
      );
      if (!targetDeploymentRows.rows[0]) {
        await client.query("rollback");
        return null;
      }

      const targetReplicaRows = await client.query<MemoryReplicaRow>(
        `
          insert into memory_replicas (
            logical_memory_id,
            deployment_identity_id,
            owner_user_id,
            replica_role,
            source_boundary,
            source_session_id,
            external_replica_id,
            policy_manifest
          )
          values ($1, $2, $3, 'target', $4, $5, $6, $7::jsonb)
          on conflict (logical_memory_id, deployment_identity_id, replica_role)
          do update set
            external_replica_id = coalesce(memory_replicas.external_replica_id, excluded.external_replica_id),
            policy_manifest = memory_replicas.policy_manifest || excluded.policy_manifest,
            disabled_at = null,
            disabled_reason = null,
            updated_at = now()
          returning *
        `,
        [
          input.logicalMemoryId,
          input.targetDeploymentIdentityId,
          targetUserId,
          sourceReplica.source_boundary,
          sourceReplica.source_session_id,
          input.targetExternalReplicaId ?? null,
          JSON.stringify(input.policyManifest ?? {})
        ]
      );
      const targetReplica = targetReplicaRows.rows[0]!;

      const relationshipRows = await client.query<SyncRelationshipRow>(
        `
          insert into cross_identity_sync_relationships (
            logical_memory_id,
            source_replica_id,
            target_replica_id,
            source_deployment_identity_id,
            target_deployment_identity_id,
            source_owner_user_id,
            target_user_id,
            target_team_id,
            source_boundary,
            source_session_id,
            sync_mode,
            idempotency_key,
            policy_manifest,
            consent_manifest,
            cursor_manifest
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb
          )
          on conflict (source_owner_user_id, idempotency_key)
          do update set
            policy_manifest = cross_identity_sync_relationships.policy_manifest || excluded.policy_manifest,
            consent_manifest = cross_identity_sync_relationships.consent_manifest || excluded.consent_manifest,
            cursor_manifest = cross_identity_sync_relationships.cursor_manifest || excluded.cursor_manifest,
            updated_at = now()
          where cross_identity_sync_relationships.logical_memory_id = excluded.logical_memory_id
            and cross_identity_sync_relationships.source_replica_id = excluded.source_replica_id
            and cross_identity_sync_relationships.target_replica_id = excluded.target_replica_id
            and cross_identity_sync_relationships.source_deployment_identity_id = excluded.source_deployment_identity_id
            and cross_identity_sync_relationships.target_deployment_identity_id = excluded.target_deployment_identity_id
            and cross_identity_sync_relationships.source_owner_user_id = excluded.source_owner_user_id
            and cross_identity_sync_relationships.target_user_id = excluded.target_user_id
            and cross_identity_sync_relationships.source_boundary = excluded.source_boundary
            and cross_identity_sync_relationships.source_session_id = excluded.source_session_id
            and cross_identity_sync_relationships.sync_mode = excluded.sync_mode
            and cross_identity_sync_relationships.revoked_at is null
          returning *
        `,
        [
          input.logicalMemoryId,
          input.sourceReplicaId,
          targetReplica.id,
          sourceReplica.source_deployment_identity_id,
          input.targetDeploymentIdentityId,
          actor.userId,
          targetUserId,
          input.targetTeamId ?? null,
          sourceReplica.source_boundary,
          sourceReplica.source_session_id,
          input.syncMode ?? "live",
          normalizeKey(input.idempotencyKey, "idempotencyKey"),
          JSON.stringify(input.policyManifest ?? {}),
          JSON.stringify(input.consentManifest ?? {}),
          JSON.stringify(input.cursorManifest ?? {})
        ]
      );

      const relationship = relationshipRows.rows[0];
      if (!relationship) {
        await client.query("rollback");
        return null;
      }
      await client.query("commit");
      return {
        relationship: mapSyncRelationship(relationship),
        targetReplica: mapMemoryReplica(targetReplica)
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async createSyncPackageUploadSession(actor, input) {
    const relationship = await getRelationshipForActor(
      pool,
      actor,
      input.syncRelationshipId
    );
    if (!relationship || relationship.revoked_at) {
      return null;
    }
    validateEncryptedSyncPackageManifest(input.packageManifest);
    const totalBytes = assertNonNegativeInteger(
      input.totalBytes ?? 0,
      "totalBytes"
    );
    const packageFormatVersion = assertPositiveInteger(
      input.packageFormatVersion ?? 1,
      "packageFormatVersion"
    );
    const rows = await pool.query<SyncPackageUploadSessionRow>(
      `
        insert into sync_package_upload_sessions (
          sync_relationship_id,
          logical_memory_id,
          source_replica_id,
          target_replica_id,
          package_format_version,
          package_manifest,
          package_checksum,
          total_bytes,
          idempotency_key
        )
        values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
        on conflict (sync_relationship_id, idempotency_key)
        do update set
          package_manifest = sync_package_upload_sessions.package_manifest,
          package_checksum = sync_package_upload_sessions.package_checksum,
          updated_at = sync_package_upload_sessions.updated_at
        returning *
      `,
      [
        relationship.id,
        relationship.logical_memory_id,
        relationship.source_replica_id,
        relationship.target_replica_id,
        packageFormatVersion,
        JSON.stringify(input.packageManifest),
        normalizeKey(input.packageChecksum, "packageChecksum"),
        totalBytes,
        normalizeKey(input.idempotencyKey, "idempotencyKey")
      ]
    );
    return rows.rows[0] ? mapSyncPackageUploadSession(rows.rows[0]) : null;
  },

  async recordSyncPackageChunk(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const uploadRows = await client.query<{
        id: string;
        sync_relationship_id: string;
        uploaded_bytes: string | number;
      }>(
        `
          select spu.id, spu.sync_relationship_id, spu.uploaded_bytes
          from sync_package_upload_sessions spu
          join cross_identity_sync_relationships sr
            on sr.id = spu.sync_relationship_id
          where spu.id = $1
            and (sr.source_owner_user_id = $2 or sr.target_user_id = $2)
            and sr.revoked_at is null
          limit 1
          for update
        `,
        [input.uploadSessionId, actor.userId]
      );
      const upload = uploadRows.rows[0];
      if (!upload) {
        await client.query("rollback");
        return null;
      }

      const chunkRows = await client.query<SyncPackageChunkRow>(
        `
          insert into sync_package_chunks (
            upload_session_id,
            chunk_index,
            chunk_checksum,
            byte_count,
            storage_ref
          )
          values ($1, $2, $3, $4, $5)
          on conflict (upload_session_id, chunk_index)
          do update set
            chunk_checksum = sync_package_chunks.chunk_checksum,
            byte_count = sync_package_chunks.byte_count,
            storage_ref = coalesce(sync_package_chunks.storage_ref, excluded.storage_ref)
          returning *
        `,
        [
          upload.id,
          assertNonNegativeInteger(input.chunkIndex, "chunkIndex"),
          normalizeKey(input.chunkChecksum, "chunkChecksum"),
          assertNonNegativeInteger(input.byteCount, "byteCount"),
          input.storageRef ?? null
        ]
      );
      const chunk = chunkRows.rows[0]!;

      await client.query(
        `
          update sync_package_upload_sessions
          set
            uploaded_bytes = coalesce((
              select sum(byte_count)::bigint
              from sync_package_chunks
              where upload_session_id = $1
            ), 0),
            chunk_count = (
              select count(*)::int
              from sync_package_chunks
              where upload_session_id = $1
            ),
            state = case when state = 'created' then 'uploading' else state end,
            updated_at = now()
          where id = $1
        `,
        [upload.id]
      );
      await client.query("commit");
      return mapSyncPackageChunk(chunk);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async enqueueSyncOutboxEntry(actor, input) {
    return insertSyncQueueEntry(pool, "sync_outbox_entries", actor, input);
  },

  async recordSyncInboxEntry(actor, input) {
    return insertSyncQueueEntry(pool, "sync_inbox_entries", actor, input);
  },

  async transitionCrossIdentitySyncRelationship(actor, input) {
    const relationship = await getRelationshipForActor(
      pool,
      actor,
      input.syncRelationshipId
    );
    if (!relationship || relationship.revoked_at) {
      return null;
    }
    const rows = await pool.query<SyncRelationshipRow>(
      `
        update cross_identity_sync_relationships
        set
          state = $3,
          cursor_manifest = case
            when $4::jsonb is null then cursor_manifest
            else cursor_manifest || $4::jsonb
          end,
          last_package_id = coalesce($5, last_package_id),
          last_error_message = $6,
          failed_at = case when $3 = 'failed' then now() else failed_at end,
          last_synced_at = case
            when $3 in ('uploaded', 'verified', 'ready') then now()
            else last_synced_at
          end,
          updated_at = now()
        where id = $1
          and (source_owner_user_id = $2 or target_user_id = $2)
          and revoked_at is null
        returning *
      `,
      [
        input.syncRelationshipId,
        actor.userId,
        input.state,
        input.cursorManifest ? JSON.stringify(input.cursorManifest) : null,
        input.lastPackageId ?? null,
        input.lastErrorMessage ?? null
      ]
    );
    return rows.rows[0] ? mapSyncRelationship(rows.rows[0]) : null;
  },

  async revokeCrossIdentitySyncRelationship(actor, input) {
    const rows = await pool.query<SyncRelationshipRow>(
      `
        update cross_identity_sync_relationships
        set
          state = 'revoked',
          revoked_at = now(),
          revoked_by_user_id = $2,
          revocation_reason = nullif(trim($3::text), ''),
          updated_at = now()
        where id = $1
          and source_owner_user_id = $2
          and revoked_at is null
        returning *
      `,
      [input.syncRelationshipId, actor.userId, input.reason ?? null]
    );
    const relationship = rows.rows[0];
    if (!relationship) {
      return null;
    }
    await pool.query(
      `
        update memory_replicas
        set freshness_status = 'revoked',
            disabled_at = now(),
            disabled_reason = 'sync_revoked',
            updated_at = now()
        where id = $1
      `,
      [relationship.target_replica_id]
    );
    return mapSyncRelationship(relationship);
  },

  async getCrossIdentitySyncRelationship(actor, syncRelationshipId) {
    const row = await getRelationshipForActor(pool, actor, syncRelationshipId);
    return row ? mapSyncRelationship(row) : null;
  }
});
