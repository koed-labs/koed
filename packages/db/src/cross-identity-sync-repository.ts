import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  CAPTURED_SESSION_SYNC_MAX_CHANGES,
  CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES,
  CAPTURED_SESSION_SYNC_MAX_CONTRIBUTORS_PER_EVENT,
  crossIdentitySyncDigest,
  type CapturedSessionSyncChangeV1,
  type CapturedSessionSyncContributorV1,
  type CapturedSessionSyncPackageV1,
  type EncryptedJsonPackage,
  type EnvelopeEncryptionProvider,
  type RecipientKeyMaterial
} from "@koed/shared";
import { upsertEncryptedFieldPayloadWithClient } from "./encrypted-payload-repository.js";
import { invalidateDerivedMemoryForMemoryEvents } from "./derived-memory-invalidation.js";
import { recordAuditEventWithClient } from "./audit-repository.js";
import type { RecordAuditEventInput } from "./types.js";
import type { ActorContext } from "./types.js";

export interface SyncActorContext extends ActorContext {
  deviceCredentialId?: string | null;
}

export type DeploymentProfile =
  | "developer"
  | "local_personal"
  | "private_vps"
  | "team_self_hosted"
  | "koed_managed_cloud";
export type SyncSourceBoundary = "captured_session";
export type SyncReplicaRole = "source" | "target";
export type SyncMode = "live" | "offload";
export type SyncRelationshipSide = "source" | "target";
export type SyncRelationshipState =
  | "created"
  | "uploading"
  | "uploaded"
  | "verified"
  | "processing"
  | "partially_available"
  | "ready"
  | "stale"
  | "paused"
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

export class SyncIdempotencyConflictError extends Error {
  statusCode = 409;
  constructor() {
    super("Cross-Identity Sync idempotency conflict");
    this.name = "SyncIdempotencyConflictError";
  }
}

export class SyncStateConflictError extends Error {
  statusCode = 409;
  constructor(message = "Cross-Identity Sync state conflict") {
    super(message);
    this.name = "SyncStateConflictError";
  }
}

export interface DeploymentIdentityRecord {
  id: string;
  protocolDeploymentId: string;
  locality: "local" | "remote";
  profile: DeploymentProfile;
  baseUrl: string | null;
  upstreamBackendId: string | null;
}

export interface ExternalSyncUserIdentityRecord {
  id: string;
  deploymentIdentityId: string;
  externalSubjectId: string;
  status: "active" | "revoked";
}

export interface MemoryReplicaRecord {
  id: string;
  logicalMemoryId: string;
  deploymentIdentityId: string;
  ownerUserId: string;
  replicaRole: SyncReplicaRole;
  localSessionId: string | null;
  freshnessStatus: string;
}

export interface LogicalMemoryRecord {
  id: string;
  ownerUserId: string;
  originDeploymentIdentityId: string;
  sourceBoundary: SyncSourceBoundary;
  originSourceId: string;
  localSessionId: string | null;
  logicalKey: string;
}

export interface CrossIdentitySyncRelationshipRecord {
  id: string;
  logicalMemoryId: string;
  side: SyncRelationshipSide;
  localReplicaId: string;
  localUserId: string;
  remoteDeploymentIdentityId: string;
  remoteUserIdentityId: string;
  remoteReplicaId: string | null;
  sourceBoundary: SyncSourceBoundary;
  syncMode: SyncMode;
  state: SyncRelationshipState;
  idempotencyKey: string;
  creationRequestHash: string;
  policyManifest: Record<string, unknown>;
  consentManifest: Record<string, unknown>;
  sourceCursor: number;
  targetProcessingCursor: number;
  packageSequence: number;
  lastPackageId: string | null;
  lastSyncedAt: string | null;
  staleAfter: string | null;
  revokedAt: string | null;
  revocationId: string | null;
}

export interface SyncPackageUploadSessionRecord {
  id: string;
  syncRelationshipId: string;
  protocolPackageId: string;
  state: SyncPackageState;
  packageFormatVersion: number;
  requestHash: string;
  packageManifest: Record<string, unknown>;
  packageChecksum: string;
  sourceSequence: number;
  fromCursor: number;
  toCursor: number;
  totalBytes: number;
  uploadedBytes: number;
  expectedChunkCount: number;
  chunkCount: number;
  verifiedChunkCount: number;
}

export interface SyncPackageChunkRecord {
  id: string;
  uploadSessionId: string;
  chunkIndex: number;
  chunkChecksum: string;
  byteCount: number;
  encryptedPayload: EncryptedJsonPackage;
}

export interface SyncQueueEntryRecord {
  id: string;
  syncRelationshipId: string;
  uploadSessionId: string | null;
  state: SyncQueueEntryState;
  idempotencyKey: string;
  requestHash: string;
  payloadManifest: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  claimToken: string | null;
  leaseExpiresAt: string | null;
}

export interface CrossIdentitySyncOperationalStatus {
  outbox: {
    pending: number;
    processing: number;
    failed: number;
    oldestPendingSeconds: number;
  };
  inbox: {
    pending: number;
    processing: number;
    failed: number;
    oldestPendingSeconds: number;
  };
  relationships: {
    ready: number;
    stale: number;
    failed: number;
    revoked: number;
  };
  retries: number;
  completedBytesLastHour: number;
  completedRecordsLastHour: number;
  sourceLagRecords: number;
  targetLagRecords: number;
}

export interface CrossIdentitySyncRepository {
  getCapturedSessionSyncSource(
    actor: ActorContext,
    sessionId: string
  ): Promise<CapturedSessionSyncPackageV1["session"] | null>;
  ensureLocalSyncDeployment(input: {
    profile: DeploymentProfile;
    protocolDeploymentId?: string;
  }): Promise<DeploymentIdentityRecord>;
  upsertRemoteSyncDeployment(input: {
    protocolDeploymentId: string;
    profile: DeploymentProfile;
    baseUrl?: string | null;
    upstreamBackendId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<DeploymentIdentityRecord>;
  upsertExternalSyncUserIdentity(input: {
    deploymentIdentityId: string;
    externalSubjectId: string;
  }): Promise<ExternalSyncUserIdentityRecord>;
  linkExternalSyncUser(
    actor: ActorContext,
    input: {
      externalUserIdentityId: string;
      proofKind: string;
      proofReference: string;
    }
  ): Promise<void>;
  createSourceSyncRelationship(
    actor: ActorContext,
    input: {
      relationshipId: string;
      logicalMemoryId: string;
      localReplicaId: string;
      sessionId: string;
      localDeploymentIdentityId: string;
      remoteDeploymentIdentityId: string;
      remoteUserIdentityId: string;
      remoteReplicaId: string;
      idempotencyKey: string;
      creationRequestHash: string;
      policyManifest: Record<string, unknown>;
      consentManifest: Record<string, unknown>;
    }
  ): Promise<{
    relationship: CrossIdentitySyncRelationshipRecord;
    logicalMemory: LogicalMemoryRecord;
    localReplica: MemoryReplicaRecord;
  } | null>;
  activateSourceSyncRelationship(input: {
    relationshipId: string;
    localUserId: string;
  }): Promise<CrossIdentitySyncRelationshipRecord | null>;
  createTargetSyncRelationship(
    actor: SyncActorContext,
    input: {
      relationshipId: string;
      logicalMemoryId: string;
      originSessionId: string;
      localDeploymentIdentityId: string;
      remoteDeploymentIdentityId: string;
      remoteUserIdentityId: string;
      remoteReplicaId: string;
      localReplicaId: string;
      idempotencyKey: string;
      creationRequestHash: string;
      policyManifest: Record<string, unknown>;
      consentManifest: Record<string, unknown>;
      session: CapturedSessionSyncPackageV1["session"];
    }
  ): Promise<{
    relationship: CrossIdentitySyncRelationshipRecord;
    logicalMemory: LogicalMemoryRecord;
    localReplica: MemoryReplicaRecord;
  } | null>;
  getCrossIdentitySyncRelationship(
    actor: SyncActorContext,
    id: string
  ): Promise<CrossIdentitySyncRelationshipRecord | null>;
  getSyncRelationshipForService(
    id: string,
    side?: SyncRelationshipSide
  ): Promise<CrossIdentitySyncRelationshipRecord | null>;
  getSyncTransportContext(
    relationshipId: string,
    input?: { includeRevoked?: boolean }
  ): Promise<{
    relationship: CrossIdentitySyncRelationshipRecord;
    localDeploymentId: string;
    localProtocolDeploymentId: string;
    remoteProtocolDeploymentId: string;
    remoteBaseUrl: string | null;
    remoteUpstreamBackendId: string | null;
    remoteCredentialReference: string | null;
    remoteSubjectId: string;
  } | null>;
  authorizeTargetSyncProcessing(input: {
    relationshipId: string;
    uploadSessionId: string;
  }): Promise<boolean>;
  ensureSyncRecipientKey(input: {
    deploymentIdentityId: string;
    material: RecipientKeyMaterial;
  }): Promise<RecipientKeyMaterial>;
  getActiveSyncRecipientKey(
    deploymentIdentityId: string
  ): Promise<RecipientKeyMaterial | null>;
  getSyncRecipientKey(
    deploymentIdentityId: string,
    keyId: string,
    keyVersion: number
  ): Promise<RecipientKeyMaterial | null>;
  readCapturedSessionSyncDelta(input: {
    relationshipId: string;
    limit?: number;
  }): Promise<{
    relationship: CrossIdentitySyncRelationshipRecord;
    session: CapturedSessionSyncPackageV1["session"];
    changes: CapturedSessionSyncChangeV1[];
    fromCursor: number;
    toCursor: number;
  } | null>;
  createSyncPackageUploadSession(
    actor: SyncActorContext,
    input: {
      syncRelationshipId: string;
      protocolPackageId: string;
      idempotencyKey: string;
      requestHash: string;
      packageManifest: Record<string, unknown>;
      packageChecksum: string;
      totalBytes: number;
      expectedChunkCount: number;
      sourceSequence: number;
      fromCursor: number;
      toCursor: number;
      relationshipSide?: SyncRelationshipSide;
    }
  ): Promise<SyncPackageUploadSessionRecord | null>;
  recordSyncPackageChunk(
    actor: SyncActorContext,
    input: {
      uploadSessionId: string;
      chunkIndex: number;
      chunkChecksum: string;
      byteCount: number;
      encryptedPayload: EncryptedJsonPackage;
      relationshipSide?: SyncRelationshipSide;
    }
  ): Promise<SyncPackageChunkRecord | null>;
  getSyncPackageUploadSession(
    actor: SyncActorContext,
    id: string,
    relationshipSide?: SyncRelationshipSide
  ): Promise<{
    upload: SyncPackageUploadSessionRecord;
    chunks: SyncPackageChunkRecord[];
  } | null>;
  getSyncPackageForService(id: string): Promise<{
    upload: SyncPackageUploadSessionRecord;
    chunks: SyncPackageChunkRecord[];
  } | null>;
  getSyncPackageBySequence(input: {
    relationshipId: string;
    sourceSequence: number;
  }): Promise<{
    upload: SyncPackageUploadSessionRecord;
    chunks: SyncPackageChunkRecord[];
  } | null>;
  deleteIncompleteSourceSyncPackage(input: {
    relationshipId: string;
    uploadSessionId: string;
  }): Promise<boolean>;
  verifySyncPackageUpload(
    actor: SyncActorContext,
    uploadSessionId: string,
    relationshipSide?: SyncRelationshipSide
  ): Promise<SyncPackageUploadSessionRecord | null>;
  enqueueSyncOutboxEntry(input: {
    syncRelationshipId: string;
    idempotencyKey: string;
    requestHash: string;
    uploadSessionId?: string | null;
    payloadManifest?: Record<string, unknown>;
    maxAttempts?: number;
  }): Promise<SyncQueueEntryRecord>;
  enqueueSyncInboxEntry(input: {
    syncRelationshipId: string;
    idempotencyKey: string;
    requestHash: string;
    uploadSessionId: string;
    payloadManifest?: Record<string, unknown>;
    maxAttempts?: number;
  }): Promise<SyncQueueEntryRecord>;
  listDueSourceSyncHeartbeats(input: {
    dueWithinSeconds: number;
    limit?: number;
  }): Promise<
    Array<{
      relationshipId: string;
      sourceCursor: number;
      targetProcessingCursor: number;
      packageSequence: number;
      staleAfter: string;
    }>
  >;
  refreshSourceSyncHeartbeat(input: {
    relationshipId: string;
    sourceCursor: number;
    targetProcessingCursor: number;
    packageSequence: number;
    staleAfterSeconds: number;
  }): Promise<boolean>;
  acceptTargetSyncHeartbeat(
    actor: SyncActorContext,
    input: {
      relationshipId: string;
      sourceCursor: number;
      targetProcessingCursor: number;
      packageSequence: number;
      staleAfterSeconds: number;
    }
  ): Promise<boolean>;
  claimSyncQueueEntry(input: {
    queue: "outbox" | "inbox";
    leaseMs: number;
  }): Promise<SyncQueueEntryRecord | null>;
  completeSyncQueueEntry(input: {
    queue: "outbox" | "inbox";
    id: string;
    claimToken: string;
  }): Promise<boolean>;
  renewSyncQueueLease(input: {
    queue: "outbox" | "inbox";
    id: string;
    claimToken: string;
    leaseMs: number;
  }): Promise<boolean>;
  deferSyncQueueEntry(input: {
    queue: "outbox" | "inbox";
    id: string;
    claimToken: string;
    delayMs: number;
  }): Promise<boolean>;
  failSyncQueueEntry(input: {
    queue: "outbox" | "inbox";
    id: string;
    claimToken: string;
    errorClass: string;
    retryAfterMs: number;
    terminal?: boolean;
  }): Promise<boolean>;
  applyCapturedSessionSyncPackage(input: {
    relationshipId: string;
    uploadSessionId: string;
    package: CapturedSessionSyncPackageV1;
  }): Promise<{ eventIds: string[]; invalidatedEventIds: string[] }>;
  listDerivedMemoryNodeIdsForSyncRelationship(input: {
    relationshipId: string;
    ownerUserId: string;
  }): Promise<string[]>;
  acknowledgeSourceSyncPackage(input: {
    relationshipId: string;
    packageId: string;
    sourceCursor: number;
    targetProcessingCursor: number;
    packageSequence: number;
    staleAfterSeconds: number;
  }): Promise<void>;
  markSourceSyncProcessing(input: {
    relationshipId: string;
    packageId: string;
  }): Promise<void>;
  markSourceSyncUploadCommitted(input: {
    relationshipId: string;
    packageId: string;
  }): Promise<void>;
  markTargetSyncReady(input: {
    relationshipId: string;
    sourceCursor: number;
    packageId: string;
    staleAfterSeconds: number;
  }): Promise<void>;
  markOverdueSyncRelationshipsStale(): Promise<number>;
  recordCrossIdentitySyncWorkerHeartbeat(instanceId: string): Promise<void>;
  isCrossIdentitySyncWorkerReady(maxAgeSeconds?: number): Promise<boolean>;
  retryCrossIdentitySyncRelationship(
    actor: SyncActorContext,
    syncRelationshipId: string
  ): Promise<CrossIdentitySyncRelationshipRecord | null>;
  revokeCrossIdentitySyncRelationship(
    actor: SyncActorContext,
    input: { syncRelationshipId: string; reason?: string | null }
  ): Promise<CrossIdentitySyncRelationshipRecord | null>;
  applyRemoteSyncRevocation(
    actor: SyncActorContext,
    input: {
      syncRelationshipId: string;
      revocationId: string;
      revocationSequence: number;
    }
  ): Promise<CrossIdentitySyncRelationshipRecord | null>;
  getCrossIdentitySyncOperationalStatus(): Promise<CrossIdentitySyncOperationalStatus>;
  cleanupCrossIdentitySyncState(input?: {
    completedRetentionHours?: number;
    abandonedUploadHours?: number;
    terminalQueueRetentionHours?: number;
    terminalUploadRetentionHours?: number;
  }): Promise<{
    chunksDeleted: number;
    uploadsFailed: number;
    queueEntriesDeleted: number;
    uploadSessionsDeleted: number;
  }>;
}

type Row = Record<string, unknown>;
const iso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === "string"
      ? new Date(value).toISOString()
      : null;
const numberValue = (value: unknown): number =>
  typeof value === "number"
    ? value
    : typeof value === "bigint"
      ? Number(value)
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : 0;
const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;
const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const nonEmpty = (value: string, name: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
};
const assertHash = (value: string): string => {
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error("requestHash must be SHA-256");
  return value.toLowerCase();
};
const unsafeControlKey =
  /(?:secret|token|password|cookie|authorization|credential|plaintext|ciphertext|wrapped.?dek|raw.?memory|source.?text)/i;
const assertSafeControlManifest = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(assertSafeControlManifest);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (unsafeControlKey.test(key)) {
      throw new Error("Unsafe Cross-Identity Sync control metadata");
    }
    assertSafeControlManifest(nested);
  }
};
const mapDeployment = (r: Row): DeploymentIdentityRecord => ({
  id: String(r.id),
  protocolDeploymentId: String(r.protocol_deployment_id),
  locality: r.locality as "local" | "remote",
  profile: r.profile as DeploymentProfile,
  baseUrl: optionalString(r.base_url),
  upstreamBackendId: optionalString(r.upstream_backend_id)
});
const mapExternalUser = (r: Row): ExternalSyncUserIdentityRecord => ({
  id: String(r.id),
  deploymentIdentityId: String(r.deployment_identity_id),
  externalSubjectId: String(r.external_subject_id),
  status: r.status as "active" | "revoked"
});
const mapLogical = (r: Row): LogicalMemoryRecord => ({
  id: String(r.id),
  ownerUserId: String(r.owner_user_id),
  originDeploymentIdentityId: String(r.origin_deployment_identity_id),
  sourceBoundary: r.source_boundary as SyncSourceBoundary,
  originSourceId: String(r.origin_source_id),
  localSessionId: optionalString(r.local_session_id),
  logicalKey: String(r.logical_key)
});
const mapReplica = (r: Row): MemoryReplicaRecord => ({
  id: String(r.id),
  logicalMemoryId: String(r.logical_memory_id),
  deploymentIdentityId: String(r.deployment_identity_id),
  ownerUserId: String(r.owner_user_id),
  replicaRole: r.replica_role as SyncReplicaRole,
  localSessionId: optionalString(r.local_session_id),
  freshnessStatus: String(r.freshness_status)
});
const mapRelationship = (r: Row): CrossIdentitySyncRelationshipRecord => ({
  id: String(r.id),
  logicalMemoryId: String(r.logical_memory_id),
  side: r.side as SyncRelationshipSide,
  localReplicaId: String(r.local_replica_id),
  localUserId: String(r.local_user_id),
  remoteDeploymentIdentityId: String(r.remote_deployment_identity_id),
  remoteUserIdentityId: String(r.remote_user_identity_id),
  remoteReplicaId: optionalString(r.remote_replica_id),
  sourceBoundary: r.source_boundary as SyncSourceBoundary,
  syncMode: r.sync_mode as SyncMode,
  state: r.state as SyncRelationshipState,
  idempotencyKey: String(r.idempotency_key),
  creationRequestHash: String(r.creation_request_hash),
  policyManifest: objectValue(r.policy_manifest),
  consentManifest: objectValue(r.consent_manifest),
  sourceCursor: numberValue(r.source_cursor),
  targetProcessingCursor: numberValue(r.target_processing_cursor),
  packageSequence: numberValue(r.package_sequence),
  lastPackageId: optionalString(r.last_package_id),
  lastSyncedAt: iso(r.last_synced_at),
  staleAfter: iso(r.stale_after),
  revokedAt: iso(r.revoked_at),
  revocationId: optionalString(r.revocation_id)
});
const mapUpload = (r: Row): SyncPackageUploadSessionRecord => ({
  id: String(r.id),
  syncRelationshipId: String(r.sync_relationship_id),
  protocolPackageId: String(r.protocol_package_id),
  state: r.state as SyncPackageState,
  packageFormatVersion: numberValue(r.package_format_version),
  requestHash: String(r.request_hash),
  packageManifest: objectValue(r.package_manifest),
  packageChecksum: String(r.package_checksum),
  sourceSequence: numberValue(r.source_sequence),
  fromCursor: numberValue(r.from_cursor),
  toCursor: numberValue(r.to_cursor),
  totalBytes: numberValue(r.total_bytes),
  uploadedBytes: numberValue(r.uploaded_bytes),
  expectedChunkCount: numberValue(r.expected_chunk_count),
  chunkCount: numberValue(r.chunk_count),
  verifiedChunkCount: numberValue(r.verified_chunk_count)
});
const mapChunk = (r: Row): SyncPackageChunkRecord => ({
  id: String(r.id),
  uploadSessionId: String(r.upload_session_id),
  chunkIndex: numberValue(r.chunk_index),
  chunkChecksum: String(r.chunk_checksum),
  byteCount: numberValue(r.byte_count),
  encryptedPayload: r.encrypted_payload as unknown as EncryptedJsonPackage
});
const mapQueue = (r: Row): SyncQueueEntryRecord => ({
  id: String(r.id),
  syncRelationshipId: String(r.sync_relationship_id),
  uploadSessionId: optionalString(r.upload_session_id),
  state: r.state as SyncQueueEntryState,
  idempotencyKey: String(r.idempotency_key),
  requestHash: String(r.request_hash),
  payloadManifest: objectValue(r.payload_manifest),
  attemptCount: numberValue(r.attempt_count),
  maxAttempts: numberValue(r.max_attempts),
  availableAt: iso(r.available_at)!,
  claimToken: optionalString(r.claim_token),
  leaseExpiresAt: iso(r.lease_expires_at)
});

const relationshipForActor = async (
  pool: pg.Pool,
  actor: SyncActorContext,
  id: string
) => {
  const result = await pool.query(
    "select * from cross_identity_sync_relationships where id = $1 and local_user_id = $2 and ($3::uuid is null or device_credential_id = $3) limit 1",
    [id, actor.userId, actor.deviceCredentialId ?? null]
  );
  return result.rows[0] as Row | undefined;
};

const lockActiveSyncDeviceCredential = async (
  client: pg.PoolClient,
  actor: SyncActorContext
): Promise<boolean> => {
  if (!actor.deviceCredentialId) return true;
  const result = await client.query(
    `select credential.id
       from device_credentials credential
       join users owner on owner.id = credential.owner_user_id
      where credential.id = $1
        and credential.owner_user_id = $2
        and credential.revoked_at is null
        and (credential.expires_at is null or credential.expires_at > now())
        and ('sync' = any(credential.operation_families) or '*' = any(credential.operation_families))
        and owner.disabled_at is null
        and owner.deleted_at is null
      for update of credential`,
    [actor.deviceCredentialId, actor.userId]
  );
  return Boolean(result.rows[0]);
};

const relationshipCredentialClause = (
  relationshipAlias: string,
  parameter: number
): string =>
  `($${parameter}::uuid is null or exists (
    select 1
      from device_credentials bound_credential
      join device_credentials presented_credential
        on presented_credential.id = $${parameter}
     where bound_credential.id = ${relationshipAlias}.device_credential_id
       and bound_credential.owner_user_id = presented_credential.owner_user_id
       and bound_credential.upstream_backend_id = presented_credential.upstream_backend_id
       and bound_credential.lineage_id = presented_credential.lineage_id
  ))`;

const contentFromUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(contentFromUnknown).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["content", "text", "message", "output", "result"]) {
    const content = contentFromUnknown(record[key]);
    if (content) return content;
  }
  return "";
};
const sanitizedEventMetadata = (
  metadata: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    ["includeInLcm", "semanticUnitType", "rawEventType", "sourceRole"]
      .filter((key) => metadata[key] !== undefined)
      .map((key) => [key, metadata[key]])
  );

const recordSyncAuditEventWithClient = async (
  client: pg.PoolClient,
  input: RecordAuditEventInput & { metadata: { eventKey: string } }
): Promise<void> => {
  const existing = await client.query(
    "select 1 from audit_events where action=$1 and target_id=$2 and metadata->>'eventKey'=$3 limit 1",
    [input.action, input.targetId ?? null, input.metadata.eventKey]
  );
  if (existing.rowCount) return;
  await recordAuditEventWithClient(client, input);
};

export const createCrossIdentitySyncRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider } = {}
): CrossIdentitySyncRepository => {
  const hydrateField = async (
    actor: ActorContext,
    sourceTable: "memory_events" | "conversation_items",
    sourceId: string,
    sourceColumn: string,
    fallback: unknown
  ): Promise<unknown> => {
    if (!options.envelopeEncryptionProvider) return fallback;
    const result = await pool.query<{
      envelope_version: number;
      provider_mode: string;
      key_id: string;
      key_version: number;
      scope: Record<string, string>;
      provenance: Record<string, string>;
      algorithm: string;
      ciphertext: string;
      nonce: string;
      tag: string;
      wrapped_dek: Record<string, unknown>;
      ciphertext_location: string;
      aad: Record<string, string>;
      envelope_created_at: Date;
      envelope_reencrypted_at: Date | null;
    }>(
      "select envelope_version,provider_mode,key_id,key_version,scope,provenance,algorithm,ciphertext,nonce,tag,wrapped_dek,ciphertext_location,aad,envelope_created_at,envelope_reencrypted_at from encrypted_field_payloads where owner_user_id = $1 and source_table = $2 and source_id = $3 and source_column = $4 and invalidated_at is null limit 1",
      [actor.userId, sourceTable, sourceId, sourceColumn]
    );
    const row = result.rows[0];
    if (!row) return fallback;
    const plaintext = await options.envelopeEncryptionProvider.decrypt({
      version: row.envelope_version,
      providerMode: row.provider_mode,
      keyId: row.key_id,
      keyVersion: row.key_version,
      scope: row.scope,
      provenance: row.provenance,
      algorithm: row.algorithm,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      tag: row.tag,
      wrappedDek: row.wrapped_dek,
      ciphertextLocation: row.ciphertext_location,
      aad: row.aad,
      createdAt: row.envelope_created_at.toISOString(),
      reencryptedAt: row.envelope_reencrypted_at?.toISOString() ?? null
    } as never);
    return JSON.parse(Buffer.from(plaintext).toString("utf8"));
  };

  const queueInsert = async (
    table: "sync_outbox_entries" | "sync_inbox_entries",
    input: {
      syncRelationshipId: string;
      idempotencyKey: string;
      requestHash: string;
      uploadSessionId?: string | null;
      payloadManifest?: Record<string, unknown>;
      maxAttempts?: number;
    }
  ): Promise<SyncQueueEntryRecord> => {
    const hash = assertHash(input.requestHash);
    const result = await pool.query(
      `insert into ${table} (sync_relationship_id, upload_session_id, idempotency_key, request_hash, payload_manifest, max_attempts) values ($1,$2,$3,$4,$5::jsonb,$6) on conflict (sync_relationship_id,idempotency_key) do update set updated_at=${table}.updated_at returning *`,
      [
        input.syncRelationshipId,
        input.uploadSessionId ?? null,
        nonEmpty(input.idempotencyKey, "idempotencyKey"),
        hash,
        JSON.stringify(input.payloadManifest ?? {}),
        input.maxAttempts ?? 8
      ]
    );
    const row = result.rows[0] as Row;
    if (
      String(row.request_hash) !== hash ||
      optionalString(row.upload_session_id) !== (input.uploadSessionId ?? null)
    )
      throw new SyncIdempotencyConflictError();
    return mapQueue(row);
  };

  return {
    async getCapturedSessionSyncSource(actor, sessionId) {
      const result = await pool.query<Row>(
        "select * from sessions where id=$1 and owner_user_id=$2 and visibility='personal' and invalidated_at is null and personal_deleted_at is null limit 1",
        [sessionId, actor.userId]
      );
      const session = result.rows[0];
      if (!session) return null;
      return {
        originSessionId: String(session.id),
        externalSessionId: optionalString(session.external_session_id),
        sourceRuntime: String(session.source_runtime),
        captureMethod: String(session.capture_method),
        capturedAt: iso(session.captured_at)!,
        title:
          typeof objectValue(session.metadata).threadName === "string"
            ? String(objectValue(session.metadata).threadName)
            : null,
        sourceAdapterVersion: optionalString(session.source_adapter_version)
      };
    },
    async ensureLocalSyncDeployment(input) {
      const existing = await pool.query<Row>(
        "select * from deployment_identities where locality='local' limit 1"
      );
      if (existing.rows[0]) return mapDeployment(existing.rows[0] as Row);
      const result = await pool.query(
        "insert into deployment_identities (protocol_deployment_id,locality,profile) values ($1,'local',$2) returning *",
        [input.protocolDeploymentId ?? randomUUID(), input.profile]
      );
      return mapDeployment(result.rows[0] as Row);
    },
    async upsertRemoteSyncDeployment(input) {
      const result = await pool.query(
        "insert into deployment_identities (protocol_deployment_id,locality,profile,base_url,upstream_backend_id,metadata) values ($1,'remote',$2,$3,$4,$5::jsonb) on conflict (protocol_deployment_id) do update set profile=excluded.profile,base_url=excluded.base_url,upstream_backend_id=excluded.upstream_backend_id,metadata=deployment_identities.metadata||excluded.metadata,updated_at=now() where deployment_identities.locality='remote' returning *",
        [
          input.protocolDeploymentId,
          input.profile,
          input.baseUrl ?? null,
          input.upstreamBackendId ?? null,
          JSON.stringify(input.metadata ?? {})
        ]
      );
      if (!result.rows[0])
        throw new SyncStateConflictError(
          "Deployment identity locality conflict"
        );
      return mapDeployment(result.rows[0] as Row);
    },
    async upsertExternalSyncUserIdentity(input) {
      const result = await pool.query(
        "insert into sync_external_user_identities (deployment_identity_id,external_subject_id) values ($1,$2) on conflict (deployment_identity_id,external_subject_id) do update set status='active',revoked_at=null,updated_at=now() returning *",
        [
          input.deploymentIdentityId,
          nonEmpty(input.externalSubjectId, "externalSubjectId")
        ]
      );
      return mapExternalUser(result.rows[0] as Row);
    },
    async linkExternalSyncUser(actor, input) {
      const existing = await pool.query<Row>(
        "select local_user_id,external_user_identity_id from sync_principal_links where proof_kind=$1 and proof_reference=$2",
        [
          nonEmpty(input.proofKind, "proofKind"),
          nonEmpty(input.proofReference, "proofReference")
        ]
      );
      if (
        existing.rows[0] &&
        (String(existing.rows[0].local_user_id) !== actor.userId ||
          String(existing.rows[0].external_user_identity_id) !==
            input.externalUserIdentityId)
      ) {
        throw new SyncStateConflictError(
          "Sync credential is already bound to another external principal"
        );
      }
      await pool
        .query(
          "insert into sync_principal_links (local_user_id,external_user_identity_id,proof_kind,proof_reference) values ($1,$2,$3,$4) on conflict (external_user_identity_id) do update set proof_kind=excluded.proof_kind,proof_reference=excluded.proof_reference,verified_at=now(),revoked_at=null where sync_principal_links.local_user_id=excluded.local_user_id returning id",
          [
            actor.userId,
            input.externalUserIdentityId,
            nonEmpty(input.proofKind, "proofKind"),
            nonEmpty(input.proofReference, "proofReference")
          ]
        )
        .then((result) => {
          if (!result.rows[0]) throw new SyncIdempotencyConflictError();
        });
    },
    async createSourceSyncRelationship(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const sessionResult = await client.query(
          "select * from sessions where id=$1 and owner_user_id=$2 and visibility='personal' and invalidated_at is null and personal_deleted_at is null for update",
          [input.sessionId, actor.userId]
        );
        const session = sessionResult.rows[0] as Row | undefined;
        if (!session) {
          await client.query("rollback");
          return null;
        }
        const logicalResult = await client.query(
          "insert into logical_memories (id,owner_user_id,origin_deployment_identity_id,source_boundary,origin_source_id,local_session_id,logical_key) values ($1,$2,$3,'captured_session',$4::uuid::text,$4::uuid,$5) on conflict (origin_deployment_identity_id,source_boundary,origin_source_id) do update set updated_at=now() where logical_memories.owner_user_id=excluded.owner_user_id returning *",
          [
            input.logicalMemoryId,
            actor.userId,
            input.localDeploymentIdentityId,
            input.sessionId,
            `captured-session:${input.sessionId}`
          ]
        );
        if (!logicalResult.rows[0]) throw new SyncIdempotencyConflictError();
        const logical = mapLogical(logicalResult.rows[0] as Row);
        const replicaResult = await client.query(
          "insert into memory_replicas (id,logical_memory_id,deployment_identity_id,owner_user_id,replica_role,source_boundary,local_session_id,freshness_status) values ($1,$2,$3,$4,'source','captured_session',$5,'fresh') on conflict (logical_memory_id,deployment_identity_id,replica_role) do update set updated_at=now() where memory_replicas.id=excluded.id returning *",
          [
            input.localReplicaId,
            logical.id,
            input.localDeploymentIdentityId,
            actor.userId,
            input.sessionId
          ]
        );
        const replica = mapReplica(replicaResult.rows[0] as Row);
        const relationshipResult = await client.query(
          "insert into cross_identity_sync_relationships (id,logical_memory_id,side,local_replica_id,local_user_id,remote_deployment_identity_id,remote_user_identity_id,remote_replica_id,source_boundary,state,idempotency_key,creation_request_hash,policy_manifest,consent_manifest) values ($1,$2,'source',$3,$4,$5,$6,$7,'captured_session','paused',$8,$9,$10::jsonb,$11::jsonb) on conflict (id) do update set updated_at=cross_identity_sync_relationships.updated_at where cross_identity_sync_relationships.local_user_id=excluded.local_user_id and cross_identity_sync_relationships.remote_deployment_identity_id=excluded.remote_deployment_identity_id and cross_identity_sync_relationships.remote_user_identity_id=excluded.remote_user_identity_id and cross_identity_sync_relationships.creation_request_hash=excluded.creation_request_hash returning *",
          [
            input.relationshipId,
            logical.id,
            replica.id,
            actor.userId,
            input.remoteDeploymentIdentityId,
            input.remoteUserIdentityId,
            input.remoteReplicaId,
            input.idempotencyKey,
            assertHash(input.creationRequestHash),
            JSON.stringify(input.policyManifest),
            JSON.stringify(input.consentManifest)
          ]
        );
        const relationship = mapRelationship(relationshipResult.rows[0] as Row);
        if (
          relationship.creationRequestHash !== input.creationRequestHash ||
          relationship.id !== input.relationshipId
        )
          throw new SyncIdempotencyConflictError();
        await client.query(
          `
            insert into sync_semantic_changes (
              session_id,
              memory_event_id,
              origin_event_id,
              operation,
              revision_hash
            )
            select
              event.session_id,
              event.id,
              event.id,
              case
                when event.invalidated_at is not null or event.personal_deleted_at is not null
                  then 'delete'::sync_change_operation
                else 'upsert'::sync_change_operation
              end,
              encode(digest(event.id::text || ':initial', 'sha256'), 'hex')
            from memory_events event
            where event.session_id = $1
              and event.event_type = 'captured'
              and not exists (
                select 1
                from sync_semantic_changes existing
                where existing.session_id = event.session_id
                  and existing.origin_event_id = event.id
              )
          `,
          [input.sessionId]
        );
        await recordSyncAuditEventWithClient(client, {
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: "personal",
          action: "cross_identity_sync.relationship.created",
          targetTable: "cross_identity_sync_relationships",
          targetId: relationship.id,
          metadata: {
            eventKey: "relationship-created",
            side: "source",
            sourceBoundary: "captured_session"
          }
        });
        await client.query("commit");
        return { relationship, logicalMemory: logical, localReplica: replica };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async activateSourceSyncRelationship(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<Row>(
          `update cross_identity_sync_relationships
              set state=case when state='paused' then 'created' else state end,
                  updated_at=now()
            where id=$1
              and local_user_id=$2
              and side='source'
              and state in ('paused','created','ready','stale')
              and revoked_at is null
            returning *`,
          [input.relationshipId, input.localUserId]
        );
        if (!result.rows[0]) {
          await client.query("rollback");
          return null;
        }
        await client.query(
          "insert into sync_outbox_entries (sync_relationship_id,idempotency_key,request_hash,payload_manifest) values ($1,'changes',$2,'{}') on conflict (sync_relationship_id,idempotency_key) do update set state=case when sync_outbox_entries.state in ('failed','cancelled') then 'pending'::sync_queue_entry_state else sync_outbox_entries.state end,attempt_count=case when sync_outbox_entries.state in ('failed','cancelled') then 0 else sync_outbox_entries.attempt_count end,available_at=case when sync_outbox_entries.state in ('failed','cancelled') then now() else sync_outbox_entries.available_at end,processed_at=case when sync_outbox_entries.state in ('failed','cancelled') then null else sync_outbox_entries.processed_at end,claim_token=null,lease_expires_at=null,last_error_message=case when sync_outbox_entries.state in ('failed','cancelled') then null else sync_outbox_entries.last_error_message end,updated_at=now()",
          [
            input.relationshipId,
            crossIdentitySyncDigest({
              relationshipId: input.relationshipId,
              initial: true
            })
          ]
        );
        await client.query("commit");
        return mapRelationship(result.rows[0]);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async createTargetSyncRelationship(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (
          !actor.deviceCredentialId ||
          !(await lockActiveSyncDeviceCredential(client, actor))
        ) {
          await client.query("rollback");
          return null;
        }
        const existingDeviceBinding = await client.query<Row>(
          `select relationship.device_credential_id,
                  relationship.remote_deployment_identity_id,
                  relationship.remote_user_identity_id
             from cross_identity_sync_relationships relationship
            where relationship.side='target'
              and ${relationshipCredentialClause("relationship", 1)}
            limit 1`,
          [actor.deviceCredentialId]
        );
        if (
          existingDeviceBinding.rows[0] &&
          String(
            existingDeviceBinding.rows[0].remote_deployment_identity_id
          ) !== input.remoteDeploymentIdentityId
        ) {
          throw new SyncStateConflictError(
            "Device credential is already bound to another source deployment"
          );
        }
        if (
          existingDeviceBinding.rows[0] &&
          String(existingDeviceBinding.rows[0].remote_user_identity_id) !==
            input.remoteUserIdentityId
        ) {
          throw new SyncStateConflictError(
            "Device credential lineage is already bound to another source principal"
          );
        }
        const boundDeviceCredentialId = existingDeviceBinding.rows[0]
          ? String(existingDeviceBinding.rows[0].device_credential_id)
          : actor.deviceCredentialId;
        const sessionResult = await client.query(
          "insert into sessions (owner_user_id,visibility,external_session_id,source_runtime,capture_method,idempotency_key,source_kind,source_adapter_version,metadata,captured_at) values ($1,'personal',$2,$3,'api',$4,'koed_sync',$5,$6::jsonb,$7) on conflict (owner_user_id,visibility,idempotency_key) where idempotency_key is not null do update set updated_at=now() returning *",
          [
            actor.userId,
            input.session.externalSessionId,
            input.session.sourceRuntime,
            `sync:${input.logicalMemoryId}:session`,
            input.session.sourceAdapterVersion,
            JSON.stringify({
              syncReplica: true,
              originSessionId: input.originSessionId,
              ...(input.session.title
                ? { threadName: input.session.title }
                : {})
            }),
            input.session.capturedAt
          ]
        );
        if (!sessionResult.rows[0]) throw new SyncIdempotencyConflictError();
        const sessionId = String((sessionResult.rows[0] as Row).id);
        const logicalResult = await client.query(
          "insert into logical_memories (id,owner_user_id,origin_deployment_identity_id,source_boundary,origin_source_id,local_session_id,logical_key) values ($1,$2,$3,'captured_session',$4,$5,$6) on conflict (id) do update set updated_at=now() where logical_memories.owner_user_id=excluded.owner_user_id and logical_memories.origin_deployment_identity_id=excluded.origin_deployment_identity_id and logical_memories.origin_source_id=excluded.origin_source_id returning *",
          [
            input.logicalMemoryId,
            actor.userId,
            input.remoteDeploymentIdentityId,
            input.originSessionId,
            sessionId,
            `captured-session:${input.originSessionId}`
          ]
        );
        if (!logicalResult.rows[0]) throw new SyncIdempotencyConflictError();
        const logical = mapLogical(logicalResult.rows[0] as Row);
        const replicaResult = await client.query(
          "insert into memory_replicas (id,logical_memory_id,deployment_identity_id,owner_user_id,replica_role,source_boundary,local_session_id,freshness_status) values ($1,$2,$3,$4,'target','captured_session',$5,'unknown') on conflict (id) do update set updated_at=now() where memory_replicas.logical_memory_id=excluded.logical_memory_id and memory_replicas.owner_user_id=excluded.owner_user_id returning *",
          [
            input.localReplicaId,
            logical.id,
            input.localDeploymentIdentityId,
            actor.userId,
            sessionId
          ]
        );
        if (!replicaResult.rows[0]) throw new SyncIdempotencyConflictError();
        const replica = mapReplica(replicaResult.rows[0] as Row);
        const relationshipResult = await client.query(
          "insert into cross_identity_sync_relationships (id,logical_memory_id,side,local_replica_id,local_user_id,device_credential_id,remote_deployment_identity_id,remote_user_identity_id,remote_replica_id,source_boundary,idempotency_key,creation_request_hash,policy_manifest,consent_manifest) values ($1,$2,'target',$3,$4,$5,$6,$7,$8,'captured_session',$9,$10,$11::jsonb,$12::jsonb) on conflict (id) do update set updated_at=cross_identity_sync_relationships.updated_at where cross_identity_sync_relationships.local_user_id=excluded.local_user_id and cross_identity_sync_relationships.device_credential_id=excluded.device_credential_id and cross_identity_sync_relationships.creation_request_hash=excluded.creation_request_hash returning *",
          [
            input.relationshipId,
            logical.id,
            replica.id,
            actor.userId,
            boundDeviceCredentialId,
            input.remoteDeploymentIdentityId,
            input.remoteUserIdentityId,
            input.remoteReplicaId,
            input.idempotencyKey,
            assertHash(input.creationRequestHash),
            JSON.stringify(input.policyManifest),
            JSON.stringify(input.consentManifest)
          ]
        );
        if (!relationshipResult.rows[0])
          throw new SyncIdempotencyConflictError();
        await recordSyncAuditEventWithClient(client, {
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: "personal",
          action: "cross_identity_sync.relationship.created",
          targetTable: "cross_identity_sync_relationships",
          targetId: input.relationshipId,
          metadata: {
            eventKey: "relationship-created",
            side: "target",
            sourceBoundary: "captured_session",
            credentialVerified: true
          }
        });
        await client.query("commit");
        return {
          relationship: mapRelationship(relationshipResult.rows[0] as Row),
          logicalMemory: logical,
          localReplica: replica
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async getCrossIdentitySyncRelationship(actor, id) {
      if (!actor.deviceCredentialId) {
        const row = await relationshipForActor(pool, actor, id);
        return row ? mapRelationship(row) : null;
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (!(await lockActiveSyncDeviceCredential(client, actor))) {
          await client.query("rollback");
          return null;
        }
        const result = await client.query<Row>(
          `select * from cross_identity_sync_relationships relationship where id=$1 and local_user_id=$2 and ${relationshipCredentialClause("relationship", 3)} limit 1`,
          [id, actor.userId, actor.deviceCredentialId]
        );
        await client.query("commit");
        return result.rows[0] ? mapRelationship(result.rows[0]) : null;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async getSyncRelationshipForService(id, side) {
      const result = await pool.query(
        "select * from cross_identity_sync_relationships where id=$1 and ($2::text is null or side::text=$2) limit 1",
        [id, side ?? null]
      );
      return result.rows[0] ? mapRelationship(result.rows[0] as Row) : null;
    },
    async getSyncTransportContext(relationshipId, input = {}) {
      const result = await pool.query<Row>(
        `
          select
            relationship.*,
            local_deployment.id as local_deployment_id,
            local_deployment.protocol_deployment_id as local_protocol_deployment_id,
            remote_deployment.protocol_deployment_id as remote_protocol_deployment_id,
            remote_deployment.base_url as remote_base_url,
            remote_deployment.upstream_backend_id as remote_upstream_backend_id,
            remote_deployment.metadata ->> 'credentialReference' as remote_credential_reference,
            remote_user.external_subject_id as remote_subject_id
          from cross_identity_sync_relationships relationship
          join memory_replicas replica on replica.id = relationship.local_replica_id
          join deployment_identities local_deployment on local_deployment.id = replica.deployment_identity_id
          join deployment_identities remote_deployment on remote_deployment.id = relationship.remote_deployment_identity_id
          join sync_external_user_identities remote_user on remote_user.id = relationship.remote_user_identity_id
          where relationship.id = $1
            and ($2::boolean or relationship.revoked_at is null)
          limit 1
        `,
        [relationshipId, input.includeRevoked ?? false]
      );
      const row = result.rows[0];
      return row
        ? {
            relationship: mapRelationship(row),
            localDeploymentId: String(row.local_deployment_id),
            localProtocolDeploymentId: String(row.local_protocol_deployment_id),
            remoteProtocolDeploymentId: String(
              row.remote_protocol_deployment_id
            ),
            remoteBaseUrl: optionalString(row.remote_base_url),
            remoteUpstreamBackendId: optionalString(
              row.remote_upstream_backend_id
            ),
            remoteCredentialReference: optionalString(
              row.remote_credential_reference
            ),
            remoteSubjectId: String(row.remote_subject_id)
          }
        : null;
    },
    async authorizeTargetSyncProcessing(input) {
      const result = await pool.query(
        `select 1
           from cross_identity_sync_relationships relationship
           join users owner on owner.id=relationship.local_user_id
           join device_credentials bound_credential on bound_credential.id=relationship.device_credential_id
           join device_credentials credential
             on credential.owner_user_id=bound_credential.owner_user_id
            and credential.upstream_backend_id=bound_credential.upstream_backend_id
            and credential.lineage_id=bound_credential.lineage_id
           join sync_external_user_identities remote_user on remote_user.id=relationship.remote_user_identity_id
           join sync_package_upload_sessions upload on upload.sync_relationship_id=relationship.id
          where relationship.id=$1
            and upload.id=$2
            and relationship.side='target'
            and relationship.revoked_at is null
            and owner.disabled_at is null
            and owner.deleted_at is null
            and credential.owner_user_id=relationship.local_user_id
            and credential.revoked_at is null
            and (credential.expires_at is null or credential.expires_at>now())
            and ('sync'=any(credential.operation_families) or '*'=any(credential.operation_families))
            and remote_user.status='active'
            and remote_user.revoked_at is null
          limit 1`,
        [input.relationshipId, input.uploadSessionId]
      );
      return Boolean(result.rows[0]);
    },
    async ensureSyncRecipientKey(input) {
      const result = await pool.query(
        "insert into sync_recipient_keys (deployment_identity_id,key_id,key_version,algorithm,public_jwk,encrypted_private_key) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb) on conflict (deployment_identity_id,key_id,key_version) do update set public_jwk=sync_recipient_keys.public_jwk returning *",
        [
          input.deploymentIdentityId,
          input.material.keyId,
          input.material.keyVersion,
          input.material.algorithm,
          JSON.stringify(input.material.publicJwk),
          JSON.stringify(input.material.encryptedPrivateKey)
        ]
      );
      const row = result.rows[0] as Row;
      if (
        crossIdentitySyncDigest(row.public_jwk) !==
        crossIdentitySyncDigest(input.material.publicJwk)
      )
        throw new SyncIdempotencyConflictError();
      return {
        algorithm: String(row.algorithm) as RecipientKeyMaterial["algorithm"],
        keyId: String(row.key_id),
        keyVersion: numberValue(row.key_version),
        publicJwk: row.public_jwk as RecipientKeyMaterial["publicJwk"],
        encryptedPrivateKey:
          row.encrypted_private_key as RecipientKeyMaterial["encryptedPrivateKey"]
      };
    },
    async getActiveSyncRecipientKey(deploymentIdentityId) {
      const result = await pool.query(
        "select * from sync_recipient_keys where deployment_identity_id=$1 and retired_at is null order by key_version desc limit 1",
        [deploymentIdentityId]
      );
      const row = result.rows[0] as Row | undefined;
      return row
        ? {
            algorithm: String(
              row.algorithm
            ) as RecipientKeyMaterial["algorithm"],
            keyId: String(row.key_id),
            keyVersion: numberValue(row.key_version),
            publicJwk: row.public_jwk as RecipientKeyMaterial["publicJwk"],
            encryptedPrivateKey:
              row.encrypted_private_key as RecipientKeyMaterial["encryptedPrivateKey"]
          }
        : null;
    },
    async getSyncRecipientKey(deploymentIdentityId, keyId, keyVersion) {
      const result = await pool.query(
        "select * from sync_recipient_keys where deployment_identity_id=$1 and key_id=$2 and key_version=$3 limit 1",
        [deploymentIdentityId, keyId, keyVersion]
      );
      const row = result.rows[0] as Row | undefined;
      return row
        ? {
            algorithm: String(
              row.algorithm
            ) as RecipientKeyMaterial["algorithm"],
            keyId: String(row.key_id),
            keyVersion: numberValue(row.key_version),
            publicJwk: row.public_jwk as RecipientKeyMaterial["publicJwk"],
            encryptedPrivateKey:
              row.encrypted_private_key as RecipientKeyMaterial["encryptedPrivateKey"]
          }
        : null;
    },
    async readCapturedSessionSyncDelta(input) {
      const relationshipResult = await pool.query(
        "select sr.*,lm.local_session_id,di.protocol_deployment_id from cross_identity_sync_relationships sr join logical_memories lm on lm.id=sr.logical_memory_id join memory_replicas mr on mr.id=sr.local_replica_id join deployment_identities di on di.id=mr.deployment_identity_id where sr.id=$1 and sr.side='source' and sr.revoked_at is null for update",
        [input.relationshipId]
      );
      const row = relationshipResult.rows[0] as Row | undefined;
      if (!row) return null;
      const relationship = mapRelationship(row);
      const sessionId = String(row.local_session_id);
      const sessionResult = await pool.query(
        "select * from sessions where id=$1",
        [sessionId]
      );
      const session = sessionResult.rows[0] as Row;
      const limit = Math.min(
        Math.max(input.limit ?? CAPTURED_SESSION_SYNC_MAX_CHANGES, 1),
        CAPTURED_SESSION_SYNC_MAX_CHANGES
      );
      const changesResult = await pool.query(
        `
          select latest.cursor, latest.origin_event_id, latest.operation, event.*
          from (
            select distinct on (change.origin_event_id)
              change.cursor,
              change.origin_event_id,
              change.operation,
              change.memory_event_id
            from sync_semantic_changes change
            where change.session_id = $1
              and change.cursor > $2
            order by change.origin_event_id, change.cursor desc
          ) latest
          left join memory_events event on event.id = latest.memory_event_id
          order by latest.cursor asc
          limit $3
        `,
        [sessionId, relationship.sourceCursor, limit]
      );
      const actor = { userId: relationship.localUserId };
      const changes: CapturedSessionSyncChangeV1[] = [];
      for (const changeRow of changesResult.rows as Row[]) {
        const cursor = numberValue(changeRow.cursor);
        const deleted =
          changeRow.operation === "delete" ||
          changeRow.invalidated_at ||
          changeRow.personal_deleted_at ||
          !changeRow.id;
        if (deleted) {
          changes.push({
            cursor,
            operation: "delete",
            originEventId: String(changeRow.origin_event_id),
            revisionHash: crossIdentitySyncDigest({
              originEventId: changeRow.origin_event_id,
              cursor,
              deleted: true
            }),
            event: null
          });
          continue;
        }
        const payload = objectValue(
          await hydrateField(
            actor,
            "memory_events",
            String(changeRow.id),
            "payload",
            changeRow.payload
          )
        );
        const contributorResult = await pool.query(
          "select ci.* from memory_event_sources mes join conversation_items ci on ci.id=mes.conversation_item_id where mes.memory_event_id=$1 order by mes.source_order,ci.source_sequence nulls last,ci.id",
          [changeRow.id]
        );
        if (
          contributorResult.rowCount !== null &&
          contributorResult.rowCount >
            CAPTURED_SESSION_SYNC_MAX_CONTRIBUTORS_PER_EVENT
        ) {
          throw new Error("Memory Event contributor limit exceeded");
        }
        const contributors: CapturedSessionSyncContributorV1[] = [];
        for (const contributor of contributorResult.rows as Row[]) {
          const hydratedRawText = await hydrateField(
            actor,
            "conversation_items",
            String(contributor.id),
            "raw_text",
            contributor.raw_text
          );
          const hydratedRawJson = await hydrateField(
            actor,
            "conversation_items",
            String(contributor.id),
            "raw_json",
            contributor.raw_json
          );
          const content =
            typeof hydratedRawText === "string" && hydratedRawText
              ? hydratedRawText
              : contentFromUnknown(hydratedRawJson);
          const actorValue =
            objectValue(contributor.metadata).actor ??
            contributor.source_event_type;
          const kindValue =
            contributor.source_event_type ?? contributor.source_record_type;
          const canonical = {
            originItemId: String(contributor.id),
            actor: typeof actorValue === "string" ? actorValue : "unknown",
            kind: typeof kindValue === "string" ? kindValue : "unknown",
            content,
            toolName:
              typeof objectValue(contributor.metadata).toolName === "string"
                ? String(objectValue(contributor.metadata).toolName)
                : null,
            toolCallId:
              typeof objectValue(contributor.metadata).toolCallId === "string"
                ? String(objectValue(contributor.metadata).toolCallId)
                : null,
            sourceEventTime: iso(contributor.event_time),
            sourceSequence:
              contributor.source_sequence === null
                ? null
                : numberValue(contributor.source_sequence)
          };
          contributors.push({
            ...canonical,
            revisionHash: crossIdentitySyncDigest(canonical)
          });
        }
        const eventBase = {
          originEventId: String(changeRow.id),
          eventType: String(changeRow.event_type),
          actor: typeof payload.actor === "string" ? payload.actor : "system",
          content: typeof payload.content === "string" ? payload.content : "",
          metadata: sanitizedEventMetadata(objectValue(payload.metadata)),
          tokenCount:
            changeRow.token_count === null
              ? null
              : numberValue(changeRow.token_count),
          sealReason: optionalString(changeRow.seal_reason),
          capturedAt: iso(changeRow.captured_at)!,
          sourceEventTime: iso(changeRow.source_event_time),
          sourceSequence:
            changeRow.source_sequence === null
              ? null
              : numberValue(changeRow.source_sequence),
          contributors
        };
        const revisionHash = crossIdentitySyncDigest(eventBase);
        changes.push({
          cursor,
          operation: "upsert",
          originEventId: eventBase.originEventId,
          revisionHash,
          event: { ...eventBase, revisionHash }
        });
      }
      const toCursor = changes.length
        ? Math.max(...changes.map((change) => change.cursor))
        : relationship.sourceCursor;
      return {
        relationship,
        session: {
          originSessionId: sessionId,
          externalSessionId: optionalString(session.external_session_id),
          sourceRuntime: String(session.source_runtime),
          captureMethod: String(session.capture_method),
          capturedAt: iso(session.captured_at)!,
          title:
            typeof objectValue(session.metadata).threadName === "string"
              ? String(objectValue(session.metadata).threadName)
              : null,
          sourceAdapterVersion: optionalString(session.source_adapter_version)
        },
        changes,
        fromCursor: relationship.sourceCursor,
        toCursor
      };
    },
    async createSyncPackageUploadSession(actor, input) {
      assertSafeControlManifest(input.packageManifest);
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (!(await lockActiveSyncDeviceCredential(client, actor))) {
          await client.query("rollback");
          return null;
        }
        const relationshipResult = await client.query<Row>(
          `select * from cross_identity_sync_relationships relationship where id=$1 and local_user_id=$2 and revoked_at is null and ($3::text is null or side::text=$3) and ${relationshipCredentialClause("relationship", 4)} for update`,
          [
            input.syncRelationshipId,
            actor.userId,
            input.relationshipSide ?? null,
            actor.deviceCredentialId ?? null
          ]
        );
        const relationship = relationshipResult.rows[0];
        if (!relationship) {
          await client.query("rollback");
          return null;
        }
        const existing = await client.query<Row>(
          "select * from sync_package_upload_sessions where sync_relationship_id=$1 and idempotency_key=$2 limit 1",
          [input.syncRelationshipId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          const upload = mapUpload(existing.rows[0]);
          if (
            upload.requestHash !== input.requestHash ||
            upload.protocolPackageId !== input.protocolPackageId ||
            upload.packageChecksum !== input.packageChecksum ||
            upload.sourceSequence !== input.sourceSequence ||
            upload.fromCursor !== input.fromCursor ||
            upload.toCursor !== input.toCursor ||
            upload.totalBytes !== input.totalBytes ||
            upload.expectedChunkCount !== input.expectedChunkCount ||
            crossIdentitySyncDigest(upload.packageManifest) !==
              crossIdentitySyncDigest(input.packageManifest)
          ) {
            throw new SyncIdempotencyConflictError();
          }
          await client.query("commit");
          return upload;
        }
        if (["failed", "paused"].includes(String(relationship.state))) {
          throw new SyncStateConflictError(
            "Sync relationship must be retried before accepting a new package"
          );
        }
        const result = await client.query<Row>(
          "insert into sync_package_upload_sessions (sync_relationship_id,protocol_package_id,package_format_version,request_hash,package_manifest,package_checksum,source_sequence,from_cursor,to_cursor,total_bytes,expected_chunk_count,idempotency_key) values ($1,$2,1,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11) returning *",
          [
            input.syncRelationshipId,
            input.protocolPackageId,
            assertHash(input.requestHash),
            JSON.stringify(input.packageManifest),
            assertHash(input.packageChecksum),
            input.sourceSequence,
            input.fromCursor,
            input.toCursor,
            input.totalBytes,
            input.expectedChunkCount,
            input.idempotencyKey
          ]
        );
        await client.query(
          "update cross_identity_sync_relationships set state='uploading',updated_at=now() where id=$1",
          [input.syncRelationshipId]
        );
        await client.query("commit");
        return mapUpload(result.rows[0]!);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async recordSyncPackageChunk(actor, input) {
      const actualByteCount = Buffer.byteLength(
        JSON.stringify(input.encryptedPayload),
        "utf8"
      );
      if (
        actualByteCount !== input.byteCount ||
        actualByteCount > CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES * 2
      ) {
        throw new SyncStateConflictError("Sync chunk byte count is invalid");
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (!(await lockActiveSyncDeviceCredential(client, actor))) {
          await client.query("rollback");
          return null;
        }
        const uploadResult = await client.query(
          `select spu.* from sync_package_upload_sessions spu join cross_identity_sync_relationships sr on sr.id=spu.sync_relationship_id where spu.id=$1 and sr.local_user_id=$2 and sr.revoked_at is null and ($3::text is null or sr.side::text=$3) and ${relationshipCredentialClause("sr", 4)} for update`,
          [
            input.uploadSessionId,
            actor.userId,
            input.relationshipSide ?? null,
            actor.deviceCredentialId ?? null
          ]
        );
        const upload = uploadResult.rows[0] as Row | undefined;
        if (!upload) {
          await client.query("rollback");
          return null;
        }
        const uploadState = String(upload.state);
        if (["verified", "processing", "completed"].includes(uploadState)) {
          const existing = await client.query(
            "select * from sync_package_chunks where upload_session_id=$1 and chunk_index=$2",
            [input.uploadSessionId, input.chunkIndex]
          );
          if (!existing.rows[0]) {
            throw new SyncStateConflictError(
              "Verified sync upload cannot accept additional chunks"
            );
          }
          const chunk = mapChunk(existing.rows[0] as Row);
          if (
            chunk.chunkChecksum !== input.chunkChecksum ||
            chunk.byteCount !== input.byteCount ||
            crossIdentitySyncDigest(chunk.encryptedPayload) !==
              crossIdentitySyncDigest(input.encryptedPayload)
          ) {
            throw new SyncIdempotencyConflictError();
          }
          await client.query("commit");
          return chunk;
        }
        if (uploadState === "failed") {
          throw new SyncStateConflictError("Sync upload has failed");
        }
        if (
          input.chunkIndex < 0 ||
          input.chunkIndex >= numberValue(upload.expected_chunk_count)
        )
          throw new SyncStateConflictError("Chunk index outside upload plan");
        const result = await client.query(
          "insert into sync_package_chunks (upload_session_id,chunk_index,chunk_checksum,byte_count,encrypted_payload) values ($1,$2,$3,$4,$5::jsonb) on conflict (upload_session_id,chunk_index) do update set received_at=sync_package_chunks.received_at returning *",
          [
            input.uploadSessionId,
            input.chunkIndex,
            assertHash(input.chunkChecksum),
            input.byteCount,
            JSON.stringify(input.encryptedPayload)
          ]
        );
        const chunk = mapChunk(result.rows[0] as Row);
        if (
          chunk.chunkChecksum !== input.chunkChecksum ||
          chunk.byteCount !== input.byteCount ||
          crossIdentitySyncDigest(chunk.encryptedPayload) !==
            crossIdentitySyncDigest(input.encryptedPayload)
        )
          throw new SyncIdempotencyConflictError();
        await client.query(
          "update sync_package_upload_sessions set uploaded_bytes=(select coalesce(sum(byte_count),0) from sync_package_chunks where upload_session_id=$1),chunk_count=(select count(*) from sync_package_chunks where upload_session_id=$1),state='uploading',updated_at=now() where id=$1",
          [input.uploadSessionId]
        );
        await client.query("commit");
        return chunk;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async getSyncPackageUploadSession(actor, id, relationshipSide) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (!(await lockActiveSyncDeviceCredential(client, actor))) {
          await client.query("rollback");
          return null;
        }
        const uploadResult = await client.query(
          `select spu.* from sync_package_upload_sessions spu join cross_identity_sync_relationships sr on sr.id=spu.sync_relationship_id where spu.id=$1 and sr.local_user_id=$2 and ($3::text is null or sr.side::text=$3) and ${relationshipCredentialClause("sr", 4)}`,
          [
            id,
            actor.userId,
            relationshipSide ?? null,
            actor.deviceCredentialId ?? null
          ]
        );
        if (!uploadResult.rows[0]) {
          await client.query("rollback");
          return null;
        }
        const chunks = await client.query(
          "select * from sync_package_chunks where upload_session_id=$1 order by chunk_index",
          [id]
        );
        await client.query("commit");
        return {
          upload: mapUpload(uploadResult.rows[0] as Row),
          chunks: chunks.rows.map((row) => mapChunk(row as Row))
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async getSyncPackageForService(id) {
      const uploadResult = await pool.query<Row>(
        "select * from sync_package_upload_sessions where id=$1 limit 1",
        [id]
      );
      if (!uploadResult.rows[0]) return null;
      const chunks = await pool.query<Row>(
        "select * from sync_package_chunks where upload_session_id=$1 order by chunk_index",
        [id]
      );
      return {
        upload: mapUpload(uploadResult.rows[0]),
        chunks: chunks.rows.map(mapChunk)
      };
    },
    async getSyncPackageBySequence(input) {
      const result = await pool.query<Row>(
        "select id from sync_package_upload_sessions where sync_relationship_id=$1 and source_sequence=$2 limit 1",
        [input.relationshipId, input.sourceSequence]
      );
      return result.rows[0]
        ? this.getSyncPackageForService(String(result.rows[0].id))
        : null;
    },
    async deleteIncompleteSourceSyncPackage(input) {
      const result = await pool.query(
        `delete from sync_package_upload_sessions upload
          using cross_identity_sync_relationships relationship
          where upload.id=$1
            and upload.sync_relationship_id=$2
            and relationship.id=upload.sync_relationship_id
            and relationship.side='source'
            and upload.state in ('created','uploading')
            and upload.chunk_count < upload.expected_chunk_count
          returning upload.id`,
        [input.uploadSessionId, input.relationshipId]
      );
      return Boolean(result.rows[0]);
    },
    async verifySyncPackageUpload(actor, uploadSessionId, relationshipSide) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (!(await lockActiveSyncDeviceCredential(client, actor))) {
          await client.query("rollback");
          return null;
        }
        const result = await client.query(
          `select spu.* from sync_package_upload_sessions spu join cross_identity_sync_relationships sr on sr.id=spu.sync_relationship_id where spu.id=$1 and sr.local_user_id=$2 and sr.revoked_at is null and ($3::text is null or sr.side::text=$3) and ${relationshipCredentialClause("sr", 4)} for update`,
          [
            uploadSessionId,
            actor.userId,
            relationshipSide ?? null,
            actor.deviceCredentialId ?? null
          ]
        );
        const row = result.rows[0] as Row | undefined;
        if (!row) {
          await client.query("rollback");
          return null;
        }
        const upload = mapUpload(row);
        if (upload.state === "verified" || upload.state === "completed") {
          await client.query("commit");
          return upload;
        }
        if (upload.state === "failed") {
          throw new SyncStateConflictError("Sync upload has failed");
        }
        const chunks = await client.query<Row>(
          "select chunk_index,byte_count,encrypted_payload from sync_package_chunks where upload_session_id=$1 order by chunk_index",
          [uploadSessionId]
        );
        if (
          chunks.rowCount !== upload.expectedChunkCount ||
          chunks.rows.some(
            (chunk, index) => numberValue(chunk.chunk_index) !== index
          ) ||
          chunks.rows.reduce(
            (sum, chunk) => sum + numberValue(chunk.byte_count),
            0
          ) !== upload.totalBytes ||
          crossIdentitySyncDigest(
            chunks.rows.map((chunk) => chunk.encrypted_payload)
          ) !== upload.packageChecksum
        )
          throw new SyncStateConflictError("Upload is incomplete");
        const updated = await client.query(
          "update sync_package_upload_sessions set state='verified',verified_chunk_count=expected_chunk_count,uploaded_at=now(),verified_at=now(),updated_at=now() where id=$1 returning *",
          [uploadSessionId]
        );
        await client.query(
          "insert into sync_inbox_entries (sync_relationship_id,upload_session_id,idempotency_key,request_hash,payload_manifest) values ($1,$2,$3,$4,'{}') on conflict do nothing",
          [
            upload.syncRelationshipId,
            upload.id,
            `package:${upload.protocolPackageId}`,
            upload.requestHash
          ]
        );
        await client.query(
          "update cross_identity_sync_relationships set state='processing',updated_at=now() where id=$1 and side='target' and revoked_at is null",
          [upload.syncRelationshipId]
        );
        await client.query(
          "update memory_replicas replica set freshness_status='stale',updated_at=now() from cross_identity_sync_relationships relationship where relationship.id=$1 and replica.id=relationship.local_replica_id",
          [upload.syncRelationshipId]
        );
        await recordSyncAuditEventWithClient(client, {
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: "personal",
          action: "cross_identity_sync.upload.committed",
          targetTable: "sync_package_upload_sessions",
          targetId: upload.id,
          metadata: {
            eventKey: `upload:${upload.id}`,
            relationshipId: upload.syncRelationshipId,
            packageSequence: upload.sourceSequence,
            bytes: upload.totalBytes,
            chunks: upload.expectedChunkCount
          }
        });
        await client.query("commit");
        return mapUpload(updated.rows[0] as Row);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    enqueueSyncOutboxEntry(input) {
      return queueInsert("sync_outbox_entries", input);
    },
    enqueueSyncInboxEntry(input) {
      return queueInsert("sync_inbox_entries", input);
    },
    async listDueSourceSyncHeartbeats(input) {
      const result = await pool.query<Row>(
        `select id,source_cursor,target_processing_cursor,package_sequence,stale_after
           from cross_identity_sync_relationships
          where side='source'
            and state in ('ready','stale')
            and revoked_at is null
            and stale_after is not null
            and stale_after<=now()+($1::int*interval '1 second')
          order by stale_after
          limit $2`,
        [Math.max(input.dueWithinSeconds, 1), Math.min(input.limit ?? 100, 500)]
      );
      return result.rows.map((row) => ({
        relationshipId: String(row.id),
        sourceCursor: numberValue(row.source_cursor),
        targetProcessingCursor: numberValue(row.target_processing_cursor),
        packageSequence: numberValue(row.package_sequence),
        staleAfter: iso(row.stale_after)!
      }));
    },
    async refreshSourceSyncHeartbeat(input) {
      const result = await pool.query(
        `update cross_identity_sync_relationships
            set state='ready',
                last_synced_at=now(),
                stale_after=now()+($5::int*interval '1 second'),
                updated_at=now()
          where id=$1
            and side='source'
            and state in ('ready','stale')
            and revoked_at is null
            and source_cursor=$2
            and target_processing_cursor=$3
            and package_sequence=$4
          returning id`,
        [
          input.relationshipId,
          input.sourceCursor,
          input.targetProcessingCursor,
          input.packageSequence,
          input.staleAfterSeconds
        ]
      );
      return result.rowCount === 1;
    },
    async acceptTargetSyncHeartbeat(actor, input) {
      const result = await pool.query(
        `update cross_identity_sync_relationships relationship
            set state='ready',
                source_cursor=$4,
                last_synced_at=now(),
                stale_after=now()+($7::int*interval '1 second'),
                updated_at=now()
           from users owner,
                device_credentials credential,
                sync_external_user_identities remote_user
          where relationship.id=$1
            and relationship.side='target'
            and relationship.local_user_id=$2
            and ${relationshipCredentialClause("relationship", 3)}
            and relationship.revoked_at is null
            and relationship.source_cursor<=$4
            and relationship.target_processing_cursor=$5
            and $4=$5
            and relationship.package_sequence=$6
            and owner.id=relationship.local_user_id
            and owner.disabled_at is null
            and owner.deleted_at is null
            and credential.id=$3
            and credential.owner_user_id=relationship.local_user_id
            and credential.revoked_at is null
            and (credential.expires_at is null or credential.expires_at>now())
            and ('sync'=any(credential.operation_families) or '*'=any(credential.operation_families))
            and remote_user.id=relationship.remote_user_identity_id
            and remote_user.status='active'
            and remote_user.revoked_at is null
          returning relationship.id`,
        [
          input.relationshipId,
          actor.userId,
          actor.deviceCredentialId,
          input.sourceCursor,
          input.targetProcessingCursor,
          input.packageSequence,
          input.staleAfterSeconds
        ]
      );
      return result.rowCount === 1;
    },
    async claimSyncQueueEntry(input) {
      const table =
        input.queue === "outbox" ? "sync_outbox_entries" : "sync_inbox_entries";
      const client = await pool.connect();
      try {
        await client.query("begin");
        const expired = await client.query<Row>(
          `select id,sync_relationship_id,upload_session_id,idempotency_key,payload_manifest->>'kind' as payload_kind
           from ${table}
           where state='processing'
             and lease_expires_at<=now()
             and attempt_count>=max_attempts
           order by lease_expires_at,created_at
           for update skip locked
           limit 1`
        );
        const expiredRow = expired.rows[0];
        if (expiredRow) {
          const isRevocation =
            input.queue === "outbox" &&
            expiredRow.payload_kind === "revocation";
          let reconciled = false;
          if (
            input.queue === "outbox" &&
            expiredRow.idempotency_key === "changes"
          ) {
            const durable = await client.query<{ complete: boolean }>(
              `select exists (
                 select 1
                 from cross_identity_sync_relationships
                 where id=$1
                   and side='source'
                   and state in ('ready','stale')
                   and revoked_at is null
               ) as complete`,
              [expiredRow.sync_relationship_id]
            );
            if (durable.rows[0]?.complete) {
              const pending = await client.query<{ pending: boolean }>(
                `select exists (
                   select 1
                   from cross_identity_sync_relationships relationship
                   join memory_replicas replica on replica.id=relationship.local_replica_id
                   join sync_semantic_changes change on change.session_id=replica.local_session_id
                   where relationship.id=$1
                     and change.cursor>relationship.source_cursor
                 ) as pending`,
                [expiredRow.sync_relationship_id]
              );
              const hasPendingChanges = pending.rows[0]?.pending === true;
              await client.query(
                `update ${table}
                 set state=$2::sync_queue_entry_state,
                     attempt_count=case when $3::boolean then 0 else attempt_count end,
                     available_at=now(),
                     locked_at=null,
                     claim_token=null,
                     lease_expires_at=null,
                     processed_at=case when $3::boolean then null else now() end,
                     last_error_message=null,
                     updated_at=now()
                 where id=$1`,
                [
                  expiredRow.id,
                  hasPendingChanges ? "pending" : "completed",
                  hasPendingChanges
                ]
              );
              reconciled = true;
            }
          } else if (input.queue === "inbox" && expiredRow.upload_session_id) {
            const durable = await client.query<{ complete: boolean }>(
              `select exists (
                 select 1
                 from sync_package_upload_sessions upload
                 join cross_identity_sync_relationships relationship
                   on relationship.id=upload.sync_relationship_id
                 where upload.id=$1
                   and upload.state='completed'
                   and relationship.side='target'
                   and relationship.state in ('ready','stale')
                   and relationship.target_processing_cursor>=upload.to_cursor
                   and relationship.revoked_at is null
               ) as complete`,
              [expiredRow.upload_session_id]
            );
            if (durable.rows[0]?.complete) {
              await client.query(
                `update ${table}
                 set state='completed',
                     locked_at=null,
                     claim_token=null,
                     lease_expires_at=null,
                     processed_at=now(),
                     last_error_message=null,
                     updated_at=now()
                 where id=$1`,
                [expiredRow.id]
              );
              reconciled = true;
            }
          }
          if (!reconciled) {
            const recovered = await client.query<Row>(
              `update ${table}
               set state=$2::sync_queue_entry_state,
                   attempt_count=case when $3::boolean then 0 else attempt_count end,
                   available_at=now(),
                   locked_at=null,
                   claim_token=null,
                   lease_expires_at=null,
                   processed_at=case when $3::boolean then null else now() end,
                   last_error_message='SyncQueueLeaseExpiredError',
                   updated_at=now()
               where id=$1
               returning sync_relationship_id,upload_session_id,state,attempt_count`,
              [expiredRow.id, isRevocation ? "pending" : "failed", isRevocation]
            );
            const recoveredRow = recovered.rows[0];
            if (!isRevocation && recoveredRow) {
              if (input.queue === "inbox" && recoveredRow.upload_session_id) {
                await client.query(
                  "update sync_package_upload_sessions set state='failed',failed_at=coalesce(failed_at,now()),last_error_message='SyncQueueLeaseExpiredError',updated_at=now() where id=$1 and state<>'completed'",
                  [recoveredRow.upload_session_id]
                );
              }
              const relationship = await client.query<Row>(
                "update cross_identity_sync_relationships set state='failed',failed_at=now(),last_error_class='SyncQueueLeaseExpiredError',updated_at=now() where id=$1 and revoked_at is null returning local_replica_id,local_user_id",
                [recoveredRow.sync_relationship_id]
              );
              if (relationship.rows[0]) {
                await client.query(
                  "update memory_replicas set freshness_status='failed',updated_at=now() where id=$1",
                  [relationship.rows[0].local_replica_id]
                );
                await recordSyncAuditEventWithClient(client, {
                  actorUserId: null,
                  ownerUserId: String(relationship.rows[0].local_user_id),
                  visibility: "personal",
                  action:
                    input.queue === "inbox"
                      ? "cross_identity_sync.processing.failed"
                      : "cross_identity_sync.transport.failed",
                  targetTable: table,
                  targetId: String(expiredRow.id),
                  metadata: {
                    eventKey: `terminal:${String(expiredRow.id)}`,
                    errorClass: "SyncQueueLeaseExpiredError",
                    attemptCount: numberValue(recoveredRow.attempt_count)
                  }
                });
              }
            }
          }
        }
        const result = await client.query(
          `with candidate as (select id from ${table} where (state='pending' or (state='processing' and lease_expires_at<=now())) and available_at<=now() and attempt_count<max_attempts order by available_at,created_at for update skip locked limit 1) update ${table} q set state='processing',attempt_count=attempt_count+1,locked_at=now(),claim_token=gen_random_uuid(),lease_expires_at=now()+($1::int*interval '1 millisecond'),updated_at=now() from candidate where q.id=candidate.id returning q.*`,
          [input.leaseMs]
        );
        await client.query("commit");
        return result.rows[0] ? mapQueue(result.rows[0] as Row) : null;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async completeSyncQueueEntry(input) {
      const table =
        input.queue === "outbox" ? "sync_outbox_entries" : "sync_inbox_entries";
      const completion =
        input.queue === "outbox"
          ? `state=case when idempotency_key='changes' and exists (
               select 1
               from cross_identity_sync_relationships relationship
               join memory_replicas replica on replica.id=relationship.local_replica_id
               join sync_semantic_changes change on change.session_id=replica.local_session_id
               where relationship.id=${table}.sync_relationship_id
                 and change.cursor>relationship.source_cursor
             ) then 'pending'::sync_queue_entry_state else 'completed'::sync_queue_entry_state end,
             attempt_count=case when idempotency_key='changes' and exists (
               select 1
               from cross_identity_sync_relationships relationship
               join memory_replicas replica on replica.id=relationship.local_replica_id
               join sync_semantic_changes change on change.session_id=replica.local_session_id
               where relationship.id=${table}.sync_relationship_id
                 and change.cursor>relationship.source_cursor
             ) then 0 else attempt_count end,
             available_at=now(),
             processed_at=case when idempotency_key='changes' and exists (
               select 1
               from cross_identity_sync_relationships relationship
               join memory_replicas replica on replica.id=relationship.local_replica_id
               join sync_semantic_changes change on change.session_id=replica.local_session_id
               where relationship.id=${table}.sync_relationship_id
                 and change.cursor>relationship.source_cursor
             ) then null else now() end`
          : "state='completed',processed_at=now()";
      const result = await pool.query(
        `update ${table} set ${completion},claim_token=null,lease_expires_at=null,last_error_message=null,updated_at=now() where id=$1 and state='processing' and claim_token=$2 and lease_expires_at>now() returning id`,
        [input.id, input.claimToken]
      );
      return result.rowCount === 1;
    },
    async renewSyncQueueLease(input) {
      const table =
        input.queue === "outbox" ? "sync_outbox_entries" : "sync_inbox_entries";
      const result = await pool.query(
        `update ${table} set lease_expires_at=now()+($3::int*interval '1 millisecond'),updated_at=now() where id=$1 and state='processing' and claim_token=$2 and lease_expires_at>now() returning id`,
        [input.id, input.claimToken, input.leaseMs]
      );
      return result.rowCount === 1;
    },
    async deferSyncQueueEntry(input) {
      const table =
        input.queue === "outbox" ? "sync_outbox_entries" : "sync_inbox_entries";
      const result = await pool.query(
        `update ${table} set state='pending',attempt_count=greatest(attempt_count-1,0),available_at=now()+($3::int*interval '1 millisecond'),claim_token=null,lease_expires_at=null,last_error_message=null,updated_at=now() where id=$1 and state='processing' and claim_token=$2 and lease_expires_at>now() returning id`,
        [input.id, input.claimToken, Math.max(input.delayMs, 250)]
      );
      return result.rowCount === 1;
    },
    async failSyncQueueEntry(input) {
      const table =
        input.queue === "outbox" ? "sync_outbox_entries" : "sync_inbox_entries";
      const client = await pool.connect();
      try {
        await client.query("begin");
        const errorClass = input.errorClass.slice(0, 120);
        const result = await client.query<Row>(
          `update ${table} set
             state=case
               when $5::boolean then 'failed'::sync_queue_entry_state
               when payload_manifest->>'kind'='revocation' then 'pending'::sync_queue_entry_state
               when attempt_count>=max_attempts then 'failed'::sync_queue_entry_state
               else 'pending'::sync_queue_entry_state
             end,
             attempt_count=case
               when not $5::boolean and payload_manifest->>'kind'='revocation' and attempt_count>=max_attempts then 0
               else attempt_count
             end,
             available_at=now()+($3::int*interval '1 millisecond'),claim_token=null,lease_expires_at=null,last_error_message=$4,updated_at=now()
           where id=$1 and state='processing' and claim_token=$2 and lease_expires_at>now()
           returning sync_relationship_id,upload_session_id,state,attempt_count`,
          [
            input.id,
            input.claimToken,
            input.retryAfterMs,
            errorClass,
            input.terminal ?? false
          ]
        );
        if (result.rows[0]?.state === "failed") {
          if (input.queue === "inbox" && result.rows[0].upload_session_id) {
            await client.query(
              "update sync_package_upload_sessions set state='failed',failed_at=coalesce(failed_at,now()),last_error_message=$2,updated_at=now() where id=$1 and state<>'completed'",
              [result.rows[0].upload_session_id, errorClass]
            );
          }
          const relationship = await client.query<Row>(
            "update cross_identity_sync_relationships set state='failed',failed_at=now(),last_error_class=$2,updated_at=now() where id=$1 and revoked_at is null returning local_replica_id,local_user_id",
            [result.rows[0].sync_relationship_id, errorClass]
          );
          if (relationship.rows[0]) {
            await client.query(
              "update memory_replicas set freshness_status='failed',updated_at=now() where id=$1",
              [relationship.rows[0].local_replica_id]
            );
            await recordSyncAuditEventWithClient(client, {
              actorUserId: null,
              ownerUserId: String(relationship.rows[0].local_user_id),
              visibility: "personal",
              action:
                input.queue === "inbox"
                  ? "cross_identity_sync.processing.failed"
                  : "cross_identity_sync.transport.failed",
              targetTable: table,
              targetId: input.id,
              metadata: {
                eventKey: `terminal:${input.id}`,
                errorClass,
                attemptCount: numberValue(result.rows[0].attempt_count)
              }
            });
          }
        }
        await client.query("commit");
        return result.rowCount === 1;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async applyCapturedSessionSyncPackage(input) {
      const client = await pool.connect();
      const eventIds: string[] = [];
      const invalidatedEventIds: string[] = [];
      try {
        await client.query("begin");
        const relationshipResult = await client.query(
          `select relationship.*
             from cross_identity_sync_relationships relationship
             join users owner on owner.id=relationship.local_user_id
             join device_credentials bound_credential on bound_credential.id=relationship.device_credential_id
             join device_credentials credential
               on credential.owner_user_id=bound_credential.owner_user_id
              and credential.upstream_backend_id=bound_credential.upstream_backend_id
              and credential.lineage_id=bound_credential.lineage_id
             join sync_external_user_identities remote_user on remote_user.id=relationship.remote_user_identity_id
             join sync_package_upload_sessions upload
               on upload.id=$2 and upload.sync_relationship_id=relationship.id
            where relationship.id=$1
              and relationship.side='target'
              and relationship.revoked_at is null
              and owner.disabled_at is null
              and owner.deleted_at is null
              and credential.owner_user_id=relationship.local_user_id
              and credential.revoked_at is null
              and (credential.expires_at is null or credential.expires_at>now())
              and ('sync'=any(credential.operation_families) or '*'=any(credential.operation_families))
              and remote_user.status='active'
              and remote_user.revoked_at is null
            for update of relationship`,
          [input.relationshipId, input.uploadSessionId]
        );
        const relationshipRow = relationshipResult.rows[0] as Row | undefined;
        if (!relationshipRow || relationshipRow.revoked_at) {
          throw new SyncStateConflictError();
        }
        const relationship = mapRelationship(relationshipRow);
        if (
          input.package.toCursor === relationship.targetProcessingCursor &&
          input.package.packageSequence === relationship.packageSequence &&
          input.package.packageId === relationship.lastPackageId
        ) {
          const replayMappings = await client.query<Row>(
            "select local_memory_event_id,active from sync_event_mappings where sync_relationship_id=$1 and origin_event_id=any($2::uuid[]) and local_memory_event_id is not null",
            [
              relationship.id,
              input.package.changes.map((change) => change.originEventId)
            ]
          );
          await client.query("commit");
          return {
            eventIds: replayMappings.rows
              .filter((row) => Boolean(row.active))
              .map((row) => String(row.local_memory_event_id)),
            invalidatedEventIds: replayMappings.rows
              .filter((row) => !row.active)
              .map((row) => String(row.local_memory_event_id))
          };
        }
        if (
          input.package.relationshipId !== relationship.id ||
          input.package.logicalMemoryId !== relationship.logicalMemoryId ||
          input.package.fromCursor !== relationship.targetProcessingCursor ||
          input.package.packageSequence !== relationship.packageSequence + 1
        ) {
          throw new SyncStateConflictError(
            "Package cursor or identity mismatch"
          );
        }
        const replicaResult = await client.query<Row>(
          "select mr.local_session_id from memory_replicas mr where mr.id=$1 and mr.owner_user_id=$2",
          [relationship.localReplicaId, relationship.localUserId]
        );
        const sessionId =
          optionalString(replicaResult.rows[0]?.local_session_id) ?? "";
        if (!sessionId)
          throw new SyncStateConflictError("Target replica session missing");
        for (const change of input.package.changes) {
          const active = await client.query<Row>(
            "select * from sync_event_mappings where sync_relationship_id=$1 and origin_event_id=$2 and active=true for update",
            [relationship.id, change.originEventId]
          );
          const existing = active.rows[0] as Row | undefined;
          if (
            existing &&
            String(existing.revision_hash) === change.revisionHash
          )
            continue;
          const oldId = optionalString(existing?.local_memory_event_id);
          if (existing && oldId) {
            await client.query(
              "update memory_events set invalidated_at=now(),invalidation_reason='sync_revision_replaced',updated_at=now() where id=$1 and invalidated_at is null",
              [oldId]
            );
            await invalidateDerivedMemoryForMemoryEvents(client, [oldId]);
            await client.query(
              "update sync_event_mappings set active=false,invalidated_at=now(),updated_at=now() where id=$1",
              [existing.id]
            );
            invalidatedEventIds.push(oldId);
          }
          if (change.operation === "delete" || !change.event) {
            await client.query(
              "insert into sync_event_mappings (sync_relationship_id,origin_event_id,revision_hash,source_cursor,active,invalidated_at) values ($1,$2,$3,$4,false,now()) on conflict do nothing",
              [
                relationship.id,
                change.originEventId,
                change.revisionHash,
                change.cursor
              ]
            );
            continue;
          }
          const contributorIds: string[] = [];
          for (const contributor of change.event.contributors) {
            const itemResult = await client.query<Row>(
              "insert into conversation_items (owner_user_id,visibility,session_id,source_kind,source_adapter_version,source_transport,external_item_id,source_record_type,source_event_type,source_sequence,event_time,observed_at,raw_json,raw_text,source_hash,idempotency_key,projection_status,projection_version,metadata) values ($1,'personal',$2,'koed_sync','1','cross_identity_sync',$3,'sync_canonical',$4,$5,$6,$6,$7::jsonb,$8,$9,$10,'projected','sync-v1',$11::jsonb) on conflict (owner_user_id,idempotency_key) where visibility='personal' do update set projection_status='projected' returning id",
              [
                relationship.localUserId,
                sessionId,
                contributor.originItemId,
                contributor.kind,
                contributor.sourceSequence,
                contributor.sourceEventTime ?? change.event.capturedAt,
                JSON.stringify({
                  contentEncrypted: true,
                  encryptedSourceTable: "conversation_items",
                  encryptedSourceColumn: "raw_json"
                }),
                "[koed encrypted conversation item]",
                contributor.revisionHash,
                `sync:${relationship.id}:item:${contributor.originItemId}:${contributor.revisionHash}`,
                JSON.stringify({
                  actor: contributor.actor,
                  toolName: contributor.toolName,
                  toolCallId: contributor.toolCallId,
                  syncCanonical: true
                })
              ]
            );
            const itemId = String(itemResult.rows[0]!.id);
            contributorIds.push(itemId);
            if (options.envelopeEncryptionProvider) {
              await upsertEncryptedFieldPayloadWithClient(
                client,
                { userId: relationship.localUserId },
                options.envelopeEncryptionProvider,
                {
                  sourceTable: "conversation_items",
                  sourceId: itemId,
                  sourceColumn: "raw_json",
                  plaintext: {
                    content: contributor.content,
                    actor: contributor.actor,
                    kind: contributor.kind,
                    toolName: contributor.toolName,
                    toolCallId: contributor.toolCallId
                  },
                  rowFamily: "conversation_item",
                  scope: {
                    tenantId: relationship.localUserId,
                    objectClass: "conversation_item"
                  },
                  aad: {
                    syncRelationshipId: relationship.id,
                    originItemId: contributor.originItemId
                  }
                }
              );
              await upsertEncryptedFieldPayloadWithClient(
                client,
                { userId: relationship.localUserId },
                options.envelopeEncryptionProvider,
                {
                  sourceTable: "conversation_items",
                  sourceId: itemId,
                  sourceColumn: "raw_text",
                  plaintext: contributor.content,
                  rowFamily: "conversation_item",
                  scope: {
                    tenantId: relationship.localUserId,
                    objectClass: "conversation_item"
                  },
                  aad: {
                    syncRelationshipId: relationship.id,
                    originItemId: contributor.originItemId
                  }
                }
              );
            }
          }
          const eventId = randomUUID();
          const payload = {
            actor: change.event.actor,
            content: change.event.content,
            metadata: {
              ...change.event.metadata,
              syncRelationshipId: relationship.id,
              originEventId: change.originEventId,
              includeInLcm: change.event.metadata.includeInLcm ?? true
            },
            workspaceId: "cross-identity-sync"
          };
          await client.query(
            "insert into memory_events (id,actor_user_id,owner_user_id,visibility,event_type,capture_method,session_id,idempotency_key,source_hash,payload,token_count,seal_reason,source_event_time,source_sequence,captured_at) values ($1,$2,$2,'personal',$3,'api',$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)",
            [
              eventId,
              relationship.localUserId,
              change.event.eventType,
              sessionId,
              `sync:${relationship.id}:event:${change.originEventId}:${change.revisionHash}`,
              change.revisionHash,
              JSON.stringify({
                contentEncrypted: true,
                encryptedSourceTable: "memory_events",
                encryptedSourceColumn: "payload",
                actor: change.event.actor,
                content: "[koed encrypted memory event]",
                metadata: {
                  syncRelationshipId: relationship.id,
                  originEventId: change.originEventId
                }
              }),
              change.event.tokenCount,
              change.event.sealReason,
              change.event.sourceEventTime,
              change.event.sourceSequence,
              change.event.capturedAt
            ]
          );
          if (!options.envelopeEncryptionProvider)
            throw new SyncStateConflictError(
              "Envelope encryption provider required for synchronized Memory"
            );
          await upsertEncryptedFieldPayloadWithClient(
            client,
            { userId: relationship.localUserId },
            options.envelopeEncryptionProvider,
            {
              sourceTable: "memory_events",
              sourceId: eventId,
              sourceColumn: "payload",
              plaintext: payload,
              rowFamily: "memory_event",
              scope: {
                tenantId: relationship.localUserId,
                objectClass: "memory_event"
              },
              aad: {
                syncRelationshipId: relationship.id,
                originEventId: change.originEventId
              }
            }
          );
          for (let index = 0; index < contributorIds.length; index += 1) {
            await client.query(
              "insert into memory_event_sources (memory_event_id,conversation_item_id,source_order,source_role) values ($1,$2,$3,'projected_semantic_source') on conflict do nothing",
              [eventId, contributorIds[index], index]
            );
          }
          await client.query(
            "insert into sync_event_mappings (sync_relationship_id,origin_event_id,revision_hash,local_memory_event_id,source_cursor) values ($1,$2,$3,$4,$5)",
            [
              relationship.id,
              change.originEventId,
              change.revisionHash,
              eventId,
              change.cursor
            ]
          );
          eventIds.push(eventId);
        }
        await client.query(
          "update cross_identity_sync_relationships set target_processing_cursor=$2,package_sequence=$3,last_package_id=$4,state='partially_available',updated_at=now() where id=$1",
          [
            relationship.id,
            input.package.toCursor,
            input.package.packageSequence,
            input.package.packageId
          ]
        );
        await client.query(
          "update sync_package_upload_sessions set state='completed',completed_at=now(),updated_at=now() where id=$1",
          [input.uploadSessionId]
        );
        await client.query("commit");
        return { eventIds, invalidatedEventIds };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async listDerivedMemoryNodeIdsForSyncRelationship(input) {
      const result = await pool.query<Row>(
        `select distinct node.id
         from memory_nodes node
         join memory_node_sources source on source.memory_node_id=node.id
         join sync_event_mappings mapping
           on mapping.local_memory_event_id=source.memory_event_id
          and mapping.active=true
         where node.owner_user_id=$1
           and node.visibility='personal'
           and node.invalidated_at is null
           and node.personal_deleted_at is null
           and mapping.sync_relationship_id=$2
         order by node.id`,
        [input.ownerUserId, input.relationshipId]
      );
      return result.rows.map((row) => String(row.id));
    },
    async acknowledgeSourceSyncPackage(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const relationship = await client.query(
          "update cross_identity_sync_relationships set source_cursor=$2,target_processing_cursor=$3,package_sequence=$4,last_package_id=$5,state='ready',last_synced_at=now(),stale_after=now()+($6::int*interval '1 second'),updated_at=now() where id=$1 and side='source' and revoked_at is null and source_cursor<=$2 and target_processing_cursor<=$3 and (package_sequence<$4 or (package_sequence=$4 and source_cursor=$2 and last_package_id=$5)) returning id",
          [
            input.relationshipId,
            input.sourceCursor,
            input.targetProcessingCursor,
            input.packageSequence,
            input.packageId,
            input.staleAfterSeconds
          ]
        );
        if (!relationship.rows[0]) {
          throw new SyncStateConflictError(
            "Source sync relationship can no longer acknowledge this package"
          );
        }
        await client.query(
          "update sync_package_upload_sessions set state='completed',completed_at=now(),updated_at=now() where sync_relationship_id=$1 and protocol_package_id=$2",
          [input.relationshipId, input.packageId]
        );
        await client.query(
          `update sync_outbox_entries entry
           set state='pending',attempt_count=0,available_at=now(),processed_at=null,claim_token=null,lease_expires_at=null,last_error_message=null,updated_at=now()
           where entry.sync_relationship_id=$1
             and entry.idempotency_key='changes'
             and exists (
               select 1
               from cross_identity_sync_relationships relationship
               join memory_replicas replica on replica.id=relationship.local_replica_id
               join sync_semantic_changes change on change.session_id=replica.local_session_id
               where relationship.id=$1 and change.cursor>$2
             )`,
          [input.relationshipId, input.sourceCursor]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async markSourceSyncProcessing(input) {
      await pool.query(
        "update cross_identity_sync_relationships set state='processing',last_package_id=$2,updated_at=now() where id=$1 and side='source' and revoked_at is null and state not in ('failed','paused')",
        [input.relationshipId, input.packageId]
      );
    },
    async markSourceSyncUploadCommitted(input) {
      await pool.query(
        "update sync_package_upload_sessions upload set state='uploaded',uploaded_at=coalesce(uploaded_at,now()),updated_at=now() from cross_identity_sync_relationships relationship where upload.sync_relationship_id=relationship.id and relationship.id=$1 and relationship.side='source' and relationship.revoked_at is null and upload.protocol_package_id=$2 and upload.state in ('created','uploading','uploaded')",
        [input.relationshipId, input.packageId]
      );
    },
    async markTargetSyncReady(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<Row>(
          "update cross_identity_sync_relationships set state='ready',target_processing_cursor=$2,last_package_id=$3,last_synced_at=now(),stale_after=now()+($4::int*interval '1 second'),last_error_class=null,updated_at=now() where id=$1 and side='target' and revoked_at is null and target_processing_cursor<=$2 returning local_replica_id,local_user_id",
          [
            input.relationshipId,
            input.sourceCursor,
            input.packageId,
            input.staleAfterSeconds
          ]
        );
        if (result.rows[0]) {
          await client.query(
            "update memory_replicas set freshness_status='fresh',last_synced_at=now(),updated_at=now() where id=$1",
            [result.rows[0]!.local_replica_id]
          );
          await recordSyncAuditEventWithClient(client, {
            actorUserId: null,
            ownerUserId: String(result.rows[0]!.local_user_id),
            visibility: "personal",
            action: "cross_identity_sync.processing.completed",
            targetTable: "cross_identity_sync_relationships",
            targetId: input.relationshipId,
            metadata: {
              eventKey: `processing:${input.sourceCursor}`,
              sourceCursor: input.sourceCursor
            }
          });
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async markOverdueSyncRelationshipsStale() {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<Row>(
          "update cross_identity_sync_relationships set state='stale',updated_at=now() where state='ready' and revoked_at is null and stale_after is not null and stale_after<=now() returning local_replica_id"
        );
        if (result.rows.length > 0) {
          await client.query(
            "update memory_replicas set freshness_status='stale',updated_at=now() where id=any($1::uuid[])",
            [result.rows.map((row) => String(row.local_replica_id))]
          );
        }
        await client.query("commit");
        return result.rows.length;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async recordCrossIdentitySyncWorkerHeartbeat(instanceId) {
      await pool.query(
        `insert into sync_service_heartbeats (service_name,instance_id,last_seen_at)
         values ('cross_identity_sync_worker',$1,now())
         on conflict (service_name) do update
         set instance_id=excluded.instance_id,last_seen_at=now(),updated_at=now()`,
        [instanceId]
      );
    },
    async isCrossIdentitySyncWorkerReady(maxAgeSeconds = 30) {
      const result = await pool.query(
        `select 1 from sync_service_heartbeats
          where service_name='cross_identity_sync_worker'
            and last_seen_at>now()-($1::int*interval '1 second')
          limit 1`,
        [Math.max(maxAgeSeconds, 1)]
      );
      return Boolean(result.rows[0]);
    },
    async retryCrossIdentitySyncRelationship(actor, syncRelationshipId) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (!(await lockActiveSyncDeviceCredential(client, actor))) {
          await client.query("rollback");
          return null;
        }
        const relationshipResult = await client.query<Row>(
          `select *
           from cross_identity_sync_relationships relationship
           where id=$1
             and local_user_id=$2
             and ${relationshipCredentialClause("relationship", 3)}
             and (
               (state='failed' and revoked_at is null)
               or (
                 side='source'
                 and revoked_at is not null
                 and exists (
                   select 1 from sync_outbox_entries entry
                   where entry.sync_relationship_id=relationship.id
                     and entry.state='failed'
                     and entry.payload_manifest->>'kind'='revocation'
                 )
               )
             )
           for update`,
          [syncRelationshipId, actor.userId, actor.deviceCredentialId ?? null]
        );
        const relationshipRow = relationshipResult.rows[0];
        if (!relationshipRow) {
          await client.query("rollback");
          return null;
        }
        const side = String(relationshipRow.side) as SyncRelationshipSide;
        const queueTable =
          side === "source" ? "sync_outbox_entries" : "sync_inbox_entries";
        const retried = await client.query(
          `update ${queueTable} set state='pending',attempt_count=0,available_at=now(),locked_at=null,claim_token=null,lease_expires_at=null,processed_at=null,last_error_message=null,updated_at=now() where sync_relationship_id=$1 and state='failed' returning id`,
          [syncRelationshipId]
        );
        if (retried.rowCount === 0) {
          await client.query("rollback");
          return null;
        }
        const relationship =
          relationshipRow.revoked_at !== null
            ? await client.query<Row>(
                "update cross_identity_sync_relationships set updated_at=now() where id=$1 and local_user_id=$2 returning *",
                [syncRelationshipId, actor.userId]
              )
            : await client.query<Row>(
                "update cross_identity_sync_relationships set state=$3::sync_relationship_state,failed_at=null,last_error_class=null,updated_at=now() where id=$1 and local_user_id=$2 returning *",
                [
                  syncRelationshipId,
                  actor.userId,
                  side === "source" ? "created" : "processing"
                ]
              );
        if (relationshipRow.revoked_at === null) {
          await client.query(
            "update memory_replicas set freshness_status='unknown',updated_at=now() where id=$1",
            [relationshipRow.local_replica_id]
          );
        }
        await recordSyncAuditEventWithClient(client, {
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: "personal",
          action: "cross_identity_sync.relationship.retry_requested",
          targetTable: "cross_identity_sync_relationships",
          targetId: syncRelationshipId,
          metadata: {
            eventKey: `retry:${side}:${String(relationshipRow.package_sequence)}`,
            side
          }
        });
        await client.query("commit");
        return mapRelationship(relationship.rows[0]!);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async revokeCrossIdentitySyncRelationship(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (!(await lockActiveSyncDeviceCredential(client, actor))) {
          await client.query("rollback");
          return null;
        }
        const revocationId = randomUUID();
        const result = await client.query(
          `update cross_identity_sync_relationships relationship set state='revoked',revoked_at=now(),revoked_by_user_id=$2,revocation_reason=nullif(trim($3),''),revocation_id=$4,revocation_sequence=package_sequence+1,revocation_origin=side,updated_at=now() where id=$1 and local_user_id=$2 and revoked_at is null and ${relationshipCredentialClause("relationship", 5)} returning relationship.*`,
          [
            input.syncRelationshipId,
            actor.userId,
            input.reason ?? null,
            revocationId,
            actor.deviceCredentialId ?? null
          ]
        );
        if (!result.rows[0]) {
          await client.query("rollback");
          return null;
        }
        await client.query(
          "update sync_outbox_entries set state='cancelled',claim_token=null,lease_expires_at=null,processed_at=now(),updated_at=now() where sync_relationship_id=$1 and state in ('pending','processing')",
          [input.syncRelationshipId]
        );
        await client.query(
          "update sync_inbox_entries set state='cancelled',claim_token=null,lease_expires_at=null,processed_at=now(),updated_at=now() where sync_relationship_id=$1 and state in ('pending','processing')",
          [input.syncRelationshipId]
        );
        await client.query(
          "update sync_package_upload_sessions set state='failed',failed_at=coalesce(failed_at,now()),last_error_message='SyncRelationshipRevoked',updated_at=now() where sync_relationship_id=$1 and state not in ('completed','failed')",
          [input.syncRelationshipId]
        );
        if (String((result.rows[0] as Row).side) === "source") {
          await client.query(
            "insert into sync_outbox_entries (sync_relationship_id,idempotency_key,request_hash,payload_manifest,max_attempts) values ($1,$2,$3,$4::jsonb,12) on conflict do nothing",
            [
              input.syncRelationshipId,
              `revocation:${revocationId}`,
              crossIdentitySyncDigest({
                relationshipId: input.syncRelationshipId,
                revocationId
              }),
              JSON.stringify({
                kind: "revocation",
                revocationId,
                revocationSequence: numberValue(
                  (result.rows[0] as Row).revocation_sequence
                )
              })
            ]
          );
        }
        await recordSyncAuditEventWithClient(client, {
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: "personal",
          action: "cross_identity_sync.relationship.revoked",
          targetTable: "cross_identity_sync_relationships",
          targetId: input.syncRelationshipId,
          metadata: {
            eventKey: `revocation:${revocationId}`,
            revocationId,
            side: String((result.rows[0] as Row).side)
          }
        });
        await client.query("commit");
        return mapRelationship(result.rows[0] as Row);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async applyRemoteSyncRevocation(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (
          !actor.deviceCredentialId ||
          !(await lockActiveSyncDeviceCredential(client, actor))
        ) {
          await client.query("rollback");
          return null;
        }
        const result = await client.query(
          `update cross_identity_sync_relationships relationship set state='revoked',revoked_at=coalesce(revoked_at,now()),revoked_by_user_id=$2,revocation_reason=coalesce(revocation_reason,'remote_sync_revoked'),revocation_id=coalesce(revocation_id,$3),revocation_sequence=greatest(coalesce(revocation_sequence,0),$4),revocation_origin='source',updated_at=now() where id=$1 and local_user_id=$2 and side='target' and ${relationshipCredentialClause("relationship", 5)} and (revocation_id is null or revocation_id=$3) returning relationship.*`,
          [
            input.syncRelationshipId,
            actor.userId,
            input.revocationId,
            input.revocationSequence,
            actor.deviceCredentialId
          ]
        );
        if (!result.rows[0]) {
          await client.query("rollback");
          return null;
        }
        await client.query(
          "update sync_outbox_entries set state='cancelled',claim_token=null,lease_expires_at=null,processed_at=now(),updated_at=now() where sync_relationship_id=$1 and state in ('pending','processing') and idempotency_key not like 'revocation:%'",
          [input.syncRelationshipId]
        );
        await client.query(
          "update sync_inbox_entries set state='cancelled',claim_token=null,lease_expires_at=null,processed_at=now(),updated_at=now() where sync_relationship_id=$1 and state in ('pending','processing')",
          [input.syncRelationshipId]
        );
        await client.query(
          "update sync_package_upload_sessions set state='failed',failed_at=coalesce(failed_at,now()),last_error_message='SyncRelationshipRevoked',updated_at=now() where sync_relationship_id=$1 and state not in ('completed','failed')",
          [input.syncRelationshipId]
        );
        await recordSyncAuditEventWithClient(client, {
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: "personal",
          action: "cross_identity_sync.relationship.remote_revoked",
          targetTable: "cross_identity_sync_relationships",
          targetId: input.syncRelationshipId,
          metadata: {
            eventKey: `remote-revocation:${input.revocationId}`,
            revocationId: input.revocationId,
            revocationSequence: input.revocationSequence
          }
        });
        await client.query("commit");
        return mapRelationship(result.rows[0] as Row);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async getCrossIdentitySyncOperationalStatus() {
      const result = await pool.query<Row>(`
        select
          (select count(*) from sync_outbox_entries where state='pending')::int as outbox_pending,
          (select count(*) from sync_outbox_entries where state='processing')::int as outbox_processing,
          (select count(*) from sync_outbox_entries where state='failed')::int as outbox_failed,
          coalesce((select extract(epoch from now()-min(created_at))::int from sync_outbox_entries where state='pending'),0) as outbox_oldest,
          (select count(*) from sync_inbox_entries where state='pending')::int as inbox_pending,
          (select count(*) from sync_inbox_entries where state='processing')::int as inbox_processing,
          (select count(*) from sync_inbox_entries where state='failed')::int as inbox_failed,
          coalesce((select extract(epoch from now()-min(created_at))::int from sync_inbox_entries where state='pending'),0) as inbox_oldest,
          (select count(*) from cross_identity_sync_relationships where state='ready')::int as relationships_ready,
          (select count(*) from cross_identity_sync_relationships where state='stale')::int as relationships_stale,
          (select count(*) from cross_identity_sync_relationships where state='failed')::int as relationships_failed,
          (select count(*) from cross_identity_sync_relationships where state='revoked')::int as relationships_revoked,
          ((select coalesce(sum(greatest(attempt_count-1,0)),0) from sync_outbox_entries)+(select coalesce(sum(greatest(attempt_count-1,0)),0) from sync_inbox_entries))::int as retries,
          coalesce((select sum(total_bytes) from sync_package_upload_sessions where completed_at>=now()-interval '1 hour'),0)::bigint as completed_bytes_last_hour,
          coalesce((select sum(case when jsonb_typeof(package_manifest->'recordCount')='number' then (package_manifest->>'recordCount')::bigint else 0 end) from sync_package_upload_sessions where completed_at>=now()-interval '1 hour'),0)::bigint as completed_records_last_hour,
          coalesce((select sum((select count(*) from sync_semantic_changes change where change.session_id=replica.local_session_id and change.cursor>relationship.source_cursor)) from cross_identity_sync_relationships relationship join memory_replicas replica on replica.id=relationship.local_replica_id where relationship.side='source' and relationship.revoked_at is null),0)::bigint as source_lag_records,
          coalesce((select sum(case when jsonb_typeof(upload.package_manifest->'recordCount')='number' then (upload.package_manifest->>'recordCount')::bigint else 0 end) from sync_package_upload_sessions upload join cross_identity_sync_relationships relationship on relationship.id=upload.sync_relationship_id where relationship.side='target' and relationship.revoked_at is null and upload.state<>'failed' and upload.to_cursor>relationship.target_processing_cursor),0)::bigint as target_lag_records
      `);
      const row = result.rows[0]!;
      return {
        outbox: {
          pending: numberValue(row.outbox_pending),
          processing: numberValue(row.outbox_processing),
          failed: numberValue(row.outbox_failed),
          oldestPendingSeconds: numberValue(row.outbox_oldest)
        },
        inbox: {
          pending: numberValue(row.inbox_pending),
          processing: numberValue(row.inbox_processing),
          failed: numberValue(row.inbox_failed),
          oldestPendingSeconds: numberValue(row.inbox_oldest)
        },
        relationships: {
          ready: numberValue(row.relationships_ready),
          stale: numberValue(row.relationships_stale),
          failed: numberValue(row.relationships_failed),
          revoked: numberValue(row.relationships_revoked)
        },
        retries: numberValue(row.retries),
        completedBytesLastHour: numberValue(row.completed_bytes_last_hour),
        completedRecordsLastHour: numberValue(row.completed_records_last_hour),
        sourceLagRecords: numberValue(row.source_lag_records),
        targetLagRecords: numberValue(row.target_lag_records)
      };
    },
    async cleanupCrossIdentitySyncState(input = {}) {
      const completedRetentionHours = Math.max(
        input.completedRetentionHours ?? 24,
        1
      );
      const abandonedUploadHours = Math.max(
        input.abandonedUploadHours ?? 24,
        1
      );
      const terminalQueueRetentionHours = Math.max(
        input.terminalQueueRetentionHours ?? 720,
        24
      );
      const terminalUploadRetentionHours = Math.max(
        input.terminalUploadRetentionHours ?? 720,
        24
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        const abandoned = await client.query(
          "update sync_package_upload_sessions upload set state='failed',failed_at=coalesce(failed_at,now()),last_error_message=coalesce(last_error_message,'AbandonedSyncUpload'),updated_at=now() where ((state in ('created','uploading','uploaded')) or (state in ('verified','processing') and not exists (select 1 from sync_inbox_entries inbox where inbox.upload_session_id=upload.id and inbox.state in ('pending','processing')))) and updated_at<now()-($1::int*interval '1 hour') returning id",
          [abandonedUploadHours]
        );
        const chunks = await client.query(
          "delete from sync_package_chunks chunk using sync_package_upload_sessions upload where chunk.upload_session_id=upload.id and ((upload.state='completed' and upload.completed_at<now()-($1::int*interval '1 hour')) or (upload.state='failed' and upload.updated_at<now()-($2::int*interval '1 hour'))) returning chunk.id",
          [completedRetentionHours, terminalUploadRetentionHours]
        );
        const queues = await client.query<Row>(
          "with deleted_outbox as (delete from sync_outbox_entries where state in ('completed','failed','cancelled') and updated_at<now()-($1::int*interval '1 hour') returning id), deleted_inbox as (delete from sync_inbox_entries where state in ('completed','failed','cancelled') and updated_at<now()-($1::int*interval '1 hour') returning id) select (select count(*) from deleted_outbox)+(select count(*) from deleted_inbox) as count",
          [terminalQueueRetentionHours]
        );
        const uploads = await client.query(
          "delete from sync_package_upload_sessions upload where upload.state in ('completed','failed') and upload.updated_at<now()-($1::int*interval '1 hour') and not exists (select 1 from sync_package_chunks chunk where chunk.upload_session_id=upload.id) returning upload.id",
          [terminalUploadRetentionHours]
        );
        await client.query("commit");
        return {
          chunksDeleted: chunks.rowCount ?? 0,
          uploadsFailed: abandoned.rowCount ?? 0,
          queueEntriesDeleted: numberValue(queues.rows[0]?.count),
          uploadSessionsDeleted: uploads.rowCount ?? 0
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  };
};
