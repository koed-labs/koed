import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  CAPTURED_SESSION_SYNC_MAX_CHANGES,
  CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES,
  CAPTURED_SESSION_SYNC_MAX_CONTRIBUTORS_PER_EVENT,
  capturedSessionSyncUploadPackageManifestSchema,
  classifyApprovalActivity,
  crossIdentitySyncDigest,
  crossIdentitySyncDeterministicUuid,
  type CapturedSessionSyncChangeV1,
  type CapturedSessionSyncContributorV1,
  type CapturedSessionSyncPackageV1,
  type CapturedSessionSyncSummaryNodeV1,
  type CapturedSessionSyncUploadPackageManifest,
  type EncryptedJsonPackage,
  type EnvelopeEncryptionProvider,
  type RecipientKeyMaterial
} from "@koed/shared";
import { upsertEncryptedFieldPayloadWithClient } from "./encrypted-payload-repository.js";
import { safeConversationMetadataForEncryptedStorage } from "./conversation-item-repository.js";
import { invalidateDerivedMemoryForMemoryEvents } from "./derived-memory-invalidation.js";
import { recordAuditEventWithClient } from "./audit-repository.js";
import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";
import {
  buildCapturedSessionSyncContributor,
  buildCapturedSessionSyncEvent,
  capturedSessionSyncManifestMatchesContributors,
  capturedSessionSyncContentFromUnknown,
  canonicalSyncJsonObject
} from "./cross-identity-sync-canonical.js";
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

const ENCRYPTED_CONVERSATION_ITEM_TEXT = "[koed encrypted conversation item]";
const ENCRYPTED_MEMORY_NODE_TEXT = "[koed encrypted memory node]";
const ENCRYPTED_MEMORY_NODE_JSON = {
  contentEncrypted: true,
  encryptedSourceTable: "memory_nodes"
};

const hasEncryptableText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

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
  ownerPrincipalId: string;
  replicaRole: SyncReplicaRole;
  localSessionId: string | null;
  freshnessStatus: string;
}

export interface LogicalMemoryRecord {
  id: string;
  ownerUserId: string;
  ownerPrincipalId: string;
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
  sourceSummaryRevisionHash: string | null;
  targetSummaryRevisionHash: string | null;
  lastPackageId: string | null;
  lastSyncedAt: string | null;
  staleAfter: string | null;
  pausedAt: string | null;
  stateBeforePause: SyncRelationshipState | null;
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
  packageManifest: CapturedSessionSyncUploadPackageManifest;
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
  prepareCapturedSessionSyncCandidateRevision(
    actor: ActorContext,
    sessionId: string
  ): Promise<number | null>;
  getCapturedSessionSyncSource(
    actor: ActorContext,
    sessionId: string
  ): Promise<CapturedSessionSyncPackageV1["session"] | null>;
  getLocalSyncDeployment(): Promise<DeploymentIdentityRecord | null>;
  ensureLocalSyncDeployment(input: {
    profile: DeploymentProfile;
    protocolDeploymentId: string;
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
  pauseCrossIdentitySyncRelationship(
    actor: ActorContext,
    syncRelationshipId: string
  ): Promise<CrossIdentitySyncRelationshipRecord | null>;
  quarantineCrossIdentitySyncForUpstreamBackend(
    actor: ActorContext,
    upstreamBackendId: string
  ): Promise<{
    relationshipCount: number;
    outboxEntryCount: number;
    uploadSessionCount: number;
  }>;
  resumeCrossIdentitySyncRelationship(
    actor: ActorContext,
    syncRelationshipId: string
  ): Promise<CrossIdentitySyncRelationshipRecord | null>;
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
  getSourceSyncRelationshipForSession(
    actor: ActorContext,
    sessionId: string
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
    summaryNodes: CapturedSessionSyncSummaryNodeV1[];
    summarySnapshotIncluded: boolean;
    summaryRevisionHash: string;
    fromCursor: number;
    toCursor: number;
  } | null>;
  getSharedMemoryLcmSyncState(input: {
    relationshipId: string;
    ownerUserId: string;
    sessionId: string;
    representation: "lcm_leaves" | "lcm_rollups";
  }): Promise<"pending" | "ready">;
  createSyncPackageUploadSession(
    actor: SyncActorContext,
    input: {
      syncRelationshipId: string;
      protocolPackageId: string;
      idempotencyKey: string;
      requestHash: string;
      packageManifest: CapturedSessionSyncUploadPackageManifest;
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
  }): Promise<{
    eventIds: string[];
    invalidatedEventIds: string[];
    summaryNodeIds: string[];
    invalidatedSummaryNodeIds: string[];
  }>;
  acknowledgeSourceSyncPackage(input: {
    relationshipId: string;
    packageId: string;
    sourceCursor: number;
    targetProcessingCursor: number;
    packageSequence: number;
    summaryRevisionHash: string | null;
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
  ownerPrincipalId: String(r.owner_principal_id),
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
  ownerPrincipalId: String(r.owner_principal_id),
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
  sourceSummaryRevisionHash: optionalString(r.source_summary_revision_hash),
  targetSummaryRevisionHash: optionalString(r.target_summary_revision_hash),
  lastPackageId: optionalString(r.last_package_id),
  lastSyncedAt: iso(r.last_synced_at),
  staleAfter: iso(r.stale_after),
  pausedAt: iso(r.paused_at),
  stateBeforePause:
    (r.state_before_pause as SyncRelationshipState | null | undefined) ?? null,
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
  packageManifest: capturedSessionSyncUploadPackageManifestSchema.parse(
    r.package_manifest
  ),
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
        and 'sync' = any(credential.operation_families)
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

const ensureOwnerPrivateReplicaRetentionPolicy = async (
  client: pg.PoolClient,
  input: {
    ownerPrivateReplicaId: string;
    logicalMemoryId: string;
    ownerUserId: string;
  }
): Promise<void> => {
  const policyId = randomUUID();
  const effectiveAt = new Date();
  const target = {
    scope: "owner_private_replica" as const,
    ownerPrivateReplicaId: input.ownerPrivateReplicaId,
    logicalMemoryId: input.logicalMemoryId
  };
  const policyHash = crossIdentitySyncDigest({
    policyId,
    version: 1,
    target,
    retentionSeconds: 0,
    deletionGraceSeconds: 0,
    backupRetentionSeconds: 0,
    effectiveAt: effectiveAt.toISOString()
  });
  await client.query(
    `insert into retention_policies (
       policy_id, version, scope, owner_private_replica_id, logical_memory_id,
       retention_seconds, deletion_grace_seconds, backup_retention_seconds,
       policy_hash, created_by_user_id, effective_at
     ) values ($1,1,'owner_private_replica',$2,$3,0,0,0,$4,$5,$6)
     on conflict do nothing`,
    [
      policyId,
      input.ownerPrivateReplicaId,
      input.logicalMemoryId,
      policyHash,
      input.ownerUserId,
      effectiveAt
    ]
  );
};

export const createCrossIdentitySyncRepository = (
  pool: pg.Pool,
  options: {
    envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
    ownerPrivateReplicaEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  } = {}
): CrossIdentitySyncRepository => {
  const requireOwnerPrivateReplicaEnvelopeEncryptionProvider =
    (): EnvelopeEncryptionProvider => {
      if (!options.ownerPrivateReplicaEnvelopeEncryptionProvider) {
        throw new SyncStateConflictError(
          "Owner-private replica envelope encryption provider required for synchronized Memory"
        );
      }
      return options.ownerPrivateReplicaEnvelopeEncryptionProvider;
    };
  const hydrateField = async (
    actor: ActorContext,
    sourceTable: "memory_events" | "conversation_items" | "memory_nodes",
    sourceId: string,
    sourceColumn: string,
    fallback: unknown
  ): Promise<unknown> => {
    if (
      !options.envelopeEncryptionProvider &&
      !options.ownerPrivateReplicaEnvelopeEncryptionProvider
    ) {
      return fallback;
    }
    const result = await pool.query<{
      encryption_scope: string;
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
      "select encryption_scope,envelope_version,provider_mode,key_id,key_version,scope,provenance,algorithm,ciphertext,nonce,tag,wrapped_dek,ciphertext_location,aad,envelope_created_at,envelope_reencrypted_at from encrypted_field_payloads where owner_user_id = $1 and source_table = $2 and source_id = $3 and source_column = $4 and invalidated_at is null limit 1",
      [actor.userId, sourceTable, sourceId, sourceColumn]
    );
    const row = result.rows[0];
    if (!row) return fallback;
    const provider =
      row.encryption_scope === "owner_private_replica"
        ? options.ownerPrivateReplicaEnvelopeEncryptionProvider
        : options.envelopeEncryptionProvider;
    if (!provider) {
      throw new Error(
        `Envelope encryption provider is unavailable for ${row.encryption_scope}`
      );
    }
    const plaintext = await provider.decrypt({
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

  const readSessionSummarySnapshot = async (input: {
    actor: ActorContext;
    sessionId: string;
  }): Promise<{
    completeLeaves: boolean;
    completeRollups: boolean;
    nodes: CapturedSessionSyncSummaryNodeV1[];
    revisionHash: string;
  }> => {
    const nodeResult = await pool.query<Row>(
      `select *
         from memory_nodes
        where owner_user_id=$1
          and session_id=$2
          and visibility='personal'
          and invalidated_at is null
          and personal_deleted_at is null
        order by depth asc,created_at asc,id asc`,
      [input.actor.userId, input.sessionId]
    );
    const nodeIds = nodeResult.rows.map((row) => String(row.id));
    if (nodeIds.length === 0) {
      return {
        completeLeaves: false,
        completeRollups: false,
        nodes: [],
        revisionHash: crossIdentitySyncDigest([])
      };
    }
    const sourceResult = await pool.query<Row>(
      `select source.memory_node_id,source.memory_event_id,source.source_order,
              event.session_id
         from memory_node_sources source
         join memory_events event on event.id=source.memory_event_id
        where source.memory_node_id=any($1::uuid[])
        order by source.memory_node_id,source.source_order`,
      [nodeIds]
    );
    const childResult = await pool.query<Row>(
      `select parent_memory_node_id,child_memory_node_id,child_order
         from memory_node_children
        where parent_memory_node_id=any($1::uuid[])
        order by parent_memory_node_id,child_order`,
      [nodeIds]
    );
    const sourceIdsByNode = new Map<string, string[]>();
    for (const row of sourceResult.rows) {
      if (String(row.session_id) !== input.sessionId) {
        throw new SyncStateConflictError(
          "LCM summary source crosses its Captured Session boundary"
        );
      }
      const nodeId = String(row.memory_node_id);
      const sourceIds = sourceIdsByNode.get(nodeId) ?? [];
      sourceIds.push(String(row.memory_event_id));
      sourceIdsByNode.set(nodeId, sourceIds);
    }
    const childIdsByNode = new Map<string, string[]>();
    const nodeIdSet = new Set(nodeIds);
    for (const row of childResult.rows) {
      const childId = String(row.child_memory_node_id);
      if (!nodeIdSet.has(childId)) {
        throw new SyncStateConflictError(
          "LCM summary child crosses its Captured Session boundary"
        );
      }
      const nodeId = String(row.parent_memory_node_id);
      const childIds = childIdsByNode.get(nodeId) ?? [];
      childIds.push(childId);
      childIdsByNode.set(nodeId, childIds);
    }
    const pendingLeaves = nodeResult.rows.some(
      (row) => row.kind === "leaf" && !optionalString(row.summary_model)
    );
    const pendingRollups = nodeResult.rows.some(
      (row) => row.kind === "rollup" && !optionalString(row.summary_model)
    );
    if (pendingLeaves) {
      return {
        completeLeaves: false,
        completeRollups: false,
        nodes: [],
        revisionHash: crossIdentitySyncDigest([])
      };
    }
    const nodes: CapturedSessionSyncSummaryNodeV1[] = [];
    for (const row of nodeResult.rows) {
      if (!optionalString(row.summary_model)) continue;
      const originNodeId = String(row.id);
      const kind = String(row.kind);
      const lcmAlgorithmVersion = optionalString(row.lcm_algorithm_version);
      const summaryModel = optionalString(row.summary_model);
      const summaryPromptVersion = optionalString(row.summary_prompt_version);
      const summaryStructuredSchemaVersion = optionalString(
        row.summary_structured_schema_version
      );
      const sourceHash = optionalString(row.source_hash);
      const sourceOriginEventIds = sourceIdsByNode.get(originNodeId) ?? [];
      const childOriginNodeIds = childIdsByNode.get(originNodeId) ?? [];
      const sourceEventCount = numberValue(row.source_event_count);
      const sourceTokenEstimate = numberValue(row.source_token_estimate);
      const summaryTokenEstimate = numberValue(row.summary_token_estimate);
      if (
        (kind !== "leaf" && kind !== "rollup") ||
        !lcmAlgorithmVersion ||
        !summaryModel ||
        !summaryPromptVersion ||
        !summaryStructuredSchemaVersion ||
        !sourceHash ||
        !/^[a-f0-9]{64}$/.test(sourceHash) ||
        sourceOriginEventIds.length === 0 ||
        sourceEventCount !== sourceOriginEventIds.length ||
        sourceTokenEstimate < 0 ||
        summaryTokenEstimate <= 0 ||
        (kind === "leaf" && childOriginNodeIds.length !== 0) ||
        (kind === "rollup" && childOriginNodeIds.length === 0)
      ) {
        throw new SyncStateConflictError(
          "LCM summary provenance is incomplete"
        );
      }
      const summaryTextValue = await hydrateField(
        input.actor,
        "memory_nodes",
        originNodeId,
        "summary_text",
        row.summary_text
      );
      const structuredValue = await hydrateField(
        input.actor,
        "memory_nodes",
        originNodeId,
        "summary_structured_json",
        row.summary_structured_json
      );
      if (
        typeof summaryTextValue !== "string" ||
        summaryTextValue.length === 0 ||
        !structuredValue ||
        typeof structuredValue !== "object" ||
        Array.isArray(structuredValue)
      ) {
        throw new SyncStateConflictError("LCM summary content is unavailable");
      }
      const summaryStructuredJson = canonicalSyncJsonObject(
        structuredValue as Record<string, unknown>,
        "LCM structured summary"
      );
      if (
        typeof summaryStructuredJson.summary_text !== "string" ||
        summaryStructuredJson.summary_text !== summaryTextValue
      ) {
        throw new SyncStateConflictError(
          "LCM summary text and structured summary do not match"
        );
      }
      const base = {
        originNodeId,
        kind,
        depth: numberValue(row.depth),
        lcmAlgorithmVersion,
        summaryText: summaryTextValue,
        summaryModel,
        summaryPromptVersion,
        summaryStructuredJson,
        summaryStructuredSchemaVersion,
        sourceOriginEventIds,
        childOriginNodeIds,
        sourceHash,
        sourceEventCount,
        sourceTokenEstimate,
        summaryTokenEstimate,
        createdAt: iso(row.created_at)!,
        updatedAt: iso(row.updated_at)!
      } satisfies Omit<CapturedSessionSyncSummaryNodeV1, "revisionHash">;
      nodes.push({
        ...base,
        revisionHash: crossIdentitySyncDigest(base)
      });
    }
    return {
      completeLeaves: nodes.some((node) => node.kind === "leaf"),
      completeRollups:
        !pendingRollups && nodes.some((node) => node.kind === "rollup"),
      nodes,
      revisionHash: crossIdentitySyncDigest(nodes)
    };
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
    async prepareCapturedSessionSyncCandidateRevision(actor, sessionId) {
      const result = await pool.query<{ source_revision: string | null }>(
        `with owned_session as (
           select id
             from sessions
            where id=$1 and owner_user_id=$2 and visibility='personal'
              and invalidated_at is null and personal_deleted_at is null
         ), inserted as (
           insert into sync_semantic_changes (
             session_id,memory_event_id,origin_event_id,operation,revision_hash
           )
           select event.session_id,event.id,event.id,
                  case
                    when event.invalidated_at is not null
                      or event.personal_deleted_at is not null
                    then 'delete'::sync_change_operation
                    else 'upsert'::sync_change_operation
                  end,
                  encode(digest(event.id::text || ':initial','sha256'),'hex')
             from memory_events event
             join owned_session session on session.id=event.session_id
            where event.event_type='captured'
              and not exists (
                select 1 from sync_semantic_changes existing
                 where existing.session_id=event.session_id
                   and existing.origin_event_id=event.id
              )
           on conflict do nothing
           returning cursor
         )
         select case when exists (select 1 from owned_session)
                then coalesce((
                  select max(change.cursor)
                    from sync_semantic_changes change
                   where change.session_id=$1
                ),0)::text
                else null end as source_revision`,
        [sessionId, actor.userId]
      );
      const sourceRevision = result.rows[0]?.source_revision ?? null;
      return sourceRevision === null ? null : Number(sourceRevision);
    },
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
    async getLocalSyncDeployment() {
      const result = await pool.query<Row>(
        "select * from deployment_identities where locality='local' limit 1"
      );
      return result.rows[0] ? mapDeployment(result.rows[0]) : null;
    },
    async ensureLocalSyncDeployment(input) {
      const protocolDeploymentId = nonEmpty(
        input.protocolDeploymentId,
        "protocolDeploymentId"
      );
      const existing = await pool.query<Row>(
        "select * from deployment_identities where locality='local' limit 1"
      );
      if (existing.rows[0]) {
        const deployment = mapDeployment(existing.rows[0] as Row);
        if (deployment.protocolDeploymentId !== protocolDeploymentId) {
          throw new SyncStateConflictError(
            "Local deployment protocol identity does not match verified identity"
          );
        }
        return deployment;
      }
      try {
        const result = await pool.query(
          "insert into deployment_identities (protocol_deployment_id,locality,profile) values ($1,'local',$2) returning *",
          [protocolDeploymentId, input.profile]
        );
        return mapDeployment(result.rows[0] as Row);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "23505"
        ) {
          throw error;
        }
        const concurrent = await pool.query<Row>(
          "select * from deployment_identities where locality='local' limit 1"
        );
        if (!concurrent.rows[0]) throw error;
        const deployment = mapDeployment(concurrent.rows[0] as Row);
        if (deployment.protocolDeploymentId !== protocolDeploymentId) {
          throw new SyncStateConflictError(
            "Local deployment protocol identity does not match verified identity"
          );
        }
        return deployment;
      }
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
          "insert into logical_memories (id,owner_user_id,owner_principal_id,origin_deployment_identity_id,source_boundary,origin_source_id,local_session_id,logical_key) values ($1,$2,$2,$3,'captured_session',$4::uuid::text,$4::uuid,$5) on conflict (origin_deployment_identity_id,source_boundary,origin_source_id) do update set updated_at=now() where logical_memories.owner_user_id=excluded.owner_user_id and logical_memories.owner_principal_id=excluded.owner_principal_id returning *",
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
          "insert into memory_replicas (id,logical_memory_id,deployment_identity_id,owner_user_id,owner_principal_id,replica_role,source_boundary,local_session_id,encryption_scope,freshness_status) values ($1,$2,$3,$4,$4,'source','captured_session',$5,'personal','fresh') on conflict (logical_memory_id,deployment_identity_id,replica_role) do update set updated_at=now() where memory_replicas.id=excluded.id and memory_replicas.owner_principal_id=excluded.owner_principal_id returning *",
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
          "insert into cross_identity_sync_relationships (id,logical_memory_id,side,local_replica_id,local_user_id,remote_deployment_identity_id,remote_user_identity_id,remote_replica_id,source_boundary,state,paused_at,state_before_pause,idempotency_key,creation_request_hash,policy_manifest,consent_manifest) values ($1,$2,'source',$3,$4,$5,$6,$7,'captured_session','paused',now(),'created',$8,$9,$10::jsonb,$11::jsonb) on conflict (id) do update set updated_at=cross_identity_sync_relationships.updated_at where cross_identity_sync_relationships.local_user_id=excluded.local_user_id and cross_identity_sync_relationships.remote_deployment_identity_id=excluded.remote_deployment_identity_id and cross_identity_sync_relationships.remote_user_identity_id=excluded.remote_user_identity_id and cross_identity_sync_relationships.creation_request_hash=excluded.creation_request_hash returning *",
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
              set state=case
                    when state='paused' then coalesce(state_before_pause, 'created'::sync_relationship_state)
                    else state
                  end,
                  paused_at=null,
                  state_before_pause=null,
                  updated_at=now()
            where id=$1
              and local_user_id=$2
              and side='source'
              and state not in ('failed','revoked','purge_pending')
              and revoked_at is null
            returning *`,
          [input.relationshipId, input.localUserId]
        );
        if (!result.rows[0]) {
          await client.query("rollback");
          return null;
        }
        await client.query(
          "insert into sync_outbox_entries (sync_relationship_id,idempotency_key,request_hash,payload_manifest) values ($1,'changes',$2,'{}') on conflict (sync_relationship_id,idempotency_key) do update set state=case when sync_outbox_entries.state in ('failed','cancelled') then 'pending'::sync_queue_entry_state else sync_outbox_entries.state end,attempt_count=case when sync_outbox_entries.state in ('failed','cancelled') then 0 else sync_outbox_entries.attempt_count end,available_at=case when sync_outbox_entries.state in ('failed','cancelled') then now() else sync_outbox_entries.available_at end,processed_at=case when sync_outbox_entries.state in ('failed','cancelled') then null else sync_outbox_entries.processed_at end,claim_token=case when sync_outbox_entries.state='processing' then sync_outbox_entries.claim_token else null end,lease_expires_at=case when sync_outbox_entries.state='processing' then sync_outbox_entries.lease_expires_at else null end,last_error_message=case when sync_outbox_entries.state in ('failed','cancelled') then null else sync_outbox_entries.last_error_message end,updated_at=now()",
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
    async pauseCrossIdentitySyncRelationship(actor, syncRelationshipId) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const currentResult = await client.query<Row>(
          `select *
             from cross_identity_sync_relationships
            where id=$1
              and local_user_id=$2
              and side='source'
            for update`,
          [syncRelationshipId, actor.userId]
        );
        const current = currentResult.rows[0];
        if (!current || current.revoked_at) {
          await client.query("rollback");
          return null;
        }
        if (current.state === "paused") {
          await client.query("commit");
          return mapRelationship(current);
        }
        if (
          ![
            "created",
            "uploading",
            "uploaded",
            "verified",
            "processing",
            "partially_available",
            "ready",
            "stale"
          ].includes(String(current.state))
        ) {
          await client.query("rollback");
          return null;
        }
        const paused = await client.query<Row>(
          `update cross_identity_sync_relationships
              set state_before_pause=state,
                  state='paused',
                  paused_at=now(),
                  updated_at=now()
            where id=$1
              and local_user_id=$2
              and side='source'
              and revoked_at is null
              and state<>'paused'
            returning *`,
          [syncRelationshipId, actor.userId]
        );
        const pausedRow = paused.rows[0];
        if (!pausedRow) {
          await client.query("rollback");
          return null;
        }
        await client.query(
          `update sync_outbox_entries
              set state='pending',
                  attempt_count=greatest(attempt_count-1,0),
                  available_at=now(),
                  locked_at=null,
                  claim_token=null,
                  lease_expires_at=null,
                  processed_at=null,
                  updated_at=now()
            where sync_relationship_id=$1
              and state='processing'
              and payload_manifest->>'kind' is distinct from 'revocation'`,
          [syncRelationshipId]
        );
        await recordSyncAuditEventWithClient(client, {
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: "personal",
          action: "cross_identity_sync.relationship.paused",
          targetTable: "cross_identity_sync_relationships",
          targetId: syncRelationshipId,
          metadata: {
            eventKey: `pause:${iso(pausedRow.paused_at)}`,
            stateBeforePause: String(pausedRow.state_before_pause)
          }
        });
        await client.query("commit");
        return mapRelationship(pausedRow);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async quarantineCrossIdentitySyncForUpstreamBackend(
      actor,
      upstreamBackendId
    ) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const relationships = await client.query<Row>(
          `update cross_identity_sync_relationships relationship
              set state_before_pause=relationship.state,
                  state='paused',
                  paused_at=now(),
                  updated_at=now()
             from deployment_identities remote_deployment
            where relationship.remote_deployment_identity_id=remote_deployment.id
              and relationship.local_user_id=$1
              and relationship.side='source'
              and relationship.revoked_at is null
              and relationship.state in (
                'created',
                'uploading',
                'uploaded',
                'verified',
                'processing',
                'partially_available',
                'ready',
                'stale'
              )
              and remote_deployment.upstream_backend_id=$2
            returning relationship.*`,
          [actor.userId, upstreamBackendId]
        );
        const relationshipIds = relationships.rows.map((row) => String(row.id));
        if (relationshipIds.length === 0) {
          await client.query("commit");
          return {
            relationshipCount: 0,
            outboxEntryCount: 0,
            uploadSessionCount: 0
          };
        }
        const outbox = await client.query(
          `update sync_outbox_entries
              set state='cancelled',
                  locked_at=null,
                  claim_token=null,
                  lease_expires_at=null,
                  processed_at=now(),
                  last_error_message=null,
                  updated_at=now()
            where sync_relationship_id=any($1::uuid[])
              and state in ('pending','processing')`,
          [relationshipIds]
        );
        const uploads = await client.query(
          `update sync_package_upload_sessions
              set state='failed',
                  failed_at=coalesce(failed_at,now()),
                  last_error_message='UpstreamBackendDisconnected',
                  updated_at=now()
            where sync_relationship_id=any($1::uuid[])
              and state in ('created','uploading','uploaded','verified','processing')`,
          [relationshipIds]
        );
        for (const row of relationships.rows) {
          await recordSyncAuditEventWithClient(client, {
            actorUserId: actor.userId,
            ownerUserId: actor.userId,
            visibility: "personal",
            action: "cross_identity_sync.relationship.backend_disconnected",
            targetTable: "cross_identity_sync_relationships",
            targetId: String(row.id),
            metadata: {
              eventKey: `backend-disconnected:${upstreamBackendId}:${iso(row.paused_at)}`,
              upstreamBackendId
            }
          });
        }
        await client.query("commit");
        return {
          relationshipCount: relationships.rowCount ?? relationshipIds.length,
          outboxEntryCount: outbox.rowCount ?? 0,
          uploadSessionCount: uploads.rowCount ?? 0
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async resumeCrossIdentitySyncRelationship(actor, syncRelationshipId) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const currentResult = await client.query<Row>(
          `select relationship.*,
                  exists (
                    select 1
                      from memory_replicas replica
                      join sync_semantic_changes change
                        on change.session_id=replica.local_session_id
                     where replica.id=relationship.local_replica_id
                       and change.cursor>relationship.source_cursor
                  ) as has_unsynced_changes,
                  exists (
                    select 1
                      from sync_package_upload_sessions upload
                     where upload.sync_relationship_id=relationship.id
                       and upload.state not in ('completed','failed')
                  ) as has_incomplete_package
             from cross_identity_sync_relationships relationship
            where relationship.id=$1
              and relationship.local_user_id=$2
              and relationship.side='source'
            for update of relationship`,
          [syncRelationshipId, actor.userId]
        );
        const current = currentResult.rows[0];
        if (!current || current.revoked_at || current.state === "revoked") {
          await client.query("rollback");
          return null;
        }
        if (current.state !== "paused") {
          await client.query("commit");
          return mapRelationship(current);
        }
        const stateBeforePause = String(
          current.state_before_pause
        ) as SyncRelationshipState;
        const resumed = await client.query<Row>(
          `update cross_identity_sync_relationships
              set state=state_before_pause,
                  paused_at=null,
                  state_before_pause=null,
                  updated_at=now()
            where id=$1
              and local_user_id=$2
              and side='source'
              and state='paused'
              and revoked_at is null
            returning *`,
          [syncRelationshipId, actor.userId]
        );
        const resumedRow = resumed.rows[0];
        if (!resumedRow) {
          await client.query("rollback");
          return null;
        }
        const needsWork =
          !["ready", "stale"].includes(stateBeforePause) ||
          current.has_unsynced_changes === true ||
          current.has_incomplete_package === true;
        if (needsWork) {
          await client.query(
            `insert into sync_outbox_entries (
               sync_relationship_id,idempotency_key,request_hash,payload_manifest
             ) values ($1,'changes',$2,'{}')
             on conflict (sync_relationship_id,idempotency_key) do update
               set state='pending',
                   attempt_count=case
                     when sync_outbox_entries.state in ('failed','cancelled','completed') then 0
                     else sync_outbox_entries.attempt_count
                   end,
                   available_at=now(),
                   locked_at=null,
                   claim_token=null,
                   lease_expires_at=null,
                   processed_at=null,
                   last_error_message=case
                     when sync_outbox_entries.state in ('failed','cancelled') then null
                     else sync_outbox_entries.last_error_message
                   end,
                   updated_at=now()`,
            [
              syncRelationshipId,
              crossIdentitySyncDigest({
                relationshipId: syncRelationshipId,
                initial: true
              })
            ]
          );
        }
        await recordSyncAuditEventWithClient(client, {
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: "personal",
          action: "cross_identity_sync.relationship.resumed",
          targetTable: "cross_identity_sync_relationships",
          targetId: syncRelationshipId,
          metadata: {
            eventKey: `resume:${iso(current.paused_at)}`,
            resumedState: stateBeforePause,
            workRequeued: needsWork
          }
        });
        await client.query("commit");
        return mapRelationship(resumedRow);
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
          `insert into sessions (
             owner_user_id, visibility, external_session_id, source_runtime,
             capture_method, idempotency_key, source_kind,
             source_adapter_version, metadata, captured_at
           ) values ($1, 'personal', null, $2, 'api', $3, 'koed_sync', $4, $5::jsonb, $6)
           on conflict (owner_user_id, visibility, idempotency_key)
             where idempotency_key is not null
           do update set external_session_id=null,
                         metadata=excluded.metadata,
                         updated_at=now()
           returning *`,
          [
            actor.userId,
            input.session.sourceRuntime,
            `sync:${input.logicalMemoryId}:session`,
            input.session.sourceAdapterVersion,
            JSON.stringify({
              syncReplica: true,
              contentEncrypted: true
            }),
            input.session.capturedAt
          ]
        );
        if (!sessionResult.rows[0]) throw new SyncIdempotencyConflictError();
        const sessionId = String((sessionResult.rows[0] as Row).id);
        const logicalResult = await client.query(
          "insert into logical_memories (id,owner_user_id,owner_principal_id,origin_deployment_identity_id,source_boundary,origin_source_id,local_session_id,logical_key) values ($1,$2,$7,$3,'captured_session',$4,$5,$6) on conflict (id) do update set updated_at=now() where logical_memories.owner_user_id=excluded.owner_user_id and logical_memories.owner_principal_id=excluded.owner_principal_id and logical_memories.origin_deployment_identity_id=excluded.origin_deployment_identity_id and logical_memories.origin_source_id=excluded.origin_source_id returning *",
          [
            input.logicalMemoryId,
            actor.userId,
            input.remoteDeploymentIdentityId,
            input.originSessionId,
            sessionId,
            `captured-session:${input.originSessionId}`,
            input.remoteUserIdentityId
          ]
        );
        if (!logicalResult.rows[0]) throw new SyncIdempotencyConflictError();
        const logical = mapLogical(logicalResult.rows[0] as Row);
        const replicaResult = await client.query(
          "insert into memory_replicas (id,logical_memory_id,deployment_identity_id,owner_user_id,owner_principal_id,replica_role,source_boundary,local_session_id,encryption_scope,freshness_status) values ($1,$2,$3,$4,$6,'target','captured_session',$5,'owner_private_replica','unknown') on conflict (id) do update set updated_at=now() where memory_replicas.logical_memory_id=excluded.logical_memory_id and memory_replicas.owner_user_id=excluded.owner_user_id and memory_replicas.owner_principal_id=excluded.owner_principal_id returning *",
          [
            input.localReplicaId,
            logical.id,
            input.localDeploymentIdentityId,
            actor.userId,
            sessionId,
            input.remoteUserIdentityId
          ]
        );
        if (!replicaResult.rows[0]) throw new SyncIdempotencyConflictError();
        const replica = mapReplica(replicaResult.rows[0] as Row);
        await ensureOwnerPrivateReplicaRetentionPolicy(client, {
          ownerPrivateReplicaId: replica.id,
          logicalMemoryId: logical.id,
          ownerUserId: actor.userId
        });
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
    async getSourceSyncRelationshipForSession(actor, sessionId) {
      const result = await pool.query<Row>(
        `select relationship.*
           from cross_identity_sync_relationships relationship
           join memory_replicas replica
             on replica.id=relationship.local_replica_id
          where relationship.side='source'
            and relationship.local_user_id=$1
            and replica.local_session_id=$2
          order by relationship.created_at desc
          limit 1`,
        [actor.userId, sessionId]
      );
      return result.rows[0] ? mapRelationship(result.rows[0]) : null;
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
            and 'sync'=any(credential.operation_families)
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
        "select sr.*,lm.local_session_id,di.protocol_deployment_id from cross_identity_sync_relationships sr join logical_memories lm on lm.id=sr.logical_memory_id join memory_replicas mr on mr.id=sr.local_replica_id join deployment_identities di on di.id=mr.deployment_identity_id where sr.id=$1 and sr.side='source' and sr.state<>'paused' and sr.revoked_at is null for update",
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
        const hydratedEventPayload = await hydrateField(
          actor,
          "memory_events",
          String(changeRow.id),
          "payload",
          changeRow.payload
        );
        const payload = objectValue(hydratedEventPayload);
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
          const hydratedMetadata = canonicalSyncJsonObject(
            await hydrateField(
              actor,
              "conversation_items",
              String(contributor.id),
              "metadata",
              contributor.metadata
            ),
            "conversation item metadata"
          );
          const hydratedTransportChunkText = await hydrateField(
            actor,
            "conversation_items",
            String(contributor.id),
            "transport_chunk_text",
            contributor.transport_chunk_text
          );
          const content =
            typeof hydratedRawText === "string" && hydratedRawText
              ? hydratedRawText
              : capturedSessionSyncContentFromUnknown(hydratedRawJson);
          const actorValue =
            hydratedMetadata.actor ?? contributor.source_event_type;
          if (
            classifyApprovalActivity({
              metadata: hydratedMetadata,
              actor: actorValue,
              content
            })
          ) {
            throw new SyncStateConflictError(
              "Approval Activity is excluded from semantic synchronization"
            );
          }
          const kindValue =
            contributor.source_event_type ?? contributor.source_record_type;
          let rawText: string | null;
          if (hydratedRawText === null) {
            rawText = null;
          } else if (typeof hydratedRawText === "string") {
            rawText = hydratedRawText;
          } else {
            throw new SyncStateConflictError(
              "Conversation item raw text must be a string"
            );
          }
          const canonical = buildCapturedSessionSyncContributor({
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
                : numberValue(contributor.source_sequence),
            sourceKind: String(contributor.source_kind),
            sourceAdapterVersion: String(contributor.source_adapter_version),
            sourceTransport: String(contributor.source_transport),
            sourceRecordType: String(contributor.source_record_type),
            sourceEventType: optionalString(contributor.source_event_type),
            rawJson: hydratedRawJson,
            rawText,
            metadata: hydratedMetadata,
            logicalSourceId: optionalString(contributor.logical_source_id),
            transportChunkIndex: numberValue(contributor.transport_chunk_index),
            transportChunkCount: numberValue(contributor.transport_chunk_count),
            transportChunkText: optionalString(hydratedTransportChunkText),
            transportChunkEncoding: optionalString(
              contributor.transport_chunk_encoding
            ),
            projectionStatus: String(
              contributor.projection_status
            ) as CapturedSessionSyncContributorV1["projectionStatus"],
            projectionVersion: optionalString(contributor.projection_version),
            projectionPolicyRevision:
              contributor.projection_policy_revision === null
                ? null
                : numberValue(contributor.projection_policy_revision),
            memoryExcludedAt: iso(contributor.memory_excluded_at),
            memoryExclusionReason: optionalString(
              contributor.memory_exclusion_reason
            )
          });
          contributors.push(canonical);
        }
        const eventMetadata = canonicalSyncJsonObject(
          objectValue(payload.metadata),
          "memory event metadata"
        );
        if (
          !capturedSessionSyncManifestMatchesContributors(
            eventMetadata,
            contributors
          )
        ) {
          throw new SyncStateConflictError(
            "Memory Event contributor snapshot is not stable"
          );
        }
        const event = buildCapturedSessionSyncEvent({
          originEventId: String(changeRow.id),
          eventType: String(changeRow.event_type),
          actor: typeof payload.actor === "string" ? payload.actor : "system",
          content: typeof payload.content === "string" ? payload.content : "",
          metadata: eventMetadata,
          includeInEmbedding: Boolean(changeRow.include_in_embedding),
          includeInLcm: Boolean(changeRow.include_in_lcm),
          projectionPolicyKey: optionalString(changeRow.projection_policy_key),
          projectionPolicyRevision:
            changeRow.projection_policy_revision === null
              ? null
              : numberValue(changeRow.projection_policy_revision),
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
        });
        changes.push({
          cursor,
          operation: "upsert",
          originEventId: event.originEventId,
          revisionHash: event.revisionHash,
          event
        });
      }
      const toCursor = changes.length
        ? Math.max(...changes.map((change) => change.cursor))
        : relationship.sourceCursor;
      const summarySnapshot = await readSessionSummarySnapshot({
        actor,
        sessionId
      });
      const summarySnapshotChanged =
        summarySnapshot.revisionHash !== relationship.sourceSummaryRevisionHash;
      const summarySnapshotIncluded =
        summarySnapshotChanged &&
        (summarySnapshot.completeLeaves ||
          (relationship.sourceSummaryRevisionHash !== null &&
            summarySnapshot.nodes.length === 0));
      const summaryNodes = summarySnapshotIncluded ? summarySnapshot.nodes : [];
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
        summaryNodes,
        summarySnapshotIncluded,
        summaryRevisionHash: summarySnapshotIncluded
          ? summarySnapshot.revisionHash
          : crossIdentitySyncDigest([]),
        fromCursor: relationship.sourceCursor,
        toCursor
      };
    },
    async getSharedMemoryLcmSyncState(input) {
      const relationshipResult = await pool.query<Row>(
        `select relationship.*
           from cross_identity_sync_relationships relationship
           join memory_replicas replica
             on replica.id=relationship.local_replica_id
          where relationship.id=$1
            and relationship.side='source'
            and relationship.local_user_id=$2
            and relationship.revoked_at is null
            and relationship.state not in ('failed','revoked','purge_pending')
            and replica.local_session_id=$3
          limit 1`,
        [input.relationshipId, input.ownerUserId, input.sessionId]
      );
      const row = relationshipResult.rows[0];
      if (!row) return "pending";
      const relationship = mapRelationship(row);
      const snapshot = await readSessionSummarySnapshot({
        actor: { userId: input.ownerUserId },
        sessionId: input.sessionId
      });
      const complete =
        input.representation === "lcm_leaves"
          ? snapshot.completeLeaves
          : snapshot.completeLeaves && snapshot.completeRollups;
      if (!complete) return "pending";
      if (relationship.sourceSummaryRevisionHash === snapshot.revisionHash) {
        return "ready";
      }
      await pool.query(
        `insert into sync_outbox_entries (
           sync_relationship_id,idempotency_key,request_hash,payload_manifest
         ) values (
           $1,$2,$3,jsonb_build_object('kind','summary_snapshot','sessionId',$4::uuid)
         )
         on conflict (sync_relationship_id,idempotency_key) do update set
           state=case
             when sync_outbox_entries.state='processing'
               then sync_outbox_entries.state
             else 'pending'::sync_queue_entry_state
           end,
           attempt_count=case
             when sync_outbox_entries.state='processing'
               then sync_outbox_entries.attempt_count
             else 0
           end,
           available_at=case
             when sync_outbox_entries.state='processing'
               then sync_outbox_entries.available_at
             else now()
           end,
           processed_at=case
             when sync_outbox_entries.state='processing'
               then sync_outbox_entries.processed_at
             else null
           end,
           claim_token=case
             when sync_outbox_entries.state='processing'
               then sync_outbox_entries.claim_token
             else null
           end,
           lease_expires_at=case
             when sync_outbox_entries.state='processing'
               then sync_outbox_entries.lease_expires_at
             else null
           end,
           last_error_message=case
             when sync_outbox_entries.state='processing'
               then sync_outbox_entries.last_error_message
             else null
           end,
           updated_at=now()`,
        [
          input.relationshipId,
          `summary-snapshot:${snapshot.revisionHash}`,
          snapshot.revisionHash,
          input.sessionId
        ]
      );
      return "pending";
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
          `select spu.* from sync_package_upload_sessions spu join cross_identity_sync_relationships sr on sr.id=spu.sync_relationship_id where spu.id=$1 and sr.local_user_id=$2 and sr.state<>'paused' and sr.revoked_at is null and ($3::text is null or sr.side::text=$3) and ${relationshipCredentialClause("sr", 4)} for update`,
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
            and relationship.state<>'paused'
            and relationship.revoked_at is null
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
          `select spu.* from sync_package_upload_sessions spu join cross_identity_sync_relationships sr on sr.id=spu.sync_relationship_id where spu.id=$1 and sr.local_user_id=$2 and sr.state<>'paused' and sr.revoked_at is null and ($3::text is null or sr.side::text=$3) and ${relationshipCredentialClause("sr", 4)} for update`,
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
            and 'sync'=any(credential.operation_families)
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
        if (input.queue === "inbox") {
          await client.query(
            `update sync_inbox_entries entry
                set state='completed',processed_at=now(),locked_at=null,
                    claim_token=null,lease_expires_at=null,
                    last_error_message=null,updated_at=now()
               from sync_package_upload_sessions upload,
                    cross_identity_sync_relationships relationship
              where upload.id=entry.upload_session_id
                and relationship.id=entry.sync_relationship_id
                and relationship.side='target'
                and relationship.revoked_at is null
                and relationship.package_sequence>upload.source_sequence
                and relationship.target_processing_cursor>=upload.to_cursor
                and (
                  entry.state='pending'
                  or (entry.state='processing' and
                      (entry.lease_expires_at is null or entry.lease_expires_at<=now()))
                )`
          );
        }
        const expired = await client.query<Row>(
          `select entry.id,entry.sync_relationship_id,entry.upload_session_id,
                  entry.idempotency_key,entry.payload_manifest->>'kind' as payload_kind
           from ${table} entry
           join cross_identity_sync_relationships relationship
             on relationship.id=entry.sync_relationship_id
           where entry.state='processing'
             and (entry.lease_expires_at is null or entry.lease_expires_at<=now())
             and entry.attempt_count>=entry.max_attempts
             and relationship.state<>'paused'
           order by entry.lease_expires_at,entry.created_at
           for update of relationship,entry skip locked
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
                "update cross_identity_sync_relationships set state='failed',failed_at=now(),last_error_class='SyncQueueLeaseExpiredError',updated_at=now() where id=$1 and state<>'paused' and revoked_at is null returning local_replica_id,local_user_id",
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
          `with candidate as (
             select entry.id
               from ${table} entry
               join cross_identity_sync_relationships relationship
                 on relationship.id=entry.sync_relationship_id
              where (entry.state='pending' or (entry.state='processing' and
                     (entry.lease_expires_at is null or entry.lease_expires_at<=now())))
                and entry.available_at<=now()
                and entry.attempt_count<entry.max_attempts
                and (
                  ($2='outbox'
                    and relationship.side='source'
                    and (
                      (entry.payload_manifest->>'kind'='revocation'
                        and relationship.state='revoked')
                      or (entry.payload_manifest->>'kind' is distinct from 'revocation'
                        and relationship.revoked_at is null
                        and relationship.state not in ('paused','failed','revoked','purge_pending'))
                    ))
                  or ($2='inbox'
                    and relationship.side='target'
                    and relationship.revoked_at is null
                    and relationship.state not in ('paused','failed','revoked','purge_pending'))
                )
              order by entry.available_at,entry.created_at
              for update of relationship,entry skip locked
              limit 1
           )
           update ${table} q
              set state='processing',attempt_count=attempt_count+1,locked_at=now(),
                  claim_token=gen_random_uuid(),
                  lease_expires_at=now()+($1::int*interval '1 millisecond'),
                  updated_at=now()
             from candidate
            where q.id=candidate.id
            returning q.*`,
          [input.leaseMs, input.queue]
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
        if (input.queue === "inbox") {
          const superseded = await client.query(
            `update sync_inbox_entries entry
                set state='completed',processed_at=now(),claim_token=null,
                    lease_expires_at=null,last_error_message=null,updated_at=now()
               from sync_package_upload_sessions upload,
                    cross_identity_sync_relationships relationship
              where entry.id=$1
                and entry.state='processing'
                and entry.claim_token=$2
                and entry.lease_expires_at>now()
                and upload.id=entry.upload_session_id
                and relationship.id=entry.sync_relationship_id
                and relationship.side='target'
                and relationship.package_sequence>upload.source_sequence
                and relationship.target_processing_cursor>=upload.to_cursor
              returning entry.id`,
            [input.id, input.claimToken]
          );
          if (superseded.rowCount === 1) {
            await client.query("commit");
            return true;
          }
        }
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
            "update cross_identity_sync_relationships set state='failed',failed_at=now(),last_error_class=$2,updated_at=now() where id=$1 and state<>'paused' and revoked_at is null returning local_replica_id,local_user_id",
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
      const summaryNodeIds: string[] = [];
      const invalidatedSummaryNodeIds: string[] = [];
      try {
        await client.query("begin");
        const ownerPrivateReplicaEncryptionProvider =
          requireOwnerPrivateReplicaEnvelopeEncryptionProvider();
        const relationshipResult = await client.query(
          `select relationship.*,
                  upload.package_manifest as upload_package_manifest
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
              and 'sync'=any(credential.operation_families)
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
        const uploadManifest = objectValue(
          relationshipRow.upload_package_manifest
        );
        const manifestSummaryRevisionHash = optionalString(
          uploadManifest.summaryRevisionHash
        );
        const summarySnapshotIncluded = manifestSummaryRevisionHash !== null;
        if (
          (summarySnapshotIncluded &&
            manifestSummaryRevisionHash !==
              input.package.summaryRevisionHash) ||
          (!summarySnapshotIncluded && input.package.summaryNodes.length > 0)
        ) {
          throw new SyncStateConflictError(
            "Sync package summary snapshot does not match its manifest"
          );
        }
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
          const replaySummaryMappings = await client.query<Row>(
            "select local_memory_node_id,active from sync_summary_node_mappings where sync_relationship_id=$1 and origin_node_id=any($2::uuid[]) and local_memory_node_id is not null",
            [
              relationship.id,
              input.package.summaryNodes.map((node) => node.originNodeId)
            ]
          );
          await client.query("commit");
          return {
            eventIds: replayMappings.rows
              .filter((row) => Boolean(row.active))
              .map((row) => String(row.local_memory_event_id)),
            invalidatedEventIds: replayMappings.rows
              .filter((row) => !row.active)
              .map((row) => String(row.local_memory_event_id)),
            summaryNodeIds: replaySummaryMappings.rows
              .filter((row) => Boolean(row.active))
              .map((row) => String(row.local_memory_node_id)),
            invalidatedSummaryNodeIds: replaySummaryMappings.rows
              .filter((row) => !row.active)
              .map((row) => String(row.local_memory_node_id))
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
          "select mr.local_session_id,mr.owner_principal_id from memory_replicas mr where mr.id=$1 and mr.owner_user_id=$2",
          [relationship.localReplicaId, relationship.localUserId]
        );
        const sessionId =
          optionalString(replicaResult.rows[0]?.local_session_id) ?? "";
        const ownerPrincipalId =
          optionalString(replicaResult.rows[0]?.owner_principal_id) ?? "";
        if (!sessionId)
          throw new SyncStateConflictError("Target replica session missing");
        if (!ownerPrincipalId)
          throw new SyncStateConflictError(
            "Target replica owner principal missing"
          );
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
            if (
              classifyApprovalActivity({
                metadata: contributor.metadata,
                actor: contributor.actor,
                content: contributor.content
              })
            ) {
              throw new SyncStateConflictError(
                "Approval Activity is excluded from semantic synchronization"
              );
            }
            const encryptedColumns = [
              "raw_json",
              ...(hasEncryptableText(contributor.rawText) ? ["raw_text"] : []),
              ...(hasEncryptableText(contributor.transportChunkText)
                ? ["transport_chunk_text"]
                : []),
              "metadata"
            ];
            const metadataForStorage =
              safeConversationMetadataForEncryptedStorage(
                contributor.metadata,
                "encryptedConversationItemColumns",
                encryptedColumns
              );
            const itemResult = await client.query<Row>(
              `insert into conversation_items (
                 id,owner_user_id,visibility,session_id,source_kind,
                 source_adapter_version,source_transport,external_item_id,
                 source_record_type,source_event_type,source_sequence,event_time,
                 observed_at,raw_json,raw_text,source_hash,idempotency_key,
                 canonical_item_key,projection_status,projection_version,
                 projection_policy_revision,memory_excluded_at,
                 memory_exclusion_reason,metadata,logical_source_id,
                 transport_chunk_index,transport_chunk_count,
                 transport_chunk_text,transport_chunk_encoding
               ) values (
                 $1,$2,'personal',$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,
                 $12::timestamptz,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,
                 $22,$23::jsonb,$24,$25,$26,$27,$28
               )
               on conflict (owner_user_id,canonical_item_key)
               where visibility='personal'
               do update set
                 session_id = excluded.session_id,
                 source_kind = excluded.source_kind,
                 source_adapter_version = excluded.source_adapter_version,
                 source_transport = excluded.source_transport,
                 external_item_id = excluded.external_item_id,
                 source_record_type = excluded.source_record_type,
                 source_event_type = excluded.source_event_type,
                 source_sequence = excluded.source_sequence,
                 event_time = excluded.event_time,
                 observed_at = excluded.observed_at,
                 raw_json = excluded.raw_json,
                 raw_text = excluded.raw_text,
                 source_hash = excluded.source_hash,
                 idempotency_key = excluded.idempotency_key,
                 projection_status = excluded.projection_status,
                 projection_version = excluded.projection_version,
                 projection_policy_revision = excluded.projection_policy_revision,
                 memory_excluded_at = excluded.memory_excluded_at,
                 memory_exclusion_reason = excluded.memory_exclusion_reason,
                 metadata = excluded.metadata,
                 logical_source_id = excluded.logical_source_id,
                 transport_chunk_index = excluded.transport_chunk_index,
                 transport_chunk_count = excluded.transport_chunk_count,
                 transport_chunk_text = excluded.transport_chunk_text,
                 transport_chunk_encoding = excluded.transport_chunk_encoding
               where conversation_items.owner_user_id = excluded.owner_user_id
                 and conversation_items.session_id = excluded.session_id
                 and conversation_items.visibility = 'personal'
              returning id`,
              [
                randomUUID(),
                relationship.localUserId,
                sessionId,
                contributor.sourceKind,
                contributor.sourceAdapterVersion,
                contributor.sourceTransport,
                contributor.originItemId,
                contributor.sourceRecordType,
                contributor.sourceEventType,
                contributor.sourceSequence,
                contributor.sourceEventTime,
                contributor.sourceEventTime ?? change.event.capturedAt,
                JSON.stringify({
                  contentEncrypted: true,
                  encryptedSourceTable: "conversation_items",
                  encryptedSourceColumn: "raw_json"
                }),
                hasEncryptableText(contributor.rawText)
                  ? ENCRYPTED_CONVERSATION_ITEM_TEXT
                  : contributor.rawText,
                contributor.revisionHash,
                `sync:${relationship.id}:item:${contributor.originItemId}:${contributor.revisionHash}`,
                `sync:${relationship.id}:canonical-item:${contributor.originItemId}`,
                contributor.projectionStatus,
                contributor.projectionVersion,
                contributor.projectionPolicyRevision,
                contributor.memoryExcludedAt,
                contributor.memoryExclusionReason,
                JSON.stringify(metadataForStorage),
                contributor.logicalSourceId,
                contributor.transportChunkIndex,
                contributor.transportChunkCount,
                hasEncryptableText(contributor.transportChunkText)
                  ? ENCRYPTED_CONVERSATION_ITEM_TEXT
                  : contributor.transportChunkText,
                contributor.transportChunkEncoding
              ]
            );
            if (itemResult.rows.length !== 1) {
              throw new SyncStateConflictError(
                "Synchronized conversation item identity conflicts with another replica"
              );
            }
            const itemId = String(itemResult.rows[0]!.id);
            contributorIds.push(itemId);
            await upsertEncryptedFieldPayloadWithClient(
              client,
              { userId: relationship.localUserId },
              ownerPrivateReplicaEncryptionProvider,
              {
                sourceTable: "conversation_items",
                sourceId: itemId,
                sourceColumn: "raw_json",
                plaintext: contributor.rawJson,
                visibility: "owner_private_replica",
                ownerPrincipalId,
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
            const encryptedContributorInput = {
              visibility: "owner_private_replica" as const,
              ownerPrincipalId,
              rowFamily: "conversation_item",
              scope: {
                tenantId: relationship.localUserId,
                objectClass: "conversation_item"
              },
              aad: {
                syncRelationshipId: relationship.id,
                originItemId: contributor.originItemId
              }
            };
            if (hasEncryptableText(contributor.rawText)) {
              await upsertEncryptedFieldPayloadWithClient(
                client,
                { userId: relationship.localUserId },
                ownerPrivateReplicaEncryptionProvider,
                {
                  sourceTable: "conversation_items",
                  sourceId: itemId,
                  sourceColumn: "raw_text",
                  plaintext: contributor.rawText,
                  ...encryptedContributorInput
                }
              );
            }
            if (hasEncryptableText(contributor.transportChunkText)) {
              await upsertEncryptedFieldPayloadWithClient(
                client,
                { userId: relationship.localUserId },
                ownerPrivateReplicaEncryptionProvider,
                {
                  sourceTable: "conversation_items",
                  sourceId: itemId,
                  sourceColumn: "transport_chunk_text",
                  plaintext: contributor.transportChunkText,
                  ...encryptedContributorInput
                }
              );
            }
            await upsertEncryptedFieldPayloadWithClient(
              client,
              { userId: relationship.localUserId },
              ownerPrivateReplicaEncryptionProvider,
              {
                sourceTable: "conversation_items",
                sourceId: itemId,
                sourceColumn: "metadata",
                plaintext: contributor.metadata,
                ...encryptedContributorInput
              }
            );
          }
          const eventId = randomUUID();
          const payload = {
            actor: change.event.actor,
            content: change.event.content,
            metadata: change.event.metadata
          };
          await client.query(
            `insert into memory_events (
               id,actor_user_id,owner_user_id,visibility,event_type,source_runtime,
               capture_method,session_id,idempotency_key,source_hash,payload,
               include_in_embedding,include_in_lcm,projection_policy_key,
               projection_policy_revision,token_count,seal_reason,
               source_event_time,source_sequence,captured_at
             ) values (
               $1,$2,$2,'personal',$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,
               $14,$15,$16,$17,$18
             )`,
            [
              eventId,
              relationship.localUserId,
              change.event.eventType,
              input.package.session.sourceRuntime,
              input.package.session.captureMethod,
              sessionId,
              `sync:${relationship.id}:event:${change.originEventId}:${change.revisionHash}`,
              change.revisionHash,
              JSON.stringify({
                contentEncrypted: true,
                encryptedSourceTable: "memory_events",
                encryptedSourceColumn: "payload",
                actor: change.event.actor,
                content: "[koed encrypted memory event]",
                metadata: {}
              }),
              change.event.includeInEmbedding,
              change.event.includeInLcm,
              change.event.projectionPolicyKey,
              change.event.projectionPolicyRevision,
              change.event.tokenCount,
              change.event.sealReason,
              change.event.sourceEventTime,
              change.event.sourceSequence,
              change.event.capturedAt
            ]
          );
          await upsertEncryptedFieldPayloadWithClient(
            client,
            { userId: relationship.localUserId },
            ownerPrivateReplicaEncryptionProvider,
            {
              sourceTable: "memory_events",
              sourceId: eventId,
              sourceColumn: "payload",
              plaintext: payload,
              visibility: "owner_private_replica",
              ownerPrincipalId,
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
        if (summarySnapshotIncluded) {
          const originEventIds = [
            ...new Set(
              input.package.summaryNodes.flatMap(
                (node) => node.sourceOriginEventIds
              )
            )
          ];
          const eventMappingResult = await client.query<Row>(
            `select origin_event_id,local_memory_event_id
               from sync_event_mappings
              where sync_relationship_id=$1
                and active=true
                and origin_event_id=any($2::uuid[])
                and local_memory_event_id is not null`,
            [relationship.id, originEventIds]
          );
          const localEventIdByOrigin = new Map(
            eventMappingResult.rows.map((row) => [
              String(row.origin_event_id),
              String(row.local_memory_event_id)
            ])
          );
          if (localEventIdByOrigin.size !== originEventIds.length) {
            throw new SyncStateConflictError(
              "LCM summary references unavailable synchronized Memory Events"
            );
          }
          const localNodeIdByOrigin = new Map(
            input.package.summaryNodes.map((node) => [
              node.originNodeId,
              crossIdentitySyncDeterministicUuid({
                kind: "synchronized_lcm_summary_node",
                relationshipId: relationship.id,
                originNodeId: node.originNodeId,
                revisionHash: node.revisionHash
              })
            ])
          );
          const requestedOriginNodeIds = new Set(
            input.package.summaryNodes.map((node) => node.originNodeId)
          );
          const previousMappings = await client.query<Row>(
            `select *
               from sync_summary_node_mappings
              where sync_relationship_id=$1
                and active=true
              for update`,
            [relationship.id]
          );
          for (const mapping of previousMappings.rows) {
            if (requestedOriginNodeIds.has(String(mapping.origin_node_id))) {
              continue;
            }
            const previousNodeId = optionalString(mapping.local_memory_node_id);
            if (previousNodeId) {
              await client.query(
                `update memory_nodes
                    set invalidated_at=now(),
                        invalidation_reason='sync_summary_snapshot_replaced',
                        updated_at=now()
                  where id=$1 and invalidated_at is null`,
                [previousNodeId]
              );
              await client.query(
                `update memory_embeddings
                    set invalidated_at=now(),
                        invalidation_reason='sync_summary_snapshot_replaced'
                  where memory_node_id=$1 and invalidated_at is null`,
                [previousNodeId]
              );
              await client.query(
                `update encrypted_field_payloads
                    set invalidated_at=now(),updated_at=now()
                  where source_table='memory_nodes'
                    and source_id=$1
                    and invalidated_at is null`,
                [previousNodeId]
              );
              invalidatedSummaryNodeIds.push(previousNodeId);
            }
            await client.query(
              `update sync_summary_node_mappings
                  set active=false,invalidated_at=now(),updated_at=now()
                where id=$1`,
              [mapping.id]
            );
          }
          for (const node of input.package.summaryNodes) {
            const existing = previousMappings.rows.find(
              (mapping) => String(mapping.origin_node_id) === node.originNodeId
            );
            const existingLocalNodeId = optionalString(
              existing?.local_memory_node_id
            );
            if (
              existing &&
              String(existing.revision_hash) === node.revisionHash &&
              existingLocalNodeId
            ) {
              summaryNodeIds.push(existingLocalNodeId);
              continue;
            }
            const previousNodeId = existingLocalNodeId;
            if (existing) {
              if (previousNodeId) {
                await client.query(
                  `update memory_nodes
                      set invalidated_at=now(),
                          invalidation_reason='sync_summary_revision_replaced',
                          updated_at=now()
                    where id=$1 and invalidated_at is null`,
                  [previousNodeId]
                );
                await client.query(
                  `update memory_embeddings
                      set invalidated_at=now(),
                          invalidation_reason='sync_summary_revision_replaced'
                    where memory_node_id=$1 and invalidated_at is null`,
                  [previousNodeId]
                );
                await client.query(
                  `update encrypted_field_payloads
                      set invalidated_at=now(),updated_at=now()
                    where source_table='memory_nodes'
                      and source_id=$1
                      and invalidated_at is null`,
                  [previousNodeId]
                );
                invalidatedSummaryNodeIds.push(previousNodeId);
              }
              await client.query(
                `update sync_summary_node_mappings
                    set active=false,invalidated_at=now(),updated_at=now()
                  where id=$1`,
                [existing.id]
              );
            }
            const localNodeId = localNodeIdByOrigin.get(node.originNodeId)!;
            const sourceItems =
              node.kind === "leaf"
                ? node.sourceOriginEventIds.map((originEventId, position) => ({
                    kind: "memory_event",
                    sourceTable: "memory_events",
                    sourceId: localEventIdByOrigin.get(originEventId),
                    visibility: "personal",
                    payload: {
                      originEventId,
                      sessionId,
                      syncRelationshipId: relationship.id
                    },
                    position
                  }))
                : node.childOriginNodeIds.map((originNodeId, position) => ({
                    kind: "lcm_child",
                    nodeId: localNodeIdByOrigin.get(originNodeId),
                    payload: {
                      originNodeId,
                      sessionId,
                      syncRelationshipId: relationship.id
                    },
                    position
                  }));
            if (
              sourceItems.some((item) =>
                "sourceId" in item ? !item.sourceId : !item.nodeId
              )
            ) {
              throw new SyncStateConflictError(
                "LCM summary provenance graph is incomplete"
              );
            }
            const localSourceHash = crossIdentitySyncDigest({
              relationshipId: relationship.id,
              originNodeId: node.originNodeId,
              revisionHash: node.revisionHash
            });
            await client.query(
              `insert into memory_nodes (
                 id,owner_user_id,session_id,created_by_user_id,visibility,
                 kind,depth,summary_text,body_text,capture_method,
                 idempotency_key,source_hash,summary_model,
                 summary_prompt_version,lcm_algorithm_version,
                 source_items_json,source_event_count,source_token_estimate,
                 summary_token_estimate,summary_structured_json,
                 summary_structured_schema_version,captured_at,created_at,
                 updated_at
               ) values (
                 $1,$2,$3,$2,'personal',$4,$5,$6,$6,'mcp',$7,$8,$9,$10,$11,
                 $12::jsonb,$13,$14,$15,$16::jsonb,$17,$18::timestamptz,
                 $19::timestamptz,$20::timestamptz
               )`,
              [
                localNodeId,
                relationship.localUserId,
                sessionId,
                node.kind,
                node.depth,
                ENCRYPTED_MEMORY_NODE_TEXT,
                `sync:${relationship.id}:node:${node.originNodeId}:${node.revisionHash}`,
                localSourceHash,
                node.summaryModel,
                node.summaryPromptVersion,
                node.lcmAlgorithmVersion,
                JSON.stringify(ENCRYPTED_MEMORY_NODE_JSON),
                node.sourceEventCount,
                node.sourceTokenEstimate,
                node.summaryTokenEstimate,
                JSON.stringify(ENCRYPTED_MEMORY_NODE_JSON),
                node.summaryStructuredSchemaVersion,
                node.createdAt,
                node.createdAt,
                node.updatedAt
              ]
            );
            for (const [sourceColumn, plaintext] of [
              ["summary_text", node.summaryText],
              ["body_text", node.summaryText],
              ["source_items_json", sourceItems],
              ["summary_structured_json", node.summaryStructuredJson]
            ] as const) {
              await upsertEncryptedFieldPayloadWithClient(
                client,
                { userId: relationship.localUserId },
                ownerPrivateReplicaEncryptionProvider,
                {
                  sourceTable: "memory_nodes",
                  sourceId: localNodeId,
                  sourceColumn,
                  plaintext,
                  visibility: "owner_private_replica",
                  ownerPrincipalId,
                  rowFamily: "memory_node",
                  scope: {
                    tenantId: relationship.localUserId,
                    objectClass: "memory_node"
                  },
                  aad: {
                    syncRelationshipId: relationship.id,
                    originNodeId: node.originNodeId,
                    revisionHash: node.revisionHash
                  }
                }
              );
            }
            await client.query(
              `insert into sync_summary_node_mappings (
                 sync_relationship_id,origin_node_id,revision_hash,
                 local_memory_node_id
               ) values ($1,$2,$3,$4)`,
              [
                relationship.id,
                node.originNodeId,
                node.revisionHash,
                localNodeId
              ]
            );
            summaryNodeIds.push(localNodeId);
          }
          for (const node of input.package.summaryNodes) {
            const localNodeId = localNodeIdByOrigin.get(node.originNodeId)!;
            for (
              let sourceOrder = 0;
              sourceOrder < node.sourceOriginEventIds.length;
              sourceOrder += 1
            ) {
              await client.query(
                `insert into memory_node_sources (
                   memory_node_id,memory_event_id,source_order
                 ) values ($1,$2,$3) on conflict do nothing`,
                [
                  localNodeId,
                  localEventIdByOrigin.get(
                    node.sourceOriginEventIds[sourceOrder]!
                  ),
                  sourceOrder
                ]
              );
            }
            for (
              let childOrder = 0;
              childOrder < node.childOriginNodeIds.length;
              childOrder += 1
            ) {
              await client.query(
                `insert into memory_node_children (
                   parent_memory_node_id,child_memory_node_id,child_order
                 ) values ($1,$2,$3) on conflict do nothing`,
                [
                  localNodeId,
                  localNodeIdByOrigin.get(node.childOriginNodeIds[childOrder]!),
                  childOrder
                ]
              );
            }
          }
        }
        await client.query(
          `update cross_identity_sync_relationships
              set source_cursor = greatest(source_cursor, $2),
                  target_processing_cursor = $2,
                  package_sequence = $3,
                  last_package_id = $4,
                  target_summary_revision_hash = case
                    when $5::text is null then target_summary_revision_hash
                    else $5
                  end,
                  state = 'partially_available',
                  updated_at = now()
            where id=$1`,
          [
            relationship.id,
            input.package.toCursor,
            input.package.packageSequence,
            input.package.packageId,
            summarySnapshotIncluded ? input.package.summaryRevisionHash : null
          ]
        );
        await client.query(
          `update memory_replicas
              set latest_revision = greatest(latest_revision, $2),
                  last_synced_at = now(),
                  updated_at = now()
            where id = $1`,
          [relationship.localReplicaId, input.package.toCursor]
        );
        await client.query(
          `update logical_memories
              set latest_source_revision = greatest(latest_source_revision, $2),
                  updated_at = now()
            where id = $1`,
          [relationship.logicalMemoryId, input.package.toCursor]
        );
        await client.query(
          "update sync_package_upload_sessions set state='completed',completed_at=now(),updated_at=now() where id=$1",
          [input.uploadSessionId]
        );
        await client.query("commit");
        return {
          eventIds,
          invalidatedEventIds,
          summaryNodeIds,
          invalidatedSummaryNodeIds
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async acknowledgeSourceSyncPackage(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const source = await client.query<{
          state: SyncRelationshipState;
          local_user_id: string;
          logical_memory_id: string;
          local_session_id: string;
        }>(
          `select relationship.state,
                  relationship.local_user_id,
                  relationship.logical_memory_id,
                  replica.local_session_id
             from cross_identity_sync_relationships relationship
             join memory_replicas replica
               on replica.id = relationship.local_replica_id
            where relationship.id = $1
              and relationship.side = 'source'
            for update of relationship`,
          [input.relationshipId]
        );
        const relationship = await client.query(
          `update cross_identity_sync_relationships
              set source_cursor=$2,
                  target_processing_cursor=$3,
                  package_sequence=$4,
                  last_package_id=$5,
                  source_summary_revision_hash=case
                    when $6::text is null then source_summary_revision_hash
                    else $6
                  end,
                  state='ready',
                  last_synced_at=now(),
                  stale_after=now()+($7::int*interval '1 second'),
                  updated_at=now()
            where id=$1
              and side='source'
              and state not in ('paused','failed','revoked','purge_pending')
              and revoked_at is null
              and source_cursor<=$2
              and target_processing_cursor<=$3
              and (package_sequence<$4 or
                   (package_sequence=$4 and source_cursor=$2 and last_package_id=$5))
            returning id`,
          [
            input.relationshipId,
            input.sourceCursor,
            input.targetProcessingCursor,
            input.packageSequence,
            input.packageId,
            input.summaryRevisionHash,
            input.staleAfterSeconds
          ]
        );
        if (!relationship.rows[0]) {
          throw new SyncStateConflictError(
            "Source sync relationship can no longer acknowledge this package"
          );
        }
        const acknowledgedSource = source.rows[0];
        if (
          acknowledgedSource?.state === "processing" &&
          (!acknowledgedSource.local_user_id ||
            !acknowledgedSource.logical_memory_id ||
            !acknowledgedSource.local_session_id)
        ) {
          throw new SyncStateConflictError(
            "Source sync relationship is not bound to Personal Memory"
          );
        }
        if (acknowledgedSource?.state === "processing") {
          await appendCollaborationOutboxEventWithClient(client, {
            family: "personal_memory_changed",
            scope: "personal",
            personalOwnerUserId: acknowledgedSource.local_user_id,
            teamId: null,
            teamWorkspaceId: null,
            threadId: null,
            messageId: null,
            shareGrantId: null,
            logicalMemoryId: acknowledgedSource.logical_memory_id,
            resourceType: "personal_memory_entry",
            resourceId: acknowledgedSource.local_session_id,
            actorPrincipalId: acknowledgedSource.local_user_id,
            mutationId: crossIdentitySyncDeterministicUuid({
              kind: "personal_memory_changed",
              relationshipId: input.relationshipId,
              packageId: input.packageId,
              sourceCursor: input.sourceCursor,
              targetProcessingCursor: input.targetProcessingCursor
            })
          });
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
        "update sync_package_upload_sessions upload set state='uploaded',uploaded_at=coalesce(uploaded_at,now()),updated_at=now() from cross_identity_sync_relationships relationship where upload.sync_relationship_id=relationship.id and relationship.id=$1 and relationship.side='source' and relationship.state<>'paused' and relationship.revoked_at is null and upload.protocol_package_id=$2 and upload.state in ('created','uploading','uploaded')",
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
          `update ${queueTable} set state='pending',attempt_count=0,available_at=now(),locked_at=null,claim_token=null,lease_expires_at=null,processed_at=null,last_error_message=null,updated_at=now() where sync_relationship_id=$1 and state in ('pending','failed') returning id`,
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
          `update cross_identity_sync_relationships relationship set state='revoked',paused_at=null,state_before_pause=null,revoked_at=now(),revoked_by_user_id=$2,revocation_reason=nullif(trim($3),''),revocation_id=$4,revocation_sequence=package_sequence+1,revocation_origin=side,updated_at=now() where id=$1 and local_user_id=$2 and revoked_at is null and ${relationshipCredentialClause("relationship", 5)} returning relationship.*`,
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
          `update cross_identity_sync_relationships relationship set state='revoked',paused_at=null,state_before_pause=null,revoked_at=coalesce(revoked_at,now()),revoked_by_user_id=$2,revocation_reason=coalesce(revocation_reason,'remote_sync_revoked'),revocation_id=coalesce(revocation_id,$3),revocation_sequence=greatest(coalesce(revocation_sequence,0),$4),revocation_origin='source',updated_at=now() where id=$1 and local_user_id=$2 and side='target' and ${relationshipCredentialClause("relationship", 5)} and (revocation_id is null or revocation_id=$3) returning relationship.*`,
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
        const relationship = result.rows[0] as Row;
        const affectedGrants = await client.query<Row>(
          `select g.id,g.team_id,g.team_workspace_id,g.logical_memory_id
             from team_session_share_grants g
            where g.logical_memory_id=$1
              and g.remote_replica_id=$2
              and g.lifecycle='active'
            for update`,
          [relationship.logical_memory_id, relationship.local_replica_id]
        );
        if (affectedGrants.rows.length > 0) {
          await client.query(
            `update team_memory_representations
                set state='stale',stale_at=coalesce(stale_at,now()),
                    freshness_evaluated_at=now(),
                    record_version=record_version+1,updated_at=now()
              where share_grant_id=any($1::uuid[])
                and state='available'`,
            [affectedGrants.rows.map((grant) => grant.id)]
          );
          for (const grant of affectedGrants.rows) {
            await appendCollaborationOutboxEventWithClient(client, {
              family: "representation_changed",
              scope: "team",
              personalOwnerUserId: null,
              teamId: String(grant.team_id),
              teamWorkspaceId: String(grant.team_workspace_id),
              threadId: null,
              messageId: null,
              shareGrantId: String(grant.id),
              logicalMemoryId: String(grant.logical_memory_id),
              resourceType: "team_session_share_grant",
              resourceId: String(grant.id),
              actorPrincipalId: actor.userId,
              mutationId: crossIdentitySyncDeterministicUuid({
                kind: "sync_revoked_representation_stale",
                relationshipId: input.syncRelationshipId,
                revocationId: input.revocationId,
                shareGrantId: String(grant.id)
              })
            });
          }
        }
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
