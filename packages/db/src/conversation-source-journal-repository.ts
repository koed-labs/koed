import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import {
  calculateConversationSourceClosureDigest,
  CONVERSATION_SOURCE_DOWNLOAD_AUTHORIZATION_TTL_MS,
  calculateConversationSourceReplicationContentDigest,
  calculateConversationSourceReplicationManifestDigest,
  calculateConversationSourceRootDigest,
  parseSignedConversationSourceClosureManifest,
  parseConversationSourceReplicationManifest,
  verifyConversationSourceClosureManifestSignature,
  verifyConversationSourceReplicationManifestForAcceptance,
  decryptEnvelopeToUtf8,
  type ConversationSourceOriginKeyRegistration,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type SignedConversationSourceClosureManifest
} from "@koed/shared";
import type pg from "pg";
import { createCapturedSessionRepository } from "./captured-session-repository.js";
import type {
  ActorContext,
  CapturedSessionRecord,
  ConversationSourceArtifactLifecycle,
  ConversationSourceArtifactRecord,
  ConversationSourceConsumerCursorRecord,
  ConversationSourceConsumerKind,
  ConversationSourceDownloadAuthorizationRecord,
  ClaimedConversationSourceRestoreJob,
  ConversationSourceRestoreJobRecord,
  ConversationSourceOriginKeyStatus,
  ConversationSourceReplicaRole,
  ConversationSourceReplicaSegmentAcceptance,
  ConversationSourceReplicationOutboxClaimRecord,
  ConversationSourceReplicationOutboxRecord,
  ConversationSourceReplicationAuthorizationBasis,
  ConversationSourceReplicationOutboxState,
  ConversationSourceSegmentRecord,
  PersonalSourceReplicationMode,
  PersonalSourceReplicationPolicyRecord,
  SourceRuntime
} from "./types.js";

export interface EnsureConversationSourceArtifactInput {
  sessionId: string;
  logicalSourceId: string;
  sourceGenerationId: string;
  replicaRole: ConversationSourceReplicaRole;
  sourceKind: string;
  sourceRuntime: SourceRuntime;
  externalSessionId: string;
  sourceFingerprint: string;
  artifactFormat: string;
  artifactFormatVersion: number;
  sourceAdapterVersion: string;
  journalStartOffset: number;
  journalStartLine: number;
  liveStartOffset: number;
  liveStartLine: number;
  currentSourceLength: number;
  sourceCreatedAt: string;
  sourceModifiedAt?: string;
  storageProvider: string;
  storagePrefix: string;
  originDeploymentId: string;
  originDeviceId: string;
  originKeyId: string;
  originPublicKey: string;
  priorGenerationClosure?: Record<string, unknown>;
  redactedSourceLabel: string;
}

export interface AppendConversationSourceSegmentInput {
  artifactId: string;
  expectedProviderOffset: number;
  expectedProviderLine: number;
  sourceEndOffset: number;
  sourceEndLine: number;
  plaintextDigest: string;
  ciphertextDigest?: string;
  plaintextSize: number;
  storedSize: number;
  storageKey: string;
  storageProvider: string;
  encryptionEnvelope?: Record<string, unknown>;
  signedManifest: Record<string, unknown>;
  originSignature: string;
  manifestDigest: string;
  previousContentDigest: string | null;
  contentDigest: string;
  currentSourceLength: number;
  sourceModifiedAt?: string;
}

export interface AcceptConversationSourceReplicaSegmentInput {
  artifactId: string;
  segmentIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  sourceStartLine: number;
  sourceEndLine: number;
  plaintextDigest: string;
  ciphertextDigest: string;
  plaintextSize: number;
  storedSize: number;
  storageKey: string;
  storageProvider: string;
  encryptionEnvelope: Record<string, unknown>;
  signedManifest: Record<string, unknown>;
  originSignature: string;
  manifestDigest: string;
  previousContentDigest: string | null;
  contentDigest: string;
  currentSourceLength: number;
  sourceModifiedAt?: string;
}

export interface FinalizeConversationSourceArtifactInput {
  artifactId: string;
  signedClosure: SignedConversationSourceClosureManifest;
}

export type RegisterConversationSourceReplicaGenerationInput =
  EnsureConversationSourceArtifactInput & {
    replicaRole: Exclude<ConversationSourceReplicaRole, "origin_local">;
  };

export type EnsureConversationSourceSessionInput = Parameters<
  ReturnType<typeof createCapturedSessionRepository>["createCapturedSession"]
>[1];

type ArtifactRow = {
  id: string;
  owner_user_id: string;
  session_id: string;
  logical_source_id: string;
  source_generation_id: string;
  replica_role: ConversationSourceReplicaRole;
  source_kind: string;
  source_runtime: SourceRuntime;
  external_session_id: string;
  source_fingerprint: string;
  artifact_format: string;
  artifact_format_version: number;
  source_adapter_version: string;
  lifecycle: ConversationSourceArtifactLifecycle;
  journal_start_offset: string | number;
  journal_start_line: number;
  live_start_offset: string | number;
  live_start_line: number;
  provider_cursor_offset: string | number;
  provider_cursor_line: number;
  current_source_length: string | number;
  current_journal_sequence: number;
  source_created_at: Date;
  source_modified_at: Date | null;
  storage_provider: string;
  storage_prefix: string;
  closure_hash: string | null;
  closure_manifest: Record<string, unknown> | null;
  closure_signature: string | null;
  origin_deployment_id: string;
  origin_device_id: string;
  origin_key_id: string;
  origin_public_key: string;
  origin_key_status: ConversationSourceOriginKeyStatus;
  prior_generation_closure: Record<string, unknown> | null;
  redacted_source_label: string;
  created_at: Date;
  updated_at: Date;
  finalized_at: Date | null;
};

type SegmentRow = {
  id: string;
  artifact_id: string;
  segment_index: number;
  source_start_offset: string | number;
  source_end_offset: string | number;
  source_start_line: number;
  source_end_line: number;
  plaintext_digest: string;
  ciphertext_digest: string | null;
  plaintext_size: string | number;
  stored_size: string | number;
  storage_key: string;
  storage_provider: string;
  encryption_envelope: Record<string, unknown> | null;
  signed_manifest: Record<string, unknown>;
  origin_signature: string;
  manifest_digest: string;
  previous_content_digest: string | null;
  content_digest: string;
  created_at: Date;
  sealed_at: Date;
};

type CursorRow = {
  artifact_id: string;
  consumer_kind: ConversationSourceConsumerKind;
  segment_index: number;
  source_offset: string | number;
  source_line: number;
  last_verified_digest: string | null;
  parser_state: Record<string, unknown>;
  failure_code: string | null;
  retry_count: number;
  next_attempt_at: Date | null;
  updated_at: Date;
};

type PolicyRow = {
  owner_user_id: string;
  enabled: boolean;
  target_upstream_id: string | null;
  mode: PersonalSourceReplicationMode;
  effective_from: Date | null;
  created_at: Date;
  updated_at: Date;
};

type OutboxRow = {
  id: string;
  owner_user_id: string;
  artifact_id: string;
  operation_kind: "registration" | "segment" | "closure";
  segment_id: string | null;
  target_upstream_id: string;
  mode: PersonalSourceReplicationMode;
  authorization_basis: ConversationSourceReplicationAuthorizationBasis;
  state: ConversationSourceReplicationOutboxState;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
  succeeded_at: Date | null;
  quarantined_at: Date | null;
};

type DownloadAuthorizationRow = {
  id: string;
  owner_user_id: string;
  device_credential_id: string;
  artifact_id: string;
  recipient_key: Record<string, unknown>;
  first_segment_index: number;
  last_segment_index: number;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revocation_reason: string | null;
};

type RestoreJobRow = {
  id: string;
  owner_user_id: string;
  upstream_backend_id: string;
  source_generation_id: string;
  target_deployment_id: string;
  recipient_key_id: string;
  recipient_key_version: number;
  action_grant_id: string;
  state: ConversationSourceRestoreJobRecord["state"];
  remote_authorization_id: string | null;
  encrypted_capability: Record<string, unknown> | null;
  registration: Record<string, unknown> | null;
  source_descriptor: Record<string, unknown> | null;
  source_closure: Record<string, unknown> | null;
  next_segment_index: number;
  last_segment_index: number | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

const statusError = (
  message: string,
  statusCode: number,
  code?: string
): Error & { statusCode: number; code?: string } =>
  Object.assign(new Error(message), {
    statusCode,
    ...(code ? { code } : {})
  });

const assertStrictJsonRecord = (
  value: Record<string, unknown>,
  name: string
): void => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    throw statusError(`${name} must be a non-empty JSON record`, 400);
  }
  const visit = (candidate: unknown): void => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (typeof candidate === "object") {
      for (const nested of Object.values(
        candidate as Record<string, unknown>
      )) {
        visit(nested);
      }
      return;
    }
    throw statusError(`${name} contains a non-JSON value`, 400);
  };
  visit(value);
};

const assertSha256 = (value: string, name: string): void => {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw statusError(`${name} must be a lowercase SHA-256 digest`, 400);
  }
};

const assertSignedSegmentMetadata = (input: {
  plaintextDigest: string;
  ciphertextDigest?: string;
  signedManifest: Record<string, unknown>;
  originSignature: string;
  manifestDigest: string;
  previousContentDigest: string | null;
  contentDigest: string;
  encryptionEnvelope?: Record<string, unknown>;
}): void => {
  assertStrictJsonRecord(input.signedManifest, "signedManifest");
  if (input.encryptionEnvelope) {
    assertStrictJsonRecord(input.encryptionEnvelope, "encryptionEnvelope");
  }
  assertSha256(input.plaintextDigest, "plaintextDigest");
  if (input.ciphertextDigest) {
    assertSha256(input.ciphertextDigest, "ciphertextDigest");
  }
  assertSha256(input.manifestDigest, "manifestDigest");
  if (input.previousContentDigest) {
    assertSha256(input.previousContentDigest, "previousContentDigest");
  }
  assertSha256(input.contentDigest, "contentDigest");
  if (!/^[A-Za-z0-9_-]{86}$/.test(input.originSignature)) {
    throw statusError("originSignature must be a raw Ed25519 signature", 400);
  }
};

const mapArtifact = (row: ArtifactRow): ConversationSourceArtifactRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  sessionId: row.session_id,
  logicalSourceId: row.logical_source_id,
  sourceGenerationId: row.source_generation_id,
  replicaRole: row.replica_role,
  sourceKind: row.source_kind,
  sourceRuntime: row.source_runtime,
  externalSessionId: row.external_session_id,
  sourceFingerprint: row.source_fingerprint,
  artifactFormat: row.artifact_format,
  artifactFormatVersion: row.artifact_format_version,
  sourceAdapterVersion: row.source_adapter_version,
  lifecycle: row.lifecycle,
  journalStartOffset: Number(row.journal_start_offset),
  journalStartLine: row.journal_start_line,
  liveStartOffset: Number(row.live_start_offset),
  liveStartLine: row.live_start_line,
  providerCursorOffset: Number(row.provider_cursor_offset),
  providerCursorLine: row.provider_cursor_line,
  currentSourceLength: Number(row.current_source_length),
  currentJournalSequence: row.current_journal_sequence,
  sourceCreatedAt: row.source_created_at.toISOString(),
  sourceModifiedAt: row.source_modified_at?.toISOString() ?? null,
  storageProvider: row.storage_provider,
  storagePrefix: row.storage_prefix,
  closureHash: row.closure_hash,
  closureManifest: row.closure_manifest,
  closureSignature: row.closure_signature,
  originDeploymentId: row.origin_deployment_id,
  originDeviceId: row.origin_device_id,
  originKeyId: row.origin_key_id,
  originPublicKey: row.origin_public_key,
  originKeyStatus: row.origin_key_status,
  priorGenerationClosure: row.prior_generation_closure,
  redactedSourceLabel: row.redacted_source_label,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  finalizedAt: row.finalized_at?.toISOString() ?? null
});

const mapSegment = (row: SegmentRow): ConversationSourceSegmentRecord => ({
  id: row.id,
  artifactId: row.artifact_id,
  segmentIndex: row.segment_index,
  sourceStartOffset: Number(row.source_start_offset),
  sourceEndOffset: Number(row.source_end_offset),
  sourceStartLine: row.source_start_line,
  sourceEndLine: row.source_end_line,
  plaintextDigest: row.plaintext_digest,
  ciphertextDigest: row.ciphertext_digest,
  plaintextSize: Number(row.plaintext_size),
  storedSize: Number(row.stored_size),
  storageKey: row.storage_key,
  storageProvider: row.storage_provider,
  encryptionEnvelope: row.encryption_envelope,
  signedManifest: row.signed_manifest,
  originSignature: row.origin_signature,
  manifestDigest: row.manifest_digest,
  previousContentDigest: row.previous_content_digest,
  contentDigest: row.content_digest,
  createdAt: row.created_at.toISOString(),
  sealedAt: row.sealed_at.toISOString()
});

const mapCursor = (row: CursorRow): ConversationSourceConsumerCursorRecord => ({
  artifactId: row.artifact_id,
  consumerKind: row.consumer_kind,
  segmentIndex: row.segment_index,
  sourceOffset: Number(row.source_offset),
  sourceLine: row.source_line,
  lastVerifiedDigest: row.last_verified_digest,
  parserState: row.parser_state,
  failureCode: row.failure_code,
  retryCount: row.retry_count,
  nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
  updatedAt: row.updated_at.toISOString()
});

const mapPolicy = (row: PolicyRow): PersonalSourceReplicationPolicyRecord => ({
  ownerUserId: row.owner_user_id,
  enabled: row.enabled,
  targetUpstreamId: row.target_upstream_id,
  mode: row.mode,
  effectiveFrom: row.effective_from?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

const mapOutbox = (
  row: OutboxRow
): ConversationSourceReplicationOutboxRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  artifactId: row.artifact_id,
  operationKind: row.operation_kind,
  segmentId: row.segment_id,
  targetUpstreamId: row.target_upstream_id,
  mode: row.mode,
  authorizationBasis: row.authorization_basis,
  state: row.state,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  nextAttemptAt: row.next_attempt_at.toISOString(),
  leaseOwner: row.lease_owner,
  leaseToken: row.lease_token,
  leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
  lastErrorCode: row.last_error_code,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  succeededAt: row.succeeded_at?.toISOString() ?? null,
  quarantinedAt: row.quarantined_at?.toISOString() ?? null
});

const signedSegmentMatches = (
  row: SegmentRow,
  input: {
    segmentIndex: number;
    sourceStartOffset: number;
    sourceEndOffset: number;
    sourceStartLine: number;
    sourceEndLine: number;
    plaintextDigest: string;
    plaintextSize: number;
    signedManifest: Record<string, unknown>;
    originSignature: string;
    manifestDigest: string;
    previousContentDigest: string | null;
    contentDigest: string;
  }
): boolean =>
  row.segment_index === input.segmentIndex &&
  Number(row.source_start_offset) === input.sourceStartOffset &&
  Number(row.source_end_offset) === input.sourceEndOffset &&
  row.source_start_line === input.sourceStartLine &&
  row.source_end_line === input.sourceEndLine &&
  row.plaintext_digest === input.plaintextDigest &&
  Number(row.plaintext_size) === input.plaintextSize &&
  row.origin_signature === input.originSignature &&
  row.manifest_digest === input.manifestDigest &&
  row.previous_content_digest === input.previousContentDigest &&
  row.content_digest === input.contentDigest &&
  isDeepStrictEqual(row.signed_manifest, input.signedManifest);

const assertSignedSegmentBinding = (
  artifact: ArtifactRow,
  input: {
    segmentIndex: number;
    sourceStartOffset: number;
    sourceEndOffset: number;
    sourceStartLine: number;
    sourceEndLine: number;
    plaintextDigest: string;
    plaintextSize: number;
    signedManifest: Record<string, unknown>;
    originSignature: string;
    manifestDigest: string;
    previousContentDigest: string | null;
    contentDigest: string;
  }
): void => {
  const manifest = parseConversationSourceReplicationManifest(
    input.signedManifest
  );
  const signedManifest = {
    manifest,
    signature: input.originSignature
  };
  const registration: ConversationSourceOriginKeyRegistration = {
    protocol: manifest.protocol,
    logicalSourceId: artifact.logical_source_id,
    sourceGenerationId: artifact.source_generation_id,
    originKeyId: artifact.origin_key_id,
    publicKey: artifact.origin_public_key,
    lifecycle: artifact.origin_key_status,
    sourceCreatedAt: artifact.source_created_at.toISOString(),
    priorGenerationClosure:
      artifact.prior_generation_closure as ConversationSourceOriginKeyRegistration["priorGenerationClosure"]
  };
  const signatureValid = (() => {
    try {
      return verifyConversationSourceReplicationManifestForAcceptance(
        signedManifest,
        registration
      );
    } catch {
      return false;
    }
  })();
  if (
    !signatureValid ||
    manifest.segmentIndex !== input.segmentIndex ||
    manifest.startByteCursor !== input.sourceStartOffset ||
    manifest.endByteCursor !== input.sourceEndOffset ||
    manifest.startItemCursor !== input.sourceStartLine ||
    manifest.endItemCursor !== input.sourceEndLine ||
    manifest.plaintextDigest !== input.plaintextDigest ||
    manifest.previousContentDigest !== input.previousContentDigest ||
    manifest.sourceFormat !== artifact.artifact_format ||
    manifest.adapterVersion !== artifact.source_adapter_version ||
    input.plaintextSize !== input.sourceEndOffset - input.sourceStartOffset ||
    calculateConversationSourceReplicationManifestDigest(manifest) !==
      input.manifestDigest ||
    calculateConversationSourceReplicationContentDigest(signedManifest) !==
      input.contentDigest
  ) {
    throw statusError(
      "Conversation source signed segment binding is invalid",
      409,
      "conversation_source_signed_segment_invalid"
    );
  }
};

const mapDownloadAuthorization = (
  row: DownloadAuthorizationRow
): ConversationSourceDownloadAuthorizationRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  deviceCredentialId: row.device_credential_id,
  artifactId: row.artifact_id,
  recipientKey: row.recipient_key,
  firstSegmentIndex: row.first_segment_index,
  lastSegmentIndex: row.last_segment_index,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  lastUsedAt: row.last_used_at?.toISOString() ?? null,
  revokedAt: row.revoked_at?.toISOString() ?? null,
  revocationReason: row.revocation_reason
});

const mapRestoreJob = (
  row: RestoreJobRow
): ConversationSourceRestoreJobRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  upstreamBackendId: row.upstream_backend_id,
  sourceGenerationId: row.source_generation_id,
  targetDeploymentId: row.target_deployment_id,
  recipientKeyId: row.recipient_key_id,
  recipientKeyVersion: row.recipient_key_version,
  actionGrantId: row.action_grant_id,
  state: row.state,
  remoteAuthorizationId: row.remote_authorization_id,
  registration: row.registration,
  sourceDescriptor: row.source_descriptor,
  sourceClosure: row.source_closure,
  nextSegmentIndex: row.next_segment_index,
  lastSegmentIndex: row.last_segment_index,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  nextAttemptAt: row.next_attempt_at.toISOString(),
  leaseOwner: row.lease_owner,
  leaseToken: row.lease_token,
  leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
  lastErrorCode: row.last_error_code,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  completedAt: row.completed_at?.toISOString() ?? null
});

const RESTORE_JOB_COLUMNS = `
  id, owner_user_id, upstream_backend_id, source_generation_id,
  target_deployment_id, recipient_key_id, recipient_key_version,
  action_grant_id, state, remote_authorization_id, encrypted_capability,
  registration, source_descriptor, source_closure, next_segment_index, last_segment_index,
  attempts, max_attempts, next_attempt_at, lease_owner, lease_token,
  lease_expires_at, last_error_code,
  created_at, updated_at, completed_at
`;

const ARTIFACT_COLUMNS = `
  id, owner_user_id, session_id, logical_source_id, source_generation_id,
  replica_role, source_kind, source_runtime, external_session_id, source_fingerprint,
  artifact_format, artifact_format_version, source_adapter_version, lifecycle,
  journal_start_offset, journal_start_line, live_start_offset, live_start_line,
  provider_cursor_offset, provider_cursor_line,
  current_source_length, current_journal_sequence, source_created_at,
  source_modified_at, storage_provider, storage_prefix, closure_hash,
  closure_manifest, closure_signature,
  origin_deployment_id, origin_device_id, origin_key_id, origin_public_key,
  origin_key_status, prior_generation_closure, redacted_source_label,
  created_at, updated_at, finalized_at
`;

const ARTIFACT_SELECT_COLUMNS = `
  artifact.id, artifact.owner_user_id, artifact.session_id,
  artifact.logical_source_id, artifact.source_generation_id,
  artifact.replica_role, artifact.source_kind, artifact.external_session_id,
  artifact.source_runtime,
  artifact.source_fingerprint, artifact.artifact_format,
  artifact.artifact_format_version, artifact.source_adapter_version,
  artifact.lifecycle,
  artifact.journal_start_offset, artifact.journal_start_line,
  artifact.live_start_offset, artifact.live_start_line,
  artifact.provider_cursor_offset, artifact.provider_cursor_line,
  artifact.current_source_length, artifact.current_journal_sequence,
  artifact.source_created_at, artifact.source_modified_at,
  artifact.storage_provider, artifact.storage_prefix, artifact.closure_hash,
  artifact.closure_manifest, artifact.closure_signature,
  artifact.origin_deployment_id, artifact.origin_device_id,
  artifact.origin_key_id, artifact.origin_public_key,
  artifact.origin_key_status, artifact.prior_generation_closure,
  artifact.redacted_source_label, artifact.created_at, artifact.updated_at,
  artifact.finalized_at
`;

const SEGMENT_COLUMNS = `
  id, artifact_id, segment_index, source_start_offset, source_end_offset,
  source_start_line, source_end_line, plaintext_digest, ciphertext_digest,
  plaintext_size, stored_size, storage_key, storage_provider,
  encryption_envelope, signed_manifest, origin_signature, manifest_digest,
  previous_content_digest, content_digest, created_at, sealed_at
`;

const SEGMENT_SELECT_COLUMNS = `
  segment.id, segment.artifact_id, segment.segment_index,
  segment.source_start_offset, segment.source_end_offset,
  segment.source_start_line, segment.source_end_line,
  segment.plaintext_digest, segment.ciphertext_digest,
  segment.plaintext_size, segment.stored_size, segment.storage_key,
  segment.storage_provider, segment.encryption_envelope,
  segment.signed_manifest, segment.origin_signature, segment.manifest_digest,
  segment.previous_content_digest, segment.content_digest,
  segment.created_at, segment.sealed_at
`;

const CURSOR_COLUMNS = `
  artifact_id, consumer_kind, segment_index, source_offset, source_line,
  last_verified_digest, parser_state, failure_code, retry_count,
  next_attempt_at, updated_at
`;

const CURSOR_SELECT_COLUMNS = `
  cursor.artifact_id, cursor.consumer_kind, cursor.segment_index,
  cursor.source_offset, cursor.source_line, cursor.last_verified_digest,
  cursor.parser_state, cursor.failure_code, cursor.retry_count,
  cursor.next_attempt_at, cursor.updated_at
`;

const POLICY_COLUMNS = `
  owner_user_id, enabled, target_upstream_id, mode, effective_from,
  created_at, updated_at
`;

const OUTBOX_COLUMNS = `
  id, owner_user_id, artifact_id, operation_kind, segment_id,
  target_upstream_id, mode, authorization_basis,
  state, attempts, max_attempts, next_attempt_at, lease_owner, lease_token,
  lease_expires_at, last_error_code, created_at, updated_at, succeeded_at,
  quarantined_at
`;

const OUTBOX_SELECT_COLUMNS = `
  outbox.id, outbox.owner_user_id, outbox.artifact_id,
  outbox.operation_kind, outbox.segment_id, outbox.target_upstream_id,
  outbox.mode, outbox.authorization_basis, outbox.state, outbox.attempts, outbox.max_attempts,
  outbox.next_attempt_at, outbox.lease_owner, outbox.lease_token,
  outbox.lease_expires_at, outbox.last_error_code, outbox.created_at,
  outbox.updated_at, outbox.succeeded_at, outbox.quarantined_at
`;

const notifyConversationSourceReplication = (
  client: pg.Pool | pg.PoolClient,
  reason: "upload" | "restore" | "materialize" | "retry",
  sourceGenerationId?: string
) =>
  client.query(
    `select pg_notify(
       'koed_conversation_source_replication',
       json_strip_nulls(
         json_build_object(
           'reason', $1::text,
           'sourceGenerationId', $2::uuid
         )
       )::text
     )`,
    [reason, sourceGenerationId ?? null]
  );

const ensureConversationSourceArtifactWithClient = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  input: EnsureConversationSourceArtifactInput
): Promise<ConversationSourceArtifactRecord> => {
  if (input.priorGenerationClosure) {
    assertStrictJsonRecord(
      input.priorGenerationClosure,
      "priorGenerationClosure"
    );
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.originPublicKey)) {
    throw statusError("originPublicKey must be a raw Ed25519 public key", 400);
  }
  const session = await client.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from sessions
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
          and invalidated_at is null
          and personal_deleted_at is null
          and $3 in (external_session_id, external_thread_id)
      ) as exists
    `,
    [actor.userId, input.sessionId, input.externalSessionId]
  );
  if (session.rows[0]?.exists !== true) {
    throw statusError("Captured Session not found for source artifact", 404);
  }
  let result: pg.QueryResult<ArtifactRow>;
  try {
    result = await client.query<ArtifactRow>(
      `
        insert into conversation_source_artifacts (
          owner_user_id, session_id, logical_source_id, source_generation_id,
          replica_role, source_kind, external_session_id, source_fingerprint,
          artifact_format, artifact_format_version, source_adapter_version,
          journal_start_offset,
          journal_start_line, live_start_offset, live_start_line,
          provider_cursor_offset, provider_cursor_line, current_source_length,
          source_created_at, source_modified_at, storage_provider,
          storage_prefix, origin_deployment_id, origin_device_id, origin_key_id,
          origin_public_key, prior_generation_closure, redacted_source_label,
          source_runtime
        )
        select
          $1, s.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $12, $13, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
          $26, $27
        from sessions s
        where s.id = $2
          and s.owner_user_id = $1
          and s.visibility = 'personal'
          and s.invalidated_at is null
          and s.personal_deleted_at is null
        on conflict (owner_user_id, logical_source_id, source_generation_id)
        do update set
          current_source_length = greatest(
            conversation_source_artifacts.current_source_length,
            excluded.current_source_length
          ),
          source_modified_at = coalesce(
            excluded.source_modified_at,
            conversation_source_artifacts.source_modified_at
          ),
          redacted_source_label = excluded.redacted_source_label,
          updated_at = now()
        where conversation_source_artifacts.session_id = excluded.session_id
          and conversation_source_artifacts.replica_role = excluded.replica_role
          and conversation_source_artifacts.source_kind = excluded.source_kind
          and conversation_source_artifacts.source_runtime =
            excluded.source_runtime
          and conversation_source_artifacts.external_session_id =
            excluded.external_session_id
          and conversation_source_artifacts.source_fingerprint =
            excluded.source_fingerprint
          and conversation_source_artifacts.artifact_format =
            excluded.artifact_format
          and conversation_source_artifacts.artifact_format_version =
            excluded.artifact_format_version
          and conversation_source_artifacts.source_adapter_version =
            excluded.source_adapter_version
          and conversation_source_artifacts.journal_start_offset =
            excluded.journal_start_offset
          and conversation_source_artifacts.journal_start_line =
            excluded.journal_start_line
          and conversation_source_artifacts.live_start_offset =
            excluded.live_start_offset
          and conversation_source_artifacts.live_start_line =
            excluded.live_start_line
          and conversation_source_artifacts.source_created_at =
            excluded.source_created_at
          and conversation_source_artifacts.storage_provider =
            excluded.storage_provider
          and conversation_source_artifacts.storage_prefix =
            excluded.storage_prefix
          and conversation_source_artifacts.origin_deployment_id =
            excluded.origin_deployment_id
          and conversation_source_artifacts.origin_device_id =
            excluded.origin_device_id
          and conversation_source_artifacts.origin_key_id =
            excluded.origin_key_id
          and conversation_source_artifacts.origin_public_key =
            excluded.origin_public_key
          and conversation_source_artifacts.origin_key_status = 'active'
          and conversation_source_artifacts.prior_generation_closure
            is not distinct from excluded.prior_generation_closure
        returning ${ARTIFACT_COLUMNS}
      `,
      [
        actor.userId,
        input.sessionId,
        input.logicalSourceId,
        input.sourceGenerationId,
        input.replicaRole,
        input.sourceKind,
        input.externalSessionId,
        input.sourceFingerprint,
        input.artifactFormat,
        input.artifactFormatVersion,
        input.sourceAdapterVersion,
        input.journalStartOffset,
        input.journalStartLine,
        input.liveStartOffset,
        input.liveStartLine,
        input.currentSourceLength,
        input.sourceCreatedAt,
        input.sourceModifiedAt ?? null,
        input.storageProvider,
        input.storagePrefix,
        input.originDeploymentId,
        input.originDeviceId,
        input.originKeyId,
        input.originPublicKey,
        input.priorGenerationClosure ?? null,
        input.redactedSourceLabel,
        input.sourceRuntime
      ]
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw statusError("Conversation source identity conflict", 409);
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) {
    const pinned = await client.query<{
      origin_key_status: ConversationSourceOriginKeyStatus;
    }>(
      `select origin_key_status
         from conversation_source_artifacts
        where owner_user_id = $1
          and logical_source_id = $2
          and source_generation_id = $3
        limit 1`,
      [actor.userId, input.logicalSourceId, input.sourceGenerationId]
    );
    const keyStatus = pinned.rows[0]?.origin_key_status;
    if (keyStatus === "lost" || keyStatus === "revoked") {
      throw statusError(
        `Conversation source origin key is ${keyStatus}`,
        409,
        `conversation_source_origin_key_${keyStatus}`
      );
    }
    throw statusError("Conversation source identity conflict", 409);
  }
  if (row.replica_role === "origin_local") {
    const registration = await client.query(
      `insert into conversation_source_replication_outbox (
         owner_user_id, artifact_id, operation_kind, segment_id,
         target_upstream_id, mode
       )
       select $1, $2, 'registration', null,
              policy.target_upstream_id, policy.mode
         from personal_source_replication_policies policy
        where policy.owner_user_id = $1
          and policy.enabled = true
          and policy.target_upstream_id is not null
          and policy.effective_from <= $3
       on conflict do nothing`,
      [actor.userId, row.id, row.source_created_at]
    );
    if ((registration.rowCount ?? 0) > 0) {
      await notifyConversationSourceReplication(
        client,
        "upload",
        row.source_generation_id
      );
    }
  }
  return mapArtifact(row);
};

export interface ConversationSourceJournalRepository {
  ensureConversationSourceArtifact(
    actor: ActorContext,
    input: EnsureConversationSourceArtifactInput
  ): Promise<ConversationSourceArtifactRecord>;
  ensureConversationSourceArtifactForCapturedSession(
    actor: ActorContext,
    input: {
      session: EnsureConversationSourceSessionInput;
      artifact: Omit<EnsureConversationSourceArtifactInput, "sessionId">;
    }
  ): Promise<{
    session: CapturedSessionRecord;
    artifact: ConversationSourceArtifactRecord;
  }>;
  registerConversationSourceReplicaGeneration(
    actor: ActorContext,
    input: RegisterConversationSourceReplicaGenerationInput
  ): Promise<ConversationSourceArtifactRecord>;
  createConversationSourceSuccessorGeneration(
    actor: ActorContext,
    input: {
      parentArtifactId: string;
      expectedParentClosureHash: string;
      sourceGenerationId: string;
      originDeploymentId: string;
      originDeviceId: string;
      originKeyId: string;
      originPublicKey: string;
      sourceCreatedAt: string;
      storageProvider: string;
      storagePrefix: string;
    }
  ): Promise<{
    artifact: ConversationSourceArtifactRecord;
    replayed: boolean;
  }>;
  getConversationSourceArtifact(
    actor: ActorContext,
    artifactId: string
  ): Promise<ConversationSourceArtifactRecord | null>;
  getConversationSourceArtifactByIdentity(
    actor: ActorContext,
    input: {
      logicalSourceId: string;
      sourceGenerationId: string;
    }
  ): Promise<ConversationSourceArtifactRecord | null>;
  getConversationSourceArtifactByProviderIdentity(
    actor: ActorContext,
    input: { sourceKind: string; externalSessionId: string }
  ): Promise<ConversationSourceArtifactRecord | null>;
  getConversationSourceArtifactByGeneration(
    actor: ActorContext,
    sourceGenerationId: string
  ): Promise<ConversationSourceArtifactRecord | null>;
  appendConversationSourceSegment(
    actor: ActorContext,
    input: AppendConversationSourceSegmentInput
  ): Promise<{
    artifact: ConversationSourceArtifactRecord;
    segment: ConversationSourceSegmentRecord;
    replayed: boolean;
  }>;
  finalizeConversationSourceArtifact(
    actor: ActorContext,
    input: FinalizeConversationSourceArtifactInput
  ): Promise<{ artifact: ConversationSourceArtifactRecord; replayed: boolean }>;
  acceptConversationSourceReplicaSegment(
    actor: ActorContext,
    input: AcceptConversationSourceReplicaSegmentInput
  ): Promise<ConversationSourceReplicaSegmentAcceptance>;
  listConversationSourceSegments(
    actor: ActorContext,
    input: {
      artifactId: string;
      afterOffset: number;
      limit: number;
    }
  ): Promise<ConversationSourceSegmentRecord[]>;
  listConversationSourceSegmentsByIndex(
    actor: ActorContext,
    input: {
      artifactId: string;
      afterSegmentIndex: number;
      throughSegmentIndex: number;
      limit: number;
    }
  ): Promise<ConversationSourceSegmentRecord[]>;
  getConversationSourceSegment(
    actor: ActorContext,
    input: { artifactId: string; segmentId: string }
  ): Promise<ConversationSourceSegmentRecord | null>;
  getConversationSourceConsumerCursor(
    actor: ActorContext,
    input: {
      artifactId: string;
      consumerKind: ConversationSourceConsumerKind;
    }
  ): Promise<ConversationSourceConsumerCursorRecord | null>;
  advanceConversationSourceConsumerCursor(
    actor: ActorContext,
    input: {
      artifactId: string;
      consumerKind: ConversationSourceConsumerKind;
      expectedSourceOffset: number;
      sourceOffset: number;
      sourceLine: number;
      segmentIndex: number;
      lastVerifiedDigest: string;
      parserState?: Record<string, unknown>;
    }
  ): Promise<ConversationSourceConsumerCursorRecord>;
  recordConversationSourceConsumerFailure(
    actor: ActorContext,
    input: {
      artifactId: string;
      consumerKind: ConversationSourceConsumerKind;
      errorCode: string;
      retryAt: string | null;
    }
  ): Promise<ConversationSourceConsumerCursorRecord>;
  upsertPersonalSourceReplicationPolicy(
    actor: ActorContext,
    input:
      | {
          enabled: true;
          targetUpstreamId: string;
          mode: PersonalSourceReplicationMode;
          effectiveFrom: string;
        }
      | {
          enabled: false;
          mode: PersonalSourceReplicationMode;
          targetUpstreamId?: never;
        }
  ): Promise<PersonalSourceReplicationPolicyRecord>;
  getPersonalSourceReplicationPolicy(
    actor: ActorContext
  ): Promise<PersonalSourceReplicationPolicyRecord | null>;
  deletePersonalSourceReplicationPolicy(actor: ActorContext): Promise<boolean>;
  enqueueConversationSourceArtifactReplication(
    actor: ActorContext,
    input: {
      artifactId: string;
      targetUpstreamId: string;
      mode: PersonalSourceReplicationMode;
    }
  ): Promise<number>;
  enqueueConversationSourceGenerationRegistration(
    actor: ActorContext,
    input: {
      artifactId: string;
      targetUpstreamId: string;
      mode: PersonalSourceReplicationMode;
    }
  ): Promise<boolean>;
  listConversationSourceReplicationActors(input: {
    direction: "upload" | "materialize";
    limit?: number;
  }): Promise<ActorContext[]>;
  getConversationSourceReplicationWakeAt(): Promise<string | null>;
  listConversationSourceArtifactsForUpload(
    actor: ActorContext,
    input?: { targetUpstreamId?: string; limit?: number }
  ): Promise<ConversationSourceArtifactRecord[]>;
  listConversationSourceArtifactsForDownload(
    actor: ActorContext,
    input?: {
      replicaRole?: Exclude<ConversationSourceReplicaRole, "origin_local">;
      limit?: number;
    }
  ): Promise<ConversationSourceArtifactRecord[]>;
  listConversationSourceArtifactsForServing(
    actor: ActorContext,
    input: {
      replicaRoles: ConversationSourceReplicaRole[];
      cursor?: { updatedAt: string; id: string };
      limit?: number;
    }
  ): Promise<{
    artifacts: ConversationSourceArtifactRecord[];
    nextCursor: { updatedAt: string; id: string } | null;
  }>;
  claimConversationSourceReplicationOutbox(
    actor: ActorContext,
    input: { workerId: string; leaseMs: number; limit?: number }
  ): Promise<ConversationSourceReplicationOutboxClaimRecord[]>;
  renewConversationSourceReplicationOutboxLease(
    actor: ActorContext,
    input: { outboxId: string; leaseToken: string; leaseMs: number }
  ): Promise<ConversationSourceReplicationOutboxRecord>;
  completeConversationSourceReplicationOutbox(
    actor: ActorContext,
    input: { outboxId: string; leaseToken: string }
  ): Promise<ConversationSourceReplicationOutboxRecord>;
  failConversationSourceReplicationOutbox(
    actor: ActorContext,
    input: {
      outboxId: string;
      leaseToken: string;
      errorCode: string;
      retryAt?: string;
      quarantine?: boolean;
    }
  ): Promise<ConversationSourceReplicationOutboxRecord>;
  updateConversationSourceOriginKeyStatus(
    actor: ActorContext,
    input: {
      artifactId: string;
      status: Exclude<ConversationSourceOriginKeyStatus, "active">;
    }
  ): Promise<ConversationSourceArtifactRecord>;
  createConversationSourceDownloadAuthorization(
    actor: ActorContext,
    input: {
      deviceCredentialId: string;
      artifactId: string;
      recipientKey: Record<string, unknown>;
      capabilityHash: string;
      firstSegmentIndex: number;
      expiresAt: string;
    }
  ): Promise<ConversationSourceDownloadAuthorizationRecord>;
  getConversationSourceDownloadAuthorization(
    actor: ActorContext,
    input: {
      deviceCredentialId: string;
      capabilityHash: string;
      authorizationId: string;
    }
  ): Promise<ConversationSourceDownloadAuthorizationRecord | null>;
  touchConversationSourceDownloadAuthorization(
    actor: ActorContext,
    authorizationId: string
  ): Promise<boolean>;
  createConversationSourceRestoreJob(
    actor: ActorContext,
    input: {
      upstreamBackendId: string;
      sourceGenerationId: string;
      targetDeploymentId: string;
      recipientKeyId: string;
      recipientKeyVersion: number;
      actionGrantId: string;
      firstSegmentIndex: number;
    }
  ): Promise<ConversationSourceRestoreJobRecord>;
  getConversationSourceRestoreJob(
    actor: ActorContext,
    restoreJobId: string
  ): Promise<ConversationSourceRestoreJobRecord | null>;
  activateConversationSourceRestoreJob(
    actor: ActorContext,
    input: {
      restoreJobId: string;
      actionGrantId: string;
      remoteAuthorizationId: string;
      capability: string;
      registration: Record<string, unknown>;
      sourceDescriptor: Record<string, unknown>;
      sourceClosure?: Record<string, unknown>;
      firstSegmentIndex: number;
      lastSegmentIndex: number;
    }
  ): Promise<ConversationSourceRestoreJobRecord>;
  claimConversationSourceRestoreJobs(input: {
    workerId: string;
    leaseMs: number;
    limit?: number;
  }): Promise<ClaimedConversationSourceRestoreJob[]>;
  renewConversationSourceRestoreJobLease(input: {
    restoreJobId: string;
    leaseToken: string;
    workerId: string;
    leaseMs: number;
  }): Promise<boolean>;
  advanceConversationSourceRestoreJob(
    actor: ActorContext,
    input: {
      restoreJobId: string;
      leaseToken: string;
      nextSegmentIndex: number;
      state?: "downloading" | "materializing";
    }
  ): Promise<ConversationSourceRestoreJobRecord>;
  completeConversationSourceRestoreJob(
    actor: ActorContext,
    input: { restoreJobId: string; leaseToken: string }
  ): Promise<ConversationSourceRestoreJobRecord>;
  failConversationSourceRestoreJob(
    actor: ActorContext,
    input: {
      restoreJobId: string;
      leaseToken: string;
      errorCode: string;
      retry: boolean;
      retryAt?: string;
    }
  ): Promise<ConversationSourceRestoreJobRecord>;
}

export const createConversationSourceJournalRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider } = {}
): ConversationSourceJournalRepository => ({
  async ensureConversationSourceArtifact(actor, input) {
    return ensureConversationSourceArtifactWithClient(pool, actor, input);
  },

  async ensureConversationSourceArtifactForCapturedSession(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const session = await createCapturedSessionRepository(pool, {
        transactionClient: client
      }).createCapturedSession(actor, input.session);
      const artifact = await ensureConversationSourceArtifactWithClient(
        client,
        actor,
        {
          ...input.artifact,
          sessionId: session.id
        }
      );
      await client.query("commit");
      return { session, artifact };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async registerConversationSourceReplicaGeneration(actor, input) {
    return ensureConversationSourceArtifactWithClient(pool, actor, input);
  },

  async createConversationSourceSuccessorGeneration(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const parentResult = await client.query<ArtifactRow>(
        `select ${ARTIFACT_COLUMNS}
           from conversation_source_artifacts
          where id = $2 and owner_user_id = $1
          for update`,
        [actor.userId, input.parentArtifactId]
      );
      const parent = parentResult.rows[0];
      if (
        !parent ||
        parent.lifecycle !== "finalized" ||
        !parent.closure_hash ||
        parent.closure_hash !== input.expectedParentClosureHash ||
        !parent.finalized_at
      ) {
        throw statusError(
          "Conversation source parent is not finalized",
          409,
          "conversation_source_parent_not_finalized"
        );
      }
      const priorGenerationClosure = {
        sourceGenerationId: parent.source_generation_id,
        contentDigest: parent.closure_hash,
        closedAt: parent.finalized_at.toISOString()
      };
      const existing = await client.query<ArtifactRow>(
        `select ${ARTIFACT_COLUMNS}
           from conversation_source_artifacts
          where owner_user_id = $1
            and logical_source_id = $2
            and prior_generation_closure = $3::jsonb
            and lifecycle <> 'deleted'
          limit 1`,
        [actor.userId, parent.logical_source_id, priorGenerationClosure]
      );
      if (existing.rows[0]) {
        const replay = existing.rows[0];
        if (
          replay.source_generation_id !== input.sourceGenerationId ||
          replay.origin_deployment_id !== input.originDeploymentId ||
          replay.origin_device_id !== input.originDeviceId ||
          replay.origin_key_id !== input.originKeyId ||
          replay.origin_public_key !== input.originPublicKey
        ) {
          throw statusError(
            "Conversation source successor already exists",
            409,
            "conversation_source_successor_conflict"
          );
        }
        await client.query("commit");
        return { artifact: mapArtifact(replay), replayed: true };
      }
      const artifact = await ensureConversationSourceArtifactWithClient(
        client,
        actor,
        {
          sessionId: parent.session_id,
          logicalSourceId: parent.logical_source_id,
          sourceGenerationId: input.sourceGenerationId,
          replicaRole: "origin_local",
          sourceKind: parent.source_kind,
          sourceRuntime: parent.source_runtime,
          externalSessionId: parent.external_session_id,
          sourceFingerprint: parent.source_fingerprint,
          artifactFormat: parent.artifact_format,
          artifactFormatVersion: parent.artifact_format_version,
          sourceAdapterVersion: parent.source_adapter_version,
          journalStartOffset: Number(parent.provider_cursor_offset),
          journalStartLine: parent.provider_cursor_line,
          liveStartOffset: Number(parent.provider_cursor_offset),
          liveStartLine: parent.provider_cursor_line,
          currentSourceLength: Number(parent.provider_cursor_offset),
          sourceCreatedAt: input.sourceCreatedAt,
          sourceModifiedAt: parent.source_modified_at?.toISOString(),
          storageProvider: input.storageProvider,
          storagePrefix: input.storagePrefix,
          originDeploymentId: input.originDeploymentId,
          originDeviceId: input.originDeviceId,
          originKeyId: input.originKeyId,
          originPublicKey: input.originPublicKey,
          priorGenerationClosure,
          redactedSourceLabel: parent.redacted_source_label
        }
      );
      await client.query("commit");
      return { artifact, replayed: false };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getConversationSourceArtifact(actor, artifactId) {
    const result = await pool.query<ArtifactRow>(
      `select ${ARTIFACT_COLUMNS}
         from conversation_source_artifacts
        where id = $2 and owner_user_id = $1 and lifecycle <> 'deleted'
        limit 1`,
      [actor.userId, artifactId]
    );
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  },

  async getConversationSourceArtifactByIdentity(actor, input) {
    const result = await pool.query<ArtifactRow>(
      `select ${ARTIFACT_COLUMNS}
         from conversation_source_artifacts
        where owner_user_id = $1
          and logical_source_id = $2
          and source_generation_id = $3
          and lifecycle <> 'deleted'
        limit 1`,
      [actor.userId, input.logicalSourceId, input.sourceGenerationId]
    );
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  },

  async getConversationSourceArtifactByProviderIdentity(actor, input) {
    const result = await pool.query<ArtifactRow>(
      `select ${ARTIFACT_COLUMNS}
         from conversation_source_artifacts
        where owner_user_id = $1
          and source_kind = $2
          and external_session_id = $3
          and replica_role = 'origin_local'
          and lifecycle <> 'deleted'
        order by source_created_at desc, id desc
        limit 1`,
      [actor.userId, input.sourceKind, input.externalSessionId]
    );
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  },

  async getConversationSourceArtifactByGeneration(actor, sourceGenerationId) {
    const result = await pool.query<ArtifactRow>(
      `select ${ARTIFACT_COLUMNS}
         from conversation_source_artifacts
        where owner_user_id = $1
          and source_generation_id = $2
          and lifecycle <> 'deleted'
        order by updated_at desc, id
        limit 1`,
      [actor.userId, sourceGenerationId]
    );
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  },

  async appendConversationSourceSegment(actor, input) {
    assertSignedSegmentMetadata(input);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const artifactResult = await client.query<ArtifactRow>(
        `select ${ARTIFACT_COLUMNS}
           from conversation_source_artifacts
          where id = $2 and owner_user_id = $1
          for update`,
        [actor.userId, input.artifactId]
      );
      const artifactRow = artifactResult.rows[0];
      if (!artifactRow) {
        throw statusError("Conversation source artifact not found", 404);
      }
      if (artifactRow.replica_role !== "origin_local") {
        throw statusError(
          "Conversation source replica is read-only",
          409,
          "conversation_source_replica_read_only"
        );
      }
      if (artifactRow.origin_key_status !== "active") {
        throw statusError(
          `Conversation source origin key is ${artifactRow.origin_key_status}`,
          409,
          `conversation_source_origin_key_${artifactRow.origin_key_status}`
        );
      }
      const existing = await client.query<SegmentRow>(
        `select ${SEGMENT_COLUMNS}
           from conversation_source_segments
          where artifact_id = $1
            and source_start_offset = $2
            and source_end_offset = $3
          limit 1`,
        [input.artifactId, input.expectedProviderOffset, input.sourceEndOffset]
      );
      if (existing.rows[0]) {
        const existingRow = existing.rows[0];
        assertSignedSegmentBinding(artifactRow, {
          ...input,
          segmentIndex: existingRow.segment_index,
          sourceStartOffset: input.expectedProviderOffset,
          sourceStartLine: input.expectedProviderLine
        });
        if (
          !signedSegmentMatches(existingRow, {
            ...input,
            segmentIndex: existingRow.segment_index,
            sourceStartOffset: input.expectedProviderOffset,
            sourceStartLine: input.expectedProviderLine
          })
        ) {
          throw statusError(
            "Conversation source segment replay conflict",
            409,
            "conversation_source_segment_replay_conflict"
          );
        }
        await client.query("commit");
        return {
          artifact: mapArtifact(artifactRow),
          segment: mapSegment(existingRow),
          replayed: true
        };
      }
      if (
        artifactRow.lifecycle !== "active" ||
        artifactRow.storage_provider !== input.storageProvider ||
        Number(artifactRow.provider_cursor_offset) !==
          input.expectedProviderOffset ||
        artifactRow.provider_cursor_line !== input.expectedProviderLine
      ) {
        throw statusError(
          "Conversation source cursor conflict",
          409,
          "conversation_source_cursor_conflict"
        );
      }
      const segmentIndex = artifactRow.current_journal_sequence + 1;
      const prior =
        segmentIndex === 0
          ? null
          : await client.query<Pick<SegmentRow, "content_digest">>(
              `select content_digest
                 from conversation_source_segments
                where artifact_id = $1 and segment_index = $2
                limit 1`,
              [input.artifactId, segmentIndex - 1]
            );
      const expectedPreviousDigest =
        segmentIndex === 0 ? null : (prior?.rows[0]?.content_digest ?? null);
      assertSignedSegmentBinding(artifactRow, {
        ...input,
        segmentIndex,
        sourceStartOffset: input.expectedProviderOffset,
        sourceStartLine: input.expectedProviderLine
      });
      if (
        expectedPreviousDigest !== input.previousContentDigest ||
        (segmentIndex === 0 &&
          (input.expectedProviderOffset !==
            Number(artifactRow.journal_start_offset) ||
            input.expectedProviderLine !== artifactRow.journal_start_line))
      ) {
        throw statusError(
          "Conversation source segment chain conflict",
          409,
          "conversation_source_segment_chain_conflict"
        );
      }
      const segmentResult = await client.query<SegmentRow>(
        `insert into conversation_source_segments (
           artifact_id, segment_index, source_start_offset, source_end_offset,
           source_start_line, source_end_line, plaintext_digest,
           ciphertext_digest, plaintext_size, stored_size, storage_key,
           storage_provider, encryption_envelope, signed_manifest,
           origin_signature, manifest_digest, previous_content_digest,
           content_digest, sealed_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16, $17, $18, now()
         )
         returning ${SEGMENT_COLUMNS}`,
        [
          input.artifactId,
          segmentIndex,
          input.expectedProviderOffset,
          input.sourceEndOffset,
          input.expectedProviderLine,
          input.sourceEndLine,
          input.plaintextDigest,
          input.ciphertextDigest ?? null,
          input.plaintextSize,
          input.storedSize,
          input.storageKey,
          input.storageProvider,
          input.encryptionEnvelope ?? null,
          input.signedManifest,
          input.originSignature,
          input.manifestDigest,
          input.previousContentDigest,
          input.contentDigest
        ]
      );
      const segmentRow = segmentResult.rows[0]!;
      const nextArtifact = await client.query<ArtifactRow>(
        `update conversation_source_artifacts
            set provider_cursor_offset = $3,
                provider_cursor_line = $4,
                current_source_length = greatest(current_source_length, $5),
                current_journal_sequence = $6,
                source_modified_at = coalesce($7, source_modified_at),
                updated_at = now()
          where id = $2 and owner_user_id = $1
          returning ${ARTIFACT_COLUMNS}`,
        [
          actor.userId,
          input.artifactId,
          input.sourceEndOffset,
          input.sourceEndLine,
          input.currentSourceLength,
          segmentIndex,
          input.sourceModifiedAt ?? null
        ]
      );
      await client.query(
        `insert into conversation_source_replication_outbox (
           owner_user_id, artifact_id, operation_kind, segment_id,
           target_upstream_id, mode
         )
         select $1, $2, 'segment', $3, policy.target_upstream_id, policy.mode
           from personal_source_replication_policies policy
          where policy.owner_user_id = $1
            and policy.enabled = true
            and policy.target_upstream_id is not null
            and policy.effective_from <= now()
            and exists (
              select 1
                from conversation_source_artifacts artifact
               where artifact.id = $2
                 and artifact.owner_user_id = $1
                 and artifact.source_created_at >= policy.effective_from
            )
         on conflict do nothing`,
        [actor.userId, input.artifactId, segmentRow.id]
      );
      await notifyConversationSourceReplication(client, "upload");
      await client.query("commit");
      return {
        artifact: mapArtifact(nextArtifact.rows[0]!),
        segment: mapSegment(segmentRow),
        replayed: false
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async finalizeConversationSourceArtifact(actor, input) {
    const signedClosure = parseSignedConversationSourceClosureManifest(
      input.signedClosure
    );
    const closureHash = calculateConversationSourceClosureDigest(signedClosure);
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("begin");
      const artifactResult = await client.query<ArtifactRow>(
        `select ${ARTIFACT_COLUMNS}
           from conversation_source_artifacts
          where id = $2 and owner_user_id = $1
          for update`,
        [actor.userId, input.artifactId]
      );
      const artifact = artifactResult.rows[0];
      if (!artifact) {
        throw statusError("Conversation source artifact not found", 404);
      }
      if (
        signedClosure.manifest.logicalSourceId !== artifact.logical_source_id ||
        signedClosure.manifest.sourceGenerationId !==
          artifact.source_generation_id ||
        signedClosure.manifest.originKeyId !== artifact.origin_key_id ||
        signedClosure.manifest.sourceCreatedAt !==
          artifact.source_created_at.toISOString() ||
        !isDeepStrictEqual(
          signedClosure.manifest.priorGenerationClosure,
          artifact.prior_generation_closure
        )
      ) {
        throw statusError(
          "Conversation source closure identity is invalid",
          409,
          "conversation_source_closure_identity_conflict"
        );
      }
      if (
        artifact.origin_key_status !== "active" ||
        !verifyConversationSourceClosureManifestSignature(
          signedClosure,
          artifact.origin_public_key
        )
      ) {
        throw statusError(
          "Conversation source closure signature is invalid",
          409,
          "conversation_source_closure_signature_invalid"
        );
      }
      if (artifact.lifecycle === "finalized") {
        if (
          artifact.closure_hash !== closureHash ||
          !isDeepStrictEqual(
            artifact.closure_manifest,
            signedClosure.manifest
          ) ||
          artifact.closure_signature !== signedClosure.signature
        ) {
          throw statusError(
            "Conversation source closure conflicts with finalized state",
            409,
            "conversation_source_closure_conflict"
          );
        }
        await client.query("commit");
        committed = true;
        return { artifact: mapArtifact(artifact), replayed: true };
      }
      if (artifact.lifecycle !== "active") {
        throw statusError(
          "Conversation source generation is not closable",
          409,
          "conversation_source_closure_lifecycle_conflict"
        );
      }
      const segments = await client.query<
        Pick<
          SegmentRow,
          | "segment_index"
          | "source_end_offset"
          | "source_end_line"
          | "content_digest"
        >
      >(
        `select segment_index, source_end_offset, source_end_line, content_digest
           from conversation_source_segments
          where artifact_id = $1
          order by segment_index`,
        [input.artifactId]
      );
      const expectedSegmentCount = artifact.current_journal_sequence + 1;
      const chainHead = segments.rows.at(-1)?.content_digest ?? null;
      const chainMatches =
        segments.rows.length === expectedSegmentCount &&
        segments.rows.every(
          (segment, index) => segment.segment_index === index
        ) &&
        signedClosure.manifest.segmentCount === expectedSegmentCount &&
        signedClosure.manifest.endByteCursor ===
          Number(artifact.provider_cursor_offset) &&
        signedClosure.manifest.endItemCursor ===
          artifact.provider_cursor_line &&
        signedClosure.manifest.chainHeadDigest === chainHead &&
        signedClosure.manifest.sourceRootDigest ===
          calculateConversationSourceRootDigest(
            segments.rows.map((segment) => segment.content_digest)
          ) &&
        (segments.rows.length === 0 ||
          (Number(segments.rows.at(-1)!.source_end_offset) ===
            signedClosure.manifest.endByteCursor &&
            segments.rows.at(-1)!.source_end_line ===
              signedClosure.manifest.endItemCursor));
      if (!chainMatches) {
        if (artifact.replica_role !== "origin_local") {
          await client.query(
            `update conversation_source_artifacts
                set lifecycle = 'conflicted', updated_at = now()
              where id = $2 and owner_user_id = $1`,
            [actor.userId, input.artifactId]
          );
          await client.query("commit");
          committed = true;
          throw statusError(
            "Conversation source closure conflicts with accepted segments",
            409,
            "conversation_source_closure_chain_conflict"
          );
        }
        throw statusError(
          "Conversation source closure does not match the local journal",
          409,
          "conversation_source_closure_chain_conflict"
        );
      }
      const finalized = await client.query<ArtifactRow>(
        `update conversation_source_artifacts
            set lifecycle = 'finalized',
                closure_hash = $3,
                closure_manifest = $4::jsonb,
                closure_signature = $5,
                finalized_at = $6,
                updated_at = now()
          where id = $2 and owner_user_id = $1 and lifecycle = 'active'
          returning ${ARTIFACT_COLUMNS}`,
        [
          actor.userId,
          input.artifactId,
          closureHash,
          signedClosure.manifest,
          signedClosure.signature,
          signedClosure.manifest.closedAt
        ]
      );
      const finalizedArtifact = finalized.rows[0];
      if (!finalizedArtifact) {
        throw statusError(
          "Conversation source closure conflicted",
          409,
          "conversation_source_closure_conflict"
        );
      }
      if (artifact.replica_role === "origin_local") {
        await client.query(
          `insert into conversation_source_replication_outbox (
             owner_user_id, artifact_id, operation_kind, segment_id,
             target_upstream_id, mode
           )
           select $1, $2, 'closure', null, policy.target_upstream_id, policy.mode
             from personal_source_replication_policies policy
            where policy.owner_user_id = $1
              and policy.enabled = true
              and policy.target_upstream_id is not null
              and policy.effective_from <= now()
              and exists (
                select 1
                  from conversation_source_artifacts artifact
                 where artifact.id = $2
                   and artifact.owner_user_id = $1
                   and artifact.source_created_at >= policy.effective_from
              )
           on conflict do nothing`,
          [actor.userId, input.artifactId]
        );
        await notifyConversationSourceReplication(client, "upload");
      }
      await client.query("commit");
      committed = true;
      return { artifact: mapArtifact(finalizedArtifact), replayed: false };
    } catch (error) {
      if (!committed) {
        await client.query("rollback").catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  },

  async acceptConversationSourceReplicaSegment(actor, input) {
    assertSignedSegmentMetadata(input);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const artifactResult = await client.query<ArtifactRow>(
        `select ${ARTIFACT_COLUMNS}
           from conversation_source_artifacts
          where id = $2 and owner_user_id = $1
          for update`,
        [actor.userId, input.artifactId]
      );
      const artifactRow = artifactResult.rows[0];
      if (!artifactRow) {
        throw statusError(
          "Conversation source replica generation is not registered",
          404,
          "conversation_source_replica_generation_not_registered"
        );
      }
      if (artifactRow.replica_role === "origin_local") {
        throw statusError(
          "Origin-local segments must use the local append path",
          409,
          "conversation_source_replica_role_conflict"
        );
      }
      if (artifactRow.origin_key_status !== "active") {
        throw statusError(
          `Conversation source origin key is ${artifactRow.origin_key_status}`,
          409,
          `conversation_source_origin_key_${artifactRow.origin_key_status}`
        );
      }
      assertSignedSegmentBinding(artifactRow, input);
      if (artifactRow.lifecycle === "conflicted") {
        throw statusError(
          "Conversation source generation is quarantined",
          409,
          "conversation_source_generation_quarantined"
        );
      }
      const existing = await client.query<SegmentRow>(
        `select ${SEGMENT_COLUMNS}
           from conversation_source_segments
          where artifact_id = $1 and segment_index = $2
          limit 1`,
        [input.artifactId, input.segmentIndex]
      );
      if (existing.rows[0]) {
        if (signedSegmentMatches(existing.rows[0], input)) {
          await client.query("commit");
          return {
            status: "replayed",
            artifact: mapArtifact(artifactRow),
            segment: mapSegment(existing.rows[0])
          };
        }
        const quarantined = await client.query<ArtifactRow>(
          `update conversation_source_artifacts
              set lifecycle = 'conflicted', updated_at = now()
            where id = $2 and owner_user_id = $1
            returning ${ARTIFACT_COLUMNS}`,
          [actor.userId, input.artifactId]
        );
        await client.query("commit");
        return {
          status: "quarantined",
          artifact: mapArtifact(quarantined.rows[0]!),
          segment: null,
          reason: "segment_identity_conflict"
        };
      }
      const expectedSegmentIndex = artifactRow.current_journal_sequence + 1;
      if (input.segmentIndex > expectedSegmentIndex) {
        await client.query("commit");
        return {
          status: "gap",
          artifact: mapArtifact(artifactRow),
          segment: null,
          expectedSegmentIndex
        };
      }
      if (
        artifactRow.lifecycle !== "active" ||
        input.segmentIndex < expectedSegmentIndex
      ) {
        const reason =
          artifactRow.lifecycle === "finalized"
            ? "post_closure_append"
            : "segment_chain_conflict";
        const quarantined = await client.query<ArtifactRow>(
          `update conversation_source_artifacts
              set lifecycle = 'conflicted', updated_at = now()
            where id = $2 and owner_user_id = $1
            returning ${ARTIFACT_COLUMNS}`,
          [actor.userId, input.artifactId]
        );
        await client.query("commit");
        return {
          status: "quarantined",
          artifact: mapArtifact(quarantined.rows[0]!),
          segment: null,
          reason
        };
      }
      const prior =
        input.segmentIndex === 0
          ? null
          : await client.query<
              Pick<
                SegmentRow,
                "content_digest" | "source_end_offset" | "source_end_line"
              >
            >(
              `select content_digest, source_end_offset, source_end_line
                 from conversation_source_segments
                where artifact_id = $1 and segment_index = $2
                limit 1`,
              [input.artifactId, input.segmentIndex - 1]
            );
      const previous = prior?.rows[0];
      const chainMatches =
        input.storageProvider === artifactRow.storage_provider &&
        (input.segmentIndex === 0
          ? input.previousContentDigest === null &&
            input.sourceStartOffset ===
              Number(artifactRow.journal_start_offset) &&
            input.sourceStartLine === artifactRow.journal_start_line
          : previous !== undefined &&
            input.previousContentDigest === previous.content_digest &&
            input.sourceStartOffset === Number(previous.source_end_offset) &&
            input.sourceStartLine === previous.source_end_line);
      if (!chainMatches) {
        const quarantined = await client.query<ArtifactRow>(
          `update conversation_source_artifacts
              set lifecycle = 'conflicted', updated_at = now()
            where id = $2 and owner_user_id = $1
            returning ${ARTIFACT_COLUMNS}`,
          [actor.userId, input.artifactId]
        );
        await client.query("commit");
        return {
          status: "quarantined",
          artifact: mapArtifact(quarantined.rows[0]!),
          segment: null,
          reason: "segment_chain_conflict"
        };
      }
      const segment = await client.query<SegmentRow>(
        `insert into conversation_source_segments (
           artifact_id, segment_index, source_start_offset, source_end_offset,
           source_start_line, source_end_line, plaintext_digest,
           ciphertext_digest, plaintext_size, stored_size, storage_key,
           storage_provider, encryption_envelope, signed_manifest,
           origin_signature, manifest_digest, previous_content_digest,
           content_digest, sealed_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16, $17, $18, now()
         )
         returning ${SEGMENT_COLUMNS}`,
        [
          input.artifactId,
          input.segmentIndex,
          input.sourceStartOffset,
          input.sourceEndOffset,
          input.sourceStartLine,
          input.sourceEndLine,
          input.plaintextDigest,
          input.ciphertextDigest,
          input.plaintextSize,
          input.storedSize,
          input.storageKey,
          input.storageProvider,
          input.encryptionEnvelope,
          input.signedManifest,
          input.originSignature,
          input.manifestDigest,
          input.previousContentDigest,
          input.contentDigest
        ]
      );
      const nextArtifact = await client.query<ArtifactRow>(
        `update conversation_source_artifacts
            set provider_cursor_offset = $3,
                provider_cursor_line = $4,
                current_source_length = greatest(current_source_length, $5),
                current_journal_sequence = $6,
                source_modified_at = coalesce($7, source_modified_at),
                updated_at = now()
          where id = $2 and owner_user_id = $1
          returning ${ARTIFACT_COLUMNS}`,
        [
          actor.userId,
          input.artifactId,
          input.sourceEndOffset,
          input.sourceEndLine,
          input.currentSourceLength,
          input.segmentIndex,
          input.sourceModifiedAt ?? null
        ]
      );
      await client.query(
        `update conversation_source_consumer_cursors
            set next_attempt_at = now(), updated_at = now()
          where artifact_id = $1
            and consumer_kind = 'remote_processing'
            and failure_code is null`,
        [input.artifactId]
      );
      await notifyConversationSourceReplication(client, "materialize");
      await client.query("commit");
      return {
        status: "accepted",
        artifact: mapArtifact(nextArtifact.rows[0]!),
        segment: mapSegment(segment.rows[0]!)
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async listConversationSourceSegments(actor, input) {
    const result = await pool.query<SegmentRow>(
      `select ${SEGMENT_SELECT_COLUMNS}
         from conversation_source_segments segment
         join conversation_source_artifacts artifact
           on artifact.id = segment.artifact_id
        where artifact.owner_user_id = $1
          and artifact.id = $2
          and artifact.lifecycle <> 'deleted'
          and segment.source_end_offset > $3
        order by segment.source_start_offset, segment.segment_index
        limit $4`,
      [actor.userId, input.artifactId, input.afterOffset, input.limit]
    );
    return result.rows.map(mapSegment);
  },

  async listConversationSourceSegmentsByIndex(actor, input) {
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const result = await pool.query<SegmentRow>(
      `select ${SEGMENT_SELECT_COLUMNS}
         from conversation_source_segments segment
         join conversation_source_artifacts artifact
           on artifact.id = segment.artifact_id
        where segment.artifact_id = $2
          and artifact.owner_user_id = $1
          and artifact.lifecycle <> 'deleted'
          and segment.segment_index > $3
          and segment.segment_index <= $4
        order by segment.segment_index
        limit $5`,
      [
        actor.userId,
        input.artifactId,
        input.afterSegmentIndex,
        input.throughSegmentIndex,
        limit
      ]
    );
    return result.rows.map(mapSegment);
  },

  async getConversationSourceSegment(actor, input) {
    const result = await pool.query<SegmentRow>(
      `select ${SEGMENT_SELECT_COLUMNS}
         from conversation_source_segments segment
         join conversation_source_artifacts artifact
           on artifact.id = segment.artifact_id
        where artifact.owner_user_id = $1
          and artifact.id = $2
          and segment.id = $3
          and artifact.lifecycle <> 'deleted'
        limit 1`,
      [actor.userId, input.artifactId, input.segmentId]
    );
    return result.rows[0] ? mapSegment(result.rows[0]) : null;
  },

  async getConversationSourceConsumerCursor(actor, input) {
    const result = await pool.query<CursorRow>(
      `select ${CURSOR_SELECT_COLUMNS}
         from conversation_source_consumer_cursors cursor
         join conversation_source_artifacts artifact
           on artifact.id = cursor.artifact_id
        where artifact.owner_user_id = $1
          and cursor.artifact_id = $2
          and cursor.consumer_kind = $3
          and artifact.lifecycle <> 'deleted'
        limit 1`,
      [actor.userId, input.artifactId, input.consumerKind]
    );
    return result.rows[0] ? mapCursor(result.rows[0]) : null;
  },

  async advanceConversationSourceConsumerCursor(actor, input) {
    const result = await pool.query<CursorRow>(
      `insert into conversation_source_consumer_cursors (
         artifact_id, consumer_kind, segment_index, source_offset,
         source_line, last_verified_digest, parser_state
       )
       select
         artifact.id, $3::conversation_source_consumer_kind, $4, $5, $6, $7, $8
       from conversation_source_artifacts artifact
       where artifact.id = $2
         and artifact.owner_user_id = $1
         and artifact.lifecycle <> 'deleted'
         and $5 <= artifact.provider_cursor_offset
         and exists (
           select 1
             from conversation_source_segments segment
            where segment.artifact_id = artifact.id
              and segment.segment_index = $4
              and segment.source_start_offset < $5
              and segment.source_end_offset >= $5
              and segment.source_start_line < $6
              and segment.source_end_line >= $6
              and segment.plaintext_digest = $7
         )
         and (
           $9 = case
             when $3::conversation_source_consumer_kind = 'canonical_live'
             then artifact.live_start_offset
             else artifact.journal_start_offset
           end
           or exists (
             select 1
             from conversation_source_consumer_cursors existing
             where existing.artifact_id = artifact.id
               and existing.consumer_kind =
                 $3::conversation_source_consumer_kind
               and existing.source_offset = $9
           )
         )
       on conflict (artifact_id, consumer_kind)
       do update set
         segment_index = excluded.segment_index,
         source_offset = excluded.source_offset,
         source_line = excluded.source_line,
         last_verified_digest = excluded.last_verified_digest,
         parser_state = excluded.parser_state,
         failure_code = null,
         retry_count = 0,
         next_attempt_at = null,
         updated_at = now()
       where conversation_source_consumer_cursors.source_offset = $9
         and excluded.source_offset >
           conversation_source_consumer_cursors.source_offset
       returning ${CURSOR_COLUMNS}`,
      [
        actor.userId,
        input.artifactId,
        input.consumerKind,
        input.segmentIndex,
        input.sourceOffset,
        input.sourceLine,
        input.lastVerifiedDigest,
        input.parserState ?? {},
        input.expectedSourceOffset
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw statusError(
        "Conversation source consumer cursor conflict",
        409,
        "conversation_source_consumer_cursor_conflict"
      );
    }
    return mapCursor(row);
  },

  async recordConversationSourceConsumerFailure(actor, input) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(input.errorCode)) {
      throw statusError("Source consumer error code is invalid", 400);
    }
    if (
      input.retryAt !== null &&
      (Number.isNaN(Date.parse(input.retryAt)) ||
        new Date(input.retryAt).toISOString() !== input.retryAt)
    ) {
      throw statusError("Source consumer retry time is invalid", 400);
    }
    const result = await pool.query<CursorRow>(
      `insert into conversation_source_consumer_cursors (
         artifact_id, consumer_kind, segment_index, source_offset,
         source_line, parser_state, failure_code, retry_count, next_attempt_at
       )
       select artifact.id, $3::conversation_source_consumer_kind, 0,
              case
                when $3::conversation_source_consumer_kind = 'canonical_live'
                then artifact.live_start_offset
                else artifact.journal_start_offset
              end,
              case
                when $3::conversation_source_consumer_kind = 'canonical_live'
                then artifact.live_start_line
                else artifact.journal_start_line
              end,
              '{}'::jsonb, $4, 1, $5
         from conversation_source_artifacts artifact
        where artifact.id = $2
          and artifact.owner_user_id = $1
          and artifact.lifecycle <> 'deleted'
       on conflict (artifact_id, consumer_kind)
       do update set
         failure_code = excluded.failure_code,
         retry_count =
           least(conversation_source_consumer_cursors.retry_count + 1, 1000),
         next_attempt_at = excluded.next_attempt_at,
         updated_at = now()
       returning ${CURSOR_COLUMNS}`,
      [
        actor.userId,
        input.artifactId,
        input.consumerKind,
        input.errorCode,
        input.retryAt
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw statusError("Conversation source artifact not found", 404);
    }
    if (input.retryAt !== null) {
      await notifyConversationSourceReplication(pool, "retry");
    }
    return mapCursor(row);
  },

  async upsertPersonalSourceReplicationPolicy(actor, input) {
    const target = input.enabled ? input.targetUpstreamId.trim() : null;
    const effectiveFrom = input.enabled ? input.effectiveFrom : null;
    if (
      input.enabled &&
      (input.targetUpstreamId.trim().length === 0 ||
        input.targetUpstreamId.trim().length > 160)
    ) {
      throw statusError("Source replication target is invalid", 400);
    }
    if (
      effectiveFrom !== null &&
      (Number.isNaN(Date.parse(effectiveFrom)) ||
        new Date(effectiveFrom).toISOString() !== effectiveFrom)
    ) {
      throw statusError(
        "Source replication effective boundary is invalid",
        400
      );
    }
    const result = await pool.query<PolicyRow>(
      `insert into personal_source_replication_policies (
         owner_user_id, enabled, target_upstream_id, mode, effective_from
       )
       select id, $2, $3, $4, $5
         from users
        where id = $1
       on conflict (owner_user_id)
       do update set
         enabled = excluded.enabled,
         target_upstream_id = excluded.target_upstream_id,
         mode = excluded.mode,
         effective_from = case
           when personal_source_replication_policies.enabled = true
            and excluded.enabled = true
            and personal_source_replication_policies.target_upstream_id =
                excluded.target_upstream_id
            and personal_source_replication_policies.mode = excluded.mode
           then personal_source_replication_policies.effective_from
           else excluded.effective_from
         end,
         updated_at = now()
       returning ${POLICY_COLUMNS}`,
      [actor.userId, input.enabled, target, input.mode, effectiveFrom]
    );
    const row = result.rows[0];
    if (!row) {
      throw statusError("Source replication policy owner not found", 404);
    }
    if (row.enabled) {
      await notifyConversationSourceReplication(pool, "upload");
    }
    return mapPolicy(row);
  },

  async getPersonalSourceReplicationPolicy(actor) {
    const result = await pool.query<PolicyRow>(
      `select ${POLICY_COLUMNS}
         from personal_source_replication_policies
        where owner_user_id = $1
        limit 1`,
      [actor.userId]
    );
    return result.rows[0] ? mapPolicy(result.rows[0]) : null;
  },

  async deletePersonalSourceReplicationPolicy(actor) {
    const result = await pool.query(
      `delete from personal_source_replication_policies
        where owner_user_id = $1`,
      [actor.userId]
    );
    return (result.rowCount ?? 0) > 0;
  },

  async enqueueConversationSourceArtifactReplication(actor, input) {
    const targetUpstreamId = input.targetUpstreamId.trim();
    if (targetUpstreamId.length === 0 || targetUpstreamId.length > 160) {
      throw statusError("Source replication target is invalid", 400);
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const artifact = await client.query<ArtifactRow>(
        `select ${ARTIFACT_COLUMNS}
           from conversation_source_artifacts
          where id = $2
            and owner_user_id = $1
          for update`,
        [actor.userId, input.artifactId]
      );
      const row = artifact.rows[0];
      if (!row) {
        throw statusError("Conversation source artifact not found", 404);
      }
      if (
        !["origin_local", "peer_personal"].includes(row.replica_role) ||
        row.lifecycle !== "finalized"
      ) {
        throw statusError(
          "Only a finalized trusted Personal source can be published for execution transfer",
          409,
          "conversation_source_transfer_publish_not_ready"
        );
      }
      const registration = await client.query(
        `insert into conversation_source_replication_outbox (
           owner_user_id, artifact_id, operation_kind, segment_id,
           target_upstream_id, mode, authorization_basis
         ) values ($1, $2, 'registration', null, $3, $4, 'execution_transfer')
         on conflict (owner_user_id, artifact_id, target_upstream_id)
           where operation_kind = 'registration'
         do update
            set authorization_basis = 'execution_transfer',
                state = case
                  when conversation_source_replication_outbox.state in ('failed', 'quarantined')
                  then 'pending'::conversation_source_replication_outbox_state
                  else conversation_source_replication_outbox.state
                end,
                attempts = case
                  when conversation_source_replication_outbox.state in ('failed', 'quarantined')
                  then 0
                  else conversation_source_replication_outbox.attempts
                end,
                next_attempt_at = case
                  when conversation_source_replication_outbox.state in ('pending', 'failed', 'quarantined')
                  then now()
                  else conversation_source_replication_outbox.next_attempt_at
                end,
                last_error_code = case
                  when conversation_source_replication_outbox.state in ('failed', 'quarantined')
                  then null
                  else conversation_source_replication_outbox.last_error_code
                end,
                quarantined_at = case
                  when conversation_source_replication_outbox.state in ('failed', 'quarantined')
                  then null
                  else conversation_source_replication_outbox.quarantined_at
                end,
                updated_at = now()`,
        [actor.userId, input.artifactId, targetUpstreamId, input.mode]
      );
      const segments = await client.query(
        `insert into conversation_source_replication_outbox (
           owner_user_id, artifact_id, operation_kind, segment_id,
           target_upstream_id, mode, authorization_basis
         )
         select $1, $2, 'segment', segment.id, $3, $4, 'execution_transfer'
           from conversation_source_segments segment
          where segment.artifact_id = $2
         on conflict (owner_user_id, segment_id, target_upstream_id)
           where operation_kind = 'segment'
         do update
            set authorization_basis = 'execution_transfer',
                state = case
                  when conversation_source_replication_outbox.state = 'failed'
                  then 'pending'::conversation_source_replication_outbox_state
                  else conversation_source_replication_outbox.state
                end,
                attempts = case
                  when conversation_source_replication_outbox.state = 'failed'
                  then 0
                  else conversation_source_replication_outbox.attempts
                end,
                next_attempt_at = case
                  when conversation_source_replication_outbox.state in ('pending', 'failed')
                  then now()
                  else conversation_source_replication_outbox.next_attempt_at
                end,
                last_error_code = case
                  when conversation_source_replication_outbox.state = 'failed'
                  then null
                  else conversation_source_replication_outbox.last_error_code
                end,
                updated_at = now()`,
        [actor.userId, input.artifactId, targetUpstreamId, input.mode]
      );
      const closure = await client.query(
        `insert into conversation_source_replication_outbox (
           owner_user_id, artifact_id, operation_kind, segment_id,
           target_upstream_id, mode, authorization_basis
         ) values ($1, $2, 'closure', null, $3, $4, 'execution_transfer')
         on conflict (owner_user_id, artifact_id, target_upstream_id)
           where operation_kind = 'closure'
         do update
            set authorization_basis = 'execution_transfer',
                state = case
                  when conversation_source_replication_outbox.state = 'failed'
                  then 'pending'::conversation_source_replication_outbox_state
                  else conversation_source_replication_outbox.state
                end,
                attempts = case
                  when conversation_source_replication_outbox.state = 'failed'
                  then 0
                  else conversation_source_replication_outbox.attempts
                end,
                next_attempt_at = case
                  when conversation_source_replication_outbox.state in ('pending', 'failed')
                  then now()
                  else conversation_source_replication_outbox.next_attempt_at
                end,
                last_error_code = case
                  when conversation_source_replication_outbox.state = 'failed'
                  then null
                  else conversation_source_replication_outbox.last_error_code
                end,
                updated_at = now()`,
        [actor.userId, input.artifactId, targetUpstreamId, input.mode]
      );
      await notifyConversationSourceReplication(
        client,
        "upload",
        row.source_generation_id
      );
      await client.query("commit");
      return (
        (registration.rowCount ?? 0) +
        (segments.rowCount ?? 0) +
        (closure.rowCount ?? 0)
      );
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async enqueueConversationSourceGenerationRegistration(actor, input) {
    const targetUpstreamId = input.targetUpstreamId.trim();
    if (targetUpstreamId.length === 0 || targetUpstreamId.length > 160) {
      throw statusError("Source replication target is invalid", 400);
    }
    const result = await pool.query<{ source_generation_id: string }>(
      `insert into conversation_source_replication_outbox (
         owner_user_id, artifact_id, operation_kind, segment_id,
         target_upstream_id, mode, authorization_basis
       )
       select artifact.owner_user_id, artifact.id, 'registration', null,
              $3, $4, 'execution_transfer'
         from conversation_source_artifacts artifact
        where artifact.owner_user_id = $1
          and artifact.id = $2
          and artifact.replica_role in ('origin_local', 'peer_personal')
          and artifact.lifecycle = 'active'
       on conflict (owner_user_id, artifact_id, target_upstream_id)
         where operation_kind = 'registration'
       do update
          set authorization_basis = 'execution_transfer',
              state = case
                when conversation_source_replication_outbox.state in ('failed', 'quarantined')
                then 'pending'::conversation_source_replication_outbox_state
                else conversation_source_replication_outbox.state
              end,
              attempts = case
                when conversation_source_replication_outbox.state in ('failed', 'quarantined')
                then 0
                else conversation_source_replication_outbox.attempts
              end,
              next_attempt_at = case
                when conversation_source_replication_outbox.state in ('pending', 'failed', 'quarantined')
                then now()
                else conversation_source_replication_outbox.next_attempt_at
              end,
              last_error_code = case
                when conversation_source_replication_outbox.state in ('failed', 'quarantined')
                then null
                else conversation_source_replication_outbox.last_error_code
              end,
              quarantined_at = case
                when conversation_source_replication_outbox.state in ('failed', 'quarantined')
                then null
                else conversation_source_replication_outbox.quarantined_at
              end,
              updated_at = now()
       returning (
         select source_generation_id
           from conversation_source_artifacts
          where id = conversation_source_replication_outbox.artifact_id
       ) as source_generation_id`,
      [actor.userId, input.artifactId, targetUpstreamId, input.mode]
    );
    const sourceGenerationId = result.rows[0]?.source_generation_id;
    if (!sourceGenerationId) {
      throw statusError(
        "Only an active trusted Personal source can be registered for execution transfer",
        409,
        "conversation_source_transfer_registration_not_ready"
      );
    }
    await notifyConversationSourceReplication(
      pool,
      "upload",
      sourceGenerationId
    );
    return true;
  },

  async listConversationSourceReplicationActors(input) {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const result =
      input.direction === "upload"
        ? await pool.query<{ user_id: string }>(
            `select outbox.owner_user_id as user_id
               from conversation_source_replication_outbox outbox
              where outbox.attempts < outbox.max_attempts
                and (
                  outbox.authorization_basis = 'execution_transfer'
                  or exists (
                    select 1
                      from personal_source_replication_policies policy
                     where policy.owner_user_id = outbox.owner_user_id
                       and policy.enabled = true
                       and policy.target_upstream_id = outbox.target_upstream_id
                       and policy.mode = outbox.mode
                  )
                )
                and (
                  (outbox.state in ('pending', 'failed')
                    and outbox.next_attempt_at <= now())
                  or (outbox.state = 'in_flight'
                    and outbox.lease_expires_at <= now())
                )
              group by outbox.owner_user_id
              order by min(outbox.next_attempt_at), outbox.owner_user_id
              limit $1`,
            [limit]
          )
        : await pool.query<{ user_id: string }>(
            `select artifact.owner_user_id as user_id
               from conversation_source_artifacts artifact
               left join conversation_source_consumer_cursors cursor
                 on cursor.artifact_id = artifact.id
                and cursor.consumer_kind = 'remote_processing'
              where artifact.replica_role in ('hosted_personal', 'peer_personal')
                and artifact.lifecycle in ('active', 'finalized')
                and artifact.current_journal_sequence >= 0
                and (
                  cursor.artifact_id is null
                  or (
                    cursor.failure_code is null
                    and cursor.source_offset < artifact.current_source_length
                  )
                  or (
                    cursor.next_attempt_at is not null
                    and cursor.next_attempt_at <= now()
                  )
                )
              group by artifact.owner_user_id
              order by min(artifact.updated_at), artifact.owner_user_id
              limit $1`,
            [limit]
          );
    return result.rows.map((row) => ({ userId: row.user_id }));
  },

  async getConversationSourceReplicationWakeAt() {
    const result = await pool.query<{ wake_at: Date | null }>(
      `select min(wake_at) as wake_at
         from (
           select case
                    when outbox.state = 'in_flight'
                    then outbox.lease_expires_at
                    else outbox.next_attempt_at
                  end as wake_at
             from conversation_source_replication_outbox outbox
            where outbox.attempts < outbox.max_attempts
              and outbox.state in ('pending', 'failed', 'in_flight')
              and (
                outbox.authorization_basis = 'execution_transfer'
                or exists (
                  select 1
                    from personal_source_replication_policies policy
                   where policy.owner_user_id = outbox.owner_user_id
                     and policy.enabled = true
                     and policy.target_upstream_id = outbox.target_upstream_id
                     and policy.mode = outbox.mode
                )
              )
           union all
           select case
                    when job.lease_expires_at is not null
                    then job.lease_expires_at
                    else job.next_attempt_at
                  end as wake_at
             from conversation_source_restore_jobs job
            where job.attempts < job.max_attempts
              and job.state in ('ready', 'downloading', 'materializing')
           union all
           select coalesce(cursor.next_attempt_at, now()) as wake_at
             from conversation_source_artifacts artifact
             left join conversation_source_consumer_cursors cursor
               on cursor.artifact_id = artifact.id
              and cursor.consumer_kind = 'remote_processing'
            where artifact.replica_role in ('hosted_personal', 'peer_personal')
              and artifact.lifecycle in ('active', 'finalized')
              and artifact.current_journal_sequence >= 0
              and (
                cursor.artifact_id is null
                or (
                  cursor.failure_code is null
                  and cursor.source_offset < artifact.current_source_length
                )
                or cursor.next_attempt_at is not null
              )
         ) wake`,
      []
    );
    return result.rows[0]?.wake_at?.toISOString() ?? null;
  },

  async listConversationSourceArtifactsForUpload(actor, input = {}) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const result = await pool.query<ArtifactRow>(
      `select distinct on (artifact.updated_at, artifact.id)
              ${ARTIFACT_SELECT_COLUMNS}
         from conversation_source_artifacts artifact
         join conversation_source_replication_outbox outbox
           on outbox.artifact_id = artifact.id
          and outbox.owner_user_id = artifact.owner_user_id
        where artifact.owner_user_id = $1
          and artifact.replica_role = 'origin_local'
          and artifact.lifecycle <> 'deleted'
          and outbox.state in ('pending', 'in_flight', 'failed')
          and ($2::text is null or outbox.target_upstream_id = $2)
        order by artifact.updated_at desc, artifact.id
        limit $3`,
      [actor.userId, input.targetUpstreamId ?? null, limit]
    );
    return result.rows.map(mapArtifact);
  },

  async listConversationSourceArtifactsForDownload(actor, input = {}) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const result = await pool.query<ArtifactRow>(
      `select ${ARTIFACT_SELECT_COLUMNS}
         from conversation_source_artifacts artifact
         left join conversation_source_consumer_cursors cursor
           on cursor.artifact_id = artifact.id
          and cursor.consumer_kind = 'remote_processing'
        where artifact.owner_user_id = $1
          and artifact.replica_role in ('hosted_personal', 'peer_personal')
          and ($2::conversation_source_replica_role is null
            or artifact.replica_role = $2)
          and artifact.lifecycle in ('active', 'finalized')
          and artifact.current_journal_sequence >= 0
          and (
            cursor.artifact_id is null
            or (
              cursor.failure_code is null
              and cursor.source_offset < artifact.current_source_length
            )
            or (
              cursor.next_attempt_at is not null
              and cursor.next_attempt_at <= now()
            )
          )
        order by artifact.updated_at desc, artifact.id
        limit $3`,
      [actor.userId, input.replicaRole ?? null, limit]
    );
    return result.rows.map(mapArtifact);
  },

  async listConversationSourceArtifactsForServing(actor, input) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const roles = [...new Set(input.replicaRoles)];
    if (
      roles.length === 0 ||
      roles.some(
        (role) =>
          role !== "origin_local" &&
          role !== "hosted_personal" &&
          role !== "peer_personal"
      )
    ) {
      throw statusError("Conversation source serving roles are invalid", 400);
    }
    const cursorUpdatedAt = input.cursor?.updatedAt ?? null;
    const cursorId = input.cursor?.id ?? null;
    const result = await pool.query<ArtifactRow>(
      `select ${ARTIFACT_COLUMNS}
         from conversation_source_artifacts
        where owner_user_id = $1
          and replica_role = any($2::conversation_source_replica_role[])
          and lifecycle = 'active'
          and current_journal_sequence >= 0
          and (
            $3::timestamptz is null
            or (updated_at, id) < ($3::timestamptz, $4::uuid)
          )
        order by updated_at desc, id desc
        limit $5`,
      [actor.userId, roles, cursorUpdatedAt, cursorId, limit + 1]
    );
    const page = result.rows.slice(0, limit);
    const last = page.at(-1);
    return {
      artifacts: page.map(mapArtifact),
      nextCursor:
        result.rows.length > limit && last
          ? {
              updatedAt: last.updated_at.toISOString(),
              id: last.id
            }
          : null
    };
  },

  async claimConversationSourceReplicationOutbox(actor, input) {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    if (
      !Number.isInteger(input.leaseMs) ||
      input.leaseMs < 1_000 ||
      input.leaseMs > 3_600_000
    ) {
      throw statusError("Source replication lease must be 1s to 1h", 400);
    }
    if (
      input.workerId.trim().length === 0 ||
      input.workerId.trim().length > 200
    ) {
      throw statusError("Source replication worker ID is invalid", 400);
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<OutboxRow>(
        `with candidate as (
           select outbox.id
             from conversation_source_replication_outbox outbox
             join conversation_source_artifacts artifact
               on artifact.id = outbox.artifact_id
              and artifact.owner_user_id = outbox.owner_user_id
             left join conversation_source_segments segment
               on segment.id = outbox.segment_id
              and segment.artifact_id = outbox.artifact_id
            where outbox.owner_user_id = $1
              and outbox.attempts < outbox.max_attempts
              and (
                outbox.authorization_basis = 'execution_transfer'
                or exists (
                  select 1
                    from personal_source_replication_policies policy
                   where policy.owner_user_id =
                     outbox.owner_user_id
                     and policy.enabled = true
                     and policy.target_upstream_id =
                       outbox.target_upstream_id
                     and policy.mode =
                       outbox.mode
                )
              )
              and (
                (outbox.state in ('pending', 'failed')
                  and outbox.next_attempt_at <= now())
                or (outbox.state = 'in_flight'
                  and outbox.lease_expires_at <= now())
              )
              and (
                outbox.operation_kind = 'registration'
                or
                (
                  outbox.operation_kind = 'segment'
                  and not exists (
                    select 1
                      from conversation_source_replication_outbox registration_outbox
                     where registration_outbox.owner_user_id =
                             outbox.owner_user_id
                       and registration_outbox.artifact_id = outbox.artifact_id
                       and registration_outbox.target_upstream_id =
                             outbox.target_upstream_id
                       and registration_outbox.operation_kind = 'registration'
                       and registration_outbox.state <> 'succeeded'
                  )
                  and not exists (
                    select 1
                      from conversation_source_replication_outbox prior_outbox
                      join conversation_source_segments prior_segment
                        on prior_segment.id = prior_outbox.segment_id
                       and prior_segment.artifact_id = prior_outbox.artifact_id
                     where prior_outbox.owner_user_id = outbox.owner_user_id
                       and prior_outbox.artifact_id = outbox.artifact_id
                       and prior_outbox.target_upstream_id =
                         outbox.target_upstream_id
                       and prior_outbox.operation_kind = 'segment'
                       and prior_segment.segment_index < segment.segment_index
                       and prior_outbox.state <> 'succeeded'
                  )
                )
                or (
                  outbox.operation_kind = 'closure'
                  and not exists (
                    select 1
                      from conversation_source_replication_outbox segment_outbox
                     where segment_outbox.owner_user_id = outbox.owner_user_id
                       and segment_outbox.artifact_id = outbox.artifact_id
                       and segment_outbox.target_upstream_id =
                         outbox.target_upstream_id
                       and segment_outbox.operation_kind = 'segment'
                       and segment_outbox.state <> 'succeeded'
                  )
                  and not exists (
                    select 1
                      from conversation_source_replication_outbox registration_outbox
                     where registration_outbox.owner_user_id =
                             outbox.owner_user_id
                       and registration_outbox.artifact_id = outbox.artifact_id
                       and registration_outbox.target_upstream_id =
                             outbox.target_upstream_id
                       and registration_outbox.operation_kind = 'registration'
                       and registration_outbox.state <> 'succeeded'
                  )
                )
              )
              and (
                outbox.authorization_basis <> 'execution_transfer'
                or artifact.prior_generation_closure is null
                or exists (
                  select 1
                    from conversation_source_artifacts prior_artifact
                    join conversation_source_replication_outbox prior_closure
                      on prior_closure.artifact_id = prior_artifact.id
                     and prior_closure.owner_user_id =
                       prior_artifact.owner_user_id
                     and prior_closure.operation_kind = 'closure'
                   where prior_artifact.owner_user_id = outbox.owner_user_id
                     and prior_artifact.source_generation_id =
                       (artifact.prior_generation_closure->>'sourceGenerationId')::uuid
                     and prior_closure.target_upstream_id =
                       outbox.target_upstream_id
                     and prior_closure.authorization_basis =
                       'execution_transfer'
                     and prior_closure.state = 'succeeded'
                )
              )
            order by outbox.next_attempt_at,
                     artifact.created_at,
                     case outbox.operation_kind
                       when 'registration' then 0
                       when 'segment' then 1
                       else 2
                     end,
                     coalesce(segment.segment_index, 2147483647),
                     outbox.created_at,
                     outbox.id
            for update of outbox skip locked
            limit $2
         )
         update conversation_source_replication_outbox outbox
            set state = 'in_flight',
                attempts = outbox.attempts + 1,
                lease_owner = $3,
                lease_token = gen_random_uuid(),
                lease_expires_at = now() + ($4::text::interval),
                last_error_code = null,
                updated_at = now()
           from candidate
          where outbox.id = candidate.id
          returning ${OUTBOX_SELECT_COLUMNS}`,
        [
          actor.userId,
          limit,
          input.workerId.trim(),
          `${input.leaseMs} milliseconds`
        ]
      );
      const claims: ConversationSourceReplicationOutboxClaimRecord[] = [];
      for (const row of result.rows) {
        const artifact = await client.query<ArtifactRow>(
          `select ${ARTIFACT_COLUMNS}
             from conversation_source_artifacts
            where id = $2 and owner_user_id = $1`,
          [actor.userId, row.artifact_id]
        );
        const segment =
          row.operation_kind === "segment" && row.segment_id
            ? await client.query<SegmentRow>(
                `select ${SEGMENT_COLUMNS}
                   from conversation_source_segments
                  where id = $1 and artifact_id = $2`,
                [row.segment_id, row.artifact_id]
              )
            : null;
        if (
          !artifact.rows[0] ||
          (row.operation_kind === "segment" && !segment?.rows[0]) ||
          (row.operation_kind === "closure" &&
            (artifact.rows[0].lifecycle !== "finalized" ||
              !artifact.rows[0].closure_hash))
        ) {
          throw new Error("Claimed source replication outbox row is orphaned");
        }
        claims.push({
          ...mapOutbox(row),
          artifact: mapArtifact(artifact.rows[0]),
          segment: segment?.rows[0] ? mapSegment(segment.rows[0]) : null
        });
      }
      await client.query("commit");
      return claims;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async renewConversationSourceReplicationOutboxLease(actor, input) {
    if (
      !Number.isInteger(input.leaseMs) ||
      input.leaseMs < 1_000 ||
      input.leaseMs > 3_600_000
    ) {
      throw statusError("Source replication lease must be 1s to 1h", 400);
    }
    const result = await pool.query<OutboxRow>(
      `update conversation_source_replication_outbox
          set lease_expires_at = now() + ($4::text::interval),
              updated_at = now()
        where id = $2
          and owner_user_id = $1
          and state = 'in_flight'
          and lease_token = $3
          and lease_expires_at > now()
        returning ${OUTBOX_COLUMNS}`,
      [
        actor.userId,
        input.outboxId,
        input.leaseToken,
        `${input.leaseMs} milliseconds`
      ]
    );
    if (!result.rows[0]) {
      throw statusError(
        "Source replication outbox lease conflict",
        409,
        "conversation_source_replication_lease_conflict"
      );
    }
    return mapOutbox(result.rows[0]);
  },

  async completeConversationSourceReplicationOutbox(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<
        OutboxRow & { source_generation_id: string }
      >(
        `update conversation_source_replication_outbox outbox
          set state = 'succeeded',
              lease_owner = null,
              lease_token = null,
              lease_expires_at = null,
              last_error_code = null,
              succeeded_at = now(),
              updated_at = now()
         from conversation_source_artifacts artifact
        where outbox.id = $2
          and outbox.owner_user_id = $1
          and outbox.state = 'in_flight'
          and outbox.lease_token = $3
          and outbox.lease_expires_at > now()
          and artifact.id = outbox.artifact_id
        returning ${OUTBOX_SELECT_COLUMNS},
                  artifact.source_generation_id`,
        [actor.userId, input.outboxId, input.leaseToken]
      );
      if (!result.rows[0]) {
        throw statusError(
          "Source replication outbox lease conflict",
          409,
          "conversation_source_replication_lease_conflict"
        );
      }
      await notifyConversationSourceReplication(
        client,
        "upload",
        result.rows[0].source_generation_id
      );
      await client.query("commit");
      return mapOutbox(result.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async failConversationSourceReplicationOutbox(actor, input) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.errorCode)) {
      throw statusError("Source replication error code is invalid", 400);
    }
    const retryAt = input.retryAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(retryAt))) {
      throw statusError("Source replication retry time is invalid", 400);
    }
    const result = await pool.query<OutboxRow>(
      `update conversation_source_replication_outbox
          set state = case
                when $4 then 'quarantined'::conversation_source_replication_outbox_state
                else 'failed'::conversation_source_replication_outbox_state
              end,
              next_attempt_at = $5,
              lease_owner = null,
              lease_token = null,
              lease_expires_at = null,
              last_error_code = $6,
              quarantined_at = case when $4 then now() else null end,
              updated_at = now()
        where id = $2
          and owner_user_id = $1
          and state = 'in_flight'
          and lease_token = $3
          and lease_expires_at > now()
        returning ${OUTBOX_COLUMNS}`,
      [
        actor.userId,
        input.outboxId,
        input.leaseToken,
        input.quarantine === true,
        retryAt,
        input.errorCode
      ]
    );
    if (!result.rows[0]) {
      throw statusError(
        "Source replication outbox lease conflict",
        409,
        "conversation_source_replication_lease_conflict"
      );
    }
    if (result.rows[0].state === "failed") {
      await notifyConversationSourceReplication(pool, "retry");
    }
    return mapOutbox(result.rows[0]);
  },

  async updateConversationSourceOriginKeyStatus(actor, input) {
    const result = await pool.query<ArtifactRow>(
      `update conversation_source_artifacts
          set origin_key_status = $3,
              updated_at = now()
        where id = $2
          and owner_user_id = $1
          and origin_key_status <> 'revoked'
          and (
            origin_key_status = 'active'
            or (origin_key_status = 'lost' and $3 = 'revoked')
          )
        returning ${ARTIFACT_COLUMNS}`,
      [actor.userId, input.artifactId, input.status]
    );
    if (result.rows[0]) {
      return mapArtifact(result.rows[0]);
    }
    const existing = await pool.query<ArtifactRow>(
      `select ${ARTIFACT_COLUMNS}
         from conversation_source_artifacts
        where id = $2 and owner_user_id = $1
        limit 1`,
      [actor.userId, input.artifactId]
    );
    if (!existing.rows[0]) {
      throw statusError("Conversation source artifact not found", 404);
    }
    if (existing.rows[0].origin_key_status === input.status) {
      return mapArtifact(existing.rows[0]);
    }
    throw statusError(
      "Conversation source origin key status cannot move backwards",
      409,
      "conversation_source_origin_key_status_conflict"
    );
  },

  async createConversationSourceDownloadAuthorization(actor, input) {
    assertStrictJsonRecord(input.recipientKey, "Source download recipient key");
    if (!/^[0-9a-f]{64}$/.test(input.capabilityHash)) {
      throw statusError("Source download capability hash is invalid", 400);
    }
    if (
      !Number.isInteger(input.firstSegmentIndex) ||
      input.firstSegmentIndex < 0
    ) {
      throw statusError("Source download segment boundary is invalid", 400);
    }
    const expiresAt = Date.parse(input.expiresAt);
    const now = Date.now();
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + CONVERSATION_SOURCE_DOWNLOAD_AUTHORIZATION_TTL_MS
    ) {
      throw statusError("Source download expiry is invalid", 400);
    }
    const result = await pool.query<DownloadAuthorizationRow>(
      `insert into conversation_source_download_authorizations (
         owner_user_id,
         device_credential_id,
         artifact_id,
         recipient_key,
         capability_hash,
         first_segment_index,
         last_segment_index,
         expires_at
       )
       select artifact.owner_user_id,
              credential.id,
              artifact.id,
              $4::jsonb,
              $5,
              $6,
              artifact.current_journal_sequence,
              $7
         from conversation_source_artifacts artifact
         join device_credentials credential
           on credential.id = $3
          and credential.owner_user_id = artifact.owner_user_id
          and credential.revoked_at is null
          and (credential.expires_at is null or credential.expires_at > now())
          and ('sync' = any(credential.operation_families)
            or '*' = any(credential.operation_families))
        where artifact.owner_user_id = $1
          and artifact.id = $2
          and artifact.replica_role = 'hosted_personal'
          and artifact.lifecycle in ('active', 'finalized')
          and artifact.current_journal_sequence >= $6 - 1
       returning
         id,
         owner_user_id,
         device_credential_id,
         artifact_id,
         recipient_key,
         first_segment_index,
         last_segment_index,
         created_at,
         expires_at,
         last_used_at,
         revoked_at,
         revocation_reason`,
      [
        actor.userId,
        input.artifactId,
        input.deviceCredentialId,
        input.recipientKey,
        input.capabilityHash,
        input.firstSegmentIndex,
        input.expiresAt
      ]
    );
    if (!result.rows[0]) {
      throw statusError(
        "Source download authorization is unavailable",
        409,
        "conversation_source_download_unavailable"
      );
    }
    return mapDownloadAuthorization(result.rows[0]);
  },

  async getConversationSourceDownloadAuthorization(actor, input) {
    const result = await pool.query<DownloadAuthorizationRow>(
      `select download_auth.id,
              download_auth.owner_user_id,
              download_auth.device_credential_id,
              download_auth.artifact_id,
              download_auth.recipient_key,
              download_auth.first_segment_index,
              download_auth.last_segment_index,
              download_auth.created_at,
              download_auth.expires_at,
              download_auth.last_used_at,
              download_auth.revoked_at,
              download_auth.revocation_reason
         from conversation_source_download_authorizations download_auth
         join device_credentials credential
           on credential.id = download_auth.device_credential_id
          and credential.owner_user_id = download_auth.owner_user_id
          and credential.revoked_at is null
          and (credential.expires_at is null or credential.expires_at > now())
         join conversation_source_artifacts artifact
           on artifact.id = download_auth.artifact_id
          and artifact.owner_user_id = download_auth.owner_user_id
          and artifact.lifecycle in ('active', 'finalized')
          and artifact.replica_role = 'hosted_personal'
        where download_auth.owner_user_id = $1
          and download_auth.id = $2
          and download_auth.device_credential_id = $3
          and download_auth.capability_hash = $4
          and download_auth.revoked_at is null
          and download_auth.expires_at > now()
        limit 1`,
      [
        actor.userId,
        input.authorizationId,
        input.deviceCredentialId,
        input.capabilityHash
      ]
    );
    return result.rows[0] ? mapDownloadAuthorization(result.rows[0]) : null;
  },

  async touchConversationSourceDownloadAuthorization(actor, authorizationId) {
    const result = await pool.query(
      `update conversation_source_download_authorizations
          set last_used_at = now()
        where id = $2
          and owner_user_id = $1
          and revoked_at is null
          and expires_at > now()`,
      [actor.userId, authorizationId]
    );
    return (result.rowCount ?? 0) === 1;
  },

  async createConversationSourceRestoreJob(actor, input) {
    const result = await pool.query<RestoreJobRow>(
      `insert into conversation_source_restore_jobs (
         owner_user_id, upstream_backend_id, source_generation_id,
         target_deployment_id, recipient_key_id, recipient_key_version,
         action_grant_id, next_segment_index
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (
         owner_user_id, upstream_backend_id, source_generation_id,
         target_deployment_id
       ) do update set updated_at = now()
       where conversation_source_restore_jobs.state in (
         'awaiting_approval','ready','downloading','materializing','completed'
       )
       returning ${RESTORE_JOB_COLUMNS}`,
      [
        actor.userId,
        input.upstreamBackendId,
        input.sourceGenerationId,
        input.targetDeploymentId,
        input.recipientKeyId,
        input.recipientKeyVersion,
        input.actionGrantId,
        input.firstSegmentIndex
      ]
    );
    if (!result.rows[0]) {
      throw statusError("Conversation source restore identity conflicts", 409);
    }
    return mapRestoreJob(result.rows[0]);
  },

  async getConversationSourceRestoreJob(actor, restoreJobId) {
    const result = await pool.query<RestoreJobRow>(
      `select ${RESTORE_JOB_COLUMNS}
         from conversation_source_restore_jobs
        where owner_user_id = $1 and id = $2
        limit 1`,
      [actor.userId, restoreJobId]
    );
    return result.rows[0] ? mapRestoreJob(result.rows[0]) : null;
  },

  async activateConversationSourceRestoreJob(actor, input) {
    if (!options.envelopeEncryptionProvider) {
      throw statusError(
        "Source restore capability encryption is unavailable",
        503
      );
    }
    if (!/^csd_[A-Za-z0-9_-]{43}$/.test(input.capability)) {
      throw statusError("Source restore capability is invalid", 400);
    }
    const envelope = await options.envelopeEncryptionProvider.encrypt({
      plaintext: JSON.stringify({ capability: input.capability }),
      scope: {
        tenantId: actor.userId,
        objectClass: "conversation_source_download_capability"
      },
      provenance: {
        rowFamily: "conversation_source_restore_jobs",
        sourceId: input.restoreJobId
      },
      ciphertextLocation:
        "conversation_source_restore_jobs.encrypted_capability",
      aad: {
        ownerUserId: actor.userId,
        restoreJobId: input.restoreJobId,
        actionGrantId: input.actionGrantId,
        remoteAuthorizationId: input.remoteAuthorizationId
      }
    });
    const result = await pool.query<RestoreJobRow>(
      `update conversation_source_restore_jobs
          set state = 'ready',
              remote_authorization_id = $4,
              encrypted_capability = $5::jsonb,
              registration = $6::jsonb,
              source_descriptor = $7::jsonb,
              source_closure = $8::jsonb,
              next_segment_index = $9,
              last_segment_index = $10,
              last_error_code = null,
              updated_at = now()
        where owner_user_id = $1
          and id = $2
          and action_grant_id = $3
          and state = 'awaiting_approval'
      returning ${RESTORE_JOB_COLUMNS}`,
      [
        actor.userId,
        input.restoreJobId,
        input.actionGrantId,
        input.remoteAuthorizationId,
        envelope,
        input.registration,
        input.sourceDescriptor,
        input.sourceClosure ?? null,
        input.firstSegmentIndex,
        input.lastSegmentIndex
      ]
    );
    if (!result.rows[0]) {
      throw statusError(
        "Conversation source restore activation conflicted",
        409
      );
    }
    await notifyConversationSourceReplication(pool, "restore");
    return mapRestoreJob(result.rows[0]);
  },

  async claimConversationSourceRestoreJobs(input) {
    if (!options.envelopeEncryptionProvider) return [];
    const leaseToken = randomUUID();
    const limit = Math.min(Math.max(input.limit ?? 4, 1), 16);
    const result = await pool.query<RestoreJobRow>(
      `with candidates as (
         select id
           from conversation_source_restore_jobs
          where state in ('ready','downloading','materializing')
            and attempts < max_attempts
            and next_attempt_at <= now()
            and (lease_expires_at is null or lease_expires_at <= now())
          order by updated_at, id
          for update skip locked
          limit $1
       )
       update conversation_source_restore_jobs job
          set state = case
                when job.state = 'ready' then 'downloading'
                else job.state
              end,
              attempts = job.attempts + 1,
              lease_owner = $2,
              lease_token = $3,
              lease_expires_at =
                now() + ($4::bigint * interval '1 millisecond'),
              updated_at = now()
         from candidates
        where job.id = candidates.id
      returning job.*`,
      [limit, input.workerId, leaseToken, input.leaseMs]
    );
    const claims: ClaimedConversationSourceRestoreJob[] = [];
    for (const row of result.rows) {
      if (!row.encrypted_capability) {
        throw statusError("Source restore capability is unavailable", 409);
      }
      const plaintext = await decryptEnvelopeToUtf8(
        options.envelopeEncryptionProvider,
        row.encrypted_capability as unknown as EncryptedPayloadEnvelope
      );
      const payload = JSON.parse(plaintext) as { capability?: unknown };
      if (
        typeof payload.capability !== "string" ||
        !/^csd_[A-Za-z0-9_-]{43}$/.test(payload.capability)
      ) {
        throw statusError("Source restore capability is invalid", 409);
      }
      claims.push({ ...mapRestoreJob(row), capability: payload.capability });
    }
    return claims;
  },

  async renewConversationSourceRestoreJobLease(input) {
    const result = await pool.query(
      `update conversation_source_restore_jobs
          set lease_expires_at =
                now() + ($4::bigint * interval '1 millisecond'),
              updated_at = now()
        where id = $1
          and lease_token = $2
          and lease_owner = $3
          and state in ('downloading','materializing')
          and lease_expires_at > now()`,
      [input.restoreJobId, input.leaseToken, input.workerId, input.leaseMs]
    );
    return (result.rowCount ?? 0) === 1;
  },

  async advanceConversationSourceRestoreJob(actor, input) {
    const result = await pool.query<RestoreJobRow>(
      `update conversation_source_restore_jobs
          set next_segment_index = $4,
              state = coalesce($5, state),
              lease_expires_at = now() + interval '3 minutes',
              updated_at = now()
        where owner_user_id = $1
          and id = $2
          and lease_token = $3
          and state in ('downloading','materializing')
          and $4 >= next_segment_index
          and $4 <= coalesce(last_segment_index + 1, $4)
      returning ${RESTORE_JOB_COLUMNS}`,
      [
        actor.userId,
        input.restoreJobId,
        input.leaseToken,
        input.nextSegmentIndex,
        input.state ?? null
      ]
    );
    if (!result.rows[0]) {
      throw statusError("Conversation source restore cursor conflicted", 409);
    }
    return mapRestoreJob(result.rows[0]);
  },

  async completeConversationSourceRestoreJob(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<RestoreJobRow>(
        `update conversation_source_restore_jobs
            set state = 'completed',
                lease_owner = null,
                lease_token = null,
                lease_expires_at = null,
                completed_at = now(),
                last_error_code = null,
                updated_at = now()
          where owner_user_id = $1
            and id = $2
            and lease_token = $3
            and state = 'materializing'
            and next_segment_index > coalesce(last_segment_index, -1)
        returning ${RESTORE_JOB_COLUMNS}`,
        [actor.userId, input.restoreJobId, input.leaseToken]
      );
      const row = result.rows[0];
      if (!row) {
        throw statusError(
          "Conversation source restore completion conflicted",
          409
        );
      }
      await notifyConversationSourceReplication(
        client,
        "materialize",
        row.source_generation_id
      );
      await client.query("commit");
      return mapRestoreJob(row);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async failConversationSourceRestoreJob(actor, input) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(input.errorCode)) {
      throw statusError("Source restore error code is invalid", 400);
    }
    const nextAttemptAt = input.retryAt ?? new Date().toISOString();
    if (
      Number.isNaN(Date.parse(nextAttemptAt)) ||
      new Date(nextAttemptAt).toISOString() !== nextAttemptAt
    ) {
      throw statusError("Source restore retry time is invalid", 400);
    }
    const result = await pool.query<RestoreJobRow>(
      `update conversation_source_restore_jobs
          set state = case
                when $5 and attempts < max_attempts then 'ready'
                else 'failed'
              end,
              next_attempt_at = $6,
              lease_owner = null,
              lease_token = null,
              lease_expires_at = null,
              last_error_code = $4,
              updated_at = now()
        where owner_user_id = $1
          and id = $2
          and lease_token = $3
      returning ${RESTORE_JOB_COLUMNS}`,
      [
        actor.userId,
        input.restoreJobId,
        input.leaseToken,
        input.errorCode,
        input.retry,
        nextAttemptAt
      ]
    );
    if (!result.rows[0]) {
      throw statusError("Conversation source restore failure conflicted", 409);
    }
    if (result.rows[0].state === "ready") {
      await notifyConversationSourceReplication(pool, "retry");
    }
    return mapRestoreJob(result.rows[0]);
  }
});
