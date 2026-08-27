import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  structuredLcmSummarySchema
} from "@koed/core";
import {
  capturedSessionSourceFrontierHash,
  classifyApprovalActivity,
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  logicalMemorySourceRevisionIdentity,
  privacyClassificationResultManifestHash,
  sharedMemoryGrantScopedSourceId,
  sharedMemorySourceCanReplace,
  sharedMemorySourceRefSchema,
  sharedSourceArtifactHash,
  sharedSourceArtifactId,
  sharedSourcePreviewHash,
  sharedSourcePreviewId,
  intersectSharedMemoryFidelityCeilings,
  sharedMemoryCeilingAuthorizes,
  sharedMemoryRepresentationsForCeiling,
  extractSharedMemorySemanticClassificationFields,
  sharedMemoryRepresentations,
  SharedMemoryConflictError,
  SharedMemorySemanticResourceLimitError,
  SharedMemorySourceItemRejectedError,
  teamSemanticEmbeddingGeneration,
  validateSharedMemoryCanonicalSourceItem,
  validateSharedMemorySemanticSanitizedReconstruction,
  SHARED_MEMORY_AUTHORITY_ACTION,
  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_BYTES,
  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_FIELDS,
  SHARED_SOURCE_ARTIFACT_SCHEMA_VERSION,
  SHARED_SOURCE_PREVIEW_SCHEMA_VERSION,
  type SharedSourceArtifactReference,
  type SharedSourceArtifactV1,
  type SharedSourcePreviewReference,
  type SharedSourcePreviewV1,
  type SharedMemorySourceRef,
  type SharedMemoryCandidatePreview,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type SharedMemoryFidelityCeiling,
  type SharedMemoryCanonicalSourceItemDto,
  type SharedMemoryRepresentation,
  type SharedMemorySemanticClassificationField,
  type SharedMemorySourceItemInput,
  type SharedMemorySourceItemType
} from "@koed/shared";
import {
  decryptAuthorizedEncryptedFieldPayloadWithClient,
  decryptAuthorizedEncryptedFieldPayloadsWithClient,
  decryptOwnerPrivateEncryptedFieldWithClient,
  decryptTeamEncryptedFieldAfterAuthorizationWithClient,
  encryptedFieldReferenceKey,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import {
  assertionSelect,
  type AssertionRow
} from "./curated-memory-support.js";
import { sessionExactCuratedAssertionSql } from "./approval-activity-sql.js";
import {
  buildCapturedSessionSyncContributor,
  buildCapturedSessionSyncEvent,
  capturedSessionSyncContentFromUnknown,
  canonicalSyncJsonObject
} from "./cross-identity-sync-canonical.js";

import type { ActorContext } from "./types.js";
import { sharedMemoryPolicyHash } from "./shared-memory-policy.js";
import {
  cancelShareGrantRevocationRetentionWithClient,
  lockShareGrantRetentionScopeWithClient,
  scheduleShareGrantRevocationRetentionWithClient
} from "./retention-lifecycle-repository.js";

import {
  resolveMonotonicPrivacyPolicySet,
  type PrivacyContentPolicyRecord
} from "./privacy-classification-repository.js";
import {
  decidePendingShareSourceReadiness,
  type PendingShareSourceReadinessDecision
} from "./pending-share-processing-workflow.js";

const SEMANTIC_PRIVACY_FINALIZATION_ADVISORY_LOCK = [
  1_263_485_252, 1_179_802_737
] as const;

export const SHARED_MEMORY_AUTHORITY = SHARED_MEMORY_AUTHORITY_ACTION;
export const SHARED_MEMORY_PRIVACY_BACKGROUND_MAX_WAIT_MS = 120_000;

export type SharedMemoryConsentMode = "snapshot" | "continuous";
export type SharedMemoryConsentState =
  | "pending"
  | "active"
  | "paused"
  | "revoked"
  | "expired";
export type SharedMemoryGrantLifecycle =
  | "active"
  | "unavailable"
  | "revoked"
  | "tombstoned"
  | "purge_pending"
  | "purged";
export type SharedMemoryRepresentationState =
  | "pending"
  | "available"
  | "stale"
  | "invalidated"
  | "purge_pending"
  | "purged";
export type SharedMemorySemanticPreviewStatus =
  | "pending"
  | "ready"
  | "failed"
  | "stale"
  | "invalidated";

export interface SharedMemoryAuthorityContext {
  action: typeof SHARED_MEMORY_AUTHORITY;
  source: "browser_session" | "device_action_grant";
  referenceId: string;
}

export interface SharedMemoryCompanionScopeDto {
  scope: "team";
  kind: "shared_session_discussion";
  teamId: string;
  teamWorkspaceId: string;
  logicalMemoryId: string;
  shareGrantId: string;
}

export interface SharedMemoryPolicyRecord {
  id: string;
  policyId: string;
  scope: "source_owner" | "team" | "workspace";
  logicalMemoryId: string | null;
  sourceOwnerPrincipalId: string | null;
  teamId: string | null;
  teamWorkspaceId: string | null;
  version: number;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  policyHash: string;
  effectiveAt: string;
  supersededAt: string | null;
}

export interface SharedMemorySourceBindingDto {
  sourceRevision: number;
  sourceHash: string;
  fidelityPolicyRevision: number;
  fidelityPolicyHash: string;
  contentPolicyVersion: number;
  contentPolicyHash: string;
  classifierVersion: number;
  classifierHash: string;
}

export interface SharedMemoryCandidatePreviewRecord {
  previewId: string;
  previewHash: string;
  previewRevision: 1;
  logicalMemoryId: string;
  source: SharedMemorySourceRef;
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  sourceRevision: number;
  sourceHash: string;
  redactedContentHash: string;
  representationPolicyRevision: number;
  representationPolicyHash: string;
  contentPolicyVersion: number;
  contentPolicyHash: string;
  classifierVersion: number;
  classifierHash: string;
  mode: SharedMemoryConsentMode;
  expiresAt: string | null;
  previewExpiresAt: string;
  itemCount: number;
  excludedItemCount: number;
  manifest: Array<{ sourceId: string; revisionHash: string }>;
  manifestHash: string;
  byteCount: number;
  createdAt: string;
}

export interface PendingShareRecord {
  id: string;
  mutationId: string;
  logicalGrantId: string;
  consentId: string;
  logicalMemoryId: string;
  source: SharedMemorySourceRef;
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  mode: SharedMemoryConsentMode;
  sourceRevision: number;
  state: "preparing" | "needs_attention" | "failed" | "activated" | "revoked";
  stage:
    | "accepted"
    | "syncing"
    | "uploading"
    | "processing"
    | "activating"
    | "privacy_filtering"
    | "complete";
  workspaceAccessState: "none" | "active" | "revoked";
  sourceUpdateState: "preparing" | "active" | "paused" | "failed" | "stopped";
  operationVersion: number;
  attemptCount: number;
  redactedFailureCode: string | null;
  lastProgressAt: string;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
  grantId: string | null;
  grantVersion?: number | null;
}

export type OwnedShareRecord =
  | {
      kind: "pending";
      pendingShare: PendingShareRecord;
      sourceAccess: OwnedConversationSourceAccessSummary;
      summary: OwnedShareSummary;
    }
  | {
      kind: "grant";
      grant: SharedMemoryGrantRecord;
      sourceAccess: OwnedConversationSourceAccessSummary;
      summary: OwnedShareSummary;
    };

export interface OwnedShareSummary {
  source: SharedMemorySourceRef;
  sourceSessionId: string | null;
  companionThreadId: string | null;
  sourceTitle: string;
  teamName: string;
  workspaceName: string;
  workspaceContentAccess: "available" | "unavailable";
  mode: "snapshot" | "continuous";
  authorizedPreview: {
    previewId: string;
    previewHash: string;
    previewRevision: number;
    sourceRevision: number;
  } | null;
  lastReadyRevision: number | null;
  lastSuccessfulUpdateAt: string | null;
}

export type OwnedConversationSourceAccessSummary = {
  mode: "snapshot" | "continuous";
  lifecycle: "active" | "revoked";
  version: number;
} | null;

type SharedMemoryEventOrder = {
  occurredAt: string | null;
  sourceCursor: number;
  eventId: string;
};

export const compareSharedMemoryEventOrder = (
  left: SharedMemoryEventOrder,
  right: SharedMemoryEventOrder
): number =>
  (left.occurredAt ?? "").localeCompare(right.occurredAt ?? "") ||
  left.sourceCursor - right.sourceCursor ||
  left.eventId.localeCompare(right.eventId);

export interface SharedMemoryDeviceProvenanceBinding {
  syncRelationshipId: string;
  deviceCredentialId: string;
  credentialKeyId: string;
  upstreamBackendId: string;
  deviceInstanceId: string;
  lineageId: string;
  credentialVersion: number;
  verifierKind: string;
  verifierHash: string | null;
  publicKeyJwk: unknown;
}

export const sharedMemoryDeviceProvenanceHash = (
  binding: SharedMemoryDeviceProvenanceBinding
): string => crossIdentitySyncDigest(binding);

export interface SharedMemoryPreviewDto {
  representation: SharedMemoryRepresentation;
  logicalMemoryId: string;
  binding: SharedMemorySourceBindingDto;
  items: SharedMemoryCanonicalSourceItemDto[];
  sourceContentHash: string;
  previewHash: string;
}

export interface SharedMemorySourceArtifactRecord extends SharedSourceArtifactReference {
  source: SharedMemorySourceRef;
  sourceRevisionId: string;
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  logicalMemoryId: string;
  remoteReplicaId: string | null;
  syncRelationshipId: string | null;
  ownerUserId: string | null;
  ownerPrincipalId: string;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  sourceRevision: number;
  sourceCursor: number;
  packageSequence: number;
  sourceHash: string;
  manifestHash: string;
  sourceContentHash: string;
  sourceOwnerPolicyId: string;
  sourceOwnerPolicyVersion: number;
  teamPolicyId: string;
  teamPolicyVersion: number;
  workspacePolicyId: string;
  workspacePolicyVersion: number;
  representationPolicyRevision: number;
  representationPolicyHash: string;
  contentPolicyVersion: number;
  contentPolicyHash: string;
  classifierVersion: number;
  classifierHash: string;
  sourceDeploymentIdentityId: string;
  remoteUserIdentityId: string;
  deviceCredentialId: string;
  deviceProvenanceHash: string;
  createdAt: string;
}

export interface SharedMemoryPersistedPreviewRecord extends SharedSourcePreviewReference {
  source: SharedMemorySourceRef;
  sourceRevisionId: string;
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  mode: SharedMemoryConsentMode;
  artifactId: string;
  artifactHash: string;
  logicalMemoryId: string;
  remoteReplicaId: string | null;
  ownerUserId: string | null;
  ownerPrincipalId: string;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  previewRevision: number;
  binding: SharedMemorySourceBindingDto;
  items: SharedMemoryCanonicalSourceItemDto[];
  sourceContentHash: string;
  manifest: SharedSourceArtifactV1["manifest"];
  manifestHash: string;
  sourceRevision: number;
  sourceHash: string;
  syncRelationshipId: string | null;
  deviceProvenanceHash: string;
  createdAt: string;
}

export interface SharedMemorySemanticPreviewRecord {
  id: string;
  sourcePreviewId: string;
  sourceArtifactId: string;
  sourcePreviewRevision: number;
  sourcePreviewHash: string;
  sourceArtifactHash: string;
  sourceManifestHash: string;
  sourceRevision: number;
  sourceHash: string;
  logicalMemoryId: string;
  ownerUserId: string;
  ownerPrincipalId: string;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  expectedManifestHash: string | null;
  expectedChunkCount: number | null;
  completedChunkCount: number;
  resultManifestHash: string | null;
  classificationFieldCount: number | null;
  classificationByteCount: number | null;
  classifierGenerationId: string;
  classifierVersion: number;
  classifierHash: string;
  effectivePrivacyPolicyHash: string;
  sourceItemIdentityHash: string | null;
  sourceItemCount: number | null;
  sanitizedContentHash: string | null;
  payloadBindingHash: string | null;
  status: SharedMemorySemanticPreviewStatus;
  failureCode: string | null;
  lastErrorClass: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  schedulingClass: "foreground" | "background";
  workReason:
    | "share_activation"
    | "source_revision_classification"
    | "policy_remasking"
    | "classifier_rematerialization"
    | "background_repair";
  eligibleAt: string;
  enqueuedAt: string;
  continuationChunkIndex: number;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  failedAt: string | null;
  staleAt: string | null;
  invalidatedAt: string | null;
  invalidationReasonCode: string | null;
}

export interface SharedMemorySemanticClassificationChunkRecord {
  id: string;
  semanticPreviewId: string;
  chunkIndex: number;
  firstFieldIndex: number;
  fieldCount: number;
  inputIdentityHash: string;
  orderedInputHash: string;
  classificationResultId: string | null;
  classificationPayloadBindingHash: string | null;
  status: "pending" | "ready";
  createdAt: string;
  readyAt: string | null;
}

export interface SharedMemorySemanticPrivacyClaim {
  semanticPreviewId: string;
  workIdentity: string;
  claimantId: string;
  claimGeneration: number;
  claimToken: string;
  expiresAt: string;
}

export interface SharedMemorySemanticPrivacyFinalizationLease {
  release(): Promise<void>;
}

export interface SharedMemorySemanticPrivacyBacklogDiagnostics {
  counts: {
    pending: number;
    leased: number;
    deferred: number;
    ready: number;
    failed: number;
    stale: number;
    invalidated: number;
  };
  bySchedulingClass: Record<"foreground" | "background", number>;
  byWorkReason: Record<
    | "share_activation"
    | "source_revision_classification"
    | "policy_remasking"
    | "classifier_rematerialization"
    | "background_repair",
    number
  >;
  oldestBackgroundWaitMs: number | null;
  completionEstimate: {
    status: "unavailable";
    reason: "insufficient_measured_throughput";
  };
}

export interface SharedMemoryPendingSemanticTarget extends SharedMemorySemanticPreviewRecord {
  status: "pending";
  shareGrantId: string;
  consentId: string;
  grantVersion: number;
}

export interface SharedMemoryDecryptedSemanticTarget {
  target: SharedMemoryPendingSemanticTarget;
  preview: SharedMemoryPersistedPreviewRecord;
  sourceManifest: SharedSourceArtifactV1["manifest"];
  sourceItemIdentityHash: string;
  classificationFields: SharedMemorySemanticClassificationField[];
}

export interface SharedMemorySemanticEmbeddingSourceBinding {
  sourceItemIndex: number;
  originalInputHash: string;
  sanitizedInputHash: string;
  inputUnchanged: boolean;
  personalSourceType: "memory_event" | "memory_node" | "curated_memory" | null;
  personalSourceId: string | null;
}

export interface SharedMemorySanitizedSemanticPreviewPayload {
  schemaVersion: 1;
  semanticPreviewId: string;
  sourcePreviewId: string;
  sourceArtifactId: string;
  sourcePreviewRevision: number;
  sourcePreviewHash: string;
  sourceArtifactHash: string;
  sourceManifestHash: string;
  sourceRevision: number;
  sourceHash: string;
  logicalMemoryId: string;
  ownerUserId: string;
  ownerPrincipalId: string;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  expectedManifestHash: string;
  expectedChunkCount: number;
  resultManifestHash: string;
  classifierGenerationId: string;
  classifierVersion: number;
  classifierHash: string;
  effectivePrivacyPolicyHash: string;
  sourceItemIdentityHash: string;
  sourceItemCount: number;
  sanitizedContentHash: string;
  displayTitle: string;
  items: SharedMemoryCanonicalSourceItemDto[];
  embeddingSourceBindings: SharedMemorySemanticEmbeddingSourceBinding[];
}

export interface SharedMemoryConsentRecord {
  source: SharedMemorySourceRef;
  sourceRevisionId: string;
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  id: string;
  previewId: string;
  logicalMemoryId: string;
  remoteReplicaId: string | null;
  sourceOwnerPrincipalId: string;
  teamId: string;
  teamWorkspaceId: string;
  sourceOwnerPolicyId: string;
  sourceOwnerPolicyVersion: number;
  teamPolicyId: string;
  teamPolicyVersion: number;
  workspacePolicyId: string;
  workspacePolicyVersion: number;
  mode: SharedMemoryConsentMode;
  state: SharedMemoryConsentState;
  consentVersion: number;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  previewRevision: number;
  previewHash: string;
  sourceRevision: number;
  maximumAuthorizedSourceRevision: number | null;
  sourceHash: string;
  fidelityPolicyRevision: number;
  fidelityPolicyHash: string;
  contentPolicyVersion: number;
  contentPolicyHash: string;
  classifierVersion: number;
  classifierHash: string;
  sourceContentHash: string;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
}

export interface SharedMemoryGrantRecord {
  source: SharedMemorySourceRef;
  sourceRevisionId: string;
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  mode: SharedMemoryConsentMode;
  id: string;
  logicalGrantId: string;
  logicalMemoryId: string;
  remoteReplicaId: string | null;
  ownerUserId: string | null;
  ownerPrincipalId: string;
  sessionId: string | null;
  displayTitle: string | null;
  teamId: string;
  teamWorkspaceId: string;
  consentId: string;
  sourceOwnerPolicyId: string;
  sourceOwnerPolicyVersion: number;
  teamPolicyId: string;
  teamPolicyVersion: number;
  workspacePolicyId: string;
  workspacePolicyVersion: number;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  fidelityPolicyRevision: number;
  contentPolicyVersion: number;
  classifierVersion: number;
  sourceRevision: number;
  grantVersion: number;
  lifecycle: SharedMemoryGrantLifecycle;
  creatorAuthority: string;
  grantedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  companionScope: SharedMemoryCompanionScopeDto;
}

export interface SharedMemoryRepresentationRecord {
  source: SharedMemorySourceRef;
  sourceRevisionId: string;
  id: string;
  shareGrantId: string;
  consentId: string;
  sourcePreviewId: string;
  sourceArtifactId: string;
  sanitizedSourcePreviewId: string;
  privacyClassifierGenerationId: string;
  privacyClassifierHash: string;
  effectivePrivacyPolicyHash: string;
  sourceManifestHash: string;
  sanitizedContentHash: string;
  teamId: string;
  teamWorkspaceId: string;
  logicalMemoryId: string;
  representation: SharedMemoryRepresentation;
  sourceRevision: number;
  sourceRevisionHash: string;
  provenanceHash: string;
  sourceOwnerPolicyId: string;
  sourceOwnerPolicyVersion: number;
  teamPolicyId: string;
  teamPolicyVersion: number;
  workspacePolicyId: string;
  workspacePolicyVersion: number;
  fidelityPolicyRevision: number;
  contentPolicyVersion: number;
  classifierVersion: number;
  recordVersion: number;
  state: SharedMemoryRepresentationState;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
  availableAt: string | null;
  staleAt: string | null;
  invalidatedAt: string | null;
  invalidationReasonCode: string | null;
}

export interface SharedMemoryReadResult {
  grant: SharedMemoryGrantRecord;
  representation: SharedMemoryRepresentationRecord;
  items: SharedMemoryCanonicalSourceItemDto[];
  sourcePage: {
    itemOffset: number;
    itemCount: number;
  };
  freshness: "fresh" | "stale";
  companionScope: SharedMemoryCompanionScopeDto;
}

export interface PendingSharedMemorySemanticItem {
  semanticItemId: string;
  representationId: string;
  shareGrantId: string;
  sourceItemIndex: number;
  text: string;
  contentHash: string;
  embeddingJobKey: string;
  computationReuseKey: string;
  personalEmbeddingReuse: {
    memoryEmbeddingId: string;
    model: string;
    dimensions: 384 | 1024 | 1536 | 3072;
    version: string;
  } | null;
}

export interface SharedMemorySemanticCandidate {
  source: SharedMemorySourceRef;
  candidateId: string;
  shareGrantId: string;
  sourceArtifactId: string;
  sourceRevisionHash: string;
  representationId: string;
  representation: SharedMemoryRepresentation;
  pseudonymousSourceId: string;
  sourceItemIndex: number;
  sourceRevision: number;
  provenanceHash: string;
  representationPolicyRevision: number;
  contentPolicyVersion: number;
  classifierVersion: number;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingVersion: string;
  itemType: SharedMemorySourceItemType;
  occurredAt: string | null;
  text: string;
  lexicalAnchors: string[];
  exactAnchorMatches?: string[];
  score: number;
  freshness: "fresh" | "stale";
}

export interface SharedMemorySemanticStageScan {
  representation: SharedMemoryRepresentation;
  candidateCount: number;
  topScore: number;
}

export interface SharedMemorySemanticExpansionItem {
  candidateId: string;
  pseudonymousSourceId: string;
  sourceChunkIndex: number;
  itemType: SharedMemorySourceItemType;
  occurredAt: string | null;
  text: string;
  lexicalAnchors: string[];
}

export interface SharedMemorySemanticExpansion {
  parent: SharedMemorySemanticCandidate;
  items: SharedMemorySemanticExpansionItem[];
}

/** Exact Team authority admitted when a bounded Memory Answer run starts. */
export interface SharedMemorySemanticAuthorizationBoundary {
  teamId: string;
  teamVersion: number;
  teamWorkspaceId: string;
  workspaceVersion: number;
  membershipVersion: number;
  workspaceAccessVersion: number;
  /** Exact PostgreSQL row version; changes on disable, delete, or re-enable. */
  userRowVersion: string;
  shareGrantIds: string[];
}

export interface SharedMemoryWorkspaceIndexEntry {
  shareGrantId: string;
  logicalMemoryId: string;
  ownerUserId: string | null;
  ownerDisplayName: string;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  title: string;
  activeRepresentation: SharedMemoryRepresentation;
  representationState: "available" | "stale";
  representationSourceRevision: number;
  representationUpdatedAt: string;
  freshness: "fresh" | "stale";
  lifecycle: SharedMemoryGrantLifecycle;
  createdAt: string;
  updatedAt: string;
  companionScope: SharedMemoryCompanionScopeDto;
}

export interface SharedMemoryWorkspaceIndexPage {
  entries: SharedMemoryWorkspaceIndexEntry[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SharedMemoryOwnerGrantPage {
  entries: SharedMemoryGrantRecord[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SharedMemoryReviewSource {
  logicalMemoryId: string;
  title: string;
  ownerPrincipalId: string;
}

export interface SharedMemoryReviewDestination {
  team: { id: string; name: string };
  workspace: { id: string; name: string };
}

export interface SharedMemoryPreviewAdmissionRecord extends SharedMemoryReviewDestination {
  source: SharedMemoryReviewSource;
  remoteReplicaId: string;
  representation: SharedMemoryRepresentation;
  requestedMaximumFidelity: SharedMemoryFidelityCeiling;
  requestedIncludeCuratedMemory: boolean;
  effectiveMaximumFidelity: SharedMemoryFidelityCeiling;
  effectiveIncludeCuratedMemory: boolean;
  sourceOwnerPolicyWillChange: boolean;
}

export interface SharedMemoryShareReviewRecord extends SharedMemoryReviewDestination {
  source: SharedMemoryReviewSource;
  preview: Pick<
    SharedMemoryPersistedPreviewRecord,
    | "previewId"
    | "previewHash"
    | "previewRevision"
    | "remoteReplicaId"
    | "representation"
    | "sourceRevision"
  >;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  sourceOwnerPolicyWillActivate: boolean;
  sourceOwnerPolicyWillReplace: boolean;
}

export interface SharedMemoryPendingShareReviewRecord extends SharedMemoryReviewDestination {
  source: SharedMemoryReviewSource;
  preview: {
    previewId: string;
    previewHash: string;
    previewRevision: number;
    representation: SharedMemoryRepresentation;
    sourceRevision: number;
  };
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  sourceOwnerPolicyWillActivate: true;
  sourceOwnerPolicyWillReplace: false;
}

export interface SharedMemoryFidelityChangeReviewRecord extends SharedMemoryShareReviewRecord {
  grant: Pick<
    SharedMemoryGrantRecord,
    | "id"
    | "logicalMemoryId"
    | "teamId"
    | "teamWorkspaceId"
    | "grantVersion"
    | "lifecycle"
    | "sourceRevision"
    | "maximumFidelity"
    | "includeCuratedMemory"
  >;
  willReactivate: boolean;
  sourceRevisionChanged: boolean;
}

export interface SharedMemoryRevokeReviewRecord extends SharedMemoryReviewDestination {
  source: Pick<SharedMemoryReviewSource, "logicalMemoryId" | "title">;
  grant: Pick<
    SharedMemoryGrantRecord,
    | "id"
    | "grantVersion"
    | "lifecycle"
    | "maximumFidelity"
    | "includeCuratedMemory"
  >;
}

export interface SharedMemoryCreateConsentInput {
  source: SharedMemorySourceRef;
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  consentId: string;
  preview: SharedSourcePreviewReference;
  mode: SharedMemoryConsentMode;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  expiresAt?: string | null;
  authority: SharedMemoryAuthorityContext;
  internalPendingShareId?: string;
}

export interface SharedMemoryCreateGrantInput {
  mutationId: string;
  logicalGrantId: string;
  consentId: string;
  authority: SharedMemoryAuthorityContext;
  internalPendingShareId?: string;
}

export interface SharedMemorySelectFidelityInput {
  mutationId: string;
  shareGrantId: string;
  consentId: string;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  expectedGrantVersion: number;
  authority: SharedMemoryAuthorityContext;
  internalPendingShareId?: string;
}

export interface SharedMemoryConsentBinding {
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
  previewId: string;
  previewRevision: number;
  previewHash: string;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
}

export interface SharedMemoryCreateShareBundleInput {
  consent: SharedMemoryCreateConsentInput;
  grant: SharedMemoryCreateGrantInput;
  expected: SharedMemoryConsentBinding & { consentId: string };
}

export interface SharedMemoryChangeFidelityBundleInput {
  consent: SharedMemoryCreateConsentInput;
  fidelity: SharedMemorySelectFidelityInput;
  expected: SharedMemoryConsentBinding & {
    consentId: string;
  };
}

export type ContinuousPersonalNoteAdvancementOutcome =
  | {
      shareGrantId: string;
      status: "accepted";
      pendingShareId: string;
    }
  | {
      shareGrantId: string;
      status: "rejected";
      reasonCode: "destination_unavailable";
    };

export interface ContinuousPersonalNoteAdvancementResult {
  pendingShares: PendingShareRecord[];
  outcomes: ContinuousPersonalNoteAdvancementOutcome[];
  nextShareGrantId: string | null;
}

export interface SharedMemoryRepository {
  createSharedMemoryCandidatePreview(
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      source: SharedMemorySourceRef;
      sourceDeploymentProtocolId?: string;
      sourceOwnerPrincipalId?: string;
      deviceCredentialId?: string;
      sourceCapabilities: SharedMemoryRepresentation[];
      activationRepresentation: SharedMemoryRepresentation;
      candidateHash: string;
      sourceRevision: number;
      itemCount: number;
      excludedItemCount: number;
      manifest: Array<{ sourceId: string; revisionHash: string }>;
      byteCount: number;
      teamId: string;
      teamWorkspaceId: string;
      mode: SharedMemoryConsentMode;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
      expiresAt?: string | null;
      authority: SharedMemoryAuthorityContext;
    }
  ): Promise<SharedMemoryCandidatePreviewRecord | null>;
  createPendingShare(
    actor: ActorContext,
    input: {
      mutationId: string;
      logicalGrantId: string;
      consentId: string;
      logicalMemoryId: string;
      source: SharedMemorySourceRef;
      sourceCapabilities: SharedMemoryRepresentation[];
      activationRepresentation: SharedMemoryRepresentation;
      teamId: string;
      teamWorkspaceId: string;
      preview: SharedSourcePreviewReference;
      previewRevision: number;
      mode: SharedMemoryConsentMode;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
      expiresAt?: string | null;
      authority: SharedMemoryAuthorityContext;
    }
  ): Promise<PendingShareRecord>;
  createPendingFidelityChange(
    actor: ActorContext,
    input: {
      source: SharedMemorySourceRef;
      sourceCapabilities: SharedMemoryRepresentation[];
      activationRepresentation: SharedMemoryRepresentation;
      mutationId: string;
      consentId: string;
      logicalMemoryId: string;
      teamId: string;
      teamWorkspaceId: string;
      shareGrantId: string;
      expectedGrantVersion: number;
      preview: SharedSourcePreviewReference;
      previewRevision: number;
      mode: SharedMemoryConsentMode;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
      expiresAt?: string | null;
      authority: SharedMemoryAuthorityContext;
      deviceCredentialId?: string;
    }
  ): Promise<PendingShareRecord>;
  advanceContinuousPersonalNoteRevision(
    actor: ActorContext,
    input: {
      mutationId: string;
      deviceCredentialId: string;
      sourceDeploymentProtocolId: string;
      sourceOwnerPrincipalId: string;
      afterShareGrantId?: string;
      candidate: SharedMemoryCandidatePreview;
    }
  ): Promise<ContinuousPersonalNoteAdvancementResult>;
  processPendingShares(input?: {
    limit?: number;
    stallThresholdMs?: number;
    reportActivationFailure?: (input: {
      pendingShareId: string;
      failureStage:
        | "load_context"
        | "begin_activation"
        | "authoritative_preview"
        | "candidate_manifest"
        | "activation_bundle"
        | "representation"
        | "publish";
      errorClass: string;
      errorCode: string | null;
      resourceLimit?: {
        kind: SharedMemorySemanticResourceLimitError["limitKind"];
        observed: number;
        maximum: number;
      };
    }) => void;
    ensureCompanion?: (input: {
      actor: ActorContext;
      grant: SharedMemoryGrantRecord;
    }) => Promise<boolean>;
  }): Promise<{
    claimed: number;
    activated: number;
    waiting: number;
    failed: number;
  }>;
  getNextPendingShareWorkAt(): Promise<string | null>;
  controlPendingShare(
    actor: ActorContext,
    input: {
      pendingShareId: string;
      mutationId: string;
      expectedOperationVersion: number;
      action: "retry" | "pause" | "resume" | "revoke";
    }
  ): Promise<PendingShareRecord>;
  getSharedMemoryCandidatePreviewAdmission(
    actor: ActorContext,
    input: {
      teamId: string;
      teamWorkspaceId: string;
      representation: SharedMemoryRepresentation;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
    }
  ): Promise<{
    effectiveMaximumFidelity: SharedMemoryFidelityCeiling;
    effectiveIncludeCuratedMemory: boolean;
    teamPolicyVersion: number;
    teamPolicyHash: string;
    workspacePolicyVersion: number;
    workspacePolicyHash: string;
  } | null>;
  getSharedMemoryPreviewAdmission(
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      remoteReplicaId: string;
      teamId: string;
      teamWorkspaceId: string;
      representation: SharedMemoryRepresentation;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
    }
  ): Promise<SharedMemoryPreviewAdmissionRecord | null>;
  getSharedMemoryShareReview(
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      logicalGrantId: string;
      teamId: string;
      teamWorkspaceId: string;
      consentId: string;
      preview: SharedSourcePreviewReference;
      previewRevision: number;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
      expiresAt: string | null;
    }
  ): Promise<SharedMemoryShareReviewRecord | null>;
  getSharedMemoryPendingShareReview(
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      logicalGrantId: string;
      teamId: string;
      teamWorkspaceId: string;
      consentId: string;
      preview: SharedSourcePreviewReference;
      previewRevision: number;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
      expiresAt: string | null;
    }
  ): Promise<SharedMemoryPendingShareReviewRecord | null>;
  getSharedMemoryFidelityChangeReview(
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      teamId: string;
      teamWorkspaceId: string;
      shareGrantId: string;
      expectedGrantVersion: number;
      preview: SharedSourcePreviewReference;
      previewRevision: number;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
      expiresAt: string | null;
    }
  ): Promise<SharedMemoryFidelityChangeReviewRecord | null>;
  getSharedMemoryRevokeReview(
    actor: ActorContext,
    input: {
      teamId: string;
      teamWorkspaceId: string;
      shareGrantId: string;
      expectedGrantVersion: number;
    }
  ): Promise<SharedMemoryRevokeReviewRecord | null>;
  createAuthoritativeSourcePreview(
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      remoteReplicaId: string;
      teamId: string;
      teamWorkspaceId: string;
      sourceCapabilities: SharedMemoryRepresentation[];
      activationRepresentation: SharedMemoryRepresentation;
      mode: SharedMemoryConsentMode;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
      authority: SharedMemoryAuthorityContext;
      internalPendingShareId?: string;
    }
  ): Promise<SharedMemoryPersistedPreviewRecord>;
  persistPersonalNoteSourceArtifact(
    actor: ActorContext,
    input: {
      pendingShareId: string;
      sourceDeploymentProtocolId: string;
      sourceOwnerPrincipalId: string;
      deviceCredentialId: string;
      candidate: SharedMemoryCandidatePreview;
    }
  ): Promise<SharedMemoryPersistedPreviewRecord>;
  putSourceOwnerPolicy(
    actor: ActorContext,
    input: {
      mutationId: string;
      logicalMemoryId: string;
      policyId?: string;
      expectedCurrentVersion: number;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
    }
  ): Promise<SharedMemoryPolicyRecord>;
  putTeamPolicy(
    actor: ActorContext,
    input: {
      mutationId: string;
      teamId: string;
      policyId?: string;
      expectedCurrentVersion: number;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
    }
  ): Promise<SharedMemoryPolicyRecord>;
  putWorkspacePolicy(
    actor: ActorContext,
    input: {
      mutationId: string;
      teamId: string;
      teamWorkspaceId: string;
      policyId?: string;
      expectedCurrentVersion: number;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
    }
  ): Promise<SharedMemoryPolicyRecord>;
  createSourceOwnerConsent(
    actor: ActorContext,
    input: SharedMemoryCreateConsentInput
  ): Promise<SharedMemoryConsentRecord>;
  createShareGrant(
    actor: ActorContext,
    input: SharedMemoryCreateGrantInput
  ): Promise<SharedMemoryGrantRecord>;
  selectGrantFidelity(
    actor: ActorContext,
    input: SharedMemorySelectFidelityInput
  ): Promise<SharedMemoryGrantRecord>;
  createShareBundle(
    actor: ActorContext,
    input: SharedMemoryCreateShareBundleInput
  ): Promise<{
    consent: SharedMemoryConsentRecord;
    grant: SharedMemoryGrantRecord;
  } | null>;
  changeFidelityBundle(
    actor: ActorContext,
    input: SharedMemoryChangeFidelityBundleInput
  ): Promise<{
    consent: SharedMemoryConsentRecord;
    grant: SharedMemoryGrantRecord;
  } | null>;
  revokeShareGrant(
    actor: ActorContext,
    input: {
      mutationId: string;
      shareGrantId: string;
      expectedGrantVersion: number;
      reasonCode: string;
      authority: SharedMemoryAuthorityContext;
    }
  ): Promise<SharedMemoryGrantRecord>;
  listPendingSemanticPrivacyTargets(input?: {
    limit?: number;
    shareGrantId?: string;
    sourcePreviewId?: string;
  }): Promise<SharedMemoryPendingSemanticTarget[]>;
  readPendingSemanticPrivacyTarget(
    actor: ActorContext,
    input: {
      semanticPreviewId: string;
      expectedSourcePreviewHash: string;
      expectedSourceArtifactHash: string;
      expectedSourceManifestHash: string;
      expectedClassifierHash: string;
      expectedEffectivePrivacyPolicyHash: string;
    }
  ): Promise<SharedMemoryDecryptedSemanticTarget | null>;
  claimSemanticPrivacyTarget(
    actor: ActorContext,
    input: {
      semanticPreviewId: string;
      claimantId: string;
      leaseMs: number;
      expectedWorkIdentity: string;
    }
  ): Promise<SharedMemorySemanticPrivacyClaim | null>;
  renewSemanticPrivacyClaim(
    actor: ActorContext,
    input: SharedMemorySemanticPrivacyClaim & { leaseMs: number }
  ): Promise<SharedMemorySemanticPrivacyClaim | null>;
  releaseSemanticPrivacyClaim(
    actor: ActorContext,
    input: SharedMemorySemanticPrivacyClaim & {
      completed: boolean;
      nextChunkIndex: number;
    }
  ): Promise<boolean>;
  initializeSemanticPrivacyManifest(
    actor: ActorContext,
    input: {
      claim: SharedMemorySemanticPrivacyClaim;
      expectedManifestHash: string;
      fieldCount: number;
      fieldByteCount: number;
      chunks: Array<{
        chunkIndex: number;
        firstFieldIndex: number;
        fieldCount: number;
        inputIdentityHash: string;
        orderedInputHash: string;
      }>;
    }
  ): Promise<SharedMemorySemanticClassificationChunkRecord[]>;
  attachSemanticPrivacyChunkResult(
    actor: ActorContext,
    input: {
      claim: SharedMemorySemanticPrivacyClaim;
      chunkIndex: number;
      inputIdentityHash: string;
      orderedInputHash: string;
      classificationResultId: string;
      classificationPayloadBindingHash: string;
    }
  ): Promise<SharedMemorySemanticClassificationChunkRecord>;
  listSemanticPrivacyManifest(
    actor: ActorContext,
    input: {
      claim: SharedMemorySemanticPrivacyClaim;
    }
  ): Promise<SharedMemorySemanticClassificationChunkRecord[]>;
  storeSanitizedSemanticPreview(
    actor: ActorContext,
    input: {
      semanticPreviewId: string;
      expectedSourcePreviewHash: string;
      expectedSourceArtifactHash: string;
      expectedSourceManifestHash: string;
      expectedSourceRevision: number;
      expectedSourceItemIdentityHash: string;
      expectedClassifierHash: string;
      expectedEffectivePrivacyPolicyHash: string;
      claim: SharedMemorySemanticPrivacyClaim;
      expectedManifestHash: string;
      expectedResultManifestHash: string;
      items: SharedMemoryCanonicalSourceItemDto[];
      sanitizedContentHash: string;
    }
  ): Promise<SharedMemorySemanticPreviewRecord>;
  markSemanticPrivacyTargetFailed(
    actor: ActorContext,
    input: {
      semanticPreviewId: string;
      expectedSourcePreviewHash: string;
      expectedSourceArtifactHash: string;
      expectedSourceManifestHash: string;
      expectedSourceItemIdentityHash: string;
      expectedClassifierHash: string;
      expectedEffectivePrivacyPolicyHash: string;
      failureCode: string;
    }
  ): Promise<boolean>;
  deferSemanticPrivacyTarget(
    actor: ActorContext,
    input: {
      semanticPreviewId: string;
      expectedSourcePreviewHash: string;
      expectedSourceArtifactHash: string;
      expectedSourceManifestHash: string;
      expectedClassifierHash: string;
      expectedEffectivePrivacyPolicyHash: string;
      errorClass: string;
    }
  ): Promise<string | null>;
  getNextSemanticPrivacyWorkAt(): Promise<string | null>;
  getSemanticPrivacyBacklogDiagnostics(): Promise<SharedMemorySemanticPrivacyBacklogDiagnostics>;
  tryAcquireSemanticPrivacyFinalizationLease(): Promise<SharedMemorySemanticPrivacyFinalizationLease | null>;
  invalidateSemanticPreview(
    actor: ActorContext,
    input: {
      semanticPreviewId: string;
      reasonCode: string;
    }
  ): Promise<boolean>;
  invalidateStaleSemanticPreviews(input?: {
    limit?: number;
  }): Promise<{ invalidated: number }>;
  reconcileReadySemanticRepresentations(input?: {
    limit?: number;
  }): Promise<{ materialized: number; skipped: number }>;
  materializeGrantRepresentation(
    actor: ActorContext,
    input: {
      mutationId: string;
      shareGrantId: string;
      consentId: string;
      expectedGrantVersion: number;
      expectedRepresentationVersion?: number;
      internalPendingShareId?: string;
      preview: SharedSourcePreviewReference;
    }
  ): Promise<SharedMemoryRepresentationRecord>;
  advanceContinuousGrantRepresentations(input: {
    remoteReplicaId: string;
    sourceRevision: number;
  }): Promise<{ advanced: number }>;
  reconcileCuratedGrantRepresentations(
    actor: ActorContext
  ): Promise<{ rematerialized: number; invalidated: number }>;
  rewrapTeamRepresentationChunkBatch(
    provider: EnvelopeEncryptionProvider,
    input?: {
      teamId?: string;
      batchSize?: number;
      force?: boolean;
      dryRun?: boolean;
      afterId?: string;
    }
  ): Promise<{
    processedRows: number;
    rewrappedRows: number;
    wouldRewrapRows: number;
    failedRows: number;
    done: boolean;
    nextCursorId: string | null;
  }>;
  listWorkspaceGrants(
    actor: ActorContext,
    input: {
      teamId: string;
      teamWorkspaceId: string;
      limit: number;
      offset: number;
    }
  ): Promise<SharedMemoryWorkspaceIndexPage>;
  listOwnerGrants(
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      limit: number;
      offset: number;
    }
  ): Promise<SharedMemoryOwnerGrantPage>;
  listOwnerShares(
    actor: ActorContext,
    input: {
      limit: number;
      history?: boolean;
      snapshotAt?: string;
      after?: {
        createdAt: string;
        recordKind: "grant" | "pending";
        id: string;
      };
    }
  ): Promise<{
    entries: OwnedShareRecord[];
    limit: number;
    hasMore: boolean;
    snapshotAt: string;
    next: {
      createdAt: string;
      recordKind: "grant" | "pending";
      id: string;
    } | null;
  }>;
  getOwnerShare(
    actor: ActorContext,
    input: { kind: "pending" | "grant"; id: string }
  ): Promise<OwnedShareRecord | null>;
  readOwnerSharePreview(
    actor: ActorContext,
    input: { kind: "pending" | "grant"; id: string }
  ): Promise<SharedMemoryPersistedPreviewRecord | null>;
  readGrantRepresentation(
    actor: ActorContext,
    input: {
      shareGrantId: string;
      representation: SharedMemoryRepresentation;
      page?: {
        direction: "older" | "newer";
        boundary?: number;
        limit: number;
      };
      /** Internal recall path; public timeline/detail reads never set this. */
      includeExpansionMaterial?: boolean;
    }
  ): Promise<SharedMemoryReadResult | null>;
  listPendingSharedMemorySemanticItems(input?: {
    limit?: number;
    model?: string;
    dimensions?: 384 | 1024 | 1536 | 3072;
    version?: string;
    duringAuthorizedLease?: (
      items: readonly PendingSharedMemorySemanticItem[]
    ) => Promise<void>;
  }): Promise<PendingSharedMemorySemanticItem[]>;
  storeSharedMemorySemanticEmbedding(input: {
    semanticItemId: string;
    contentHash: string;
    model: string;
    dimensions: 384 | 1024 | 1536 | 3072;
    version: string;
    vector: number[];
  }): Promise<boolean>;
  reusePersonalSharedMemorySemanticEmbedding(input: {
    semanticItemId: string;
    contentHash: string;
    memoryEmbeddingId: string;
    model: string;
    dimensions: 384 | 1024 | 1536 | 3072;
    version: string;
  }): Promise<boolean>;
  markSharedMemorySemanticEmbeddingFailed(input: {
    semanticItemId: string;
    errorClass: string;
  }): Promise<void>;
  getNextSharedMemorySemanticEmbeddingRetryAt(): Promise<string | null>;
  authorizeSharedMemorySemanticRecall(
    actor: ActorContext,
    input: { teamWorkspaceId: string }
  ): Promise<void>;
  freezeSharedMemorySemanticRecallBoundary(
    actor: ActorContext,
    input: { teamWorkspaceId: string; maximumGrantCount: number }
  ): Promise<SharedMemorySemanticAuthorizationBoundary>;
  searchAuthorizedSharedMemorySemanticItems(
    actor: ActorContext,
    input: {
      teamWorkspaceId: string;
      queryVector: number[];
      model: string;
      dimensions: 384 | 1024 | 1536 | 3072;
      version: string;
      limit: number;
      searchDomain: "global" | "session" | "project";
      sessionId?: string;
      projectId?: string;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
      exactHints?: string[];
      representations?: SharedMemoryRepresentation[];
      parentCandidateIds?: string[];
      strictLimit?: boolean;
      authorizationBoundary?: SharedMemorySemanticAuthorizationBoundary;
    }
  ): Promise<SharedMemorySemanticCandidate[]>;
  scanAuthorizedSharedMemorySemanticItems(
    actor: ActorContext,
    input: {
      teamWorkspaceId: string;
      queryVector: number[];
      model: string;
      dimensions: 384 | 1024 | 1536 | 3072;
      version: string;
      limit: number;
      searchDomain: "global" | "session" | "project";
      sessionId?: string;
      projectId?: string;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
      representations?: SharedMemoryRepresentation[];
      parentCandidateIds?: string[];
      authorizationBoundary?: SharedMemorySemanticAuthorizationBoundary;
    }
  ): Promise<SharedMemorySemanticStageScan[]>;
  expandAuthorizedSharedMemorySemanticItem(
    actor: ActorContext,
    input: {
      teamWorkspaceId: string;
      candidateId: string;
      searchDomain: "global" | "session" | "project";
      sessionId?: string;
      projectId?: string;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
      authorizationBoundary?: SharedMemorySemanticAuthorizationBoundary;
    }
  ): Promise<SharedMemorySemanticExpansion | null>;
}

type SharedMemoryClientScopedRepository = SharedMemoryRepository & {
  createSourceOwnerConsent(
    actor: ActorContext,
    input: SharedMemoryCreateConsentInput,
    client?: pg.PoolClient
  ): Promise<SharedMemoryConsentRecord>;
  createShareGrant(
    actor: ActorContext,
    input: SharedMemoryCreateGrantInput,
    client?: pg.PoolClient
  ): Promise<SharedMemoryGrantRecord>;
  selectGrantFidelity(
    actor: ActorContext,
    input: SharedMemorySelectFidelityInput,
    client?: pg.PoolClient
  ): Promise<SharedMemoryGrantRecord>;
  materializeGrantRepresentation(
    actor: ActorContext,
    input: Parameters<
      SharedMemoryRepository["materializeGrantRepresentation"]
    >[1],
    client?: pg.PoolClient
  ): Promise<SharedMemoryRepresentationRecord>;
};

export class SharedMemoryAuthorizationError extends Error {
  statusCode = 403;
  constructor(message = "Shared Memory operation is not authorized") {
    super(message);
    this.name = "SharedMemoryAuthorizationError";
  }
}

export class SharedMemorySemanticDerivativePendingError extends Error {
  constructor() {
    super("Shared Memory semantic privacy materialization is pending");
    this.name = "SharedMemorySemanticDerivativePendingError";
  }
}

export interface SharedMemoryReadySemanticDerivative {
  record: SharedMemorySemanticPreviewRecord;
  payload: SharedMemorySanitizedSemanticPreviewPayload;
}

export const requireReadySharedMemorySemanticDerivative = (
  candidate: SharedMemoryReadySemanticDerivative | null
): SharedMemoryReadySemanticDerivative => {
  if (!candidate || candidate.record.status === "pending") {
    throw new SharedMemorySemanticDerivativePendingError();
  }
  if (
    candidate.record.status !== "ready" ||
    candidate.record.expectedManifestHash === null ||
    candidate.record.expectedChunkCount === null ||
    candidate.record.resultManifestHash === null ||
    candidate.record.sourceItemIdentityHash === null ||
    candidate.record.sourceItemCount === null ||
    candidate.record.sanitizedContentHash === null ||
    candidate.record.payloadBindingHash === null
  ) {
    throw new SharedMemoryConflictError(
      "Shared Memory sanitized semantic derivative is invalid or unavailable"
    );
  }
  return candidate;
};

const isUniqueViolation = (error: unknown, constraint: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "23505" &&
  (error as { constraint?: unknown }).constraint === constraint;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SOURCE_ITEMS = 2_048;
const MAX_CHUNK_BYTES = 256 * 1_024;
const OUTBOX_REPLAY_DAYS = 30;
const MAX_WORKSPACE_INDEX_LIMIT = 100;
const MAX_WORKSPACE_INDEX_OFFSET = 10_000;
const ENCRYPTED_CONVERSATION_ITEM_TEXT = "[koed encrypted conversation item]";
const ENCRYPTED_MEMORY_NODE_TEXT = "[koed encrypted memory node]";
const SHARED_MEMORY_CLASSIFIER_VERSION = 1;

type SqlClient = pg.Pool | pg.PoolClient;
type Row = Record<string, unknown>;

interface LogicalMemorySourceIdentity {
  logicalMemoryId: string;
  sourceKind: SharedMemorySourceRef["kind"];
}

interface ExactLogicalMemorySourceRevision extends LogicalMemorySourceIdentity {
  id: string;
  genericRevision: number;
  sourceRevision: number;
  source: SharedMemorySourceRef;
}

const iso = (value: unknown): string =>
  value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
const nullableIso = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);
const numberValue = (value: unknown): number => Number(value);
const stringValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  throw new TypeError("Expected a scalar database value");
};
const nullableStringValue = (value: unknown): string | null =>
  value === null || value === undefined ? null : stringValue(value);
const sourceRefFromRow = (row: Row): SharedMemorySourceRef | undefined => {
  if (row.source_kind === "personal_note") {
    return sharedMemorySourceRefSchema.parse({
      kind: "personal_note",
      noteId: row.source_note_id,
      noteRevision: numberValue(row.source_revision),
      memoryEventId: row.source_memory_event_id,
      logicalMemoryId: row.logical_memory_id
    });
  }
  const capturedSessionId = row.source_session_id ?? row.session_id;
  if (row.source_kind === "captured_session" && capturedSessionId) {
    return sharedMemorySourceRefSchema.parse({
      kind: "captured_session",
      sessionId: capturedSessionId,
      logicalMemoryId: row.logical_memory_id
    });
  }
  return undefined;
};

const ensureLogicalMemorySourceRevision = async (
  client: pg.PoolClient,
  input: {
    source: SharedMemorySourceRef;
    ownerPrincipalId: string;
    revision: number;
  }
): Promise<ExactLogicalMemorySourceRevision> => {
  let identity: ReturnType<typeof logicalMemorySourceRevisionIdentity>;
  try {
    identity = logicalMemorySourceRevisionIdentity({
      source: input.source,
      ownerPrincipalId: input.ownerPrincipalId,
      sourceRevision: input.revision
    });
  } catch {
    throw new SharedMemoryConflictError(
      "Shared Memory source revision is outside the supported range"
    );
  }
  const { bindingHash, genericRevision, id: revisionId } = identity;
  const logicalIdentity = await client.query<Row>(
    `select id,source_kind,owner_principal_id
       from logical_memories
      where id=$1 and lifecycle='active'
        and invalidated_at is null and purge_completed_at is null
      for update`,
    [input.source.logicalMemoryId]
  );
  const logical = logicalIdentity.rows[0];
  if (
    !logical ||
    stringValue(logical.source_kind) !== input.source.kind ||
    stringValue(logical.owner_principal_id) !== input.ownerPrincipalId
  ) {
    throw new SharedMemoryConflictError(
      "Shared Memory source identity changed"
    );
  }
  if (input.source.kind === "captured_session") {
    const root = await client.query<Row>(
      `insert into captured_session_logical_memories
         (logical_memory_id,source_kind,source_session_id,owner_principal_id)
       values ($1,'captured_session',$2,$3)
       on conflict (logical_memory_id) do update
         set source_session_id=captured_session_logical_memories.source_session_id
       where captured_session_logical_memories.source_session_id=excluded.source_session_id
         and captured_session_logical_memories.owner_principal_id=excluded.owner_principal_id
       returning logical_memory_id`,
      [
        input.source.logicalMemoryId,
        input.source.sessionId,
        input.ownerPrincipalId
      ]
    );
    if (!root.rows[0]) {
      throw new SharedMemoryConflictError(
        "Captured Session source binding changed"
      );
    }
  } else {
    const root = await client.query<Row>(
      `insert into personal_note_logical_memories
         (logical_memory_id,source_kind,source_note_id,owner_principal_id)
       values ($1,'personal_note',$2,$3)
       on conflict (logical_memory_id) do update
         set source_note_id=personal_note_logical_memories.source_note_id
       where personal_note_logical_memories.source_note_id=excluded.source_note_id
         and personal_note_logical_memories.owner_principal_id=excluded.owner_principal_id
       returning logical_memory_id`,
      [
        input.source.logicalMemoryId,
        input.source.noteId,
        input.ownerPrincipalId
      ]
    );
    if (!root.rows[0]) {
      throw new SharedMemoryConflictError(
        "Personal Note source binding changed"
      );
    }
  }
  const revision = await client.query<Row>(
    `insert into logical_memory_source_revisions
       (id,logical_memory_id,owner_principal_id,source_kind,revision,binding_hash)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (logical_memory_id,revision) do update
       set binding_hash=logical_memory_source_revisions.binding_hash
     where logical_memory_source_revisions.id=excluded.id
       and logical_memory_source_revisions.owner_principal_id=excluded.owner_principal_id
       and logical_memory_source_revisions.source_kind=excluded.source_kind
       and logical_memory_source_revisions.binding_hash=excluded.binding_hash
     returning id`,
    [
      revisionId,
      input.source.logicalMemoryId,
      input.ownerPrincipalId,
      input.source.kind,
      genericRevision,
      bindingHash
    ]
  );
  if (!revision.rows[0]) {
    throw new SharedMemoryConflictError(
      "Shared Memory source revision changed"
    );
  }
  const binding =
    input.source.kind === "captured_session"
      ? await client.query<Row>(
          `insert into captured_session_source_revisions
             (source_revision_id,logical_memory_id,owner_principal_id,
              source_kind,revision,source_session_id,source_cursor)
           values ($1,$2,$3,'captured_session',$4,$5,$6)
           on conflict (source_revision_id) do update
             set source_cursor=captured_session_source_revisions.source_cursor
           where captured_session_source_revisions.logical_memory_id=excluded.logical_memory_id
             and captured_session_source_revisions.owner_principal_id=excluded.owner_principal_id
             and captured_session_source_revisions.source_session_id=excluded.source_session_id
             and captured_session_source_revisions.source_cursor=excluded.source_cursor
           returning source_revision_id`,
          [
            revisionId,
            input.source.logicalMemoryId,
            input.ownerPrincipalId,
            genericRevision,
            input.source.sessionId,
            input.revision
          ]
        )
      : await client.query<Row>(
          `insert into personal_note_source_revisions
             (source_revision_id,logical_memory_id,owner_principal_id,
              source_kind,source_note_id,revision,source_memory_event_id)
           values ($1,$2,$3,'personal_note',$4,$5,$6)
           on conflict (source_revision_id) do update
             set source_memory_event_id=personal_note_source_revisions.source_memory_event_id
           where personal_note_source_revisions.logical_memory_id=excluded.logical_memory_id
             and personal_note_source_revisions.owner_principal_id=excluded.owner_principal_id
             and personal_note_source_revisions.source_note_id=excluded.source_note_id
             and personal_note_source_revisions.revision=excluded.revision
             and personal_note_source_revisions.source_memory_event_id=excluded.source_memory_event_id
           returning source_revision_id`,
          [
            revisionId,
            input.source.logicalMemoryId,
            input.ownerPrincipalId,
            input.source.noteId,
            input.revision,
            input.source.memoryEventId
          ]
        );
  if (!binding.rows[0]) {
    throw new SharedMemoryConflictError(
      "Shared Memory source-specific revision binding changed"
    );
  }
  return {
    id: revisionId,
    logicalMemoryId: input.source.logicalMemoryId,
    sourceKind: input.source.kind,
    genericRevision,
    sourceRevision: input.revision,
    source: input.source
  };
};

const ensureCandidateSourceIdentity = async (
  client: pg.PoolClient,
  actor: ActorContext,
  input: {
    source: SharedMemorySourceRef;
    sourceDeploymentProtocolId?: string;
    sourceOwnerPrincipalId?: string;
    deviceCredentialId?: string;
    requireExternalBinding?: boolean;
  }
): Promise<{
  ownerPrincipalId: string;
  deploymentIdentityId: string;
  remoteUserIdentityId: string | null;
  credential: Row;
}> => {
  const hasDeployment = input.sourceDeploymentProtocolId !== undefined;
  const hasPrincipal = input.sourceOwnerPrincipalId !== undefined;
  if (!hasDeployment && !hasPrincipal) {
    throw new SharedMemoryAuthorizationError(
      "Candidate source device provenance is required"
    );
  }
  if (
    !input.sourceDeploymentProtocolId ||
    !input.sourceOwnerPrincipalId ||
    !input.deviceCredentialId
  ) {
    throw new SharedMemoryConflictError(
      "Candidate source provenance is incomplete"
    );
  }
  assertUuid(input.sourceDeploymentProtocolId, "sourceDeploymentProtocolId");
  assertUuid(input.sourceOwnerPrincipalId, "sourceOwnerPrincipalId");
  assertUuid(input.deviceCredentialId, "deviceCredentialId");
  const expectedLogicalMemoryId = crossIdentitySyncDeterministicUuid(
    input.source.kind === "personal_note"
      ? {
          protocol: "koed.personal-note-share/v1",
          sourceDeploymentId: input.sourceDeploymentProtocolId,
          sourceOwnerPrincipalId: input.sourceOwnerPrincipalId,
          noteId: input.source.noteId,
          identity: "logical-memory"
        }
      : {
          protocol: "koed.captured-session-sync/v1",
          sourceDeploymentId: input.sourceDeploymentProtocolId,
          sourceUserId: input.sourceOwnerPrincipalId,
          originSessionId: input.source.sessionId,
          identity: "logical-memory"
        }
  );
  if (expectedLogicalMemoryId !== input.source.logicalMemoryId) {
    throw new SharedMemoryConflictError(
      "Candidate source provenance does not match its logical Memory"
    );
  }
  const credential = await client.query<Row>(
    `select credential_key_id,upstream_backend_id,device_instance_id,
            lineage_id,credential_version,verifier_kind,verifier_hash,
            public_key_jwk,metadata
       from device_credentials
      where id=$1 and owner_user_id=$2 and revoked_at is null
        and (expires_at is null or expires_at>now())
        and 'share_grant_management'=any(operation_families)
      for update`,
    [input.deviceCredentialId, actor.userId]
  );
  if (!credential.rows[0]) {
    throw new SharedMemoryAuthorizationError(
      "Candidate source device authority is unavailable"
    );
  }
  const credentialMetadata = credential.rows[0].metadata;
  if (
    !isPlainObject(credentialMetadata) ||
    credentialMetadata.protocolDeploymentId !==
      input.sourceDeploymentProtocolId ||
    credentialMetadata.sourceOwnerPrincipalId !== input.sourceOwnerPrincipalId
  ) {
    throw new SharedMemoryAuthorizationError(
      "Candidate source identity does not match device authority"
    );
  }
  const existingDeployment = await client.query<Row>(
    `select id,locality
       from deployment_identities
      where protocol_deployment_id=$1 and disabled_at is null
      for update`,
    [input.sourceDeploymentProtocolId]
  );
  const deployment = existingDeployment.rows[0];
  if (!deployment) {
    throw new SharedMemoryConflictError(
      "Candidate source deployment identity changed"
    );
  }
  const localIdentity = await client.query<Row>(
    `select owner_principal_id
       from logical_memories
      where id=$1 and owner_user_id=$2
        and origin_deployment_identity_id=$3 and source_kind=$4
        and lifecycle='active' and invalidated_at is null
        and purge_completed_at is null
      for update`,
    [
      input.source.logicalMemoryId,
      actor.userId,
      deployment.id,
      input.source.kind
    ]
  );
  if (
    localIdentity.rows[0] &&
    !input.requireExternalBinding &&
    deployment.locality === "local" &&
    stringValue(localIdentity.rows[0].owner_principal_id) === actor.userId
  ) {
    return {
      ownerPrincipalId: stringValue(localIdentity.rows[0].owner_principal_id),
      deploymentIdentityId: stringValue(deployment.id),
      remoteUserIdentityId: null,
      credential: credential.rows[0]
    };
  }
  const externalIdentityResult = await client.query<Row>(
    `select identity.id
       from sync_external_user_identities identity
       join sync_principal_links link
         on link.external_user_identity_id=identity.id
        and link.local_user_id=$3 and link.revoked_at is null
      where identity.deployment_identity_id=$1
        and identity.external_subject_id=$2
        and identity.status='active' and identity.revoked_at is null
      for update of identity,link`,
    [deployment.id, input.sourceOwnerPrincipalId, actor.userId]
  );
  const externalIdentity = externalIdentityResult.rows[0];
  if (!externalIdentity) {
    throw new SharedMemoryAuthorizationError(
      "Candidate source principal is not bound to this User"
    );
  }
  const remoteUserIdentityId = stringValue(externalIdentity.id);
  if (localIdentity.rows[0]) {
    if (
      stringValue(localIdentity.rows[0].owner_principal_id) !==
      input.sourceOwnerPrincipalId
    ) {
      throw new SharedMemoryConflictError(
        "Candidate source principal identity changed"
      );
    }
    return {
      ownerPrincipalId: input.sourceOwnerPrincipalId,
      deploymentIdentityId: stringValue(deployment.id),
      remoteUserIdentityId,
      credential: credential.rows[0]
    };
  }
  const logicalKey =
    input.source.kind === "personal_note"
      ? `personal_note:${input.sourceDeploymentProtocolId}:${input.source.noteId}`
      : `captured-session:${input.source.sessionId}`;
  const logical = await client.query<Row>(
    `insert into logical_memories
       (id,protocol_logical_id,owner_user_id,owner_principal_id,
        origin_deployment_identity_id,source_kind,logical_key)
     values ($1,$1,$2,$3,$4,$5,$6)
     on conflict (id) do update set updated_at=logical_memories.updated_at
     where logical_memories.owner_user_id=excluded.owner_user_id
       and logical_memories.owner_principal_id=excluded.owner_principal_id
       and logical_memories.origin_deployment_identity_id=
         excluded.origin_deployment_identity_id
       and logical_memories.source_kind=excluded.source_kind
       and logical_memories.logical_key=excluded.logical_key
       and logical_memories.lifecycle='active'
       and logical_memories.invalidated_at is null
       and logical_memories.purge_completed_at is null
     returning id`,
    [
      input.source.logicalMemoryId,
      actor.userId,
      input.sourceOwnerPrincipalId,
      deployment.id,
      input.source.kind,
      logicalKey
    ]
  );
  if (!logical.rows[0]) {
    throw new SharedMemoryConflictError("Candidate source identity changed");
  }
  return {
    ownerPrincipalId: input.sourceOwnerPrincipalId,
    deploymentIdentityId: stringValue(deployment.id),
    remoteUserIdentityId,
    credential: credential.rows[0]
  };
};

const pendingShareSourceRefFromRow = (
  row: Row
): SharedMemorySourceRef | undefined =>
  sourceRefFromRow({
    source_kind: row.effective_source_kind ?? row.source_kind,
    source_session_id: row.effective_source_session_id ?? row.source_session_id,
    source_note_id: row.effective_source_note_id ?? row.source_note_id,
    source_memory_event_id:
      row.effective_source_memory_event_id ?? row.source_memory_event_id,
    source_revision:
      row.effective_source_revision ??
      row.replacement_source_revision ??
      row.source_revision,
    logical_memory_id: row.logical_memory_id
  });

const requiredSourceRefFromRow = (row: Row): SharedMemorySourceRef => {
  const source = sourceRefFromRow(row);
  if (!source) {
    throw new SharedMemoryConflictError(
      "Shared Memory source metadata is required"
    );
  }
  return source;
};

const sourceRefRow = (source: SharedMemorySourceRef): Row => ({
  source_kind: source.kind,
  source_session_id:
    source.kind === "captured_session" ? source.sessionId : null,
  source_note_id: source.kind === "personal_note" ? source.noteId : null,
  source_memory_event_id:
    source.kind === "personal_note" ? source.memoryEventId : null
});

const requiredPendingShareSourceRefFromRow = (
  row: Row
): SharedMemorySourceRef => {
  const source = pendingShareSourceRefFromRow(row);
  if (!source) {
    throw new SharedMemoryConflictError(
      "Pending Share source metadata is required"
    );
  }
  return source;
};

const normalizedSourceRef = (
  source: SharedMemorySourceRef | undefined,
  logicalMemoryId: string
): SharedMemorySourceRef | undefined => {
  if (!source) return undefined;
  const parsed = sharedMemorySourceRefSchema.parse(source);
  if (parsed.logicalMemoryId !== logicalMemoryId) {
    throw new SharedMemoryConflictError(
      "Shared Memory source does not match the logical memory"
    );
  }
  return parsed;
};
const representationValue = (value: unknown): SharedMemoryRepresentation => {
  const representation = stringValue(value);
  if (
    !sharedMemoryRepresentations.includes(
      representation as SharedMemoryRepresentation
    )
  ) {
    throw new SharedMemoryConflictError(
      "Shared Memory representation is invalid"
    );
  }
  return representation as SharedMemoryRepresentation;
};
const representationArrayValue = (
  value: unknown
): SharedMemoryRepresentation[] => {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" &&
        /^\{"?[a-z_]+"?(?:,"?[a-z_]+"?)*\}$/.test(value)
      ? value
          .slice(1, -1)
          .split(",")
          .map((entry) => entry.replace(/^"|"$/g, ""))
      : null;
  if (!values) {
    throw new SharedMemoryConflictError(
      "Shared Memory source capabilities are invalid"
    );
  }
  const representations = values.map(representationValue);
  if (
    representations.length === 0 ||
    new Set(representations).size !== representations.length
  ) {
    throw new SharedMemoryConflictError(
      "Shared Memory source capabilities are invalid"
    );
  }
  return representations;
};
const privacyPlaceholderOnlyPattern =
  /^\s*(?:\[(?:PRIVATE_DATA|[A-Z][A-Z_]*)\][\s,;|/]*)+$/;
const semanticItemAnchors = (
  item: SharedMemoryCanonicalSourceItemDto
): string[] => {
  const value = item.content.lexicalAnchors ?? item.content.lexical_anchors;
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" &&
          !privacyPlaceholderOnlyPattern.test(entry)
      )
    : [];
};
export const composeSharedMemorySemanticText = (
  item: SharedMemoryCanonicalSourceItemDto
): string => {
  if (item.itemType === "lcm_leaf" || item.itemType === "lcm_rollup") {
    const summary = stringValue(item.content.summaryText).trim();
    const anchors = semanticItemAnchors(item);
    return anchors.length > 0
      ? `${summary}\n\nLexical anchors:\n${anchors.join("\n")}`
      : summary;
  }
  if (item.itemType === "curated_assertion") {
    const assertion = stringValue(item.content.assertionText).trim();
    const topic = stringValue(item.content.topicTitle ?? "").trim();
    const tags = Array.isArray(item.content.tags)
      ? item.content.tags.filter(
          (entry): entry is string =>
            typeof entry === "string" &&
            !privacyPlaceholderOnlyPattern.test(entry)
        )
      : [];
    return [topic, assertion, tags.join(" ")].filter(Boolean).join("\n");
  }
  if (
    item.itemType === "user_message" ||
    item.itemType === "assistant_message" ||
    item.itemType === "thought"
  ) {
    return stringValue(item.content.text).trim();
  }
  const toolName = stringValue(item.content.toolName).trim();
  const payload = item.content.payload;
  const payloadText =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  return `${toolName}\n${payloadText}`.trim();
};

export const sharedMemorySanitizedDisplayTitle = (
  items: readonly SharedMemoryCanonicalSourceItemDto[]
): string => {
  for (const item of items) {
    const value =
      item.itemType === "lcm_leaf" || item.itemType === "lcm_rollup"
        ? (item.content.title ?? item.content.summaryText)
        : item.itemType === "curated_assertion"
          ? (item.content.topicTitle ?? item.content.assertionText)
          : item.itemType === "tool_call" || item.itemType === "tool_result"
            ? item.content.toolName
            : item.content.text;
    if (typeof value !== "string") continue;
    const normalized = value.trim().normalize("NFC").replace(/\s+/gu, " ");
    if (!normalized || privacyPlaceholderOnlyPattern.test(normalized)) continue;
    return Array.from(normalized).slice(0, 80).join("");
  }
  return "Shared Memory";
};

export const sharedMemorySourceItemIdentityHash = (
  items: readonly SharedMemoryCanonicalSourceItemDto[]
): string =>
  crossIdentitySyncDigest(
    items.map((item, sourceItemIndex) => ({
      sourceItemIndex,
      itemType: item.itemType,
      schemaVersion: item.schemaVersion,
      sourceId: item.sourceId,
      sourceLogicalMemoryId: item.sourceLogicalMemoryId,
      sourceRevision: item.sourceRevision,
      occurredAt: item.occurredAt
    }))
  );

const sharedMemoryEmbeddingInputHash = (
  item: SharedMemoryCanonicalSourceItemDto
): string =>
  createHash("sha256")
    .update(composeSharedMemorySemanticText(item), "utf8")
    .digest("hex");

export const sharedMemorySemanticEmbeddingSourceBinding = (
  sourceItemIndex: number,
  original: SharedMemoryCanonicalSourceItemDto,
  sanitized: SharedMemoryCanonicalSourceItemDto,
  manifest: SharedSourceArtifactV1["manifest"][number]
): SharedMemorySemanticEmbeddingSourceBinding => {
  const originalText = composeSharedMemorySemanticText(original);
  const sanitizedText = composeSharedMemorySemanticText(sanitized);
  const personalSource = manifest.sourceEventId
    ? { type: "memory_event" as const, id: manifest.sourceEventId }
    : manifest.sourceNodeId
      ? { type: "memory_node" as const, id: manifest.sourceNodeId }
      : manifest.sourceTable === "curated_memory_assertions"
        ? { type: "curated_memory" as const, id: manifest.sourceId }
        : null;
  return {
    sourceItemIndex,
    originalInputHash: createHash("sha256")
      .update(originalText, "utf8")
      .digest("hex"),
    sanitizedInputHash: createHash("sha256")
      .update(sanitizedText, "utf8")
      .digest("hex"),
    inputUnchanged: originalText === sanitizedText,
    personalSourceType: personalSource?.type ?? null,
    personalSourceId: personalSource?.id ?? null
  };
};

export const sharedMemorySemanticPreviewPayloadBindingHash = (
  payload: SharedMemorySanitizedSemanticPreviewPayload
): string => crossIdentitySyncDigest(payload);

export const sharedMemorySemanticPrivacyWorkIdentity = (
  target: Pick<
    SharedMemorySemanticPreviewRecord,
    | "id"
    | "sourcePreviewHash"
    | "sourceArtifactHash"
    | "sourceManifestHash"
    | "sourceRevision"
    | "classifierGenerationId"
    | "classifierHash"
    | "effectivePrivacyPolicyHash"
  >
): string =>
  crossIdentitySyncDigest({
    domain: "koed:shared-memory-semantic-privacy-work:v1",
    semanticPreviewId: target.id,
    sourcePreviewHash: target.sourcePreviewHash,
    sourceArtifactHash: target.sourceArtifactHash,
    sourceManifestHash: target.sourceManifestHash,
    sourceRevision: target.sourceRevision,
    classifierGenerationId: target.classifierGenerationId,
    classifierHash: target.classifierHash,
    effectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash
  });

export const sharedMemorySanitizedSemanticSourceRevisionHash = (input: {
  sourcePreviewId: string;
  sourcePreviewHash: string;
  sourceArtifactId: string;
  sourceArtifactHash: string;
  sourceManifestHash: string;
  sourceRevision: number;
  representation: SharedMemoryRepresentation;
  sanitizedSourcePreviewId: string;
  sanitizedContentHash: string;
  sourceItemIdentityHash: string;
  sourceItemCount: number;
  privacyClassifierGenerationId: string;
  privacyClassifierHash: string;
  effectivePrivacyPolicyHash: string;
}): string =>
  crossIdentitySyncDigest({
    kind: "shared_memory_sanitized_source_revision_v1",
    ...input
  });

export const sharedMemorySanitizedSemanticSourceBinding = (input: {
  sourceRevision: number;
  sourceRevisionHash: string;
  fidelityPolicyRevision: number;
  fidelityPolicyHash: string;
  contentPolicyVersion: number;
  effectivePrivacyPolicyHash: string;
  privacyClassifierVersion: number;
  privacyClassifierHash: string;
}): SharedMemorySourceBindingDto => ({
  sourceRevision: input.sourceRevision,
  sourceHash: input.sourceRevisionHash,
  fidelityPolicyRevision: input.fidelityPolicyRevision,
  fidelityPolicyHash: input.fidelityPolicyHash,
  contentPolicyVersion: input.contentPolicyVersion,
  contentPolicyHash: input.effectivePrivacyPolicyHash,
  classifierVersion: input.privacyClassifierVersion,
  classifierHash: input.privacyClassifierHash
});

export const sharedMemorySanitizedSemanticProvenanceHash = (input: {
  shareGrantId: string;
  consentId: string;
  logicalMemoryId: string;
  representation: SharedMemoryRepresentation;
  binding: SharedMemorySourceBindingDto;
  sourcePreviewId: string;
  sourcePreviewHash: string;
  sourceArtifactId: string;
  sourceArtifactHash: string;
  sourceManifestHash: string;
  sanitizedSourcePreviewId: string;
  expectedManifestHash: string;
  expectedChunkCount: number;
  resultManifestHash: string;
  sourceItemIdentityHash: string;
  sourceItemCount: number;
  semanticPayloadBindingHash: string;
  privacyClassifierGenerationId: string;
  privacyClassifierHash: string;
  effectivePrivacyPolicyHash: string;
  sanitizedContentHash: string;
  sourceOwnerPolicyId: string;
  sourceOwnerPolicyVersion: number;
  teamPolicyId: string;
  teamPolicyVersion: number;
  workspacePolicyId: string;
  workspacePolicyVersion: number;
}): string =>
  crossIdentitySyncDigest({
    kind: "shared_memory_sanitized_team_representation_v1",
    ...input
  });

const assertUuid = (value: string, field: string): void => {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID`);
};

const assertHash = (value: string, field: string): void => {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
};

const assertFidelityConsent = (input: {
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
}): void => {
  if (
    input.maximumFidelity !== "memory_events" &&
    input.maximumFidelity !== "lcm_leaves" &&
    input.maximumFidelity !== "lcm_rollups"
  ) {
    throw new TypeError("maximumFidelity must be a supported fidelity ceiling");
  }
  if (typeof input.includeCuratedMemory !== "boolean") {
    throw new TypeError("includeCuratedMemory must be a boolean");
  }
};

const assertEffectiveShareSelection = (input: {
  source: SharedMemorySourceRef;
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  mode: SharedMemoryConsentMode;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
}): void => {
  assertFidelityConsent(input);
  if (
    input.sourceCapabilities.length === 0 ||
    new Set(input.sourceCapabilities).size !==
      input.sourceCapabilities.length ||
    input.sourceCapabilities.some(
      (representation) => !sharedMemoryRepresentations.includes(representation)
    ) ||
    !input.sourceCapabilities.includes(input.activationRepresentation) ||
    !sharedMemoryCeilingAuthorizes(
      input.maximumFidelity,
      input.activationRepresentation,
      input.includeCuratedMemory
    )
  ) {
    throw new SharedMemoryConflictError(
      "Shared Memory activation is outside the effective source and consent boundary"
    );
  }
  if (
    input.source.kind === "personal_note" &&
    (input.sourceCapabilities.length !== 1 ||
      input.sourceCapabilities[0] !== "memory_events" ||
      input.activationRepresentation !== "memory_events" ||
      input.maximumFidelity !== "memory_events" ||
      input.includeCuratedMemory)
  ) {
    throw new SharedMemoryConflictError(
      "Personal Note sharing requires one Memory Event capability"
    );
  }
};

const fidelityConsentFromRow = (row: Row) => ({
  maximumFidelity: stringValue(
    row.maximum_fidelity
  ) as SharedMemoryFidelityCeiling,
  includeCuratedMemory: row.include_curated_memory === true
});

const effectiveFidelityConsent = (...rows: readonly Row[]) => ({
  maximumFidelity: intersectSharedMemoryFidelityCeilings(
    ...rows.map((row) => fidelityConsentFromRow(row).maximumFidelity)
  )!,
  includeCuratedMemory: rows.every(
    (row) => fidelityConsentFromRow(row).includeCuratedMemory
  )
});

const fidelityConsentDoesNotExpand = (
  candidate: {
    maximumFidelity: SharedMemoryFidelityCeiling;
    includeCuratedMemory: boolean;
  },
  current: {
    maximumFidelity: SharedMemoryFidelityCeiling;
    includeCuratedMemory: boolean;
  }
): boolean =>
  sharedMemoryCeilingAuthorizes(
    current.maximumFidelity,
    candidate.maximumFidelity
  ) &&
  (!candidate.includeCuratedMemory || current.includeCuratedMemory);

const cumulativeRepresentationAuthorizationSql = (
  representationSql: string,
  aliases: {
    grant?: string;
    consent?: string;
    ownerPolicy?: string;
    teamPolicy?: string;
    workspacePolicy?: string;
  } = {}
): string => {
  const grant = aliases.grant ?? "g";
  const consent = aliases.consent ?? "c";
  const owner = aliases.ownerPolicy ?? "op";
  const team = aliases.teamPolicy ?? "tp";
  const workspace = aliases.workspacePolicy ?? "wp";
  const ceilingAuthorizes = (alias: string) => `case ${alias}.maximum_fidelity
    when 'memory_events' then ${representationSql} in ('memory_events','lcm_leaves','lcm_rollups')
    when 'lcm_leaves' then ${representationSql} in ('lcm_leaves','lcm_rollups')
    when 'lcm_rollups' then ${representationSql}='lcm_rollups'
    else false end`;
  return `((${representationSql}='curated_assertions'
      and ${grant}.include_curated_memory
      and ${consent}.include_curated_memory
      and ${owner}.include_curated_memory
      and ${team}.include_curated_memory
      and ${workspace}.include_curated_memory)
    or (${representationSql}<>'curated_assertions'
      and ${ceilingAuthorizes(grant)}
      and ${ceilingAuthorizes(consent)}
      and ${ceilingAuthorizes(owner)}
      and ${ceilingAuthorizes(team)}
      and ${ceilingAuthorizes(workspace)}))`;
};

const semanticPrivacyConsentJoinSql = (
  preview = "preview",
  grant = "g",
  consent = "c"
): string => `join lateral (
  select pending.replacement_consent_id as id,
         pending.replacement_maximum_fidelity as maximum_fidelity,
         pending.replacement_include_curated_memory as include_curated_memory
    from pending_share_operation_records pending
   where pending.grant_id=${grant}.id
     and pending.owner_user_id=${grant}.owner_user_id
     and pending.logical_memory_id=${preview}.logical_memory_id
     and pending.team_id=${preview}.team_id
     and pending.team_workspace_id=${preview}.team_workspace_id
     and pending.replacement_representation=${preview}.representation
     and pending.replacement_source_revision=${preview}.source_revision
     and pending.replacement_source_hash=${preview}.source_hash
     and pending.replacement_expected_grant_version=${grant}.grant_version
     and pending.state='preparing'
     and pending.stage in ('activating','privacy_filtering')
     and pending.revoked_at is null
     and exists (
       select 1
         from shared_memory_candidate_preview_records candidate
        where candidate.id=pending.replacement_preview_id
          and candidate.preview_hash=pending.replacement_preview_hash
          and candidate.preview_revision=pending.replacement_preview_revision
          and candidate.owner_user_id=${preview}.owner_user_id
          and candidate.logical_memory_id=${preview}.logical_memory_id
          and candidate.team_id=${preview}.team_id
          and candidate.team_workspace_id=${preview}.team_workspace_id
          and candidate.representation=${preview}.representation
          and candidate.source_revision=${preview}.source_revision
          and candidate.source_hash=${preview}.source_hash
          and candidate.source_kind=${preview}.source_kind
          and candidate.source_note_id is not distinct from ${preview}.source_note_id
          and candidate.source_session_id is not distinct from ${preview}.source_session_id
          and candidate.source_memory_event_id is not distinct from ${preview}.source_memory_event_id
          and candidate.invalidated_at is null
     )
  union all
  select current.id,current.maximum_fidelity,current.include_curated_memory
    from source_owner_representation_consent_records current
   where current.id=${grant}.consent_id
     and current.state='active' and current.revoked_at is null
     and (current.expires_at is null or current.expires_at>now())
     and (current.mode='continuous' or (
       current.preview_id=${preview}.id
       and current.preview_hash=${preview}.preview_hash
       and current.source_revision=${preview}.source_revision
     ))
  limit 1
) ${consent} on true`;

const grantAuthorizesRepresentationSql = (
  representationSql: string,
  grant = "g"
): string => `((${representationSql}='curated_assertions'
    and ${grant}.include_curated_memory)
  or (${representationSql}<>'curated_assertions' and case ${grant}.maximum_fidelity
    when 'memory_events' then ${representationSql} in ('memory_events','lcm_leaves','lcm_rollups')
    when 'lcm_leaves' then ${representationSql} in ('lcm_leaves','lcm_rollups')
    when 'lcm_rollups' then ${representationSql}='lcm_rollups'
    else false end))`;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const requiredString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const createSharedMemoryPreview = (input: {
  representation: SharedMemoryRepresentation;
  logicalMemoryId: string;
  binding: SharedMemorySourceBindingDto;
  items: SharedMemorySourceItemInput[];
}): SharedMemoryPreviewDto => {
  validateBinding(input.binding);
  if (input.items.length === 0 || input.items.length > MAX_SOURCE_ITEMS) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  const items = input.items.map((item) =>
    validateSharedMemoryCanonicalSourceItem({
      representation: input.representation,
      logicalMemoryId: input.logicalMemoryId,
      sourceRevision: input.binding.sourceRevision,
      item
    })
  );
  const sourceContentHash = crossIdentitySyncDigest(items);
  return {
    representation: input.representation,
    logicalMemoryId: input.logicalMemoryId,
    binding: { ...input.binding },
    items,
    sourceContentHash,
    previewHash: crossIdentitySyncDigest({
      representation: input.representation,
      logicalMemoryId: input.logicalMemoryId,
      binding: input.binding,
      sourceContentHash,
      items
    })
  };
};

const validateBinding = (binding: SharedMemorySourceBindingDto): void => {
  if (
    !Number.isSafeInteger(binding.sourceRevision) ||
    binding.sourceRevision < 0
  ) {
    throw new TypeError("sourceRevision must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(binding.fidelityPolicyRevision) ||
    binding.fidelityPolicyRevision < 1 ||
    !Number.isSafeInteger(binding.contentPolicyVersion) ||
    binding.contentPolicyVersion < 1 ||
    !Number.isSafeInteger(binding.classifierVersion) ||
    binding.classifierVersion < 1
  ) {
    throw new TypeError(
      "policy and classifier versions must be positive integers"
    );
  }
  assertHash(binding.sourceHash, "sourceHash");
  assertHash(binding.fidelityPolicyHash, "fidelityPolicyHash");
  assertHash(binding.contentPolicyHash, "contentPolicyHash");
  assertHash(binding.classifierHash, "classifierHash");
};

const mapPolicy = (
  row: Row,
  scope: SharedMemoryPolicyRecord["scope"]
): SharedMemoryPolicyRecord => ({
  id: stringValue(row.id),
  policyId: stringValue(row.policy_id),
  scope,
  logicalMemoryId: row.logical_memory_id
    ? stringValue(row.logical_memory_id)
    : null,
  sourceOwnerPrincipalId: row.source_owner_principal_id
    ? stringValue(row.source_owner_principal_id)
    : null,
  teamId: row.team_id ? stringValue(row.team_id) : null,
  teamWorkspaceId: row.team_workspace_id
    ? stringValue(row.team_workspace_id)
    : null,
  version: numberValue(row.version),
  maximumFidelity: stringValue(
    row.maximum_fidelity
  ) as SharedMemoryFidelityCeiling,
  includeCuratedMemory: row.include_curated_memory === true,
  policyHash: stringValue(row.policy_hash),
  effectiveAt: iso(row.effective_at),
  supersededAt: nullableIso(row.superseded_at)
});

const mapConsent = (row: Row): SharedMemoryConsentRecord => ({
  source: requiredSourceRefFromRow(row),
  sourceCapabilities: representationArrayValue(row.source_capabilities),
  activationRepresentation: representationValue(row.activation_representation),
  id: stringValue(row.id),
  sourceRevisionId: stringValue(row.source_revision_id),
  previewId: stringValue(row.preview_id),
  logicalMemoryId: stringValue(row.logical_memory_id),
  remoteReplicaId: nullableStringValue(row.remote_replica_id),
  sourceOwnerPrincipalId: stringValue(row.source_owner_principal_id),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  sourceOwnerPolicyId: stringValue(row.source_owner_policy_id),
  sourceOwnerPolicyVersion: numberValue(row.source_owner_policy_version),
  teamPolicyId: stringValue(row.team_policy_id),
  teamPolicyVersion: numberValue(row.team_policy_version),
  workspacePolicyId: stringValue(row.workspace_policy_id),
  workspacePolicyVersion: numberValue(row.workspace_policy_version),
  mode: stringValue(row.mode) as SharedMemoryConsentMode,
  state: stringValue(row.state) as SharedMemoryConsentState,
  consentVersion: numberValue(row.consent_version),
  maximumFidelity: stringValue(
    row.maximum_fidelity
  ) as SharedMemoryFidelityCeiling,
  includeCuratedMemory: row.include_curated_memory === true,
  previewRevision: numberValue(row.preview_revision),
  previewHash: stringValue(row.preview_hash),
  sourceRevision: numberValue(row.source_revision),
  maximumAuthorizedSourceRevision:
    row.maximum_authorized_source_revision === null
      ? null
      : numberValue(row.maximum_authorized_source_revision),
  sourceHash: stringValue(row.source_hash),
  fidelityPolicyRevision: numberValue(row.fidelity_policy_revision),
  fidelityPolicyHash: stringValue(row.fidelity_policy_hash),
  contentPolicyVersion: numberValue(row.content_policy_version),
  contentPolicyHash: stringValue(row.content_policy_hash),
  classifierVersion: numberValue(row.classifier_version),
  classifierHash: stringValue(row.classifier_hash),
  sourceContentHash: stringValue(row.source_content_hash),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  activatedAt: nullableIso(row.activated_at),
  revokedAt: nullableIso(row.revoked_at)
});

const companionScope = (grant: {
  id: string;
  teamId: string;
  teamWorkspaceId: string;
  logicalMemoryId: string;
}): SharedMemoryCompanionScopeDto => ({
  scope: "team",
  kind: "shared_session_discussion",
  teamId: grant.teamId,
  teamWorkspaceId: grant.teamWorkspaceId,
  logicalMemoryId: grant.logicalMemoryId,
  shareGrantId: grant.id
});

const mapGrant = (row: Row): SharedMemoryGrantRecord => {
  const grant = {
    source: requiredSourceRefFromRow(row),
    sourceCapabilities: representationArrayValue(row.source_capabilities),
    activationRepresentation: representationValue(
      row.activation_representation
    ),
    mode: stringValue(row.mode) as SharedMemoryConsentMode,
    id: stringValue(row.id),
    sourceRevisionId: stringValue(row.source_revision_id),
    logicalGrantId: stringValue(row.logical_grant_id),
    logicalMemoryId: stringValue(row.logical_memory_id),
    remoteReplicaId: nullableStringValue(row.remote_replica_id),
    ownerUserId: row.owner_user_id ? stringValue(row.owner_user_id) : null,
    ownerPrincipalId: stringValue(row.owner_principal_id),
    sessionId:
      row.source_kind === "captured_session" && row.source_session_id
        ? stringValue(row.source_session_id)
        : null,
    displayTitle: row.display_title ? stringValue(row.display_title) : null,
    teamId: stringValue(row.team_id),
    teamWorkspaceId: stringValue(row.team_workspace_id),
    consentId: stringValue(row.consent_id),
    sourceOwnerPolicyId: stringValue(row.source_owner_policy_id),
    sourceOwnerPolicyVersion: numberValue(row.source_owner_policy_version),
    teamPolicyId: stringValue(row.team_policy_id),
    teamPolicyVersion: numberValue(row.team_policy_version),
    workspacePolicyId: stringValue(row.workspace_policy_id),
    workspacePolicyVersion: numberValue(row.workspace_policy_version),
    maximumFidelity: stringValue(
      row.maximum_fidelity
    ) as SharedMemoryFidelityCeiling,
    includeCuratedMemory: row.include_curated_memory === true,
    fidelityPolicyRevision: numberValue(row.fidelity_policy_revision),
    contentPolicyVersion: numberValue(row.content_policy_version),
    classifierVersion: numberValue(row.classifier_version),
    sourceRevision: numberValue(row.source_revision),
    grantVersion: numberValue(row.grant_version),
    lifecycle: stringValue(row.lifecycle) as SharedMemoryGrantLifecycle,
    creatorAuthority: stringValue(row.creator_authority),
    grantedByUserId: row.granted_by_user_id
      ? stringValue(row.granted_by_user_id)
      : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revokedAt: nullableIso(row.revoked_at)
  };
  return { ...grant, companionScope: companionScope(grant) };
};

const mapPendingShare = (row: Row): PendingShareRecord => ({
  id: stringValue(row.id),
  mutationId: stringValue(row.replacement_mutation_id ?? row.mutation_id),
  logicalGrantId: stringValue(row.logical_grant_id),
  consentId: stringValue(row.replacement_consent_id ?? row.consent_id),
  logicalMemoryId: stringValue(row.logical_memory_id),
  source: requiredPendingShareSourceRefFromRow(row),
  sourceCapabilities: representationArrayValue(row.source_capabilities),
  activationRepresentation: representationValue(row.activation_representation),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  representation: (row.replacement_representation ??
    row.representation) as SharedMemoryRepresentation,
  maximumFidelity: stringValue(
    row.replacement_maximum_fidelity ?? row.maximum_fidelity
  ) as SharedMemoryFidelityCeiling,
  includeCuratedMemory:
    (row.replacement_include_curated_memory ?? row.include_curated_memory) ===
    true,
  mode: (row.replacement_mode ?? row.mode) as SharedMemoryConsentMode,
  sourceRevision: numberValue(
    row.replacement_source_revision ?? row.source_revision
  ),
  state: row.state as PendingShareRecord["state"],
  stage: row.stage as PendingShareRecord["stage"],
  workspaceAccessState:
    row.workspace_access_state as PendingShareRecord["workspaceAccessState"],
  sourceUpdateState:
    row.source_update_state as PendingShareRecord["sourceUpdateState"],
  operationVersion: numberValue(row.operation_version),
  attemptCount: numberValue(row.attempt_count),
  redactedFailureCode:
    row.redacted_failure_code === null
      ? null
      : stringValue(row.redacted_failure_code),
  lastProgressAt: iso(row.last_progress_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  activatedAt: nullableIso(row.activated_at),
  revokedAt: nullableIso(row.revoked_at),
  grantId: row.grant_id === null ? null : stringValue(row.grant_id),
  grantVersion:
    row.grant_id === null
      ? null
      : row.grant_version === null || row.grant_version === undefined
        ? (() => {
            throw new SharedMemoryConflictError(
              "Active Pending Share grant version is unavailable"
            );
          })()
        : numberValue(row.grant_version)
});

const mapRepresentation = (row: Row): SharedMemoryRepresentationRecord => ({
  source: requiredSourceRefFromRow(row),
  id: stringValue(row.id),
  sourceRevisionId: stringValue(row.source_revision_id),
  shareGrantId: stringValue(row.share_grant_id),
  consentId: stringValue(row.consent_id),
  sourcePreviewId: stringValue(row.source_preview_id),
  sourceArtifactId: stringValue(row.source_artifact_id),
  sanitizedSourcePreviewId: stringValue(row.sanitized_source_preview_id),
  privacyClassifierGenerationId: stringValue(
    row.privacy_classifier_generation_id
  ),
  privacyClassifierHash: stringValue(row.privacy_classifier_hash),
  effectivePrivacyPolicyHash: stringValue(row.effective_privacy_policy_hash),
  sourceManifestHash: stringValue(row.source_manifest_hash),
  sanitizedContentHash: stringValue(row.sanitized_content_hash),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  logicalMemoryId: stringValue(row.logical_memory_id),
  representation: stringValue(row.representation) as SharedMemoryRepresentation,
  sourceRevision: numberValue(row.source_revision),
  sourceRevisionHash: stringValue(row.source_revision_hash),
  provenanceHash: stringValue(row.provenance_hash),
  sourceOwnerPolicyId: stringValue(row.source_owner_policy_id),
  sourceOwnerPolicyVersion: numberValue(row.source_owner_policy_version),
  teamPolicyId: stringValue(row.team_policy_id),
  teamPolicyVersion: numberValue(row.team_policy_version),
  workspacePolicyId: stringValue(row.workspace_policy_id),
  workspacePolicyVersion: numberValue(row.workspace_policy_version),
  fidelityPolicyRevision: numberValue(row.fidelity_policy_revision),
  contentPolicyVersion: numberValue(row.content_policy_version),
  classifierVersion: numberValue(row.classifier_version),
  recordVersion: numberValue(row.record_version),
  state: stringValue(row.state) as SharedMemoryRepresentationState,
  chunkCount: numberValue(row.chunk_count),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  availableAt: nullableIso(row.available_at),
  staleAt: nullableIso(row.stale_at),
  invalidatedAt: nullableIso(row.invalidated_at),
  invalidationReasonCode: row.invalidation_reason_code
    ? stringValue(row.invalidation_reason_code)
    : null
});

const mapSemanticPreview = (row: Row): SharedMemorySemanticPreviewRecord => ({
  id: stringValue(row.id),
  sourcePreviewId: stringValue(row.source_preview_id),
  sourceArtifactId: stringValue(row.source_artifact_id),
  sourcePreviewRevision: numberValue(row.source_preview_revision),
  sourcePreviewHash: stringValue(row.source_preview_hash),
  sourceArtifactHash: stringValue(row.source_artifact_hash),
  sourceManifestHash: stringValue(row.source_manifest_hash),
  sourceRevision: numberValue(row.source_revision),
  sourceHash: stringValue(row.source_hash),
  logicalMemoryId: stringValue(row.logical_memory_id),
  ownerUserId: stringValue(row.owner_user_id),
  ownerPrincipalId: stringValue(row.owner_principal_id),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  representation: stringValue(row.representation) as SharedMemoryRepresentation,
  expectedManifestHash: row.expected_manifest_hash
    ? stringValue(row.expected_manifest_hash)
    : null,
  expectedChunkCount:
    row.expected_chunk_count === null || row.expected_chunk_count === undefined
      ? null
      : numberValue(row.expected_chunk_count),
  completedChunkCount: numberValue(row.completed_chunk_count),
  resultManifestHash: row.result_manifest_hash
    ? stringValue(row.result_manifest_hash)
    : null,
  classificationFieldCount:
    row.classification_field_count === null ||
    row.classification_field_count === undefined
      ? null
      : numberValue(row.classification_field_count),
  classificationByteCount:
    row.classification_byte_count === null ||
    row.classification_byte_count === undefined
      ? null
      : numberValue(row.classification_byte_count),
  classifierGenerationId: stringValue(row.classifier_generation_id),
  classifierVersion: numberValue(row.classifier_version),
  classifierHash: stringValue(row.classifier_hash),
  effectivePrivacyPolicyHash: stringValue(row.effective_privacy_policy_hash),
  sourceItemIdentityHash: row.source_item_identity_hash
    ? stringValue(row.source_item_identity_hash)
    : null,
  sourceItemCount:
    row.source_item_count === null || row.source_item_count === undefined
      ? null
      : numberValue(row.source_item_count),
  sanitizedContentHash: row.sanitized_content_hash
    ? stringValue(row.sanitized_content_hash)
    : null,
  payloadBindingHash: row.payload_binding_hash
    ? stringValue(row.payload_binding_hash)
    : null,
  status: stringValue(row.status) as SharedMemorySemanticPreviewStatus,
  failureCode: row.failure_code ? stringValue(row.failure_code) : null,
  lastErrorClass: row.last_error_class
    ? stringValue(row.last_error_class)
    : null,
  attemptCount: numberValue(row.attempt_count),
  nextAttemptAt: nullableIso(row.next_attempt_at),
  schedulingClass: stringValue(row.scheduling_class) as
    | "foreground"
    | "background",
  workReason: stringValue(
    row.work_reason
  ) as SharedMemorySemanticPreviewRecord["workReason"],
  eligibleAt: iso(row.eligible_at),
  enqueuedAt: iso(row.enqueued_at),
  continuationChunkIndex: numberValue(row.continuation_chunk_index),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  readyAt: nullableIso(row.ready_at),
  failedAt: nullableIso(row.failed_at),
  staleAt: nullableIso(row.stale_at),
  invalidatedAt: nullableIso(row.invalidated_at),
  invalidationReasonCode: row.invalidation_reason_code
    ? stringValue(row.invalidation_reason_code)
    : null
});

const mapSemanticClassificationChunk = (
  row: Row
): SharedMemorySemanticClassificationChunkRecord => ({
  id: stringValue(row.id),
  semanticPreviewId: stringValue(row.semantic_preview_id),
  chunkIndex: numberValue(row.chunk_index),
  firstFieldIndex: numberValue(row.first_field_index),
  fieldCount: numberValue(row.field_count),
  inputIdentityHash: stringValue(row.input_identity_hash),
  orderedInputHash: stringValue(row.ordered_input_hash),
  classificationResultId: row.classification_result_id
    ? stringValue(row.classification_result_id)
    : null,
  classificationPayloadBindingHash: row.classification_payload_binding_hash
    ? stringValue(row.classification_payload_binding_hash)
    : null,
  status: stringValue(row.status) as "pending" | "ready",
  createdAt: iso(row.created_at),
  readyAt: nullableIso(row.ready_at)
});

const mapArtifact = (row: Row): SharedMemorySourceArtifactRecord => ({
  source: requiredSourceRefFromRow(row),
  sourceCapabilities: representationArrayValue(row.source_capabilities),
  activationRepresentation: representationValue(row.activation_representation),
  artifactId: stringValue(row.id),
  sourceRevisionId: stringValue(row.source_revision_id),
  artifactHash: stringValue(row.artifact_hash),
  logicalMemoryId: stringValue(row.logical_memory_id),
  remoteReplicaId: nullableStringValue(row.remote_replica_id),
  syncRelationshipId: nullableStringValue(row.sync_relationship_id),
  ownerUserId: row.owner_user_id ? stringValue(row.owner_user_id) : null,
  ownerPrincipalId: stringValue(row.owner_principal_id),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  representation: stringValue(row.representation) as SharedMemoryRepresentation,
  maximumFidelity: stringValue(
    row.maximum_fidelity
  ) as SharedMemoryFidelityCeiling,
  includeCuratedMemory: row.include_curated_memory === true,
  sourceRevision: numberValue(row.source_revision),
  sourceCursor: numberValue(row.source_cursor),
  packageSequence: numberValue(row.package_sequence),
  sourceHash: stringValue(row.source_hash),
  manifestHash: stringValue(row.manifest_hash),
  sourceContentHash: stringValue(row.source_content_hash),
  sourceOwnerPolicyId: stringValue(row.source_owner_policy_id),
  sourceOwnerPolicyVersion: numberValue(row.source_owner_policy_version),
  teamPolicyId: stringValue(row.team_policy_id),
  teamPolicyVersion: numberValue(row.team_policy_version),
  workspacePolicyId: stringValue(row.workspace_policy_id),
  workspacePolicyVersion: numberValue(row.workspace_policy_version),
  representationPolicyRevision: numberValue(row.representation_policy_revision),
  representationPolicyHash: stringValue(row.representation_policy_hash),
  contentPolicyVersion: numberValue(row.content_policy_version),
  contentPolicyHash: stringValue(row.content_policy_hash),
  classifierVersion: numberValue(row.classifier_version),
  classifierHash: stringValue(row.classifier_hash),
  sourceDeploymentIdentityId: stringValue(row.source_deployment_identity_id),
  remoteUserIdentityId: stringValue(row.remote_user_identity_id),
  deviceCredentialId: stringValue(row.device_credential_id),
  deviceProvenanceHash: stringValue(row.device_provenance_hash),
  createdAt: iso(row.created_at)
});

const mapPersistedPreview = (
  row: Row,
  artifact: SharedMemorySourceArtifactRecord,
  preview: SharedSourcePreviewV1,
  artifactBody: SharedSourceArtifactV1
): SharedMemoryPersistedPreviewRecord => ({
  source: preview.source,
  sourceCapabilities: representationArrayValue(row.source_capabilities),
  activationRepresentation: representationValue(row.activation_representation),
  mode: stringValue(row.mode) as SharedMemoryConsentMode,
  previewId: stringValue(row.id),
  sourceRevisionId: stringValue(row.source_revision_id),
  previewHash: stringValue(row.preview_hash),
  artifactId: artifact.artifactId,
  artifactHash: artifact.artifactHash,
  logicalMemoryId: stringValue(row.logical_memory_id),
  remoteReplicaId: nullableStringValue(row.remote_replica_id),
  ownerUserId: row.owner_user_id ? stringValue(row.owner_user_id) : null,
  ownerPrincipalId: stringValue(row.owner_principal_id),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  representation: stringValue(row.representation) as SharedMemoryRepresentation,
  maximumFidelity: artifact.maximumFidelity,
  includeCuratedMemory: artifact.includeCuratedMemory,
  previewRevision: numberValue(row.preview_revision),
  binding: {
    sourceRevision: preview.binding.sourceRevision,
    sourceHash: preview.binding.sourceHash,
    fidelityPolicyRevision: preview.binding.representationPolicyRevision,
    fidelityPolicyHash: preview.binding.representationPolicyHash,
    contentPolicyVersion: preview.binding.contentPolicyVersion,
    contentPolicyHash: preview.binding.contentPolicyHash,
    classifierVersion: preview.binding.classifierVersion,
    classifierHash: preview.binding.classifierHash
  },
  items: preview.items,
  sourceContentHash: stringValue(row.source_content_hash),
  manifest: artifactBody.manifest,
  manifestHash: artifactBody.manifestHash,
  sourceRevision: numberValue(row.source_revision),
  sourceHash: stringValue(row.source_hash),
  syncRelationshipId: artifact.syncRelationshipId,
  deviceProvenanceHash: artifact.deviceProvenanceHash,
  createdAt: iso(row.created_at)
});

const mapWorkspaceIndexEntry = (row: Row): SharedMemoryWorkspaceIndexEntry => {
  const grantScope = {
    id: stringValue(row.share_grant_id),
    teamId: stringValue(row.team_id),
    teamWorkspaceId: stringValue(row.team_workspace_id),
    logicalMemoryId: stringValue(row.logical_memory_id)
  };
  const representationState = stringValue(row.representation_state);
  if (representationState !== "available" && representationState !== "stale") {
    throw new SharedMemoryConflictError(
      "Workspace index selected an unavailable representation"
    );
  }
  return {
    shareGrantId: grantScope.id,
    logicalMemoryId: grantScope.logicalMemoryId,
    ownerUserId: row.owner_user_id ? stringValue(row.owner_user_id) : null,
    ownerDisplayName: row.owner_display_name
      ? stringValue(row.owner_display_name)
      : "Team member",
    maximumFidelity: stringValue(
      row.maximum_fidelity
    ) as SharedMemoryFidelityCeiling,
    includeCuratedMemory: row.include_curated_memory === true,
    sourceCapabilities: representationArrayValue(row.source_capabilities),
    activationRepresentation: representationValue(
      row.activation_representation
    ),
    title: row.display_title ? stringValue(row.display_title) : "Shared Memory",
    activeRepresentation: stringValue(
      row.active_representation
    ) as SharedMemoryRepresentation,
    representationState,
    representationSourceRevision: numberValue(
      row.representation_source_revision
    ),
    representationUpdatedAt: iso(row.representation_updated_at),
    freshness:
      representationState === "stale" ||
      row.replica_freshness_status === "stale" ||
      row.sync_relationship_state === "stale" ||
      row.sync_relationship_state === "revoked" ||
      (row.consent_mode === "continuous" &&
        numberValue(row.representation_source_revision) <
          numberValue(row.target_processing_cursor))
        ? "stale"
        : "fresh",
    lifecycle: stringValue(row.lifecycle) as SharedMemoryGrantLifecycle,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    companionScope: companionScope(grantScope)
  };
};

const withTransaction = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await work(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

class SharedMemoryBundleInvariantError extends Error {}

const consentMatchesBinding = (
  consent: SharedMemoryConsentRecord,
  expected: SharedMemoryConsentBinding
): boolean =>
  consent.logicalMemoryId === expected.logicalMemoryId &&
  consent.teamId === expected.teamId &&
  consent.teamWorkspaceId === expected.teamWorkspaceId &&
  consent.previewId === expected.previewId &&
  consent.previewRevision === expected.previewRevision &&
  consent.previewHash === expected.previewHash &&
  consent.maximumFidelity === expected.maximumFidelity &&
  consent.includeCuratedMemory === expected.includeCuratedMemory;

const grantMatchesBinding = (
  grant: SharedMemoryGrantRecord,
  expected: SharedMemoryConsentBinding & { consentId: string }
): boolean =>
  grant.logicalMemoryId === expected.logicalMemoryId &&
  grant.teamId === expected.teamId &&
  grant.teamWorkspaceId === expected.teamWorkspaceId &&
  grant.consentId === expected.consentId &&
  grant.maximumFidelity === expected.maximumFidelity &&
  grant.includeCuratedMemory === expected.includeCuratedMemory;

const requireWorkspaceAccess = async (
  client: SqlClient,
  actor: ActorContext,
  teamId: string,
  teamWorkspaceId: string,
  required: "read" | "write"
): Promise<void> => {
  const result = await client.query<{ allowed: boolean }>(
    `select exists (
       select 1
       from teams t
       join team_memberships tm
         on tm.team_id=t.id and tm.user_id=$3
        and tm.status='enabled' and tm.disabled_at is null
       join users u
         on u.id=tm.user_id and u.disabled_at is null and u.deleted_at is null
       join team_workspaces tw
         on tw.team_id=t.id and tw.id=$2 and tw.lifecycle='active'
        and tw.archived_at is null
       join team_workspace_access_grants wa
         on wa.team_id=t.id and wa.team_workspace_id=tw.id
        and wa.user_id=$3 and wa.disabled_at is null
       where t.id=$1 and t.lifecycle='active'
         and t.entitlement_status in ('active','grace')
         and wa.access ${required === "write" ? "='write'" : "in ('read','write')"}
     ) as allowed`,
    [teamId, teamWorkspaceId, actor.userId]
  );
  if (result.rows[0]?.allowed !== true)
    throw new SharedMemoryAuthorizationError();
};

const requireWorkspaceSharePermission = async (
  client: SqlClient,
  actor: ActorContext,
  teamId: string,
  teamWorkspaceId: string
): Promise<void> => {
  await requireWorkspaceAccess(client, actor, teamId, teamWorkspaceId, "write");
  const shareAuthority = await client.query<{ allowed: boolean }>(
    `select exists (
       select 1 from team_workspace_access_grants
        where team_id=$1 and team_workspace_id=$2 and user_id=$3
          and access='write' and can_share_owned_memory=true
          and disabled_at is null
     ) as allowed`,
    [teamId, teamWorkspaceId, actor.userId]
  );
  if (shareAuthority.rows[0]?.allowed !== true) {
    throw new SharedMemoryAuthorizationError(
      "Workspace Memory sharing authority is required"
    );
  }
};

const requireTeamManager = async (
  client: SqlClient,
  actor: ActorContext,
  teamId: string
): Promise<void> => {
  const result = await client.query<Row>(
    `select 1
       from teams t
       join team_memberships tm on tm.team_id=t.id
       join users u on u.id=tm.user_id
        and u.disabled_at is null and u.deleted_at is null
      where t.id=$1 and tm.user_id=$2
        and tm.role in ('owner','admin') and tm.status='enabled'
        and tm.disabled_at is null and t.lifecycle='active'
        and t.entitlement_status in ('active','grace')
      limit 1`,
    [teamId, actor.userId]
  );
  if (!result.rows[0]) throw new SharedMemoryAuthorizationError();
};

const requireSourceOwner = async (
  client: SqlClient,
  actor: ActorContext,
  logicalMemoryId: string
): Promise<{ ownerPrincipalId: string; sessionId: string | null }> => {
  const result = await client.query<Row>(
    `select lm.owner_principal_id,source.local_session_id
       from logical_memories lm
       join users u on u.id=lm.owner_user_id
        and u.disabled_at is null and u.deleted_at is null
       left join local_captured_session_logical_memories source
         on source.logical_memory_id=lm.id
      where lm.id=$1 and lm.owner_user_id=$2 and lm.lifecycle='active'
        and lm.invalidated_at is null and lm.purge_completed_at is null
      limit 1`,
    [logicalMemoryId, actor.userId]
  );
  const row = result.rows[0];
  if (!row)
    throw new SharedMemoryAuthorizationError(
      "Only the source owner may perform this operation"
    );
  return {
    ownerPrincipalId: stringValue(row.owner_principal_id),
    sessionId: row.local_session_id ? stringValue(row.local_session_id) : null
  };
};

const authorityReference = (authority: SharedMemoryAuthorityContext): string =>
  `${authority.source}:${authority.referenceId}`;

const requireShareAuthority = async (
  client: SqlClient,
  actor: ActorContext,
  input: {
    teamId: string;
    teamWorkspaceId: string;
    authority: SharedMemoryAuthorityContext;
    consume: boolean;
    delegatedDeviceActionGrant: boolean;
    requireSharePermission?: boolean;
  }
): Promise<string> => {
  if (input.authority.action !== SHARED_MEMORY_AUTHORITY) {
    throw new SharedMemoryAuthorizationError(
      "Explicit Workspace share authority is required"
    );
  }
  assertUuid(input.authority.referenceId, "authority.referenceId");
  if (input.requireSharePermission !== false) {
    await requireWorkspaceSharePermission(
      client,
      actor,
      input.teamId,
      input.teamWorkspaceId
    );
  }

  if (input.authority.source === "browser_session") {
    const session = await client.query(
      `select 1 from user_sessions
        where id=$1 and user_id=$2 and revoked_at is null and expires_at>now()
        limit 1`,
      [input.authority.referenceId, actor.userId]
    );
    if (!session.rows[0]) throw new SharedMemoryAuthorizationError();
    return authorityReference(input.authority);
  }

  if (!input.delegatedDeviceActionGrant) {
    throw new SharedMemoryAuthorizationError(
      "Device Action Grants require atomic high-risk execution"
    );
  }
  return authorityReference(input.authority);
};

const requireRecordedShareAuthority = async (
  client: SqlClient,
  actor: ActorContext,
  input: {
    teamId: string;
    teamWorkspaceId: string;
    authority: SharedMemoryAuthorityContext;
    recordedAuthority?: string;
    delegatedDeviceActionGrant: boolean;
    requireSharePermission?: boolean;
  }
): Promise<void> => {
  assertUuid(input.authority.referenceId, "authority.referenceId");
  if (input.authority.action !== SHARED_MEMORY_AUTHORITY) {
    throw new SharedMemoryAuthorizationError(
      "Explicit Workspace share authority is required"
    );
  }
  if (
    input.recordedAuthority !== undefined &&
    input.recordedAuthority !== authorityReference(input.authority)
  ) {
    throw new SharedMemoryConflictError("Authority idempotency conflict");
  }
  if (input.authority.source === "browser_session") {
    await requireShareAuthority(client, actor, {
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      authority: input.authority,
      consume: false,
      delegatedDeviceActionGrant: input.delegatedDeviceActionGrant,
      requireSharePermission: input.requireSharePermission
    });
    return;
  }
  if (!input.delegatedDeviceActionGrant) {
    throw new SharedMemoryAuthorizationError(
      "Device Action Grants require atomic high-risk execution"
    );
  }
};

const appendOutbox = async (
  client: SqlClient,
  input: {
    mutationId: string;
    family:
      | "share_grant_lifecycle"
      | "fidelity_changed"
      | "source_revision_changed"
      | "memory_event_available"
      | "lcm_leaf_available"
      | "lcm_rollup_available"
      | "access_revoked";
    teamId: string;
    teamWorkspaceId: string;
    shareGrantId: string;
    logicalMemoryId: string;
    resourceType: string;
    resourceId: string;
    actorPrincipalId: string | null;
  }
): Promise<void> => {
  const result = await client.query<Row>(
    `insert into collaboration_outbox (
       protocol_version, family, scope, team_id, team_workspace_id,
       share_grant_id, logical_memory_id, resource_type, resource_id,
       actor_principal_id, mutation_id, replay_until
     ) values (1,$1,'team',$2,$3,$4,$5,$6,$7,$8,$9,
       now()+make_interval(days=>$10::int))
     on conflict (mutation_id,family) do update
       set mutation_id=excluded.mutation_id
     returning team_id,team_workspace_id,share_grant_id,logical_memory_id,
               resource_type,resource_id,actor_principal_id`,
    [
      input.family,
      input.teamId,
      input.teamWorkspaceId,
      input.shareGrantId,
      input.logicalMemoryId,
      input.resourceType,
      input.resourceId,
      input.actorPrincipalId,
      input.mutationId,
      OUTBOX_REPLAY_DAYS
    ]
  );
  const row = result.rows[0];
  if (
    !row ||
    row.team_id !== input.teamId ||
    row.team_workspace_id !== input.teamWorkspaceId ||
    row.share_grant_id !== input.shareGrantId ||
    row.logical_memory_id !== input.logicalMemoryId ||
    row.resource_type !== input.resourceType ||
    row.resource_id !== input.resourceId ||
    row.actor_principal_id !== input.actorPrincipalId
  ) {
    throw new SharedMemoryConflictError("Collaboration mutation ID was reused");
  }
  await client.query(
    `select pg_notify(
       'koed_collaboration_realtime',
       json_build_object(
         'scope', 'team',
         'teamId', $1::uuid,
         'cursor', (
           select cursor
             from collaboration_outbox
            where mutation_id=$2 and family=$3
         ),
         'family', $3::text
       )::text
     )`,
    [input.teamId, input.mutationId, input.family]
  );
};

const appendPendingShareOwnerEvent = async (
  client: SqlClient,
  input: {
    mutationId: string;
    ownerUserId: string;
    pendingShareId: string;
  }
): Promise<void> => {
  const result = await client.query<Row>(
    `insert into collaboration_outbox (
       protocol_version,family,scope,personal_owner_user_id,
       resource_type,resource_id,actor_principal_id,mutation_id,replay_until
     ) values (1,'pending_share_lifecycle','personal',$1,
       'pending_share_operations',$2,$1,$3,
       now()+make_interval(days=>$4::int))
     on conflict (mutation_id,family) do update
       set mutation_id=excluded.mutation_id
     returning personal_owner_user_id,resource_type,resource_id,actor_principal_id`,
    [
      input.ownerUserId,
      input.pendingShareId,
      input.mutationId,
      OUTBOX_REPLAY_DAYS
    ]
  );
  const row = result.rows[0];
  if (
    !row ||
    row.personal_owner_user_id !== input.ownerUserId ||
    row.resource_type !== "pending_share_operations" ||
    row.resource_id !== input.pendingShareId ||
    row.actor_principal_id !== input.ownerUserId
  ) {
    throw new SharedMemoryConflictError(
      "Pending Share lifecycle mutation ID was reused"
    );
  }
  await client.query(
    `select pg_notify(
       'koed_collaboration_realtime',
       json_build_object(
         'scope','personal','ownerUserId',$1::uuid,
         'cursor',(select cursor from collaboration_outbox
                    where mutation_id=$2 and family='pending_share_lifecycle'),
         'family','pending_share_lifecycle'
       )::text
     )`,
    [input.ownerUserId, input.mutationId]
  );
};

const cascadeParentShareRevocation = async (
  client: SqlClient,
  input: {
    shareGrantId: string;
    actorUserId: string;
    mutationId: string;
    revokedAt: Date;
  }
): Promise<void> => {
  const sourceRevocationMutationId = crossIdentitySyncDeterministicUuid({
    kind: "parent_share_source_revocation",
    shareGrantId: input.shareGrantId,
    mutationId: input.mutationId
  });
  const source = await client.query<Row>(
    `update team_conversation_source_grants
        set lifecycle='revoked',version=version+1,mutation_id=$2,
            revoked_at=$3,revoked_by_user_id=$4,
            revocation_reason='parent_share_revoked',updated_at=now()
      where share_grant_id=$1 and lifecycle='active'
      returning id`,
    [
      input.shareGrantId,
      sourceRevocationMutationId,
      input.revokedAt,
      input.actorUserId
    ]
  );
  if ((source.rowCount ?? 0) > 0) {
    await client.query(
      `select pg_notify(
         'koed_team_conversation_source',
         json_build_object(
           'shareGrantId',$1::uuid,'reason','revoked'
         )::text
       )`,
      [input.shareGrantId]
    );
  }

  const pending = await client.query<Row>(
    `update pending_share_operations
        set state='revoked',stage='complete',workspace_access_state='revoked',
            source_update_state='stopped',revoked_at=coalesce(revoked_at,$2),
            redacted_failure_code=null,updated_at=now(),
            operation_version=operation_version+1
      where grant_id=$1 and state<>'revoked'
      returning id,owner_user_id,operation_version`,
    [input.shareGrantId, input.revokedAt]
  );
  for (const row of pending.rows) {
    const pendingShareId = stringValue(row.id);
    await client.query(
      `update pending_share_outbox
          set state='completed',locked_at=null,updated_at=now()
        where pending_share_id=$1`,
      [pendingShareId]
    );
    await appendPendingShareOwnerEvent(client, {
      mutationId: crossIdentitySyncDeterministicUuid({
        kind: "pending_share_lifecycle",
        pendingShareId,
        state: "revoked",
        operationVersion: numberValue(row.operation_version),
        parentMutationId: input.mutationId
      }),
      ownerUserId: stringValue(row.owner_user_id),
      pendingShareId
    });
  }
};

const appendPolicyAudit = async (
  client: SqlClient,
  input: {
    actorUserId: string;
    ownerUserId: string | null;
    action: string;
    targetTable: string;
    targetId: string;
    mutationId: string;
    scope: "source_owner" | "team" | "workspace";
    logicalMemoryId?: string;
    teamId?: string;
    teamWorkspaceId?: string;
    policyId: string;
    version: number;
    previousVersion: number;
    maximumFidelity: SharedMemoryFidelityCeiling;
    includeCuratedMemory: boolean;
  }
): Promise<void> => {
  await client.query(
    `insert into audit_events (
       actor_user_id,owner_user_id,visibility,action,target_table,target_id,metadata
     ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      input.actorUserId,
      input.ownerUserId,
      input.ownerUserId ? "personal" : null,
      input.action,
      input.targetTable,
      input.targetId,
      JSON.stringify({
        mutationId: input.mutationId,
        scope: input.scope,
        logicalMemoryId: input.logicalMemoryId ?? null,
        teamId: input.teamId ?? null,
        teamWorkspaceId: input.teamWorkspaceId ?? null,
        policyId: input.policyId,
        version: input.version,
        previousVersion: input.previousVersion,
        maximumFidelity: input.maximumFidelity,
        includeCuratedMemory: input.includeCuratedMemory
      })
    ]
  );
};

const invalidateAffectedGrants = async (
  client: SqlClient,
  input: {
    mutationId: string;
    actorUserId: string;
    whereSql: string;
    parameters: unknown[];
    reasonCode: string;
  }
): Promise<void> => {
  const affected = await client.query<Row>(
    `update team_memory_share_grants g
        set lifecycle='unavailable', grant_version=grant_version+1, updated_at=now()
      where g.lifecycle='active' and (${input.whereSql})
      returning g.*`,
    input.parameters
  );
  for (const raw of affected.rows) {
    const row = raw as Row;
    await client.query(
      `update team_memory_representations
          set state='invalidated', invalidated_at=now(),
              invalidation_reason_code=$2, record_version=record_version+1,
              updated_at=now()
        where share_grant_id=$1 and state in ('pending','available','stale')`,
      [row.id, input.reasonCode]
    );
    await client.query(
      `delete from team_memory_semantic_items where share_grant_id=$1`,
      [row.id]
    );
    await appendOutbox(client, {
      mutationId: crossIdentitySyncDeterministicUuid({
        parentMutationId: input.mutationId,
        shareGrantId: row.id,
        reasonCode: input.reasonCode
      }),
      family: "fidelity_changed",
      teamId: stringValue(row.team_id),
      teamWorkspaceId: stringValue(row.team_workspace_id),
      shareGrantId: stringValue(row.id),
      logicalMemoryId: stringValue(row.logical_memory_id),
      resourceType: "team_memory_representation",
      resourceId: stringValue(row.id),
      actorPrincipalId: input.actorUserId
    });
  }
};

const activePolicy = async (
  client: SqlClient,
  input: {
    table:
      | "source_owner_representation_policies"
      | "team_representation_policies"
      | "workspace_representation_policies";
    whereSql: string;
    parameters: unknown[];
  }
): Promise<Row | null> => {
  const result = await client.query(
    `select * from ${input.table} where ${input.whereSql}
      and superseded_at is null for update`,
    input.parameters
  );
  return (result.rows[0] as Row | undefined) ?? null;
};

const requireCurrentPolicies = async (
  client: SqlClient,
  input: {
    logicalMemoryId: string;
    ownerPrincipalId: string;
    teamId: string;
    teamWorkspaceId: string;
  }
): Promise<{
  owner: Row;
  team: Row;
  workspace: Row;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
}> => {
  const owner = await activePolicy(client, {
    table: "source_owner_representation_policies",
    whereSql: "logical_memory_id=$1 and source_owner_principal_id=$2",
    parameters: [input.logicalMemoryId, input.ownerPrincipalId]
  });
  const team = await activePolicy(client, {
    table: "team_representation_policies",
    whereSql: "team_id=$1",
    parameters: [input.teamId]
  });
  const workspace = await activePolicy(client, {
    table: "workspace_representation_policies",
    whereSql: "team_id=$1 and team_workspace_id=$2",
    parameters: [input.teamId, input.teamWorkspaceId]
  });
  if (!owner || !team || !workspace) {
    throw new SharedMemoryConflictError(
      "All three active representation policies are required"
    );
  }
  return {
    owner,
    team,
    workspace,
    ...effectiveFidelityConsent(owner, team, workspace)
  };
};

const sameConsentCreate = (
  row: Row,
  input: {
    logicalMemoryId: string;
    remoteReplicaId: string | null;
    teamId: string;
    teamWorkspaceId: string;
    mode: SharedMemoryConsentMode;
    maximumFidelity: SharedMemoryFidelityCeiling;
    includeCuratedMemory: boolean;
    preview: SharedSourcePreviewReference;
  }
): boolean =>
  row.logical_memory_id === input.logicalMemoryId &&
  row.remote_replica_id === input.remoteReplicaId &&
  row.team_id === input.teamId &&
  row.team_workspace_id === input.teamWorkspaceId &&
  row.mode === input.mode &&
  row.maximum_fidelity === input.maximumFidelity &&
  row.include_curated_memory === input.includeCuratedMemory &&
  row.preview_id === input.preview.previewId &&
  row.preview_hash === input.preview.previewHash;

const representationAvailableFamily = (
  representation: SharedMemoryRepresentation
):
  | "memory_event_available"
  | "lcm_leaf_available"
  | "lcm_rollup_available"
  | "fidelity_changed" =>
  representation === "memory_events"
    ? "memory_event_available"
    : representation === "lcm_leaves"
      ? "lcm_leaf_available"
      : representation === "lcm_rollups"
        ? "lcm_rollup_available"
        : "fidelity_changed";

const chunkItems = (
  items: SharedMemoryCanonicalSourceItemDto[]
): SharedMemoryCanonicalSourceItemDto[][] => {
  const chunks: SharedMemoryCanonicalSourceItemDto[][] = [];
  let current: SharedMemoryCanonicalSourceItemDto[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (
      Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_CHUNK_BYTES
    ) {
      if (current.length === 0) {
        throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
      }
      chunks.push(current);
      current = [item];
      if (
        Buffer.byteLength(JSON.stringify(current), "utf8") > MAX_CHUNK_BYTES
      ) {
        throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
      }
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

const ciphertextHash = (ciphertext: string): string =>
  createHash("sha256").update(Buffer.from(ciphertext, "base64")).digest("hex");

const envelopeScope = (input: {
  teamId: string;
  teamWorkspaceId: string;
}): EncryptedPayloadEnvelope["scope"] => ({
  teamId: input.teamId,
  workspaceId: input.teamWorkspaceId,
  objectClass: "shared_memory_representation_chunk"
});

const envelopeProvenance = (
  representationId: string
): EncryptedPayloadEnvelope["provenance"] => ({
  rowFamily: "team_memory_representation_chunk",
  sourceTable: "team_memory_representations",
  sourceId: representationId
});

const SHARED_MEMORY_CHUNK_FORMAT_VERSION = 1;
const SHARED_MEMORY_SEMANTIC_PREVIEW_FORMAT_VERSION = 1;
const SHARED_MEMORY_SEMANTIC_PREVIEW_SOURCE =
  "shared_source_semantic_previews" as const;
const SHARED_MEMORY_SEMANTIC_PREVIEW_COLUMN = "sanitized_preview";
const SHARED_MEMORY_PRIVACY_WAKE_CHANNEL = "koed_shared_memory_privacy";
const SAFE_LIFECYCLE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;

const envelopeAad = (input: {
  representationId: string;
  shareGrantId: string;
  teamId: string;
  teamWorkspaceId: string;
  logicalMemoryId: string;
  consentId: string;
  representation: SharedMemoryRepresentation;
  chunkIndex: number;
  chunkCount: number;
  itemOffset: number;
  itemCount: number;
  totalItemCount: number;
  binding: SharedMemorySourceBindingDto;
  sourceContentHash: string;
  provenanceHash: string;
}): Record<string, string | number> => ({
  chunkFormatVersion: SHARED_MEMORY_CHUNK_FORMAT_VERSION,
  representationId: input.representationId,
  shareGrantId: input.shareGrantId,
  teamId: input.teamId,
  teamWorkspaceId: input.teamWorkspaceId,
  logicalMemoryId: input.logicalMemoryId,
  consentId: input.consentId,
  representation: input.representation,
  chunkIndex: input.chunkIndex,
  chunkCount: input.chunkCount,
  itemOffset: input.itemOffset,
  itemCount: input.itemCount,
  totalItemCount: input.totalItemCount,
  sourceRevision: input.binding.sourceRevision,
  sourceHash: input.binding.sourceHash,
  fidelityPolicyRevision: input.binding.fidelityPolicyRevision,
  fidelityPolicyHash: input.binding.fidelityPolicyHash,
  contentPolicyVersion: input.binding.contentPolicyVersion,
  contentPolicyHash: input.binding.contentPolicyHash,
  classifierVersion: input.binding.classifierVersion,
  classifierHash: input.binding.classifierHash,
  sourceContentHash: input.sourceContentHash,
  provenanceHash: input.provenanceHash
});

const aadMatches = (
  actual: Record<string, string>,
  expected: Record<string, string | number>
): boolean =>
  Object.entries(expected).every(
    ([key, value]) => actual[key] === String(value)
  ) && Object.keys(actual).length === Object.keys(expected).length;

export const createSharedMemoryRepository = (
  pool: pg.Pool,
  options: {
    resolveTeamEncryptionProvider: (input: {
      teamId: string;
      purpose: "encrypt" | "decrypt";
      keyId?: string;
      keyVersion?: number;
    }) => EnvelopeEncryptionProvider | Promise<EnvelopeEncryptionProvider>;
    resolveOwnerPrivateReplicaEncryptionProvider: (input: {
      ownerUserId: string;
      ownerPrincipalId: string;
      logicalMemoryId: string;
      remoteReplicaId: string | null;
      teamId: string;
      teamWorkspaceId: string;
      purpose: "encrypt" | "decrypt";
      keyId?: string;
      keyVersion?: number;
    }) => EnvelopeEncryptionProvider | Promise<EnvelopeEncryptionProvider>;
    resolvePersonalEncryptionProvider: (input: {
      ownerUserId: string;
      purpose: "decrypt";
    }) => EnvelopeEncryptionProvider | Promise<EnvelopeEncryptionProvider>;
    delegatedDeviceActionGrantExecution?: boolean;
    /** Test-only boundary hook for deterministic claim/revocation races. */
    afterSharedMemorySemanticClaimForTest?: () => Promise<void>;
    /** Test-only hook while exact authorization locks remain held after decrypt. */
    afterSharedMemorySemanticDecryptForTest?: () => Promise<void>;
  }
): SharedMemoryRepository => {
  const delegatedDeviceActionGrant =
    options.delegatedDeviceActionGrantExecution === true;
  const resolveOwnerPrivateReplicaEncryptionProvider = async (input: {
    ownerUserId: string;
    ownerPrincipalId: string;
    logicalMemoryId: string;
    remoteReplicaId: string | null;
    teamId: string;
    teamWorkspaceId: string;
    purpose: "encrypt" | "decrypt";
    keyId?: string;
    keyVersion?: number;
  }): Promise<EnvelopeEncryptionProvider> =>
    options.resolveOwnerPrivateReplicaEncryptionProvider(input);

  const nullableString = (value: unknown): string | null =>
    value === null || value === undefined
      ? null
      : typeof value === "string"
        ? value
        : typeof value === "number" ||
            typeof value === "bigint" ||
            typeof value === "boolean"
          ? String(value)
          : null;

  const nullableNumber = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);

  const mapPrivacyPolicy = (row: Row): PrivacyContentPolicyRecord => ({
    id: stringValue(row.id),
    policyId: stringValue(row.policy_id),
    version: numberValue(row.version),
    scope: stringValue(row.scope) as PrivacyContentPolicyRecord["scope"],
    deploymentIdentityId: stringValue(row.deployment_identity_id),
    sourceOwnerUserId: nullableString(row.source_owner_user_id),
    teamId: nullableString(row.team_id),
    teamWorkspaceId: nullableString(row.team_workspace_id),
    labels: row.labels as PrivacyContentPolicyRecord["labels"],
    replacementContractVersion: stringValue(row.replacement_contract_version),
    policyHash: stringValue(row.policy_hash),
    status: stringValue(row.status) as PrivacyContentPolicyRecord["status"],
    effectiveAt: iso(row.effective_at),
    createdAt: iso(row.created_at),
    supersededAt: nullableIso(row.superseded_at),
    revokedAt: nullableIso(row.revoked_at),
    revocationReasonCode: nullableString(row.revocation_reason_code)
  });

  const resolveCurrentPrivacyPolicy = async (
    client: SqlClient,
    input: {
      ownerUserId: string;
      teamId: string;
      teamWorkspaceId: string;
      lockRows?: boolean;
    }
  ) => {
    const result = await client.query<Row>(
      `select policy.*
         from privacy_content_policies policy
         join deployment_identities deployment
           on deployment.id=policy.deployment_identity_id
          and deployment.locality='local'
          and deployment.disabled_at is null
        where policy.status='active'
          and policy.effective_at<=now()
          and (
            (policy.scope='deployment'
              and policy.source_owner_user_id is null
              and policy.team_id is null
              and policy.team_workspace_id is null)
            or (policy.scope='source_owner'
              and policy.source_owner_user_id=$1
              and policy.team_id is null
              and policy.team_workspace_id is null)
            or (policy.scope='team'
              and policy.source_owner_user_id is null
              and policy.team_id=$2
              and policy.team_workspace_id is null)
            or (policy.scope='workspace'
              and policy.source_owner_user_id is null
              and policy.team_id=$2
              and policy.team_workspace_id=$3)
          )
        order by policy.version desc
        ${input.lockRows ? "for share of policy,deployment" : ""}`,
      [input.ownerUserId, input.teamId, input.teamWorkspaceId]
    );
    const policies = result.rows.map(mapPrivacyPolicy);
    if (!policies.some((policy) => policy.scope === "deployment")) {
      throw new SharedMemoryConflictError(
        "Active deployment privacy policy is required"
      );
    }
    if (
      new Set(policies.map((policy) => policy.scope)).size !== policies.length
    ) {
      throw new SharedMemoryConflictError(
        "Privacy policy scope resolution is ambiguous"
      );
    }
    try {
      return resolveMonotonicPrivacyPolicySet(policies);
    } catch {
      throw new SharedMemoryConflictError(
        "Effective privacy policy binding is invalid"
      );
    }
  };

  const loadActivePrivacyClassifier = async (
    client: SqlClient
  ): Promise<{ id: string; version: number; classifierHash: string }> => {
    const result = await client.query<Row>(
      `select id,version,classifier_hash
         from privacy_classifier_generations
        where status='active' and revoked_at is null
        limit 2`
    );
    if (result.rows.length !== 1) {
      throw new SharedMemoryConflictError(
        "Exactly one active privacy classifier generation is required"
      );
    }
    const row = result.rows[0]!;
    return {
      id: stringValue(row.id),
      version: numberValue(row.version),
      classifierHash: stringValue(row.classifier_hash)
    };
  };

  const assertLifecycleCode = (value: string, field: string): void => {
    if (!SAFE_LIFECYCLE_CODE_PATTERN.test(value)) {
      throw new TypeError(
        `${field} must be a lowercase lifecycle code no longer than 120 characters`
      );
    }
  };

  const encryptedJsonMarkerMatches = (
    value: unknown,
    sourceTable: string,
    sourceColumn: string
  ): boolean =>
    isPlainObject(value) &&
    value.contentEncrypted === true &&
    value.encryptedSourceTable === sourceTable &&
    value.encryptedSourceColumn === sourceColumn;

  const requireHydratedValue = <T>(
    value: T | null | undefined,
    message: string
  ): T => {
    if (value === null || value === undefined) {
      throw new SharedMemoryConflictError(message);
    }
    return value;
  };

  const deviceProvenanceHash = (row: Row): string =>
    sharedMemoryDeviceProvenanceHash({
      syncRelationshipId: stringValue(row.sync_relationship_id),
      deviceCredentialId: stringValue(row.device_credential_id),
      credentialKeyId: stringValue(row.credential_key_id),
      upstreamBackendId: stringValue(row.upstream_backend_id),
      deviceInstanceId: stringValue(row.device_instance_id),
      lineageId: stringValue(row.lineage_id),
      credentialVersion: numberValue(row.credential_version),
      verifierKind: stringValue(row.verifier_kind),
      verifierHash: nullableString(row.verifier_hash),
      publicKeyJwk: row.public_key_jwk ?? null
    });

  const fidelityPolicyHashForPreview = (input: {
    representation: SharedMemoryRepresentation;
    revision: number;
    owner: SharedMemoryPolicyRecord;
    team: SharedMemoryPolicyRecord;
    workspace: SharedMemoryPolicyRecord;
  }): string =>
    crossIdentitySyncDigest({
      kind: "shared_memory_fidelity_policy",
      representation: input.representation,
      revision: input.revision,
      owner: {
        policyId: input.owner.policyId,
        version: input.owner.version,
        hash: input.owner.policyHash
      },
      team: {
        policyId: input.team.policyId,
        version: input.team.version,
        hash: input.team.policyHash
      },
      workspace: {
        policyId: input.workspace.policyId,
        version: input.workspace.version,
        hash: input.workspace.policyHash
      }
    });

  const contentPolicyHashForPreview = (input: {
    representation: SharedMemoryRepresentation;
    version: number;
  }): string =>
    crossIdentitySyncDigest({
      kind: "shared_memory_content_policy",
      representation: input.representation,
      version: input.version
    });

  const classifierHashForPreview = (input: {
    representation: SharedMemoryRepresentation;
    version: number;
  }): string =>
    crossIdentitySyncDigest({
      kind: "shared_memory_classifier",
      representation: input.representation,
      version: input.version
    });

  type AuthoritativeSyncContext = {
    logicalMemoryId: string;
    remoteReplicaId: string;
    localSessionId: string;
    sourceSessionId: string;
    ownerUserId: string;
    ownerPrincipalId: string;
    teamId: string;
    teamWorkspaceId: string;
    syncRelationshipId: string;
    localReplicaId: string;
    remoteSyncReplicaId: string;
    sourceRevision: number;
    sourceCursor: number;
    packageSequence: number;
    sourceCapabilities: SharedMemoryRepresentation[];
    activationRepresentation: SharedMemoryRepresentation;
    mode: SharedMemoryConsentMode;
    fidelityPolicyRevision: number;
    fidelityPolicyHash: string;
    maximumFidelity: SharedMemoryFidelityCeiling;
    includeCuratedMemory: boolean;
    contentPolicyVersion: number;
    contentPolicyHash: string;
    classifierVersion: number;
    classifierHash: string;
    sourceOwnerPolicyId: string;
    sourceOwnerPolicyVersion: number;
    teamPolicyId: string;
    teamPolicyVersion: number;
    workspacePolicyId: string;
    workspacePolicyVersion: number;
    sourceDeploymentIdentityId: string;
    remoteUserIdentityId: string;
    deviceCredentialId: string;
    deviceProvenanceHash: string;
  };

  type PersistedPreviewLoadResult = {
    artifact: SharedMemorySourceArtifactRecord;
    preview: SharedMemoryPersistedPreviewRecord;
    artifactBody: SharedSourceArtifactV1;
    previewBody: SharedSourcePreviewV1;
  };

  type ArtifactPersistenceContext = Pick<
    AuthoritativeSyncContext,
    | "logicalMemoryId"
    | "ownerUserId"
    | "ownerPrincipalId"
    | "teamId"
    | "teamWorkspaceId"
    | "sourceRevision"
    | "sourceCursor"
    | "packageSequence"
    | "sourceCapabilities"
    | "activationRepresentation"
    | "mode"
    | "fidelityPolicyRevision"
    | "fidelityPolicyHash"
    | "maximumFidelity"
    | "includeCuratedMemory"
    | "contentPolicyVersion"
    | "contentPolicyHash"
    | "classifierVersion"
    | "classifierHash"
    | "sourceOwnerPolicyId"
    | "sourceOwnerPolicyVersion"
    | "teamPolicyId"
    | "teamPolicyVersion"
    | "workspacePolicyId"
    | "workspacePolicyVersion"
    | "sourceDeploymentIdentityId"
    | "remoteUserIdentityId"
    | "deviceCredentialId"
    | "deviceProvenanceHash"
  > & {
    remoteReplicaId: string | null;
    syncRelationshipId: string | null;
  };

  const proposedSourceOwnerPolicy = (input: {
    existing: Row | null | undefined;
    logicalMemoryId: string;
    ownerPrincipalId: string;
    maximumFidelity: SharedMemoryFidelityCeiling;
    includeCuratedMemory: boolean;
    policyId?: string;
    version?: number;
  }): SharedMemoryPolicyRecord => {
    const policyId =
      input.policyId ??
      (input.existing ? stringValue(input.existing.policy_id) : randomUUID());
    const version =
      input.version ??
      (input.existing ? numberValue(input.existing.version) + 1 : 1);
    assertFidelityConsent(input);
    return {
      id: policyId,
      policyId,
      scope: "source_owner",
      logicalMemoryId: input.logicalMemoryId,
      sourceOwnerPrincipalId: input.ownerPrincipalId,
      teamId: null,
      teamWorkspaceId: null,
      version,
      maximumFidelity: input.maximumFidelity,
      includeCuratedMemory: input.includeCuratedMemory,
      policyHash: sharedMemoryPolicyHash({
        scope: "source_owner",
        scopeId: `${input.logicalMemoryId}:${input.ownerPrincipalId}`,
        policyId,
        version,
        maximumFidelity: input.maximumFidelity,
        includeCuratedMemory: input.includeCuratedMemory
      }),
      effectiveAt: new Date().toISOString(),
      supersededAt: null
    };
  };

  type LoadedMappedEvent = {
    eventId: string;
    sourceCursor: number;
    mappedRevisionHash: string;
    occurredAt: string | null;
    contributorItems: SharedMemoryCanonicalSourceItemDto[];
    manifestEntries: SharedSourceArtifactV1["manifest"];
  };

  type LoadedNodeItem = {
    item: SharedMemoryCanonicalSourceItemDto;
    manifestEntry: SharedSourceArtifactV1["manifest"][number];
    sourceEventIds: string[];
    nodeRevisionHash: string;
  };

  type AuthoritativeSourceMaterial = {
    items: SharedMemoryCanonicalSourceItemDto[];
    manifest: SharedSourceArtifactV1["manifest"];
    manifestHash: string;
    sourceContentHash: string;
    sourceHash: string;
    mappedEvents: Map<string, LoadedMappedEvent>;
  };

  const hydrateOwnerPrivateEncryptedField = async (
    client: pg.PoolClient,
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider | null,
    input: {
      ownerPrincipalId: string;
      sourceTable: "conversation_items" | "memory_events" | "memory_nodes";
      sourceId: string;
      sourceColumn: string;
      fallback: unknown;
      requiredMessage: string;
    }
  ): Promise<unknown> => {
    if (provider) {
      const decrypted = await decryptOwnerPrivateEncryptedFieldWithClient(
        client,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: input.sourceTable,
          sourceId: input.sourceId,
          sourceColumn: input.sourceColumn
        }
      );
      if (decrypted?.record.ownerUserId === actor.userId) {
        return decrypted.plaintext;
      }
    }
    if (
      input.fallback === ENCRYPTED_CONVERSATION_ITEM_TEXT ||
      input.fallback === ENCRYPTED_MEMORY_NODE_TEXT ||
      encryptedJsonMarkerMatches(
        input.fallback,
        input.sourceTable,
        input.sourceColumn
      )
    ) {
      throw new SharedMemoryConflictError(input.requiredMessage);
    }
    return input.fallback;
  };

  const decryptPersistedOwnerPrivatePayload = async (
    client: pg.PoolClient,
    input: {
      sourceTable: "shared_source_artifacts" | "shared_source_previews";
      sourceId: string;
      sourceColumn: "artifact" | "preview";
      ownerUserId: string;
      ownerPrincipalId: string;
      logicalMemoryId: string;
      remoteReplicaId: string | null;
      teamId: string;
      teamWorkspaceId: string;
      requiredMessage: string;
    }
  ): Promise<unknown> => {
    const provider = await resolveOwnerPrivateReplicaEncryptionProvider({
      ownerUserId: input.ownerUserId,
      ownerPrincipalId: input.ownerPrincipalId,
      logicalMemoryId: input.logicalMemoryId,
      remoteReplicaId: input.remoteReplicaId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      purpose: "decrypt"
    });
    const decrypted = await decryptOwnerPrivateEncryptedFieldWithClient(
      client,
      provider,
      {
        ownerPrincipalId: input.ownerPrincipalId,
        sourceTable: input.sourceTable,
        sourceId: input.sourceId,
        sourceColumn: input.sourceColumn
      }
    );
    if (!decrypted) {
      throw new SharedMemoryConflictError(input.requiredMessage);
    }
    return decrypted.plaintext;
  };

  const RAW_REASONING_LABEL_PATTERN =
    /reasoning[_/ -]?raw|raw[_/ -]?reasoning|raw[_/ -]?content|reasoningTextDelta|ReasoningTextDelta|reasoning[_/ -]?text[_/ -]?delta|ReasoningRawContent|ReasoningRawContentDelta/i;
  const REASONING_LABEL_PATTERN = /reasoning|thought/i;
  const SYSTEM_LABEL_PATTERN =
    /system|developer|instruction|prompt|hidden[_ -]?reasoning|chain[_ -]?of[_ -]?thought/i;

  const uniqueOrderedUuids = (values: Iterable<string>): string[] => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (!seen.has(value)) {
        seen.add(value);
        ordered.push(value);
      }
    }
    return ordered;
  };

  const strictAuthoritativeSourceItem = (input: {
    representation: SharedMemoryRepresentation;
    logicalMemoryId: string;
    sourceRevision: number;
    itemType: SharedMemorySourceItemType;
    sourceId: string;
    occurredAt: string | null;
    content: Record<string, unknown>;
  }): SharedMemoryCanonicalSourceItemDto => {
    const sourceItem: SharedMemorySourceItemInput = {
      itemType: input.itemType,
      schemaVersion: 1,
      sourceId: input.sourceId,
      sourceLogicalMemoryId: input.logicalMemoryId,
      sourceRevision: input.sourceRevision,
      occurredAt: input.occurredAt,
      content: input.content
    };
    return validateSharedMemoryCanonicalSourceItem({
      representation: input.representation,
      logicalMemoryId: input.logicalMemoryId,
      sourceRevision: input.sourceRevision,
      item: sourceItem
    });
  };

  const classifyMemoryEventItemType = (input: {
    actor: string;
    kind: string;
  }): SharedMemorySourceItemType => {
    const actor = input.actor.toLowerCase();
    const kind = input.kind.toLowerCase();
    if (SYSTEM_LABEL_PATTERN.test(actor) || SYSTEM_LABEL_PATTERN.test(kind)) {
      throw new SharedMemorySourceItemRejectedError("system_instruction");
    }
    if (RAW_REASONING_LABEL_PATTERN.test(kind)) {
      throw new SharedMemorySourceItemRejectedError("hidden_reasoning");
    }
    if (REASONING_LABEL_PATTERN.test(kind)) {
      return "thought";
    }
    if (
      kind === "tool_call" ||
      (actor === "tool" && !/result|output/.test(kind))
    ) {
      return "tool_call";
    }
    if (
      kind === "tool_result" ||
      (actor === "tool" && /result|output/.test(kind))
    ) {
      return "tool_result";
    }
    if (actor === "user" || kind === "user_message") {
      return "user_message";
    }
    if (
      actor === "assistant" ||
      actor === "agent" ||
      actor === "subagent" ||
      /agent_message|assistant_message|final_message|subagent_message/.test(
        kind
      )
    ) {
      return "assistant_message";
    }
    throw new SharedMemorySourceItemRejectedError("unknown_item_type");
  };

  const buildMemoryEventSourceItem = (input: {
    logicalMemoryId: string;
    sourceRevision: number;
    contributor: ReturnType<typeof buildCapturedSessionSyncContributor>;
  }): SharedMemoryCanonicalSourceItemDto => {
    if (
      classifyApprovalActivity({
        metadata: input.contributor.metadata,
        actor: input.contributor.actor,
        content: input.contributor.content
      })
    ) {
      throw new SharedMemorySourceItemRejectedError(
        "approval_activity_excluded"
      );
    }
    const itemType = classifyMemoryEventItemType({
      actor: input.contributor.actor,
      kind: input.contributor.kind
    });
    const textContent =
      input.contributor.content.trim().length > 0
        ? input.contributor.content
        : (input.contributor.rawText ?? "");
    if (itemType === "tool_call" || itemType === "tool_result") {
      if (!input.contributor.toolName) {
        throw new SharedMemorySourceItemRejectedError(
          "unsupported_protocol_item"
        );
      }
      return strictAuthoritativeSourceItem({
        representation: "memory_events",
        logicalMemoryId: input.logicalMemoryId,
        sourceRevision: input.sourceRevision,
        itemType,
        sourceId: input.contributor.originItemId,
        occurredAt: input.contributor.sourceEventTime,
        content: {
          toolName: input.contributor.toolName,
          toolCallId: input.contributor.toolCallId,
          payload: isPlainObject(input.contributor.rawJson)
            ? input.contributor.rawJson
            : { text: textContent }
        }
      });
    }
    return strictAuthoritativeSourceItem({
      representation: "memory_events",
      logicalMemoryId: input.logicalMemoryId,
      sourceRevision: input.sourceRevision,
      itemType,
      sourceId: input.contributor.originItemId,
      occurredAt: input.contributor.sourceEventTime,
      content: { text: textContent }
    });
  };

  const authoritativeSourceBinding = (input: {
    representation: SharedMemoryRepresentation;
    sourceRevision: number;
    ownerPolicy: SharedMemoryPolicyRecord;
    teamPolicy: SharedMemoryPolicyRecord;
    workspacePolicy: SharedMemoryPolicyRecord;
    fidelityPolicyRevision: number;
    contentPolicyVersion: number;
  }): SharedMemorySourceBindingDto => ({
    sourceRevision: input.sourceRevision,
    sourceHash: "",
    fidelityPolicyRevision: input.fidelityPolicyRevision,
    fidelityPolicyHash: fidelityPolicyHashForPreview({
      representation: input.representation,
      revision: input.fidelityPolicyRevision,
      owner: input.ownerPolicy,
      team: input.teamPolicy,
      workspace: input.workspacePolicy
    }),
    contentPolicyVersion: input.contentPolicyVersion,
    contentPolicyHash: contentPolicyHashForPreview({
      representation: input.representation,
      version: input.contentPolicyVersion
    }),
    classifierVersion: SHARED_MEMORY_CLASSIFIER_VERSION,
    classifierHash: classifierHashForPreview({
      representation: input.representation,
      version: SHARED_MEMORY_CLASSIFIER_VERSION
    })
  });

  const canonicalStructuredLcmSummary = (value: unknown) => {
    const current = structuredLcmSummarySchema.safeParse(value);
    if (current.success) {
      return current.data;
    }
    throw new SharedMemoryConflictError(
      "LCM summary must use the exact semantic summary schema"
    );
  };

  type ParsedSemanticItemManifestEntry = {
    sourceIds: string[];
    actor: string;
    kind: string;
    toolName: string | null;
    toolCallId: string | null;
    sourceSequence: number | null;
    sourceEventTime: string | null;
    offsetStart: number;
    offsetEnd: number;
  };

  const parseSemanticItemManifest = (
    value: unknown
  ): ParsedSemanticItemManifestEntry[] => {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > MAX_SOURCE_ITEMS
    ) {
      throw new SharedMemoryConflictError(
        "Memory Event semantic item manifest is missing or invalid"
      );
    }
    return value.map((entryValue) => {
      if (!isPlainObject(entryValue)) {
        throw new SharedMemoryConflictError(
          "Memory Event semantic item manifest entry is invalid"
        );
      }
      const entry = entryValue as Record<string, unknown>;
      const offsetStart = entry.offsetStart;
      const offsetEnd = entry.offsetEnd;
      const sourceSequence = entry.sourceSequence;
      const sourceEventTime = entry.sourceEventTime;
      if (
        !Array.isArray(entry.sourceIds) ||
        entry.sourceIds.length === 0 ||
        entry.sourceIds.some(
          (sourceId) =>
            !requiredString(sourceId) || !UUID_PATTERN.test(sourceId)
        ) ||
        !requiredString(entry.actor) ||
        !requiredString(entry.kind) ||
        !Number.isSafeInteger(offsetStart) ||
        !Number.isSafeInteger(offsetEnd) ||
        Number(offsetStart) < 0 ||
        Number(offsetEnd) <= Number(offsetStart) ||
        (entry.toolName !== undefined &&
          entry.toolName !== null &&
          !requiredString(entry.toolName)) ||
        (entry.toolCallId !== undefined &&
          entry.toolCallId !== null &&
          !requiredString(entry.toolCallId)) ||
        (sourceSequence !== undefined &&
          sourceSequence !== null &&
          (!Number.isSafeInteger(sourceSequence) ||
            Number(sourceSequence) < 0)) ||
        (sourceEventTime !== undefined &&
          sourceEventTime !== null &&
          (typeof sourceEventTime !== "string" ||
            Number.isNaN(Date.parse(sourceEventTime))))
      ) {
        throw new SharedMemoryConflictError(
          "Memory Event semantic item manifest entry is invalid"
        );
      }
      return {
        sourceIds: uniqueOrderedUuids(entry.sourceIds as string[]),
        actor: entry.actor,
        kind: entry.kind,
        toolName: nullableString(entry.toolName),
        toolCallId: nullableString(entry.toolCallId),
        sourceSequence: nullableNumber(sourceSequence),
        sourceEventTime: nullableString(sourceEventTime),
        offsetStart: Number(offsetStart),
        offsetEnd: Number(offsetEnd)
      };
    });
  };

  const sourceMaterialHashes = (input: {
    source: Extract<SharedMemorySourceRef, { kind: "captured_session" }>;
    representation: SharedMemoryRepresentation;
    logicalMemoryId: string;
    sourceCursor: number;
    manifest: SharedSourceArtifactV1["manifest"];
    items: SharedMemoryCanonicalSourceItemDto[];
  }): Pick<
    AuthoritativeSourceMaterial,
    "manifestHash" | "sourceContentHash" | "sourceHash"
  > => {
    const manifestHash = crossIdentitySyncDigest(input.manifest);
    const sourceContentHash = crossIdentitySyncDigest(input.items);
    const sourceHash = capturedSessionSourceFrontierHash({
      source: input.source,
      representation: input.representation,
      sourceCursor: input.sourceCursor,
      manifestHash,
      sourceContentHash
    });
    return {
      manifestHash,
      sourceContentHash,
      sourceHash
    };
  };

  const buildArtifactBody = (input: {
    context: AuthoritativeSyncContext;
    representation: SharedMemoryRepresentation;
    sourceHash: string;
    manifestHash: string;
    sourceContentHash: string;
    items: SharedMemoryCanonicalSourceItemDto[];
    manifest: SharedSourceArtifactV1["manifest"];
  }): SharedSourceArtifactV1 => {
    const artifactBase: Omit<SharedSourceArtifactV1, "artifactHash"> = {
      schemaVersion: SHARED_SOURCE_ARTIFACT_SCHEMA_VERSION,
      artifactId: "",
      source: {
        kind: "captured_session",
        sessionId: input.context.sourceSessionId,
        logicalMemoryId: input.context.logicalMemoryId
      },
      logicalMemoryId: input.context.logicalMemoryId,
      representation: input.representation,
      binding: {
        sourceRevision: input.context.sourceRevision,
        sourceHash: input.sourceHash,
        representationPolicyRevision: input.context.fidelityPolicyRevision,
        representationPolicyHash: input.context.fidelityPolicyHash,
        contentPolicyVersion: input.context.contentPolicyVersion,
        contentPolicyHash: input.context.contentPolicyHash,
        classifierVersion: input.context.classifierVersion,
        classifierHash: input.context.classifierHash
      },
      sync: {
        relationshipId: input.context.syncRelationshipId,
        localReplicaId: input.context.localReplicaId,
        remoteReplicaId: input.context.remoteSyncReplicaId,
        localSessionId: input.context.localSessionId,
        sourceCursor: input.context.sourceCursor,
        packageSequence: input.context.packageSequence,
        sourceDeploymentIdentityId: input.context.sourceDeploymentIdentityId,
        remoteUserIdentityId: input.context.remoteUserIdentityId,
        deviceCredentialId: input.context.deviceCredentialId,
        deviceProvenanceHash: input.context.deviceProvenanceHash
      },
      policies: {
        sourceOwnerPolicyId: input.context.sourceOwnerPolicyId,
        sourceOwnerPolicyVersion: input.context.sourceOwnerPolicyVersion,
        teamPolicyId: input.context.teamPolicyId,
        teamPolicyVersion: input.context.teamPolicyVersion,
        workspacePolicyId: input.context.workspacePolicyId,
        workspacePolicyVersion: input.context.workspacePolicyVersion
      },
      manifest: input.manifest,
      manifestHash: input.manifestHash,
      items: input.items,
      sourceContentHash: input.sourceContentHash
    };
    const artifactHash = sharedSourceArtifactHash(artifactBase);
    return {
      ...artifactBase,
      artifactId: sharedSourceArtifactId(artifactHash),
      artifactHash
    };
  };

  const buildPreviewBody = (input: {
    artifact: SharedSourceArtifactV1;
  }): SharedSourcePreviewV1 => {
    const previewBase: Omit<SharedSourcePreviewV1, "previewHash"> = {
      schemaVersion: SHARED_SOURCE_PREVIEW_SCHEMA_VERSION,
      previewId: "",
      source: input.artifact.source,
      artifactId: input.artifact.artifactId,
      logicalMemoryId: input.artifact.logicalMemoryId,
      representation: input.artifact.representation,
      binding: input.artifact.binding,
      items: input.artifact.items,
      sourceContentHash: input.artifact.sourceContentHash
    };
    const previewHash = sharedSourcePreviewHash(previewBase);
    return {
      ...previewBase,
      previewId: sharedSourcePreviewId(previewHash),
      previewHash
    };
  };

  const validateLoadedSourceItems = (
    representation: SharedMemoryRepresentation,
    logicalMemoryId: string,
    sourceRevision: number,
    items: unknown
  ): SharedMemoryCanonicalSourceItemDto[] => {
    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > MAX_SOURCE_ITEMS
    ) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source items are invalid"
      );
    }
    return items.map((item) =>
      validateSharedMemoryCanonicalSourceItem({
        representation,
        logicalMemoryId,
        sourceRevision,
        item: item as SharedMemorySourceItemInput
      })
    );
  };

  const loadAuthoritativeMappedEvents = async (
    client: pg.PoolClient,
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider,
    input: {
      logicalMemoryId: string;
      ownerUserId: string;
      ownerPrincipalId: string;
      localSessionId: string;
      syncRelationshipId: string;
      sourceRevision: number;
    }
  ): Promise<Map<string, LoadedMappedEvent>> => {
    const mappedResult = await client.query<Row>(
      `select sem.origin_event_id,sem.revision_hash as mapped_revision_hash,
              sem.source_cursor,me.*
         from sync_event_mappings sem
         join memory_events me
           on me.id=sem.local_memory_event_id
          and me.owner_user_id=$2
          and me.visibility='personal'
          and me.session_id=$3
          and me.invalidated_at is null
          and me.personal_deleted_at is null
        where sem.sync_relationship_id=$1
          and sem.active=true
          and sem.invalidated_at is null
          and sem.local_memory_event_id is not null
          and sem.source_cursor <= $4
        order by sem.source_cursor asc,me.captured_at asc,me.id asc`,
      [
        input.syncRelationshipId,
        input.ownerUserId,
        input.localSessionId,
        input.sourceRevision
      ]
    );
    if (mappedResult.rows.length === 0) {
      throw new SharedMemoryConflictError(
        "No authoritative synced Memory Events are available for this Shared Memory source"
      );
    }
    const eventIds = mappedResult.rows.map((row) => stringValue(row.id));
    const sourceResult = await client.query<Row>(
      `select mes.memory_event_id,mes.source_order,ci.*
         from memory_event_sources mes
         join conversation_items ci
           on ci.id=mes.conversation_item_id
        where mes.memory_event_id = any($1::uuid[])
        order by mes.memory_event_id asc,
                 mes.source_order asc,
                 ci.source_sequence asc nulls last,
                 ci.id asc`,
      [eventIds]
    );
    const sourcesByEventId = new Map<string, Row[]>();
    for (const row of sourceResult.rows) {
      const eventId = stringValue(row.memory_event_id);
      const group = sourcesByEventId.get(eventId);
      if (group) {
        group.push(row);
      } else {
        sourcesByEventId.set(eventId, [row]);
      }
    }

    const hydratedSourceCache = new Map<
      string,
      {
        contributor: ReturnType<typeof buildCapturedSessionSyncContributor>;
        rawJson: unknown;
        rawText: string | null;
        metadata: Record<string, unknown>;
        transportChunkText: string | null;
      }
    >();
    const sourceOriginId = (sourceRow: Row): string => {
      const originItemId = nullableString(sourceRow.external_item_id);
      if (!originItemId) {
        throw new SharedMemoryConflictError(
          "Synchronized Conversation Item origin identity is missing"
        );
      }
      return originItemId;
    };
    const hydrateCanonicalSource = async (sourceRow: Row) => {
      const localSourceId = stringValue(sourceRow.id);
      const originItemId = sourceOriginId(sourceRow);
      const cached = hydratedSourceCache.get(localSourceId);
      if (cached) return cached;
      const rawJson = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "conversation_items",
          sourceId: localSourceId,
          sourceColumn: "raw_json",
          fallback: sourceRow.raw_json,
          requiredMessage:
            "Conversation Item raw JSON decryption is required for Shared Memory"
        }
      );
      const metadataValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "conversation_items",
          sourceId: localSourceId,
          sourceColumn: "metadata",
          fallback: sourceRow.metadata,
          requiredMessage:
            "Conversation Item metadata decryption is required for Shared Memory"
        }
      );
      const metadata = canonicalSyncJsonObject(
        metadataValue ?? {},
        "conversation item metadata"
      );
      const encryptedConversationItemColumns =
        isPlainObject(sourceRow.metadata) &&
        sourceRow.metadata.encryptedConversationItemColumns;
      const rawTextWasEmptyBeforeEncryption =
        sourceRow.raw_text === ENCRYPTED_CONVERSATION_ITEM_TEXT &&
        Array.isArray(encryptedConversationItemColumns) &&
        !encryptedConversationItemColumns.includes("raw_text");
      const rawTextValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "conversation_items",
          sourceId: localSourceId,
          sourceColumn: "raw_text",
          fallback: rawTextWasEmptyBeforeEncryption ? "" : sourceRow.raw_text,
          requiredMessage:
            "Conversation Item raw text decryption is required for Shared Memory"
        }
      );
      const transportChunkValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "conversation_items",
          sourceId: localSourceId,
          sourceColumn: "transport_chunk_text",
          fallback: sourceRow.transport_chunk_text,
          requiredMessage:
            "Conversation Item transport chunk decryption is required for Shared Memory"
        }
      );
      const rawText = nullableString(rawTextValue);
      const transportChunkText = nullableString(transportChunkValue);
      const actorValue = metadata.actor ?? sourceRow.source_event_type;
      const kindValue =
        sourceRow.source_event_type ?? sourceRow.source_record_type;
      const contributor = buildCapturedSessionSyncContributor({
        originItemId,
        actor: typeof actorValue === "string" ? actorValue : "unknown",
        kind: typeof kindValue === "string" ? kindValue : "unknown",
        content:
          rawText && rawText.length > 0
            ? rawText
            : capturedSessionSyncContentFromUnknown(rawJson),
        toolName:
          typeof metadata.toolName === "string"
            ? String(metadata.toolName)
            : null,
        toolCallId:
          typeof metadata.toolCallId === "string"
            ? String(metadata.toolCallId)
            : null,
        sourceEventTime: nullableIso(sourceRow.event_time),
        sourceSequence: nullableNumber(sourceRow.source_sequence),
        sourceKind: stringValue(sourceRow.source_kind),
        sourceAdapterVersion: stringValue(sourceRow.source_adapter_version),
        sourceTransport: stringValue(sourceRow.source_transport),
        sourceRecordType: stringValue(sourceRow.source_record_type),
        sourceEventType: nullableString(sourceRow.source_event_type),
        rawJson,
        rawText,
        metadata,
        logicalSourceId: nullableString(sourceRow.logical_source_id),
        transportChunkIndex: numberValue(sourceRow.transport_chunk_index),
        transportChunkCount: numberValue(sourceRow.transport_chunk_count),
        transportChunkText,
        transportChunkEncoding: nullableString(
          sourceRow.transport_chunk_encoding
        ),
        projectionStatus: stringValue(sourceRow.projection_status) as
          | "pending"
          | "held"
          | "projected"
          | "error"
          | "raw_only",
        projectionVersion: nullableString(sourceRow.projection_version),
        projectionPolicyRevision: nullableNumber(
          sourceRow.projection_policy_revision
        ),
        memoryExcludedAt: nullableIso(sourceRow.memory_excluded_at),
        memoryExclusionReason: nullableString(sourceRow.memory_exclusion_reason)
      });
      const hydrated = {
        contributor,
        rawJson,
        rawText,
        metadata,
        transportChunkText
      };
      hydratedSourceCache.set(localSourceId, hydrated);
      return hydrated;
    };
    const loaded = new Map<string, LoadedMappedEvent>();
    for (const row of mappedResult.rows) {
      const eventId = stringValue(row.id);
      const sourceRows = sourcesByEventId.get(eventId) ?? [];
      if (sourceRows.length === 0) {
        throw new SharedMemoryConflictError(
          "Memory Event source contributors are incomplete"
        );
      }
      for (const sourceRow of sourceRows) {
        if (
          stringValue(sourceRow.owner_user_id) !== input.ownerUserId ||
          stringValue(sourceRow.visibility) !== "personal" ||
          stringValue(sourceRow.session_id) !== input.localSessionId ||
          sourceRow.personal_deleted_at !== null ||
          nullableString(sourceRow.projection_status) !== "projected"
        ) {
          throw new SharedMemoryConflictError(
            "Memory Event contributor provenance is invalid"
          );
        }
      }
      const payloadValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "memory_events",
          sourceId: eventId,
          sourceColumn: "payload",
          fallback: row.payload,
          requiredMessage:
            "Memory Event payload decryption is required for Shared Memory"
        }
      );
      if (!isPlainObject(payloadValue) || !requiredString(payloadValue.actor)) {
        throw new SharedMemoryConflictError(
          "Memory Event payload is not canonical Shared Memory source content"
        );
      }
      const eventContent =
        typeof payloadValue.content === "string" ? payloadValue.content : "";
      const payloadMetadata =
        payloadValue.metadata === undefined
          ? {}
          : canonicalSyncJsonObject(
              payloadValue.metadata,
              "memory event metadata"
            );
      const manifest = parseSemanticItemManifest(
        payloadMetadata.semanticItemManifest
      );
      const sourceRowsById = new Map<string, Row>();
      for (const sourceRow of sourceRows) {
        const originItemId = sourceOriginId(sourceRow);
        if (sourceRowsById.has(originItemId)) {
          throw new SharedMemoryConflictError(
            "Synchronized Conversation Item origin identity is duplicated"
          );
        }
        sourceRowsById.set(originItemId, sourceRow);
      }
      const manifestSourceIds = manifest.flatMap((entry) => entry.sourceIds);
      const uniqueManifestSourceIds = new Set(manifestSourceIds);
      if (
        uniqueManifestSourceIds.size !== manifestSourceIds.length ||
        uniqueManifestSourceIds.size !== sourceRowsById.size ||
        [...uniqueManifestSourceIds].some(
          (sourceId) => !sourceRowsById.has(sourceId)
        )
      ) {
        throw new SharedMemoryConflictError(
          "Memory Event semantic manifest does not exactly cover persisted source rows"
        );
      }
      const canonicalContributors = [];
      for (const sourceRow of sourceRows) {
        canonicalContributors.push(
          (await hydrateCanonicalSource(sourceRow)).contributor
        );
      }
      const canonicalEvent = buildCapturedSessionSyncEvent({
        originEventId: stringValue(row.origin_event_id),
        eventType: stringValue(row.event_type),
        actor: payloadValue.actor,
        content: eventContent,
        metadata: payloadMetadata,
        includeInEmbedding: Boolean(row.include_in_embedding),
        includeInLcm: Boolean(row.include_in_lcm),
        projectionPolicyKey: nullableString(row.projection_policy_key),
        projectionPolicyRevision: nullableNumber(
          row.projection_policy_revision
        ),
        tokenCount: nullableNumber(row.token_count),
        sealReason: nullableString(row.seal_reason),
        capturedAt: iso(row.captured_at),
        sourceEventTime: nullableIso(row.source_event_time),
        sourceSequence: nullableNumber(row.source_sequence),
        contributors: canonicalContributors
      });
      if (
        canonicalEvent.revisionHash !== stringValue(row.mapped_revision_hash)
      ) {
        throw new SharedMemoryConflictError(
          "Memory Event sync revision hash does not match active mapping"
        );
      }
      const contributorItems: SharedMemoryCanonicalSourceItemDto[] = [];
      const manifestEntries: SharedSourceArtifactV1["manifest"] = [];
      for (const entry of manifest) {
        const sourceRowsForEntry = entry.sourceIds.map((sourceId) => {
          const sourceRow = sourceRowsById.get(sourceId);
          if (!sourceRow) {
            throw new SharedMemoryConflictError(
              "Memory Event semantic manifest does not match persisted source rows"
            );
          }
          return sourceRow;
        });
        if (
          sourceRowsForEntry.some(
            (sourceRow) => sourceRow.memory_excluded_at !== null
          )
        ) {
          continue;
        }
        const primary = sourceRowsForEntry[0]!;
        const primaryId = sourceOriginId(primary);
        const hydrated = await hydrateCanonicalSource(primary);
        const slicedContent =
          entry.offsetEnd <= eventContent.length
            ? eventContent.slice(entry.offsetStart, entry.offsetEnd)
            : "";
        const contributor = buildCapturedSessionSyncContributor({
          originItemId: primaryId,
          actor: entry.actor,
          kind: entry.kind,
          content:
            slicedContent.trim().length > 0
              ? slicedContent
              : (hydrated.rawText ?? ""),
          toolName: entry.toolName,
          toolCallId: entry.toolCallId,
          sourceEventTime:
            entry.sourceEventTime ?? nullableIso(primary.event_time),
          sourceSequence:
            entry.sourceSequence ?? nullableNumber(primary.source_sequence),
          sourceKind: stringValue(primary.source_kind),
          sourceAdapterVersion: stringValue(primary.source_adapter_version),
          sourceTransport: stringValue(primary.source_transport),
          sourceRecordType: stringValue(primary.source_record_type),
          sourceEventType: nullableString(primary.source_event_type),
          rawJson: hydrated.rawJson,
          rawText: hydrated.rawText,
          metadata: hydrated.metadata,
          logicalSourceId: nullableString(primary.logical_source_id),
          transportChunkIndex: numberValue(primary.transport_chunk_index),
          transportChunkCount: numberValue(primary.transport_chunk_count),
          transportChunkText: hydrated.transportChunkText,
          transportChunkEncoding: nullableString(
            primary.transport_chunk_encoding
          ),
          projectionStatus: stringValue(primary.projection_status) as
            | "pending"
            | "held"
            | "projected"
            | "error"
            | "raw_only",
          projectionVersion: nullableString(primary.projection_version),
          projectionPolicyRevision: nullableNumber(
            primary.projection_policy_revision
          ),
          memoryExcludedAt: nullableIso(primary.memory_excluded_at),
          memoryExclusionReason: nullableString(primary.memory_exclusion_reason)
        });
        let item: SharedMemoryCanonicalSourceItemDto;
        try {
          item = buildMemoryEventSourceItem({
            logicalMemoryId: input.logicalMemoryId,
            sourceRevision: input.sourceRevision,
            contributor
          });
        } catch (error) {
          if (
            error instanceof SharedMemorySourceItemRejectedError &&
            [
              "hidden_reasoning",
              "system_instruction",
              "credential_item",
              "unsupported_protocol_item",
              "approval_activity_excluded"
            ].includes(error.reasonCode)
          ) {
            continue;
          }
          throw error;
        }
        contributorItems.push(item);
        manifestEntries.push({
          sourceId: primaryId,
          sourceTable: "conversation_items",
          itemType: item.itemType,
          sourceCursor: numberValue(row.source_cursor),
          revisionHash: contributor.revisionHash,
          occurredAt: contributor.sourceEventTime,
          sourceEventId: eventId,
          sourceNodeId: null
        });
      }
      loaded.set(eventId, {
        eventId,
        sourceCursor: numberValue(row.source_cursor),
        mappedRevisionHash: stringValue(row.mapped_revision_hash),
        occurredAt:
          canonicalEvent.sourceEventTime ??
          nullableIso(row.source_event_time) ??
          iso(row.captured_at),
        contributorItems,
        manifestEntries
      });
    }
    return loaded;
  };

  const loadAuthoritativeLeafNodes = async (
    client: pg.PoolClient,
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider,
    input: {
      logicalMemoryId: string;
      ownerUserId: string;
      ownerPrincipalId: string;
      localSessionId: string;
      sourceRevision: number;
      mappedEvents: Map<string, LoadedMappedEvent>;
    }
  ): Promise<Map<string, LoadedNodeItem>> => {
    const result = await client.query<Row>(
      `select mn.*,mns.memory_event_id,mns.source_order
         from memory_nodes mn
         join memory_node_sources mns on mns.memory_node_id=mn.id
        where mn.owner_user_id=$1
          and mn.session_id=$2
          and mn.visibility='personal'
          and mn.kind='leaf'
          and mn.invalidated_at is null
          and mn.personal_deleted_at is null
        order by mn.created_at asc,mn.id asc,mns.source_order asc`,
      [input.ownerUserId, input.localSessionId]
    );
    const rowsByNodeId = new Map<string, Row[]>();
    for (const row of result.rows) {
      const nodeId = stringValue(row.id);
      const group = rowsByNodeId.get(nodeId);
      if (group) {
        group.push(row);
      } else {
        rowsByNodeId.set(nodeId, [row]);
      }
    }
    const loaded = new Map<string, LoadedNodeItem>();
    for (const [nodeId, rows] of rowsByNodeId) {
      const sourceEventIds = uniqueOrderedUuids(
        rows.map((row) => stringValue(row.memory_event_id))
      );
      const matchingCount = sourceEventIds.filter((eventId) =>
        input.mappedEvents.has(eventId)
      ).length;
      if (matchingCount === 0) {
        continue;
      }
      if (matchingCount !== sourceEventIds.length) {
        throw new SharedMemoryConflictError(
          "LCM leaf mixes shared and unshared source provenance"
        );
      }
      const row = rows[0]!;
      if (!requiredString(row.summary_model)) {
        throw new SharedMemoryConflictError(
          "LCM placeholder leaves cannot be shared authoritatively"
        );
      }
      if (
        !requiredString(row.summary_prompt_version) ||
        !requiredString(row.lcm_algorithm_version)
      ) {
        throw new SharedMemoryConflictError(
          "LCM leaf summary provenance is incomplete"
        );
      }
      if (
        nullableString(row.summary_structured_schema_version) !==
        LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
      ) {
        throw new SharedMemoryConflictError(
          "Legacy or incomplete LCM leaves cannot be shared authoritatively"
        );
      }
      const summaryTextValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "memory_nodes",
          sourceId: nodeId,
          sourceColumn: "summary_text",
          fallback: row.summary_text,
          requiredMessage:
            "LCM leaf summary decryption is required for Shared Memory"
        }
      );
      const structuredValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "memory_nodes",
          sourceId: nodeId,
          sourceColumn: "summary_structured_json",
          fallback: row.summary_structured_json,
          requiredMessage:
            "LCM structured summary decryption is required for Shared Memory"
        }
      );
      const structured = canonicalStructuredLcmSummary(structuredValue);
      const summaryText = requireHydratedValue(
        nullableString(summaryTextValue),
        "LCM leaf summary text is required"
      );
      if (summaryText !== structured.summary_text) {
        throw new SharedMemoryConflictError(
          "LCM leaf summary text drift prevents authoritative sharing"
        );
      }
      const eventRevisionHashes = sourceEventIds.map(
        (eventId) => input.mappedEvents.get(eventId)!.mappedRevisionHash
      );
      const item = strictAuthoritativeSourceItem({
        representation: "lcm_leaves",
        logicalMemoryId: input.logicalMemoryId,
        sourceRevision: input.sourceRevision,
        itemType: "lcm_leaf",
        sourceId: nodeId,
        occurredAt: nullableIso(row.updated_at) ?? iso(row.created_at),
        content: {
          title: structured.title,
          summaryText: structured.summary_text,
          lexicalAnchors: structured.lexical_anchors,
          sourceIds: sourceEventIds,
          expansionItems: sourceEventIds.flatMap(
            (eventId) => input.mappedEvents.get(eventId)!.contributorItems
          )
        }
      });
      const sourceCursor = Math.max(
        ...sourceEventIds.map(
          (eventId) => input.mappedEvents.get(eventId)!.sourceCursor
        )
      );
      const nodeRevisionHash = crossIdentitySyncDigest({
        kind: "shared_memory_lcm_leaf",
        nodeId,
        summaryModel: stringValue(row.summary_model),
        summaryPromptVersion: stringValue(row.summary_prompt_version),
        summaryStructuredSchemaVersion: nullableString(
          row.summary_structured_schema_version
        ),
        lcmAlgorithmVersion: stringValue(row.lcm_algorithm_version),
        structured,
        sourceEventIds,
        eventRevisionHashes
      });
      loaded.set(nodeId, {
        item,
        manifestEntry: {
          sourceId: nodeId,
          sourceTable: "memory_nodes",
          itemType: "lcm_leaf",
          sourceCursor,
          revisionHash: nodeRevisionHash,
          occurredAt: item.occurredAt,
          sourceEventId: null,
          sourceNodeId: nodeId
        },
        sourceEventIds,
        nodeRevisionHash
      });
    }
    return loaded;
  };

  const loadAuthoritativeRollupNodes = async (
    client: pg.PoolClient,
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider,
    input: {
      logicalMemoryId: string;
      ownerUserId: string;
      ownerPrincipalId: string;
      localSessionId: string;
      sourceRevision: number;
      mappedEvents: Map<string, LoadedMappedEvent>;
      leaves: Map<string, LoadedNodeItem>;
    }
  ): Promise<LoadedNodeItem[]> => {
    const rowResult = await client.query<Row>(
      `select *
         from memory_nodes
        where owner_user_id=$1
          and session_id=$2
          and visibility='personal'
          and kind='rollup'
          and invalidated_at is null
          and personal_deleted_at is null
        order by depth asc,created_at asc,id asc`,
      [input.ownerUserId, input.localSessionId]
    );
    const childResult = await client.query<Row>(
      `select child.parent_memory_node_id,child.child_memory_node_id,child.child_order
         from memory_node_children child
         join memory_nodes parent on parent.id=child.parent_memory_node_id
         join memory_nodes descendant on descendant.id=child.child_memory_node_id
        where parent.owner_user_id=$1
          and parent.session_id=$2
          and descendant.owner_user_id=$1
          and descendant.session_id=$2
        order by parent_memory_node_id asc,child_order asc`,
      [input.ownerUserId, input.localSessionId]
    );
    const sourceResult = await client.query<Row>(
      `select source.memory_node_id,source.memory_event_id,source.source_order
         from memory_node_sources source
         join memory_nodes node on node.id=source.memory_node_id
        where node.owner_user_id=$1
          and node.session_id=$2
        order by memory_node_id asc,source_order asc`,
      [input.ownerUserId, input.localSessionId]
    );
    const rowsById = new Map(
      rowResult.rows.map((row) => [stringValue(row.id), row])
    );
    const childIdsByParent = new Map<string, string[]>();
    for (const row of childResult.rows) {
      const parentId = stringValue(row.parent_memory_node_id);
      const group = childIdsByParent.get(parentId);
      if (group) {
        group.push(stringValue(row.child_memory_node_id));
      } else {
        childIdsByParent.set(parentId, [stringValue(row.child_memory_node_id)]);
      }
    }
    const sourceIdsByNode = new Map<string, string[]>();
    for (const row of sourceResult.rows) {
      const nodeId = stringValue(row.memory_node_id);
      const group = sourceIdsByNode.get(nodeId);
      if (group) {
        group.push(stringValue(row.memory_event_id));
      } else {
        sourceIdsByNode.set(nodeId, [stringValue(row.memory_event_id)]);
      }
    }
    const cache = new Map<string, LoadedNodeItem | null>();
    const visiting = new Set<string>();
    const loadNode = async (nodeId: string): Promise<LoadedNodeItem | null> => {
      if (cache.has(nodeId)) {
        return cache.get(nodeId)!;
      }
      if (visiting.has(nodeId)) {
        throw new SharedMemoryConflictError(
          "LCM rollup provenance contains a cycle"
        );
      }
      const row = rowsById.get(nodeId);
      if (!row) {
        cache.set(nodeId, null);
        return null;
      }
      const directSourceEventIds = uniqueOrderedUuids(
        sourceIdsByNode.get(nodeId) ?? []
      );
      const relevantDirectSourceIds = directSourceEventIds.filter((eventId) =>
        input.mappedEvents.has(eventId)
      );
      if (
        relevantDirectSourceIds.length > 0 &&
        relevantDirectSourceIds.length !== directSourceEventIds.length
      ) {
        throw new SharedMemoryConflictError(
          "LCM rollup mixes shared and unshared source provenance"
        );
      }
      const childIds = childIdsByParent.get(nodeId) ?? [];
      visiting.add(nodeId);
      const childNodes: LoadedNodeItem[] = [];
      for (const childId of childIds) {
        const leaf = input.leaves.get(childId);
        if (leaf) {
          childNodes.push(leaf);
          continue;
        }
        const rollupChild = await loadNode(childId);
        if (rollupChild) {
          childNodes.push(rollupChild);
          continue;
        }
        if (relevantDirectSourceIds.length > 0 || childNodes.length > 0) {
          visiting.delete(nodeId);
          throw new SharedMemoryConflictError(
            "LCM rollup mixes cross-session or incomplete child provenance"
          );
        }
      }
      visiting.delete(nodeId);
      if (relevantDirectSourceIds.length === 0 && childNodes.length === 0) {
        cache.set(nodeId, null);
        return null;
      }
      if (!requiredString(row.summary_model)) {
        throw new SharedMemoryConflictError(
          "LCM placeholder rollups cannot be shared authoritatively"
        );
      }
      if (
        !requiredString(row.summary_prompt_version) ||
        !requiredString(row.lcm_algorithm_version)
      ) {
        throw new SharedMemoryConflictError(
          "LCM rollup summary provenance is incomplete"
        );
      }
      if (
        nullableString(row.summary_structured_schema_version) !==
        LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
      ) {
        throw new SharedMemoryConflictError(
          "Legacy or incomplete LCM rollups cannot be shared authoritatively"
        );
      }
      if (childNodes.length === 0) {
        throw new SharedMemoryConflictError(
          "LCM rollups must have complete summarized children"
        );
      }
      const descendantSourceEventIds = uniqueOrderedUuids(
        childNodes.flatMap((child) => child.sourceEventIds)
      );
      if (
        crossIdentitySyncDigest(directSourceEventIds) !==
        crossIdentitySyncDigest(descendantSourceEventIds)
      ) {
        throw new SharedMemoryConflictError(
          "LCM rollup direct source provenance does not match its child tree"
        );
      }
      const summaryTextValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "memory_nodes",
          sourceId: nodeId,
          sourceColumn: "summary_text",
          fallback: row.summary_text,
          requiredMessage:
            "LCM rollup summary decryption is required for Shared Memory"
        }
      );
      const structuredValue = await hydrateOwnerPrivateEncryptedField(
        client,
        actor,
        provider,
        {
          ownerPrincipalId: input.ownerPrincipalId,
          sourceTable: "memory_nodes",
          sourceId: nodeId,
          sourceColumn: "summary_structured_json",
          fallback: row.summary_structured_json,
          requiredMessage:
            "LCM structured rollup decryption is required for Shared Memory"
        }
      );
      const structured = canonicalStructuredLcmSummary(structuredValue);
      const summaryText = requireHydratedValue(
        nullableString(summaryTextValue),
        "LCM rollup summary text is required"
      );
      if (summaryText !== structured.summary_text) {
        throw new SharedMemoryConflictError(
          "LCM rollup summary text drift prevents authoritative sharing"
        );
      }
      const item = strictAuthoritativeSourceItem({
        representation: "lcm_rollups",
        logicalMemoryId: input.logicalMemoryId,
        sourceRevision: input.sourceRevision,
        itemType: "lcm_rollup",
        sourceId: nodeId,
        occurredAt: nullableIso(row.updated_at) ?? iso(row.created_at),
        content: {
          title: structured.title,
          summaryText: structured.summary_text,
          lexicalAnchors: structured.lexical_anchors,
          sourceIds: descendantSourceEventIds,
          expansionItems: childNodes.map((child) => child.item)
        }
      });
      const sourceCursor = Math.max(
        ...descendantSourceEventIds.map(
          (eventId) => input.mappedEvents.get(eventId)!.sourceCursor
        )
      );
      const nodeRevisionHash = crossIdentitySyncDigest({
        kind: "shared_memory_lcm_rollup",
        nodeId,
        summaryModel: stringValue(row.summary_model),
        summaryPromptVersion: stringValue(row.summary_prompt_version),
        summaryStructuredSchemaVersion: nullableString(
          row.summary_structured_schema_version
        ),
        lcmAlgorithmVersion: stringValue(row.lcm_algorithm_version),
        structured,
        childNodeIds: childIds,
        childRevisionHashes: childNodes.map((child) => child.nodeRevisionHash),
        sourceEventIds: descendantSourceEventIds
      });
      const loadedNode = {
        item,
        manifestEntry: {
          sourceId: nodeId,
          sourceTable: "memory_nodes",
          itemType: "lcm_rollup",
          sourceCursor,
          revisionHash: nodeRevisionHash,
          occurredAt: item.occurredAt,
          sourceEventId: null,
          sourceNodeId: nodeId
        },
        sourceEventIds: descendantSourceEventIds,
        nodeRevisionHash
      } satisfies LoadedNodeItem;
      cache.set(nodeId, loadedNode);
      return loadedNode;
    };
    const loaded: LoadedNodeItem[] = [];
    for (const row of rowResult.rows) {
      const node = await loadNode(stringValue(row.id));
      if (node) {
        loaded.push(node);
      }
    }
    return loaded;
  };

  const loadEligibleCuratedAssertionMaterial = async (
    client: pg.PoolClient,
    actor: ActorContext,
    personalProvider: EnvelopeEncryptionProvider,
    input: {
      logicalMemoryId: string;
      ownerUserId: string;
      localSessionId: string;
      sourceRevision: number;
    }
  ): Promise<Pick<AuthoritativeSourceMaterial, "items" | "manifest">> => {
    const result = await client.query<AssertionRow>(
      `select ${assertionSelect}
         from curated_memory_assertions cma
         left join curated_memory_topics cmt on cmt.id=cma.topic_id
        where cma.owner_user_id=$1
          and cma.visibility='personal'
          and cma.status='current'
          and cma.suppressed_at is null
          and (cma.expires_at is null or cma.expires_at>now())
          and ${sessionExactCuratedAssertionSql("$1", "$2")}
        order by cma.observed_at asc,cma.id asc
        limit $3`,
      [input.ownerUserId, input.localSessionId, MAX_SOURCE_ITEMS + 1]
    );
    const items: SharedMemoryCanonicalSourceItemDto[] = [];
    const manifest: SharedSourceArtifactV1["manifest"] = [];
    if (result.rows.length > MAX_SOURCE_ITEMS) {
      throw new SharedMemoryConflictError(
        "Curated Shared Memory candidate exceeds the item consent boundary"
      );
    }
    const sourceRows = await client.query<{
      assertion_id: string;
      source_role: string;
      conversation_item_id: string | null;
      memory_event_id: string | null;
      lcm_node_id: string | null;
    }>(
      `select assertion_id,source_role,conversation_item_id,memory_event_id,lcm_node_id
         from curated_memory_sources
        where assertion_id=any($1::uuid[])
        order by created_at asc,id asc`,
      [result.rows.map((row) => row.id)]
    );
    const sourceMap = new Map<
      string,
      Array<{
        sourceRole: string;
        conversationItemId: string | null;
        memoryEventId: string | null;
        lcmNodeId: string | null;
      }>
    >();
    for (const row of sourceRows.rows) {
      sourceMap.set(row.assertion_id, [
        ...(sourceMap.get(row.assertion_id) ?? []),
        {
          sourceRole: row.source_role,
          conversationItemId: row.conversation_item_id,
          memoryEventId: row.memory_event_id,
          lcmNodeId: row.lcm_node_id
        }
      ]);
    }
    const directSources = [...sourceMap.values()]
      .flat()
      .filter((source) =>
        [
          "primary_evidence",
          "supporting_evidence",
          "superseding_evidence",
          "conflicting_evidence"
        ].includes(source.sourceRole)
      );
    const conversationItemIds = directSources
      .map((source) => source.conversationItemId)
      .filter((id): id is string => id !== null);
    const memoryEventIds = directSources
      .map((source) => source.memoryEventId)
      .filter((id): id is string => id !== null);
    const lcmNodeIds = directSources
      .map((source) => source.lcmNodeId)
      .filter((id): id is string => id !== null);
    const [conversationRows, eventRows, nodeRows] = await Promise.all([
      client.query<{ id: string }>(
        `select id from conversation_items
          where id=any($1::uuid[]) and owner_user_id=$2
            and visibility='personal' and session_id=$3
            and personal_deleted_at is null and memory_excluded_at is null`,
        [conversationItemIds, input.ownerUserId, input.localSessionId]
      ),
      client.query<{ id: string }>(
        `select id from memory_events
          where id=any($1::uuid[]) and owner_user_id=$2
            and visibility='personal' and session_id=$3
            and invalidated_at is null and personal_deleted_at is null`,
        [memoryEventIds, input.ownerUserId, input.localSessionId]
      ),
      client.query<{
        root_id: string;
        expected_count: number;
        active_count: string;
        exact_count: string;
        invalid_node_count: string;
        root_kind: "leaf" | "rollup";
        source_ids: string[];
      }>(
        `with recursive descendants(root_id,id) as (
           select id,id from memory_nodes where id=any($1::uuid[])
           union
           select parent.root_id,child.child_memory_node_id
             from memory_node_children child
             join descendants parent on parent.id=child.parent_memory_node_id
         ), underlying as (
           select distinct d.root_id,mns.memory_event_id
             from descendants d
             join memory_node_sources mns on mns.memory_node_id=d.id
         )
         select root.id as root_id,root.source_event_count as expected_count,
                root.kind as root_kind,
                array_agg(distinct me.id) filter (where me.id is not null) as source_ids,
                count(distinct me.id)::text as active_count,
                count(distinct me.id) filter (where me.session_id=$3)::text as exact_count,
                count(distinct d.id) filter (where node.id is null)::text as invalid_node_count
           from memory_nodes root
           join descendants d on d.root_id=root.id
           left join memory_nodes node on node.id=d.id
            and node.owner_user_id=$2 and node.visibility='personal'
            and node.invalidated_at is null and node.personal_deleted_at is null
            and node.session_id=$3
           left join underlying u on u.root_id=root.id
           left join memory_events me on me.id=u.memory_event_id
            and me.owner_user_id=$2 and me.visibility='personal'
            and me.invalidated_at is null and me.personal_deleted_at is null
          where root.id=any($1::uuid[]) and root.owner_user_id=$2
          group by root.id,root.source_event_count,root.kind`,
        [lcmNodeIds, input.ownerUserId, input.localSessionId]
      )
    ]);
    const conversationIds = new Set(conversationRows.rows.map((row) => row.id));
    const eventIds = new Set(eventRows.rows.map((row) => row.id));
    const nodesById = new Map(nodeRows.rows.map((row) => [row.root_id, row]));
    const encryptedPayloads =
      await decryptAuthorizedEncryptedFieldPayloadsWithClient(
        client,
        actor,
        personalProvider,
        [
          ...conversationItemIds.map((sourceId) => ({
            sourceTable: "conversation_items" as const,
            sourceId,
            sourceColumn: "raw_text"
          })),
          ...memoryEventIds.map((sourceId) => ({
            sourceTable: "memory_events" as const,
            sourceId,
            sourceColumn: "payload"
          })),
          ...lcmNodeIds.map((sourceId) => ({
            sourceTable: "memory_nodes" as const,
            sourceId,
            sourceColumn: "summary_text"
          })),
          ...result.rows.map((row) => ({
            sourceTable: "curated_memory_assertions" as const,
            sourceId: row.id,
            sourceColumn: "payload"
          })),
          ...result.rows
            .map((row) => row.topic_id)
            .filter((sourceId): sourceId is string => sourceId !== null)
            .map((sourceId) => ({
              sourceTable: "curated_memory_topics" as const,
              sourceId,
              sourceColumn: "payload"
            }))
        ]
      );
    const decryptedValue = (
      sourceTable:
        | "conversation_items"
        | "memory_events"
        | "memory_nodes"
        | "curated_memory_assertions"
        | "curated_memory_topics",
      sourceId: string,
      sourceColumn: string
    ): unknown =>
      encryptedPayloads.get(
        encryptedFieldReferenceKey({ sourceTable, sourceId, sourceColumn })
      )?.plaintext;
    for (const assertionRow of result.rows) {
      const sources = sourceMap.get(assertionRow.id) ?? [];
      const direct = sources.filter((source) =>
        [
          "primary_evidence",
          "supporting_evidence",
          "superseding_evidence",
          "conflicting_evidence"
        ].includes(source.sourceRole)
      );
      let eligible = direct.length > 0;
      const sourceIds: string[] = [];
      const expansionItems: SharedMemoryCanonicalSourceItemDto[] = [];
      for (const source of direct) {
        const identifiers = [
          source.conversationItemId,
          source.memoryEventId,
          source.lcmNodeId
        ].filter((id): id is string => id !== null);
        if (identifiers.length !== 1) {
          eligible = false;
          break;
        }
        const sourceId = identifiers[0]!;
        sourceIds.push(sourceId);
        if (source.conversationItemId) {
          const plaintext = decryptedValue(
            "conversation_items",
            sourceId,
            "raw_text"
          );
          eligible = conversationIds.has(sourceId) && plaintext !== undefined;
          if (eligible) {
            const text =
              typeof plaintext === "string"
                ? plaintext
                : JSON.stringify(plaintext);
            expansionItems.push(
              strictAuthoritativeSourceItem({
                representation: "memory_events",
                logicalMemoryId: input.logicalMemoryId,
                sourceRevision: input.sourceRevision,
                itemType: "user_message",
                sourceId,
                occurredAt: null,
                content: { text }
              })
            );
          }
        } else if (source.memoryEventId) {
          const plaintext = decryptedValue(
            "memory_events",
            sourceId,
            "payload"
          );
          eligible = eventIds.has(sourceId) && plaintext !== undefined;
          if (eligible) {
            const payload = isPlainObject(plaintext) ? plaintext : {};
            expansionItems.push(
              strictAuthoritativeSourceItem({
                representation: "memory_events",
                logicalMemoryId: input.logicalMemoryId,
                sourceRevision: input.sourceRevision,
                itemType:
                  payload.actor === "assistant"
                    ? "assistant_message"
                    : "user_message",
                sourceId,
                occurredAt: null,
                content: {
                  text:
                    typeof payload.content === "string"
                      ? payload.content
                      : JSON.stringify(plaintext)
                }
              })
            );
          }
        } else {
          const row = nodesById.get(sourceId);
          eligible = Boolean(
            row &&
            Number(row.active_count) > 0 &&
            Number(row.active_count) === Number(row.exact_count) &&
            Number(row.active_count) === Number(row.expected_count) &&
            Number(row.invalid_node_count) === 0
          );
          if (eligible) {
            const plaintext = decryptedValue(
              "memory_nodes",
              sourceId,
              "summary_text"
            );
            eligible = plaintext !== undefined;
            if (eligible && row) {
              expansionItems.push(
                strictAuthoritativeSourceItem({
                  representation:
                    row.root_kind === "rollup" ? "lcm_rollups" : "lcm_leaves",
                  logicalMemoryId: input.logicalMemoryId,
                  sourceRevision: input.sourceRevision,
                  itemType:
                    row.root_kind === "rollup" ? "lcm_rollup" : "lcm_leaf",
                  sourceId,
                  occurredAt: null,
                  content: {
                    summaryText:
                      typeof plaintext === "string"
                        ? plaintext
                        : JSON.stringify(plaintext),
                    lexicalAnchors: [],
                    sourceIds: row.source_ids
                  }
                })
              );
            }
          }
        }
        if (!eligible) break;
      }
      if (!eligible) continue;
      const protectedValue = decryptedValue(
        "curated_memory_assertions",
        assertionRow.id,
        "payload"
      );
      const protectedRecord = isPlainObject(protectedValue)
        ? protectedValue
        : null;
      const topicValue = assertionRow.topic_id
        ? decryptedValue(
            "curated_memory_topics",
            assertionRow.topic_id,
            "payload"
          )
        : null;
      const topicRecord = isPlainObject(topicValue) ? topicValue : null;
      const assertionText = protectedRecord
        ? requireHydratedValue(
            nullableString(protectedRecord.assertionText),
            "Curated assertion text decryption is required for Shared Memory"
          )
        : assertionRow.assertion_text;
      const topicTitle = protectedRecord
        ? (nullableString(protectedRecord.topicTitle) ??
          nullableString(topicRecord?.title) ??
          assertionRow.topic_title)
        : (nullableString(topicRecord?.title) ?? assertionRow.topic_title);
      const tags = protectedRecord
        ? Array.isArray(protectedRecord.tags)
          ? protectedRecord.tags.filter(
              (tag): tag is string => typeof tag === "string"
            )
          : []
        : assertionRow.tags;
      const item = strictAuthoritativeSourceItem({
        representation: "curated_assertions",
        logicalMemoryId: input.logicalMemoryId,
        sourceRevision: input.sourceRevision,
        itemType: "curated_assertion",
        sourceId: assertionRow.id,
        occurredAt: iso(assertionRow.observed_at),
        content: {
          assertionText,
          topicTitle,
          tags,
          sourceCount: direct.length,
          ...(expansionItems.length > 0 ? { expansionItems } : {})
        }
      });
      items.push(item);
      manifest.push({
        sourceId: assertionRow.id,
        sourceTable: "curated_memory_assertions",
        itemType: "curated_assertion",
        sourceCursor: input.sourceRevision,
        revisionHash: crossIdentitySyncDigest({
          assertionText,
          topicTitle,
          tags,
          sourceIds
        }),
        occurredAt: item.occurredAt,
        sourceEventId: null,
        sourceNodeId: null
      });
    }
    return { items, manifest };
  };

  const loadAuthoritativeSourceMaterial = async (
    client: pg.PoolClient,
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider,
    input: {
      representation: SharedMemoryRepresentation;
      logicalMemoryId: string;
      ownerUserId: string;
      ownerPrincipalId: string;
      localSessionId: string;
      sourceSessionId: string;
      syncRelationshipId: string;
      sourceRevision: number;
    }
  ): Promise<AuthoritativeSourceMaterial> => {
    const mappedEvents =
      input.representation === "curated_assertions"
        ? new Map<string, LoadedMappedEvent>()
        : await loadAuthoritativeMappedEvents(client, actor, provider, {
            logicalMemoryId: input.logicalMemoryId,
            ownerUserId: input.ownerUserId,
            ownerPrincipalId: input.ownerPrincipalId,
            localSessionId: input.localSessionId,
            syncRelationshipId: input.syncRelationshipId,
            sourceRevision: input.sourceRevision
          });
    const orderedMappedEvents = [...mappedEvents.values()].sort(
      compareSharedMemoryEventOrder
    );
    let items: SharedMemoryCanonicalSourceItemDto[];
    let manifest: SharedSourceArtifactV1["manifest"];
    if (input.representation === "curated_assertions") {
      const personalProvider = await options.resolvePersonalEncryptionProvider({
        ownerUserId: input.ownerUserId,
        purpose: "decrypt"
      });
      if (personalProvider.keyId === provider.keyId) {
        throw new SharedMemoryConflictError(
          "Personal and owner-private Curated Memory boundaries require distinct encryption keys"
        );
      }
      ({ items, manifest } = await loadEligibleCuratedAssertionMaterial(
        client,
        actor,
        personalProvider,
        input
      ));
    } else if (input.representation === "memory_events") {
      items = orderedMappedEvents.flatMap((event) => event.contributorItems);
      manifest = orderedMappedEvents.flatMap((event) => event.manifestEntries);
    } else {
      const leaves = await loadAuthoritativeLeafNodes(client, actor, provider, {
        logicalMemoryId: input.logicalMemoryId,
        ownerUserId: input.ownerUserId,
        ownerPrincipalId: input.ownerPrincipalId,
        localSessionId: input.localSessionId,
        sourceRevision: input.sourceRevision,
        mappedEvents
      });
      if (input.representation === "lcm_leaves") {
        const orderedLeaves = [...leaves.values()].sort(
          (left, right) =>
            left.manifestEntry.sourceCursor -
              right.manifestEntry.sourceCursor ||
            left.item.sourceId.localeCompare(right.item.sourceId)
        );
        items = orderedLeaves.map((leaf) => leaf.item);
        manifest = orderedLeaves.map((leaf) => leaf.manifestEntry);
        const coveredEventIds = new Set(
          orderedLeaves.flatMap((leaf) => leaf.sourceEventIds)
        );
        if (
          orderedLeaves.length > 0 &&
          (coveredEventIds.size !== orderedMappedEvents.length ||
            orderedMappedEvents.some(
              (event) => !coveredEventIds.has(event.eventId)
            ))
        ) {
          throw new SharedMemoryConflictError(
            "LCM leaves do not cover the authoritative source revision"
          );
        }
      } else {
        const rollups = await loadAuthoritativeRollupNodes(
          client,
          actor,
          provider,
          {
            logicalMemoryId: input.logicalMemoryId,
            ownerUserId: input.ownerUserId,
            ownerPrincipalId: input.ownerPrincipalId,
            localSessionId: input.localSessionId,
            sourceRevision: input.sourceRevision,
            mappedEvents,
            leaves
          }
        );
        const orderedRollups = [...rollups].sort(
          (left, right) =>
            left.manifestEntry.sourceCursor -
              right.manifestEntry.sourceCursor ||
            left.item.sourceId.localeCompare(right.item.sourceId)
        );
        items = orderedRollups.map((rollup) => rollup.item);
        manifest = orderedRollups.map((rollup) => rollup.manifestEntry);
        const coveredEventIds = new Set(
          orderedRollups.flatMap((rollup) => rollup.sourceEventIds)
        );
        if (
          orderedRollups.length > 0 &&
          (coveredEventIds.size !== orderedMappedEvents.length ||
            orderedMappedEvents.some(
              (event) => !coveredEventIds.has(event.eventId)
            ))
        ) {
          throw new SharedMemoryConflictError(
            "LCM rollups do not cover the authoritative source revision"
          );
        }
      }
    }
    if (
      items.length === 0 ||
      manifest.length === 0 ||
      items.length > MAX_SOURCE_ITEMS
    ) {
      throw new SharedMemoryConflictError(
        "Authoritative Shared Memory source material is empty or invalid"
      );
    }
    // Admission and Privacy use the same complete semantic-preview bounds.
    extractSharedMemorySemanticClassificationFields(items);
    const hashes = sourceMaterialHashes({
      source: {
        kind: "captured_session",
        sessionId: input.sourceSessionId,
        logicalMemoryId: input.logicalMemoryId
      },
      representation: input.representation,
      logicalMemoryId: input.logicalMemoryId,
      sourceCursor: input.sourceRevision,
      manifest,
      items
    });
    return {
      items,
      manifest,
      ...hashes,
      mappedEvents
    };
  };

  const persistArtifactAndPreview = async (
    client: pg.PoolClient,
    actor: ActorContext,
    input: {
      context: ArtifactPersistenceContext;
      artifactBody: SharedSourceArtifactV1;
      previewBody: SharedSourcePreviewV1;
    }
  ): Promise<PersistedPreviewLoadResult> => {
    const source = sharedMemorySourceRefSchema.parse(input.artifactBody.source);
    const exactSourceRevision = await ensureLogicalMemorySourceRevision(
      client,
      {
        source,
        ownerPrincipalId: input.context.ownerPrincipalId,
        revision: input.context.sourceRevision
      }
    );
    const artifactResult = await client.query<Row>(
      `insert into shared_source_artifacts (
         id,logical_memory_id,source_revision_id,remote_replica_id,sync_relationship_id,
         owner_user_id,owner_principal_id,team_id,team_workspace_id,
         representation,artifact_schema_version,source_revision,source_cursor,
         package_sequence,source_hash,manifest_hash,artifact_hash,
         source_content_hash,maximum_fidelity,include_curated_memory,
         source_owner_policy_id,
         source_owner_policy_version,team_policy_id,team_policy_version,
         workspace_policy_id,workspace_policy_version,
         representation_policy_revision,representation_policy_hash,
         content_policy_version,content_policy_hash,
         classifier_version,classifier_hash,
         source_deployment_identity_id,remote_user_identity_id,
         device_credential_id,device_provenance_hash,
         source_capabilities,activation_representation
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,
         $34,$35,$36,$37,$38
       )
       on conflict (artifact_hash) do update
         set invalidated_at=null,invalidation_reason=null
       returning *`,
      [
        input.artifactBody.artifactId,
        input.context.logicalMemoryId,
        exactSourceRevision.id,
        input.context.remoteReplicaId,
        input.context.syncRelationshipId,
        input.context.ownerUserId,
        input.context.ownerPrincipalId,
        input.context.teamId,
        input.context.teamWorkspaceId,
        input.artifactBody.representation,
        input.artifactBody.schemaVersion,
        input.context.sourceRevision,
        input.context.sourceCursor,
        input.context.packageSequence,
        input.artifactBody.binding.sourceHash,
        input.artifactBody.manifestHash,
        input.artifactBody.artifactHash,
        input.artifactBody.sourceContentHash,
        input.context.maximumFidelity,
        input.context.includeCuratedMemory,
        input.context.sourceOwnerPolicyId,
        input.context.sourceOwnerPolicyVersion,
        input.context.teamPolicyId,
        input.context.teamPolicyVersion,
        input.context.workspacePolicyId,
        input.context.workspacePolicyVersion,
        input.context.fidelityPolicyRevision,
        input.context.fidelityPolicyHash,
        input.context.contentPolicyVersion,
        input.context.contentPolicyHash,
        input.context.classifierVersion,
        input.context.classifierHash,
        input.context.sourceDeploymentIdentityId,
        input.context.remoteUserIdentityId,
        input.context.deviceCredentialId,
        input.context.deviceProvenanceHash,
        input.context.sourceCapabilities,
        input.context.activationRepresentation
      ]
    );
    const artifactRow: Row = {
      ...artifactResult.rows[0]!,
      source_kind: source.kind,
      source_session_id:
        source.kind === "captured_session" ? source.sessionId : null,
      source_note_id: source.kind === "personal_note" ? source.noteId : null,
      source_memory_event_id:
        source.kind === "personal_note" ? source.memoryEventId : null,
      maximum_fidelity: input.context.maximumFidelity,
      include_curated_memory: input.context.includeCuratedMemory
    };
    const provider = await resolveOwnerPrivateReplicaEncryptionProvider({
      ownerUserId: input.context.ownerUserId,
      ownerPrincipalId: input.context.ownerPrincipalId,
      logicalMemoryId: input.context.logicalMemoryId,
      remoteReplicaId: input.context.remoteReplicaId,
      teamId: input.context.teamId,
      teamWorkspaceId: input.context.teamWorkspaceId,
      purpose: "encrypt"
    });
    await upsertEncryptedFieldPayloadWithClient(client, actor, provider, {
      sourceTable: "shared_source_artifacts",
      sourceId: input.artifactBody.artifactId,
      sourceColumn: "artifact",
      plaintext: input.artifactBody,
      visibility: "owner_private_replica",
      ownerPrincipalId: input.context.ownerPrincipalId,
      rowFamily: "shared_source_artifact",
      scope: {
        tenantId: input.context.ownerUserId,
        objectClass: "shared_source_artifact"
      },
      aad: {
        logicalMemoryId: input.context.logicalMemoryId,
        remoteReplicaId: input.context.remoteReplicaId,
        teamId: input.context.teamId,
        teamWorkspaceId: input.context.teamWorkspaceId,
        representation: input.artifactBody.representation,
        artifactHash: input.artifactBody.artifactHash,
        sourceRevision: input.context.sourceRevision,
        syncRelationshipId: input.context.syncRelationshipId,
        sourceDeploymentIdentityId: input.context.sourceDeploymentIdentityId,
        remoteUserIdentityId: input.context.remoteUserIdentityId,
        deviceCredentialId: input.context.deviceCredentialId,
        deviceProvenanceHash: input.context.deviceProvenanceHash
      }
    });
    const previewResult = await client.query<Row>(
      `insert into shared_source_previews (
         id,source_artifact_id,logical_memory_id,source_revision_id,remote_replica_id,
         owner_user_id,owner_principal_id,team_id,team_workspace_id,
         representation,preview_schema_version,preview_revision,
         preview_hash,source_revision,source_hash,source_content_hash,
         source_capabilities,activation_representation,mode
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
       )
       on conflict (preview_hash) do update
         set invalidated_at=null,invalidation_reason=null
       returning *`,
      [
        input.previewBody.previewId,
        input.artifactBody.artifactId,
        input.context.logicalMemoryId,
        exactSourceRevision.id,
        input.context.remoteReplicaId,
        input.context.ownerUserId,
        input.context.ownerPrincipalId,
        input.context.teamId,
        input.context.teamWorkspaceId,
        input.previewBody.representation,
        input.previewBody.schemaVersion,
        1,
        input.previewBody.previewHash,
        input.context.sourceRevision,
        input.previewBody.binding.sourceHash,
        input.previewBody.sourceContentHash,
        input.context.sourceCapabilities,
        input.context.activationRepresentation,
        input.context.mode
      ]
    );
    await upsertEncryptedFieldPayloadWithClient(client, actor, provider, {
      sourceTable: "shared_source_previews",
      sourceId: input.previewBody.previewId,
      sourceColumn: "preview",
      plaintext: input.previewBody,
      visibility: "owner_private_replica",
      ownerPrincipalId: input.context.ownerPrincipalId,
      rowFamily: "shared_source_preview",
      scope: {
        tenantId: input.context.ownerUserId,
        objectClass: "shared_source_preview"
      },
      aad: {
        logicalMemoryId: input.context.logicalMemoryId,
        remoteReplicaId: input.context.remoteReplicaId,
        teamId: input.context.teamId,
        teamWorkspaceId: input.context.teamWorkspaceId,
        representation: input.previewBody.representation,
        artifactId: input.previewBody.artifactId,
        previewHash: input.previewBody.previewHash,
        sourceRevision: input.context.sourceRevision
      }
    });
    await client.query(
      `select pg_notify(
         '${SHARED_MEMORY_PRIVACY_WAKE_CHANNEL}',
         json_build_object(
           'sourcePreviewId', $1::uuid,
           'teamId', $2::uuid,
           'teamWorkspaceId', $3::uuid,
           'representation', $4::text
         )::text
       )`,
      [
        input.previewBody.previewId,
        input.context.teamId,
        input.context.teamWorkspaceId,
        input.previewBody.representation
      ]
    );
    return {
      artifact: mapArtifact(artifactRow),
      preview: mapPersistedPreview(
        previewResult.rows[0]!,
        mapArtifact(artifactRow),
        input.previewBody,
        input.artifactBody
      ),
      artifactBody: input.artifactBody,
      previewBody: input.previewBody
    };
  };

  const loadPersistedPreviewByReference = async (
    client: pg.PoolClient,
    input: {
      preview: SharedSourcePreviewReference;
      requiredMessage: string;
    }
  ): Promise<PersistedPreviewLoadResult> => {
    const result = await client.query<Row>(
      `select
          sp.id as preview_id,
          sp.source_artifact_id as preview_source_artifact_id,
          sp.logical_memory_id as preview_logical_memory_id,
          sp.source_revision_id as preview_source_revision_id,
          sp.remote_replica_id as preview_remote_replica_id,
          sp.owner_user_id as preview_owner_user_id,
          sp.owner_principal_id as preview_owner_principal_id,
          sp.team_id as preview_team_id,
          sp.team_workspace_id as preview_team_workspace_id,
          sp.representation as preview_representation,
          sp.preview_schema_version,
          sp.preview_revision,
          sp.preview_hash,
          sp.source_revision as preview_source_revision,
          sp.source_hash as preview_source_hash,
          sp.source_content_hash as preview_source_content_hash,
          binding.source_kind as preview_source_kind,
          binding.source_session_id as preview_source_session_id,
          binding.source_note_id as preview_source_note_id,
          binding.source_memory_event_id as preview_source_memory_event_id,
          sp.source_capabilities as preview_source_capabilities,
          sp.activation_representation as preview_activation_representation,
          sp.mode as preview_mode,
          sp.created_at as preview_created_at,
          sa.id as artifact_id,
          sa.logical_memory_id as artifact_logical_memory_id,
          sa.source_revision_id as artifact_source_revision_id,
          sa.remote_replica_id as artifact_remote_replica_id,
          sa.sync_relationship_id,
          sa.owner_user_id as artifact_owner_user_id,
          sa.owner_principal_id as artifact_owner_principal_id,
          sa.team_id as artifact_team_id,
          sa.team_workspace_id as artifact_team_workspace_id,
          sa.representation as artifact_representation,
          sa.source_revision as artifact_source_revision,
          sa.source_cursor,
          sa.package_sequence,
          sa.source_hash as artifact_source_hash,
          sa.manifest_hash,
          sa.artifact_hash,
          sa.source_content_hash as artifact_source_content_hash,
          sa.maximum_fidelity,
          sa.include_curated_memory,
          sa.source_owner_policy_id,
          sa.source_owner_policy_version,
          sa.team_policy_id,
          sa.team_policy_version,
          sa.workspace_policy_id,
          sa.workspace_policy_version,
          sa.representation_policy_revision,
          sa.representation_policy_hash,
          sa.content_policy_version,
          sa.content_policy_hash,
          sa.classifier_version,
          sa.classifier_hash,
          sa.source_deployment_identity_id,
          sa.remote_user_identity_id,
          sa.device_credential_id,
          sa.device_provenance_hash,
          binding.source_kind as artifact_source_kind,
          binding.source_session_id as artifact_source_session_id,
          binding.source_note_id as artifact_source_note_id,
          binding.source_memory_event_id as artifact_source_memory_event_id,
          sa.source_capabilities as artifact_source_capabilities,
          sa.activation_representation as artifact_activation_representation,
          sa.created_at as artifact_created_at
         from shared_source_preview_records sp
         join shared_source_artifact_records sa on sa.id=sp.source_artifact_id
         join logical_memory_source_revision_bindings binding
           on binding.source_revision_id=sp.source_revision_id
          and binding.source_revision_id=sa.source_revision_id
        where sp.id=$1 and sp.preview_hash=$2
          and sp.invalidated_at is null
          and sa.invalidated_at is null
        limit 1`,
      [input.preview.previewId, input.preview.previewHash]
    );
    const row = result.rows[0];
    if (!row) {
      throw new SharedMemoryConflictError(input.requiredMessage);
    }
    const artifactRow: Row = {
      id: row.artifact_id,
      logical_memory_id: row.artifact_logical_memory_id,
      source_revision_id: row.artifact_source_revision_id,
      remote_replica_id: row.artifact_remote_replica_id,
      sync_relationship_id: row.sync_relationship_id,
      owner_user_id: row.artifact_owner_user_id,
      owner_principal_id: row.artifact_owner_principal_id,
      team_id: row.artifact_team_id,
      team_workspace_id: row.artifact_team_workspace_id,
      representation: row.artifact_representation,
      source_revision: row.artifact_source_revision,
      source_cursor: row.source_cursor,
      package_sequence: row.package_sequence,
      source_hash: row.artifact_source_hash,
      manifest_hash: row.manifest_hash,
      artifact_hash: row.artifact_hash,
      source_content_hash: row.artifact_source_content_hash,
      source_owner_policy_id: row.source_owner_policy_id,
      source_owner_policy_version: row.source_owner_policy_version,
      maximum_fidelity: row.maximum_fidelity,
      include_curated_memory: row.include_curated_memory,
      team_policy_id: row.team_policy_id,
      team_policy_version: row.team_policy_version,
      workspace_policy_id: row.workspace_policy_id,
      workspace_policy_version: row.workspace_policy_version,
      representation_policy_revision: row.representation_policy_revision,
      representation_policy_hash: row.representation_policy_hash,
      content_policy_version: row.content_policy_version,
      content_policy_hash: row.content_policy_hash,
      classifier_version: row.classifier_version,
      classifier_hash: row.classifier_hash,
      source_deployment_identity_id: row.source_deployment_identity_id,
      remote_user_identity_id: row.remote_user_identity_id,
      device_credential_id: row.device_credential_id,
      device_provenance_hash: row.device_provenance_hash,
      source_kind: row.artifact_source_kind,
      source_session_id: row.artifact_source_session_id,
      source_note_id: row.artifact_source_note_id,
      source_memory_event_id: row.artifact_source_memory_event_id,
      source_capabilities: row.artifact_source_capabilities,
      activation_representation: row.artifact_activation_representation,
      created_at: row.artifact_created_at
    };
    const artifact = mapArtifact(artifactRow);
    const ownerUserId = artifact.ownerUserId;
    if (!ownerUserId) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source owner binding is missing"
      );
    }
    const artifactPlain = await decryptPersistedOwnerPrivatePayload(client, {
      sourceTable: "shared_source_artifacts",
      sourceId: artifact.artifactId,
      sourceColumn: "artifact",
      ownerUserId,
      ownerPrincipalId: artifact.ownerPrincipalId,
      logicalMemoryId: artifact.logicalMemoryId,
      remoteReplicaId: artifact.remoteReplicaId,
      teamId: artifact.teamId,
      teamWorkspaceId: artifact.teamWorkspaceId,
      requiredMessage: "Shared Memory source artifact decryption is required"
    });
    const previewPlain = await decryptPersistedOwnerPrivatePayload(client, {
      sourceTable: "shared_source_previews",
      sourceId: input.preview.previewId,
      sourceColumn: "preview",
      ownerUserId,
      ownerPrincipalId: artifact.ownerPrincipalId,
      logicalMemoryId: artifact.logicalMemoryId,
      remoteReplicaId: artifact.remoteReplicaId,
      teamId: artifact.teamId,
      teamWorkspaceId: artifact.teamWorkspaceId,
      requiredMessage: "Shared Memory source preview decryption is required"
    });
    if (!isPlainObject(artifactPlain) || !isPlainObject(previewPlain)) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source payload is invalid"
      );
    }
    const artifactBody = artifactPlain as unknown as SharedSourceArtifactV1;
    const previewBody = previewPlain as unknown as SharedSourcePreviewV1;
    const validatedArtifactItems = validateLoadedSourceItems(
      artifact.representation,
      artifact.logicalMemoryId,
      artifact.sourceRevision,
      artifactBody.items
    );
    const validatedPreviewItems = validateLoadedSourceItems(
      artifact.representation,
      artifact.logicalMemoryId,
      artifact.sourceRevision,
      previewBody.items
    );
    const manifestHash = crossIdentitySyncDigest(artifactBody.manifest);
    const artifactHash = sharedSourceArtifactHash({
      ...artifactBody,
      items: validatedArtifactItems
    });
    const previewHash = sharedSourcePreviewHash({
      ...previewBody,
      items: validatedPreviewItems
    });
    const sourceBindingMatches =
      crossIdentitySyncDigest(artifactBody.source ?? null) ===
        crossIdentitySyncDigest(artifact.source ?? null) &&
      crossIdentitySyncDigest(previewBody.source ?? null) ===
        crossIdentitySyncDigest(artifact.source ?? null);
    const transportBindingMatches =
      artifact.source?.kind === "personal_note"
        ? artifact.remoteReplicaId === null &&
          artifact.syncRelationshipId === null &&
          artifactBody.sync === undefined
        : artifact.remoteReplicaId !== null &&
          artifact.syncRelationshipId !== null &&
          artifactBody.sync !== undefined &&
          artifactBody.sync.relationshipId === artifact.syncRelationshipId &&
          artifactBody.sync.localReplicaId === artifact.remoteReplicaId &&
          artifactBody.sync.sourceDeploymentIdentityId ===
            artifact.sourceDeploymentIdentityId &&
          artifactBody.sync.remoteUserIdentityId ===
            artifact.remoteUserIdentityId &&
          artifactBody.sync.deviceCredentialId ===
            artifact.deviceCredentialId &&
          artifactBody.sync.deviceProvenanceHash ===
            artifact.deviceProvenanceHash;
    if (
      artifactBody.schemaVersion !== SHARED_SOURCE_ARTIFACT_SCHEMA_VERSION ||
      previewBody.schemaVersion !== SHARED_SOURCE_PREVIEW_SCHEMA_VERSION ||
      artifactBody.artifactId !== artifact.artifactId ||
      artifactBody.artifactHash !== artifact.artifactHash ||
      artifactHash !== artifact.artifactHash ||
      sharedSourceArtifactId(artifactHash) !== artifact.artifactId ||
      artifactBody.logicalMemoryId !== artifact.logicalMemoryId ||
      artifactBody.representation !== artifact.representation ||
      artifactBody.binding.sourceHash !== artifact.sourceHash ||
      artifactBody.binding.sourceRevision !== artifact.sourceRevision ||
      artifactBody.manifestHash !== artifact.manifestHash ||
      manifestHash !== artifact.manifestHash ||
      artifactBody.sourceContentHash !== artifact.sourceContentHash ||
      crossIdentitySyncDigest(validatedArtifactItems) !==
        artifact.sourceContentHash ||
      !sourceBindingMatches ||
      !transportBindingMatches ||
      artifactBody.policies.sourceOwnerPolicyId !==
        artifact.sourceOwnerPolicyId ||
      artifactBody.policies.sourceOwnerPolicyVersion !==
        artifact.sourceOwnerPolicyVersion ||
      artifactBody.policies.teamPolicyId !== artifact.teamPolicyId ||
      artifactBody.policies.teamPolicyVersion !== artifact.teamPolicyVersion ||
      artifactBody.policies.workspacePolicyId !== artifact.workspacePolicyId ||
      artifactBody.policies.workspacePolicyVersion !==
        artifact.workspacePolicyVersion
    ) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source artifact binding mismatch"
      );
    }
    if (
      previewBody.previewId !== input.preview.previewId ||
      previewBody.previewHash !== input.preview.previewHash ||
      previewHash !== input.preview.previewHash ||
      sharedSourcePreviewId(previewHash) !== input.preview.previewId ||
      previewBody.artifactId !== artifact.artifactId ||
      previewBody.logicalMemoryId !== artifact.logicalMemoryId ||
      previewBody.representation !== artifact.representation ||
      previewBody.binding.sourceHash !== artifact.sourceHash ||
      previewBody.binding.sourceRevision !== artifact.sourceRevision ||
      previewBody.sourceContentHash !== artifact.sourceContentHash ||
      crossIdentitySyncDigest(validatedPreviewItems) !==
        artifact.sourceContentHash ||
      crossIdentitySyncDigest(validatedPreviewItems) !==
        crossIdentitySyncDigest(validatedArtifactItems)
    ) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source preview binding mismatch"
      );
    }
    const previewRecord = mapPersistedPreview(
      {
        id: row.preview_id,
        logical_memory_id: row.preview_logical_memory_id,
        source_revision_id: row.preview_source_revision_id,
        remote_replica_id: row.preview_remote_replica_id,
        owner_user_id: row.preview_owner_user_id,
        owner_principal_id: row.preview_owner_principal_id,
        team_id: row.preview_team_id,
        team_workspace_id: row.preview_team_workspace_id,
        representation: row.preview_representation,
        preview_revision: row.preview_revision,
        preview_hash: row.preview_hash,
        source_revision: row.preview_source_revision,
        source_hash: row.preview_source_hash,
        source_content_hash: row.preview_source_content_hash,
        source_kind: row.preview_source_kind,
        source_session_id: row.preview_source_session_id,
        source_note_id: row.preview_source_note_id,
        source_memory_event_id: row.preview_source_memory_event_id,
        source_capabilities: row.preview_source_capabilities,
        activation_representation: row.preview_activation_representation,
        mode: row.preview_mode,
        created_at: row.preview_created_at
      },
      artifact,
      {
        ...previewBody,
        items: validatedPreviewItems
      },
      {
        ...artifactBody,
        items: validatedArtifactItems
      }
    );
    return {
      artifact,
      preview: previewRecord,
      artifactBody: {
        ...artifactBody,
        items: validatedArtifactItems
      },
      previewBody: {
        ...previewBody,
        items: validatedPreviewItems
      }
    };
  };

  const loadPersistedPreviewMetadataByReference = async (
    client: pg.PoolClient,
    input: {
      preview: SharedSourcePreviewReference;
      requiredMessage: string;
    }
  ): Promise<{
    artifact: SharedMemorySourceArtifactRecord;
    preview: {
      previewId: string;
      previewHash: string;
      artifactId: string;
      logicalMemoryId: string;
      remoteReplicaId: string | null;
      ownerUserId: string;
      ownerPrincipalId: string;
      teamId: string;
      teamWorkspaceId: string;
      representation: SharedMemoryRepresentation;
      previewRevision: number;
      sourceRevision: number;
      sourceHash: string;
      sourceContentHash: string;
      binding: SharedMemorySourceBindingDto;
      deviceProvenanceHash: string;
    };
  }> => {
    const result = await client.query<Row>(
      `select row_to_json(preview) as preview_row,
              row_to_json(artifact) as artifact_row
         from shared_source_preview_records preview
         join shared_source_artifact_records artifact
           on artifact.id=preview.source_artifact_id
        where preview.id=$1 and preview.preview_hash=$2
          and preview.invalidated_at is null
          and artifact.invalidated_at is null
        limit 1`,
      [input.preview.previewId, input.preview.previewHash]
    );
    const row = result.rows[0];
    if (
      !row ||
      !isPlainObject(row.preview_row) ||
      !isPlainObject(row.artifact_row)
    ) {
      throw new SharedMemoryConflictError(input.requiredMessage);
    }
    const artifact = mapArtifact(row.artifact_row);
    const previewRow = row.preview_row;
    const ownerUserId = nullableString(previewRow.owner_user_id);
    if (!ownerUserId) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source owner binding is missing"
      );
    }
    const preview = {
      previewId: stringValue(previewRow.id),
      previewHash: stringValue(previewRow.preview_hash),
      artifactId: stringValue(previewRow.source_artifact_id),
      logicalMemoryId: stringValue(previewRow.logical_memory_id),
      remoteReplicaId: nullableStringValue(previewRow.remote_replica_id),
      ownerUserId,
      ownerPrincipalId: stringValue(previewRow.owner_principal_id),
      teamId: stringValue(previewRow.team_id),
      teamWorkspaceId: stringValue(previewRow.team_workspace_id),
      representation: stringValue(
        previewRow.representation
      ) as SharedMemoryRepresentation,
      previewRevision: numberValue(previewRow.preview_revision),
      sourceRevision: numberValue(previewRow.source_revision),
      sourceHash: stringValue(previewRow.source_hash),
      sourceContentHash: stringValue(previewRow.source_content_hash),
      binding: {
        sourceRevision: artifact.sourceRevision,
        sourceHash: artifact.sourceHash,
        fidelityPolicyRevision: artifact.representationPolicyRevision,
        fidelityPolicyHash: artifact.representationPolicyHash,
        contentPolicyVersion: artifact.contentPolicyVersion,
        contentPolicyHash: artifact.contentPolicyHash,
        classifierVersion: artifact.classifierVersion,
        classifierHash: artifact.classifierHash
      },
      deviceProvenanceHash: artifact.deviceProvenanceHash
    };
    if (
      preview.previewId !== input.preview.previewId ||
      preview.previewHash !== input.preview.previewHash ||
      preview.artifactId !== artifact.artifactId ||
      preview.logicalMemoryId !== artifact.logicalMemoryId ||
      preview.remoteReplicaId !== artifact.remoteReplicaId ||
      preview.ownerUserId !== artifact.ownerUserId ||
      preview.ownerPrincipalId !== artifact.ownerPrincipalId ||
      preview.teamId !== artifact.teamId ||
      preview.teamWorkspaceId !== artifact.teamWorkspaceId ||
      preview.representation !== artifact.representation ||
      preview.sourceRevision !== artifact.sourceRevision ||
      preview.sourceHash !== artifact.sourceHash ||
      preview.sourceContentHash !== artifact.sourceContentHash
    ) {
      throw new SharedMemoryConflictError(
        "Persisted Shared Memory source preview metadata binding mismatch"
      );
    }
    return { artifact, preview };
  };

  const loadActiveReplicaState = async (
    client: pg.PoolClient,
    input: {
      logicalMemoryId: string;
      remoteReplicaId: string;
      ownerUserId: string;
      ownerPrincipalId: string;
      syncRelationshipId: string;
    }
  ): Promise<{
    localSessionId: string;
    localReplicaId: string;
    remoteSyncReplicaId: string;
    sourceCursor: number;
    packageSequence: number;
    sourceDeploymentIdentityId: string;
    remoteUserIdentityId: string;
    deviceCredentialId: string;
    deviceProvenanceHash: string;
  }> => {
    const result = await client.query<Row>(
      `select local_memory.local_session_id,
              mr.id as local_replica_id,
              sr.remote_replica_id as remote_sync_replica_id,
              sr.target_processing_cursor,
              sr.package_sequence,
              sr.remote_deployment_identity_id as source_deployment_identity_id,
              sr.remote_user_identity_id,
              sr.device_credential_id,
              credential.credential_key_id,credential.upstream_backend_id,
              credential.device_instance_id,credential.lineage_id,
              credential.credential_version,credential.verifier_kind,
              credential.verifier_hash,credential.public_key_jwk,
              sr.id as sync_relationship_id
         from logical_memories lm
         join local_captured_session_logical_memories local_memory
           on local_memory.logical_memory_id=lm.id
          and local_memory.owner_user_id=$3
         join memory_replicas mr
           on mr.logical_memory_id=lm.id
          and mr.id=$2
          and mr.owner_user_id=$3
          and mr.owner_principal_id=$4
          and mr.replica_role='target'
          and mr.encryption_scope='owner_private_replica'
          and mr.lifecycle='active'
          and mr.disabled_at is null
         join cross_identity_sync_relationships sr
           on sr.id=$5
          and sr.local_replica_id=mr.id
          and sr.logical_memory_id=lm.id
          and sr.side='target'
          and sr.local_user_id=$3
          and sr.revoked_at is null
          and sr.state in ('processing','partially_available','ready','stale')
         join device_credentials credential
           on credential.id=sr.device_credential_id
          and credential.owner_user_id=$3
          and credential.revoked_at is null
          and (credential.expires_at is null or credential.expires_at > now())
        where lm.id=$1
          and lm.owner_user_id=$3
          and lm.owner_principal_id=$4
        limit 1`,
      [
        input.logicalMemoryId,
        input.remoteReplicaId,
        input.ownerUserId,
        input.ownerPrincipalId,
        input.syncRelationshipId
      ]
    );
    const row = result.rows[0];
    if (!row || !nullableString(row.local_session_id)) {
      throw new SharedMemoryConflictError(
        "Active owner-private sync relationship is required"
      );
    }
    return {
      localSessionId: stringValue(row.local_session_id),
      localReplicaId: stringValue(row.local_replica_id),
      remoteSyncReplicaId: stringValue(row.remote_sync_replica_id),
      sourceCursor: numberValue(row.target_processing_cursor),
      packageSequence: numberValue(row.package_sequence),
      sourceDeploymentIdentityId: stringValue(
        row.source_deployment_identity_id
      ),
      remoteUserIdentityId: stringValue(row.remote_user_identity_id),
      deviceCredentialId: stringValue(row.device_credential_id),
      deviceProvenanceHash: deviceProvenanceHash({
        ...row,
        sync_relationship_id: row.sync_relationship_id
      })
    };
  };

  const loadAuthoritativeSyncContext = async (
    client: pg.PoolClient,
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      remoteReplicaId: string;
      teamId: string;
      teamWorkspaceId: string;
      representation: SharedMemoryRepresentation;
      sourceCapabilities: SharedMemoryRepresentation[];
      activationRepresentation: SharedMemoryRepresentation;
      mode: SharedMemoryConsentMode;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
      authority?: SharedMemoryAuthorityContext;
      continuousGrantId?: string;
      internalPendingShareId?: string;
    }
  ): Promise<{
    context: AuthoritativeSyncContext;
    ownerPolicy: SharedMemoryPolicyRecord;
    teamPolicy: SharedMemoryPolicyRecord;
    workspacePolicy: SharedMemoryPolicyRecord;
  }> => {
    if (!delegatedDeviceActionGrant) {
      await client.query("set transaction isolation level repeatable read");
    }
    const owner = await requireSourceOwner(
      client,
      actor,
      input.logicalMemoryId
    );
    if (input.internalPendingShareId) {
      const pending = await client.query(
        `select 1 from pending_share_operation_records
          where id=$1 and owner_user_id=$2 and logical_memory_id=$3
            and team_id=$4 and team_workspace_id=$5
            and coalesce(replacement_representation,representation)=$6
            and state='preparing' and revoked_at is null
          limit 1`,
        [
          input.internalPendingShareId,
          actor.userId,
          input.logicalMemoryId,
          input.teamId,
          input.teamWorkspaceId,
          input.representation
        ]
      );
      if (!pending.rowCount) {
        throw new SharedMemoryAuthorizationError(
          "Pending Share preview authority is invalid"
        );
      }
    } else if (input.authority) {
      await requireShareAuthority(client, actor, {
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        authority: input.authority,
        consume: false,
        delegatedDeviceActionGrant
      });
    } else {
      if (!input.continuousGrantId) {
        throw new SharedMemoryAuthorizationError(
          "Continuous Share Grant authority is required"
        );
      }
      const continuousAuthority = await client.query<{ allowed: boolean }>(
        `select exists (
           select 1
             from team_memory_share_grant_records g
             join source_owner_representation_consent_records consent
               on consent.id=g.consent_id
              and consent.mode='continuous'
              and consent.state='active'
              and consent.revoked_at is null
              and (consent.expires_at is null or consent.expires_at>now())
            where g.id=$1
              and g.logical_memory_id=$2
              and g.remote_replica_id=$3
              and g.owner_user_id=$4
              and g.owner_principal_id=$5
              and g.team_id=$6
              and g.team_workspace_id=$7
              and (
                g.lifecycle='active'
                or (g.lifecycle='unavailable' and exists (
                  select 1 from pending_share_operation_records pending
                   where pending.grant_id=g.id
                     and pending.state='needs_attention'
                     and pending.redacted_failure_code='approval_content_remediation'
                     and pending.revoked_at is null
                ))
              )
              and g.revoked_at is null
              and (
                ($8 <> 'curated_assertions' and case consent.maximum_fidelity
                  when 'memory_events' then $8 in ('memory_events','lcm_leaves','lcm_rollups')
                  when 'lcm_leaves' then $8 in ('lcm_leaves','lcm_rollups')
                  when 'lcm_rollups' then $8 = 'lcm_rollups'
                  else false end)
                or ($8 = 'curated_assertions' and consent.include_curated_memory)
              )
         ) as allowed`,
        [
          input.continuousGrantId,
          input.logicalMemoryId,
          input.remoteReplicaId,
          actor.userId,
          owner.ownerPrincipalId,
          input.teamId,
          input.teamWorkspaceId,
          input.representation
        ]
      );
      if (continuousAuthority.rows[0]?.allowed !== true) {
        throw new SharedMemoryAuthorizationError(
          "Active continuous consent is required"
        );
      }
    }
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `shared-memory-owner-policy:${input.logicalMemoryId}:${owner.ownerPrincipalId}`
    ]);
    const existingOwnerPolicy = await activePolicy(client, {
      table: "source_owner_representation_policies",
      whereSql: "logical_memory_id=$1 and source_owner_principal_id=$2",
      parameters: [input.logicalMemoryId, owner.ownerPrincipalId]
    });
    assertFidelityConsent(input);
    const currentConsent = existingOwnerPolicy
      ? fidelityConsentFromRow(existingOwnerPolicy)
      : null;
    const policyChanged =
      !existingOwnerPolicy ||
      currentConsent?.maximumFidelity !== input.maximumFidelity ||
      currentConsent?.includeCuratedMemory !== input.includeCuratedMemory;
    if (policyChanged && !input.authority && !input.internalPendingShareId) {
      throw new SharedMemoryConflictError(
        "Continuous materialization requires the existing source-owner policy"
      );
    }
    const teamPolicyRow = await activePolicy(client, {
      table: "team_representation_policies",
      whereSql: "team_id=$1",
      parameters: [input.teamId]
    });
    const workspacePolicyRow = await activePolicy(client, {
      table: "workspace_representation_policies",
      whereSql: "team_id=$1 and team_workspace_id=$2",
      parameters: [input.teamId, input.teamWorkspaceId]
    });
    if (!teamPolicyRow || !workspacePolicyRow) {
      throw new SharedMemoryConflictError(
        "Team and Workspace representation policies are required"
      );
    }
    const ownerPolicy = policyChanged
      ? proposedSourceOwnerPolicy({
          existing: existingOwnerPolicy,
          logicalMemoryId: input.logicalMemoryId,
          ownerPrincipalId: owner.ownerPrincipalId,
          maximumFidelity: input.maximumFidelity,
          includeCuratedMemory: input.includeCuratedMemory
        })
      : mapPolicy(existingOwnerPolicy!, "source_owner");
    const teamPolicy = mapPolicy(teamPolicyRow, "team");
    const workspacePolicy = mapPolicy(workspacePolicyRow, "workspace");
    const effectiveMaximumFidelity = intersectSharedMemoryFidelityCeilings(
      ownerPolicy.maximumFidelity,
      teamPolicy.maximumFidelity,
      workspacePolicy.maximumFidelity
    )!;
    const effectiveIncludeCuratedMemory =
      ownerPolicy.includeCuratedMemory &&
      teamPolicy.includeCuratedMemory &&
      workspacePolicy.includeCuratedMemory;
    if (
      !sharedMemoryCeilingAuthorizes(
        effectiveMaximumFidelity,
        input.representation,
        effectiveIncludeCuratedMemory
      )
    ) {
      throw new SharedMemoryConflictError(
        "Representation is outside the effective fidelity policy"
      );
    }
    if (
      input.maximumFidelity !== effectiveMaximumFidelity ||
      input.includeCuratedMemory !== effectiveIncludeCuratedMemory
    ) {
      throw new SharedMemoryConflictError(
        "Preview fidelity is outside the exact policy intersection"
      );
    }
    const rowResult = await client.query<Row>(
      `select lm.id as logical_memory_id,lm.owner_user_id,lm.owner_principal_id,
              local_memory.local_session_id,source_binding.source_session_id,
              lm.latest_source_revision,
              mr.id as remote_replica_id,mr.latest_revision,
              mr.representation_policy_revision as replica_representation_policy_revision,
              mr.content_policy_version as replica_content_policy_version,
              sr.id as sync_relationship_id,sr.local_replica_id,
              sr.remote_replica_id as remote_sync_replica_id,
              sr.remote_deployment_identity_id as source_deployment_identity_id,
              sr.remote_user_identity_id,sr.device_credential_id,
              sr.source_cursor,sr.target_processing_cursor,sr.package_sequence,
              credential.credential_key_id,credential.upstream_backend_id,
              credential.device_instance_id,credential.lineage_id,
              credential.credential_version,credential.verifier_kind,
              credential.verifier_hash,credential.public_key_jwk
         from logical_memories lm
         join local_captured_session_logical_memories local_memory
           on local_memory.logical_memory_id=lm.id
          and local_memory.owner_user_id=$3
         join memory_replicas mr
           on mr.logical_memory_id=lm.id
          and mr.id=$2
          and mr.owner_user_id=$3
          and mr.owner_principal_id=lm.owner_principal_id
          and mr.replica_role='target'
          and mr.encryption_scope='owner_private_replica'
          and mr.lifecycle='active'
          and mr.disabled_at is null
         join cross_identity_sync_relationships sr
           on sr.local_replica_id=mr.id
          and sr.logical_memory_id=lm.id
          and sr.side='target'
          and sr.local_user_id=$3
          and sr.revoked_at is null
          and sr.state in ('processing','partially_available','ready','stale')
         join logical_memory_source_revision_bindings source_binding
           on source_binding.logical_memory_id=lm.id
          and source_binding.owner_principal_id=lm.owner_principal_id
          and source_binding.source_revision=sr.target_processing_cursor
          and source_binding.source_kind='captured_session'
         join device_credentials credential
           on credential.id=sr.device_credential_id
          and credential.owner_user_id=$3
          and credential.revoked_at is null
          and (credential.expires_at is null or credential.expires_at > now())
        where lm.id=$1
          and lm.owner_user_id=$3
          and lm.owner_principal_id=$4
        for update of lm,mr,sr,credential`,
      [
        input.logicalMemoryId,
        input.remoteReplicaId,
        actor.userId,
        owner.ownerPrincipalId
      ]
    );
    const row = rowResult.rows[0];
    if (!row) {
      throw new SharedMemoryAuthorizationError(
        "Owner-private sync relationship is not active for this Memory source"
      );
    }
    const sourceRevision = numberValue(row.target_processing_cursor);
    if (
      sourceRevision !== numberValue(row.latest_source_revision) ||
      sourceRevision !== numberValue(row.latest_revision) ||
      nullableString(row.local_session_id) === null ||
      nullableString(row.source_session_id) === null
    ) {
      throw new SharedMemoryConflictError(
        "Replica revision drift prevents authoritative source preview generation"
      );
    }
    const representationPolicyRevision =
      nullableNumber(row.replica_representation_policy_revision) ?? 1;
    const contentPolicyVersion =
      nullableNumber(row.replica_content_policy_version) ?? 1;
    const binding = authoritativeSourceBinding({
      representation: input.representation,
      sourceRevision,
      ownerPolicy,
      teamPolicy,
      workspacePolicy,
      fidelityPolicyRevision: representationPolicyRevision,
      contentPolicyVersion
    });
    return {
      context: {
        logicalMemoryId: input.logicalMemoryId,
        remoteReplicaId: stringValue(row.remote_replica_id),
        localSessionId: requireHydratedValue(
          nullableString(row.local_session_id),
          "Target replica session is required"
        ),
        sourceSessionId: requireHydratedValue(
          nullableString(row.source_session_id),
          "Source Session identity is required"
        ),
        ownerUserId: stringValue(row.owner_user_id),
        ownerPrincipalId: stringValue(row.owner_principal_id),
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        syncRelationshipId: stringValue(row.sync_relationship_id),
        localReplicaId: stringValue(row.local_replica_id),
        remoteSyncReplicaId: stringValue(row.remote_sync_replica_id),
        sourceRevision,
        sourceCursor: sourceRevision,
        packageSequence: numberValue(row.package_sequence),
        sourceCapabilities: input.sourceCapabilities,
        activationRepresentation: input.activationRepresentation,
        mode: input.mode,
        fidelityPolicyRevision: representationPolicyRevision,
        fidelityPolicyHash: binding.fidelityPolicyHash,
        maximumFidelity: input.maximumFidelity,
        includeCuratedMemory: input.includeCuratedMemory,
        contentPolicyVersion,
        contentPolicyHash: binding.contentPolicyHash,
        classifierVersion: binding.classifierVersion,
        classifierHash: binding.classifierHash,
        sourceOwnerPolicyId: ownerPolicy.policyId,
        sourceOwnerPolicyVersion: ownerPolicy.version,
        teamPolicyId: teamPolicy.policyId,
        teamPolicyVersion: teamPolicy.version,
        workspacePolicyId: workspacePolicy.policyId,
        workspacePolicyVersion: workspacePolicy.version,
        sourceDeploymentIdentityId: stringValue(
          row.source_deployment_identity_id
        ),
        remoteUserIdentityId: stringValue(row.remote_user_identity_id),
        deviceCredentialId: stringValue(row.device_credential_id),
        deviceProvenanceHash: deviceProvenanceHash({
          ...row,
          sync_relationship_id: row.sync_relationship_id
        })
      },
      ownerPolicy,
      teamPolicy,
      workspacePolicy
    };
  };

  const createAuthoritativeSourcePreview = async (
    actor: ActorContext,
    input: Omit<
      Parameters<SharedMemoryRepository["createAuthoritativeSourcePreview"]>[1],
      "authority"
    > & {
      authority?: SharedMemoryAuthorityContext;
      representation?: SharedMemoryRepresentation;
    },
    continuousGrantId?: string
  ): Promise<SharedMemoryPersistedPreviewRecord> => {
    assertUuid(input.logicalMemoryId, "logicalMemoryId");
    assertUuid(input.remoteReplicaId, "remoteReplicaId");
    assertUuid(input.teamId, "teamId");
    assertUuid(input.teamWorkspaceId, "teamWorkspaceId");
    assertFidelityConsent(input);
    const representation =
      input.representation ?? input.activationRepresentation;
    return withTransaction(pool, async (client) => {
      const { context } = await loadAuthoritativeSyncContext(client, actor, {
        ...input,
        representation,
        continuousGrantId
      });
      const provider = await resolveOwnerPrivateReplicaEncryptionProvider({
        ownerUserId: context.ownerUserId,
        ownerPrincipalId: context.ownerPrincipalId,
        logicalMemoryId: context.logicalMemoryId,
        remoteReplicaId: context.remoteReplicaId!,
        teamId: context.teamId,
        teamWorkspaceId: context.teamWorkspaceId,
        purpose: "decrypt"
      });
      const material = await loadAuthoritativeSourceMaterial(
        client,
        actor,
        provider,
        {
          representation,
          logicalMemoryId: context.logicalMemoryId,
          ownerUserId: context.ownerUserId,
          ownerPrincipalId: context.ownerPrincipalId,
          localSessionId: context.localSessionId,
          sourceSessionId: context.sourceSessionId,
          syncRelationshipId: context.syncRelationshipId,
          sourceRevision: context.sourceRevision
        }
      );
      const artifactBody = buildArtifactBody({
        context,
        representation,
        sourceHash: material.sourceHash,
        manifestHash: material.manifestHash,
        sourceContentHash: material.sourceContentHash,
        items: material.items,
        manifest: material.manifest
      });
      const previewBody = buildPreviewBody({ artifact: artifactBody });
      const persisted = await persistArtifactAndPreview(client, actor, {
        context,
        artifactBody,
        previewBody
      });
      return persisted.preview;
    });
  };

  const persistPersonalNoteSourceArtifact = async (
    actor: ActorContext,
    input: Parameters<
      SharedMemoryRepository["persistPersonalNoteSourceArtifact"]
    >[1]
  ): Promise<SharedMemoryPersistedPreviewRecord> => {
    assertUuid(input.pendingShareId, "pendingShareId");
    assertUuid(input.sourceDeploymentProtocolId, "sourceDeploymentProtocolId");
    assertUuid(input.sourceOwnerPrincipalId, "sourceOwnerPrincipalId");
    assertUuid(input.deviceCredentialId, "deviceCredentialId");
    const candidate = input.candidate;
    const source = sharedMemorySourceRefSchema.parse(candidate.source);
    const expectedLogicalMemoryId = crossIdentitySyncDeterministicUuid({
      protocol: "koed.personal-note-share/v1",
      sourceDeploymentId: input.sourceDeploymentProtocolId,
      sourceOwnerPrincipalId: input.sourceOwnerPrincipalId,
      noteId: source.kind === "personal_note" ? source.noteId : "",
      identity: "logical-memory"
    });
    if (
      source.kind !== "personal_note" ||
      source.logicalMemoryId !== candidate.logicalMemoryId ||
      source.logicalMemoryId !== expectedLogicalMemoryId ||
      candidate.sourceCapabilities.length !== 1 ||
      candidate.sourceCapabilities[0] !== "memory_events" ||
      candidate.activationRepresentation !== "memory_events" ||
      candidate.sourceRevision !== source.noteRevision ||
      candidate.itemCount !== 1 ||
      candidate.excludedItemCount !== 0 ||
      candidate.items.length !== 1 ||
      candidate.manifest.length !== 1 ||
      candidate.items[0]?.id !== source.memoryEventId ||
      candidate.manifest[0]?.sourceId !== source.memoryEventId
    ) {
      throw new SharedMemoryConflictError(
        "Personal Note source upload must contain exactly one immutable Memory Event"
      );
    }
    const candidateHash = crossIdentitySyncDigest({
      version: 2,
      source,
      sourceOwnerPrincipalId: input.sourceOwnerPrincipalId,
      sourceCapabilities: candidate.sourceCapabilities,
      activationRepresentation: candidate.activationRepresentation,
      mode: candidate.mode,
      sourceRevision: source.noteRevision,
      itemCount: 1,
      byteCount: candidate.byteCount,
      excludedItemCount: 0,
      manifest: candidate.manifest,
      items: candidate.items
    });
    if (candidateHash !== candidate.candidateHash) {
      throw new SharedMemoryConflictError(
        "Personal Note candidate hash is invalid"
      );
    }
    return withTransaction(pool, async (client) => {
      const pendingResult = await client.query<Row>(
        `select p.*,pending_binding.source_kind,pending_binding.source_session_id,
                pending_binding.source_note_id,pending_binding.source_memory_event_id,
                candidate_binding.source_memory_event_id as candidate_source_memory_event_id,
                candidate.candidate_manifest as reviewed_candidate_manifest,
                candidate.candidate_manifest_hash as reviewed_candidate_manifest_hash,
                candidate.item_count as candidate_item_count,
                candidate.byte_count as candidate_byte_count,
                candidate.source_hash as candidate_source_hash,
                candidate.representation_policy_revision as candidate_policy_revision,
                candidate.representation_policy_hash as candidate_policy_hash,
                candidate.content_policy_version as candidate_content_version,
                candidate.content_policy_hash as candidate_content_hash,
                candidate.classifier_version as candidate_classifier_version,
                candidate.classifier_hash as candidate_classifier_hash
           from pending_share_operations p
           join logical_memory_source_revision_bindings pending_binding
             on pending_binding.source_revision_id=coalesce(
               p.replacement_source_revision_id,p.source_revision_id
             )
           join shared_memory_candidate_previews candidate
             on candidate.id=coalesce(p.replacement_preview_id,p.preview_id)
            and candidate.preview_hash=coalesce(
              p.replacement_preview_hash,p.preview_hash
            )
           join logical_memory_source_revision_bindings candidate_binding
             on candidate_binding.source_revision_id=candidate.source_revision_id
          where p.id=$1 and p.owner_user_id=$2 and p.state in ('preparing','needs_attention')
            and p.revoked_at is null
          for update of p,candidate`,
        [input.pendingShareId, actor.userId]
      );
      const pending = pendingResult.rows[0];
      if (!pending) {
        throw new SharedMemoryAuthorizationError(
          "Pending Share source upload is not authorized"
        );
      }
      const pendingSource = sourceRefFromRow({
        ...pending,
        source_revision:
          pending.replacement_source_revision ?? pending.source_revision,
        source_memory_event_id:
          pending.candidate_source_memory_event_id ??
          pending.source_memory_event_id
      });
      if (
        pendingSource?.kind !== "personal_note" ||
        crossIdentitySyncDigest(pendingSource) !==
          crossIdentitySyncDigest(source) ||
        stringValue(pending.logical_memory_id) !== source.logicalMemoryId ||
        stringValue(
          pending.replacement_representation ?? pending.representation
        ) !== "memory_events" ||
        stringValue(pending.replacement_mode ?? pending.mode) !==
          candidate.mode ||
        numberValue(
          pending.replacement_source_revision ?? pending.source_revision
        ) !== source.noteRevision
      ) {
        throw new SharedMemoryConflictError(
          "Pending Share does not match the Personal Note source"
        );
      }
      if (
        stringValue(pending.replacement_source_hash ?? pending.source_hash) !==
          candidate.candidateHash ||
        stringValue(pending.candidate_source_hash) !==
          candidate.candidateHash ||
        numberValue(pending.candidate_item_count) !== 1 ||
        numberValue(pending.candidate_byte_count) !== candidate.byteCount ||
        crossIdentitySyncDigest(pending.reviewed_candidate_manifest) !==
          crossIdentitySyncDigest(candidate.manifest) ||
        stringValue(pending.reviewed_candidate_manifest_hash) !==
          crossIdentitySyncDigest(candidate.manifest)
      ) {
        throw new SharedMemoryConflictError(
          "Uploaded Personal Note differs from the reviewed candidate"
        );
      }
      await requireWorkspaceSharePermission(
        client,
        actor,
        stringValue(pending.team_id),
        stringValue(pending.team_workspace_id)
      );
      const admittedSourceIdentity = await ensureCandidateSourceIdentity(
        client,
        actor,
        {
          source,
          sourceDeploymentProtocolId: input.sourceDeploymentProtocolId,
          sourceOwnerPrincipalId: input.sourceOwnerPrincipalId,
          deviceCredentialId: input.deviceCredentialId,
          requireExternalBinding: true
        }
      );
      const deploymentIdentityId = admittedSourceIdentity.deploymentIdentityId;
      const logicalOwnerPrincipalId = admittedSourceIdentity.ownerPrincipalId;
      const identity = admittedSourceIdentity.credential;
      const remoteUserIdentityId = admittedSourceIdentity.remoteUserIdentityId;
      if (!remoteUserIdentityId) {
        throw new SharedMemoryAuthorizationError(
          "Personal Note source principal binding is unavailable"
        );
      }
      const logicalKey = `personal_note:${input.sourceDeploymentProtocolId}:${source.noteId}`;
      const logicalResult = await client.query<Row>(
        `insert into logical_memories
           (id,protocol_logical_id,owner_user_id,owner_principal_id,
            origin_deployment_identity_id,source_kind,logical_key,
            latest_source_revision)
         values ($1,$1,$2,$3,$4,'personal_note',$5,$6)
         on conflict (id) do update
           set latest_source_revision=excluded.latest_source_revision,
               updated_at=case
                 when logical_memories.latest_source_revision < excluded.latest_source_revision
                   then now()
                 else logical_memories.updated_at
               end
         where logical_memories.protocol_logical_id=excluded.protocol_logical_id
           and logical_memories.owner_user_id=excluded.owner_user_id
           and logical_memories.owner_principal_id=excluded.owner_principal_id
           and logical_memories.origin_deployment_identity_id=
             excluded.origin_deployment_identity_id
           and logical_memories.source_kind=excluded.source_kind
           and logical_memories.logical_key=excluded.logical_key
           and logical_memories.latest_source_revision <=
             excluded.latest_source_revision
         returning *`,
        [
          source.logicalMemoryId,
          actor.userId,
          logicalOwnerPrincipalId,
          deploymentIdentityId,
          logicalKey,
          source.noteRevision
        ]
      );
      const logical = logicalResult.rows[0];
      if (
        !logical ||
        logical.owner_user_id !== actor.userId ||
        logical.owner_principal_id !== logicalOwnerPrincipalId ||
        logical.origin_deployment_identity_id !== deploymentIdentityId ||
        logical.source_kind !== "personal_note" ||
        numberValue(logical.latest_source_revision) !== source.noteRevision
      ) {
        throw new SharedMemoryConflictError(
          "Personal Note logical memory binding changed"
        );
      }
      const existingOwnerPolicy = await activePolicy(client, {
        table: "source_owner_representation_policies",
        whereSql: "logical_memory_id=$1 and source_owner_principal_id=$2",
        parameters: [source.logicalMemoryId, logicalOwnerPrincipalId]
      });
      const ownerPolicy =
        existingOwnerPolicy &&
        stringValue(existingOwnerPolicy.maximum_fidelity) === "memory_events" &&
        existingOwnerPolicy.include_curated_memory === false
          ? mapPolicy(existingOwnerPolicy, "source_owner")
          : proposedSourceOwnerPolicy({
              existing: existingOwnerPolicy,
              logicalMemoryId: source.logicalMemoryId,
              ownerPrincipalId: logicalOwnerPrincipalId,
              maximumFidelity: "memory_events",
              includeCuratedMemory: false,
              policyId: existingOwnerPolicy
                ? undefined
                : crossIdentitySyncDeterministicUuid({
                    protocol: "koed.personal-note-share/v1",
                    logicalMemoryId: source.logicalMemoryId,
                    ownerPrincipalId: logicalOwnerPrincipalId,
                    identity: "source-owner-policy"
                  })
            });
      const teamPolicyRow = await activePolicy(client, {
        table: "team_representation_policies",
        whereSql: "team_id=$1",
        parameters: [pending.team_id]
      });
      const workspacePolicyRow = await activePolicy(client, {
        table: "workspace_representation_policies",
        whereSql: "team_id=$1 and team_workspace_id=$2",
        parameters: [pending.team_id, pending.team_workspace_id]
      });
      if (!teamPolicyRow || !workspacePolicyRow) {
        throw new SharedMemoryConflictError(
          "Team and Workspace representation policies are required"
        );
      }
      const teamPolicy = mapPolicy(teamPolicyRow, "team");
      const workspacePolicy = mapPolicy(workspacePolicyRow, "workspace");
      if (
        !sharedMemoryCeilingAuthorizes(
          intersectSharedMemoryFidelityCeilings(
            ownerPolicy.maximumFidelity,
            teamPolicy.maximumFidelity,
            workspacePolicy.maximumFidelity
          ),
          "memory_events"
        )
      ) {
        throw new SharedMemoryConflictError(
          "Personal Note sharing is outside the current policy intersection"
        );
      }
      const representationPolicyRevision = Math.max(
        teamPolicy.version,
        workspacePolicy.version
      );
      const reviewedRepresentationPolicyHash = crossIdentitySyncDigest({
        kind: "shared_memory_candidate_fidelity_policy",
        representation: "memory_events",
        revision: representationPolicyRevision,
        team: {
          version: teamPolicy.version,
          hash: teamPolicy.policyHash
        },
        workspace: {
          version: workspacePolicy.version,
          hash: workspacePolicy.policyHash
        }
      });
      const reviewedContentPolicyVersion = 1;
      const reviewedContentPolicyHash = contentPolicyHashForPreview({
        representation: "memory_events",
        version: reviewedContentPolicyVersion
      });
      const reviewedClassifierVersion = SHARED_MEMORY_CLASSIFIER_VERSION;
      const reviewedClassifierHash = classifierHashForPreview({
        representation: "memory_events",
        version: reviewedClassifierVersion
      });
      if (
        numberValue(pending.candidate_policy_revision) !==
          representationPolicyRevision ||
        stringValue(pending.candidate_policy_hash) !==
          reviewedRepresentationPolicyHash ||
        numberValue(pending.candidate_content_version) !==
          reviewedContentPolicyVersion ||
        stringValue(pending.candidate_content_hash) !==
          reviewedContentPolicyHash ||
        numberValue(pending.candidate_classifier_version) !==
          reviewedClassifierVersion ||
        stringValue(pending.candidate_classifier_hash) !==
          reviewedClassifierHash
      ) {
        throw new SharedMemoryConflictError(
          "Personal Note sharing policy changed after review"
        );
      }
      const representationPolicyHash = fidelityPolicyHashForPreview({
        representation: "memory_events",
        revision: representationPolicyRevision,
        owner: ownerPolicy,
        team: teamPolicy,
        workspace: workspacePolicy
      });
      const contentPolicyVersion = reviewedContentPolicyVersion;
      const classifierVersion = reviewedClassifierVersion;
      const sourceItem = candidate.items[0]!;
      if (sourceItem.representation !== "memory_events") {
        throw new SharedMemorySourceItemRejectedError("wrong_representation");
      }
      const contributor = sourceItem.sourceItems[0];
      if (
        sourceItem.sourceItems.length !== 1 ||
        !contributor ||
        contributor.id !== source.memoryEventId ||
        contributor.sourceKind !== "user_message" ||
        !contributor.body.trim()
      ) {
        throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
      }
      const items = [
        strictAuthoritativeSourceItem({
          representation: "memory_events",
          logicalMemoryId: source.logicalMemoryId,
          sourceRevision: source.noteRevision,
          itemType: "user_message",
          sourceId: source.memoryEventId,
          occurredAt: contributor.occurredAt,
          content: { text: contributor.body }
        })
      ];
      const manifest: SharedSourceArtifactV1["manifest"] = [
        {
          sourceId: source.memoryEventId,
          sourceTable: "memory_events",
          itemType: "user_message",
          sourceCursor: source.noteRevision,
          revisionHash: candidate.manifest[0]!.revisionHash,
          occurredAt: contributor.occurredAt,
          sourceEventId: source.memoryEventId,
          sourceNodeId: null
        }
      ];
      const deviceProvenance = crossIdentitySyncDigest({
        kind: "personal_note_source_upload",
        source,
        sourceDeploymentProtocolId: input.sourceDeploymentProtocolId,
        deviceCredentialId: input.deviceCredentialId,
        credentialKeyId: identity.credential_key_id,
        upstreamBackendId: identity.upstream_backend_id,
        deviceInstanceId: identity.device_instance_id,
        lineageId: identity.lineage_id,
        credentialVersion: identity.credential_version,
        verifierKind: identity.verifier_kind,
        verifierHash: identity.verifier_hash ?? null,
        publicKeyJwk: identity.public_key_jwk ?? null
      });
      const context: ArtifactPersistenceContext = {
        logicalMemoryId: source.logicalMemoryId,
        remoteReplicaId: null,
        syncRelationshipId: null,
        ownerUserId: actor.userId,
        ownerPrincipalId: logicalOwnerPrincipalId,
        teamId: stringValue(pending.team_id),
        teamWorkspaceId: stringValue(pending.team_workspace_id),
        sourceRevision: source.noteRevision,
        sourceCursor: source.noteRevision,
        packageSequence: 1,
        sourceCapabilities: candidate.sourceCapabilities,
        activationRepresentation: candidate.activationRepresentation,
        mode: candidate.mode,
        fidelityPolicyRevision: representationPolicyRevision,
        fidelityPolicyHash: representationPolicyHash,
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        contentPolicyVersion,
        contentPolicyHash: contentPolicyHashForPreview({
          representation: "memory_events",
          version: contentPolicyVersion
        }),
        classifierVersion,
        classifierHash: classifierHashForPreview({
          representation: "memory_events",
          version: classifierVersion
        }),
        sourceOwnerPolicyId: ownerPolicy.policyId,
        sourceOwnerPolicyVersion: ownerPolicy.version,
        teamPolicyId: teamPolicy.policyId,
        teamPolicyVersion: teamPolicy.version,
        workspacePolicyId: workspacePolicy.policyId,
        workspacePolicyVersion: workspacePolicy.version,
        sourceDeploymentIdentityId: deploymentIdentityId,
        remoteUserIdentityId,
        deviceCredentialId: input.deviceCredentialId,
        deviceProvenanceHash: deviceProvenance
      };
      const artifactBase: Omit<SharedSourceArtifactV1, "artifactHash"> = {
        schemaVersion: SHARED_SOURCE_ARTIFACT_SCHEMA_VERSION,
        artifactId: "",
        logicalMemoryId: source.logicalMemoryId,
        source,
        representation: "memory_events",
        binding: {
          sourceRevision: source.noteRevision,
          sourceHash: candidate.candidateHash,
          representationPolicyRevision,
          representationPolicyHash,
          contentPolicyVersion,
          contentPolicyHash: context.contentPolicyHash,
          classifierVersion,
          classifierHash: context.classifierHash
        },
        policies: {
          sourceOwnerPolicyId: ownerPolicy.policyId,
          sourceOwnerPolicyVersion: ownerPolicy.version,
          teamPolicyId: teamPolicy.policyId,
          teamPolicyVersion: teamPolicy.version,
          workspacePolicyId: workspacePolicy.policyId,
          workspacePolicyVersion: workspacePolicy.version
        },
        manifest,
        manifestHash: crossIdentitySyncDigest(manifest),
        items,
        sourceContentHash: crossIdentitySyncDigest(items)
      };
      const artifactHash = sharedSourceArtifactHash(artifactBase);
      const artifactBody: SharedSourceArtifactV1 = {
        ...artifactBase,
        artifactId: sharedSourceArtifactId(artifactHash),
        artifactHash
      };
      const persisted = await persistArtifactAndPreview(client, actor, {
        context,
        artifactBody,
        previewBody: buildPreviewBody({ artifact: artifactBody })
      });
      return persisted.preview;
    });
  };

  const reviewOrNull = async <T>(work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof SharedMemoryAuthorizationError ||
        error instanceof SharedMemoryConflictError
      ) {
        return null;
      }
      throw error;
    }
  };

  const loadReviewDisplay = async (
    client: SqlClient,
    input: {
      logicalMemoryId: string;
      teamId: string;
      teamWorkspaceId: string;
      ownerPrincipalId: string;
    }
  ): Promise<SharedMemoryReviewSource & SharedMemoryReviewDestination> => {
    const result = await client.query<Row>(
      `select t.name as team_name,tw.name as workspace_name,
              coalesce(nullif(trim(s.metadata->>'threadName'),''),'Captured Session') as source_title
         from logical_memories lm
         join teams t on t.id=$2
         join team_workspaces tw on tw.id=$3 and tw.team_id=t.id
         left join local_captured_session_logical_memories local_memory
           on local_memory.logical_memory_id=lm.id
         left join sessions s on s.id=local_memory.local_session_id
        where lm.id=$1 and lm.owner_principal_id=$4
        limit 1`,
      [
        input.logicalMemoryId,
        input.teamId,
        input.teamWorkspaceId,
        input.ownerPrincipalId
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new SharedMemoryAuthorizationError();
    }
    return {
      logicalMemoryId: input.logicalMemoryId,
      ownerPrincipalId: input.ownerPrincipalId,
      title: stringValue(row.source_title),
      team: { id: input.teamId, name: stringValue(row.team_name) },
      workspace: {
        id: input.teamWorkspaceId,
        name: stringValue(row.workspace_name)
      }
    };
  };

  const loadPreviewCandidatePolicies = async (
    client: pg.PoolClient,
    input: {
      artifact: SharedMemorySourceArtifactRecord;
      logicalMemoryId: string;
      ownerPrincipalId: string;
      teamId: string;
      teamWorkspaceId: string;
      representation: SharedMemoryRepresentation;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
    }
  ): Promise<{
    owner: SharedMemoryPolicyRecord;
    ownerNeedsActivation: boolean;
    currentOwner: Row | null;
    team: SharedMemoryPolicyRecord;
    workspace: SharedMemoryPolicyRecord;
    maximumFidelity: SharedMemoryFidelityCeiling;
    includeCuratedMemory: boolean;
  }> => {
    const currentOwner = await activePolicy(client, {
      table: "source_owner_representation_policies",
      whereSql: "logical_memory_id=$1 and source_owner_principal_id=$2",
      parameters: [input.logicalMemoryId, input.ownerPrincipalId]
    });
    const teamRow = await activePolicy(client, {
      table: "team_representation_policies",
      whereSql: "team_id=$1",
      parameters: [input.teamId]
    });
    const workspaceRow = await activePolicy(client, {
      table: "workspace_representation_policies",
      whereSql: "team_id=$1 and team_workspace_id=$2",
      parameters: [input.teamId, input.teamWorkspaceId]
    });
    if (!teamRow || !workspaceRow) {
      throw new SharedMemoryConflictError(
        "Team and Workspace representation policies are required"
      );
    }
    const currentOwnerId = currentOwner
      ? stringValue(currentOwner.policy_id)
      : null;
    const currentOwnerVersion = currentOwner
      ? numberValue(currentOwner.version)
      : 0;
    const ownerIsCurrent =
      currentOwnerId === input.artifact.sourceOwnerPolicyId &&
      currentOwnerVersion === input.artifact.sourceOwnerPolicyVersion;
    const ownerIsNext = currentOwner
      ? currentOwnerId === input.artifact.sourceOwnerPolicyId &&
        currentOwnerVersion + 1 === input.artifact.sourceOwnerPolicyVersion
      : input.artifact.sourceOwnerPolicyVersion === 1;
    if (!ownerIsCurrent && !ownerIsNext) {
      throw new SharedMemoryConflictError(
        "Preview source-owner policy proposal is stale"
      );
    }
    const owner = ownerIsCurrent
      ? mapPolicy(currentOwner!, "source_owner")
      : proposedSourceOwnerPolicy({
          existing: currentOwner,
          logicalMemoryId: input.logicalMemoryId,
          ownerPrincipalId: input.ownerPrincipalId,
          maximumFidelity: input.maximumFidelity,
          includeCuratedMemory: input.includeCuratedMemory,
          policyId: input.artifact.sourceOwnerPolicyId,
          version: input.artifact.sourceOwnerPolicyVersion
        });
    const team = mapPolicy(teamRow, "team");
    const workspace = mapPolicy(workspaceRow, "workspace");
    const effectiveMaximumFidelity = intersectSharedMemoryFidelityCeilings(
      owner.maximumFidelity,
      team.maximumFidelity,
      workspace.maximumFidelity
    )!;
    const effectiveIncludeCuratedMemory =
      owner.includeCuratedMemory &&
      team.includeCuratedMemory &&
      workspace.includeCuratedMemory;
    if (
      input.artifact.teamPolicyId !== team.policyId ||
      input.artifact.teamPolicyVersion !== team.version ||
      input.artifact.workspacePolicyId !== workspace.policyId ||
      input.artifact.workspacePolicyVersion !== workspace.version ||
      input.artifact.representationPolicyHash !==
        fidelityPolicyHashForPreview({
          representation: input.representation,
          revision: input.artifact.representationPolicyRevision,
          owner,
          team,
          workspace
        }) ||
      !sharedMemoryCeilingAuthorizes(
        effectiveMaximumFidelity,
        input.representation,
        effectiveIncludeCuratedMemory
      ) ||
      input.maximumFidelity !== effectiveMaximumFidelity ||
      input.includeCuratedMemory !== effectiveIncludeCuratedMemory ||
      input.artifact.maximumFidelity !== input.maximumFidelity ||
      input.artifact.includeCuratedMemory !== input.includeCuratedMemory
    ) {
      throw new SharedMemoryConflictError(
        "Preview is outside the proposed exact three-policy intersection"
      );
    }
    return {
      owner,
      ownerNeedsActivation: !ownerIsCurrent,
      currentOwner,
      team,
      workspace,
      maximumFidelity: effectiveMaximumFidelity,
      includeCuratedMemory: effectiveIncludeCuratedMemory
    };
  };

  const loadPreviewReviewContext = async (
    client: pg.PoolClient,
    actor: ActorContext,
    input: {
      logicalMemoryId: string;
      teamId: string;
      teamWorkspaceId: string;
      preview: SharedSourcePreviewReference;
      previewRevision: number;
      maximumFidelity: SharedMemoryFidelityCeiling;
      includeCuratedMemory: boolean;
      expiresAt: string | null;
    }
  ): Promise<SharedMemoryShareReviewRecord> => {
    assertFidelityConsent(input);
    if (input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.now()) {
      throw new SharedMemoryConflictError(
        "Shared Memory review input is no longer valid"
      );
    }
    const loaded = await loadPersistedPreviewByReference(client, {
      preview: input.preview,
      requiredMessage: "Shared Memory preview reference is not active"
    });
    const { preview, artifact, artifactBody } = loaded;
    if (
      !sharedMemoryCeilingAuthorizes(
        input.maximumFidelity,
        preview.representation,
        input.includeCuratedMemory
      )
    ) {
      throw new SharedMemoryConflictError(
        "Preview representation is outside the requested fidelity"
      );
    }
    const owner = await requireSourceOwner(
      client,
      actor,
      input.logicalMemoryId
    );
    if (
      preview.ownerUserId !== actor.userId ||
      preview.ownerPrincipalId !== owner.ownerPrincipalId ||
      preview.logicalMemoryId !== input.logicalMemoryId ||
      preview.teamId !== input.teamId ||
      preview.teamWorkspaceId !== input.teamWorkspaceId ||
      preview.previewRevision !== input.previewRevision
    ) {
      throw new SharedMemoryAuthorizationError(
        "Shared Memory preview ownership or destination binding is invalid"
      );
    }
    await requireWorkspaceSharePermission(
      client,
      actor,
      input.teamId,
      input.teamWorkspaceId
    );
    if (artifact.source?.kind === "captured_session") {
      if (
        !preview.remoteReplicaId ||
        !artifact.syncRelationshipId ||
        !artifactBody.sync
      ) {
        throw new SharedMemoryAuthorizationError(
          "Owner-private remote replica binding is invalid"
        );
      }
      const replicaState = await loadActiveReplicaState(client, {
        logicalMemoryId: input.logicalMemoryId,
        remoteReplicaId: preview.remoteReplicaId,
        ownerUserId: actor.userId,
        ownerPrincipalId: owner.ownerPrincipalId,
        syncRelationshipId: artifact.syncRelationshipId
      });
      if (
        replicaState.sourceCursor < preview.sourceRevision ||
        replicaState.localReplicaId !== preview.remoteReplicaId ||
        artifactBody.sync.relationshipId !== artifact.syncRelationshipId ||
        artifactBody.sync.localReplicaId !== preview.remoteReplicaId ||
        artifactBody.sync.remoteReplicaId !==
          replicaState.remoteSyncReplicaId ||
        artifactBody.sync.localSessionId !== replicaState.localSessionId ||
        artifactBody.sync.sourceDeploymentIdentityId !==
          replicaState.sourceDeploymentIdentityId ||
        artifactBody.sync.remoteUserIdentityId !==
          replicaState.remoteUserIdentityId ||
        artifactBody.sync.deviceCredentialId !==
          replicaState.deviceCredentialId ||
        artifactBody.sync.deviceProvenanceHash !==
          replicaState.deviceProvenanceHash ||
        preview.deviceProvenanceHash !== replicaState.deviceProvenanceHash
      ) {
        throw new SharedMemoryAuthorizationError(
          "Owner-private remote replica binding is invalid"
        );
      }
    } else if (
      artifact.source?.kind !== "personal_note" ||
      preview.remoteReplicaId !== null ||
      artifact.syncRelationshipId !== null ||
      artifactBody.sync !== undefined
    ) {
      throw new SharedMemoryAuthorizationError(
        "Standalone Personal Note binding is invalid"
      );
    }
    const policies = await loadPreviewCandidatePolicies(client, {
      artifact,
      logicalMemoryId: input.logicalMemoryId,
      ownerPrincipalId: owner.ownerPrincipalId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      representation: preview.representation,
      maximumFidelity: input.maximumFidelity,
      includeCuratedMemory: input.includeCuratedMemory
    });
    if (
      preview.binding.fidelityPolicyRevision !==
        artifact.representationPolicyRevision ||
      preview.binding.fidelityPolicyHash !==
        artifact.representationPolicyHash ||
      preview.binding.contentPolicyVersion !== artifact.contentPolicyVersion ||
      preview.binding.contentPolicyHash !== artifact.contentPolicyHash ||
      preview.binding.classifierVersion !== artifact.classifierVersion ||
      preview.binding.classifierHash !== artifact.classifierHash
    ) {
      throw new SharedMemoryConflictError(
        "Preview binding is no longer current"
      );
    }
    const display = await loadReviewDisplay(client, {
      logicalMemoryId: input.logicalMemoryId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      ownerPrincipalId: owner.ownerPrincipalId
    });
    return {
      source: {
        logicalMemoryId: display.logicalMemoryId,
        ownerPrincipalId: display.ownerPrincipalId,
        title: display.title
      },
      team: display.team,
      workspace: display.workspace,
      preview: {
        previewId: preview.previewId,
        previewHash: preview.previewHash,
        previewRevision: preview.previewRevision,
        remoteReplicaId: preview.remoteReplicaId,
        representation: preview.representation,
        sourceRevision: preview.sourceRevision
      },
      maximumFidelity: policies.maximumFidelity,
      includeCuratedMemory: policies.includeCuratedMemory,
      sourceOwnerPolicyWillActivate: policies.ownerNeedsActivation,
      sourceOwnerPolicyWillReplace:
        policies.ownerNeedsActivation && policies.currentOwner !== null
    };
  };

  const activatePreviewSourceOwnerPolicy = async (
    client: pg.PoolClient,
    actor: ActorContext,
    input: SharedMemoryCreateConsentInput,
    preservingGrantId?: string
  ): Promise<void> => {
    assertFidelityConsent(input);
    const loaded = await loadPersistedPreviewByReference(client, {
      preview: input.preview,
      requiredMessage: "Consent preview reference is not active"
    });
    const { preview, artifact } = loaded;
    const owner = await requireSourceOwner(
      client,
      actor,
      preview.logicalMemoryId
    );
    if (input.internalPendingShareId) {
      const pending = await client.query(
        `select 1 from pending_share_operation_records
          where id=$1 and owner_user_id=$2 and logical_memory_id=$3
            and team_id=$4 and team_workspace_id=$5
            and state='preparing' and revoked_at is null
          limit 1`,
        [
          input.internalPendingShareId,
          actor.userId,
          preview.logicalMemoryId,
          preview.teamId,
          preview.teamWorkspaceId
        ]
      );
      if (!pending.rowCount) {
        throw new SharedMemoryAuthorizationError(
          "Pending Share internal authority is invalid"
        );
      }
    } else {
      await requireShareAuthority(client, actor, {
        teamId: preview.teamId,
        teamWorkspaceId: preview.teamWorkspaceId,
        authority: input.authority,
        consume: false,
        delegatedDeviceActionGrant
      });
    }
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `shared-memory-owner-policy:${preview.logicalMemoryId}:${owner.ownerPrincipalId}`
    ]);
    const policies = await loadPreviewCandidatePolicies(client, {
      artifact,
      logicalMemoryId: preview.logicalMemoryId,
      ownerPrincipalId: owner.ownerPrincipalId,
      teamId: preview.teamId,
      teamWorkspaceId: preview.teamWorkspaceId,
      representation: preview.representation,
      maximumFidelity: input.maximumFidelity,
      includeCuratedMemory: input.includeCuratedMemory
    });
    if (!policies.ownerNeedsActivation) return;

    const previousVersion = policies.currentOwner
      ? numberValue(policies.currentOwner.version)
      : 0;
    if (policies.currentOwner) {
      await client.query(
        "update source_owner_representation_policies set superseded_at=now() where id=$1",
        [policies.currentOwner.id]
      );
    }
    const inserted = await client.query<Row>(
      `insert into source_owner_representation_policies (
         policy_id,logical_memory_id,source_owner_principal_id,version,
         maximum_fidelity,include_curated_memory,policy_hash,
         created_by_user_id,effective_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,now())
       returning *`,
      [
        policies.owner.policyId,
        preview.logicalMemoryId,
        owner.ownerPrincipalId,
        policies.owner.version,
        policies.owner.maximumFidelity,
        policies.owner.includeCuratedMemory,
        policies.owner.policyHash,
        actor.userId
      ]
    );
    await appendPolicyAudit(client, {
      actorUserId: actor.userId,
      ownerUserId: actor.userId,
      action: policies.currentOwner
        ? "shared_memory.source_owner_policy.updated"
        : "shared_memory.source_owner_policy.created",
      targetTable: "source_owner_representation_policies",
      targetId: stringValue(inserted.rows[0]?.id),
      mutationId: input.authority.referenceId,
      scope: "source_owner",
      logicalMemoryId: preview.logicalMemoryId,
      policyId: policies.owner.policyId,
      version: policies.owner.version,
      previousVersion,
      maximumFidelity: policies.owner.maximumFidelity,
      includeCuratedMemory: policies.owner.includeCuratedMemory
    });
    if (!policies.currentOwner) return;

    await client.query(
      `update source_owner_representation_consents
          set state='paused', paused_at=now(), updated_at=now(),
              state_reason_code='source_owner_policy_changed'
        where logical_memory_id=$1 and source_owner_principal_id=$2 and state='active'`,
      [preview.logicalMemoryId, owner.ownerPrincipalId]
    );
    await invalidateAffectedGrants(client, {
      mutationId: input.authority.referenceId,
      actorUserId: actor.userId,
      whereSql: preservingGrantId
        ? "g.logical_memory_id=$1 and g.owner_principal_id=$2 and g.id<>$3"
        : "g.logical_memory_id=$1 and g.owner_principal_id=$2",
      parameters: preservingGrantId
        ? [preview.logicalMemoryId, owner.ownerPrincipalId, preservingGrantId]
        : [preview.logicalMemoryId, owner.ownerPrincipalId],
      reasonCode: "source_owner_policy_changed"
    });
  };

  const semanticVectorTable = (dimensions: 384 | 1024 | 1536 | 3072): string =>
    `team_memory_semantic_vectors_${dimensions}`;
  const semanticVectorCast = (
    dimensions: 384 | 1024 | 1536 | 3072
  ): "vector" | "halfvec" => (dimensions === 3072 ? "halfvec" : "vector");

  const hydrateAuthorizedSemanticCandidates = async (
    actor: ActorContext,
    inputs: Array<{
      candidateId: string;
      shareGrantId: string;
      teamWorkspaceId: string;
      representationId: string;
      representation: SharedMemoryRepresentation;
      pseudonymousSourceId: string;
      sourceItemIndex: number;
      sourceRevision: number;
      provenanceHash: string;
      representationPolicyRevision: number;
      contentPolicyVersion: number;
      classifierVersion: number;
      embeddingModel: string;
      embeddingDimensions: number;
      embeddingVersion: string;
      itemType: SharedMemorySourceItemType;
      occurredAt: string | null;
      score: number;
      exactHints?: string[];
    }>
  ): Promise<SharedMemorySemanticCandidate[]> => {
    const grouped = new Map<string, typeof inputs>();
    for (const input of inputs) {
      const key = `${input.shareGrantId}:${input.representationId}`;
      const group = grouped.get(key) ?? [];
      group.push(input);
      grouped.set(key, group);
    }
    const hydratedGroups = await Promise.all(
      [...grouped.values()].map(async (group) => {
        const first = group[0]!;
        const minimumIndex = Math.min(
          ...group.map((candidate) => candidate.sourceItemIndex)
        );
        const maximumIndex = Math.max(
          ...group.map((candidate) => candidate.sourceItemIndex)
        );
        const authorized = await repository.readGrantRepresentation(actor, {
          shareGrantId: first.shareGrantId,
          representation: first.representation,
          page: {
            direction: "newer",
            boundary: minimumIndex,
            limit: maximumIndex - minimumIndex + 1
          }
        });
        if (
          !authorized ||
          authorized.grant.teamWorkspaceId !== first.teamWorkspaceId ||
          authorized.representation.id !== first.representationId ||
          authorized.representation.sourceRevision !== first.sourceRevision
        )
          return [];
        return group.flatMap((input) => {
          const item =
            authorized.items[
              input.sourceItemIndex - authorized.sourcePage.itemOffset
            ];
          if (
            !item ||
            item.sourceId !== input.pseudonymousSourceId ||
            item.itemType !== input.itemType
          )
            return [];
          const text = composeSharedMemorySemanticText(item);
          const exactAnchorMatches = (input.exactHints ?? []).filter((hint) =>
            [text, ...semanticItemAnchors(item)].some((value) =>
              value.includes(hint)
            )
          );
          return [
            {
              source: authorized.grant.source,
              candidateId: input.candidateId,
              shareGrantId: input.shareGrantId,
              sourceArtifactId: authorized.representation.sourceArtifactId,
              sourceRevisionHash: authorized.representation.sourceRevisionHash,
              representationId: input.representationId,
              representation: input.representation,
              pseudonymousSourceId: input.pseudonymousSourceId,
              sourceItemIndex: input.sourceItemIndex,
              sourceRevision: input.sourceRevision,
              provenanceHash: input.provenanceHash,
              representationPolicyRevision: input.representationPolicyRevision,
              contentPolicyVersion: input.contentPolicyVersion,
              classifierVersion: input.classifierVersion,
              embeddingModel: input.embeddingModel,
              embeddingDimensions: input.embeddingDimensions,
              embeddingVersion: input.embeddingVersion,
              itemType: input.itemType,
              occurredAt: input.occurredAt,
              text,
              lexicalAnchors: semanticItemAnchors(item),
              exactAnchorMatches:
                exactAnchorMatches.length > 0 ? exactAnchorMatches : undefined,
              score:
                input.score + Math.min(exactAnchorMatches.length, 4) * 0.25,
              freshness: authorized.freshness
            }
          ];
        });
      })
    );
    return hydratedGroups
      .flat()
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.candidateId.localeCompare(right.candidateId)
      );
  };

  const mapPendingSemanticTarget = (
    row: Row
  ): SharedMemoryPendingSemanticTarget => ({
    ...mapSemanticPreview(row),
    status: "pending",
    shareGrantId: stringValue(row.share_grant_id),
    consentId: stringValue(row.consent_id),
    grantVersion: numberValue(row.grant_version)
  });

  const loadAuthorizedPendingSemanticTarget = async (
    client: pg.PoolClient,
    actor: ActorContext,
    semanticPreviewId: string,
    lock: boolean,
    skipLocked = false
  ): Promise<{
    row: Row;
    target: SharedMemoryPendingSemanticTarget;
  } | null> => {
    const result = await client.query<Row>(
      `select semantic.*,preview.remote_replica_id,
              g.id as share_grant_id,c.id as consent_id,g.grant_version
         from shared_source_semantic_previews semantic
         join shared_source_preview_records preview
           on preview.id=semantic.source_preview_id
          and preview.source_artifact_id=semantic.source_artifact_id
          and preview.preview_revision=semantic.source_preview_revision
          and preview.preview_hash=semantic.source_preview_hash
          and preview.source_revision=semantic.source_revision
          and preview.source_hash=semantic.source_hash
          and preview.logical_memory_id=semantic.logical_memory_id
          and preview.owner_user_id=semantic.owner_user_id
          and preview.owner_principal_id=semantic.owner_principal_id
          and preview.team_id=semantic.team_id
          and preview.team_workspace_id=semantic.team_workspace_id
          and preview.representation=semantic.representation
          and preview.invalidated_at is null
         join shared_source_artifact_records artifact
           on artifact.id=semantic.source_artifact_id
          and artifact.artifact_hash=semantic.source_artifact_hash
          and artifact.manifest_hash=semantic.source_manifest_hash
          and artifact.source_revision=semantic.source_revision
          and artifact.source_hash=semantic.source_hash
          and artifact.logical_memory_id=semantic.logical_memory_id
          and artifact.owner_user_id=semantic.owner_user_id
          and artifact.owner_principal_id=semantic.owner_principal_id
          and artifact.team_id=semantic.team_id
          and artifact.team_workspace_id=semantic.team_workspace_id
          and artifact.representation=semantic.representation
          and artifact.invalidated_at is null
         join team_memory_share_grant_records g
           on g.logical_memory_id=semantic.logical_memory_id
          and g.remote_replica_id is not distinct from preview.remote_replica_id
          and g.owner_user_id=semantic.owner_user_id
          and g.owner_principal_id=semantic.owner_principal_id
          and g.team_id=semantic.team_id
          and g.team_workspace_id=semantic.team_workspace_id
          and g.revoked_at is null
          and (
            g.lifecycle='active'
            or (g.lifecycle='unavailable' and exists (
              select 1 from pending_share_operation_records pending
               where pending.grant_id=g.id
                 and pending.owner_user_id=g.owner_user_id
                 and pending.consent_id=g.consent_id
                 and pending.state='preparing'
                 and pending.stage in ('activating','privacy_filtering')
                 and pending.revoked_at is null
            ))
          )
         join team_memory_share_grants grant_lock
           on grant_lock.id=g.id
         ${semanticPrivacyConsentJoinSql()}
         join users owner
           on owner.id=semantic.owner_user_id
          and owner.disabled_at is null and owner.deleted_at is null
         join teams team
           on team.id=semantic.team_id and team.lifecycle='active'
          and team.entitlement_status in ('active','grace')
         join team_memberships membership
           on membership.team_id=semantic.team_id
          and membership.user_id=semantic.owner_user_id
          and membership.status='enabled' and membership.disabled_at is null
         join team_workspaces workspace
           on workspace.id=semantic.team_workspace_id
          and workspace.team_id=semantic.team_id
          and workspace.lifecycle='active' and workspace.archived_at is null
         join team_workspace_access_grants access
           on access.team_workspace_id=semantic.team_workspace_id
          and access.team_id=semantic.team_id
          and access.user_id=semantic.owner_user_id
          and access.access='write'
          and access.can_share_owned_memory=true
          and access.disabled_at is null
         join source_owner_representation_policies op
           on op.policy_id=g.source_owner_policy_id
          and op.version=g.source_owner_policy_version
          and op.superseded_at is null
         join team_representation_policies tp
           on tp.policy_id=g.team_policy_id and tp.version=g.team_policy_version
          and tp.team_id=g.team_id and tp.superseded_at is null
         join workspace_representation_policies wp
           on wp.policy_id=g.workspace_policy_id
          and wp.version=g.workspace_policy_version
          and wp.team_id=g.team_id
          and wp.team_workspace_id=g.team_workspace_id
          and wp.superseded_at is null
         join privacy_classifier_generations generation
           on generation.id=semantic.classifier_generation_id
          and generation.version=semantic.classifier_version
          and generation.classifier_hash=semantic.classifier_hash
          and generation.status='active' and generation.revoked_at is null
        where semantic.id=$1 and semantic.owner_user_id=$2
          and semantic.status='pending'
          and ${cumulativeRepresentationAuthorizationSql("semantic.representation")}
        limit 1
        ${lock ? `for update of semantic,grant_lock${skipLocked ? " skip locked" : ""}` : ""}`,
      [semanticPreviewId, actor.userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const effectivePolicy = await resolveCurrentPrivacyPolicy(client, {
      ownerUserId: stringValue(row.owner_user_id),
      teamId: stringValue(row.team_id),
      teamWorkspaceId: stringValue(row.team_workspace_id)
    });
    if (
      effectivePolicy.effectivePolicyHash !==
      stringValue(row.effective_privacy_policy_hash)
    ) {
      return null;
    }
    return { row, target: mapPendingSemanticTarget(row) };
  };

  const decryptReadySemanticPreview = async (
    client: pg.PoolClient,
    actor: ActorContext,
    input: {
      sourcePreviewId: string;
      sourcePreviewHash: string;
      sourceArtifactId: string;
      sourceArtifactHash: string;
      sourceManifestHash: string;
      sourceRevision: number;
      sourceHash: string;
      ownerPrincipalId: string;
      logicalMemoryId: string;
      teamId: string;
      teamWorkspaceId: string;
      representation: SharedMemoryRepresentation;
    }
  ): Promise<SharedMemoryReadySemanticDerivative | null> => {
    const activeClassifier = await loadActivePrivacyClassifier(client);
    const effectivePolicy = await resolveCurrentPrivacyPolicy(client, {
      ownerUserId: actor.userId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId
    });
    const result = await client.query<Row>(
      `select * from shared_source_semantic_previews
        where source_preview_id=$1 and source_preview_hash=$2
          and source_artifact_id=$3 and source_artifact_hash=$4
          and source_manifest_hash=$5
          and source_revision=$6 and source_hash=$7
          and owner_user_id=$8 and owner_principal_id=$9
          and logical_memory_id=$10 and team_id=$11 and team_workspace_id=$12
          and representation=$13
          and classifier_generation_id=$14 and classifier_version=$15
          and classifier_hash=$16 and effective_privacy_policy_hash=$17
          and status='ready' and invalidated_at is null
        limit 1
        for share`,
      [
        input.sourcePreviewId,
        input.sourcePreviewHash,
        input.sourceArtifactId,
        input.sourceArtifactHash,
        input.sourceManifestHash,
        input.sourceRevision,
        input.sourceHash,
        actor.userId,
        input.ownerPrincipalId,
        input.logicalMemoryId,
        input.teamId,
        input.teamWorkspaceId,
        input.representation,
        activeClassifier.id,
        activeClassifier.version,
        activeClassifier.classifierHash,
        effectivePolicy.effectivePolicyHash
      ]
    );
    const row = result.rows[0];
    if (!row) return null;
    const record = mapSemanticPreview(row);
    const provider = await options.resolveTeamEncryptionProvider({
      teamId: input.teamId,
      purpose: "decrypt"
    });
    const decrypted =
      await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
        client,
        provider,
        {
          teamId: input.teamId,
          teamWorkspaceId: input.teamWorkspaceId,
          sourceTable: SHARED_MEMORY_SEMANTIC_PREVIEW_SOURCE,
          sourceId: record.id,
          sourceColumn: SHARED_MEMORY_SEMANTIC_PREVIEW_COLUMN
        }
      );
    if (!decrypted || !isPlainObject(decrypted)) {
      throw new SharedMemoryConflictError(
        "Ready sanitized semantic preview payload is unavailable"
      );
    }
    const payload =
      decrypted as unknown as SharedMemorySanitizedSemanticPreviewPayload;
    const validatedItems = Array.isArray(payload.items)
      ? payload.items.map((item) =>
          validateSharedMemoryCanonicalSourceItem({
            representation: input.representation,
            logicalMemoryId: input.logicalMemoryId,
            sourceRevision: input.sourceRevision,
            item
          })
        )
      : [];
    const payloadBindingHash =
      sharedMemorySemanticPreviewPayloadBindingHash(payload);
    if (
      payload.schemaVersion !== SHARED_MEMORY_SEMANTIC_PREVIEW_FORMAT_VERSION ||
      payload.semanticPreviewId !== record.id ||
      payload.sourcePreviewId !== record.sourcePreviewId ||
      payload.sourceArtifactId !== record.sourceArtifactId ||
      payload.sourcePreviewRevision !== record.sourcePreviewRevision ||
      payload.sourcePreviewHash !== record.sourcePreviewHash ||
      payload.sourceArtifactHash !== record.sourceArtifactHash ||
      payload.sourceManifestHash !== record.sourceManifestHash ||
      payload.sourceRevision !== record.sourceRevision ||
      payload.sourceHash !== record.sourceHash ||
      payload.logicalMemoryId !== record.logicalMemoryId ||
      payload.ownerUserId !== record.ownerUserId ||
      payload.ownerPrincipalId !== record.ownerPrincipalId ||
      payload.teamId !== record.teamId ||
      payload.teamWorkspaceId !== record.teamWorkspaceId ||
      payload.representation !== record.representation ||
      payload.expectedManifestHash !== record.expectedManifestHash ||
      payload.expectedChunkCount !== record.expectedChunkCount ||
      payload.resultManifestHash !== record.resultManifestHash ||
      payload.classifierGenerationId !== record.classifierGenerationId ||
      payload.classifierVersion !== record.classifierVersion ||
      payload.classifierHash !== record.classifierHash ||
      payload.effectivePrivacyPolicyHash !==
        record.effectivePrivacyPolicyHash ||
      payload.sourceItemIdentityHash !== record.sourceItemIdentityHash ||
      payload.sourceItemCount !== record.sourceItemCount ||
      payload.sourceItemIdentityHash !==
        sharedMemorySourceItemIdentityHash(validatedItems) ||
      payload.sourceItemCount !== validatedItems.length ||
      !Array.isArray(payload.embeddingSourceBindings) ||
      payload.embeddingSourceBindings.length !== validatedItems.length ||
      payload.embeddingSourceBindings.some(
        (binding, sourceItemIndex) =>
          binding.sourceItemIndex !== sourceItemIndex ||
          binding.sanitizedInputHash !==
            sharedMemoryEmbeddingInputHash(validatedItems[sourceItemIndex]!) ||
          binding.inputUnchanged !==
            (binding.originalInputHash === binding.sanitizedInputHash)
      ) ||
      payload.sanitizedContentHash !== record.sanitizedContentHash ||
      crossIdentitySyncDigest(validatedItems) !== record.sanitizedContentHash ||
      payload.displayTitle !==
        sharedMemorySanitizedDisplayTitle(validatedItems) ||
      payloadBindingHash !== record.payloadBindingHash
    ) {
      throw new SharedMemoryConflictError(
        "Sanitized semantic preview content binding mismatch"
      );
    }
    return {
      record,
      payload: { ...payload, items: validatedItems }
    };
  };

  const invalidateSemanticDerivativeDependentsWithClient = async (
    client: pg.PoolClient,
    rows: readonly Row[],
    reasonCode: string
  ): Promise<void> => {
    if (rows.length === 0) return;
    const semanticPreviewIds = rows.map((row) => stringValue(row.id));
    await client.query(
      `update encrypted_field_payloads
          set invalidated_at=now(),invalidation_reason=$2,updated_at=now()
        where source_table='shared_source_semantic_previews'
          and source_id=any($1::uuid[])
          and source_column='sanitized_preview'
          and invalidated_at is null`,
      [semanticPreviewIds, reasonCode]
    );
    const representations = await client.query<{ id: string }>(
      `update team_memory_representations
          set state='invalidated',invalidated_at=now(),updated_at=now(),
              record_version=record_version+1,
              invalidation_reason_code=$2
        where sanitized_source_preview_id=any($1::uuid[])
          and state in ('pending','available','stale')
        returning id`,
      [semanticPreviewIds, reasonCode]
    );
    if (representations.rows.length > 0) {
      await client.query(
        `delete from team_memory_semantic_items
          where representation_id=any($1::uuid[])`,
        [representations.rows.map((row) => row.id)]
      );
    }
  };

  type PendingShareProcessingOutcome =
    | "activated"
    | "waiting"
    | "failed"
    | "skipped";

  interface PendingShareWorkerExpected {
    state: string;
    operationVersion: number;
  }

  interface LoadedPendingShareProcessingContext {
    pending: Row;
    workerExpected: PendingShareWorkerExpected;
    wantedRevision: number;
    readiness: PendingShareSourceReadinessDecision;
  }

  const loadPendingShareProcessingContext = async (
    pendingShareId: string,
    stallThresholdMs: number
  ): Promise<LoadedPendingShareProcessingContext | null> => {
    const pendingResult = await pool.query<Row>(
      `select p.*,local_memory.local_session_id,lm.latest_source_revision,
                candidate.candidate_manifest,candidate.candidate_manifest_hash,
                candidate.source_memory_event_id as candidate_source_memory_event_id,
                candidate.item_count as candidate_item_count,
                candidate.byte_count as candidate_byte_count,
                candidate.excluded_item_count as candidate_excluded_item_count,
                note_preview.id as note_preview_id,
                note_preview.preview_hash as note_preview_hash,
                mr.id as remote_replica_id,mr.latest_revision,
                sr.target_processing_cursor,sr.state as sync_state
           from pending_share_operation_records p
           join logical_memories lm
             on lm.id=p.logical_memory_id and lm.owner_user_id=p.owner_user_id
           left join local_captured_session_logical_memories local_memory
             on local_memory.logical_memory_id=lm.id
            and local_memory.owner_user_id=p.owner_user_id
           join shared_memory_candidate_preview_records candidate
             on candidate.id=coalesce(p.replacement_preview_id,p.preview_id)
            and candidate.preview_hash=coalesce(p.replacement_preview_hash,p.preview_hash)
            and candidate.source_revision=coalesce(
              p.replacement_source_revision,p.source_revision
            )
           left join memory_replicas mr
             on mr.logical_memory_id=p.logical_memory_id
            and mr.owner_user_id=p.owner_user_id
            and mr.replica_role='target'
            and mr.encryption_scope='owner_private_replica'
            and mr.lifecycle='active' and mr.disabled_at is null
           left join shared_source_artifact_records note_artifact
             on p.source_kind='personal_note'
            and note_artifact.logical_memory_id=p.logical_memory_id
            and note_artifact.owner_user_id=p.owner_user_id
            and note_artifact.team_id=p.team_id
            and note_artifact.team_workspace_id=p.team_workspace_id
            and note_artifact.source_kind='personal_note'
            and note_artifact.source_note_id=p.source_note_id
            and note_artifact.source_memory_event_id=
              candidate.source_memory_event_id
            and note_artifact.source_revision=coalesce(
              p.replacement_source_revision,p.source_revision
            )
            and note_artifact.representation=coalesce(
              p.replacement_representation,p.representation
            )
            and note_artifact.invalidated_at is null
           left join shared_source_preview_records note_preview
             on note_preview.source_artifact_id=note_artifact.id
            and note_preview.invalidated_at is null
           left join cross_identity_sync_relationships sr
             on sr.local_replica_id=mr.id
            and sr.logical_memory_id=p.logical_memory_id
            and sr.side='target' and sr.revoked_at is null
          where p.id=$1 and p.state in ('preparing','needs_attention')
            and p.revoked_at is null
          order by note_preview.created_at desc nulls last,
                   sr.updated_at desc nulls last
          limit 1`,
      [pendingShareId]
    );
    const pending = pendingResult.rows[0];
    if (!pending) {
      await pool.query(
        `update pending_share_outbox
              set state='completed',locked_at=null,updated_at=now()
            where pending_share_id=$1`,
        [pendingShareId]
      );
      return null;
    }
    const workerExpected = {
      state: stringValue(pending.state),
      operationVersion: numberValue(pending.operation_version)
    };
    const wantedRevision = numberValue(
      pending.replacement_source_revision ?? pending.source_revision
    );
    const personalNote = pending.source_kind === "personal_note";
    const notePreviewReady = personalNote && pending.note_preview_id !== null;
    const stalled =
      Date.now() - new Date(pending.last_progress_at as Date).getTime() >=
      stallThresholdMs;
    const readiness: PendingShareSourceReadinessDecision = notePreviewReady
      ? { kind: "ready", remoteReplicaId: null }
      : personalNote
        ? {
            kind: "waiting",
            state: stalled ? "needs_attention" : "preparing",
            stage: "uploading",
            failureCode: stalled ? "source_preparation_stalled" : null,
            visibleTransition:
              workerExpected.state !==
                (stalled ? "needs_attention" : "preparing") ||
              stringValue(pending.stage) !== "uploading" ||
              nullableString(pending.redacted_failure_code) !==
                (stalled ? "source_preparation_stalled" : null)
          }
        : decidePendingShareSourceReadiness(
            {
              wantedRevision,
              targetRevision: nullableNumber(pending.target_processing_cursor),
              replicaRevision: nullableNumber(pending.latest_revision),
              logicalRevision: numberValue(pending.latest_source_revision),
              remoteReplicaId: nullableString(pending.remote_replica_id),
              localSessionId: nullableString(pending.local_session_id),
              lastProgressAtMs: new Date(
                pending.last_progress_at as Date
              ).getTime(),
              currentState: workerExpected.state,
              currentStage: stringValue(pending.stage),
              currentFailureCode: nullableString(pending.redacted_failure_code)
            },
            stallThresholdMs,
            Date.now()
          );
    return {
      pending,
      workerExpected,
      wantedRevision,
      readiness
    };
  };

  const transitionUnreadyPendingShare = async (
    pendingShareId: string,
    context: LoadedPendingShareProcessingContext & {
      readiness: Exclude<
        PendingShareSourceReadinessDecision,
        { kind: "ready" }
      >;
    }
  ): Promise<"failed" | "waiting"> => {
    const { pending, readiness, workerExpected } = context;
    if (readiness.kind === "stale") {
      await withTransaction(pool, async (client) => {
        const failed = await client.query<Row>(
          `update pending_share_operations
              set state='failed',source_update_state='failed',
                  redacted_failure_code='candidate_source_advanced',
                  attempt_count=attempt_count+1,updated_at=now(),
                  operation_version=operation_version+1
            where id=$1 and state=$2 and operation_version=$3
              and revoked_at is null
            returning operation_version`,
          [
            pendingShareId,
            workerExpected.state,
            workerExpected.operationVersion
          ]
        );
        if (!failed.rows[0]) return;
        await client.query(
          `update pending_share_outbox
              set state='failed',locked_at=null,
                  available_at=now()+interval '1 hour',updated_at=now()
            where pending_share_id=$1`,
          [pendingShareId]
        );
        await appendPendingShareOwnerEvent(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "pending_share_lifecycle",
            pendingShareId,
            state: "failed",
            reason: "candidate_source_advanced",
            operationVersion: numberValue(failed.rows[0].operation_version)
          }),
          ownerUserId: stringValue(pending.owner_user_id),
          pendingShareId
        });
      });
      return "failed";
    }

    await withTransaction(pool, async (client) => {
      const updated = await client.query<Row>(
        `update pending_share_operations
            set state=$2,stage=$3,attempt_count=attempt_count+1,
                redacted_failure_code=$4,updated_at=now(),
                operation_version=operation_version+$5
          where id=$1 and state=$6 and operation_version=$7
            and revoked_at is null
          returning operation_version`,
        [
          pendingShareId,
          readiness.state,
          readiness.stage,
          readiness.failureCode,
          readiness.visibleTransition ? 1 : 0,
          workerExpected.state,
          workerExpected.operationVersion
        ]
      );
      if (!updated.rows[0]) return;
      await client.query(
        `update pending_share_outbox
            set state='pending',locked_at=null,
                available_at=now()+interval '5 seconds',updated_at=now()
          where pending_share_id=$1`,
        [pendingShareId]
      );
      if (readiness.visibleTransition) {
        await appendPendingShareOwnerEvent(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "pending_share_lifecycle",
            pendingShareId,
            state: readiness.state,
            stage: readiness.stage,
            reason: readiness.failureCode,
            operationVersion: numberValue(updated.rows[0].operation_version)
          }),
          ownerUserId: stringValue(pending.owner_user_id),
          pendingShareId
        });
      }
    });
    return "waiting";
  };

  const beginPendingShareActivation = async (
    pendingShareId: string,
    pending: Row,
    workerExpected: PendingShareWorkerExpected
  ): Promise<PendingShareWorkerExpected | null> => {
    const activating = await withTransaction(pool, async (client) => {
      const updated = await client.query<Row>(
        `update pending_share_operations
            set state='preparing',stage='activating',
                redacted_failure_code=null,last_progress_at=now(),updated_at=now(),
                operation_version=operation_version+1
           where id=$1 and state=$2 and operation_version=$3
             and revoked_at is null
           returning operation_version`,
        [pendingShareId, workerExpected.state, workerExpected.operationVersion]
      );
      if (!updated.rows[0]) return null;
      const operationVersion = numberValue(updated.rows[0].operation_version);
      await appendPendingShareOwnerEvent(client, {
        mutationId: crossIdentitySyncDeterministicUuid({
          kind: "pending_share_lifecycle",
          pendingShareId,
          state: "preparing",
          stage: "activating",
          operationVersion
        }),
        ownerUserId: stringValue(pending.owner_user_id),
        pendingShareId
      });
      return operationVersion;
    });
    return activating === null
      ? null
      : { state: "preparing", operationVersion: activating };
  };

  type PendingShareStoredAuthority =
    | SharedMemoryAuthorityContext
    | {
        action: typeof SHARED_MEMORY_AUTHORITY;
        source: "continuous_consent";
        referenceId: string;
      };

  interface PendingShareActivationContext {
    pendingShareId: string;
    pending: Row;
    workerExpected: PendingShareWorkerExpected;
    wantedRevision: number;
    replacement: boolean;
    actor: ActorContext;
    authority: PendingShareStoredAuthority;
    source: SharedMemorySourceRef;
    sourceCapabilities: SharedMemoryRepresentation[];
    activationRepresentation: SharedMemoryRepresentation;
    representation: SharedMemoryRepresentation;
    maximumFidelity: SharedMemoryFidelityCeiling;
    includeCuratedMemory: boolean;
    consentId: string;
    mode: SharedMemoryConsentMode;
    remoteReplicaId: string | null;
  }

  const buildPendingShareActivationContext = (input: {
    pendingShareId: string;
    pending: Row;
    workerExpected: PendingShareWorkerExpected;
    wantedRevision: number;
    remoteReplicaId: string | null;
  }): PendingShareActivationContext => ({
    ...input,
    replacement: input.pending.replacement_mutation_id !== null,
    actor: { userId: stringValue(input.pending.owner_user_id) },
    authority: {
      action: SHARED_MEMORY_AUTHORITY,
      source: (input.pending.replacement_authority_source ??
        input.pending
          .authority_source) as PendingShareStoredAuthority["source"],
      referenceId: stringValue(
        input.pending.replacement_authority_reference_id ??
          input.pending.authority_reference_id
      )
    },
    source: requiredSourceRefFromRow({
      ...input.pending,
      source_revision:
        input.pending.replacement_source_revision ??
        input.pending.source_revision,
      source_memory_event_id:
        input.pending.candidate_source_memory_event_id ??
        input.pending.source_memory_event_id
    }),
    sourceCapabilities: representationArrayValue(
      input.pending.source_capabilities
    ),
    activationRepresentation: representationValue(
      input.pending.activation_representation
    ),
    representation: (input.pending.replacement_representation ??
      input.pending.representation) as SharedMemoryRepresentation,
    maximumFidelity: stringValue(
      input.pending.replacement_maximum_fidelity ??
        input.pending.maximum_fidelity
    ) as SharedMemoryFidelityCeiling,
    includeCuratedMemory:
      (input.pending.replacement_include_curated_memory ??
        input.pending.include_curated_memory) === true,
    consentId: stringValue(
      input.pending.replacement_consent_id ?? input.pending.consent_id
    ),
    mode: (input.pending.replacement_mode ??
      input.pending.mode) as SharedMemoryConsentMode
  });

  const isContinuousPersonalNoteAdvancement = (
    context: PendingShareActivationContext
  ): boolean =>
    context.replacement &&
    context.authority.source === "continuous_consent" &&
    context.source.kind === "personal_note" &&
    context.mode === "continuous";

  const createPendingShareAuthoritativePreview = async (
    context: PendingShareActivationContext
  ): Promise<SharedMemoryPersistedPreviewRecord> => {
    const preview =
      context.source.kind === "personal_note"
        ? (
            await withTransaction(pool, (client) =>
              loadPersistedPreviewByReference(client, {
                preview: {
                  previewId: stringValue(context.pending.note_preview_id),
                  previewHash: stringValue(context.pending.note_preview_hash)
                },
                requiredMessage:
                  "Pending Personal Note source preview is not active"
              })
            )
          ).preview
        : await createAuthoritativeSourcePreview(context.actor, {
            logicalMemoryId: stringValue(context.pending.logical_memory_id),
            remoteReplicaId: context.remoteReplicaId!,
            teamId: stringValue(context.pending.team_id),
            teamWorkspaceId: stringValue(context.pending.team_workspace_id),
            representation: context.representation,
            sourceCapabilities: context.sourceCapabilities,
            activationRepresentation: context.activationRepresentation,
            mode: context.mode,
            maximumFidelity: context.maximumFidelity,
            includeCuratedMemory: context.includeCuratedMemory,
            authority: context.authority as SharedMemoryAuthorityContext,
            internalPendingShareId: context.pendingShareId
          });
    if (
      preview.sourceRevision !== context.wantedRevision ||
      crossIdentitySyncDigest(preview.source ?? null) !==
        crossIdentitySyncDigest(context.source) ||
      preview.ownerUserId !== context.actor.userId ||
      preview.teamId !== stringValue(context.pending.team_id) ||
      preview.teamWorkspaceId !==
        stringValue(context.pending.team_workspace_id) ||
      preview.activationRepresentation !== context.activationRepresentation ||
      preview.mode !== context.mode
    ) {
      throw new SharedMemoryConflictError(
        "Pending Share source preview binding changed"
      );
    }
    return preview;
  };

  const validatePendingShareCandidateManifest = async (
    context: PendingShareActivationContext,
    preview: SharedMemoryPersistedPreviewRecord
  ): Promise<boolean> => {
    const acceptedManifest = context.pending.candidate_manifest as Array<{
      sourceId: string;
      revisionHash: string;
    }>;
    const localAuthoritativeSourceIds =
      context.representation === "memory_events"
        ? [
            ...new Set(preview.manifest.map((entry) => entry.sourceEventId))
          ].filter((id): id is string => id !== null)
        : preview.manifest.map((entry) => entry.sourceId);
    const authoritativeSourceIds =
      context.source.kind !== "captured_session" ||
      context.representation === "curated_assertions"
        ? localAuthoritativeSourceIds
        : await withTransaction(pool, async (client) => {
            if (!preview.syncRelationshipId) return [];
            const mappingTable =
              context.representation === "memory_events"
                ? {
                    localColumn: "local_memory_event_id",
                    originColumn: "origin_event_id",
                    table: "sync_event_mappings"
                  }
                : {
                    localColumn: "local_memory_node_id",
                    originColumn: "origin_node_id",
                    table: "sync_summary_node_mappings"
                  };
            const mappings = await client.query<Row>(
              `select ${mappingTable.localColumn} as local_id,
                      ${mappingTable.originColumn} as origin_id
                 from ${mappingTable.table}
                where sync_relationship_id=$1
                  and ${mappingTable.localColumn}=any($2::uuid[])
                  and active=true`,
              [preview.syncRelationshipId, localAuthoritativeSourceIds]
            );
            const originByLocalId = new Map(
              mappings.rows.map((row) => [
                stringValue(row.local_id),
                stringValue(row.origin_id)
              ])
            );
            return localAuthoritativeSourceIds.flatMap((localId) => {
              const originId = originByLocalId.get(localId);
              return originId ? [originId] : [];
            });
          });
    const reproducedManifest =
      context.source.kind === "personal_note"
        ? preview.manifest.map((entry) => ({
            sourceId: entry.sourceEventId ?? entry.sourceId,
            revisionHash: entry.revisionHash
          }))
        : authoritativeSourceIds.map((sourceId) => ({
            sourceId,
            revisionHash: crossIdentitySyncDigest({
              version: 1,
              sourceId,
              representation: context.representation,
              sourceRevision: context.wantedRevision
            })
          }));
    const manifestMatches =
      authoritativeSourceIds.length ===
        numberValue(context.pending.candidate_item_count) &&
      crossIdentitySyncDigest(acceptedManifest) ===
        stringValue(context.pending.candidate_manifest_hash) &&
      crossIdentitySyncDigest(reproducedManifest) ===
        stringValue(context.pending.candidate_manifest_hash);
    if (manifestMatches) return true;

    await withTransaction(pool, async (client) => {
      const failed = await client.query<Row>(
        `update pending_share_operations
              set state='failed',source_update_state='failed',
                  redacted_failure_code='candidate_manifest_changed',
                  updated_at=now(),operation_version=operation_version+1
            where id=$1 and state=$2 and operation_version=$3
              and revoked_at is null
            returning owner_user_id,operation_version`,
        [
          context.pendingShareId,
          context.workerExpected.state,
          context.workerExpected.operationVersion
        ]
      );
      if (!failed.rows[0]) return;
      await client.query(
        `update pending_share_outbox
              set state='failed',locked_at=null,
                  available_at=now()+interval '1 hour',updated_at=now()
            where pending_share_id=$1`,
        [context.pendingShareId]
      );
      await appendPendingShareOwnerEvent(client, {
        mutationId: crossIdentitySyncDeterministicUuid({
          kind: "pending_share_lifecycle",
          pendingShareId: context.pendingShareId,
          state: "failed",
          reason: "candidate_manifest_changed",
          operationVersion: numberValue(failed.rows[0].operation_version)
        }),
        ownerUserId: stringValue(failed.rows[0].owner_user_id),
        pendingShareId: context.pendingShareId
      });
    });
    return false;
  };

  type PendingShareActivationBundle = NonNullable<
    Awaited<ReturnType<SharedMemoryRepository["createShareBundle"]>>
  >;

  const createPendingShareActivationBundle = async (
    context: PendingShareActivationContext,
    preview: SharedMemoryPersistedPreviewRecord
  ): Promise<PendingShareActivationBundle> => {
    const {
      pendingShareId,
      pending,
      replacement,
      actor,
      authority,
      source,
      sourceCapabilities,
      activationRepresentation,
      maximumFidelity,
      includeCuratedMemory,
      consentId,
      mode
    } = context;
    if (
      isContinuousPersonalNoteAdvancement(context) &&
      source.kind === "personal_note"
    ) {
      return withTransaction(pool, async (client) => {
        const grantResult = await client.query<Row>(
          `select grant_row.*,binding.source_kind,binding.source_session_id,
                  binding.source_note_id,binding.source_memory_event_id
             from team_memory_share_grants grant_row
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=grant_row.source_revision_id
            where grant_row.id=$1 and grant_row.owner_user_id=$2 and grant_row.consent_id=$3
              and grant_row.logical_memory_id=$4 and grant_row.team_id=$5
              and grant_row.team_workspace_id=$6 and binding.source_kind='personal_note'
              and binding.source_note_id=$7 and grant_row.mode='continuous'
              and grant_row.source_revision<$8 and grant_row.lifecycle='active'
              and grant_row.revoked_at is null
            for update of grant_row`,
          [
            pending.grant_id,
            actor.userId,
            consentId,
            source.logicalMemoryId,
            pending.team_id,
            pending.team_workspace_id,
            source.noteId,
            source.noteRevision
          ]
        );
        const consentResult = await client.query<Row>(
          `select consent.*,binding.source_kind,binding.source_session_id,
                  binding.source_note_id,binding.source_memory_event_id
             from source_owner_representation_consents consent
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=consent.source_revision_id
            where consent.id=$1 and consent.logical_memory_id=$2 and consent.team_id=$3
              and consent.team_workspace_id=$4 and binding.source_kind='personal_note'
              and binding.source_note_id=$5 and consent.mode='continuous'
              and consent.state='active'
              and consent.maximum_authorized_source_revision is null
              and consent.revoked_at is null
              and (consent.expires_at is null or consent.expires_at>now())
            for update of consent`,
          [
            consentId,
            source.logicalMemoryId,
            pending.team_id,
            pending.team_workspace_id,
            source.noteId
          ]
        );
        if (!grantResult.rows[0] || !consentResult.rows[0]) {
          throw new SharedMemoryAuthorizationError(
            "Continuous Personal Note consent is no longer active"
          );
        }
        return {
          grant: mapGrant(grantResult.rows[0]),
          consent: mapConsent(consentResult.rows[0])
        };
      });
    }
    const bundle = replacement
      ? await repository.changeFidelityBundle(actor, {
          consent: {
            source,
            sourceCapabilities,
            activationRepresentation,
            consentId,
            preview,
            mode,
            maximumFidelity,
            includeCuratedMemory,
            expiresAt: nullableIso(pending.replacement_expires_at),
            authority: authority as SharedMemoryAuthorityContext,
            internalPendingShareId: pendingShareId
          },
          fidelity: {
            mutationId: crossIdentitySyncDeterministicUuid({
              kind: "pending_representation_change",
              pendingShareId,
              replacementMutationId: pending.replacement_mutation_id
            }),
            shareGrantId: stringValue(pending.grant_id),
            consentId,
            maximumFidelity,
            includeCuratedMemory,
            expectedGrantVersion: numberValue(
              pending.replacement_expected_grant_version
            ),
            authority: authority as SharedMemoryAuthorityContext,
            internalPendingShareId: pendingShareId
          },
          expected: {
            logicalMemoryId: stringValue(pending.logical_memory_id),
            teamId: stringValue(pending.team_id),
            teamWorkspaceId: stringValue(pending.team_workspace_id),
            previewId: preview.previewId,
            previewRevision: preview.previewRevision,
            previewHash: preview.previewHash,
            consentId,
            maximumFidelity,
            includeCuratedMemory
          }
        })
      : await repository.createShareBundle(actor, {
          consent: {
            source,
            sourceCapabilities,
            activationRepresentation,
            consentId,
            preview,
            mode,
            maximumFidelity,
            includeCuratedMemory,
            expiresAt: nullableIso(pending.share_expires_at),
            authority: authority as SharedMemoryAuthorityContext,
            internalPendingShareId: pendingShareId
          },
          grant: {
            mutationId: crossIdentitySyncDeterministicUuid({
              kind: "pending_share_grant",
              pendingShareId
            }),
            logicalGrantId: stringValue(pending.logical_grant_id),
            consentId,
            authority: authority as SharedMemoryAuthorityContext,
            internalPendingShareId: pendingShareId
          },
          expected: {
            logicalMemoryId: stringValue(pending.logical_memory_id),
            teamId: stringValue(pending.team_id),
            teamWorkspaceId: stringValue(pending.team_workspace_id),
            previewId: preview.previewId,
            previewRevision: preview.previewRevision,
            previewHash: preview.previewHash,
            consentId,
            maximumFidelity,
            includeCuratedMemory
          }
        });
    if (!bundle) {
      throw new SharedMemoryConflictError(
        "Pending Share binding changed during activation"
      );
    }

    return bundle;
  };

  const stagePendingShareRepresentation = async (
    context: PendingShareActivationContext,
    preview: SharedMemoryPersistedPreviewRecord,
    bundle: PendingShareActivationBundle,
    ensureCompanion: NonNullable<
      Parameters<SharedMemoryRepository["processPendingShares"]>[0]
    >["ensureCompanion"]
  ): Promise<SharedMemoryRepresentationRecord | null> => {
    const { pendingShareId, replacement, actor } = context;
    let stagedRepresentation: SharedMemoryRepresentationRecord | null = null;
    const continuousNoteAdvancement =
      isContinuousPersonalNoteAdvancement(context);
    if (!replacement || continuousNoteAdvancement) {
      stagedRepresentation = await repository.materializeGrantRepresentation(
        actor,
        {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "pending_share_materialization",
            pendingShareId
          }),
          shareGrantId: bundle.grant.id,
          consentId: bundle.consent.id,
          expectedGrantVersion: bundle.grant.grantVersion,
          ...(continuousNoteAdvancement
            ? { internalPendingShareId: pendingShareId }
            : {}),
          preview
        }
      );
      if (
        !continuousNoteAdvancement &&
        ensureCompanion &&
        !(await ensureCompanion({ actor, grant: bundle.grant }))
      ) {
        throw new SharedMemoryConflictError(
          "Pending Share companion discussion is unavailable"
        );
      }
    }

    return stagedRepresentation;
  };

  const publishPendingShareActivation = async (
    context: PendingShareActivationContext,
    bundle: PendingShareActivationBundle,
    stagedRepresentation: SharedMemoryRepresentationRecord | null
  ): Promise<boolean> => {
    const { pendingShareId, actor, representation, mode, workerExpected } =
      context;
    if (isContinuousPersonalNoteAdvancement(context)) {
      const source = context.source;
      if (!stagedRepresentation || source.kind !== "personal_note") {
        throw new SharedMemoryConflictError(
          "Continuous Personal Note advancement was not staged"
        );
      }
      return withTransaction(pool, async (client) => {
        const current = await client.query<Row>(
          `select g.id,g.grant_version,g.source_revision,binding.source_note_id,
                  g.consent_id,g.team_id,g.team_workspace_id,g.logical_memory_id
             from team_memory_share_grants g
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=g.source_revision_id
             join source_owner_representation_consents consent
               on consent.id=g.consent_id and consent.mode='continuous'
              and consent.state='active' and consent.revoked_at is null
              and (consent.expires_at is null or consent.expires_at>now())
             join pending_share_operation_records pending
               on pending.id=$1 and pending.grant_id=g.id
              and pending.replacement_authority_source='continuous_consent'
              and pending.replacement_consent_id=g.consent_id
              and pending.replacement_source_revision=$2
              and pending.state=$3 and pending.operation_version=$4
              and pending.revoked_at is null
            where g.id=$5 and g.owner_user_id=$6 and g.lifecycle='active'
              and binding.source_kind='personal_note' and binding.source_note_id=$7
              and g.source_revision<$2 and g.revoked_at is null
            for update of g,consent,pending`,
          [
            pendingShareId,
            source.noteRevision,
            workerExpected.state,
            workerExpected.operationVersion,
            bundle.grant.id,
            actor.userId,
            source.noteId
          ]
        );
        const grant = current.rows[0];
        if (!grant) return false;
        const published = await client.query<Row>(
          `update team_memory_representations
              set state='available',available_at=coalesce(available_at,now()),
                  stale_at=null,updated_at=now()
            where id=$1 and share_grant_id=$2 and consent_id=$3
              and source_revision=$4 and state='pending'
              and invalidated_at is null
            returning id`,
          [
            stagedRepresentation.id,
            bundle.grant.id,
            bundle.consent.id,
            source.noteRevision
          ]
        );
        if (!published.rows[0]) return false;
        await client.query(
          `with invalidated as (
             update team_memory_representations
                set state='invalidated',invalidated_at=now(),updated_at=now(),
                    record_version=record_version+1,
                    invalidation_reason_code='continuous_source_replaced'
              where share_grant_id=$1 and id<>$2
                and state in ('pending','available','stale')
              returning id
           )
           delete from team_memory_semantic_items
            where representation_id in (select id from invalidated)`,
          [bundle.grant.id, stagedRepresentation.id]
        );
        const advancedGrant = await client.query<Row>(
          `update team_memory_share_grants
              set source_revision=$2,source_revision_id=$3,
                  grant_version=grant_version+1,updated_at=now()
            where id=$1 and grant_version=$4 and source_revision<$2
              and lifecycle='active' and revoked_at is null
            returning *`,
          [
            bundle.grant.id,
            source.noteRevision,
            stagedRepresentation.sourceRevisionId,
            numberValue(grant.grant_version)
          ]
        );
        if (!advancedGrant.rows[0]) {
          throw new SharedMemoryConflictError(
            "Continuous Personal Note Share Grant changed during publication"
          );
        }
        const activated = await client.query<Row>(
          `update pending_share_operations
              set state='activated',stage='complete',
                  workspace_access_state='active',source_update_state='active',
                  activated_at=now(),last_progress_at=now(),
                  redacted_failure_code=null,updated_at=now(),
                  operation_version=operation_version+1
            where id=$1 and state=$2 and operation_version=$3
              and revoked_at is null
            returning operation_version`,
          [
            pendingShareId,
            workerExpected.state,
            workerExpected.operationVersion
          ]
        );
        if (!activated.rows[0]) {
          throw new SharedMemoryConflictError(
            "Continuous Personal Note Pending Share changed during publication"
          );
        }
        await client.query(
          `update pending_share_outbox
              set state='completed',locked_at=null,updated_at=now()
            where pending_share_id=$1`,
          [pendingShareId]
        );
        await appendOutbox(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "continuous_personal_note_representation_published",
            pendingShareId,
            representationId: stagedRepresentation.id
          }),
          family: representationAvailableFamily(representation),
          teamId: bundle.grant.teamId,
          teamWorkspaceId: bundle.grant.teamWorkspaceId,
          shareGrantId: bundle.grant.id,
          logicalMemoryId: bundle.grant.logicalMemoryId,
          resourceType: "team_memory_representation",
          resourceId: stagedRepresentation.id,
          actorPrincipalId: actor.userId
        });
        await appendOutbox(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "continuous_personal_note_grant_advanced",
            pendingShareId,
            shareGrantId: bundle.grant.id,
            sourceRevision: source.noteRevision
          }),
          family: "source_revision_changed",
          teamId: bundle.grant.teamId,
          teamWorkspaceId: bundle.grant.teamWorkspaceId,
          shareGrantId: bundle.grant.id,
          logicalMemoryId: bundle.grant.logicalMemoryId,
          resourceType: "team_memory_share_grant",
          resourceId: bundle.grant.id,
          actorPrincipalId: actor.userId
        });
        await appendPendingShareOwnerEvent(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "continuous_personal_note_pending_activated",
            pendingShareId,
            sourceRevision: source.noteRevision,
            operationVersion: numberValue(activated.rows[0].operation_version)
          }),
          ownerUserId: actor.userId,
          pendingShareId
        });
        return true;
      });
    }
    const published = await withTransaction(pool, async (client) => {
      if (stagedRepresentation) {
        const companion = await client.query<{ id: string }>(
          `select id from collaboration_threads
              where kind='shared_session_discussion' and lifecycle='active'
                and share_grant_id=$1 and team_id=$2
                and team_workspace_id=$3 and shared_logical_memory_id=$4
              limit 1 for update`,
          [
            bundle.grant.id,
            bundle.grant.teamId,
            bundle.grant.teamWorkspaceId,
            bundle.grant.logicalMemoryId
          ]
        );
        if (!companion.rows[0]) return false;
        const representationPublished = await client.query<Row>(
          `update team_memory_representations
                set state=(case when stale_at is null then 'available' else 'stale' end)::memory_representation_state,
                    available_at=coalesce(available_at,now()),updated_at=now()
              where id=$1 and share_grant_id=$2 and consent_id=$3
                and state='pending' and invalidated_at is null
              returning representation,logical_memory_id`,
          [stagedRepresentation.id, bundle.grant.id, bundle.consent.id]
        );
        if (!representationPublished.rows[0]) return false;
        const grantPublished = await client.query<Row>(
          `update team_memory_share_grants
                set lifecycle='active',grant_version=grant_version+1,
                    updated_at=now()
              where id=$1 and consent_id=$2 and lifecycle='unavailable'
                and revoked_at is null
              returning *`,
          [bundle.grant.id, bundle.consent.id]
        );
        if (!grantPublished.rows[0]) return false;
        await appendOutbox(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "pending_share_representation_published",
            pendingShareId,
            representationId: stagedRepresentation.id
          }),
          family: representationAvailableFamily(representation),
          teamId: bundle.grant.teamId,
          teamWorkspaceId: bundle.grant.teamWorkspaceId,
          shareGrantId: bundle.grant.id,
          logicalMemoryId: bundle.grant.logicalMemoryId,
          resourceType: "team_memory_representation",
          resourceId: stagedRepresentation.id,
          actorPrincipalId: actor.userId
        });
        await appendOutbox(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "pending_share_grant_published",
            pendingShareId,
            grantVersion: numberValue(grantPublished.rows[0].grant_version)
          }),
          family: "share_grant_lifecycle",
          teamId: bundle.grant.teamId,
          teamWorkspaceId: bundle.grant.teamWorkspaceId,
          shareGrantId: bundle.grant.id,
          logicalMemoryId: bundle.grant.logicalMemoryId,
          resourceType: "team_memory_share_grant",
          resourceId: bundle.grant.id,
          actorPrincipalId: actor.userId
        });
      }
      const activated = await client.query<Row>(
        `update pending_share_operations
              set state='activated',stage='complete',
                  workspace_access_state='active',source_update_state=$2,
                  grant_id=$3,activated_at=now(),last_progress_at=now(),
                  redacted_failure_code=null,updated_at=now(),
                  operation_version=operation_version+1
            where id=$1 and state=$4 and operation_version=$5
              and revoked_at is null
            returning operation_version`,
        [
          pendingShareId,
          mode === "continuous" ? "active" : "stopped",
          bundle.grant.id,
          workerExpected!.state,
          workerExpected!.operationVersion
        ]
      );
      if (!activated.rows[0]) return false;
      await client.query(
        `update pending_share_outbox
              set state='completed',locked_at=null,updated_at=now()
            where pending_share_id=$1`,
        [pendingShareId]
      );
      await client.query(
        `insert into audit_events
             (actor_user_id,owner_user_id,visibility,action,target_table,target_id,metadata)
           values ($1,$1,'personal','shared_memory.pending_share.activated',
                   'pending_share_operations',$2,$3::jsonb)`,
        [
          actor.userId,
          pendingShareId,
          JSON.stringify({ grantId: bundle.grant.id })
        ]
      );
      await appendPendingShareOwnerEvent(client, {
        mutationId: crossIdentitySyncDeterministicUuid({
          kind: "pending_share_lifecycle",
          pendingShareId,
          state: "activated",
          grantId: bundle.grant.id,
          grantVersion: bundle.grant.grantVersion,
          operationVersion: numberValue(activated.rows[0].operation_version)
        }),
        ownerUserId: actor.userId,
        pendingShareId
      });
      return true;
    });
    return published;
  };

  const transitionPendingShareActivationError = async (
    pendingShareId: string,
    workerExpected: PendingShareWorkerExpected | null,
    error: unknown
  ): Promise<"waiting" | "failed"> => {
    if (error instanceof SharedMemorySemanticDerivativePendingError) {
      await withTransaction(pool, async (client) => {
        const waiting = await client.query<Row>(
          `update pending_share_operations
                set state='preparing',stage='privacy_filtering',
                    source_update_state='preparing',redacted_failure_code=null,
                    last_progress_at=now(),updated_at=now(),
                    operation_version=operation_version+1
              where id=$1 and state=$2 and operation_version=$3
                and revoked_at is null
              returning owner_user_id,operation_version`,
          [
            pendingShareId,
            workerExpected?.state ?? "",
            workerExpected?.operationVersion ?? -1
          ]
        );
        if (!waiting.rows[0]) return;
        await client.query(
          `update pending_share_outbox
                set state='pending',locked_at=null,
                    available_at=coalesce((
                      select min(semantic.next_attempt_at)
                        from shared_source_semantic_previews semantic,
                             pending_share_operations pending
                       where pending.id=$1
                         and semantic.logical_memory_id=pending.logical_memory_id
                         and semantic.owner_user_id=pending.owner_user_id
                         and semantic.team_id=pending.team_id
                         and semantic.team_workspace_id=pending.team_workspace_id
                         and semantic.status='pending'
                         and semantic.next_attempt_at is not null
                    ),now()+interval '5 minutes'),updated_at=now()
              where pending_share_id=$1`,
          [pendingShareId]
        );
        await appendPendingShareOwnerEvent(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "pending_share_lifecycle",
            pendingShareId,
            state: "preparing",
            stage: "privacy_filtering",
            operationVersion: numberValue(waiting.rows[0].operation_version)
          }),
          ownerUserId: stringValue(waiting.rows[0].owner_user_id),
          pendingShareId
        });
      });
      return "waiting";
    }
    await withTransaction(pool, async (client) => {
      const failed = await client.query<Row>(
        `update pending_share_operations
            set state='needs_attention',source_update_state='failed',
                redacted_failure_code='activation_failed',
                attempt_count=attempt_count+1,updated_at=now(),
                operation_version=operation_version+1
          where id=$1 and state=$2 and operation_version=$3
            and revoked_at is null
          returning owner_user_id,operation_version`,
        [
          pendingShareId,
          workerExpected?.state ?? "",
          workerExpected?.operationVersion ?? -1
        ]
      );
      if (!failed.rows[0]) return;
      await client.query(
        `update pending_share_outbox
            set state='completed',locked_at=null,updated_at=now()
          where pending_share_id=$1`,
        [pendingShareId]
      );
      await appendPendingShareOwnerEvent(client, {
        mutationId: crossIdentitySyncDeterministicUuid({
          kind: "pending_share_lifecycle",
          pendingShareId,
          state: "needs_attention",
          reason: "activation_failed",
          operationVersion: numberValue(failed.rows[0].operation_version)
        }),
        ownerUserId: stringValue(failed.rows[0].owner_user_id),
        pendingShareId
      });
    });
    return "failed";
  };

  const processClaimedPendingShare = async (
    pendingShareId: string,
    stallThresholdMs: number,
    ensureCompanion: NonNullable<
      Parameters<SharedMemoryRepository["processPendingShares"]>[0]
    >["ensureCompanion"],
    reportActivationFailure: NonNullable<
      Parameters<SharedMemoryRepository["processPendingShares"]>[0]
    >["reportActivationFailure"]
  ): Promise<PendingShareProcessingOutcome> => {
    let workerExpected: PendingShareWorkerExpected | null = null;
    let failureStage: Parameters<
      NonNullable<
        NonNullable<
          Parameters<SharedMemoryRepository["processPendingShares"]>[0]
        >["reportActivationFailure"]
      >
    >[0]["failureStage"] = "load_context";
    try {
      const loaded = await loadPendingShareProcessingContext(
        pendingShareId,
        stallThresholdMs
      );
      if (!loaded) return "skipped";
      const { pending, wantedRevision, readiness } = loaded;
      workerExpected = loaded.workerExpected;
      if (readiness.kind !== "ready") {
        return transitionUnreadyPendingShare(pendingShareId, {
          ...loaded,
          readiness
        });
      }
      failureStage = "begin_activation";
      const activating = await beginPendingShareActivation(
        pendingShareId,
        pending,
        workerExpected
      );
      if (!activating) return "skipped";
      workerExpected = activating;
      const context = buildPendingShareActivationContext({
        pendingShareId,
        pending,
        workerExpected,
        wantedRevision,
        remoteReplicaId: readiness.remoteReplicaId
      });
      failureStage = "authoritative_preview";
      const preview = await createPendingShareAuthoritativePreview(context);
      failureStage = "candidate_manifest";
      if (!(await validatePendingShareCandidateManifest(context, preview))) {
        return "failed";
      }
      failureStage = "activation_bundle";
      const bundle = await createPendingShareActivationBundle(context, preview);
      failureStage = "representation";
      const stagedRepresentation = await stagePendingShareRepresentation(
        context,
        preview,
        bundle,
        ensureCompanion
      );
      failureStage = "publish";
      return (await publishPendingShareActivation(
        context,
        bundle,
        stagedRepresentation
      ))
        ? "activated"
        : "skipped";
    } catch (error) {
      try {
        reportActivationFailure?.({
          pendingShareId,
          failureStage,
          errorClass: error instanceof Error ? error.name : "UnknownError",
          errorCode:
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string" &&
            /^[A-Z0-9_]{1,80}$/.test(error.code)
              ? error.code
              : null,
          ...(error instanceof SharedMemorySemanticResourceLimitError
            ? {
                resourceLimit: {
                  kind: error.limitKind,
                  observed: error.observed,
                  maximum: error.maximum
                }
              }
            : {})
        });
      } catch {
        // Diagnostics must not change the worker outcome.
      }
      return transitionPendingShareActivationError(
        pendingShareId,
        workerExpected,
        error
      );
    }
  };
  const claimPendingShares = (limit: number): Promise<string[]> =>
    withTransaction(pool, async (client) => {
      const result = await client.query<Row>(
        `with candidates as (
             select o.id
               from pending_share_outbox o
               join pending_share_operation_records p on p.id=o.pending_share_id
              where p.state in ('preparing','needs_attention')
                and p.revoked_at is null
                and (
                  (o.state in ('pending','failed') and o.available_at<=now())
                  or (o.state='processing' and o.locked_at<now()-interval '5 minutes')
                )
              order by o.available_at,o.id
              for update of o skip locked
              limit $1
           )
           update pending_share_outbox o
              set state='processing',locked_at=now(),updated_at=now(),
                  attempt_count=o.attempt_count+1
             from candidates c
            where o.id=c.id
          returning o.pending_share_id`,
        [limit]
      );
      return result.rows.map((row) => stringValue(row.pending_share_id));
    });

  const repairPendingShareCompanions = async (
    limit: number,
    ensureCompanion: NonNullable<
      NonNullable<
        Parameters<SharedMemoryRepository["processPendingShares"]>[0]
      >["ensureCompanion"]
    >
  ): Promise<void> => {
    const repairs = await pool.query<Row>(
      `select g.*,p.id as pending_share_id,
                p.owner_user_id as pending_owner_user_id,
                p.operation_version as pending_operation_version
           from pending_share_operation_records p
           join team_memory_share_grant_records g on g.id=p.grant_id
          where p.state='needs_attention' and p.stage='activating'
            and p.redacted_failure_code='activation_failed'
            and p.revoked_at is null
            and g.lifecycle='unavailable' and g.revoked_at is null
            and exists (
              select 1 from team_memory_representation_records r
               where r.share_grant_id=g.id and r.consent_id=g.consent_id
                 and r.state='pending' and r.invalidated_at is null
            )
            and not exists (
              select 1 from collaboration_threads t
               where t.kind='shared_session_discussion'
                 and t.share_grant_id=g.id
                 and t.team_id=g.team_id
                 and t.team_workspace_id=g.team_workspace_id
                 and t.shared_logical_memory_id=g.logical_memory_id
                 and t.lifecycle='active'
            )
          order by p.updated_at,p.id
          limit $1`,
      [limit]
    );
    for (const row of repairs.rows) {
      const repaired = await ensureCompanion({
        actor: { userId: stringValue(row.pending_owner_user_id) },
        grant: mapGrant(row)
      });
      if (!repaired) continue;
      await withTransaction(pool, async (client) => {
        const pendingShareId = stringValue(row.pending_share_id);
        const resumed = await client.query<Row>(
          `update pending_share_operations
                set state='preparing',source_update_state='preparing',
                    redacted_failure_code=null,next_attempt_at=now(),
                    updated_at=now(),operation_version=operation_version+1
              where id=$1 and state='needs_attention'
                and operation_version=$2 and revoked_at is null
              returning owner_user_id,operation_version`,
          [pendingShareId, numberValue(row.pending_operation_version)]
        );
        if (!resumed.rows[0]) return;
        await client.query(
          `update pending_share_outbox
                set state='pending',available_at=now(),locked_at=null,
                    updated_at=now()
              where pending_share_id=$1`,
          [pendingShareId]
        );
        await appendPendingShareOwnerEvent(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "pending_share_companion_repaired",
            pendingShareId,
            operationVersion: numberValue(resumed.rows[0].operation_version)
          }),
          ownerUserId: stringValue(resumed.rows[0].owner_user_id),
          pendingShareId
        });
      });
    }
  };

  const processPendingShareWorkflow = async (
    input: NonNullable<
      Parameters<SharedMemoryRepository["processPendingShares"]>[0]
    > = {}
  ) => {
    const limit = Math.max(1, Math.min(100, input.limit ?? 10));
    const stallThresholdMs = Math.max(
      60_000,
      input.stallThresholdMs ?? 15 * 60_000
    );
    const claimed = await claimPendingShares(limit);
    const totals = {
      claimed: claimed.length,
      activated: 0,
      waiting: 0,
      failed: 0
    };
    for (const pendingShareId of claimed) {
      const outcome = await processClaimedPendingShare(
        pendingShareId,
        stallThresholdMs,
        input.ensureCompanion,
        input.reportActivationFailure
      );
      if (outcome !== "skipped") totals[outcome] += 1;
    }
    if (input.ensureCompanion) {
      await repairPendingShareCompanions(limit, input.ensureCompanion);
    }
    return totals;
  };

  const repository: SharedMemoryClientScopedRepository = {
    async createSharedMemoryCandidatePreview(actor, input) {
      assertUuid(input.logicalMemoryId, "logicalMemoryId");
      assertUuid(input.teamId, "teamId");
      assertUuid(input.teamWorkspaceId, "teamWorkspaceId");
      assertHash(input.candidateHash, "candidateHash");
      const source = normalizedSourceRef(input.source, input.logicalMemoryId);
      if (!source) {
        throw new SharedMemoryConflictError(
          "Shared Memory candidate source metadata is required"
        );
      }
      if (
        input.manifest.length !== input.itemCount ||
        new Set(input.manifest.map((entry) => entry.sourceId)).size !==
          input.manifest.length
      ) {
        throw new SharedMemoryConflictError(
          "Candidate manifest must exactly match the reviewed item count"
        );
      }
      for (const entry of input.manifest) {
        assertUuid(entry.sourceId, "candidateManifest.sourceId");
        assertHash(entry.revisionHash, "candidateManifest.revisionHash");
      }
      assertEffectiveShareSelection({ ...input, source });
      return withTransaction(pool, async (client) => {
        await requireWorkspaceSharePermission(
          client,
          actor,
          input.teamId,
          input.teamWorkspaceId
        );
        const admittedSourceIdentity = await ensureCandidateSourceIdentity(
          client,
          actor,
          {
            source,
            sourceDeploymentProtocolId: input.sourceDeploymentProtocolId,
            sourceOwnerPrincipalId: input.sourceOwnerPrincipalId,
            deviceCredentialId: input.deviceCredentialId
          }
        );
        const requestHash = crossIdentitySyncDigest({
          version: 2,
          ownerUserId: actor.userId,
          source,
          ...(input.sourceDeploymentProtocolId && input.sourceOwnerPrincipalId
            ? {
                sourceDeploymentProtocolId: input.sourceDeploymentProtocolId,
                sourceOwnerPrincipalId: input.sourceOwnerPrincipalId
              }
            : {}),
          sourceCapabilities: input.sourceCapabilities,
          activationRepresentation: input.activationRepresentation,
          logicalMemoryId: input.logicalMemoryId,
          candidateHash: input.candidateHash,
          sourceRevision: input.sourceRevision,
          itemCount: input.itemCount,
          excludedItemCount: input.excludedItemCount,
          manifest: input.manifest,
          byteCount: input.byteCount,
          teamId: input.teamId,
          teamWorkspaceId: input.teamWorkspaceId,
          maximumFidelity: input.maximumFidelity,
          includeCuratedMemory: input.includeCuratedMemory,
          mode: input.mode,
          expiresAt: input.expiresAt ?? null
        });
        const existing = await client.query<Row>(
          `select * from shared_memory_candidate_preview_records
            where authority_source=$1 and authority_reference_id=$2
              and owner_user_id=$3
            order by created_at desc,id desc`,
          [input.authority.source, input.authority.referenceId, actor.userId]
        );
        const mapCandidate = (
          row: Row
        ): SharedMemoryCandidatePreviewRecord => ({
          previewId: stringValue(row.id),
          previewHash: stringValue(row.preview_hash),
          previewRevision: 1,
          logicalMemoryId: stringValue(row.logical_memory_id),
          source: requiredSourceRefFromRow(row),
          sourceCapabilities: representationArrayValue(row.source_capabilities),
          activationRepresentation: representationValue(
            row.activation_representation
          ),
          teamId: stringValue(row.team_id),
          teamWorkspaceId: stringValue(row.team_workspace_id),
          representation: row.representation as SharedMemoryRepresentation,
          maximumFidelity: stringValue(
            row.maximum_fidelity
          ) as SharedMemoryFidelityCeiling,
          includeCuratedMemory: row.include_curated_memory === true,
          sourceRevision: numberValue(row.source_revision),
          sourceHash: stringValue(row.source_hash),
          redactedContentHash: stringValue(row.redacted_content_hash),
          representationPolicyRevision: numberValue(
            row.representation_policy_revision
          ),
          representationPolicyHash: stringValue(row.representation_policy_hash),
          contentPolicyVersion: numberValue(row.content_policy_version),
          contentPolicyHash: stringValue(row.content_policy_hash),
          classifierVersion: numberValue(row.classifier_version),
          classifierHash: stringValue(row.classifier_hash),
          mode: row.mode as SharedMemoryConsentMode,
          expiresAt: nullableIso(row.share_expires_at),
          previewExpiresAt: iso(row.expires_at),
          itemCount: numberValue(row.item_count),
          excludedItemCount: numberValue(row.excluded_item_count),
          manifest: row.candidate_manifest as Array<{
            sourceId: string;
            revisionHash: string;
          }>,
          manifestHash: stringValue(row.candidate_manifest_hash),
          byteCount: numberValue(row.byte_count),
          createdAt: iso(row.created_at)
        });
        for (const row of existing.rows) {
          const candidate = mapCandidate(row);
          if (
            crossIdentitySyncDigest(candidate.manifest) !==
            candidate.manifestHash
          ) {
            throw new SharedMemoryConflictError(
              "Persisted candidate manifest hash is invalid"
            );
          }
          const existingHash = crossIdentitySyncDigest({
            version: 2,
            ownerUserId: stringValue(row.owner_user_id),
            source: requiredSourceRefFromRow(row),
            ...(input.sourceDeploymentProtocolId && input.sourceOwnerPrincipalId
              ? {
                  sourceDeploymentProtocolId: input.sourceDeploymentProtocolId,
                  sourceOwnerPrincipalId: input.sourceOwnerPrincipalId
                }
              : {}),
            sourceCapabilities: candidate.sourceCapabilities,
            activationRepresentation: candidate.activationRepresentation,
            logicalMemoryId: candidate.logicalMemoryId,
            candidateHash: candidate.sourceHash,
            sourceRevision: candidate.sourceRevision,
            itemCount: candidate.itemCount,
            excludedItemCount: candidate.excludedItemCount,
            manifest: candidate.manifest,
            byteCount: candidate.byteCount,
            teamId: candidate.teamId,
            teamWorkspaceId: candidate.teamWorkspaceId,
            maximumFidelity: candidate.maximumFidelity,
            includeCuratedMemory: candidate.includeCuratedMemory,
            mode: candidate.mode,
            expiresAt: candidate.expiresAt
          });
          if (existingHash === requestHash) {
            return new Date(candidate.previewExpiresAt).getTime() > Date.now()
              ? candidate
              : null;
          }
        }
        if (
          input.authority.source === "device_action_grant" &&
          existing.rows.length > 0
        ) {
          throw new SharedMemoryConflictError(
            "Candidate preview authority reference was reused with different bindings"
          );
        }
        const teamPolicy = await activePolicy(client, {
          table: "team_representation_policies",
          whereSql: "team_id=$1",
          parameters: [input.teamId]
        });
        const workspacePolicy = await activePolicy(client, {
          table: "workspace_representation_policies",
          whereSql: "team_id=$1 and team_workspace_id=$2",
          parameters: [input.teamId, input.teamWorkspaceId]
        });
        if (!teamPolicy || !workspacePolicy) return null;
        const effective = effectiveFidelityConsent(teamPolicy, workspacePolicy);
        if (
          !sharedMemoryCeilingAuthorizes(
            effective.maximumFidelity,
            input.activationRepresentation,
            effective.includeCuratedMemory
          ) ||
          !fidelityConsentDoesNotExpand(input, effective)
        ) {
          return null;
        }
        const representationPolicyRevision = Math.max(
          numberValue(teamPolicy.version),
          numberValue(workspacePolicy.version)
        );
        const representationPolicyHash = crossIdentitySyncDigest({
          kind: "shared_memory_candidate_fidelity_policy",
          representation: input.activationRepresentation,
          revision: representationPolicyRevision,
          team: {
            version: teamPolicy.version,
            hash: teamPolicy.policy_hash
          },
          workspace: {
            version: workspacePolicy.version,
            hash: workspacePolicy.policy_hash
          }
        });
        const contentPolicyVersion = 1;
        const contentPolicyHash = contentPolicyHashForPreview({
          representation: input.activationRepresentation,
          version: contentPolicyVersion
        });
        const classifierVersion = SHARED_MEMORY_CLASSIFIER_VERSION;
        const classifierHash = classifierHashForPreview({
          representation: input.activationRepresentation,
          version: classifierVersion
        });
        const previewId = crossIdentitySyncDeterministicUuid({
          kind: "shared_memory_candidate_preview",
          authorityReferenceId: input.authority.referenceId,
          requestHash
        });
        const createdAt = new Date();
        const previewExpiresAt = new Date(
          createdAt.getTime() + 10 * 60 * 1_000
        );
        const previewHash = crossIdentitySyncDigest({
          requestHash,
          previewId,
          representationPolicyRevision,
          representationPolicyHash,
          contentPolicyVersion,
          contentPolicyHash,
          classifierVersion,
          classifierHash,
          previewExpiresAt: previewExpiresAt.toISOString()
        });
        if (!source) {
          throw new SharedMemoryConflictError(
            "Shared Memory source metadata is required"
          );
        }
        const sourceOwner = await client.query<{ owner_principal_id: string }>(
          `select owner_principal_id
             from logical_memories
            where id=$1 and owner_user_id=$2 and source_kind=$3
              and lifecycle='active' and invalidated_at is null
              and purge_completed_at is null
            limit 1`,
          [source.logicalMemoryId, actor.userId, source.kind]
        );
        if (!sourceOwner.rows[0]) {
          throw new SharedMemoryAuthorizationError(
            "Shared Memory source ownership is unavailable"
          );
        }
        if (
          sourceOwner.rows[0].owner_principal_id !==
          admittedSourceIdentity.ownerPrincipalId
        ) {
          throw new SharedMemoryConflictError(
            "Candidate source principal changed during admission"
          );
        }
        const exactSourceRevision = await ensureLogicalMemorySourceRevision(
          client,
          {
            source,
            ownerPrincipalId: sourceOwner.rows[0].owner_principal_id,
            revision: input.sourceRevision
          }
        );
        const inserted = await client.query<Row>(
          `insert into shared_memory_candidate_previews
             (id,preview_hash,preview_revision,authority_source,authority_reference_id,
              owner_user_id,logical_memory_id,source_revision_id,team_id,team_workspace_id,
              representation,maximum_fidelity,include_curated_memory,mode,source_revision,
              source_hash,redacted_content_hash,item_count,byte_count,
              excluded_item_count,candidate_manifest,candidate_manifest_hash,
              representation_policy_revision,representation_policy_hash,
              content_policy_version,content_policy_hash,classifier_version,
              classifier_hash,share_expires_at,expires_at,created_at,
              source_capabilities,activation_representation)
           values ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,
                   $18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
                   $30,$31)
           returning *`,
          [
            previewId,
            previewHash,
            input.authority.source,
            input.authority.referenceId,
            actor.userId,
            input.logicalMemoryId,
            exactSourceRevision.id,
            input.teamId,
            input.teamWorkspaceId,
            input.activationRepresentation,
            input.maximumFidelity,
            input.includeCuratedMemory,
            input.mode,
            input.sourceRevision,
            input.candidateHash,
            input.itemCount,
            input.byteCount,
            input.excludedItemCount,
            JSON.stringify(input.manifest),
            crossIdentitySyncDigest(input.manifest),
            representationPolicyRevision,
            representationPolicyHash,
            contentPolicyVersion,
            contentPolicyHash,
            classifierVersion,
            classifierHash,
            input.expiresAt ?? null,
            previewExpiresAt,
            createdAt,
            input.sourceCapabilities,
            input.activationRepresentation
          ]
        );
        return inserted.rows[0]
          ? mapCandidate({
              ...inserted.rows[0],
              source_kind: source.kind,
              source_session_id:
                source.kind === "captured_session" ? source.sessionId : null,
              source_note_id:
                source.kind === "personal_note" ? source.noteId : null,
              source_memory_event_id:
                source.kind === "personal_note" ? source.memoryEventId : null
            })
          : null;
      });
    },
    async createPendingShare(actor, input) {
      const sourceRef = normalizedSourceRef(
        input.source,
        input.logicalMemoryId
      );
      if (!sourceRef) {
        throw new SharedMemoryConflictError(
          "Pending Share source metadata is required"
        );
      }
      assertEffectiveShareSelection({ ...input, source: sourceRef });
      const requestHash = crossIdentitySyncDigest({
        version: 2,
        ownerUserId: actor.userId,
        source: sourceRef,
        sourceCapabilities: input.sourceCapabilities,
        activationRepresentation: input.activationRepresentation,
        mutationId: input.mutationId,
        logicalGrantId: input.logicalGrantId,
        consentId: input.consentId,
        logicalMemoryId: input.logicalMemoryId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        preview: input.preview,
        previewRevision: input.previewRevision,
        mode: input.mode,
        maximumFidelity: input.maximumFidelity,
        includeCuratedMemory: input.includeCuratedMemory,
        expiresAt: input.expiresAt ?? null
      });
      return withTransaction(pool, async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1,0))",
          [`pending-share:${input.mutationId}`]
        );
        const existing = await client.query<Row>(
          `select pending.*,grant_row.grant_version
             from pending_share_operation_records pending
             left join team_memory_share_grants grant_row
               on grant_row.id=pending.grant_id
            where pending.mutation_id=$1 limit 1`,
          [input.mutationId]
        );
        if (existing.rows[0]) {
          if (
            stringValue(existing.rows[0].request_hash) !== requestHash ||
            stringValue(existing.rows[0].authority_source) !==
              input.authority.source ||
            stringValue(existing.rows[0].authority_reference_id) !==
              input.authority.referenceId
          ) {
            throw new SharedMemoryConflictError(
              "Pending Share mutation was reused with different bindings"
            );
          }
          return mapPendingShare(existing.rows[0]);
        }
        await requireWorkspaceSharePermission(
          client,
          actor,
          input.teamId,
          input.teamWorkspaceId
        );
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1,0))",
          [
            `pending-share-destination:${actor.userId}:${input.logicalMemoryId}:${input.teamId}:${input.teamWorkspaceId}`
          ]
        );
        const inFlight = await client.query<{ id: string }>(
          `select id from pending_share_operations
            where owner_user_id=$1 and logical_memory_id=$2
              and team_id=$3 and team_workspace_id=$4
              and state in ('preparing','needs_attention')
              and revoked_at is null
            order by created_at desc,id desc
            limit 1 for update`,
          [
            actor.userId,
            input.logicalMemoryId,
            input.teamId,
            input.teamWorkspaceId
          ]
        );
        if (inFlight.rows[0]) {
          throw new SharedMemoryConflictError(
            "A Pending Share is already in progress for this destination"
          );
        }
        const preview = await client.query<Row>(
          `select candidate.*,binding.source_kind,binding.source_session_id,
                  binding.source_note_id,binding.source_memory_event_id
             from shared_memory_candidate_previews candidate
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=candidate.source_revision_id
            where candidate.id=$1 and candidate.preview_hash=$2
              and candidate.preview_revision=$3
              and candidate.owner_user_id=$4 and candidate.logical_memory_id=$5
              and candidate.team_id=$6 and candidate.team_workspace_id=$7
              and candidate.maximum_fidelity=$8
              and candidate.include_curated_memory=$9
              and candidate.mode=$10
              and candidate.share_expires_at is not distinct from $11::timestamptz
              and candidate.authority_source=$12
              and candidate.invalidated_at is null and candidate.expires_at>now()
            for update of candidate`,
          [
            input.preview.previewId,
            input.preview.previewHash,
            input.previewRevision,
            actor.userId,
            input.logicalMemoryId,
            input.teamId,
            input.teamWorkspaceId,
            input.maximumFidelity,
            input.includeCuratedMemory,
            input.mode,
            input.expiresAt ?? null,
            input.authority.source
          ]
        );
        const source = preview.rows[0];
        if (!source) {
          throw new SharedMemoryConflictError(
            "Pending Share preview is missing, expired, or changed"
          );
        }
        const previewSource = sourceRefFromRow(source);
        if (
          crossIdentitySyncDigest(previewSource ?? null) !==
          crossIdentitySyncDigest(sourceRef ?? null)
        ) {
          throw new SharedMemoryConflictError(
            "Pending Share source does not match the reviewed preview"
          );
        }
        const representation = representationValue(source.representation);
        if (
          !sharedMemoryCeilingAuthorizes(
            input.maximumFidelity,
            representation,
            input.includeCuratedMemory
          )
        ) {
          throw new SharedMemoryConflictError(
            "Pending Share representation is outside consent"
          );
        }
        const pendingId = crossIdentitySyncDeterministicUuid({
          kind: "pending_share",
          mutationId: input.mutationId
        });
        const inserted = await client.query<Row>(
          `insert into pending_share_operations
              (id,mutation_id,request_hash,logical_grant_id,consent_id,
              authority_source,authority_reference_id,
              preview_id,preview_hash,preview_revision,owner_user_id,
              display_title,
              logical_memory_id,source_revision_id,team_id,team_workspace_id,representation,
              maximum_fidelity,include_curated_memory,mode,source_revision,source_hash,
              share_expires_at,source_capabilities,activation_representation)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
           returning *`,
          [
            pendingId,
            input.mutationId,
            requestHash,
            input.logicalGrantId,
            input.consentId,
            input.authority.source,
            input.authority.referenceId,
            input.preview.previewId,
            input.preview.previewHash,
            input.previewRevision,
            actor.userId,
            null,
            input.logicalMemoryId,
            source.source_revision_id,
            input.teamId,
            input.teamWorkspaceId,
            representation,
            input.maximumFidelity,
            input.includeCuratedMemory,
            input.mode,
            source.source_revision,
            source.source_hash,
            input.expiresAt ?? null,
            input.sourceCapabilities,
            input.activationRepresentation
          ]
        );
        if (!inserted.rows[0]) {
          throw new SharedMemoryConflictError(
            "Pending Share could not be persisted"
          );
        }
        await client.query(
          `insert into pending_share_outbox (pending_share_id)
           values ($1) on conflict (pending_share_id) do nothing`,
          [pendingId]
        );
        await client.query(
          `insert into audit_events
             (actor_user_id,owner_user_id,visibility,action,target_table,target_id,metadata)
           values ($1,$1,'personal','shared_memory.pending_share.accepted',
                   'pending_share_operations',$2,$3::jsonb)`,
          [
            actor.userId,
            pendingId,
            JSON.stringify({
              mutationId: input.mutationId,
              teamId: input.teamId,
              teamWorkspaceId: input.teamWorkspaceId,
              logicalMemoryId: input.logicalMemoryId,
              source: sourceRef,
              sourceCapabilities: input.sourceCapabilities,
              activationRepresentation: input.activationRepresentation,
              representation,
              maximumFidelity: input.maximumFidelity,
              includeCuratedMemory: input.includeCuratedMemory,
              mode: input.mode
            })
          ]
        );
        await appendPendingShareOwnerEvent(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "pending_share_lifecycle",
            pendingShareId: pendingId,
            operationVersion: 1
          }),
          ownerUserId: actor.userId,
          pendingShareId: pendingId
        });
        return mapPendingShare({
          ...inserted.rows[0],
          source_kind: previewSource?.kind,
          source_session_id:
            previewSource?.kind === "captured_session"
              ? previewSource.sessionId
              : null,
          source_note_id:
            previewSource?.kind === "personal_note"
              ? previewSource.noteId
              : null,
          source_memory_event_id:
            previewSource?.kind === "personal_note"
              ? previewSource.memoryEventId
              : null
        });
      });
    },
    async createPendingFidelityChange(actor, input) {
      assertFidelityConsent(input);
      const source = normalizedSourceRef(input.source, input.logicalMemoryId);
      if (!source) {
        throw new SharedMemoryConflictError(
          "Fidelity replacement source metadata is required"
        );
      }
      assertEffectiveShareSelection({ ...input, source });
      const requestHash = crossIdentitySyncDigest({
        version: 2,
        ...input,
        authority: input.authority
      });
      return withTransaction(pool, async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1,0))",
          [`pending-fidelity-change:${input.mutationId}`]
        );
        const replay = await client.query<Row>(
          `select p.*,grant_row.grant_version,
                  preview.source_kind as effective_source_kind,
                  preview.source_session_id as effective_source_session_id,
                  preview.source_note_id as effective_source_note_id,
                  preview.source_memory_event_id as effective_source_memory_event_id,
                  preview.source_revision as effective_source_revision
             from pending_share_operations p
             left join team_memory_share_grants grant_row
               on grant_row.id=p.grant_id
             join shared_memory_candidate_preview_records preview
               on preview.id=coalesce(p.replacement_preview_id,p.preview_id)
            where p.replacement_mutation_id=$1 limit 1`,
          [input.mutationId]
        );
        if (replay.rows[0]) {
          if (
            stringValue(replay.rows[0].replacement_request_hash) !== requestHash
          ) {
            throw new SharedMemoryConflictError(
              "Fidelity-change mutation was reused with different bindings"
            );
          }
          return mapPendingShare(replay.rows[0]);
        }
        const grantResult = await client.query<Row>(
          `select grant_row.*,binding.source_kind,binding.source_session_id,
                  binding.source_note_id,binding.source_memory_event_id
             from team_memory_share_grants grant_row
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=grant_row.source_revision_id
            where grant_row.id=$1 and grant_row.owner_user_id=$2
              and grant_row.logical_memory_id=$3 and grant_row.team_id=$4
              and grant_row.team_workspace_id=$5 and grant_row.lifecycle='active'
            for update of grant_row`,
          [
            input.shareGrantId,
            actor.userId,
            input.logicalMemoryId,
            input.teamId,
            input.teamWorkspaceId
          ]
        );
        const grant = grantResult.rows[0];
        if (!grant) {
          throw new SharedMemoryAuthorizationError(
            "Only the active Share Grant owner may replace its representation"
          );
        }
        if (
          !sharedMemorySourceCanReplace(
            requiredSourceRefFromRow(grant),
            source
          ) ||
          crossIdentitySyncDigest(
            representationArrayValue(grant.source_capabilities)
          ) !== crossIdentitySyncDigest(input.sourceCapabilities)
        ) {
          throw new SharedMemoryAuthorizationError(
            "Fidelity replacement source binding is invalid"
          );
        }
        if (numberValue(grant.grant_version) !== input.expectedGrantVersion) {
          throw new SharedMemoryConflictError();
        }
        const internalContinuousAuthority =
          (input.authority as { source: string }).source ===
          "continuous_consent";
        if (internalContinuousAuthority) {
          if (!input.deviceCredentialId) {
            throw new SharedMemoryAuthorizationError(
              "Continuous source advancement requires device authority"
            );
          }
          const continuousAuthority = await client.query<Row>(
            `select credential.id
               from device_credentials credential
               join users owner_row
                 on owner_row.id=credential.owner_user_id
                and owner_row.disabled_at is null
                and owner_row.deleted_at is null
               join teams team_row
                 on team_row.id=$3 and team_row.lifecycle='active'
                and team_row.entitlement_status in ('active','grace')
               join team_memberships membership
                 on membership.team_id=team_row.id
                and membership.user_id=credential.owner_user_id
                and membership.status='enabled'
                and membership.disabled_at is null
               join team_workspaces workspace_row
                 on workspace_row.id=$4 and workspace_row.team_id=team_row.id
                and workspace_row.lifecycle='active'
                and workspace_row.archived_at is null
               join team_workspace_access_grants workspace_access
                 on workspace_access.team_id=team_row.id
                and workspace_access.team_workspace_id=workspace_row.id
                and workspace_access.user_id=credential.owner_user_id
                and workspace_access.access='write'
                and workspace_access.can_share_owned_memory=true
                and workspace_access.disabled_at is null
              where credential.id=$1 and credential.owner_user_id=$2
                and credential.revoked_at is null
                and (credential.expires_at is null or credential.expires_at>now())
                and 'share_grant_management'=any(credential.operation_families)
              for update of credential,owner_row,team_row,membership,
                            workspace_row,workspace_access`,
            [
              input.deviceCredentialId,
              actor.userId,
              input.teamId,
              input.teamWorkspaceId
            ]
          );
          if (!continuousAuthority.rows[0]) {
            throw new SharedMemoryAuthorizationError(
              "Continuous source advancement authority is unavailable"
            );
          }
          const continuousConsent = await client.query<Row>(
            `select id from source_owner_representation_consents
              where id=$1 and id=$2 and logical_memory_id=$3
                and source_owner_principal_id=$4 and team_id=$5
                and team_workspace_id=$6 and mode='continuous'
                and state='active' and revoked_at is null
                and (expires_at is null or expires_at>now())
              for update`,
            [
              input.authority.referenceId,
              grant.consent_id,
              grant.logical_memory_id,
              grant.owner_principal_id,
              grant.team_id,
              grant.team_workspace_id
            ]
          );
          if (!continuousConsent.rows[0]) {
            throw new SharedMemoryAuthorizationError(
              "Active continuous consent is required for source advancement"
            );
          }
        } else {
          await requireShareAuthority(client, actor, {
            teamId: input.teamId,
            teamWorkspaceId: input.teamWorkspaceId,
            authority: input.authority,
            consume: true,
            delegatedDeviceActionGrant
          });
        }
        const previewResult = await client.query<Row>(
          `select preview.*,binding.source_kind,binding.source_session_id,
                  binding.source_note_id,binding.source_memory_event_id
             from shared_memory_candidate_previews preview
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=preview.source_revision_id
            where preview.id=$1 and preview.preview_hash=$2
              and preview.preview_revision=$3 and preview.owner_user_id=$4
              and preview.logical_memory_id=$5 and preview.team_id=$6
              and preview.team_workspace_id=$7 and preview.maximum_fidelity=$8
              and preview.include_curated_memory=$9 and preview.mode=$10
              and preview.share_expires_at is not distinct from $11::timestamptz
              and preview.authority_source=$12
              and preview.invalidated_at is null and preview.expires_at>now()
            for update of preview`,
          [
            input.preview.previewId,
            input.preview.previewHash,
            input.previewRevision,
            actor.userId,
            input.logicalMemoryId,
            input.teamId,
            input.teamWorkspaceId,
            input.maximumFidelity,
            input.includeCuratedMemory,
            input.mode,
            input.expiresAt ?? null,
            input.authority.source
          ]
        );
        const preview = previewResult.rows[0];
        if (!preview) {
          throw new SharedMemoryConflictError(
            "Replacement preview is missing, expired, or changed"
          );
        }
        if (
          crossIdentitySyncDigest(requiredSourceRefFromRow(preview)) !==
            crossIdentitySyncDigest(source) ||
          crossIdentitySyncDigest(
            representationArrayValue(preview.source_capabilities)
          ) !== crossIdentitySyncDigest(input.sourceCapabilities) ||
          representationValue(preview.activation_representation) !==
            input.activationRepresentation
        ) {
          throw new SharedMemoryConflictError(
            "Replacement preview source binding changed"
          );
        }
        const representation = representationValue(preview.representation);
        if (
          !sharedMemoryCeilingAuthorizes(
            input.maximumFidelity,
            representation,
            input.includeCuratedMemory
          )
        ) {
          throw new SharedMemoryConflictError(
            "Replacement representation is outside consent"
          );
        }
        const pendingResult = await client.query<Row>(
          `update pending_share_operations
              set replacement_mutation_id=$2,replacement_request_hash=$3,
                  replacement_consent_id=$4,replacement_authority_source=$5,
                  replacement_authority_reference_id=$6,
                  replacement_preview_id=$7,replacement_preview_hash=$8,
                  replacement_preview_revision=$9,replacement_representation=$10,
                  replacement_maximum_fidelity=$11,
                  replacement_include_curated_memory=$12,
                  replacement_mode=$13,replacement_source_revision=$14,
                  replacement_source_revision_id=$20,
                  replacement_source_hash=$15,replacement_expires_at=$16,
                  replacement_expected_grant_version=$17,
                  state='preparing',stage='accepted',workspace_access_state='active',
                  source_update_state='preparing',redacted_failure_code=null,
                  last_progress_at=now(),next_attempt_at=now(),updated_at=now(),
                  operation_version=operation_version+1
            where grant_id=$1 and owner_user_id=$18
              and (
                ($19::boolean=false and state='activated')
                or ($19::boolean=true and state in ('activated','preparing','needs_attention')
                  and coalesce(replacement_source_revision,source_revision)<$14)
              )
          returning *`,
          [
            input.shareGrantId,
            input.mutationId,
            requestHash,
            input.consentId,
            input.authority.source,
            input.authority.referenceId,
            input.preview.previewId,
            input.preview.previewHash,
            input.previewRevision,
            representation,
            input.maximumFidelity,
            input.includeCuratedMemory,
            input.mode,
            preview.source_revision,
            preview.source_hash,
            input.expiresAt ?? null,
            input.expectedGrantVersion,
            actor.userId,
            internalContinuousAuthority,
            preview.source_revision_id
          ]
        );
        const pending = pendingResult.rows[0];
        if (!pending) {
          throw new SharedMemoryConflictError(
            "The active share has no durable operation to replace"
          );
        }
        await client.query(
          `update pending_share_outbox
              set state='pending',available_at=now(),locked_at=null,updated_at=now()
            where pending_share_id=$1`,
          [pending.id]
        );
        await client.query(
          `insert into audit_events
             (actor_user_id,owner_user_id,visibility,action,target_table,target_id,metadata)
           values ($1,$1,'personal',$4,
                   'pending_share_operations',$2,$3::jsonb)`,
          [
            actor.userId,
            pending.id,
            JSON.stringify({
              mutationId: input.mutationId,
              shareGrantId: input.shareGrantId,
              expectedGrantVersion: input.expectedGrantVersion,
              representation
            }),
            input.maximumFidelity === stringValue(grant.maximum_fidelity) &&
            input.includeCuratedMemory === Boolean(grant.include_curated_memory)
              ? "shared_memory.source_revision_change.accepted"
              : "shared_memory.fidelity_change.accepted"
          ]
        );
        await appendPendingShareOwnerEvent(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "pending_share_replacement_lifecycle",
            pendingShareId: stringValue(pending.id),
            replacementMutationId: input.mutationId,
            state: "preparing",
            operationVersion: numberValue(pending.operation_version)
          }),
          ownerUserId: actor.userId,
          pendingShareId: stringValue(pending.id)
        });
        return mapPendingShare({
          ...pending,
          grant_version: grant.grant_version,
          effective_source_kind: preview.source_kind,
          effective_source_session_id: preview.source_session_id,
          effective_source_note_id: preview.source_note_id,
          effective_source_memory_event_id: preview.source_memory_event_id,
          effective_source_revision: preview.source_revision
        });
      });
    },
    async advanceContinuousPersonalNoteRevision(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      assertUuid(input.deviceCredentialId, "deviceCredentialId");
      assertUuid(
        input.sourceDeploymentProtocolId,
        "sourceDeploymentProtocolId"
      );
      assertUuid(input.sourceOwnerPrincipalId, "sourceOwnerPrincipalId");
      if (input.afterShareGrantId) {
        assertUuid(input.afterShareGrantId, "afterShareGrantId");
      }
      const candidate = input.candidate;
      const source = sharedMemorySourceRefSchema.parse(candidate.source);
      if (
        source.kind !== "personal_note" ||
        candidate.mode !== "continuous" ||
        candidate.logicalMemoryId !== source.logicalMemoryId ||
        candidate.sourceRevision !== source.noteRevision ||
        candidate.sourceCapabilities.length !== 1 ||
        candidate.sourceCapabilities[0] !== "memory_events" ||
        candidate.activationRepresentation !== "memory_events" ||
        candidate.itemCount !== 1 ||
        candidate.excludedItemCount !== 0 ||
        candidate.items.length !== 1 ||
        candidate.items[0]?.id !== source.memoryEventId ||
        candidate.manifest.length !== 1 ||
        candidate.manifest[0]?.sourceId !== source.memoryEventId
      ) {
        throw new SharedMemoryConflictError(
          "Continuous Personal Note advancement requires one exact newer revision"
        );
      }
      const authorization = await pool.query<Row>(
        `select g.id as grant_id,g.grant_version,g.team_id,
                g.team_workspace_id,g.consent_id
           from team_memory_share_grant_records g
           join source_owner_representation_consent_records consent
             on consent.id=g.consent_id
            and consent.mode='continuous' and consent.state='active'
            and consent.revoked_at is null
            and (consent.expires_at is null or consent.expires_at>now())
           join device_credentials credential
             on credential.id=$5 and credential.owner_user_id=g.owner_user_id
            and credential.revoked_at is null
            and (credential.expires_at is null or credential.expires_at>now())
            and 'share_grant_management'=any(credential.operation_families)
          where g.owner_user_id=$1 and g.logical_memory_id=$2
            and g.source_kind='personal_note' and g.source_note_id=$3
            and g.source_revision<$4 and g.mode='continuous'
            and g.lifecycle='active' and g.revoked_at is null
            and ($6::uuid is null or g.id>$6::uuid)
          order by g.id
          limit $7`,
        [
          actor.userId,
          source.logicalMemoryId,
          source.noteId,
          source.noteRevision,
          input.deviceCredentialId,
          input.afterShareGrantId ?? null,
          101
        ]
      );
      const pageRows = authorization.rows.slice(0, 100);
      const pendingShares: PendingShareRecord[] = [];
      const outcomes: ContinuousPersonalNoteAdvancementOutcome[] = [];
      for (const row of pageRows) {
        const shareGrantId = stringValue(row.grant_id);
        const consentId = stringValue(row.consent_id);
        const authority = {
          action: SHARED_MEMORY_AUTHORITY,
          source: "continuous_consent",
          referenceId: consentId
        } as unknown as SharedMemoryAuthorityContext;
        try {
          const preview = await repository.createSharedMemoryCandidatePreview(
            actor,
            {
              logicalMemoryId: source.logicalMemoryId,
              source,
              sourceDeploymentProtocolId: input.sourceDeploymentProtocolId,
              sourceOwnerPrincipalId: input.sourceOwnerPrincipalId,
              deviceCredentialId: input.deviceCredentialId,
              sourceCapabilities: ["memory_events"],
              activationRepresentation: "memory_events",
              candidateHash: candidate.candidateHash,
              sourceRevision: source.noteRevision,
              itemCount: 1,
              excludedItemCount: 0,
              manifest: candidate.manifest,
              byteCount: candidate.byteCount,
              teamId: stringValue(row.team_id),
              teamWorkspaceId: stringValue(row.team_workspace_id),
              mode: "continuous",
              maximumFidelity: "memory_events",
              includeCuratedMemory: false,
              expiresAt: null,
              authority
            }
          );
          if (!preview) {
            outcomes.push({
              shareGrantId,
              status: "rejected",
              reasonCode: "destination_unavailable"
            });
            continue;
          }
          const pendingShare = await repository.createPendingFidelityChange(
            actor,
            {
              source,
              sourceCapabilities: ["memory_events"],
              activationRepresentation: "memory_events",
              mutationId: crossIdentitySyncDeterministicUuid({
                kind: "continuous_personal_note_revision",
                mutationId: input.mutationId,
                shareGrantId,
                sourceRevision: source.noteRevision,
                sourceHash: candidate.candidateHash
              }),
              consentId,
              logicalMemoryId: source.logicalMemoryId,
              teamId: stringValue(row.team_id),
              teamWorkspaceId: stringValue(row.team_workspace_id),
              shareGrantId,
              expectedGrantVersion: numberValue(row.grant_version),
              preview: {
                previewId: preview.previewId,
                previewHash: preview.previewHash
              },
              previewRevision: preview.previewRevision,
              mode: "continuous",
              maximumFidelity: "memory_events",
              includeCuratedMemory: false,
              expiresAt: null,
              authority,
              deviceCredentialId: input.deviceCredentialId
            }
          );
          pendingShares.push(pendingShare);
          outcomes.push({
            shareGrantId,
            status: "accepted",
            pendingShareId: pendingShare.id
          });
        } catch (error) {
          if (
            !(
              error instanceof SharedMemoryAuthorizationError ||
              error instanceof SharedMemoryConflictError
            )
          ) {
            throw error;
          }
          outcomes.push({
            shareGrantId,
            status: "rejected",
            reasonCode: "destination_unavailable"
          });
        }
      }
      return {
        pendingShares,
        outcomes,
        nextShareGrantId:
          authorization.rows.length > pageRows.length
            ? stringValue(pageRows.at(-1)?.grant_id)
            : null
      };
    },
    async processPendingShares(input = {}) {
      return processPendingShareWorkflow(input);
    },
    async getNextPendingShareWorkAt() {
      const next = await pool.query<{ work_at: Date | null }>(
        `select min(case
                  when outbox.state='processing'
                    then outbox.locked_at+interval '5 minutes'
                  else outbox.available_at
                end) as work_at
           from pending_share_outbox outbox
           join pending_share_operation_records pending
             on pending.id=outbox.pending_share_id
          where pending.state in ('preparing','needs_attention')
            and pending.revoked_at is null
            and outbox.state in ('pending','failed','processing')`
      );
      return next.rows[0]?.work_at?.toISOString() ?? null;
    },
    async controlPendingShare(actor, input) {
      assertUuid(input.pendingShareId, "pendingShareId");
      assertUuid(input.mutationId, "mutationId");
      return withTransaction(pool, async (client) => {
        const result = await client.query<Row>(
          `select p.*,grant_row.grant_version,
                  preview.source_kind as effective_source_kind,
                  preview.source_session_id as effective_source_session_id,
                  preview.source_note_id as effective_source_note_id,
                  preview.source_memory_event_id as effective_source_memory_event_id,
                  preview.source_revision as effective_source_revision
             from pending_share_operations p
             left join team_memory_share_grants grant_row
               on grant_row.id=p.grant_id
             join shared_memory_candidate_preview_records preview
               on preview.id=coalesce(p.replacement_preview_id,p.preview_id)
            where p.id=$1 for update of p`,
          [input.pendingShareId]
        );
        const pending = result.rows[0];
        if (!pending || stringValue(pending.owner_user_id) !== actor.userId) {
          throw new SharedMemoryAuthorizationError(
            "Only the source owner may control a Pending Share"
          );
        }
        if (
          numberValue(pending.operation_version) !==
          input.expectedOperationVersion
        ) {
          if (
            nullableString(pending.last_control_mutation_id) ===
              input.mutationId &&
            nullableString(pending.last_control_action) === input.action
          ) {
            return mapPendingShare(pending);
          }
          throw new SharedMemoryConflictError();
        }
        if (input.action === "retry") {
          if (
            !["failed", "needs_attention"].includes(stringValue(pending.state))
          ) {
            throw new SharedMemoryConflictError(
              "Only failed Pending Shares can be retried"
            );
          }
          await client.query(
            `insert into pending_share_outbox (pending_share_id,state,available_at)
             values ($1,'pending',now())
             on conflict (pending_share_id) do update
               set state='pending',available_at=now(),locked_at=null,updated_at=now()`,
            [input.pendingShareId]
          );
        } else if (input.action === "revoke") {
          if (
            stringValue(pending.state) === "activated" ||
            pending.grant_id !== null
          ) {
            throw new SharedMemoryConflictError(
              "Active Pending Shares must revoke their Share Grant"
            );
          }
          if (stringValue(pending.state) === "revoked") {
            throw new SharedMemoryConflictError(
              "Pending Share is already revoked"
            );
          }
          await client.query(
            `update source_owner_representation_consents
                set state='revoked',revoked_at=coalesce(revoked_at,now()),
                    state_reason_code='owner_revoked',
                    updated_at=now()
              where id=$1 and revoked_at is null`,
            [pending.consent_id]
          );
          await client.query(
            `update pending_share_outbox
                set state='completed',locked_at=null,updated_at=now()
              where pending_share_id=$1`,
            [input.pendingShareId]
          );
        } else {
          if (
            stringValue(pending.state) !== "activated" ||
            pending.grant_id === null
          ) {
            throw new SharedMemoryConflictError(
              "Update controls require an active continuous share"
            );
          }
          const activeAuthority = await client.query<Row>(
            `select g.consent_id,c.mode,c.state as consent_state
               from team_memory_share_grants g
               join source_owner_representation_consents c on c.id=g.consent_id
              where g.id=$1 and g.owner_user_id=$2 and g.lifecycle='active'
                and g.revoked_at is null and c.revoked_at is null
              for update of g,c`,
            [pending.grant_id, actor.userId]
          );
          const activeConsent = activeAuthority.rows[0];
          if (
            !activeConsent ||
            stringValue(activeConsent.mode) !== "continuous"
          ) {
            throw new SharedMemoryConflictError(
              "Update controls require the active Share Grant consent to be continuous"
            );
          }
          const expectedState = input.action === "pause" ? "active" : "paused";
          if (stringValue(activeConsent.consent_state) !== expectedState) {
            throw new SharedMemoryConflictError(
              `Continuous share updates are not ${expectedState}`
            );
          }
          const consentControl = await client.query(
            input.action === "pause"
              ? `update source_owner_representation_consents
                    set state='paused',paused_at=now(),updated_at=now(),
                        state_reason_code='owner_paused_updates'
                  where id=$1 and state='active' and revoked_at is null`
              : `update source_owner_representation_consents
                    set state='active',paused_at=null,updated_at=now(),
                        state_reason_code=null
                  where id=$1 and state='paused' and revoked_at is null`,
            [activeConsent.consent_id]
          );
          if ((consentControl.rowCount ?? 0) !== 1) {
            throw new SharedMemoryConflictError(
              "Continuous share consent state changed"
            );
          }
        }
        const updated = await client.query<Row>(
          `update pending_share_operations
              set state=case when $2='retry' then 'preparing'
                    when $2='revoke' then 'revoked' else state end,
                  stage=case when $2='retry' then 'syncing'
                    when $2='revoke' then 'complete' else stage end,
                  workspace_access_state=case when $2='revoke' then 'revoked'
                    else workspace_access_state end,
                  source_update_state=case
                    when $2='retry' then 'preparing'
                    when $2='pause' then 'paused'
                    when $2='resume' then 'active'
                    when $2='revoke' then 'stopped'
                    else source_update_state end,
                  redacted_failure_code=case when $2 in ('retry','revoke') then null
                    else redacted_failure_code end,
                  next_attempt_at=case when $2='retry' then now()
                    else next_attempt_at end,
                  revoked_at=case when $2='revoke' then coalesce(revoked_at,now())
                    else revoked_at end,
                  last_control_mutation_id=$3,last_control_action=$2,
                  last_progress_at=now(),updated_at=now(),
                  operation_version=operation_version+1
            where id=$1 returning *`,
          [input.pendingShareId, input.action, input.mutationId]
        );
        await client.query(
          `insert into audit_events
             (actor_user_id,owner_user_id,visibility,action,target_table,target_id,metadata)
           values ($1,$1,'personal',$2,'pending_share_operations',$3,$4::jsonb)`,
          [
            actor.userId,
            `shared_memory.pending_share.${input.action}`,
            input.pendingShareId,
            JSON.stringify({ mutationId: input.mutationId })
          ]
        );
        await appendPendingShareOwnerEvent(client, {
          mutationId: crossIdentitySyncDeterministicUuid({
            kind: "pending_share_lifecycle",
            pendingShareId: input.pendingShareId,
            parentMutationId: input.mutationId,
            action: input.action,
            state: stringValue(updated.rows[0]!.state),
            operationVersion: numberValue(updated.rows[0]!.operation_version)
          }),
          ownerUserId: actor.userId,
          pendingShareId: input.pendingShareId
        });
        return mapPendingShare({
          ...updated.rows[0]!,
          grant_version: pending.grant_version,
          effective_source_kind: pending.effective_source_kind,
          effective_source_session_id: pending.effective_source_session_id,
          effective_source_note_id: pending.effective_source_note_id,
          effective_source_memory_event_id:
            pending.effective_source_memory_event_id,
          effective_source_revision: pending.effective_source_revision
        });
      });
    },
    async getSharedMemoryCandidatePreviewAdmission(actor, input) {
      return withTransaction(pool, async (client) => {
        await requireWorkspaceSharePermission(
          client,
          actor,
          input.teamId,
          input.teamWorkspaceId
        );
        assertFidelityConsent(input);
        const teamPolicy = await activePolicy(client, {
          table: "team_representation_policies",
          whereSql: "team_id=$1",
          parameters: [input.teamId]
        });
        const workspacePolicy = await activePolicy(client, {
          table: "workspace_representation_policies",
          whereSql: "team_id=$1 and team_workspace_id=$2",
          parameters: [input.teamId, input.teamWorkspaceId]
        });
        if (!teamPolicy || !workspacePolicy) return null;
        const effective = effectiveFidelityConsent(teamPolicy, workspacePolicy);
        if (
          !sharedMemoryCeilingAuthorizes(
            effective.maximumFidelity,
            input.representation,
            effective.includeCuratedMemory
          ) ||
          !fidelityConsentDoesNotExpand(input, effective)
        ) {
          return null;
        }
        return {
          effectiveMaximumFidelity: effective.maximumFidelity,
          effectiveIncludeCuratedMemory: effective.includeCuratedMemory,
          teamPolicyVersion: numberValue(teamPolicy.version),
          teamPolicyHash: stringValue(teamPolicy.policy_hash),
          workspacePolicyVersion: numberValue(workspacePolicy.version),
          workspacePolicyHash: stringValue(workspacePolicy.policy_hash)
        };
      });
    },
    async getSharedMemoryPreviewAdmission(actor, input) {
      return withTransaction(pool, (client) =>
        reviewOrNull(async () => {
          assertFidelityConsent(input);
          const owner = await requireSourceOwner(
            client,
            actor,
            input.logicalMemoryId
          );
          await requireWorkspaceSharePermission(
            client,
            actor,
            input.teamId,
            input.teamWorkspaceId
          );
          const readiness = await client.query<Row>(
            `select mr.id,
                    lm.latest_source_revision,mr.latest_revision,
                    sr.target_processing_cursor
               from logical_memories lm
               join local_captured_session_logical_memories local_memory
                 on local_memory.logical_memory_id=lm.id
                and local_memory.owner_user_id=$3
               join memory_replicas mr
                 on mr.id=$2 and mr.logical_memory_id=lm.id
                and mr.owner_user_id=$3
                and mr.owner_principal_id=$4
                and mr.replica_role='target'
                and mr.encryption_scope='owner_private_replica'
                and mr.lifecycle='active' and mr.disabled_at is null
               join cross_identity_sync_relationships sr
                 on sr.local_replica_id=mr.id
                and sr.logical_memory_id=lm.id and sr.side='target'
                and sr.local_user_id=$3 and sr.revoked_at is null
                and sr.state in ('processing','partially_available','ready','stale')
               join device_credentials credential
                 on credential.id=sr.device_credential_id
                and credential.owner_user_id=$3
                and credential.revoked_at is null
                and (credential.expires_at is null or credential.expires_at>now())
              where lm.id=$1 and lm.owner_user_id=$3
                and lm.owner_principal_id=$4
                and sr.target_processing_cursor=lm.latest_source_revision
                and sr.target_processing_cursor=mr.latest_revision
              limit 1`,
            [
              input.logicalMemoryId,
              input.remoteReplicaId,
              actor.userId,
              owner.ownerPrincipalId
            ]
          );
          if (!readiness.rows[0]) {
            throw new SharedMemoryAuthorizationError(
              "Owner-private sync relationship is not ready"
            );
          }
          const teamPolicy = await activePolicy(client, {
            table: "team_representation_policies",
            whereSql: "team_id=$1",
            parameters: [input.teamId]
          });
          const workspacePolicy = await activePolicy(client, {
            table: "workspace_representation_policies",
            whereSql: "team_id=$1 and team_workspace_id=$2",
            parameters: [input.teamId, input.teamWorkspaceId]
          });
          if (!teamPolicy || !workspacePolicy) {
            throw new SharedMemoryConflictError(
              "Team and Workspace representation policies are required"
            );
          }
          const effectiveMaximumFidelity =
            intersectSharedMemoryFidelityCeilings(
              input.maximumFidelity,
              fidelityConsentFromRow(teamPolicy).maximumFidelity,
              fidelityConsentFromRow(workspacePolicy).maximumFidelity
            )!;
          const effectiveIncludeCuratedMemory =
            input.includeCuratedMemory &&
            fidelityConsentFromRow(teamPolicy).includeCuratedMemory &&
            fidelityConsentFromRow(workspacePolicy).includeCuratedMemory;
          if (
            effectiveMaximumFidelity !== input.maximumFidelity ||
            effectiveIncludeCuratedMemory !== input.includeCuratedMemory ||
            !sharedMemoryCeilingAuthorizes(
              effectiveMaximumFidelity,
              input.representation,
              effectiveIncludeCuratedMemory
            )
          ) {
            throw new SharedMemoryConflictError(
              "Preview fidelity is outside the destination policy intersection"
            );
          }
          const ownerPolicy = await activePolicy(client, {
            table: "source_owner_representation_policies",
            whereSql: "logical_memory_id=$1 and source_owner_principal_id=$2",
            parameters: [input.logicalMemoryId, owner.ownerPrincipalId]
          });
          const currentConsent = ownerPolicy
            ? fidelityConsentFromRow(ownerPolicy)
            : null;
          const display = await loadReviewDisplay(client, {
            logicalMemoryId: input.logicalMemoryId,
            teamId: input.teamId,
            teamWorkspaceId: input.teamWorkspaceId,
            ownerPrincipalId: owner.ownerPrincipalId
          });
          return {
            source: {
              logicalMemoryId: display.logicalMemoryId,
              ownerPrincipalId: display.ownerPrincipalId,
              title: display.title
            },
            team: display.team,
            workspace: display.workspace,
            remoteReplicaId: input.remoteReplicaId,
            representation: input.representation,
            requestedMaximumFidelity: input.maximumFidelity,
            requestedIncludeCuratedMemory: input.includeCuratedMemory,
            effectiveMaximumFidelity,
            effectiveIncludeCuratedMemory,
            sourceOwnerPolicyWillChange:
              currentConsent?.maximumFidelity !== input.maximumFidelity ||
              currentConsent?.includeCuratedMemory !==
                input.includeCuratedMemory
          };
        })
      );
    },

    async getSharedMemoryShareReview(actor, input) {
      return withTransaction(pool, (client) =>
        reviewOrNull(async () => {
          const review = await loadPreviewReviewContext(client, actor, input);
          const conflicts = await client.query<{ conflicting: boolean }>(
            `select exists (
               select 1 from team_memory_share_grant_records
                where logical_grant_id=$1
                  and (owner_user_id<>$2 or logical_memory_id<>$3
                    or team_id<>$4 or team_workspace_id<>$5 or consent_id<>$6)
               union all
               select 1 from team_memory_share_grant_records
                where logical_memory_id=$3 and team_workspace_id=$5
                  and logical_grant_id<>$1
             ) as conflicting`,
            [
              input.logicalGrantId,
              actor.userId,
              input.logicalMemoryId,
              input.teamId,
              input.teamWorkspaceId,
              input.consentId
            ]
          );
          const retention = await client.query(
            `select 1 from retention_policies
              where effective_at <= transaction_timestamp()
                and (superseded_at is null or superseded_at > transaction_timestamp())
                and ((scope='workspace' and team_id=$1 and team_workspace_id=$2)
                  or (scope='team' and team_id=$1))
              limit 1`,
            [input.teamId, input.teamWorkspaceId]
          );
          if (conflicts.rows[0]?.conflicting === true || !retention.rowCount) {
            throw new SharedMemoryConflictError(
              "Share Grant destination or retention context is invalid"
            );
          }
          return review;
        })
      );
    },

    async getSharedMemoryPendingShareReview(actor, input) {
      return withTransaction(pool, (client) =>
        reviewOrNull(async () => {
          await requireWorkspaceSharePermission(
            client,
            actor,
            input.teamId,
            input.teamWorkspaceId
          );
          const result = await client.query<Row>(
            `select preview.*,team.name as team_name,workspace.name as workspace_name
               from shared_memory_candidate_preview_records preview
               join teams team on team.id=preview.team_id
               join team_workspaces workspace
                 on workspace.id=preview.team_workspace_id
                and workspace.team_id=preview.team_id
              where preview.id=$1 and preview.preview_hash=$2
                and preview.preview_revision=$3
                and preview.owner_user_id=$4
                and preview.logical_memory_id=$5
                and preview.team_id=$6 and preview.team_workspace_id=$7
                and preview.maximum_fidelity=$8
                and preview.include_curated_memory=$9
                and preview.share_expires_at is not distinct from $10::timestamptz
                and preview.invalidated_at is null and preview.expires_at>now()
              limit 1`,
            [
              input.preview.previewId,
              input.preview.previewHash,
              input.previewRevision,
              actor.userId,
              input.logicalMemoryId,
              input.teamId,
              input.teamWorkspaceId,
              input.maximumFidelity,
              input.includeCuratedMemory,
              input.expiresAt
            ]
          );
          const row = result.rows[0];
          if (!row) {
            throw new SharedMemoryConflictError(
              "Candidate preview is missing, expired, or changed"
            );
          }
          return {
            source: {
              logicalMemoryId: input.logicalMemoryId,
              ownerPrincipalId: actor.userId,
              title: "Personal Memory"
            },
            team: { id: input.teamId, name: stringValue(row.team_name) },
            workspace: {
              id: input.teamWorkspaceId,
              name: stringValue(row.workspace_name)
            },
            preview: {
              previewId: input.preview.previewId,
              previewHash: input.preview.previewHash,
              previewRevision: input.previewRevision,
              sourceRevision: numberValue(row.source_revision),
              representation: representationValue(row.representation)
            },
            maximumFidelity: input.maximumFidelity,
            includeCuratedMemory: input.includeCuratedMemory,
            sourceOwnerPolicyWillActivate: true,
            sourceOwnerPolicyWillReplace: false
          };
        })
      );
    },

    async getSharedMemoryFidelityChangeReview(actor, input) {
      return withTransaction(pool, (client) =>
        reviewOrNull(async () => {
          const personalNoteCandidate = await client.query<Row>(
            `select preview.*,team.name as team_name,
                    workspace.name as workspace_name
               from shared_memory_candidate_preview_records preview
               join teams team on team.id=preview.team_id
               join team_workspaces workspace
                 on workspace.id=preview.team_workspace_id
                and workspace.team_id=preview.team_id
              where preview.id=$1 and preview.preview_hash=$2
                and preview.preview_revision=$3
                and preview.owner_user_id=$4
                and preview.logical_memory_id=$5
                and preview.team_id=$6 and preview.team_workspace_id=$7
                and preview.maximum_fidelity=$8
                and preview.include_curated_memory=$9
                and preview.share_expires_at is not distinct from $10::timestamptz
                and preview.source_kind='personal_note'
                and preview.invalidated_at is null and preview.expires_at>now()
              limit 1`,
            [
              input.preview.previewId,
              input.preview.previewHash,
              input.previewRevision,
              actor.userId,
              input.logicalMemoryId,
              input.teamId,
              input.teamWorkspaceId,
              input.maximumFidelity,
              input.includeCuratedMemory,
              input.expiresAt
            ]
          );
          const candidate = personalNoteCandidate.rows[0];
          const review = candidate
            ? await (async (): Promise<SharedMemoryShareReviewRecord> => {
                await requireWorkspaceSharePermission(
                  client,
                  actor,
                  input.teamId,
                  input.teamWorkspaceId
                );
                return {
                  source: {
                    logicalMemoryId: input.logicalMemoryId,
                    ownerPrincipalId: actor.userId,
                    title: "Personal Memory"
                  },
                  team: {
                    id: input.teamId,
                    name: stringValue(candidate.team_name)
                  },
                  workspace: {
                    id: input.teamWorkspaceId,
                    name: stringValue(candidate.workspace_name)
                  },
                  preview: {
                    previewId: input.preview.previewId,
                    previewHash: input.preview.previewHash,
                    previewRevision: input.previewRevision,
                    remoteReplicaId: null,
                    representation: representationValue(
                      candidate.representation
                    ),
                    sourceRevision: numberValue(candidate.source_revision)
                  },
                  maximumFidelity: input.maximumFidelity,
                  includeCuratedMemory: input.includeCuratedMemory,
                  sourceOwnerPolicyWillActivate: false,
                  sourceOwnerPolicyWillReplace: false
                };
              })()
            : await loadPreviewReviewContext(client, actor, input);
          const grantResult = await client.query<Row>(
            `select * from team_memory_share_grant_records
              where id=$1 and owner_user_id=$2 and logical_memory_id=$3
                and team_id=$4 and team_workspace_id=$5
                and grant_version=$6 and lifecycle in ('active','revoked')
              limit 1`,
            [
              input.shareGrantId,
              actor.userId,
              input.logicalMemoryId,
              input.teamId,
              input.teamWorkspaceId,
              input.expectedGrantVersion
            ]
          );
          const row = grantResult.rows[0];
          if (!row) {
            throw new SharedMemoryConflictError(
              "Current Share Grant fidelity is required"
            );
          }
          const grant = mapGrant(row);
          if (
            candidate &&
            !sharedMemorySourceCanReplace(
              requiredSourceRefFromRow(row),
              requiredSourceRefFromRow(candidate)
            )
          ) {
            throw new SharedMemoryAuthorizationError(
              "Personal Note replacement source binding is invalid"
            );
          }
          const sourceRevisionChanged =
            review.preview.sourceRevision > grant.sourceRevision;
          if (
            grant.lifecycle === "active" &&
            grant.maximumFidelity === input.maximumFidelity &&
            grant.includeCuratedMemory === input.includeCuratedMemory &&
            !sourceRevisionChanged
          ) {
            throw new SharedMemoryConflictError(
              "Active Share Grant already uses this source revision and fidelity"
            );
          }
          return {
            ...review,
            grant: {
              id: grant.id,
              logicalMemoryId: grant.logicalMemoryId,
              teamId: grant.teamId,
              teamWorkspaceId: grant.teamWorkspaceId,
              grantVersion: grant.grantVersion,
              lifecycle: grant.lifecycle,
              sourceRevision: grant.sourceRevision,
              maximumFidelity: grant.maximumFidelity,
              includeCuratedMemory: grant.includeCuratedMemory
            },
            willReactivate: grant.lifecycle === "revoked",
            sourceRevisionChanged
          };
        })
      );
    },

    async getSharedMemoryRevokeReview(actor, input) {
      return withTransaction(pool, (client) =>
        reviewOrNull(async () => {
          const result = await client.query<Row>(
            `select g.*,t.name as team_name,tw.name as workspace_name,
                    coalesce(
                      nullif(trim(g.display_title),''),
                      nullif(trim(s.metadata->>'threadName'),''),
                      case when g.source_kind='personal_note'
                        then 'Personal Note' else 'Captured Session' end
                    ) as source_title
               from team_memory_share_grant_records g
               join teams t on t.id=g.team_id
               join team_workspaces tw on tw.id=g.team_workspace_id and tw.team_id=t.id
               left join logical_memories lm on lm.id=g.logical_memory_id
               left join local_captured_session_logical_memories local_memory
                 on local_memory.logical_memory_id=lm.id
                and local_memory.owner_user_id=g.owner_user_id
               left join sessions s on s.id=local_memory.local_session_id
              where g.id=$1 and g.owner_user_id=$2
                and g.team_id=$3 and g.team_workspace_id=$4
                and g.grant_version=$5 and g.lifecycle='active'
              limit 1`,
            [
              input.shareGrantId,
              actor.userId,
              input.teamId,
              input.teamWorkspaceId,
              input.expectedGrantVersion
            ]
          );
          const row = result.rows[0];
          if (!row) {
            throw new SharedMemoryAuthorizationError(
              "Source-owned Share Grant is required"
            );
          }
          const grant = mapGrant(row);
          return {
            source: {
              logicalMemoryId: grant.logicalMemoryId,
              title: stringValue(row.source_title)
            },
            team: { id: grant.teamId, name: stringValue(row.team_name) },
            workspace: {
              id: grant.teamWorkspaceId,
              name: stringValue(row.workspace_name)
            },
            grant: {
              id: grant.id,
              grantVersion: grant.grantVersion,
              lifecycle: grant.lifecycle,
              maximumFidelity: grant.maximumFidelity,
              includeCuratedMemory: grant.includeCuratedMemory
            }
          };
        })
      );
    },

    async createAuthoritativeSourcePreview(actor, input) {
      return createAuthoritativeSourcePreview(actor, input);
    },
    async persistPersonalNoteSourceArtifact(actor, input) {
      return persistPersonalNoteSourceArtifact(actor, input);
    },
    async putSourceOwnerPolicy(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      assertFidelityConsent(input);
      return withTransaction(pool, async (client) => {
        const owner = await requireSourceOwner(
          client,
          actor,
          input.logicalMemoryId
        );
        const current = await activePolicy(client, {
          table: "source_owner_representation_policies",
          whereSql: "logical_memory_id=$1 and source_owner_principal_id=$2",
          parameters: [input.logicalMemoryId, owner.ownerPrincipalId]
        });
        if (
          numberValue(current?.version ?? 0) !== input.expectedCurrentVersion
        ) {
          throw new SharedMemoryConflictError();
        }
        if (
          current &&
          input.policyId !== undefined &&
          input.policyId !== current.policy_id
        ) {
          throw new SharedMemoryConflictError(
            "Policy lineage cannot be replaced"
          );
        }
        const id =
          input.policyId ??
          (current ? stringValue(current.policy_id) : randomUUID());
        const version = input.expectedCurrentVersion + 1;
        const hash = sharedMemoryPolicyHash({
          scope: "source_owner",
          scopeId: `${input.logicalMemoryId}:${owner.ownerPrincipalId}`,
          policyId: id,
          version,
          maximumFidelity: input.maximumFidelity,
          includeCuratedMemory: input.includeCuratedMemory
        });
        const existing = await client.query<Row>(
          `select * from source_owner_representation_policies
          where policy_id=$1 and version=$2 limit 1`,
          [id, version]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].policy_hash !== hash) {
            throw new SharedMemoryConflictError("Policy idempotency conflict");
          }
          return mapPolicy(existing.rows[0] as Row, "source_owner");
        }
        if (current) {
          await client.query(
            "update source_owner_representation_policies set superseded_at=now() where id=$1",
            [current.id]
          );
        }
        const inserted = await client.query<Row>(
          `insert into source_owner_representation_policies (
           policy_id,logical_memory_id,source_owner_principal_id,version,
           maximum_fidelity,include_curated_memory,policy_hash,
           created_by_user_id,effective_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,now())
         returning *`,
          [
            id,
            input.logicalMemoryId,
            owner.ownerPrincipalId,
            version,
            input.maximumFidelity,
            input.includeCuratedMemory,
            hash,
            actor.userId
          ]
        );
        await appendPolicyAudit(client, {
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          action: "shared_memory.source_owner_policy.updated",
          targetTable: "source_owner_representation_policies",
          targetId: stringValue(inserted.rows[0]?.id),
          mutationId: input.mutationId,
          scope: "source_owner",
          logicalMemoryId: input.logicalMemoryId,
          policyId: id,
          version,
          previousVersion: input.expectedCurrentVersion,
          maximumFidelity: input.maximumFidelity,
          includeCuratedMemory: input.includeCuratedMemory
        });
        if (current) {
          await client.query(
            `update source_owner_representation_consents
              set state='paused', paused_at=now(), updated_at=now(),
                  state_reason_code='source_owner_policy_changed'
            where logical_memory_id=$1 and source_owner_principal_id=$2 and state='active'`,
            [input.logicalMemoryId, owner.ownerPrincipalId]
          );
          await invalidateAffectedGrants(client, {
            mutationId: input.mutationId,
            actorUserId: actor.userId,
            whereSql: "g.logical_memory_id=$1 and g.owner_principal_id=$2",
            parameters: [input.logicalMemoryId, owner.ownerPrincipalId],
            reasonCode: "source_owner_policy_changed"
          });
        }
        return mapPolicy(inserted.rows[0] as Row, "source_owner");
      });
    },

    async putTeamPolicy(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      assertFidelityConsent(input);
      return withTransaction(pool, async (client) => {
        await requireTeamManager(client, actor, input.teamId);
        const current = await activePolicy(client, {
          table: "team_representation_policies",
          whereSql: "team_id=$1",
          parameters: [input.teamId]
        });
        if (
          numberValue(current?.version ?? 0) !== input.expectedCurrentVersion
        ) {
          throw new SharedMemoryConflictError();
        }
        if (
          current &&
          input.policyId !== undefined &&
          input.policyId !== current.policy_id
        ) {
          throw new SharedMemoryConflictError(
            "Policy lineage cannot be replaced"
          );
        }
        if (
          current &&
          !fidelityConsentDoesNotExpand(input, fidelityConsentFromRow(current))
        ) {
          throw new SharedMemoryAuthorizationError(
            "Team policy updates may only reduce fidelity"
          );
        }
        const id =
          input.policyId ??
          (current ? stringValue(current.policy_id) : randomUUID());
        const version = input.expectedCurrentVersion + 1;
        const hash = sharedMemoryPolicyHash({
          scope: "team",
          scopeId: input.teamId,
          policyId: id,
          version,
          maximumFidelity: input.maximumFidelity,
          includeCuratedMemory: input.includeCuratedMemory
        });
        const existing = await client.query<Row>(
          "select * from team_representation_policies where policy_id=$1 and version=$2 limit 1",
          [id, version]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].policy_hash !== hash)
            throw new SharedMemoryConflictError("Policy idempotency conflict");
          return mapPolicy(existing.rows[0] as Row, "team");
        }
        if (current)
          await client.query(
            "update team_representation_policies set superseded_at=now() where id=$1",
            [current.id]
          );
        const inserted = await client.query<Row>(
          `insert into team_representation_policies (
           policy_id,team_id,version,maximum_fidelity,include_curated_memory,
           policy_hash,created_by_user_id,effective_at
         ) values ($1,$2,$3,$4,$5,$6,$7,now()) returning *`,
          [
            id,
            input.teamId,
            version,
            input.maximumFidelity,
            input.includeCuratedMemory,
            hash,
            actor.userId
          ]
        );
        await appendPolicyAudit(client, {
          actorUserId: actor.userId,
          ownerUserId: null,
          action: "team.shared_memory_policy.updated",
          targetTable: "team_representation_policies",
          targetId: stringValue(inserted.rows[0]?.id),
          mutationId: input.mutationId,
          scope: "team",
          teamId: input.teamId,
          policyId: id,
          version,
          previousVersion: input.expectedCurrentVersion,
          maximumFidelity: input.maximumFidelity,
          includeCuratedMemory: input.includeCuratedMemory
        });
        if (current) {
          await client.query(
            `update source_owner_representation_consents set state='paused',paused_at=now(),
                  updated_at=now(),state_reason_code='team_policy_changed'
            where team_id=$1 and state='active'`,
            [input.teamId]
          );
          await invalidateAffectedGrants(client, {
            mutationId: input.mutationId,
            actorUserId: actor.userId,
            whereSql: "g.team_id=$1",
            parameters: [input.teamId],
            reasonCode: "team_policy_changed"
          });
        }
        return mapPolicy(inserted.rows[0] as Row, "team");
      });
    },

    async putWorkspacePolicy(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      assertFidelityConsent(input);
      return withTransaction(pool, async (client) => {
        await requireTeamManager(client, actor, input.teamId);
        await requireWorkspaceAccess(
          client,
          actor,
          input.teamId,
          input.teamWorkspaceId,
          "write"
        );
        const current = await activePolicy(client, {
          table: "workspace_representation_policies",
          whereSql: "team_id=$1 and team_workspace_id=$2",
          parameters: [input.teamId, input.teamWorkspaceId]
        });
        if (numberValue(current?.version ?? 0) !== input.expectedCurrentVersion)
          throw new SharedMemoryConflictError();
        if (
          current &&
          input.policyId !== undefined &&
          input.policyId !== current.policy_id
        ) {
          throw new SharedMemoryConflictError(
            "Policy lineage cannot be replaced"
          );
        }
        if (
          current &&
          !fidelityConsentDoesNotExpand(input, fidelityConsentFromRow(current))
        ) {
          throw new SharedMemoryAuthorizationError(
            "Workspace policy updates may only reduce fidelity"
          );
        }
        const id =
          input.policyId ??
          (current ? stringValue(current.policy_id) : randomUUID());
        const version = input.expectedCurrentVersion + 1;
        const hash = sharedMemoryPolicyHash({
          scope: "workspace",
          scopeId: `${input.teamId}:${input.teamWorkspaceId}`,
          policyId: id,
          version,
          maximumFidelity: input.maximumFidelity,
          includeCuratedMemory: input.includeCuratedMemory
        });
        const existing = await client.query<Row>(
          "select * from workspace_representation_policies where policy_id=$1 and version=$2 limit 1",
          [id, version]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].policy_hash !== hash)
            throw new SharedMemoryConflictError("Policy idempotency conflict");
          return mapPolicy(existing.rows[0] as Row, "workspace");
        }
        if (current)
          await client.query(
            "update workspace_representation_policies set superseded_at=now() where id=$1",
            [current.id]
          );
        const inserted = await client.query<Row>(
          `insert into workspace_representation_policies (
           policy_id,team_id,team_workspace_id,version,maximum_fidelity,
           include_curated_memory,policy_hash,created_by_user_id,effective_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,now()) returning *`,
          [
            id,
            input.teamId,
            input.teamWorkspaceId,
            version,
            input.maximumFidelity,
            input.includeCuratedMemory,
            hash,
            actor.userId
          ]
        );
        await appendPolicyAudit(client, {
          actorUserId: actor.userId,
          ownerUserId: null,
          action: "team.workspace.shared_memory_policy.updated",
          targetTable: "workspace_representation_policies",
          targetId: stringValue(inserted.rows[0]?.id),
          mutationId: input.mutationId,
          scope: "workspace",
          teamId: input.teamId,
          teamWorkspaceId: input.teamWorkspaceId,
          policyId: id,
          version,
          previousVersion: input.expectedCurrentVersion,
          maximumFidelity: input.maximumFidelity,
          includeCuratedMemory: input.includeCuratedMemory
        });
        if (current) {
          await client.query(
            `update source_owner_representation_consents set state='paused',paused_at=now(),
                  updated_at=now(),state_reason_code='workspace_policy_changed'
            where team_id=$1 and team_workspace_id=$2 and state='active'`,
            [input.teamId, input.teamWorkspaceId]
          );
          await invalidateAffectedGrants(client, {
            mutationId: input.mutationId,
            actorUserId: actor.userId,
            whereSql: "g.team_id=$1 and g.team_workspace_id=$2",
            parameters: [input.teamId, input.teamWorkspaceId],
            reasonCode: "workspace_policy_changed"
          });
        }
        return mapPolicy(inserted.rows[0] as Row, "workspace");
      });
    },

    async createShareBundle(actor, input) {
      try {
        return await withTransaction(pool, async (client) => {
          await activatePreviewSourceOwnerPolicy(client, actor, input.consent);
          const consent = await repository.createSourceOwnerConsent(
            actor,
            input.consent,
            client
          );
          if (!consentMatchesBinding(consent, input.expected)) {
            throw new SharedMemoryBundleInvariantError();
          }
          const grant = await repository.createShareGrant(
            actor,
            input.grant,
            client
          );
          if (!grantMatchesBinding(grant, input.expected)) {
            throw new SharedMemoryBundleInvariantError();
          }
          return { consent, grant };
        });
      } catch (error) {
        if (error instanceof SharedMemoryBundleInvariantError) return null;
        throw error;
      }
    },

    async changeFidelityBundle(actor, input) {
      try {
        return await withTransaction(pool, async (client) => {
          await activatePreviewSourceOwnerPolicy(
            client,
            actor,
            input.consent,
            input.fidelity.shareGrantId
          );
          const consent = await repository.createSourceOwnerConsent(
            actor,
            input.consent,
            client
          );
          if (!consentMatchesBinding(consent, input.expected)) {
            throw new SharedMemoryBundleInvariantError();
          }
          const grant = await repository.selectGrantFidelity(
            actor,
            input.fidelity,
            client
          );
          if (!grantMatchesBinding(grant, input.expected)) {
            throw new SharedMemoryBundleInvariantError();
          }
          await repository.materializeGrantRepresentation(
            actor,
            {
              mutationId: input.fidelity.mutationId,
              shareGrantId: grant.id,
              consentId: consent.id,
              expectedGrantVersion: grant.grantVersion,
              preview: input.consent.preview
            },
            client
          );
          return { consent, grant };
        });
      } catch (error) {
        if (error instanceof SharedMemoryBundleInvariantError) return null;
        throw error;
      }
    },

    async createSourceOwnerConsent(
      actor,
      input,
      transactionClient?: pg.PoolClient
    ) {
      assertUuid(input.consentId, "consentId");
      assertFidelityConsent(input);
      const command = async (client: pg.PoolClient) => {
        const loaded = await loadPersistedPreviewByReference(client, {
          preview: input.preview,
          requiredMessage: "Consent preview reference is not active"
        });
        const { preview, artifact, artifactBody } = loaded;
        const logicalMemoryId = preview.logicalMemoryId;
        const teamId = preview.teamId;
        const teamWorkspaceId = preview.teamWorkspaceId;
        const remoteReplicaId = preview.remoteReplicaId;
        if (
          crossIdentitySyncDigest(input.source) !==
            crossIdentitySyncDigest(preview.source) ||
          crossIdentitySyncDigest(input.sourceCapabilities) !==
            crossIdentitySyncDigest(preview.sourceCapabilities) ||
          input.activationRepresentation !== preview.activationRepresentation
        ) {
          throw new SharedMemoryConflictError(
            "Consent source binding must match the reviewed preview"
          );
        }
        const owner = await requireSourceOwner(client, actor, logicalMemoryId);
        if (preview.ownerPrincipalId !== owner.ownerPrincipalId) {
          throw new SharedMemoryAuthorizationError(
            "Only the source owner may consent to this preview"
          );
        }
        if (input.internalPendingShareId) {
          const pending = await client.query(
            `select 1 from pending_share_operation_records
              where id=$1 and owner_user_id=$2 and logical_memory_id=$3
                and team_id=$4 and team_workspace_id=$5
                and coalesce(replacement_consent_id,consent_id)=$6
                and state='preparing' and revoked_at is null
              limit 1`,
            [
              input.internalPendingShareId,
              actor.userId,
              logicalMemoryId,
              teamId,
              teamWorkspaceId,
              input.consentId
            ]
          );
          if (!pending.rowCount) {
            throw new SharedMemoryAuthorizationError(
              "Pending Share internal consent authority is invalid"
            );
          }
        } else {
          await requireShareAuthority(client, actor, {
            teamId,
            teamWorkspaceId,
            authority: input.authority,
            consume: false,
            delegatedDeviceActionGrant
          });
        }
        if (artifact.source?.kind === "captured_session") {
          if (
            !remoteReplicaId ||
            !artifact.syncRelationshipId ||
            !artifactBody.sync
          ) {
            throw new SharedMemoryAuthorizationError(
              "Owner-private remote replica binding is invalid"
            );
          }
          const replicaState = await loadActiveReplicaState(client, {
            logicalMemoryId,
            remoteReplicaId,
            ownerUserId: actor.userId,
            ownerPrincipalId: owner.ownerPrincipalId,
            syncRelationshipId: artifact.syncRelationshipId
          });
          if (
            replicaState.sourceCursor < preview.sourceRevision ||
            replicaState.localReplicaId !== remoteReplicaId ||
            artifactBody.sync.relationshipId !== artifact.syncRelationshipId ||
            artifactBody.sync.localReplicaId !== remoteReplicaId ||
            artifactBody.sync.remoteReplicaId !==
              replicaState.remoteSyncReplicaId ||
            artifactBody.sync.localSessionId !== replicaState.localSessionId ||
            artifactBody.sync.sourceDeploymentIdentityId !==
              replicaState.sourceDeploymentIdentityId ||
            artifactBody.sync.remoteUserIdentityId !==
              replicaState.remoteUserIdentityId ||
            artifactBody.sync.deviceCredentialId !==
              replicaState.deviceCredentialId ||
            artifactBody.sync.deviceProvenanceHash !==
              replicaState.deviceProvenanceHash ||
            preview.deviceProvenanceHash !== replicaState.deviceProvenanceHash
          ) {
            throw new SharedMemoryAuthorizationError(
              "Owner-private remote replica binding is invalid"
            );
          }
        } else if (
          artifact.source?.kind !== "personal_note" ||
          remoteReplicaId !== null ||
          artifact.syncRelationshipId !== null ||
          artifactBody.sync !== undefined
        ) {
          throw new SharedMemoryAuthorizationError(
            "Standalone Personal Note binding is invalid"
          );
        }
        const policies = await requireCurrentPolicies(client, {
          logicalMemoryId,
          ownerPrincipalId: owner.ownerPrincipalId,
          teamId,
          teamWorkspaceId
        });
        if (
          policies.maximumFidelity !== input.maximumFidelity ||
          policies.includeCuratedMemory !== input.includeCuratedMemory ||
          !sharedMemoryCeilingAuthorizes(
            input.maximumFidelity,
            preview.representation,
            input.includeCuratedMemory
          ) ||
          artifact.maximumFidelity !== input.maximumFidelity ||
          artifact.includeCuratedMemory !== input.includeCuratedMemory ||
          stringValue(policies.owner.policy_id) !==
            artifact.sourceOwnerPolicyId ||
          numberValue(policies.owner.version) !==
            artifact.sourceOwnerPolicyVersion ||
          stringValue(policies.team.policy_id) !== artifact.teamPolicyId ||
          numberValue(policies.team.version) !== artifact.teamPolicyVersion ||
          stringValue(policies.workspace.policy_id) !==
            artifact.workspacePolicyId ||
          numberValue(policies.workspace.version) !==
            artifact.workspacePolicyVersion ||
          preview.binding.fidelityPolicyRevision !==
            artifact.representationPolicyRevision ||
          preview.binding.fidelityPolicyHash !==
            artifact.representationPolicyHash ||
          preview.binding.contentPolicyVersion !==
            artifact.contentPolicyVersion ||
          preview.binding.contentPolicyHash !== artifact.contentPolicyHash ||
          preview.binding.classifierVersion !== artifact.classifierVersion ||
          preview.binding.classifierHash !== artifact.classifierHash
        ) {
          throw new SharedMemoryConflictError(
            "Consent fidelity must match the exact three-policy intersection"
          );
        }
        const existing = await client.query(
          `select consent.*,binding.source_kind,binding.source_session_id,
                  binding.source_note_id,binding.source_memory_event_id
             from source_owner_representation_consents consent
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=consent.source_revision_id
            where consent.id=$1 for update of consent`,
          [input.consentId]
        );
        if (existing.rows[0]) {
          if (
            !sameConsentCreate(existing.rows[0] as Row, {
              logicalMemoryId,
              remoteReplicaId,
              teamId,
              teamWorkspaceId,
              mode: input.mode,
              maximumFidelity: input.maximumFidelity,
              includeCuratedMemory: input.includeCuratedMemory,
              preview: input.preview
            })
          )
            throw new SharedMemoryConflictError("Consent idempotency conflict");
          return mapConsent(existing.rows[0] as Row);
        }
        const inserted = await client.query(
          `insert into source_owner_representation_consents (
           id,preview_id,logical_memory_id,source_revision_id,remote_replica_id,source_owner_principal_id,
           team_id,team_workspace_id,source_owner_policy_id,source_owner_policy_version,
           team_policy_id,team_policy_version,workspace_policy_id,workspace_policy_version,
           mode,state,consent_version,maximum_fidelity,include_curated_memory,
           preview_revision,preview_hash,source_revision,maximum_authorized_source_revision,
           source_hash,fidelity_policy_revision,fidelity_policy_hash,
           content_policy_version,content_policy_hash,classifier_version,classifier_hash,
          source_content_hash,activated_at,expires_at,
           source_capabilities,activation_representation
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active',1,
           $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
           $26,$27,$28,$29,now(),$30,$31,$32
         ) returning *`,
          [
            input.consentId,
            input.preview.previewId,
            logicalMemoryId,
            preview.sourceRevisionId,
            remoteReplicaId,
            owner.ownerPrincipalId,
            teamId,
            teamWorkspaceId,
            artifact.sourceOwnerPolicyId,
            artifact.sourceOwnerPolicyVersion,
            artifact.teamPolicyId,
            artifact.teamPolicyVersion,
            artifact.workspacePolicyId,
            artifact.workspacePolicyVersion,
            input.mode,
            input.maximumFidelity,
            input.includeCuratedMemory,
            preview.previewRevision,
            input.preview.previewHash,
            preview.sourceRevision,
            input.mode === "snapshot" ? preview.sourceRevision : null,
            preview.sourceHash,
            artifact.representationPolicyRevision,
            artifact.representationPolicyHash,
            artifact.contentPolicyVersion,
            artifact.contentPolicyHash,
            artifact.classifierVersion,
            artifact.classifierHash,
            preview.sourceContentHash,
            input.expiresAt ?? null,
            preview.sourceCapabilities,
            preview.activationRepresentation
          ]
        );
        return mapConsent({
          ...(inserted.rows[0] as Row),
          source_kind: artifact.source?.kind,
          source_session_id:
            artifact.source?.kind === "captured_session"
              ? artifact.source.sessionId
              : null,
          source_note_id:
            artifact.source?.kind === "personal_note"
              ? artifact.source.noteId
              : null,
          source_memory_event_id:
            artifact.source?.kind === "personal_note"
              ? artifact.source.memoryEventId
              : null
        });
      };
      if (transactionClient) return command(transactionClient);
      return withTransaction(pool, async (client) => {
        await activatePreviewSourceOwnerPolicy(client, actor, input);
        return command(client);
      });
    },

    async createShareGrant(actor, input, transactionClient?: pg.PoolClient) {
      assertUuid(input.mutationId, "mutationId");
      assertUuid(input.logicalGrantId, "logicalGrantId");
      const command = async (client: pg.PoolClient) => {
        const consentResult = await client.query(
          `select c.*,lm.owner_user_id,binding.source_kind,
                  binding.source_session_id,binding.source_note_id,
                  binding.source_memory_event_id
           from source_owner_representation_consents c
           join logical_memories lm on lm.id=c.logical_memory_id
           join logical_memory_source_revision_bindings binding
             on binding.source_revision_id=c.source_revision_id
          where c.id=$1 and c.state='active' and c.revoked_at is null
            and (c.expires_at is null or c.expires_at>now())
          for update of c`,
          [input.consentId]
        );
        const consent = consentResult.rows[0] as Row | undefined;
        if (!consent || consent.owner_user_id !== actor.userId)
          throw new SharedMemoryAuthorizationError(
            "Only the source owner may create a Share Grant"
          );
        const existing = await client.query(
          `select grant_row.*,binding.source_kind,binding.source_session_id,
                  binding.source_note_id,binding.source_memory_event_id
             from team_memory_share_grants grant_row
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=grant_row.source_revision_id
            where grant_row.logical_grant_id=$1 for update of grant_row`,
          [input.logicalGrantId]
        );
        if (existing.rows[0]) {
          const row = existing.rows[0] as Row;
          if (
            row.consent_id !== input.consentId ||
            row.owner_user_id !== actor.userId
          )
            throw new SharedMemoryConflictError(
              "Share Grant idempotency conflict"
            );
          if (input.internalPendingShareId) {
            const pending = await client.query<Row>(
              `select 1 from pending_share_operation_records
                where id=$1 and owner_user_id=$2 and grant_id=$3
                  and consent_id=$4 and logical_grant_id=$5
                  and state in ('preparing','activated') and revoked_at is null`,
              [
                input.internalPendingShareId,
                actor.userId,
                row.id,
                input.consentId,
                input.logicalGrantId
              ]
            );
            if (!pending.rows[0]) {
              throw new SharedMemoryAuthorizationError(
                "Pending Share internal grant replay is invalid"
              );
            }
          } else {
            await requireRecordedShareAuthority(client, actor, {
              teamId: stringValue(row.team_id),
              teamWorkspaceId: stringValue(row.team_workspace_id),
              authority: input.authority,
              recordedAuthority: stringValue(row.creator_authority),
              delegatedDeviceActionGrant
            });
          }
          return mapGrant(row);
        }
        const destination = await client.query(
          `select id from team_memory_share_grants
           where logical_memory_id=$1 and team_workspace_id=$2
           for update`,
          [consent.logical_memory_id, consent.team_workspace_id]
        );
        if (destination.rows[0]) {
          throw new SharedMemoryConflictError(
            "This logical memory already has a Share Grant for the destination Workspace"
          );
        }
        let authority: string;
        if (input.internalPendingShareId) {
          const pending = await client.query<Row>(
            `select authority_reference_id from pending_share_operations
              where id=$1 and owner_user_id=$2 and logical_memory_id=$3
                and team_id=$4 and team_workspace_id=$5
                and consent_id=$6 and logical_grant_id=$7
                and state='preparing' and revoked_at is null
              limit 1 for update`,
            [
              input.internalPendingShareId,
              actor.userId,
              consent.logical_memory_id,
              consent.team_id,
              consent.team_workspace_id,
              input.consentId,
              input.logicalGrantId
            ]
          );
          if (!pending.rows[0]) {
            throw new SharedMemoryAuthorizationError(
              "Pending Share internal grant authority is invalid"
            );
          }
          authority = `pending_share:${stringValue(
            pending.rows[0].authority_reference_id
          )}`;
        } else {
          authority = await requireShareAuthority(client, actor, {
            teamId: stringValue(consent.team_id),
            teamWorkspaceId: stringValue(consent.team_workspace_id),
            authority: input.authority,
            consume: true,
            delegatedDeviceActionGrant
          });
        }
        const policies = await requireCurrentPolicies(client, {
          logicalMemoryId: stringValue(consent.logical_memory_id),
          ownerPrincipalId: stringValue(consent.source_owner_principal_id),
          teamId: stringValue(consent.team_id),
          teamWorkspaceId: stringValue(consent.team_workspace_id)
        });
        const consentFidelity = fidelityConsentFromRow(consent);
        if (
          policies.maximumFidelity !== consentFidelity.maximumFidelity ||
          policies.includeCuratedMemory !== consentFidelity.includeCuratedMemory
        )
          throw new SharedMemoryConflictError(
            "Consent is no longer in the exact fidelity policy intersection"
          );
        const retentionPolicy = await client.query(
          `select 1 from retention_policies
            where effective_at <= transaction_timestamp()
              and (superseded_at is null
                or superseded_at > transaction_timestamp())
              and (
                (scope = 'workspace' and team_id = $1
                  and team_workspace_id = $2)
                or (scope = 'team' and team_id = $1)
              )
            limit 1
            for share`,
          [consent.team_id, consent.team_workspace_id]
        );
        if (!retentionPolicy.rowCount) {
          throw new SharedMemoryConflictError(
            "A Team or Workspace retention policy is required before sharing"
          );
        }
        let inserted: pg.QueryResult<Row>;
        try {
          inserted = await client.query<Row>(
            `insert into team_memory_share_grants (
           logical_grant_id,logical_memory_id,source_revision_id,remote_replica_id,
           owner_user_id,owner_principal_id,team_id,team_workspace_id,consent_id,
           display_title,
           source_owner_policy_id,source_owner_policy_version,team_policy_id,
           team_policy_version,workspace_policy_id,workspace_policy_version,
           maximum_fidelity,include_curated_memory,
           fidelity_policy_revision,content_policy_version,classifier_version,
           source_revision,grant_version,lifecycle,creator_authority,granted_by_user_id,
           source_capabilities,activation_representation,mode
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           $17,$18,$19,$20,$21,$22,1,$23,$24,$5,$25,$26,$27
           ) returning *`,
            [
              input.logicalGrantId,
              consent.logical_memory_id,
              consent.source_revision_id,
              consent.remote_replica_id,
              actor.userId,
              consent.source_owner_principal_id,
              consent.team_id,
              consent.team_workspace_id,
              consent.id,
              null,
              consent.source_owner_policy_id,
              consent.source_owner_policy_version,
              consent.team_policy_id,
              consent.team_policy_version,
              consent.workspace_policy_id,
              consent.workspace_policy_version,
              consent.maximum_fidelity,
              consent.include_curated_memory,
              consent.fidelity_policy_revision,
              consent.content_policy_version,
              consent.classifier_version,
              consent.source_revision,
              input.internalPendingShareId ? "unavailable" : "active",
              authority,
              consent.source_capabilities,
              consent.activation_representation,
              consent.mode
            ]
          );
        } catch (error) {
          if (
            isUniqueViolation(
              error,
              "team_memory_share_grants_destination_unique"
            )
          ) {
            throw new SharedMemoryConflictError(
              "This logical memory already has a Share Grant for the destination Workspace"
            );
          }
          throw error;
        }
        const row = inserted.rows[0] as Row;
        Object.assign(row, {
          source_kind: consent.source_kind,
          source_session_id: consent.source_session_id,
          source_note_id: consent.source_note_id,
          source_memory_event_id: consent.source_memory_event_id
        });
        if (input.internalPendingShareId) {
          await client.query(
            `update pending_share_operations
                set grant_id=$2,stage='activating',last_progress_at=now(),
                    updated_at=now()
              where id=$1 and state='preparing'`,
            [input.internalPendingShareId, row.id]
          );
        }
        await appendOutbox(client, {
          mutationId: input.mutationId,
          family: "share_grant_lifecycle",
          teamId: stringValue(row.team_id),
          teamWorkspaceId: stringValue(row.team_workspace_id),
          shareGrantId: stringValue(row.id),
          logicalMemoryId: stringValue(row.logical_memory_id),
          resourceType: "team_memory_share_grant",
          resourceId: stringValue(row.id),
          actorPrincipalId: actor.userId
        });
        return mapGrant(row);
      };
      return transactionClient
        ? command(transactionClient)
        : withTransaction(pool, command);
    },

    async selectGrantFidelity(actor, input, transactionClient?: pg.PoolClient) {
      assertUuid(input.mutationId, "mutationId");
      const command = async (client: pg.PoolClient) => {
        await lockShareGrantRetentionScopeWithClient(
          client,
          input.shareGrantId
        );
        const grantResult = await client.query(
          `select grant_row.*,binding.source_kind,binding.source_session_id,
                  binding.source_note_id,binding.source_memory_event_id
             from team_memory_share_grants grant_row
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=grant_row.source_revision_id
            where grant_row.id=$1 for update of grant_row`,
          [input.shareGrantId]
        );
        const grant = grantResult.rows[0] as Row | undefined;
        if (!grant || grant.owner_user_id !== actor.userId)
          throw new SharedMemoryAuthorizationError(
            "Only the source owner may select Shared Memory fidelity"
          );
        if (grant.lifecycle !== "active" && grant.lifecycle !== "revoked") {
          throw new SharedMemoryConflictError(
            "Share Grant cannot be changed after retention purge has started"
          );
        }
        if (numberValue(grant.grant_version) !== input.expectedGrantVersion) {
          const replay = await client.query(
            `select 1 from collaboration_outbox
            where mutation_id=$1
              and family in ('fidelity_changed','source_revision_changed')
              and share_grant_id=$2 and resource_id=$2
              and actor_principal_id=$3 and invalidated_at is null
            limit 1`,
            [input.mutationId, input.shareGrantId, actor.userId]
          );
          if (replay.rows[0] && grant.consent_id === input.consentId) {
            await requireRecordedShareAuthority(client, actor, {
              teamId: stringValue(grant.team_id),
              teamWorkspaceId: stringValue(grant.team_workspace_id),
              authority: input.authority,
              delegatedDeviceActionGrant
            });
            return mapGrant(grant);
          }
          throw new SharedMemoryConflictError();
        }
        if (input.internalPendingShareId) {
          const pending = await client.query(
            `select 1 from pending_share_operation_records
              where id=$1 and owner_user_id=$2 and grant_id=$3
                and replacement_consent_id=$4
                and replacement_expected_grant_version=$5
                and state='preparing' and revoked_at is null
              limit 1`,
            [
              input.internalPendingShareId,
              actor.userId,
              input.shareGrantId,
              input.consentId,
              input.expectedGrantVersion
            ]
          );
          if (!pending.rowCount) {
            throw new SharedMemoryAuthorizationError(
              "Pending representation-change authority is invalid"
            );
          }
        } else {
          await requireShareAuthority(client, actor, {
            teamId: stringValue(grant.team_id),
            teamWorkspaceId: stringValue(grant.team_workspace_id),
            authority: input.authority,
            consume: true,
            delegatedDeviceActionGrant
          });
        }
        const consentResult = await client.query(
          `select consent.*,binding.source_kind,binding.source_session_id,
                  binding.source_note_id,binding.source_memory_event_id
             from source_owner_representation_consents consent
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=consent.source_revision_id
            where consent.id=$1 and consent.logical_memory_id=$2
              and consent.source_owner_principal_id=$3 and consent.team_id=$4
              and consent.team_workspace_id=$5 and consent.state='active'
              and consent.revoked_at is null
              and (consent.expires_at is null or consent.expires_at>now())
            for update of consent`,
          [
            input.consentId,
            grant.logical_memory_id,
            grant.owner_principal_id,
            grant.team_id,
            grant.team_workspace_id
          ]
        );
        const consent = consentResult.rows[0] as Row | undefined;
        if (!consent)
          throw new SharedMemoryConflictError(
            "Replacement consent is not active"
          );
        if (
          consent.maximum_fidelity !== input.maximumFidelity ||
          consent.include_curated_memory !== input.includeCuratedMemory
        ) {
          throw new SharedMemoryConflictError(
            "Replacement consent fidelity does not match the request"
          );
        }
        const replacementEventFamily =
          consent.maximum_fidelity === grant.maximum_fidelity &&
          consent.include_curated_memory === grant.include_curated_memory
            ? "source_revision_changed"
            : "fidelity_changed";
        if (
          consent.source_kind !== grant.source_kind ||
          !sharedMemorySourceCanReplace(
            requiredSourceRefFromRow(grant),
            requiredSourceRefFromRow(consent)
          )
        ) {
          throw new SharedMemoryAuthorizationError(
            "Replacement consent source binding is invalid"
          );
        }
        const policies = await requireCurrentPolicies(client, {
          logicalMemoryId: stringValue(grant.logical_memory_id),
          ownerPrincipalId: stringValue(grant.owner_principal_id),
          teamId: stringValue(grant.team_id),
          teamWorkspaceId: stringValue(grant.team_workspace_id)
        });
        if (
          policies.maximumFidelity !== input.maximumFidelity ||
          policies.includeCuratedMemory !== input.includeCuratedMemory
        )
          throw new SharedMemoryConflictError(
            "Selected fidelity is outside the exact policy intersection"
          );
        if (grant.lifecycle === "revoked") {
          const clock = await client.query<{ now: Date }>(
            "select transaction_timestamp() as now"
          );
          const cancellation =
            await cancelShareGrantRevocationRetentionWithClient(client, {
              shareGrantId: input.shareGrantId,
              actorUserId: actor.userId,
              mutationId: input.mutationId,
              canceledAt: clock.rows[0]!.now
            });
          if (cancellation === "purge_started") {
            throw new SharedMemoryConflictError(
              "Share Grant retention purge has already started"
            );
          }
        }
        await client.query(
          `update team_memory_representations
            set state='invalidated',invalidated_at=now(),updated_at=now(),
                record_version=record_version+1,
                invalidation_reason_code='owner_selected_fidelity_replacement'
          where share_grant_id=$1 and state in ('pending','available','stale')`,
          [input.shareGrantId]
        );
        await client.query(
          `delete from team_memory_semantic_items where share_grant_id=$1`,
          [input.shareGrantId]
        );
        const updated = await client.query(
          `update team_memory_share_grants set
           consent_id=$2,source_owner_policy_id=$3,source_owner_policy_version=$4,
           team_policy_id=$5,team_policy_version=$6,workspace_policy_id=$7,
           workspace_policy_version=$8,maximum_fidelity=$9,
           include_curated_memory=$10,fidelity_policy_revision=$11,
           content_policy_version=$12,classifier_version=$13,source_revision=$14,
           activation_representation=$15,mode=$16,source_capabilities=$17,
           source_revision_id=$18,remote_replica_id=$19,
           lifecycle='active',grant_version=grant_version+1,updated_at=now(),
           revoked_at=null,revoked_by_user_id=null,revocation_reason=null,
           retention_policy_id=null,retention_policy_version=null,
           retention_triggered_at=null,retain_until=null,
           active_retention_decision_id=null,active_purge_job_id=null,
           tombstoned_at=null,purge_completed_at=null
         where id=$1 returning *`,
          [
            input.shareGrantId,
            consent.id,
            consent.source_owner_policy_id,
            consent.source_owner_policy_version,
            consent.team_policy_id,
            consent.team_policy_version,
            consent.workspace_policy_id,
            consent.workspace_policy_version,
            consent.maximum_fidelity,
            consent.include_curated_memory,
            consent.fidelity_policy_revision,
            consent.content_policy_version,
            consent.classifier_version,
            consent.source_revision,
            consent.activation_representation,
            consent.mode,
            consent.source_capabilities,
            consent.source_revision_id,
            consent.remote_replica_id
          ]
        );
        const row = {
          ...(updated.rows[0] as Row),
          ...sourceRefRow(requiredSourceRefFromRow(grant))
        };
        await appendOutbox(client, {
          mutationId: input.mutationId,
          family: replacementEventFamily,
          teamId: stringValue(row.team_id),
          teamWorkspaceId: stringValue(row.team_workspace_id),
          shareGrantId: stringValue(row.id),
          logicalMemoryId: stringValue(row.logical_memory_id),
          resourceType: "team_memory_share_grant",
          resourceId: stringValue(row.id),
          actorPrincipalId: actor.userId
        });
        return mapGrant(row);
      };
      return transactionClient
        ? command(transactionClient)
        : withTransaction(pool, command);
    },

    async revokeShareGrant(actor, input) {
      assertUuid(input.mutationId, "mutationId");
      if (!requiredString(input.reasonCode) || input.reasonCode.length > 120)
        throw new TypeError("reasonCode is required");
      return withTransaction(pool, async (client) => {
        await lockShareGrantRetentionScopeWithClient(
          client,
          input.shareGrantId
        );
        const result = await client.query(
          `select grant_row.*,binding.source_kind,binding.source_session_id,
                  binding.source_note_id,binding.source_memory_event_id
             from team_memory_share_grants grant_row
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=grant_row.source_revision_id
            where grant_row.id=$1 for update of grant_row`,
          [input.shareGrantId]
        );
        const grant = result.rows[0] as Row | undefined;
        if (!grant || grant.owner_user_id !== actor.userId) {
          throw new SharedMemoryAuthorizationError(
            "Only the source owner may revoke this Share Grant"
          );
        }
        if (grant.lifecycle === "revoked") {
          const replay = await client.query(
            `select 1
             where exists (
               select 1 from collaboration_outbox
                where mutation_id=$1 and family='access_revoked'
                  and share_grant_id=$2 and resource_id=$2
                  and actor_principal_id=$3 and invalidated_at is null
             ) or exists (
               select 1 from purge_jobs
                where idempotency_key = 'share-grant:' || $2::text
                  || ':revocation:' || $1::text
             )`,
            [input.mutationId, input.shareGrantId, actor.userId]
          );
          if (!replay.rows[0])
            throw new SharedMemoryConflictError(
              "Share Grant is already revoked"
            );
          if (grant.revocation_reason !== input.reasonCode) {
            throw new SharedMemoryConflictError(
              "Share Grant revocation idempotency conflict"
            );
          }
          if (grant.revoked_by_user_id !== actor.userId) {
            throw new SharedMemoryConflictError(
              "Share Grant revocation idempotency conflict"
            );
          }
          await requireRecordedShareAuthority(client, actor, {
            teamId: stringValue(grant.team_id),
            teamWorkspaceId: stringValue(grant.team_workspace_id),
            authority: input.authority,
            delegatedDeviceActionGrant,
            requireSharePermission: false
          });
          await cascadeParentShareRevocation(client, {
            shareGrantId: input.shareGrantId,
            actorUserId: actor.userId,
            mutationId: input.mutationId,
            revokedAt: grant.revoked_at as Date
          });
          return mapGrant(grant);
        }
        const reusedMutation = await client.query(
          `select 1 from purge_jobs
            where idempotency_key = 'share-grant:' || $1::text
              || ':revocation:' || $2::text
            limit 1`,
          [input.shareGrantId, input.mutationId]
        );
        if (reusedMutation.rowCount) {
          throw new SharedMemoryConflictError(
            "Share Grant revocation mutation was already used"
          );
        }
        await requireShareAuthority(client, actor, {
          teamId: stringValue(grant.team_id),
          teamWorkspaceId: stringValue(grant.team_workspace_id),
          authority: input.authority,
          consume: true,
          delegatedDeviceActionGrant,
          requireSharePermission: false
        });
        if (numberValue(grant.grant_version) !== input.expectedGrantVersion)
          throw new SharedMemoryConflictError();
        const clock = await client.query<{ now: Date }>(
          "select transaction_timestamp() as now"
        );
        const revokedAt = clock.rows[0]!.now;
        const updated = await client.query(
          `update team_memory_share_grants
            set lifecycle='revoked',grant_version=grant_version+1,updated_at=now(),
                revocation_epoch=revocation_epoch+1,
                revoked_at=$4,revoked_by_user_id=$2,revocation_reason=$3
          where id=$1 returning *`,
          [input.shareGrantId, actor.userId, input.reasonCode, revokedAt]
        );
        await client.query(
          `update team_memory_representations
            set state='invalidated',invalidated_at=now(),updated_at=now(),
                record_version=record_version+1,invalidation_reason_code='share_revoked'
          where share_grant_id=$1 and state in ('pending','available','stale')`,
          [input.shareGrantId]
        );
        await client.query(
          `delete from team_memory_semantic_items where share_grant_id=$1`,
          [input.shareGrantId]
        );
        const row = {
          ...(updated.rows[0] as Row),
          ...sourceRefRow(requiredSourceRefFromRow(grant))
        };
        await cascadeParentShareRevocation(client, {
          shareGrantId: input.shareGrantId,
          actorUserId: actor.userId,
          mutationId: input.mutationId,
          revokedAt
        });
        await scheduleShareGrantRevocationRetentionWithClient(client, {
          shareGrantId: input.shareGrantId,
          actorUserId: actor.userId,
          mutationId: input.mutationId,
          revocationEpoch: numberValue(row.revocation_epoch),
          triggeredAt: revokedAt
        });
        await appendOutbox(client, {
          mutationId: input.mutationId,
          family: "access_revoked",
          teamId: stringValue(row.team_id),
          teamWorkspaceId: stringValue(row.team_workspace_id),
          shareGrantId: stringValue(row.id),
          logicalMemoryId: stringValue(row.logical_memory_id),
          resourceType: "team_memory_share_grant",
          resourceId: stringValue(row.id),
          actorPrincipalId: actor.userId
        });
        return mapGrant(row);
      });
    },

    async listPendingSemanticPrivacyTargets(input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 32, 1), 100);
      if (input.shareGrantId) {
        assertUuid(input.shareGrantId, "shareGrantId");
      }
      if (input.sourcePreviewId) {
        assertUuid(input.sourcePreviewId, "sourcePreviewId");
      }
      return withTransaction(pool, async (client) => {
        const classifier = await loadActivePrivacyClassifier(client);
        const candidates = await client.query<Row>(
          `select preview.id as source_preview_id,
                  preview.source_artifact_id,
                  preview.preview_revision as source_preview_revision,
                  preview.preview_hash as source_preview_hash,
                  artifact.artifact_hash as source_artifact_hash,
                  artifact.manifest_hash as source_manifest_hash,
                  preview.source_revision,preview.source_hash,
                  preview.logical_memory_id,preview.owner_user_id,
                  preview.owner_principal_id,preview.team_id,
                  preview.team_workspace_id,preview.representation,
                  g.id as share_grant_id,c.id as consent_id,g.grant_version,
                  g.lifecycle as grant_lifecycle
             from shared_source_preview_records preview
             join shared_source_artifact_records artifact
               on artifact.id=preview.source_artifact_id
              and artifact.logical_memory_id=preview.logical_memory_id
              and artifact.remote_replica_id is not distinct from preview.remote_replica_id
              and artifact.owner_user_id=preview.owner_user_id
              and artifact.owner_principal_id=preview.owner_principal_id
              and artifact.team_id=preview.team_id
              and artifact.team_workspace_id=preview.team_workspace_id
              and artifact.representation=preview.representation
              and artifact.source_revision=preview.source_revision
              and artifact.source_hash=preview.source_hash
              and artifact.invalidated_at is null
             join team_memory_share_grant_records g
               on g.logical_memory_id=preview.logical_memory_id
              and g.remote_replica_id is not distinct from preview.remote_replica_id
              and g.owner_user_id=preview.owner_user_id
              and g.owner_principal_id=preview.owner_principal_id
              and g.team_id=preview.team_id
              and g.team_workspace_id=preview.team_workspace_id
              and g.revoked_at is null
              and (
                g.lifecycle='active'
                or (g.lifecycle='unavailable' and exists (
                  select 1 from pending_share_operation_records pending
                   where pending.grant_id=g.id
                     and pending.owner_user_id=g.owner_user_id
                     and pending.consent_id=g.consent_id
                     and pending.state='preparing'
                     and pending.stage in ('activating','privacy_filtering')
                     and pending.revoked_at is null
                ))
              )
             ${semanticPrivacyConsentJoinSql()}
             join users owner on owner.id=preview.owner_user_id
              and owner.disabled_at is null and owner.deleted_at is null
             join teams team on team.id=preview.team_id
              and team.lifecycle='active'
              and team.entitlement_status in ('active','grace')
             join team_memberships membership
               on membership.team_id=preview.team_id
              and membership.user_id=preview.owner_user_id
              and membership.status='enabled' and membership.disabled_at is null
             join team_workspaces workspace
               on workspace.id=preview.team_workspace_id
              and workspace.team_id=preview.team_id
              and workspace.lifecycle='active' and workspace.archived_at is null
             join team_workspace_access_grants access
               on access.team_workspace_id=preview.team_workspace_id
              and access.team_id=preview.team_id
              and access.user_id=preview.owner_user_id
              and access.access='write'
              and access.can_share_owned_memory=true
              and access.disabled_at is null
             join source_owner_representation_policies op
               on op.policy_id=g.source_owner_policy_id
              and op.version=g.source_owner_policy_version
              and op.superseded_at is null
             join team_representation_policies tp
               on tp.policy_id=g.team_policy_id and tp.version=g.team_policy_version
              and tp.team_id=g.team_id and tp.superseded_at is null
             join workspace_representation_policies wp
               on wp.policy_id=g.workspace_policy_id
              and wp.version=g.workspace_policy_version
              and wp.team_id=g.team_id
              and wp.team_workspace_id=g.team_workspace_id
              and wp.superseded_at is null
            where preview.invalidated_at is null
              and preview.owner_user_id is not null
              and ($2::uuid is null or g.id=$2)
              and ($3::uuid is null or preview.id=$3)
              and ${cumulativeRepresentationAuthorizationSql("preview.representation")}
            order by preview.created_at,preview.id
            limit $1`,
          [
            Math.min(limit * 8, 800),
            input.shareGrantId ?? null,
            input.sourcePreviewId ?? null
          ]
        );
        const targets: SharedMemoryPendingSemanticTarget[] = [];
        const seenTargetIds = new Set<string>();
        const candidateByPreviewId = new Map<
          string,
          { row: Row; effectivePolicyHash: string }
        >();
        for (const candidate of candidates.rows) {
          const effectivePolicy = await resolveCurrentPrivacyPolicy(client, {
            ownerUserId: stringValue(candidate.owner_user_id),
            teamId: stringValue(candidate.team_id),
            teamWorkspaceId: stringValue(candidate.team_workspace_id)
          });
          const superseded = await client.query<Row>(
            `update shared_source_semantic_previews
                set status='stale',stale_at=now(),updated_at=now(),
                    invalidation_reason_code='privacy_binding_superseded'
              where source_preview_id=$1 and status='ready'
                and invalidated_at is null
                and (classifier_generation_id<>$2
                  or effective_privacy_policy_hash<>$3)
              returning *`,
            [
              candidate.source_preview_id,
              classifier.id,
              effectivePolicy.effectivePolicyHash
            ]
          );
          await invalidateSemanticDerivativeDependentsWithClient(
            client,
            superseded.rows,
            "privacy_binding_superseded"
          );
          let workReason: SharedMemorySemanticPreviewRecord["workReason"] =
            "share_activation";
          if (superseded.rows.length > 0) {
            workReason = superseded.rows.some(
              (row) =>
                stringValue(row.classifier_generation_id) !== classifier.id
            )
              ? "classifier_rematerialization"
              : "policy_remasking";
          } else {
            const priorRevision = await client.query(
              `select 1 from shared_source_semantic_previews
                where logical_memory_id=$1 and owner_user_id=$2
                  and team_id=$3 and team_workspace_id=$4
                  and representation=$5 and source_revision<$6
                limit 1`,
              [
                candidate.logical_memory_id,
                candidate.owner_user_id,
                candidate.team_id,
                candidate.team_workspace_id,
                candidate.representation,
                candidate.source_revision
              ]
            );
            if (priorRevision.rows[0]) {
              workReason = "source_revision_classification";
            }
          }
          const semanticPreviewId = randomUUID();
          candidateByPreviewId.set(stringValue(candidate.source_preview_id), {
            row: candidate,
            effectivePolicyHash: effectivePolicy.effectivePolicyHash
          });
          await client.query(
            `insert into shared_source_semantic_previews (
               id,source_preview_id,source_artifact_id,
               source_preview_revision,source_preview_hash,source_artifact_hash,
               source_manifest_hash,source_revision,source_hash,logical_memory_id,
               owner_user_id,owner_principal_id,team_id,team_workspace_id,
               representation,classifier_generation_id,classifier_version,
               classifier_hash,effective_privacy_policy_hash,
               scheduling_class,work_reason,status
             ) values (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               'pending'
             )
             on conflict do nothing`,
            [
              semanticPreviewId,
              candidate.source_preview_id,
              candidate.source_artifact_id,
              candidate.source_preview_revision,
              candidate.source_preview_hash,
              candidate.source_artifact_hash,
              candidate.source_manifest_hash,
              candidate.source_revision,
              candidate.source_hash,
              candidate.logical_memory_id,
              candidate.owner_user_id,
              candidate.owner_principal_id,
              candidate.team_id,
              candidate.team_workspace_id,
              candidate.representation,
              classifier.id,
              classifier.version,
              classifier.classifierHash,
              effectivePolicy.effectivePolicyHash,
              "foreground",
              workReason
            ]
          );
        }
        if (candidateByPreviewId.size === 0) return targets;
        const pending = await client.query<Row>(
          `select semantic.*
               from shared_source_semantic_previews semantic
              where semantic.source_preview_id=any($1::uuid[])
                and semantic.classifier_generation_id=$2
                and semantic.status='pending'
                and semantic.eligible_at<=now()
                and (semantic.next_attempt_at is null
                  or semantic.next_attempt_at<=now())
                and not exists (
                  select 1 from shared_source_semantic_privacy_work_claims claim
                   where claim.semantic_preview_id=semantic.id
                     and claim.state='active' and claim.expires_at>now()
                )
              order by
                case
                  when semantic.scheduling_class='background'
                    and semantic.enqueued_at<=now()-interval '2 minutes' then 0
                  when semantic.scheduling_class='foreground' then 1
                  else 2
                end,
                semantic.eligible_at,semantic.enqueued_at,semantic.id
              limit $3`,
          [
            [...candidateByPreviewId.keys()],
            classifier.id,
            Math.min(limit * 8, 800)
          ]
        );
        for (const row of pending.rows) {
          if (targets.length >= limit) break;
          const candidate = candidateByPreviewId.get(
            stringValue(row.source_preview_id)
          );
          if (
            !candidate ||
            stringValue(row.effective_privacy_policy_hash) !==
              candidate.effectivePolicyHash
          ) {
            continue;
          }
          const target = mapPendingSemanticTarget({
            ...row,
            share_grant_id: candidate.row.share_grant_id,
            consent_id: candidate.row.consent_id,
            grant_version: candidate.row.grant_version
          });
          if (!seenTargetIds.has(target.id)) {
            seenTargetIds.add(target.id);
            targets.push(target);
          }
        }
        return targets;
      });
    },

    async readPendingSemanticPrivacyTarget(actor, input) {
      assertUuid(input.semanticPreviewId, "semanticPreviewId");
      assertHash(input.expectedSourcePreviewHash, "expectedSourcePreviewHash");
      assertHash(
        input.expectedSourceArtifactHash,
        "expectedSourceArtifactHash"
      );
      assertHash(
        input.expectedSourceManifestHash,
        "expectedSourceManifestHash"
      );
      assertHash(input.expectedClassifierHash, "expectedClassifierHash");
      assertHash(
        input.expectedEffectivePrivacyPolicyHash,
        "expectedEffectivePrivacyPolicyHash"
      );
      return withTransaction(pool, async (client) => {
        await client.query(
          "set transaction isolation level repeatable read read only"
        );
        const loaded = await loadAuthorizedPendingSemanticTarget(
          client,
          actor,
          input.semanticPreviewId,
          false
        );
        if (!loaded) return null;
        if (
          loaded.target.sourcePreviewHash !== input.expectedSourcePreviewHash ||
          loaded.target.sourceArtifactHash !==
            input.expectedSourceArtifactHash ||
          loaded.target.sourceManifestHash !==
            input.expectedSourceManifestHash ||
          loaded.target.classifierHash !== input.expectedClassifierHash ||
          loaded.target.effectivePrivacyPolicyHash !==
            input.expectedEffectivePrivacyPolicyHash
        ) {
          throw new SharedMemoryConflictError(
            "Pending semantic privacy target binding changed"
          );
        }
        const preview = await loadPersistedPreviewByReference(client, {
          preview: {
            previewId: loaded.target.sourcePreviewId,
            previewHash: loaded.target.sourcePreviewHash
          },
          requiredMessage:
            "Pending semantic privacy target source preview is unavailable"
        });
        if (
          preview.artifact.artifactId !== loaded.target.sourceArtifactId ||
          preview.artifact.artifactHash !== loaded.target.sourceArtifactHash ||
          preview.artifact.manifestHash !== loaded.target.sourceManifestHash ||
          preview.preview.sourceRevision !== loaded.target.sourceRevision ||
          preview.preview.sourceHash !== loaded.target.sourceHash
        ) {
          throw new SharedMemoryConflictError(
            "Pending semantic privacy target source binding mismatch"
          );
        }
        return {
          target: loaded.target,
          preview: preview.preview,
          sourceManifest: preview.artifactBody.manifest,
          sourceItemIdentityHash: sharedMemorySourceItemIdentityHash(
            preview.preview.items
          ),
          classificationFields: extractSharedMemorySemanticClassificationFields(
            preview.preview.items
          )
        };
      });
    },

    async claimSemanticPrivacyTarget(actor, input) {
      assertUuid(input.semanticPreviewId, "semanticPreviewId");
      assertHash(input.expectedWorkIdentity, "expectedWorkIdentity");
      if (!input.claimantId.trim() || input.claimantId.length > 200) {
        throw new TypeError("claimantId is invalid");
      }
      if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000) {
        throw new TypeError("leaseMs must be at least 1000");
      }
      return withTransaction(pool, async (client) => {
        const loaded = await loadAuthorizedPendingSemanticTarget(
          client,
          actor,
          input.semanticPreviewId,
          true,
          true
        );
        if (!loaded) return null;
        if (
          sharedMemorySemanticPrivacyWorkIdentity(loaded.target) !==
          input.expectedWorkIdentity
        ) {
          throw new SharedMemoryConflictError(
            "Semantic privacy work identity changed"
          );
        }
        const existing = await client.query<Row>(
          `select claim.*,
                  (claim.state='active' and claim.expires_at>now()) as lease_active
             from shared_source_semantic_privacy_work_claims claim
            where semantic_preview_id=$1 for update`,
          [input.semanticPreviewId]
        );
        const prior = existing.rows[0];
        if (prior?.lease_active === true) {
          return null;
        }
        const generation = prior ? numberValue(prior.claim_generation) + 1 : 1;
        const claimToken = randomUUID();
        const claimed = await client.query<Row>(
          `insert into shared_source_semantic_privacy_work_claims (
             id,semantic_preview_id,work_identity,claimant_id,claim_generation,
             claim_token,state,created_at,heartbeat_at,expires_at
           ) values ($1,$2,$3,$4,$5,$6,'active',now(),now(),
             now()+($7::integer * interval '1 millisecond'))
           on conflict (semantic_preview_id) do update set
             work_identity=excluded.work_identity,
             claimant_id=excluded.claimant_id,
             claim_generation=excluded.claim_generation,
             claim_token=excluded.claim_token,
             state='active',created_at=now(),heartbeat_at=now(),
             expires_at=excluded.expires_at,released_at=null,completed_at=null
           returning *`,
          [
            randomUUID(),
            input.semanticPreviewId,
            input.expectedWorkIdentity,
            input.claimantId,
            generation,
            claimToken,
            input.leaseMs
          ]
        );
        const row = claimed.rows[0]!;
        return {
          semanticPreviewId: input.semanticPreviewId,
          workIdentity: input.expectedWorkIdentity,
          claimantId: input.claimantId,
          claimGeneration: generation,
          claimToken,
          expiresAt: iso(row.expires_at)
        };
      });
    },

    async renewSemanticPrivacyClaim(actor, input) {
      assertUuid(input.semanticPreviewId, "semanticPreviewId");
      assertUuid(input.claimToken, "claimToken");
      const renewed = await pool.query<Row>(
        `update shared_source_semantic_privacy_work_claims claim
            set heartbeat_at=now(),
                expires_at=now()+($6::integer * interval '1 millisecond')
           from shared_source_semantic_previews semantic
          where claim.semantic_preview_id=$1 and claim.claim_token=$2
            and claim.claim_generation=$3 and claim.claimant_id=$4
            and claim.work_identity=$5 and claim.state='active'
            and claim.expires_at>now()
            and semantic.id=claim.semantic_preview_id
            and semantic.owner_user_id=$7 and semantic.status='pending'
          returning claim.*`,
        [
          input.semanticPreviewId,
          input.claimToken,
          input.claimGeneration,
          input.claimantId,
          input.workIdentity,
          input.leaseMs,
          actor.userId
        ]
      );
      const row = renewed.rows[0];
      return row ? { ...input, expiresAt: iso(row.expires_at) } : null;
    },

    async releaseSemanticPrivacyClaim(actor, input) {
      return withTransaction(pool, async (client) => {
        const released = await client.query(
          `update shared_source_semantic_privacy_work_claims claim
              set state=$6,released_at=case when $7::boolean then null else now() end,
                  completed_at=case when $7::boolean then now() else null end
             from shared_source_semantic_previews semantic
            where claim.semantic_preview_id=$1 and claim.claim_token=$2
              and claim.claim_generation=$3 and claim.claimant_id=$4
              and claim.work_identity=$5 and claim.state='active'
              and claim.expires_at>now() and semantic.id=claim.semantic_preview_id
              and semantic.owner_user_id=$8`,
          [
            input.semanticPreviewId,
            input.claimToken,
            input.claimGeneration,
            input.claimantId,
            input.workIdentity,
            input.completed ? "completed" : "released",
            input.completed,
            actor.userId
          ]
        );
        if ((released.rowCount ?? 0) !== 1) return false;
        if (!input.completed) {
          await client.query(
            `update shared_source_semantic_previews
                set continuation_chunk_index=$2,eligible_at=now(),updated_at=now()
              where id=$1 and owner_user_id=$3 and status='pending'`,
            [input.semanticPreviewId, input.nextChunkIndex, actor.userId]
          );
        }
        return true;
      });
    },

    async initializeSemanticPrivacyManifest(actor, input) {
      assertHash(input.expectedManifestHash, "expectedManifestHash");
      if (
        input.chunks.length < 1 ||
        !Number.isSafeInteger(input.fieldCount) ||
        input.fieldCount < 1 ||
        input.fieldCount > SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_FIELDS ||
        !Number.isSafeInteger(input.fieldByteCount) ||
        input.fieldByteCount < 0 ||
        input.fieldByteCount > SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_BYTES
      ) {
        throw new TypeError("Semantic privacy manifest must contain fields");
      }
      let nextFieldIndex = 0;
      for (const [index, chunk] of input.chunks.entries()) {
        assertHash(chunk.inputIdentityHash, "inputIdentityHash");
        assertHash(chunk.orderedInputHash, "orderedInputHash");
        if (
          chunk.chunkIndex !== index ||
          chunk.firstFieldIndex !== nextFieldIndex ||
          !Number.isSafeInteger(chunk.fieldCount) ||
          chunk.fieldCount < 1 ||
          chunk.fieldCount > 16
        ) {
          throw new SharedMemoryConflictError(
            "Semantic privacy manifest field ranges are invalid"
          );
        }
        nextFieldIndex += chunk.fieldCount;
      }
      if (nextFieldIndex !== input.fieldCount) {
        throw new SharedMemoryConflictError(
          "Semantic privacy manifest does not cover every field"
        );
      }
      return withTransaction(pool, async (client) => {
        const claim = await client.query<Row>(
          `select claim.* from shared_source_semantic_privacy_work_claims claim
             join shared_source_semantic_previews semantic
               on semantic.id=claim.semantic_preview_id
            where claim.semantic_preview_id=$1 and claim.claim_token=$2
              and claim.claim_generation=$3 and claim.work_identity=$4
              and claim.state='active' and claim.expires_at>now()
              and semantic.owner_user_id=$5 and semantic.status='pending'
            for update of semantic,claim`,
          [
            input.claim.semanticPreviewId,
            input.claim.claimToken,
            input.claim.claimGeneration,
            input.claim.workIdentity,
            actor.userId
          ]
        );
        if (!claim.rows[0]) {
          throw new SharedMemoryConflictError("Semantic privacy claim expired");
        }
        for (const chunk of input.chunks) {
          await client.query(
            `insert into shared_source_semantic_preview_classification_chunks (
               id,semantic_preview_id,chunk_index,first_field_index,field_count,
               input_identity_hash,ordered_input_hash,status
             ) values ($1,$2,$3,$4,$5,$6,$7,'pending')
             on conflict (semantic_preview_id,chunk_index) do nothing`,
            [
              randomUUID(),
              input.claim.semanticPreviewId,
              chunk.chunkIndex,
              chunk.firstFieldIndex,
              chunk.fieldCount,
              chunk.inputIdentityHash,
              chunk.orderedInputHash
            ]
          );
        }
        const rows = await client.query<Row>(
          `select * from shared_source_semantic_preview_classification_chunks
            where semantic_preview_id=$1 order by chunk_index`,
          [input.claim.semanticPreviewId]
        );
        const mapped = rows.rows.map(mapSemanticClassificationChunk);
        if (
          mapped.length !== input.chunks.length ||
          mapped.some((row, index) => {
            const expected = input.chunks[index];
            return (
              !expected ||
              row.chunkIndex !== expected.chunkIndex ||
              row.firstFieldIndex !== expected.firstFieldIndex ||
              row.fieldCount !== expected.fieldCount ||
              row.inputIdentityHash !== expected.inputIdentityHash ||
              row.orderedInputHash !== expected.orderedInputHash
            );
          })
        ) {
          throw new SharedMemoryConflictError(
            "Semantic privacy manifest binding changed"
          );
        }
        const updated = await client.query(
          `update shared_source_semantic_previews
              set expected_manifest_hash=$2,expected_chunk_count=$3,
                  classification_field_count=$4,classification_byte_count=$5,
                  updated_at=now()
            where id=$1 and owner_user_id=$6 and status='pending'
              and (expected_manifest_hash is null or expected_manifest_hash=$2)
              and (expected_chunk_count is null or expected_chunk_count=$3)`,
          [
            input.claim.semanticPreviewId,
            input.expectedManifestHash,
            input.chunks.length,
            input.fieldCount,
            input.fieldByteCount,
            actor.userId
          ]
        );
        if ((updated.rowCount ?? 0) !== 1) {
          throw new SharedMemoryConflictError(
            "Semantic privacy manifest could not be initialized"
          );
        }
        return mapped;
      });
    },

    async attachSemanticPrivacyChunkResult(actor, input) {
      assertUuid(input.classificationResultId, "classificationResultId");
      assertHash(
        input.classificationPayloadBindingHash,
        "classificationPayloadBindingHash"
      );
      return withTransaction(pool, async (client) => {
        const attached = await client.query<Row>(
          `update shared_source_semantic_preview_classification_chunks chunk
              set classification_result_id=$6,
                  classification_payload_binding_hash=$7,status='ready',
                  ready_at=coalesce(chunk.ready_at,now())
             from shared_source_semantic_privacy_work_claims claim,
                  shared_source_semantic_previews semantic,
                  privacy_classification_results result
            where chunk.semantic_preview_id=$1 and chunk.chunk_index=$5
              and chunk.input_identity_hash=$8 and chunk.ordered_input_hash=$9
              and claim.semantic_preview_id=chunk.semantic_preview_id
              and claim.claim_token=$2 and claim.claim_generation=$3
              and claim.work_identity=$4 and claim.state='active'
              and claim.expires_at>now()
              and semantic.id=chunk.semantic_preview_id
              and semantic.owner_user_id=$10 and semantic.status='pending'
              and result.id=$6 and result.owner_user_id=$10
              and result.owner_content_fingerprint=$8
              and result.payload_binding_hash=$7 and result.status='ready'
              and (chunk.status='pending' or
                (chunk.classification_result_id=$6 and
                 chunk.classification_payload_binding_hash=$7))
            returning chunk.*`,
          [
            input.claim.semanticPreviewId,
            input.claim.claimToken,
            input.claim.claimGeneration,
            input.claim.workIdentity,
            input.chunkIndex,
            input.classificationResultId,
            input.classificationPayloadBindingHash,
            input.inputIdentityHash,
            input.orderedInputHash,
            actor.userId
          ]
        );
        if (!attached.rows[0]) {
          throw new SharedMemoryConflictError(
            "Semantic privacy chunk result binding was rejected"
          );
        }
        await client.query(
          `update shared_source_semantic_previews
              set completed_chunk_count=(
                select count(*) from shared_source_semantic_preview_classification_chunks
                 where semantic_preview_id=$1 and status='ready'
              ),updated_at=now()
            where id=$1 and owner_user_id=$2 and status='pending'`,
          [input.claim.semanticPreviewId, actor.userId]
        );
        return mapSemanticClassificationChunk(attached.rows[0]);
      });
    },

    async listSemanticPrivacyManifest(actor, input) {
      const result = await pool.query<Row>(
        `select chunk.*
           from shared_source_semantic_preview_classification_chunks chunk
           join shared_source_semantic_privacy_work_claims claim
             on claim.semantic_preview_id=chunk.semantic_preview_id
           join shared_source_semantic_previews semantic
             on semantic.id=chunk.semantic_preview_id
          where chunk.semantic_preview_id=$1 and claim.claim_token=$2
            and claim.claim_generation=$3 and claim.work_identity=$4
            and claim.state='active' and claim.expires_at>now()
            and semantic.owner_user_id=$5 and semantic.status='pending'
          order by chunk.chunk_index`,
        [
          input.claim.semanticPreviewId,
          input.claim.claimToken,
          input.claim.claimGeneration,
          input.claim.workIdentity,
          actor.userId
        ]
      );
      return result.rows.map(mapSemanticClassificationChunk);
    },

    async storeSanitizedSemanticPreview(actor, input) {
      assertUuid(input.semanticPreviewId, "semanticPreviewId");
      assertHash(input.expectedManifestHash, "expectedManifestHash");
      assertHash(
        input.expectedResultManifestHash,
        "expectedResultManifestHash"
      );
      assertHash(input.expectedSourcePreviewHash, "expectedSourcePreviewHash");
      assertHash(
        input.expectedSourceArtifactHash,
        "expectedSourceArtifactHash"
      );
      assertHash(
        input.expectedSourceManifestHash,
        "expectedSourceManifestHash"
      );
      assertHash(
        input.expectedSourceItemIdentityHash,
        "expectedSourceItemIdentityHash"
      );
      if (
        !Number.isSafeInteger(input.expectedSourceRevision) ||
        input.expectedSourceRevision < 0
      ) {
        throw new TypeError("expectedSourceRevision must be non-negative");
      }
      assertHash(input.expectedClassifierHash, "expectedClassifierHash");
      assertHash(
        input.expectedEffectivePrivacyPolicyHash,
        "expectedEffectivePrivacyPolicyHash"
      );
      assertHash(input.sanitizedContentHash, "sanitizedContentHash");
      return withTransaction(pool, async (client) => {
        const current = await client.query<Row>(
          `select * from shared_source_semantic_previews
            where id=$1 and owner_user_id=$2
            for update`,
          [input.semanticPreviewId, actor.userId]
        );
        const currentRow = current.rows[0];
        if (!currentRow) {
          throw new SharedMemoryAuthorizationError(
            "Semantic privacy target is not owned by the actor"
          );
        }
        const currentRecord = mapSemanticPreview(currentRow);
        if (currentRecord.status === "ready") {
          if (
            currentRecord.sourcePreviewHash !==
              input.expectedSourcePreviewHash ||
            currentRecord.sourceArtifactHash !==
              input.expectedSourceArtifactHash ||
            currentRecord.sourceManifestHash !==
              input.expectedSourceManifestHash ||
            currentRecord.sourceRevision !== input.expectedSourceRevision ||
            currentRecord.sourceItemIdentityHash !==
              input.expectedSourceItemIdentityHash ||
            currentRecord.classifierHash !== input.expectedClassifierHash ||
            currentRecord.effectivePrivacyPolicyHash !==
              input.expectedEffectivePrivacyPolicyHash ||
            currentRecord.expectedManifestHash !== input.expectedManifestHash ||
            currentRecord.resultManifestHash !==
              input.expectedResultManifestHash ||
            currentRecord.sanitizedContentHash !== input.sanitizedContentHash
          ) {
            throw new SharedMemoryConflictError(
              "Ready sanitized semantic preview is immutable"
            );
          }
          return currentRecord;
        }
        if (currentRecord.status !== "pending") {
          throw new SharedMemoryConflictError(
            "Semantic privacy target is no longer pending"
          );
        }
        const loaded = await loadAuthorizedPendingSemanticTarget(
          client,
          actor,
          input.semanticPreviewId,
          true
        );
        if (!loaded) {
          throw new SharedMemoryConflictError(
            "Semantic privacy target authorization or policy is stale"
          );
        }
        const target = loaded.target;
        if (
          target.sourcePreviewHash !== input.expectedSourcePreviewHash ||
          target.sourceArtifactHash !== input.expectedSourceArtifactHash ||
          target.sourceManifestHash !== input.expectedSourceManifestHash ||
          target.sourceRevision !== input.expectedSourceRevision ||
          target.classifierHash !== input.expectedClassifierHash ||
          target.effectivePrivacyPolicyHash !==
            input.expectedEffectivePrivacyPolicyHash
        ) {
          throw new SharedMemoryConflictError(
            "Semantic privacy target binding changed"
          );
        }
        const source = await loadPersistedPreviewByReference(client, {
          preview: {
            previewId: target.sourcePreviewId,
            previewHash: target.sourcePreviewHash
          },
          requiredMessage:
            "Semantic privacy target source preview is unavailable"
        });
        if (
          source.artifact.artifactId !== target.sourceArtifactId ||
          source.artifact.artifactHash !== target.sourceArtifactHash ||
          source.artifact.manifestHash !== target.sourceManifestHash ||
          source.preview.sourceRevision !== target.sourceRevision ||
          source.preview.sourceHash !== target.sourceHash ||
          source.artifactBody.manifest.length !== source.preview.items.length
        ) {
          throw new SharedMemoryConflictError(
            "Semantic privacy target source binding mismatch"
          );
        }
        const activeClaim = await client.query<Row>(
          `select * from shared_source_semantic_privacy_work_claims
            where semantic_preview_id=$1 and claim_token=$2
              and claim_generation=$3 and work_identity=$4
              and state='active' and expires_at>now()
            for update`,
          [
            input.claim.semanticPreviewId,
            input.claim.claimToken,
            input.claim.claimGeneration,
            input.claim.workIdentity
          ]
        );
        if (!activeClaim.rows[0]) {
          throw new SharedMemoryConflictError("Semantic privacy claim expired");
        }
        if (
          currentRecord.expectedManifestHash !== input.expectedManifestHash ||
          currentRecord.expectedChunkCount === null ||
          currentRecord.completedChunkCount !== currentRecord.expectedChunkCount
        ) {
          throw new SharedMemoryConflictError(
            "Semantic privacy manifest is incomplete"
          );
        }
        const manifest = await client.query<Row>(
          `select chunk.*,result.owner_user_id as result_owner_user_id,
                  result.classifier_generation_id as result_classifier_generation_id,
                  result.classifier_hash as result_classifier_hash,
                  result.owner_content_fingerprint,
                  result.payload_binding_hash as result_payload_binding_hash,
                  result.status as result_status,
                  result.invalidated_at as result_invalidated_at
             from shared_source_semantic_preview_classification_chunks chunk
             join privacy_classification_results result
               on result.id=chunk.classification_result_id
            where chunk.semantic_preview_id=$1 and chunk.status='ready'
            order by chunk.chunk_index
            for share of chunk,result`,
          [target.id]
        );
        const expectedClassificationFields =
          extractSharedMemorySemanticClassificationFields(source.preview.items);
        if (manifest.rows.length !== currentRecord.expectedChunkCount) {
          throw new SharedMemoryConflictError(
            "Semantic privacy result manifest is incomplete"
          );
        }
        const classificationProvider =
          await options.resolvePersonalEncryptionProvider({
            ownerUserId: actor.userId,
            purpose: "decrypt"
          });
        let nextFieldIndex = 0;
        for (const [manifestIndex, row] of manifest.rows.entries()) {
          const chunkIndex = numberValue(row.chunk_index);
          const firstFieldIndex = numberValue(row.first_field_index);
          const fieldCount = numberValue(row.field_count);
          if (
            chunkIndex !== manifestIndex ||
            firstFieldIndex !== nextFieldIndex ||
            fieldCount < 1 ||
            stringValue(row.result_owner_user_id) !== actor.userId ||
            stringValue(row.result_classifier_generation_id) !==
              target.classifierGenerationId ||
            stringValue(row.result_classifier_hash) !== target.classifierHash ||
            stringValue(row.owner_content_fingerprint) !==
              stringValue(row.input_identity_hash) ||
            stringValue(row.result_payload_binding_hash) !==
              stringValue(row.classification_payload_binding_hash) ||
            stringValue(row.result_status) !== "ready" ||
            row.result_invalidated_at !== null
          ) {
            throw new SharedMemoryConflictError(
              "Semantic privacy result manifest binding is invalid"
            );
          }
          const resultId = stringValue(row.classification_result_id);
          const decrypted =
            await decryptAuthorizedEncryptedFieldPayloadWithClient(
              client,
              actor,
              classificationProvider,
              {
                sourceTable: "privacy_classification_results",
                sourceId: resultId,
                sourceColumn: "detected_spans"
              }
            );
          const payload = decrypted?.plaintext;
          const fields =
            isPlainObject(payload) && Array.isArray(payload.fields)
              ? payload.fields
              : null;
          const expectedFields = expectedClassificationFields.slice(
            firstFieldIndex,
            firstFieldIndex + fieldCount
          );
          if (
            !decrypted ||
            !isPlainObject(payload) ||
            payload.resultId !== resultId ||
            payload.ownerUserId !== actor.userId ||
            payload.classifierGenerationId !== target.classifierGenerationId ||
            payload.classifierHash !== target.classifierHash ||
            decrypted.record.envelope.aad.payloadBindingHash !==
              row.result_payload_binding_hash ||
            !fields ||
            fields.length !== expectedFields.length ||
            fields.some((field, index) => {
              const expected = expectedFields[index];
              return (
                !isPlainObject(field) ||
                !expected ||
                field.path !== expected.path ||
                field.inputSha256 !== expected.inputSha256 ||
                field.inputByteLength !== expected.inputByteLength
              );
            })
          ) {
            throw new SharedMemoryConflictError(
              "Privacy classification payload is not bound to the authoritative preview inputs"
            );
          }
          nextFieldIndex += fieldCount;
        }
        if (nextFieldIndex !== expectedClassificationFields.length) {
          throw new SharedMemoryConflictError(
            "Semantic privacy result manifest does not cover every field"
          );
        }
        const resultManifestHash = privacyClassificationResultManifestHash({
          expectedManifestHash: input.expectedManifestHash,
          chunks: manifest.rows.map((row) => ({
            chunkIndex: numberValue(row.chunk_index),
            firstFieldIndex: numberValue(row.first_field_index),
            fieldCount: numberValue(row.field_count),
            inputIdentityHash: stringValue(row.input_identity_hash),
            orderedInputHash: stringValue(row.ordered_input_hash),
            classificationResultId: stringValue(row.classification_result_id),
            classificationPayloadBindingHash: stringValue(
              row.classification_payload_binding_hash
            )
          }))
        });
        if (resultManifestHash !== input.expectedResultManifestHash) {
          throw new SharedMemoryConflictError(
            "Semantic privacy result manifest hash changed"
          );
        }
        if (input.items.length === 0 || input.items.length > MAX_SOURCE_ITEMS) {
          throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
        }
        const items = input.items.map((item) =>
          validateSharedMemoryCanonicalSourceItem({
            representation: target.representation,
            logicalMemoryId: target.logicalMemoryId,
            sourceRevision: target.sourceRevision,
            item
          })
        );
        validateSharedMemorySemanticSanitizedReconstruction(
          source.preview.items,
          items
        );
        if (crossIdentitySyncDigest(items) !== input.sanitizedContentHash) {
          throw new SharedMemoryConflictError(
            "Sanitized semantic content hash does not match the payload"
          );
        }
        const sourceItemIdentityHash = sharedMemorySourceItemIdentityHash(
          source.preview.items
        );
        if (
          sourceItemIdentityHash !== input.expectedSourceItemIdentityHash ||
          sharedMemorySourceItemIdentityHash(items) !== sourceItemIdentityHash
        ) {
          throw new SharedMemoryConflictError(
            "Sanitization must preserve source item identity and order"
          );
        }
        const embeddingSourceBindings = items.map((item, sourceItemIndex) =>
          sharedMemorySemanticEmbeddingSourceBinding(
            sourceItemIndex,
            source.preview.items[sourceItemIndex]!,
            item,
            source.artifactBody.manifest[sourceItemIndex]!
          )
        );
        const displayTitle = sharedMemorySanitizedDisplayTitle(items);
        const payload: SharedMemorySanitizedSemanticPreviewPayload = {
          schemaVersion: SHARED_MEMORY_SEMANTIC_PREVIEW_FORMAT_VERSION,
          semanticPreviewId: target.id,
          sourcePreviewId: target.sourcePreviewId,
          sourceArtifactId: target.sourceArtifactId,
          sourcePreviewRevision: target.sourcePreviewRevision,
          sourcePreviewHash: target.sourcePreviewHash,
          sourceArtifactHash: target.sourceArtifactHash,
          sourceManifestHash: target.sourceManifestHash,
          sourceRevision: target.sourceRevision,
          sourceHash: target.sourceHash,
          logicalMemoryId: target.logicalMemoryId,
          ownerUserId: target.ownerUserId,
          ownerPrincipalId: target.ownerPrincipalId,
          teamId: target.teamId,
          teamWorkspaceId: target.teamWorkspaceId,
          representation: target.representation,
          expectedManifestHash: input.expectedManifestHash,
          expectedChunkCount: manifest.rows.length,
          resultManifestHash,
          classifierGenerationId: target.classifierGenerationId,
          classifierVersion: target.classifierVersion,
          classifierHash: target.classifierHash,
          effectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash,
          sourceItemIdentityHash,
          sourceItemCount: items.length,
          sanitizedContentHash: input.sanitizedContentHash,
          displayTitle,
          items,
          embeddingSourceBindings
        };
        const payloadBindingHash =
          sharedMemorySemanticPreviewPayloadBindingHash(payload);
        const provider = await options.resolveTeamEncryptionProvider({
          teamId: target.teamId,
          purpose: "encrypt"
        });
        const ownerPrivateProvider =
          await resolveOwnerPrivateReplicaEncryptionProvider({
            ownerUserId: target.ownerUserId,
            ownerPrincipalId: target.ownerPrincipalId,
            logicalMemoryId: target.logicalMemoryId,
            remoteReplicaId: nullableStringValue(loaded.row.remote_replica_id),
            teamId: target.teamId,
            teamWorkspaceId: target.teamWorkspaceId,
            purpose: "decrypt"
          });
        if (
          provider.keyId === classificationProvider.keyId ||
          provider.keyId === ownerPrivateProvider.keyId ||
          classificationProvider.keyId === ownerPrivateProvider.keyId
        ) {
          throw new SharedMemoryConflictError(
            "Personal classification, owner-private source, and Team sanitized preview require distinct encryption keys"
          );
        }
        await upsertEncryptedFieldPayloadWithClient(client, actor, provider, {
          sourceTable: SHARED_MEMORY_SEMANTIC_PREVIEW_SOURCE,
          sourceId: target.id,
          sourceColumn: SHARED_MEMORY_SEMANTIC_PREVIEW_COLUMN,
          plaintext: payload,
          visibility: "team",
          teamId: target.teamId,
          teamWorkspaceId: target.teamWorkspaceId,
          rowFamily: "shared_source_semantic_preview",
          scope: {
            teamId: target.teamId,
            workspaceId: target.teamWorkspaceId,
            objectClass: "shared_source_semantic_preview"
          },
          aad: {
            sourcePreviewId: target.sourcePreviewId,
            sourcePreviewHash: target.sourcePreviewHash,
            sourceArtifactId: target.sourceArtifactId,
            sourceArtifactHash: target.sourceArtifactHash,
            sourceManifestHash: target.sourceManifestHash,
            sourceRevision: target.sourceRevision,
            sourceHash: target.sourceHash,
            logicalMemoryId: target.logicalMemoryId,
            teamId: target.teamId,
            teamWorkspaceId: target.teamWorkspaceId,
            representation: target.representation,
            expectedManifestHash: input.expectedManifestHash,
            expectedChunkCount: manifest.rows.length,
            resultManifestHash,
            classifierGenerationId: target.classifierGenerationId,
            classifierVersion: target.classifierVersion,
            classifierHash: target.classifierHash,
            effectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash,
            sourceItemIdentityHash,
            sourceItemCount: items.length,
            sanitizedContentHash: input.sanitizedContentHash,
            payloadBindingHash
          }
        });
        const ready = await client.query<Row>(
          `update shared_source_semantic_previews
              set result_manifest_hash=$2,
                  source_item_identity_hash=$3,source_item_count=$4,
                  sanitized_content_hash=$5,payload_binding_hash=$6,
                  status='ready',ready_at=now(),updated_at=now(),
                  last_error_class=null,attempt_count=0,next_attempt_at=null
            where id=$1 and owner_user_id=$7 and status='pending'
              and source_preview_hash=$8
              and classifier_hash=$9
              and effective_privacy_policy_hash=$10
              and source_artifact_hash=$11
              and source_manifest_hash=$12
              and source_revision=$13
              and expected_manifest_hash=$14
              and expected_chunk_count=$15
              and completed_chunk_count=expected_chunk_count
            returning *`,
          [
            target.id,
            resultManifestHash,
            sourceItemIdentityHash,
            items.length,
            input.sanitizedContentHash,
            payloadBindingHash,
            actor.userId,
            input.expectedSourcePreviewHash,
            input.expectedClassifierHash,
            input.expectedEffectivePrivacyPolicyHash,
            input.expectedSourceArtifactHash,
            input.expectedSourceManifestHash,
            input.expectedSourceRevision,
            input.expectedManifestHash,
            manifest.rows.length
          ]
        );
        if (!ready.rows[0]) {
          throw new SharedMemoryConflictError(
            "Semantic privacy target could not transition to ready"
          );
        }
        const completedClaim = await client.query(
          `update shared_source_semantic_privacy_work_claims
              set state='completed',completed_at=now(),released_at=null
            where semantic_preview_id=$1 and claim_token=$2
              and claim_generation=$3 and work_identity=$4
              and state='active' and expires_at>now()`,
          [
            input.claim.semanticPreviewId,
            input.claim.claimToken,
            input.claim.claimGeneration,
            input.claim.workIdentity
          ]
        );
        if ((completedClaim.rowCount ?? 0) !== 1) {
          throw new SharedMemoryConflictError(
            "Semantic privacy claim expired before publication"
          );
        }
        const titledGrant = await client.query(
          `update team_memory_share_grants
              set display_title=$2,display_title_source_revision=$7,updated_at=now()
            where id=$1 and owner_user_id=$3 and team_id=$4
              and team_workspace_id=$5 and logical_memory_id=$6
              and lifecycle in ('unavailable','active') and revoked_at is null
              and (display_title_source_revision is null
                or display_title_source_revision<=$7)`,
          [
            target.shareGrantId,
            displayTitle,
            actor.userId,
            target.teamId,
            target.teamWorkspaceId,
            target.logicalMemoryId,
            target.sourceRevision
          ]
        );
        if ((titledGrant.rowCount ?? 0) !== 1) {
          const newerTitle = await client.query(
            `select 1 from team_memory_share_grant_records
              where id=$1 and owner_user_id=$2 and team_id=$3
                and team_workspace_id=$4 and logical_memory_id=$5
                and lifecycle in ('unavailable','active') and revoked_at is null
                and display_title_source_revision>$6`,
            [
              target.shareGrantId,
              actor.userId,
              target.teamId,
              target.teamWorkspaceId,
              target.logicalMemoryId,
              target.sourceRevision
            ]
          );
          if (!newerTitle.rows[0]) {
            throw new SharedMemoryConflictError(
              "Sanitized Team title target is no longer available"
            );
          }
        }
        await client.query(
          `update pending_share_operations
              set display_title=$2,updated_at=now()
            where grant_id=$1 and owner_user_id=$3
              and coalesce(replacement_source_revision,source_revision)=$4
              and state='preparing' and revoked_at is null`,
          [
            target.shareGrantId,
            displayTitle,
            actor.userId,
            target.sourceRevision
          ]
        );
        await client.query(
          `update pending_share_outbox outbox
              set state='pending',available_at=now(),locked_at=null,updated_at=now()
             from pending_share_operations pending
            where pending.id=outbox.pending_share_id
              and pending.grant_id=$1 and pending.owner_user_id=$2
              and pending.state='preparing' and pending.stage='privacy_filtering'
              and pending.revoked_at is null`,
          [target.shareGrantId, actor.userId]
        );
        await client.query(
          "select pg_notify('koed_pending_share_activation','work')"
        );
        return mapSemanticPreview(ready.rows[0]);
      });
    },

    async markSemanticPrivacyTargetFailed(actor, input) {
      assertUuid(input.semanticPreviewId, "semanticPreviewId");
      assertHash(input.expectedSourcePreviewHash, "expectedSourcePreviewHash");
      assertHash(
        input.expectedSourceArtifactHash,
        "expectedSourceArtifactHash"
      );
      assertHash(
        input.expectedSourceManifestHash,
        "expectedSourceManifestHash"
      );
      assertHash(
        input.expectedSourceItemIdentityHash,
        "expectedSourceItemIdentityHash"
      );
      assertHash(input.expectedClassifierHash, "expectedClassifierHash");
      assertHash(
        input.expectedEffectivePrivacyPolicyHash,
        "expectedEffectivePrivacyPolicyHash"
      );
      assertLifecycleCode(input.failureCode, "failureCode");
      return withTransaction(pool, async (client) => {
        const authorized = await loadAuthorizedPendingSemanticTarget(
          client,
          actor,
          input.semanticPreviewId,
          true
        );
        if (!authorized) return false;
        const target = authorized.target;
        if (
          target.sourcePreviewHash !== input.expectedSourcePreviewHash ||
          target.sourceArtifactHash !== input.expectedSourceArtifactHash ||
          target.sourceManifestHash !== input.expectedSourceManifestHash ||
          target.classifierHash !== input.expectedClassifierHash ||
          target.effectivePrivacyPolicyHash !==
            input.expectedEffectivePrivacyPolicyHash
        ) {
          throw new SharedMemoryConflictError(
            "Semantic privacy failure target binding changed"
          );
        }
        const source = await loadPersistedPreviewByReference(client, {
          preview: {
            previewId: target.sourcePreviewId,
            previewHash: target.sourcePreviewHash
          },
          requiredMessage:
            "Semantic privacy failure target source preview is unavailable"
        });
        const sourceItemIdentityHash = sharedMemorySourceItemIdentityHash(
          source.preview.items
        );
        if (
          source.artifact.artifactId !== target.sourceArtifactId ||
          source.artifact.artifactHash !== target.sourceArtifactHash ||
          source.artifact.manifestHash !== target.sourceManifestHash ||
          sourceItemIdentityHash !== input.expectedSourceItemIdentityHash
        ) {
          throw new SharedMemoryConflictError(
            "Semantic privacy failure target source binding mismatch"
          );
        }
        const result = await client.query(
          `update shared_source_semantic_previews
              set source_item_identity_hash=$3,source_item_count=$4,
                  status='failed',failure_code=$5,failed_at=now(),updated_at=now(),
                  last_error_class=null,attempt_count=0,next_attempt_at=null
            where id=$1 and owner_user_id=$2 and status='pending'
              and source_preview_hash=$6 and source_artifact_hash=$7
              and source_manifest_hash=$8 and classifier_hash=$9
              and effective_privacy_policy_hash=$10`,
          [
            input.semanticPreviewId,
            actor.userId,
            sourceItemIdentityHash,
            source.preview.items.length,
            input.failureCode,
            input.expectedSourcePreviewHash,
            input.expectedSourceArtifactHash,
            input.expectedSourceManifestHash,
            input.expectedClassifierHash,
            input.expectedEffectivePrivacyPolicyHash
          ]
        );
        if ((result.rowCount ?? 0) === 0) return false;
        const terminal = await client.query<Row>(
          `update pending_share_operations
              set state='needs_attention',stage='privacy_filtering',
                  source_update_state='failed',redacted_failure_code=$2,
                  last_progress_at=now(),updated_at=now(),
                  operation_version=operation_version+1
            where grant_id=$1 and owner_user_id=$3
              and state='preparing' and stage='privacy_filtering'
              and revoked_at is null
            returning id,operation_version`,
          [target.shareGrantId, input.failureCode, actor.userId]
        );
        for (const pending of terminal.rows) {
          const pendingShareId = stringValue(pending.id);
          await client.query(
            `update pending_share_outbox
                set state='completed',locked_at=null,updated_at=now()
              where pending_share_id=$1`,
            [pendingShareId]
          );
          await appendPendingShareOwnerEvent(client, {
            mutationId: crossIdentitySyncDeterministicUuid({
              kind: "pending_share_privacy_failed",
              pendingShareId,
              reason: input.failureCode,
              operationVersion: numberValue(pending.operation_version)
            }),
            ownerUserId: actor.userId,
            pendingShareId
          });
        }
        return true;
      });
    },

    async deferSemanticPrivacyTarget(actor, input) {
      assertUuid(input.semanticPreviewId, "semanticPreviewId");
      assertHash(input.expectedSourcePreviewHash, "expectedSourcePreviewHash");
      assertHash(
        input.expectedSourceArtifactHash,
        "expectedSourceArtifactHash"
      );
      assertHash(
        input.expectedSourceManifestHash,
        "expectedSourceManifestHash"
      );
      assertHash(input.expectedClassifierHash, "expectedClassifierHash");
      assertHash(
        input.expectedEffectivePrivacyPolicyHash,
        "expectedEffectivePrivacyPolicyHash"
      );
      assertLifecycleCode(input.errorClass, "errorClass");
      const deferred = await pool.query<{ next_attempt_at: Date }>(
        `update shared_source_semantic_previews
            set attempt_count=attempt_count+1,last_error_class=$8,
                next_attempt_at=now()+make_interval(
                  secs=>least(300,(power(2,least(attempt_count,5))::integer*5))
                ),updated_at=now()
          where id=$1 and owner_user_id=$2 and status='pending'
            and source_preview_hash=$3 and source_artifact_hash=$4
            and source_manifest_hash=$5 and classifier_hash=$6
            and effective_privacy_policy_hash=$7
          returning next_attempt_at`,
        [
          input.semanticPreviewId,
          actor.userId,
          input.expectedSourcePreviewHash,
          input.expectedSourceArtifactHash,
          input.expectedSourceManifestHash,
          input.expectedClassifierHash,
          input.expectedEffectivePrivacyPolicyHash,
          input.errorClass.slice(0, 160)
        ]
      );
      return deferred.rows[0]?.next_attempt_at.toISOString() ?? null;
    },

    async getNextSemanticPrivacyWorkAt() {
      const next = await pool.query<{ work_at: Date | null }>(
        `select min(work_at) as work_at
           from (
             select semantic.next_attempt_at as work_at
               from shared_source_semantic_previews semantic
              where semantic.status='pending'
                and semantic.next_attempt_at is not null
             union all
             select claim.expires_at as work_at
               from shared_source_semantic_privacy_work_claims claim
               join shared_source_semantic_previews semantic
                 on semantic.id=claim.semantic_preview_id
              where semantic.status='pending' and claim.state='active'
           ) wake_times`
      );
      return next.rows[0]?.work_at?.toISOString() ?? null;
    },

    async tryAcquireSemanticPrivacyFinalizationLease() {
      const client = await pool.connect();
      try {
        const lock = await client.query<{ acquired: boolean }>(
          "select pg_try_advisory_lock($1,$2) as acquired",
          [...SEMANTIC_PRIVACY_FINALIZATION_ADVISORY_LOCK]
        );
        if (lock.rows[0]?.acquired !== true) {
          client.release();
          return null;
        }
        let released = false;
        return {
          async release() {
            if (released) return;
            released = true;
            try {
              await client.query("select pg_advisory_unlock($1,$2)", [
                ...SEMANTIC_PRIVACY_FINALIZATION_ADVISORY_LOCK
              ]);
            } finally {
              client.release();
            }
          }
        };
      } catch (error) {
        client.release();
        throw error;
      }
    },

    async getSemanticPrivacyBacklogDiagnostics() {
      const [totals, classes, reasons] = await Promise.all([
        pool.query<Row>(
          `select
             count(*) filter (
               where semantic.status='pending'
                 and coalesce(semantic.next_attempt_at,semantic.eligible_at)<=now()
                 and (claim.id is null or claim.state<>'active' or claim.expires_at<=now())
             )::integer as pending,
             count(*) filter (
               where semantic.status='pending' and claim.state='active'
                 and claim.expires_at>now()
             )::integer as leased,
             count(*) filter (
               where semantic.status='pending' and semantic.next_attempt_at>now()
             )::integer as deferred,
             count(*) filter (where semantic.status='ready')::integer as ready,
             count(*) filter (where semantic.status='failed')::integer as failed,
             count(*) filter (where semantic.status='stale')::integer as stale,
             count(*) filter (where semantic.status='invalidated')::integer as invalidated,
             extract(epoch from (now()-min(semantic.enqueued_at) filter (
               where semantic.status='pending' and semantic.scheduling_class='background'
             )))*1000 as oldest_background_wait_ms
           from shared_source_semantic_previews semantic
           left join shared_source_semantic_privacy_work_claims claim
             on claim.semantic_preview_id=semantic.id`
        ),
        pool.query<Row>(
          `select scheduling_class,count(*)::integer as count
             from shared_source_semantic_previews
            where status='pending'
            group by scheduling_class`
        ),
        pool.query<Row>(
          `select work_reason,count(*)::integer as count
             from shared_source_semantic_previews
            where status='pending'
            group by work_reason`
        )
      ]);
      const total = totals.rows[0] ?? {};
      const bySchedulingClass = {
        foreground: 0,
        background: 0
      };
      for (const row of classes.rows) {
        if (row.scheduling_class === "foreground") {
          bySchedulingClass.foreground = numberValue(row.count);
        } else if (row.scheduling_class === "background") {
          bySchedulingClass.background = numberValue(row.count);
        }
      }
      const byWorkReason = {
        share_activation: 0,
        source_revision_classification: 0,
        policy_remasking: 0,
        classifier_rematerialization: 0,
        background_repair: 0
      };
      for (const row of reasons.rows) {
        const workReason = nullableString(row.work_reason);
        if (workReason && Object.hasOwn(byWorkReason, workReason)) {
          byWorkReason[workReason as keyof typeof byWorkReason] = numberValue(
            row.count
          );
        }
      }
      const oldestBackgroundWaitMs = total.oldest_background_wait_ms;
      return {
        counts: {
          pending: numberValue(total.pending ?? 0),
          leased: numberValue(total.leased ?? 0),
          deferred: numberValue(total.deferred ?? 0),
          ready: numberValue(total.ready ?? 0),
          failed: numberValue(total.failed ?? 0),
          stale: numberValue(total.stale ?? 0),
          invalidated: numberValue(total.invalidated ?? 0)
        },
        bySchedulingClass,
        byWorkReason,
        oldestBackgroundWaitMs:
          oldestBackgroundWaitMs === null ||
          oldestBackgroundWaitMs === undefined
            ? null
            : Math.max(numberValue(oldestBackgroundWaitMs), 0),
        completionEstimate: {
          status: "unavailable" as const,
          reason: "insufficient_measured_throughput" as const
        }
      };
    },

    async invalidateSemanticPreview(actor, input) {
      assertUuid(input.semanticPreviewId, "semanticPreviewId");
      assertLifecycleCode(input.reasonCode, "reasonCode");
      return withTransaction(pool, async (client) => {
        const invalidated = await client.query<Row>(
          `update shared_source_semantic_previews
              set status='invalidated',invalidated_at=now(),updated_at=now(),
                  invalidation_reason_code=$3,last_error_class=null,
                  attempt_count=0,next_attempt_at=null
            where id=$1 and owner_user_id=$2 and status<>'invalidated'
            returning *`,
          [input.semanticPreviewId, actor.userId, input.reasonCode]
        );
        const row = invalidated.rows[0];
        if (!row) return false;
        await client.query(
          `update encrypted_field_payloads
              set invalidated_at=now(),invalidation_reason=$4,updated_at=now()
            where owner_user_id=$1 and team_id=$2 and team_workspace_id=$3
              and encryption_scope='team'
              and source_table='shared_source_semantic_previews'
              and source_id=$5 and source_column='sanitized_preview'
              and invalidated_at is null`,
          [
            actor.userId,
            row.team_id,
            row.team_workspace_id,
            input.reasonCode,
            input.semanticPreviewId
          ]
        );
        const representations = await client.query<{ id: string }>(
          `update team_memory_representations
              set state='invalidated',invalidated_at=now(),updated_at=now(),
                  record_version=record_version+1,
                  invalidation_reason_code='privacy_material_invalidated'
            where sanitized_source_preview_id=$1
              and state in ('pending','available','stale')
            returning id`,
          [input.semanticPreviewId]
        );
        if (representations.rows.length > 0) {
          await client.query(
            `delete from team_memory_semantic_items
              where representation_id=any($1::uuid[])`,
            [representations.rows.map((representation) => representation.id)]
          );
        }
        return true;
      });
    },

    async invalidateStaleSemanticPreviews(input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
      return withTransaction(pool, async (client) => {
        const candidates = await client.query<Row>(
          `select * from shared_source_semantic_previews
            where status in ('pending','ready','failed')
            order by updated_at,id
            limit $1
            for update skip locked`,
          [limit]
        );
        let invalidated = 0;
        for (const row of candidates.rows) {
          const current = await client.query<{
            source_current: boolean;
            classifier_current: boolean;
            authorization_current: boolean;
          }>(
            `select
               exists (
                 select 1
                   from shared_source_preview_records preview
                   join shared_source_artifact_records artifact
                     on artifact.id=preview.source_artifact_id
                    and artifact.invalidated_at is null
                  where preview.id=$1 and preview.invalidated_at is null
                    and preview.preview_revision=$2
                    and preview.preview_hash=$3
                    and artifact.id=$4 and artifact.artifact_hash=$5
                    and artifact.manifest_hash=$6
                    and preview.source_revision=$7 and preview.source_hash=$8
               ) as source_current,
               exists (
                 select 1 from privacy_classifier_generations generation
                  where generation.id=$9 and generation.version=$10
                    and generation.classifier_hash=$11
                    and generation.status='active'
                    and generation.revoked_at is null
               ) as classifier_current,
               exists (
                 select 1
                   from shared_source_preview_records preview
                   join shared_source_artifact_records artifact
                     on artifact.id=preview.source_artifact_id
                    and artifact.invalidated_at is null
                   join team_memory_share_grant_records g
                     on g.logical_memory_id=preview.logical_memory_id
                    and g.remote_replica_id is not distinct from preview.remote_replica_id
                    and g.owner_user_id=preview.owner_user_id
                    and g.owner_principal_id=preview.owner_principal_id
                    and g.team_id=preview.team_id
                    and g.team_workspace_id=preview.team_workspace_id
                    and g.revoked_at is null
                    and (
                      g.lifecycle='active'
                      or (g.lifecycle='unavailable' and exists (
                        select 1 from pending_share_operation_records pending
                         where pending.grant_id=g.id
                           and pending.owner_user_id=g.owner_user_id
                           and pending.consent_id=g.consent_id
                           and pending.state='preparing'
                           and pending.stage in ('activating','privacy_filtering')
                           and pending.revoked_at is null
                      ))
                    )
                   ${semanticPrivacyConsentJoinSql()}
                   join teams team on team.id=preview.team_id
                    and team.lifecycle='active'
                    and team.entitlement_status in ('active','grace')
                   join team_workspaces workspace
                     on workspace.id=preview.team_workspace_id
                    and workspace.team_id=preview.team_id
                    and workspace.lifecycle='active'
                    and workspace.archived_at is null
                   join source_owner_representation_policies op
                     on op.policy_id=g.source_owner_policy_id
                    and op.version=g.source_owner_policy_version
                    and op.superseded_at is null
                   join team_representation_policies tp
                     on tp.policy_id=g.team_policy_id
                    and tp.version=g.team_policy_version
                    and tp.team_id=g.team_id and tp.superseded_at is null
                   join workspace_representation_policies wp
                     on wp.policy_id=g.workspace_policy_id
                    and wp.version=g.workspace_policy_version
                    and wp.team_id=g.team_id
                    and wp.team_workspace_id=g.team_workspace_id
                    and wp.superseded_at is null
                  where preview.id=$1 and preview.invalidated_at is null
                    and preview.preview_revision=$2
                    and preview.preview_hash=$3
                    and artifact.id=$4 and artifact.artifact_hash=$5
                    and artifact.manifest_hash=$6
                    and preview.source_revision=$7 and preview.source_hash=$8
                    and ${cumulativeRepresentationAuthorizationSql("preview.representation")}
               ) as authorization_current`,
            [
              row.source_preview_id,
              row.source_preview_revision,
              row.source_preview_hash,
              row.source_artifact_id,
              row.source_artifact_hash,
              row.source_manifest_hash,
              row.source_revision,
              row.source_hash,
              row.classifier_generation_id,
              row.classifier_version,
              row.classifier_hash
            ]
          );
          const state = current.rows[0];
          let reasonCode: string | null = null;
          if (!state?.source_current) {
            reasonCode = "source_binding_stale";
          } else if (!state.classifier_current) {
            reasonCode = "privacy_classifier_superseded";
          } else if (!state.authorization_current) {
            reasonCode = "sharing_authorization_revoked";
          } else {
            try {
              const effectivePolicy = await resolveCurrentPrivacyPolicy(
                client,
                {
                  ownerUserId: stringValue(row.owner_user_id),
                  teamId: stringValue(row.team_id),
                  teamWorkspaceId: stringValue(row.team_workspace_id)
                }
              );
              if (
                effectivePolicy.effectivePolicyHash !==
                stringValue(row.effective_privacy_policy_hash)
              ) {
                reasonCode = "privacy_policy_superseded";
              }
            } catch {
              reasonCode = "privacy_policy_unavailable";
            }
          }
          if (!reasonCode) continue;
          const wasReady = stringValue(row.status) === "ready";
          const transitioned = await client.query<Row>(
            `update shared_source_semantic_previews
                set status=$2,
                    stale_at=case when $2='stale' then now() else stale_at end,
                    invalidated_at=case when $2='invalidated' then now() else invalidated_at end,
                    invalidation_reason_code=$3,updated_at=now(),
                    last_error_class=null,attempt_count=0,next_attempt_at=null
              where id=$1 and status=$4
              returning *`,
            [row.id, wasReady ? "stale" : "invalidated", reasonCode, row.status]
          );
          if (!transitioned.rows[0]) continue;
          await invalidateSemanticDerivativeDependentsWithClient(
            client,
            transitioned.rows,
            reasonCode
          );
          invalidated += 1;
        }
        return { invalidated };
      });
    },

    async reconcileReadySemanticRepresentations(input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 32, 1), 100);
      const candidates = await pool.query<Row>(
        `select semantic.id as semantic_preview_id,semantic.owner_user_id,
                semantic.source_preview_id,semantic.source_preview_hash,
                semantic.source_revision,semantic.representation,
                g.id as share_grant_id,g.consent_id,g.grant_version
           from shared_source_semantic_previews semantic
           join shared_source_preview_records preview
             on preview.id=semantic.source_preview_id
            and preview.invalidated_at is null
           join team_memory_share_grant_records g
             on g.logical_memory_id=semantic.logical_memory_id
            and g.remote_replica_id is not distinct from preview.remote_replica_id
            and g.owner_user_id=semantic.owner_user_id
            and g.owner_principal_id=semantic.owner_principal_id
            and g.team_id=semantic.team_id
            and g.team_workspace_id=semantic.team_workspace_id
            and g.lifecycle='active' and g.revoked_at is null
           join source_owner_representation_consent_records consent
             on consent.id=g.consent_id
            and consent.state='active' and consent.revoked_at is null
            and (consent.expires_at is null or consent.expires_at>now())
          where semantic.status='ready'
            and semantic.invalidated_at is null
            and not exists (
              select 1 from pending_share_operation_records pending
               where pending.grant_id=g.id
                 and pending.source_kind='personal_note'
                 and pending.replacement_authority_source='continuous_consent'
                 and pending.logical_memory_id=semantic.logical_memory_id
                 and pending.team_id=semantic.team_id
                 and pending.team_workspace_id=semantic.team_workspace_id
                 and pending.replacement_source_revision=semantic.source_revision
                 and pending.replacement_source_hash=semantic.source_hash
                 and pending.state in ('preparing','needs_attention')
                 and pending.revoked_at is null
            )
            and not exists (
              select 1
                from team_memory_representation_records representation
               where representation.share_grant_id=g.id
                 and representation.representation=semantic.representation
                 and representation.source_revision=semantic.source_revision
                 and representation.sanitized_source_preview_id=semantic.id
                 and representation.state in ('pending','available','stale')
                 and representation.invalidated_at is null
            )
          order by semantic.ready_at,semantic.id,g.id
          limit $1`,
        [limit]
      );
      let materialized = 0;
      let skipped = 0;
      for (const row of candidates.rows) {
        const actor = { userId: stringValue(row.owner_user_id) };
        try {
          await repository.materializeGrantRepresentation(actor, {
            mutationId: crossIdentitySyncDeterministicUuid({
              operation: "sanitized-semantic-materialization",
              semanticPreviewId: stringValue(row.semantic_preview_id),
              shareGrantId: stringValue(row.share_grant_id),
              consentId: stringValue(row.consent_id),
              representation: stringValue(row.representation),
              sourceRevision: numberValue(row.source_revision),
              previewHash: stringValue(row.source_preview_hash)
            }),
            shareGrantId: stringValue(row.share_grant_id),
            consentId: stringValue(row.consent_id),
            expectedGrantVersion: numberValue(row.grant_version),
            preview: {
              previewId: stringValue(row.source_preview_id),
              previewHash: stringValue(row.source_preview_hash)
            }
          });
          materialized += 1;
        } catch (error) {
          if (
            error instanceof SharedMemoryAuthorizationError ||
            error instanceof SharedMemoryConflictError
          ) {
            skipped += 1;
            continue;
          }
          throw error;
        }
      }
      return { materialized, skipped };
    },

    async materializeGrantRepresentation(
      actor,
      input,
      transactionClient?: pg.PoolClient
    ) {
      assertUuid(input.mutationId, "mutationId");
      if (input.internalPendingShareId) {
        assertUuid(input.internalPendingShareId, "internalPendingShareId");
      }
      const command = async (client: pg.PoolClient) => {
        const grantResult = await client.query<Row>(
          `select g.*,
                mr.id as authorized_replica_id,
                sr.id as authorized_sync_relationship_id,
                mr.freshness_status as replica_freshness_status,
                sr.state as sync_relationship_state
           from team_memory_share_grant_records g
           left join memory_replicas mr
             on mr.id=g.remote_replica_id
            and mr.replica_role='target'
            and mr.encryption_scope='owner_private_replica'
            and mr.lifecycle='active'
            and mr.disabled_at is null
           left join cross_identity_sync_relationships sr
             on sr.local_replica_id=mr.id
            and sr.logical_memory_id=g.logical_memory_id
            and sr.side='target'
            and sr.revoked_at is null
            and sr.state in ('processing','partially_available','ready','stale')
          where g.id=$1
            and (
              (g.source_kind='captured_session' and mr.id is not null and sr.id is not null)
              or (g.source_kind='personal_note' and g.remote_replica_id is null)
            )
          for update of g`,
          [input.shareGrantId]
        );
        const grantRow = grantResult.rows[0] as Row | undefined;
        if (!grantRow || grantRow.owner_user_id !== actor.userId) {
          throw new SharedMemoryAuthorizationError(
            "Only the source owner may materialize a Share Grant representation"
          );
        }
        const pendingActivation =
          stringValue(grantRow.lifecycle) === "unavailable"
            ? await client.query<Row>(
                `select id from pending_share_operations
                  where grant_id=$1 and owner_user_id=$2 and state='preparing'
                    and workspace_access_state='none' and revoked_at is null
                  for update`,
                [input.shareGrantId, actor.userId]
              )
            : null;
        const pendingContinuousNoteAdvancement = input.internalPendingShareId
          ? await client.query<Row>(
              `select id from pending_share_operations
                where id=$1 and grant_id=$2 and owner_user_id=$3
                  and replacement_authority_source='continuous_consent'
                  and replacement_consent_id=$4
                  and replacement_source_revision is not null
                  and state='preparing' and stage='activating'
                  and workspace_access_state='active' and revoked_at is null
                for update`,
              [
                input.internalPendingShareId,
                input.shareGrantId,
                actor.userId,
                input.consentId
              ]
            )
          : null;
        const remediationRecovery =
          stringValue(grantRow.lifecycle) === "unavailable"
            ? await client.query<Row>(
                `select id,operation_version
                   from pending_share_operations
                  where grant_id=$1 and owner_user_id=$2
                    and state='needs_attention'
                    and redacted_failure_code='approval_content_remediation'
                    and revoked_at is null
                  for update`,
                [input.shareGrantId, actor.userId]
              )
            : null;
        if (
          !["active", "unavailable"].includes(
            stringValue(grantRow.lifecycle)
          ) ||
          (stringValue(grantRow.lifecycle) === "unavailable" &&
            !pendingActivation?.rows[0] &&
            !remediationRecovery?.rows[0]) ||
          grantRow.revoked_at !== null ||
          (input.internalPendingShareId !== undefined &&
            !pendingContinuousNoteAdvancement?.rows[0])
        ) {
          throw new SharedMemoryConflictError(
            "Share Grant is not active for materialization"
          );
        }
        if (
          numberValue(grantRow.grant_version) !== input.expectedGrantVersion
        ) {
          throw new SharedMemoryConflictError();
        }
        const grant = mapGrant(grantRow);
        await requireWorkspaceSharePermission(
          client,
          actor,
          grant.teamId,
          grant.teamWorkspaceId
        );
        const loaded = await loadPersistedPreviewMetadataByReference(client, {
          preview: input.preview,
          requiredMessage: "Materialization preview reference is not active"
        });
        const { preview, artifact } = loaded;
        const consentResult = await client.query<Row>(
          `select consent.*,binding.source_kind,binding.source_session_id,
                  binding.source_note_id,binding.source_memory_event_id
             from source_owner_representation_consents consent
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=consent.source_revision_id
            where consent.id=$1
              and consent.logical_memory_id=$2
              and consent.remote_replica_id is not distinct from $3::uuid
              and consent.source_owner_principal_id=$4
              and consent.team_id=$5
              and consent.team_workspace_id=$6
              and consent.state='active'
              and consent.revoked_at is null
              and (consent.expires_at is null or consent.expires_at>now())
            for update of consent`,
          [
            input.consentId,
            grantRow.logical_memory_id,
            grantRow.remote_replica_id,
            grantRow.owner_principal_id,
            grantRow.team_id,
            grantRow.team_workspace_id
          ]
        );
        const consentRow = consentResult.rows[0] as Row | undefined;
        if (
          !consentRow ||
          stringValue(grantRow.consent_id) !== input.consentId
        ) {
          throw new SharedMemoryConflictError(
            "Share Grant is no longer bound to the requested consent"
          );
        }
        const consent = mapConsent(consentRow);
        if (
          preview.logicalMemoryId !== grant.logicalMemoryId ||
          preview.remoteReplicaId !== grant.remoteReplicaId ||
          preview.teamId !== grant.teamId ||
          preview.teamWorkspaceId !== grant.teamWorkspaceId ||
          preview.ownerPrincipalId !== grant.ownerPrincipalId ||
          !sharedMemoryCeilingAuthorizes(
            grant.maximumFidelity,
            preview.representation,
            grant.includeCuratedMemory
          ) ||
          artifact.maximumFidelity !== grant.maximumFidelity ||
          artifact.includeCuratedMemory !== grant.includeCuratedMemory ||
          artifact.artifactId !== preview.artifactId ||
          artifact.sourceOwnerPolicyId !== grant.sourceOwnerPolicyId ||
          artifact.sourceOwnerPolicyVersion !==
            grant.sourceOwnerPolicyVersion ||
          artifact.teamPolicyId !== grant.teamPolicyId ||
          artifact.teamPolicyVersion !== grant.teamPolicyVersion ||
          artifact.workspacePolicyId !== grant.workspacePolicyId ||
          artifact.workspacePolicyVersion !== grant.workspacePolicyVersion ||
          artifact.representationPolicyRevision !==
            grant.fidelityPolicyRevision ||
          artifact.contentPolicyVersion !== grant.contentPolicyVersion ||
          artifact.classifierVersion !== grant.classifierVersion ||
          preview.binding.fidelityPolicyRevision !==
            grant.fidelityPolicyRevision ||
          preview.binding.contentPolicyVersion !== grant.contentPolicyVersion ||
          preview.binding.classifierVersion !== grant.classifierVersion
        ) {
          throw new SharedMemoryConflictError(
            "Authoritative preview does not match the cumulative Share Grant binding"
          );
        }
        if (
          consent.maximumFidelity !== grant.maximumFidelity ||
          consent.includeCuratedMemory !== grant.includeCuratedMemory ||
          !sharedMemoryCeilingAuthorizes(
            consent.maximumFidelity,
            preview.representation,
            consent.includeCuratedMemory
          )
        ) {
          throw new SharedMemoryConflictError(
            "Consent fidelity does not authorize the materialized preview"
          );
        }
        if (
          consent.mode === "snapshot" &&
          preview.sourceRevision !== consent.sourceRevision
        ) {
          throw new SharedMemoryConflictError(
            "Snapshot consent requires the exact consented source revision"
          );
        }
        if (
          consent.maximumAuthorizedSourceRevision !== null &&
          preview.sourceRevision > consent.maximumAuthorizedSourceRevision
        ) {
          throw new SharedMemoryConflictError(
            "Preview exceeds the consented source revision boundary"
          );
        }
        const currentPolicies = await requireCurrentPolicies(client, {
          logicalMemoryId: grant.logicalMemoryId,
          ownerPrincipalId: grant.ownerPrincipalId,
          teamId: grant.teamId,
          teamWorkspaceId: grant.teamWorkspaceId
        });
        if (
          currentPolicies.maximumFidelity !== grant.maximumFidelity ||
          currentPolicies.includeCuratedMemory !== grant.includeCuratedMemory ||
          !sharedMemoryCeilingAuthorizes(
            currentPolicies.maximumFidelity,
            preview.representation,
            currentPolicies.includeCuratedMemory
          ) ||
          stringValue(currentPolicies.owner.policy_id) !==
            grant.sourceOwnerPolicyId ||
          numberValue(currentPolicies.owner.version) !==
            grant.sourceOwnerPolicyVersion ||
          stringValue(currentPolicies.team.policy_id) !== grant.teamPolicyId ||
          numberValue(currentPolicies.team.version) !==
            grant.teamPolicyVersion ||
          stringValue(currentPolicies.workspace.policy_id) !==
            grant.workspacePolicyId ||
          numberValue(currentPolicies.workspace.version) !==
            grant.workspacePolicyVersion
        ) {
          throw new SharedMemoryConflictError(
            "Materialization requires the exact active policy intersection"
          );
        }
        let authoritativeSourceCursor = preview.sourceRevision;
        if (artifact.source?.kind === "captured_session") {
          if (!grant.remoteReplicaId || !artifact.syncRelationshipId) {
            throw new SharedMemoryConflictError(
              "Active replica provenance no longer matches the authoritative preview"
            );
          }
          const replicaState = await loadActiveReplicaState(client, {
            logicalMemoryId: grant.logicalMemoryId,
            remoteReplicaId: grant.remoteReplicaId,
            ownerUserId: actor.userId,
            ownerPrincipalId: grant.ownerPrincipalId,
            syncRelationshipId: artifact.syncRelationshipId
          });
          authoritativeSourceCursor = replicaState.sourceCursor;
          if (
            replicaState.sourceCursor < preview.sourceRevision ||
            replicaState.localReplicaId !== grant.remoteReplicaId ||
            preview.deviceProvenanceHash !== replicaState.deviceProvenanceHash
          ) {
            throw new SharedMemoryConflictError(
              "Active replica provenance no longer matches the authoritative preview"
            );
          }
        } else if (
          artifact.source?.kind !== "personal_note" ||
          grant.remoteReplicaId !== null ||
          artifact.syncRelationshipId !== null ||
          preview.representation !== "memory_events" ||
          preview.sourceRevision !== artifact.source.noteRevision
        ) {
          throw new SharedMemoryConflictError(
            "Materialization requires an exact standalone Personal Note revision"
          );
        }
        const monotonicFloor = Math.max(
          consent.sourceRevision,
          grant.sourceRevision
        );
        const latestResult = await client.query<Row>(
          `select max(source_revision)::bigint as latest_source_revision
           from team_memory_representations
          where share_grant_id=$1
            and representation=$2
            and state in ('pending','available','stale')
            and invalidated_at is null`,
          [grant.id, preview.representation]
        );
        const latestMaterializedRevision =
          nullableNumber(latestResult.rows[0]?.latest_source_revision) ?? 0;
        if (
          consent.mode === "continuous" &&
          preview.sourceRevision <
            Math.max(monotonicFloor, latestMaterializedRevision)
        ) {
          throw new SharedMemoryConflictError(
            "Continuous materialization cannot move the Share Grant backwards"
          );
        }
        const sanitized = requireReadySharedMemorySemanticDerivative(
          await decryptReadySemanticPreview(client, actor, {
            sourcePreviewId: preview.previewId,
            sourcePreviewHash: preview.previewHash,
            sourceArtifactId: artifact.artifactId,
            sourceArtifactHash: artifact.artifactHash,
            sourceManifestHash: artifact.manifestHash,
            sourceRevision: preview.sourceRevision,
            sourceHash: preview.sourceHash,
            ownerPrincipalId: grant.ownerPrincipalId,
            logicalMemoryId: grant.logicalMemoryId,
            teamId: grant.teamId,
            teamWorkspaceId: grant.teamWorkspaceId,
            representation: preview.representation
          })
        );
        const sanitizedItems = sanitized.payload.items;
        const sanitizedContentHash = sanitized.record.sanitizedContentHash!;
        const sourceRevisionHash =
          sharedMemorySanitizedSemanticSourceRevisionHash({
            sourcePreviewId: preview.previewId,
            sourcePreviewHash: preview.previewHash,
            sourceArtifactId: artifact.artifactId,
            sourceArtifactHash: artifact.artifactHash,
            sourceManifestHash: artifact.manifestHash,
            sourceRevision: preview.sourceRevision,
            representation: preview.representation,
            sanitizedSourcePreviewId: sanitized.record.id,
            sanitizedContentHash,
            sourceItemIdentityHash: sanitized.payload.sourceItemIdentityHash,
            sourceItemCount: sanitized.payload.sourceItemCount,
            privacyClassifierGenerationId:
              sanitized.record.classifierGenerationId,
            privacyClassifierHash: sanitized.record.classifierHash,
            effectivePrivacyPolicyHash:
              sanitized.record.effectivePrivacyPolicyHash
          });
        const teamSourceBinding = sharedMemorySanitizedSemanticSourceBinding({
          sourceRevision: preview.sourceRevision,
          sourceRevisionHash,
          fidelityPolicyRevision: grant.fidelityPolicyRevision,
          fidelityPolicyHash: preview.binding.fidelityPolicyHash,
          contentPolicyVersion: grant.contentPolicyVersion,
          effectivePrivacyPolicyHash:
            sanitized.record.effectivePrivacyPolicyHash,
          privacyClassifierVersion: sanitized.record.classifierVersion,
          privacyClassifierHash: sanitized.record.classifierHash
        });
        const provenanceHash = sharedMemorySanitizedSemanticProvenanceHash({
          shareGrantId: grant.id,
          consentId: consent.id,
          logicalMemoryId: grant.logicalMemoryId,
          representation: preview.representation,
          binding: teamSourceBinding,
          sourcePreviewId: preview.previewId,
          sourcePreviewHash: preview.previewHash,
          sourceArtifactId: artifact.artifactId,
          sourceArtifactHash: artifact.artifactHash,
          sourceManifestHash: artifact.manifestHash,
          sanitizedSourcePreviewId: sanitized.record.id,
          expectedManifestHash: sanitized.payload.expectedManifestHash,
          expectedChunkCount: sanitized.payload.expectedChunkCount,
          resultManifestHash: sanitized.payload.resultManifestHash,
          sourceItemIdentityHash: sanitized.payload.sourceItemIdentityHash,
          sourceItemCount: sanitized.payload.sourceItemCount,
          semanticPayloadBindingHash: sanitized.record.payloadBindingHash!,
          privacyClassifierGenerationId:
            sanitized.record.classifierGenerationId,
          privacyClassifierHash: sanitized.record.classifierHash,
          effectivePrivacyPolicyHash:
            sanitized.record.effectivePrivacyPolicyHash,
          sanitizedContentHash,
          sourceOwnerPolicyId: grant.sourceOwnerPolicyId,
          sourceOwnerPolicyVersion: grant.sourceOwnerPolicyVersion,
          teamPolicyId: grant.teamPolicyId,
          teamPolicyVersion: grant.teamPolicyVersion,
          workspacePolicyId: grant.workspacePolicyId,
          workspacePolicyVersion: grant.workspacePolicyVersion
        });
        const existingResult = await client.query<Row>(
          `select representation.*,binding.source_kind,
                  binding.source_session_id,binding.source_note_id,
                  binding.source_memory_event_id
             from team_memory_representations representation
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=representation.source_revision_id
            where representation.share_grant_id=$1
              and representation.representation=$2
              and representation.source_revision=$3
              and representation.fidelity_policy_revision=$4
              and representation.content_policy_version=$5
              and representation.classifier_version=$6
              and representation.sanitized_source_preview_id=$7
            for update of representation`,
          [
            grant.id,
            preview.representation,
            preview.sourceRevision,
            grant.fidelityPolicyRevision,
            grant.contentPolicyVersion,
            grant.classifierVersion,
            sanitized.record.id
          ]
        );
        let representationRow = existingResult.rows[0] as Row | undefined;
        if (representationRow) {
          const representationState = stringValue(representationRow.state);
          if (
            input.expectedRepresentationVersion !== undefined &&
            numberValue(representationRow.record_version) !==
              input.expectedRepresentationVersion
          ) {
            throw new SharedMemoryConflictError();
          }
          if (
            representationState !== "invalidated" &&
            (stringValue(representationRow.consent_id) !== consent.id ||
              stringValue(representationRow.source_preview_id) !==
                preview.previewId ||
              stringValue(representationRow.source_artifact_id) !==
                artifact.artifactId ||
              stringValue(representationRow.sanitized_source_preview_id) !==
                sanitized.record.id ||
              stringValue(representationRow.source_revision_id) !==
                artifact.sourceRevisionId ||
              stringValue(
                representationRow.privacy_classifier_generation_id
              ) !== sanitized.record.classifierGenerationId ||
              stringValue(representationRow.privacy_classifier_hash) !==
                sanitized.record.classifierHash ||
              stringValue(representationRow.effective_privacy_policy_hash) !==
                sanitized.record.effectivePrivacyPolicyHash ||
              stringValue(representationRow.source_manifest_hash) !==
                artifact.manifestHash ||
              stringValue(representationRow.sanitized_content_hash) !==
                sanitizedContentHash ||
              stringValue(representationRow.source_revision_hash) !==
                sourceRevisionHash ||
              stringValue(representationRow.provenance_hash) !==
                provenanceHash ||
              stringValue(representationRow.source_owner_policy_id) !==
                grant.sourceOwnerPolicyId ||
              numberValue(representationRow.source_owner_policy_version) !==
                grant.sourceOwnerPolicyVersion ||
              stringValue(representationRow.team_policy_id) !==
                grant.teamPolicyId ||
              numberValue(representationRow.team_policy_version) !==
                grant.teamPolicyVersion ||
              stringValue(representationRow.workspace_policy_id) !==
                grant.workspacePolicyId ||
              numberValue(representationRow.workspace_policy_version) !==
                grant.workspacePolicyVersion)
          ) {
            throw new SharedMemoryConflictError(
              "Existing materialized representation does not match the authoritative preview"
            );
          }
          if (
            representationState === "available" ||
            representationState === "stale"
          ) {
            return mapRepresentation(representationRow);
          }
        } else {
          if (
            input.expectedRepresentationVersion !== undefined &&
            input.expectedRepresentationVersion !== 0
          ) {
            throw new SharedMemoryConflictError();
          }
          const inserted = await client.query<Row>(
            `insert into team_memory_representations (
             share_grant_id,consent_id,source_preview_id,source_artifact_id,
             sanitized_source_preview_id,
             privacy_classifier_generation_id,privacy_classifier_hash,
             effective_privacy_policy_hash,source_manifest_hash,
             sanitized_content_hash,
             team_id,team_workspace_id,logical_memory_id,source_revision_id,representation,
             source_revision,source_revision_hash,provenance_hash,
             source_owner_policy_id,source_owner_policy_version,
             team_policy_id,team_policy_version,
             workspace_policy_id,workspace_policy_version,
             fidelity_policy_revision,content_policy_version,
             classifier_version,record_version,state,chunk_count
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19,$20,$21,$22,$23,$24,$25,$26,$27,1,'pending',0
           ) returning *`,
            [
              grant.id,
              consent.id,
              preview.previewId,
              artifact.artifactId,
              sanitized.record.id,
              sanitized.record.classifierGenerationId,
              sanitized.record.classifierHash,
              sanitized.record.effectivePrivacyPolicyHash,
              artifact.manifestHash,
              sanitizedContentHash,
              grant.teamId,
              grant.teamWorkspaceId,
              grant.logicalMemoryId,
              artifact.sourceRevisionId,
              preview.representation,
              preview.sourceRevision,
              sourceRevisionHash,
              provenanceHash,
              grant.sourceOwnerPolicyId,
              grant.sourceOwnerPolicyVersion,
              grant.teamPolicyId,
              grant.teamPolicyVersion,
              grant.workspacePolicyId,
              grant.workspacePolicyVersion,
              grant.fidelityPolicyRevision,
              grant.contentPolicyVersion,
              grant.classifierVersion
            ]
          );
          representationRow = inserted.rows[0]!;
        }
        const representationId = stringValue(representationRow.id);
        const resetResult = await client.query<Row>(
          `update team_memory_representations
            set consent_id=$2,
                source_preview_id=$3,
                source_artifact_id=$4,
                sanitized_source_preview_id=$5,
                privacy_classifier_generation_id=$6,
                privacy_classifier_hash=$7,
                effective_privacy_policy_hash=$8,
                source_manifest_hash=$9,
                sanitized_content_hash=$10,
                source_revision_hash=$11,
                provenance_hash=$12,
                source_owner_policy_id=$13,
                source_owner_policy_version=$14,
                team_policy_id=$15,
                team_policy_version=$16,
                workspace_policy_id=$17,
                workspace_policy_version=$18,
                source_revision_id=$19,
                source_revision=$20,
                record_version=case when id=$1 and record_version>0 then record_version+1 else 1 end,
                state='pending',
                chunk_count=0,
                freshness_evaluated_at=null,
                available_at=null,
                stale_at=null,
                invalidated_at=null,
                invalidation_reason_code=null,
                updated_at=now()
          where id=$1
          returning *`,
          [
            representationId,
            consent.id,
            preview.previewId,
            artifact.artifactId,
            sanitized.record.id,
            sanitized.record.classifierGenerationId,
            sanitized.record.classifierHash,
            sanitized.record.effectivePrivacyPolicyHash,
            artifact.manifestHash,
            sanitizedContentHash,
            sourceRevisionHash,
            provenanceHash,
            grant.sourceOwnerPolicyId,
            grant.sourceOwnerPolicyVersion,
            grant.teamPolicyId,
            grant.teamPolicyVersion,
            grant.workspacePolicyId,
            grant.workspacePolicyVersion,
            artifact.sourceRevisionId,
            preview.sourceRevision
          ]
        );
        if (!resetResult.rows[0]) {
          throw new SharedMemoryConflictError(
            "Failed to reset Shared Memory representation state"
          );
        }
        if (preview.representation === "curated_assertions") {
          const assertionIds = sanitizedItems.map((item) => item.sourceId);
          const expiry = await client.query<{
            expires_at: Date | null;
            selected_count: number;
          }>(
            `select min(expires_at) as expires_at,
                    count(*)::integer as selected_count
               from curated_memory_assertions
              where id=any($1::uuid[]) and owner_user_id=$2
                and status='current' and suppressed_at is null
                and (expires_at is null or expires_at>now())`,
            [assertionIds, actor.userId]
          );
          if (expiry.rows[0]?.selected_count !== new Set(assertionIds).size) {
            throw new SharedMemoryConflictError(
              "Curated assertion validity changed after preview approval"
            );
          }
          await client.query(
            `update team_memory_representations
                set curated_expires_at=$2
              where id=$1`,
            [representationId, expiry.rows[0]?.expires_at ?? null]
          );
        }
        const finalAuthority = await client.query<Row>(
          `select semantic.id
             from team_memory_share_grant_records g
             join source_owner_representation_consent_records c
               on c.id=g.consent_id and c.id=$2
              and c.state='active' and c.revoked_at is null
              and (c.expires_at is null or c.expires_at>now())
             join users owner on owner.id=g.owner_user_id
              and owner.id=$5 and owner.disabled_at is null
              and owner.deleted_at is null
             join teams team on team.id=g.team_id
              and team.lifecycle='active'
              and team.entitlement_status in ('active','grace')
             join team_memberships membership
               on membership.team_id=g.team_id
              and membership.user_id=g.owner_user_id
              and membership.status='enabled'
              and membership.disabled_at is null
             join team_workspaces workspace
               on workspace.id=g.team_workspace_id
              and workspace.team_id=g.team_id
              and workspace.lifecycle='active'
              and workspace.archived_at is null
             join team_workspace_access_grants access
               on access.team_workspace_id=g.team_workspace_id
              and access.team_id=g.team_id
              and access.user_id=g.owner_user_id
              and access.access='write'
              and access.can_share_owned_memory=true
              and access.disabled_at is null
             join source_owner_representation_policies op
               on op.policy_id=g.source_owner_policy_id
              and op.version=g.source_owner_policy_version
              and op.superseded_at is null
             join team_representation_policies tp
               on tp.policy_id=g.team_policy_id
              and tp.version=g.team_policy_version
              and tp.team_id=g.team_id and tp.superseded_at is null
             join workspace_representation_policies wp
               on wp.policy_id=g.workspace_policy_id
              and wp.version=g.workspace_policy_version
              and wp.team_id=g.team_id
              and wp.team_workspace_id=g.team_workspace_id
              and wp.superseded_at is null
             join shared_source_preview_records preview
               on preview.id=$3 and preview.invalidated_at is null
              and preview.logical_memory_id=g.logical_memory_id
              and preview.remote_replica_id is not distinct from g.remote_replica_id
              and preview.owner_user_id=g.owner_user_id
              and preview.owner_principal_id=g.owner_principal_id
              and preview.team_id=g.team_id
              and preview.team_workspace_id=g.team_workspace_id
             join shared_source_artifact_records artifact
               on artifact.id=preview.source_artifact_id
              and artifact.invalidated_at is null
             left join lateral (
               select true as authorized
                 from memory_replicas replica
                 join cross_identity_sync_relationships relationship
                   on relationship.id=artifact.sync_relationship_id
                  and relationship.local_replica_id=replica.id
                  and relationship.logical_memory_id=g.logical_memory_id
                  and relationship.side='target'
                  and relationship.revoked_at is null
                  and relationship.state in (
                    'processing','partially_available','ready','stale'
                  )
                  and relationship.target_processing_cursor>=preview.source_revision
                where replica.id=g.remote_replica_id
                  and replica.replica_role='target'
                  and replica.encryption_scope='owner_private_replica'
                  and replica.lifecycle='active' and replica.disabled_at is null
                limit 1
                for share of replica,relationship
             ) captured_source on true
             join shared_source_semantic_previews semantic
               on semantic.id=$4 and semantic.status='ready'
              and semantic.invalidated_at is null
              and semantic.source_preview_id=preview.id
              and semantic.source_preview_revision=preview.preview_revision
              and semantic.source_preview_hash=preview.preview_hash
              and semantic.source_artifact_id=artifact.id
              and semantic.source_artifact_hash=artifact.artifact_hash
              and semantic.source_manifest_hash=artifact.manifest_hash
              and semantic.source_revision=preview.source_revision
              and semantic.source_hash=preview.source_hash
              and semantic.logical_memory_id=g.logical_memory_id
              and semantic.owner_user_id=g.owner_user_id
              and semantic.owner_principal_id=g.owner_principal_id
              and semantic.team_id=g.team_id
              and semantic.team_workspace_id=g.team_workspace_id
              and semantic.representation=preview.representation
             join privacy_classifier_generations generation
               on generation.id=semantic.classifier_generation_id
              and generation.version=semantic.classifier_version
              and generation.classifier_hash=semantic.classifier_hash
              and generation.status='active'
              and generation.revoked_at is null
            where g.id=$1 and g.revoked_at is null
              and (
                (g.source_kind='captured_session'
                  and captured_source.authorized=true)
                or (g.source_kind='personal_note'
                  and g.remote_replica_id is null
                  and g.source_session_id is null
                  and g.source_note_id=preview.source_note_id
                  and (g.source_memory_event_id=preview.source_memory_event_id
                    or (c.mode='continuous'
                      and preview.source_revision>g.source_revision))
                  and preview.source_kind='personal_note'
                  and artifact.source_kind='personal_note'
                  and artifact.sync_relationship_id is null)
              )
              and (
                g.lifecycle='active'
                or (g.lifecycle='unavailable' and exists (
                  select 1 from pending_share_operation_records pending
                   where pending.grant_id=g.id
                     and pending.owner_user_id=g.owner_user_id
                     and pending.consent_id=g.consent_id
                     and pending.state='preparing'
                     and pending.stage in ('activating','privacy_filtering')
                     and pending.revoked_at is null
                ))
              )
              and g.grant_version=$6
              and (c.mode='continuous' or (
                c.preview_id=preview.id and c.preview_hash=preview.preview_hash
                and c.source_revision=preview.source_revision
              ))
              and (c.maximum_authorized_source_revision is null
                or preview.source_revision<=c.maximum_authorized_source_revision)
              and ${cumulativeRepresentationAuthorizationSql("semantic.representation")}
            limit 1
            for share of g,c,owner,team,membership,workspace,access,op,tp,wp,
              preview,artifact,semantic,generation`,
          [
            grant.id,
            consent.id,
            preview.previewId,
            sanitized.record.id,
            actor.userId,
            input.expectedGrantVersion
          ]
        );
        if (!finalAuthority.rows[0]) {
          throw new SharedMemoryConflictError(
            "Sharing authority changed before Team materialization commit"
          );
        }
        const finalPrivacyPolicy = await resolveCurrentPrivacyPolicy(client, {
          ownerUserId: actor.userId,
          teamId: grant.teamId,
          teamWorkspaceId: grant.teamWorkspaceId,
          lockRows: true
        });
        if (
          finalPrivacyPolicy.effectivePolicyHash !==
          sanitized.record.effectivePrivacyPolicyHash
        ) {
          throw new SharedMemoryConflictError(
            "Effective privacy policy changed before Team materialization commit"
          );
        }
        const ownerPrivateProvider =
          await resolveOwnerPrivateReplicaEncryptionProvider({
            ownerUserId: actor.userId,
            ownerPrincipalId: grant.ownerPrincipalId,
            logicalMemoryId: grant.logicalMemoryId,
            remoteReplicaId: grant.remoteReplicaId,
            teamId: grant.teamId,
            teamWorkspaceId: grant.teamWorkspaceId,
            purpose: "decrypt"
          });
        const teamProvider = await options.resolveTeamEncryptionProvider({
          teamId: grant.teamId,
          purpose: "encrypt"
        });
        if (ownerPrivateProvider.keyId === teamProvider.keyId) {
          throw new SharedMemoryConflictError(
            "Owner-private source and Team representation require distinct encryption keys"
          );
        }
        if (preview.representation === "curated_assertions") {
          const personalProvider =
            await options.resolvePersonalEncryptionProvider({
              ownerUserId: actor.userId,
              purpose: "decrypt"
            });
          if (
            personalProvider.keyId === ownerPrivateProvider.keyId ||
            personalProvider.keyId === teamProvider.keyId
          ) {
            throw new SharedMemoryConflictError(
              "Personal, owner-private, and Team Curated Memory require distinct encryption keys"
            );
          }
        }
        const chunks = chunkItems(sanitizedItems);
        // Reconciliation metadata is rebuilt from the sanitized Team
        // representation. It carries only grant-scoped identity and positions;
        // embedding plaintext is never persisted here.
        await client.query(
          `delete from team_memory_semantic_items where representation_id=$1`,
          [representationId]
        );
        let itemOffset = 0;
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index]!;
          const envelope = await teamProvider.encrypt({
            plaintext: Buffer.from(JSON.stringify(chunk), "utf8"),
            scope: envelopeScope({
              teamId: grant.teamId,
              teamWorkspaceId: grant.teamWorkspaceId
            }),
            provenance: envelopeProvenance(representationId),
            ciphertextLocation: "team_memory_representation_chunks",
            aad: envelopeAad({
              representationId,
              shareGrantId: grant.id,
              teamId: grant.teamId,
              teamWorkspaceId: grant.teamWorkspaceId,
              logicalMemoryId: grant.logicalMemoryId,
              consentId: consent.id,
              representation: preview.representation,
              chunkIndex: index,
              chunkCount: chunks.length,
              itemOffset,
              itemCount: chunk.length,
              totalItemCount: sanitizedItems.length,
              binding: teamSourceBinding,
              sourceContentHash: sanitizedContentHash,
              provenanceHash
            })
          });
          await client.query(
            `insert into team_memory_representation_chunks (
             representation_id,share_grant_id,team_id,team_workspace_id,
             logical_memory_id,chunk_index,envelope_version,provider_mode,
             algorithm,key_id,key_version,ciphertext,ciphertext_hash,nonce,tag,
             wrapped_dek,aad,envelope_created_at,envelope_reencrypted_at,
             verified_at
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
             $17::jsonb,$18,$19,now()
           )
           on conflict (representation_id,chunk_index) do update
             set share_grant_id=excluded.share_grant_id,
                 team_id=excluded.team_id,
                 team_workspace_id=excluded.team_workspace_id,
                 logical_memory_id=excluded.logical_memory_id,
                 envelope_version=excluded.envelope_version,
                 provider_mode=excluded.provider_mode,
                 algorithm=excluded.algorithm,
                 key_id=excluded.key_id,
                 key_version=excluded.key_version,
                 ciphertext=excluded.ciphertext,
                 ciphertext_hash=excluded.ciphertext_hash,
                 nonce=excluded.nonce,
                 tag=excluded.tag,
                 wrapped_dek=excluded.wrapped_dek,
                 aad=excluded.aad,
                 envelope_created_at=excluded.envelope_created_at,
                 envelope_reencrypted_at=excluded.envelope_reencrypted_at,
                 verified_at=now(),
                 purged_at=null`,
            [
              representationId,
              grant.id,
              grant.teamId,
              grant.teamWorkspaceId,
              grant.logicalMemoryId,
              index,
              envelope.version,
              envelope.providerMode,
              envelope.algorithm,
              envelope.keyId,
              envelope.keyVersion,
              envelope.ciphertext,
              ciphertextHash(envelope.ciphertext),
              envelope.nonce,
              envelope.tag,
              JSON.stringify(envelope.wrappedDek),
              JSON.stringify(envelope.aad),
              envelope.createdAt,
              envelope.reencryptedAt
            ]
          );
          for (
            let chunkItemIndex = 0;
            chunkItemIndex < chunk.length;
            chunkItemIndex += 1
          ) {
            const item = chunk[chunkItemIndex]!;
            const sourceItemIndex = itemOffset + chunkItemIndex;
            await client.query(
              `insert into team_memory_semantic_items (
                 representation_id,share_grant_id,team_id,team_workspace_id,
                 logical_memory_id,pseudonymous_source_id,source_item_index,
                 encrypted_chunk_index,encrypted_chunk_item_index,item_type,
                 occurred_at,source_revision,representation_policy_revision,
                 content_policy_version,classifier_version,content_hash,
                 embedding_state
               ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending')`,
              [
                representationId,
                grant.id,
                grant.teamId,
                grant.teamWorkspaceId,
                grant.logicalMemoryId,
                sharedMemoryGrantScopedSourceId(grant.id, item.sourceId),
                sourceItemIndex,
                index,
                chunkItemIndex,
                item.itemType,
                item.occurredAt,
                preview.sourceRevision,
                grant.fidelityPolicyRevision,
                grant.contentPolicyVersion,
                grant.classifierVersion,
                sharedMemoryEmbeddingInputHash(item)
              ]
            );
          }
          itemOffset += chunk.length;
        }
        await client.query(
          `delete from team_memory_representation_chunks
          where representation_id=$1
            and chunk_index >= $2`,
          [representationId, chunks.length]
        );
        const staleState =
          nullableString(grantRow.replica_freshness_status) === "stale" ||
          nullableString(grantRow.sync_relationship_state) === "stale" ||
          (consent.mode === "continuous" &&
            preview.sourceRevision < authoritativeSourceCursor);
        const finalized = await client.query<Row>(
          `update team_memory_representations
            set state=$2::memory_representation_state,
                chunk_count=$3,
                freshness_evaluated_at=now(),
                available_at=case when $2::memory_representation_state='pending' then null
                  else coalesce(available_at, now()) end,
                stale_at=$4,
                updated_at=now()
          where id=$1
          returning *`,
          [
            representationId,
            pendingActivation?.rows[0] ||
            pendingContinuousNoteAdvancement?.rows[0]
              ? "pending"
              : staleState
                ? "stale"
                : "available",
            chunks.length,
            staleState ? new Date() : null
          ]
        );
        if (
          !pendingContinuousNoteAdvancement?.rows[0] &&
          consent.mode === "continuous" &&
          preview.sourceRevision > grant.sourceRevision
        ) {
          await client.query(
            `update team_memory_share_grants
              set source_revision=$2,source_revision_id=$3,updated_at=now()
            where id=$1`,
            [grant.id, preview.sourceRevision, artifact.sourceRevisionId]
          );
        }
        if (
          !pendingActivation?.rows[0] &&
          !pendingContinuousNoteAdvancement?.rows[0]
        ) {
          await appendOutbox(client, {
            mutationId: input.mutationId,
            family: representationAvailableFamily(preview.representation),
            teamId: grant.teamId,
            teamWorkspaceId: grant.teamWorkspaceId,
            shareGrantId: grant.id,
            logicalMemoryId: grant.logicalMemoryId,
            resourceType: "team_memory_representation",
            resourceId: representationId,
            actorPrincipalId: actor.userId
          });
        }
        if (remediationRecovery?.rows[0]) {
          await client.query(
            `update team_memory_share_grants
                set lifecycle='active',grant_version=grant_version+1,
                    updated_at=now()
              where id=$1 and lifecycle='unavailable' and revoked_at is null`,
            [grant.id]
          );
          const resumed = await client.query<Row>(
            `update pending_share_operations
                set state='activated',stage='complete',
                    workspace_access_state='active',source_update_state='active',
                    redacted_failure_code=null,last_progress_at=now(),updated_at=now(),
                    operation_version=operation_version+1
              where id=$1 and state='needs_attention'
                and operation_version=$2 and revoked_at is null
              returning operation_version`,
            [
              remediationRecovery.rows[0].id,
              remediationRecovery.rows[0].operation_version
            ]
          );
          if (!resumed.rows[0]) {
            throw new SharedMemoryConflictError(
              "Approval Activity remediation recovery changed concurrently"
            );
          }
          await appendOutbox(client, {
            mutationId: crossIdentitySyncDeterministicUuid({
              kind: "approval_activity_continuous_rebuilt",
              shareGrantId: grant.id,
              sourceRevision: preview.sourceRevision
            }),
            family: "share_grant_lifecycle",
            teamId: grant.teamId,
            teamWorkspaceId: grant.teamWorkspaceId,
            shareGrantId: grant.id,
            logicalMemoryId: grant.logicalMemoryId,
            resourceType: "team_memory_share_grant",
            resourceId: grant.id,
            actorPrincipalId: actor.userId
          });
          await appendPendingShareOwnerEvent(client, {
            mutationId: crossIdentitySyncDeterministicUuid({
              kind: "pending_share_lifecycle",
              pendingShareId: stringValue(remediationRecovery.rows[0].id),
              state: "activated",
              reason: "approval_content_remediation_rebuilt",
              operationVersion: numberValue(resumed.rows[0].operation_version)
            }),
            ownerUserId: actor.userId,
            pendingShareId: stringValue(remediationRecovery.rows[0].id)
          });
        }
        return mapRepresentation({
          ...(finalized.rows[0] as Row),
          ...sourceRefRow(artifact.source!)
        });
      };
      return transactionClient
        ? command(transactionClient)
        : withTransaction(pool, command);
    },

    async advanceContinuousGrantRepresentations(input) {
      assertUuid(input.remoteReplicaId, "remoteReplicaId");
      if (
        !Number.isSafeInteger(input.sourceRevision) ||
        input.sourceRevision < 0
      ) {
        throw new SharedMemoryConflictError("Source revision is invalid");
      }
      const candidates = await pool.query<Row>(
        `select g.id,g.owner_user_id,g.logical_memory_id,
                g.remote_replica_id,g.team_id,g.team_workspace_id,
                g.maximum_fidelity,g.include_curated_memory,g.grant_version,
                g.source_capabilities,g.activation_representation,g.mode,
                consent.id as consent_id
           from team_memory_share_grant_records g
           join source_owner_representation_consent_records consent
             on consent.id=g.consent_id
            and consent.mode='continuous'
            and consent.state='active'
            and consent.revoked_at is null
            and (consent.expires_at is null or consent.expires_at>now())
          where g.remote_replica_id=$1
            and (
              g.lifecycle='active'
              or (g.lifecycle='unavailable' and exists (
                select 1 from pending_share_operation_records pending
                 where pending.grant_id=g.id
                   and pending.state='needs_attention'
                   and pending.redacted_failure_code='approval_content_remediation'
                   and pending.revoked_at is null
              ))
            )
            and g.revoked_at is null
            and g.source_revision<$2
          order by g.id`,
        [input.remoteReplicaId, input.sourceRevision]
      );
      let advanced = 0;
      for (const row of candidates.rows) {
        const grantId = stringValue(row.id);
        const actor = { userId: stringValue(row.owner_user_id) };
        const maximumFidelity = stringValue(
          row.maximum_fidelity
        ) as SharedMemoryFidelityCeiling;
        const includeCuratedMemory = row.include_curated_memory === true;
        const representations: SharedMemoryRepresentation[] = [
          ...sharedMemoryRepresentationsForCeiling(maximumFidelity),
          ...(includeCuratedMemory ? (["curated_assertions"] as const) : [])
        ];
        for (const representation of representations) {
          const preview = await createAuthoritativeSourcePreview(
            actor,
            {
              logicalMemoryId: stringValue(row.logical_memory_id),
              remoteReplicaId: stringValue(row.remote_replica_id),
              teamId: stringValue(row.team_id),
              teamWorkspaceId: stringValue(row.team_workspace_id),
              representation,
              sourceCapabilities: representationArrayValue(
                row.source_capabilities
              ),
              activationRepresentation: representationValue(
                row.activation_representation
              ),
              mode: stringValue(row.mode) as SharedMemoryConsentMode,
              maximumFidelity,
              includeCuratedMemory
            },
            grantId
          );
          if (preview.sourceRevision !== input.sourceRevision) {
            throw new SharedMemoryConflictError(
              "Continuous preview revision does not match the synced replica"
            );
          }
          advanced += 1;
        }
      }
      return { advanced };
    },

    async reconcileCuratedGrantRepresentations(actor) {
      const candidates = await pool.query<Row>(
        `select g.id,g.logical_memory_id,g.remote_replica_id,g.team_id,
                g.team_workspace_id,g.grant_version,g.consent_id,
                c.maximum_fidelity,c.include_curated_memory,
                g.source_capabilities,g.activation_representation,g.mode
           from team_memory_share_grant_records g
           join source_owner_representation_consent_records c on c.id=g.consent_id
            and c.mode='continuous' and c.state='active' and c.revoked_at is null
            and (c.expires_at is null or c.expires_at>now())
          where g.owner_user_id=$1 and g.lifecycle='active' and g.revoked_at is null
            and g.include_curated_memory and c.include_curated_memory
          order by g.id`,
        [actor.userId]
      );
      let rematerialized = 0;
      let invalidated = 0;
      for (const row of candidates.rows) {
        const grantId = stringValue(row.id);
        try {
          await createAuthoritativeSourcePreview(
            actor,
            {
              logicalMemoryId: stringValue(row.logical_memory_id),
              remoteReplicaId: stringValue(row.remote_replica_id),
              teamId: stringValue(row.team_id),
              teamWorkspaceId: stringValue(row.team_workspace_id),
              representation: "curated_assertions",
              sourceCapabilities: representationArrayValue(
                row.source_capabilities
              ),
              activationRepresentation: representationValue(
                row.activation_representation
              ),
              mode: stringValue(row.mode) as SharedMemoryConsentMode,
              maximumFidelity: stringValue(
                row.maximum_fidelity
              ) as SharedMemoryFidelityCeiling,
              includeCuratedMemory: true
            },
            grantId
          );
          rematerialized += 1;
        } catch (error) {
          if (!(error instanceof SharedMemoryConflictError)) throw error;
          await pool.query(
            `with invalidated as (
               update team_memory_representations
                  set state='invalidated',invalidated_at=now(),updated_at=now(),
                      invalidation_reason_code='curated_evidence_ineligible',
                      record_version=record_version+1
                where share_grant_id=$1 and representation='curated_assertions'
                  and state in ('pending','available','stale')
                returning id
             )
             delete from team_memory_semantic_items
              where representation_id in (select id from invalidated)`,
            [grantId]
          );
          invalidated += 1;
        }
      }
      return { rematerialized, invalidated };
    },

    async listWorkspaceGrants(actor, input) {
      assertUuid(input.teamId, "teamId");
      assertUuid(input.teamWorkspaceId, "teamWorkspaceId");
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_WORKSPACE_INDEX_LIMIT
      ) {
        throw new TypeError(
          `limit must be between 1 and ${MAX_WORKSPACE_INDEX_LIMIT}`
        );
      }
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        input.offset > MAX_WORKSPACE_INDEX_OFFSET
      ) {
        throw new TypeError(
          `offset must be between 0 and ${MAX_WORKSPACE_INDEX_OFFSET}`
        );
      }

      return withTransaction(pool, async (client) => {
        await client.query(
          "set transaction isolation level repeatable read read only"
        );
        await requireWorkspaceAccess(
          client,
          actor,
          input.teamId,
          input.teamWorkspaceId,
          "read"
        );
        const result = await client.query<Row>(
          `select g.id as share_grant_id,g.logical_memory_id,g.owner_user_id,
                share_owner.display_name as owner_display_name,g.display_title,
                g.team_id,g.team_workspace_id,g.maximum_fidelity,
                g.include_curated_memory,g.source_capabilities,
                g.activation_representation,
                r.representation as active_representation,
                g.lifecycle,g.created_at,g.updated_at,
                r.state as representation_state,
                r.source_revision as representation_source_revision,
                r.updated_at as representation_updated_at,
                mr.freshness_status as replica_freshness_status,
                sr.state as sync_relationship_state,
                sr.target_processing_cursor,
                c.mode as consent_mode
           from team_memory_share_grant_records g
           join teams t on t.id=g.team_id and t.lifecycle='active'
             and t.entitlement_status in ('active','grace')
           join team_memberships tm on tm.team_id=g.team_id and tm.user_id=$1
             and tm.status='enabled' and tm.disabled_at is null
           join users u on u.id=tm.user_id and u.disabled_at is null and u.deleted_at is null
           left join users share_owner on share_owner.id=g.owner_user_id
             and share_owner.disabled_at is null and share_owner.deleted_at is null
           join team_workspaces tw on tw.id=g.team_workspace_id and tw.team_id=g.team_id
             and tw.lifecycle='active' and tw.archived_at is null
           join team_workspace_access_grants wa on wa.team_workspace_id=tw.id
             and wa.team_id=g.team_id and wa.user_id=$1 and wa.disabled_at is null
             and wa.access in ('read','write')
           join source_owner_representation_consent_records c on c.id=g.consent_id
             and c.state in ('active','paused') and c.revoked_at is null
             and (c.expires_at is null or c.expires_at>now())
           join source_owner_representation_policies op on op.policy_id=g.source_owner_policy_id
             and op.version=g.source_owner_policy_version and op.superseded_at is null
           join team_representation_policies tp on tp.policy_id=g.team_policy_id
             and tp.version=g.team_policy_version and tp.team_id=g.team_id
             and tp.superseded_at is null
           join workspace_representation_policies wp on wp.policy_id=g.workspace_policy_id
             and wp.version=g.workspace_policy_version and wp.team_id=g.team_id
             and wp.team_workspace_id=g.team_workspace_id and wp.superseded_at is null
           left join memory_replicas mr on mr.id=g.remote_replica_id and mr.replica_role='target'
             and mr.encryption_scope='owner_private_replica' and mr.lifecycle='active'
             and mr.disabled_at is null
           left join cross_identity_sync_relationships sr on sr.local_replica_id=mr.id
             and sr.logical_memory_id=g.logical_memory_id and sr.side='target'
           join lateral (
             select r0.representation,r0.state,r0.source_revision,r0.updated_at
               from team_memory_representation_records r0
              where r0.share_grant_id=g.id and r0.consent_id=g.consent_id
                and ${cumulativeRepresentationAuthorizationSql("r0.representation")}
                and r0.state in ('available','stale')
                and r0.invalidated_at is null
                and (r0.curated_expires_at is null or r0.curated_expires_at>now())
                and r0.source_owner_policy_id=g.source_owner_policy_id
                and r0.source_owner_policy_version=g.source_owner_policy_version
                and r0.team_policy_id=g.team_policy_id
                and r0.team_policy_version=g.team_policy_version
                and r0.workspace_policy_id=g.workspace_policy_id
                and r0.workspace_policy_version=g.workspace_policy_version
                and r0.fidelity_policy_revision=g.fidelity_policy_revision
                and r0.content_policy_version=g.content_policy_version
                and r0.classifier_version=g.classifier_version
                and (c.maximum_authorized_source_revision is null
                  or r0.source_revision<=c.maximum_authorized_source_revision)
              order by r0.source_revision desc,r0.available_at desc,r0.id desc
              limit 1
           ) r on true
          where g.team_id=$2 and g.team_workspace_id=$3
            and g.lifecycle='active' and g.revoked_at is null
            and (
              (g.source_kind='captured_session' and mr.id is not null and sr.id is not null)
              or (g.source_kind='personal_note' and g.remote_replica_id is null)
            )
            and ${cumulativeRepresentationAuthorizationSql("g.maximum_fidelity")}
            and (not g.include_curated_memory or (
              c.include_curated_memory and op.include_curated_memory
              and tp.include_curated_memory and wp.include_curated_memory
            ))
          order by g.updated_at desc,g.id desc
          limit $4 offset $5`,
          [
            actor.userId,
            input.teamId,
            input.teamWorkspaceId,
            input.limit + 1,
            input.offset
          ]
        );
        const hasMore = result.rows.length > input.limit;
        return {
          entries: result.rows
            .slice(0, input.limit)
            .map(mapWorkspaceIndexEntry),
          limit: input.limit,
          offset: input.offset,
          hasMore
        };
      });
    },

    async listOwnerGrants(actor, input) {
      assertUuid(input.logicalMemoryId, "logicalMemoryId");
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_WORKSPACE_INDEX_LIMIT
      ) {
        throw new TypeError(
          `limit must be between 1 and ${MAX_WORKSPACE_INDEX_LIMIT}`
        );
      }
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        input.offset > MAX_WORKSPACE_INDEX_OFFSET
      ) {
        throw new TypeError(
          `offset must be between 0 and ${MAX_WORKSPACE_INDEX_OFFSET}`
        );
      }

      return withTransaction(pool, async (client) => {
        await client.query(
          "set transaction isolation level repeatable read read only"
        );
        const result = await client.query<Row>(
          `select g.*
             from team_memory_share_grant_records g
            where g.logical_memory_id=$1 and g.owner_user_id=$2
            order by g.updated_at desc,g.id desc
            limit $3 offset $4`,
          [input.logicalMemoryId, actor.userId, input.limit + 1, input.offset]
        );
        return {
          entries: result.rows.slice(0, input.limit).map(mapGrant),
          limit: input.limit,
          offset: input.offset,
          hasMore: result.rows.length > input.limit
        };
      });
    },

    async listOwnerShares(actor, input) {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_WORKSPACE_INDEX_LIMIT
      ) {
        throw new TypeError(
          `limit must be between 1 and ${MAX_WORKSPACE_INDEX_LIMIT}`
        );
      }
      const history = input.history ?? false;
      return withTransaction(pool, async (client) => {
        await client.query(
          "set transaction isolation level repeatable read read only"
        );
        const snapshotAt = input.snapshotAt
          ? new Date(input.snapshotAt)
          : (
              await client.query<{ now: Date }>(
                "select transaction_timestamp() as now"
              )
            ).rows[0]!.now;
        if (Number.isNaN(snapshotAt.getTime())) {
          throw new TypeError("snapshotAt must be a timestamp");
        }
        const afterCreatedAt = input.after
          ? new Date(input.after.createdAt)
          : null;
        if (afterCreatedAt && Number.isNaN(afterCreatedAt.getTime())) {
          throw new TypeError("Owned-share keyset timestamp is invalid");
        }
        if (input.after) {
          assertUuid(input.after.id, "ownedShareCursorId");
        }
        const result = await client.query<Row>(
          `select owned.record_kind,owned.payload,owned.source_access,
                  owned.effective_source_kind,owned.effective_source_session_id,
                  owned.effective_source_note_id,owned.effective_source_memory_event_id,
                  owned.effective_source_revision,
                  jsonb_build_object(
                    'sourceSessionId',s.id,
                    'companionThreadId',case when workspace_access.available
                      then companion.id else null end,
                    'sourceTitle',coalesce(nullif(btrim(owned.display_title),''),
                                           nullif(btrim(s.metadata ->> 'threadName'),''),
                                           s.external_session_id,'Untitled conversation'),
                    'teamName',t.name,'workspaceName',w.name,
                    'workspaceContentAccess',case when workspace_access.available
                      then 'available' else 'unavailable' end,
                    'mode',coalesce(c.mode,owned.share_mode),
                    'authorizedPreview',case when not workspace_access.available
                      or coalesce(c.preview_id,owned.preview_id) is null
                      then null else jsonb_build_object(
                        'previewId',coalesce(c.preview_id,owned.preview_id),
                        'previewHash',coalesce(c.preview_hash,owned.preview_hash),
                        'previewRevision',coalesce(c.preview_revision,owned.preview_revision),
                        'sourceRevision',coalesce(c.source_revision,owned.source_revision)) end,
                    'lastReadyRevision',ready.source_revision,
                    'lastSuccessfulUpdateAt',ready.available_at
                  ) as summary,
                  owned.created_at as sort_created_at,owned.record_kind as sort_record_kind,
                  owned.sort_id
             from (
               select 'pending'::text as record_kind,
                      to_jsonb(p) || jsonb_build_object(
                        'grant_version',activated_grant.grant_version
                      ) as payload,
                      case when source.id is null then null else
                        jsonb_build_object('mode',source.mode,'lifecycle',source.lifecycle,
                                           'version',source.version) end as source_access,
                      p.logical_memory_id,p.team_id,p.team_workspace_id,p.display_title,
                      coalesce(p.replacement_consent_id,p.consent_id) as consent_id,
                      coalesce(p.replacement_mode,p.mode) as share_mode,
                      coalesce(p.replacement_preview_id,p.preview_id) as preview_id,
                      coalesce(p.replacement_preview_hash,p.preview_hash) as preview_hash,
                      coalesce(p.replacement_preview_revision,p.preview_revision) as preview_revision,
                      coalesce(p.replacement_source_revision,p.source_revision) as source_revision,
                      preview.source_kind as effective_source_kind,
                      preview.source_session_id as effective_source_session_id,
                      preview.source_note_id as effective_source_note_id,
                      preview.source_memory_event_id as effective_source_memory_event_id,
                      preview.source_revision as effective_source_revision,
                      p.grant_id,p.created_at,p.id as sort_id
                 from pending_share_operation_records p
                 join shared_memory_candidate_preview_records preview
                   on preview.id=coalesce(p.replacement_preview_id,p.preview_id)
                 left join lateral (
                   select s.id,s.mode,s.lifecycle,s.version
                     from team_conversation_source_grants s
                    where s.share_grant_id=p.grant_id
                   order by s.updated_at desc,s.id desc limit 1
                 ) source on true
                 left join team_memory_share_grant_records activated_grant
                   on activated_grant.id=p.grant_id
                where p.owner_user_id=$1
                  and p.created_at<=$4
                  and (($2::boolean and p.state='revoked')
                    or (not $2::boolean and
                        p.state in ('preparing','needs_attention','failed','activated')))
               union all
               select 'grant'::text as record_kind,to_jsonb(g) as payload,
                      case when source.id is null then null else
                        jsonb_build_object('mode',source.mode,'lifecycle',source.lifecycle,
                                           'version',source.version) end as source_access,
                      g.logical_memory_id,g.team_id,g.team_workspace_id,g.display_title,g.consent_id,
                      null::shared_memory_consent_mode as share_mode,
                      null::uuid as preview_id,null::text as preview_hash,
                      null::integer as preview_revision,null::bigint as source_revision,
                      g.source_kind as effective_source_kind,
                      g.source_session_id as effective_source_session_id,
                      g.source_note_id as effective_source_note_id,
                      g.source_memory_event_id as effective_source_memory_event_id,
                      g.source_revision as effective_source_revision,
                      g.id as grant_id,g.created_at,g.id as sort_id
                 from team_memory_share_grant_records g
                 left join lateral (
                   select s.id,s.mode,s.lifecycle,s.version
                     from team_conversation_source_grants s
                    where s.share_grant_id=g.id
                    order by s.updated_at desc,s.id desc limit 1
                 ) source on true
                where g.owner_user_id=$1
                  and g.created_at<=$4
                  and not exists (
                    select 1 from pending_share_operation_records p
                     where p.grant_id=g.id
                  )
                  and (($2::boolean and
                        g.lifecycle in ('revoked','tombstoned','purge_pending','purged'))
                    or (not $2::boolean and
                        g.lifecycle in ('active','unavailable')))
             ) owned
             left join logical_memories lm on lm.id=owned.logical_memory_id
             left join local_captured_session_logical_memories local_memory
               on local_memory.logical_memory_id=lm.id
              and local_memory.owner_user_id=$1
             left join sessions s on s.id=local_memory.local_session_id and s.owner_user_id=$1
             join teams t on t.id=owned.team_id
             join team_workspaces w on w.id=owned.team_workspace_id and w.team_id=owned.team_id
             cross join lateral (
               select exists (
                 select 1
                   from team_memberships tm
                   join users owner_user on owner_user.id=tm.user_id
                    and owner_user.disabled_at is null and owner_user.deleted_at is null
                   join team_workspace_access_grants wa
                     on wa.team_id=tm.team_id
                    and wa.team_workspace_id=owned.team_workspace_id
                    and wa.user_id=tm.user_id
                    and wa.access in ('read','write')
                    and wa.disabled_at is null
                  where tm.team_id=owned.team_id and tm.user_id=$1
                    and tm.status='enabled' and tm.disabled_at is null
                    and t.lifecycle='active'
                    and t.entitlement_status in ('active','grace')
                    and w.lifecycle='active' and w.archived_at is null
               ) as available
             ) workspace_access
             left join source_owner_representation_consent_records c on c.id=owned.consent_id
             left join lateral (
               select ct.id
                 from collaboration_threads ct
                where ct.kind='shared_session_discussion'
                  and ct.share_grant_id=owned.grant_id
                  and ct.team_id=owned.team_id
                  and ct.team_workspace_id=owned.team_workspace_id
                  and ct.shared_logical_memory_id=owned.logical_memory_id
                  and ct.lifecycle='active'
                order by ct.created_at,ct.id limit 1
             ) companion on true
             left join lateral (
               select r.source_revision,r.available_at
                 from team_memory_representation_records r
                where r.share_grant_id=owned.grant_id and r.state='available'
                order by r.source_revision desc,r.updated_at desc limit 1
             ) ready on true
            where ($5::timestamptz is null or
                   owned.created_at < $5::timestamptz or
                   (owned.created_at = $5::timestamptz and owned.record_kind > $6::text) or
                   (owned.created_at = $5::timestamptz and owned.record_kind = $6::text
                    and owned.sort_id < $7::uuid))
            order by owned.created_at desc,owned.record_kind asc,owned.sort_id desc
            limit $3`,
          [
            actor.userId,
            history,
            input.limit + 1,
            snapshotAt,
            afterCreatedAt,
            input.after?.recordKind ?? null,
            input.after?.id ?? null
          ]
        );
        const pageRows = result.rows.slice(0, input.limit);
        const last = pageRows.at(-1);
        const hasMore = result.rows.length > input.limit;
        return {
          entries: pageRows.map((row) => {
            const payload = row.payload as Row;
            const effectiveSource = pendingShareSourceRefFromRow({
              ...payload,
              effective_source_kind: row.effective_source_kind,
              effective_source_session_id: row.effective_source_session_id,
              effective_source_note_id: row.effective_source_note_id,
              effective_source_memory_event_id:
                row.effective_source_memory_event_id,
              effective_source_revision: row.effective_source_revision
            });
            const source = row.source_access as Row | null;
            const rawSummary = row.summary as Row;
            const rawPreview = rawSummary.authorizedPreview as Row | null;
            const summary: OwnedShareSummary = {
              source:
                effectiveSource ??
                (() => {
                  throw new SharedMemoryConflictError(
                    "Owned Share source metadata is required"
                  );
                })(),
              sourceSessionId: nullableString(rawSummary.sourceSessionId),
              companionThreadId: nullableString(rawSummary.companionThreadId),
              sourceTitle: stringValue(rawSummary.sourceTitle),
              teamName: stringValue(rawSummary.teamName),
              workspaceName: stringValue(rawSummary.workspaceName),
              workspaceContentAccess:
                rawSummary.workspaceContentAccess === "available"
                  ? "available"
                  : "unavailable",
              mode: rawSummary.mode as "snapshot" | "continuous",
              authorizedPreview: rawPreview
                ? {
                    previewId: stringValue(rawPreview.previewId),
                    previewHash: stringValue(rawPreview.previewHash),
                    previewRevision: numberValue(rawPreview.previewRevision),
                    sourceRevision: numberValue(rawPreview.sourceRevision)
                  }
                : null,
              lastReadyRevision: nullableNumber(rawSummary.lastReadyRevision),
              lastSuccessfulUpdateAt: nullableIso(
                rawSummary.lastSuccessfulUpdateAt
              )
            };
            const sourceAccess: OwnedConversationSourceAccessSummary = source
              ? {
                  mode: source.mode as "snapshot" | "continuous",
                  lifecycle: source.lifecycle as "active" | "revoked",
                  version: numberValue(source.version)
                }
              : null;
            return stringValue(row.record_kind) === "pending"
              ? ({
                  kind: "pending",
                  pendingShare: mapPendingShare({
                    ...payload,
                    effective_source_kind: row.effective_source_kind,
                    effective_source_session_id:
                      row.effective_source_session_id,
                    effective_source_note_id: row.effective_source_note_id,
                    effective_source_memory_event_id:
                      row.effective_source_memory_event_id,
                    effective_source_revision: row.effective_source_revision
                  }),
                  sourceAccess,
                  summary
                } as const)
              : ({
                  kind: "grant",
                  grant: mapGrant(payload),
                  sourceAccess,
                  summary
                } as const);
          }),
          limit: input.limit,
          hasMore,
          snapshotAt: snapshotAt.toISOString(),
          next:
            hasMore && last
              ? {
                  createdAt: iso(last.sort_created_at),
                  recordKind: stringValue(last.sort_record_kind) as
                    | "grant"
                    | "pending",
                  id: stringValue(last.sort_id)
                }
              : null
        };
      });
    },

    async getOwnerShare(actor, input) {
      assertUuid(input.id, "ownedShareId");
      for (const history of [false, true]) {
        let after:
          | { createdAt: string; recordKind: "grant" | "pending"; id: string }
          | undefined;
        let snapshotAt: string | undefined;
        for (;;) {
          const page = await repository.listOwnerShares(actor, {
            limit: MAX_WORKSPACE_INDEX_LIMIT,
            history,
            snapshotAt,
            after
          });
          snapshotAt = page.snapshotAt;
          const match = page.entries.find(
            (entry) =>
              entry.kind === input.kind &&
              (entry.kind === "pending"
                ? entry.pendingShare.id === input.id
                : entry.grant.id === input.id)
          );
          if (match) return match;
          if (!page.hasMore || !page.next) break;
          after = page.next;
        }
      }
      return null;
    },

    async readOwnerSharePreview(actor, input) {
      const ownedShare = await repository.getOwnerShare(actor, input);
      if (ownedShare?.summary.workspaceContentAccess !== "available") {
        return null;
      }
      const previewReference = ownedShare?.summary.authorizedPreview;
      if (!previewReference) return null;
      return withTransaction(pool, async (client) => {
        await client.query(
          "set transaction isolation level repeatable read read only"
        );
        const authorized = await client.query(
          `select 1 from shared_source_preview_records
            where id=$1 and preview_hash=$2 and owner_user_id=$3
              and invalidated_at is null
            limit 1`,
          [
            previewReference.previewId,
            previewReference.previewHash,
            actor.userId
          ]
        );
        if ((authorized.rowCount ?? 0) !== 1) return null;
        const loaded = await loadPersistedPreviewByReference(client, {
          preview: previewReference,
          requiredMessage: "Owned Shared Memory preview is unavailable"
        });
        return loaded.preview;
      });
    },

    async listPendingSharedMemorySemanticItems(input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 32, 1), 128);
      const authorizedRows = await withTransaction(pool, async (client) => {
        const readiness = await client.query<Row>(
          `select count(*)::integer as missing_count
             from team_memory_representation_records r
             join team_memory_share_grant_records g on g.id=r.share_grant_id
               and g.lifecycle='active' and g.revoked_at is null
               and ${grantAuthorizesRepresentationSql("r.representation")}
            where r.state in ('available','stale') and r.invalidated_at is null
              and (r.curated_expires_at is null or r.curated_expires_at>now())
              and not exists (
                select 1 from team_memory_semantic_items smi
                 where smi.representation_id=r.id
              )`
        );
        if (numberValue(readiness.rows[0]?.missing_count) > 0) {
          throw new SharedMemoryConflictError(
            "Active Team representations predate semantic metadata; reset or rematerialize them before semantic recall"
          );
        }
        const claimed = await client.query<Row>(
          `select smi.*,
                r.representation,r.source_revision as representation_source_revision,
                chunk.envelope_version,chunk.provider_mode,chunk.algorithm,
                chunk.key_id,chunk.key_version,chunk.ciphertext,
                chunk.ciphertext_hash,chunk.nonce,chunk.tag,chunk.wrapped_dek,
                chunk.aad,chunk.envelope_created_at,chunk.envelope_reencrypted_at
           from team_memory_semantic_items smi
           join team_memory_representation_records r on r.id=smi.representation_id
             and r.share_grant_id=smi.share_grant_id
             and r.team_id=smi.team_id and r.team_workspace_id=smi.team_workspace_id
             and r.logical_memory_id=smi.logical_memory_id
             and r.state in ('available','stale') and r.invalidated_at is null
             and (r.curated_expires_at is null or r.curated_expires_at>now())
           join team_memory_share_grant_records g on g.id=r.share_grant_id
             and g.lifecycle='active' and g.revoked_at is null
             and g.consent_id=r.consent_id
           join teams t on t.id=g.team_id and t.lifecycle='active'
             and t.entitlement_status in ('active','grace')
           join team_workspaces tw on tw.id=g.team_workspace_id and tw.team_id=g.team_id
             and tw.lifecycle='active' and tw.archived_at is null
           join source_owner_representation_consent_records consent on consent.id=g.consent_id
             and consent.state='active' and consent.revoked_at is null
             and (consent.expires_at is null or consent.expires_at>now())
           join source_owner_representation_policies op on op.policy_id=g.source_owner_policy_id
             and op.version=g.source_owner_policy_version and op.superseded_at is null
           join team_representation_policies tp on tp.policy_id=g.team_policy_id
             and tp.version=g.team_policy_version and tp.team_id=g.team_id and tp.superseded_at is null
           join workspace_representation_policies wp on wp.policy_id=g.workspace_policy_id
             and wp.version=g.workspace_policy_version and wp.team_id=g.team_id
             and wp.team_workspace_id=g.team_workspace_id and wp.superseded_at is null
           left join memory_replicas mr on mr.id=g.remote_replica_id
             and mr.replica_role='target' and mr.encryption_scope='owner_private_replica'
             and mr.lifecycle='active' and mr.disabled_at is null
           left join cross_identity_sync_relationships sr on sr.local_replica_id=mr.id
             and sr.logical_memory_id=g.logical_memory_id and sr.side='target'
             and sr.revoked_at is null
             and sr.state in ('processing','partially_available','ready','stale')
           join shared_source_preview_records sp on sp.id=r.source_preview_id and sp.invalidated_at is null
           join shared_source_artifact_records sa on sa.id=r.source_artifact_id and sa.invalidated_at is null
           join shared_source_semantic_previews semantic
             on semantic.id=r.sanitized_source_preview_id
            and semantic.source_preview_id=sp.id
            and semantic.source_preview_revision=sp.preview_revision
            and semantic.source_preview_hash=sp.preview_hash
            and semantic.source_artifact_id=sa.id
            and semantic.source_artifact_hash=sa.artifact_hash
            and semantic.source_manifest_hash=sa.manifest_hash
            and semantic.source_revision=r.source_revision
            and semantic.source_hash=sp.source_hash
            and semantic.owner_user_id=g.owner_user_id
            and semantic.owner_principal_id=g.owner_principal_id
            and semantic.team_id=g.team_id
            and semantic.team_workspace_id=g.team_workspace_id
            and semantic.representation=r.representation
            and semantic.classifier_generation_id=r.privacy_classifier_generation_id
            and semantic.classifier_hash=r.privacy_classifier_hash
            and semantic.effective_privacy_policy_hash=r.effective_privacy_policy_hash
            and semantic.sanitized_content_hash=r.sanitized_content_hash
            and semantic.status='ready' and semantic.invalidated_at is null
           join privacy_classifier_generations privacy_classifier
             on privacy_classifier.id=semantic.classifier_generation_id
            and privacy_classifier.version=semantic.classifier_version
            and privacy_classifier.classifier_hash=semantic.classifier_hash
            and privacy_classifier.status='active'
            and privacy_classifier.revoked_at is null
           join team_memory_representation_chunks chunk
             on chunk.representation_id=r.id
             and chunk.share_grant_id=g.id
             and chunk.chunk_index=smi.encrypted_chunk_index
             and chunk.purged_at is null
          where smi.embedding_state in ('pending','failed','processing','embedded')
            and (
              (g.source_kind='captured_session' and mr.id is not null and sr.id is not null)
              or (g.source_kind='personal_note' and g.remote_replica_id is null)
            )
            and smi.attempt_count < 5
            and (
              smi.embedding_state='pending'
              or (smi.embedding_state='failed' and smi.next_attempt_at<=now())
              or (smi.embedding_state='processing' and smi.updated_at <= now() - interval '5 minutes')
              or (smi.embedding_state='embedded' and $2::text is not null and (
                smi.embedding_model<>$2 or smi.embedding_dimensions<>$3
                or smi.embedding_version<>$4
              ))
            )
            and smi.source_revision=r.source_revision
            and smi.representation_policy_revision=g.fidelity_policy_revision
            and smi.content_policy_version=g.content_policy_version
            and smi.classifier_version=g.classifier_version
            and r.source_owner_policy_id=g.source_owner_policy_id
            and r.source_owner_policy_version=g.source_owner_policy_version
            and r.team_policy_id=g.team_policy_id and r.team_policy_version=g.team_policy_version
            and r.workspace_policy_id=g.workspace_policy_id and r.workspace_policy_version=g.workspace_policy_version
            and ${cumulativeRepresentationAuthorizationSql("r.representation", { consent: "consent" })}
            and not exists (
              select 1 from team_memory_representation_records newer
               where newer.share_grant_id=r.share_grant_id
                 and newer.representation=r.representation
                 and newer.state in ('available','stale')
                 and newer.source_revision>r.source_revision
            )
          order by coalesce(smi.next_attempt_at,smi.updated_at),smi.id
          limit $1
          for update of smi skip locked`,
          [
            limit,
            input.model ?? null,
            input.dimensions ?? null,
            input.version ?? null
          ]
        );
        if (claimed.rows.length > 0) {
          await client.query(
            `update team_memory_semantic_items
                set embedding_state='processing',attempt_count=attempt_count+1,
                    embedded_at=null,last_error_class=null,next_attempt_at=null,
                    updated_at=now()
              where id=any($1::uuid[])`,
            [claimed.rows.map((row) => row.id)]
          );
        }
        return claimed;
      });

      const pending: PendingSharedMemorySemanticItem[] = [];
      await options.afterSharedMemorySemanticClaimForTest?.();
      const rowsByChunk = new Map<string, Row[]>();
      for (const row of authorizedRows.rows) {
        const key = `${stringValue(row.team_id)}:${stringValue(row.representation_id)}:${numberValue(row.encrypted_chunk_index)}`;
        const rows = rowsByChunk.get(key) ?? [];
        rows.push(row);
        rowsByChunk.set(key, rows);
      }
      for (const rows of rowsByChunk.values()) {
        try {
          const authorizedPending = await withTransaction(
            pool,
            async (client) => {
              const reauthorized = await client.query<Row>(
                `select smi.*,
                        r.representation,r.source_preview_id,r.source_artifact_id,
                        r.source_revision as representation_source_revision,
                        semantic.owner_user_id as semantic_owner_user_id,
                        semantic.owner_principal_id as semantic_owner_principal_id,
                        semantic.effective_privacy_policy_hash as semantic_effective_privacy_policy_hash,
                        semantic.classifier_hash as semantic_classifier_hash,
                        g.remote_replica_id as grant_remote_replica_id,
                        sp.preview_hash as semantic_source_preview_hash,
                        sp.source_hash as semantic_source_hash,
                        sa.artifact_hash as semantic_source_artifact_hash,
                        sa.manifest_hash as semantic_source_manifest_hash,
                        chunk.envelope_version,chunk.provider_mode,chunk.algorithm,
                        chunk.key_id,chunk.key_version,chunk.ciphertext,
                        chunk.ciphertext_hash,chunk.nonce,chunk.tag,chunk.wrapped_dek,
                        chunk.aad,chunk.envelope_created_at,chunk.envelope_reencrypted_at
                   from team_memory_semantic_items smi
                   join team_memory_representation_records r on r.id=smi.representation_id
                     and r.share_grant_id=smi.share_grant_id
                     and r.team_id=smi.team_id and r.team_workspace_id=smi.team_workspace_id
                     and r.logical_memory_id=smi.logical_memory_id
                     and r.state in ('available','stale') and r.invalidated_at is null
                     and (r.curated_expires_at is null or r.curated_expires_at>now())
                   join team_memory_share_grant_records g on g.id=smi.share_grant_id
                     and g.team_workspace_id=smi.team_workspace_id
                     and g.team_id=smi.team_id and g.logical_memory_id=smi.logical_memory_id
                     and g.lifecycle='active' and g.revoked_at is null
                     and g.consent_id=r.consent_id
                   join teams t on t.id=g.team_id and t.lifecycle='active'
                     and t.entitlement_status in ('active','grace')
                   join team_workspaces tw on tw.id=g.team_workspace_id and tw.team_id=g.team_id
                     and tw.lifecycle='active' and tw.archived_at is null
                   join source_owner_representation_consent_records consent on consent.id=g.consent_id
                     and consent.state='active' and consent.revoked_at is null
                     and (consent.expires_at is null or consent.expires_at>now())
                   join source_owner_representation_policies op on op.policy_id=g.source_owner_policy_id
                     and op.version=g.source_owner_policy_version and op.superseded_at is null
                   join team_representation_policies tp on tp.policy_id=g.team_policy_id
                     and tp.version=g.team_policy_version and tp.team_id=g.team_id
                     and tp.superseded_at is null
                   join workspace_representation_policies wp on wp.policy_id=g.workspace_policy_id
                     and wp.version=g.workspace_policy_version and wp.team_id=g.team_id
                     and wp.team_workspace_id=g.team_workspace_id and wp.superseded_at is null
                   left join memory_replicas mr on mr.id=g.remote_replica_id
                     and mr.replica_role='target' and mr.encryption_scope='owner_private_replica'
                     and mr.lifecycle='active' and mr.disabled_at is null
                   left join cross_identity_sync_relationships sr on sr.local_replica_id=mr.id
                     and sr.logical_memory_id=g.logical_memory_id and sr.side='target'
                     and sr.revoked_at is null
                     and sr.state in ('processing','partially_available','ready','stale')
                   join shared_source_preview_records sp on sp.id=r.source_preview_id
                     and sp.invalidated_at is null
                   join shared_source_artifact_records sa on sa.id=r.source_artifact_id
                     and sa.invalidated_at is null
                   join shared_source_semantic_previews semantic
                     on semantic.id=r.sanitized_source_preview_id
                    and semantic.source_preview_id=sp.id
                    and semantic.source_preview_revision=sp.preview_revision
                    and semantic.source_preview_hash=sp.preview_hash
                    and semantic.source_artifact_id=sa.id
                    and semantic.source_artifact_hash=sa.artifact_hash
                    and semantic.source_manifest_hash=sa.manifest_hash
                    and semantic.source_revision=r.source_revision
                    and semantic.source_hash=sp.source_hash
                    and semantic.owner_user_id=g.owner_user_id
                    and semantic.owner_principal_id=g.owner_principal_id
                    and semantic.team_id=g.team_id
                    and semantic.team_workspace_id=g.team_workspace_id
                    and semantic.representation=r.representation
                    and semantic.classifier_generation_id=r.privacy_classifier_generation_id
                    and semantic.classifier_hash=r.privacy_classifier_hash
                    and semantic.effective_privacy_policy_hash=r.effective_privacy_policy_hash
                    and semantic.sanitized_content_hash=r.sanitized_content_hash
                    and semantic.status='ready' and semantic.invalidated_at is null
                   join privacy_classifier_generations privacy_classifier
                     on privacy_classifier.id=semantic.classifier_generation_id
                    and privacy_classifier.version=semantic.classifier_version
                    and privacy_classifier.classifier_hash=semantic.classifier_hash
                    and privacy_classifier.status='active'
                    and privacy_classifier.revoked_at is null
                   join team_memory_representation_chunks chunk
                     on chunk.representation_id=r.id and chunk.share_grant_id=g.id
                     and chunk.chunk_index=smi.encrypted_chunk_index
                     and chunk.purged_at is null
                  where smi.id=any($1::uuid[]) and smi.embedding_state='processing'
                    and (
                      (g.source_kind='captured_session' and mr.id is not null and sr.id is not null)
                      or (g.source_kind='personal_note' and g.remote_replica_id is null)
                    )
                    and smi.source_revision=r.source_revision
                    and smi.representation_policy_revision=g.fidelity_policy_revision
                    and smi.content_policy_version=g.content_policy_version
                    and smi.classifier_version=g.classifier_version
                    and r.source_owner_policy_id=g.source_owner_policy_id
                    and r.source_owner_policy_version=g.source_owner_policy_version
                    and r.team_policy_id=g.team_policy_id and r.team_policy_version=g.team_policy_version
                    and r.workspace_policy_id=g.workspace_policy_id
                    and r.workspace_policy_version=g.workspace_policy_version
                    and ${cumulativeRepresentationAuthorizationSql("r.representation", { consent: "consent" })}
                  order by smi.id
                  for share of smi,r,g,t,tw,consent,op,tp,wp,sp,sa,semantic,
                    privacy_classifier,chunk`,
                [rows.map((claimedRow) => claimedRow.id)]
              );
              if (reauthorized.rows.length !== rows.length) {
                throw new SharedMemoryAuthorizationError(
                  "Semantic materialization authority changed after claim"
                );
              }
              const row = reauthorized.rows[0]!;
              const currentPrivacyPolicy = await resolveCurrentPrivacyPolicy(
                client,
                {
                  ownerUserId: stringValue(row.semantic_owner_user_id),
                  teamId: stringValue(row.team_id),
                  teamWorkspaceId: stringValue(row.team_workspace_id)
                }
              );
              if (
                currentPrivacyPolicy.effectivePolicyHash !==
                stringValue(row.semantic_effective_privacy_policy_hash)
              ) {
                throw new SharedMemoryConflictError(
                  "Semantic materialization privacy policy is stale"
                );
              }
              const semanticDerivative =
                requireReadySharedMemorySemanticDerivative(
                  await decryptReadySemanticPreview(
                    client,
                    { userId: stringValue(row.semantic_owner_user_id) },
                    {
                      sourcePreviewId: stringValue(row.source_preview_id),
                      sourcePreviewHash: stringValue(
                        row.semantic_source_preview_hash
                      ),
                      sourceArtifactId: stringValue(row.source_artifact_id),
                      sourceArtifactHash: stringValue(
                        row.semantic_source_artifact_hash
                      ),
                      sourceManifestHash: stringValue(
                        row.semantic_source_manifest_hash
                      ),
                      sourceRevision: numberValue(row.source_revision),
                      sourceHash: stringValue(row.semantic_source_hash),
                      ownerPrincipalId: stringValue(
                        row.semantic_owner_principal_id
                      ),
                      logicalMemoryId: stringValue(row.logical_memory_id),
                      teamId: stringValue(row.team_id),
                      teamWorkspaceId: stringValue(row.team_workspace_id),
                      representation: stringValue(
                        row.representation
                      ) as SharedMemoryRepresentation
                    }
                  )
                );
              if (
                ciphertextHash(stringValue(row.ciphertext)) !==
                stringValue(row.ciphertext_hash)
              ) {
                throw new SharedMemoryConflictError(
                  "Semantic source chunk integrity check failed"
                );
              }
              const provider = await options.resolveTeamEncryptionProvider({
                teamId: stringValue(row.team_id),
                purpose: "decrypt",
                keyId: stringValue(row.key_id),
                keyVersion: numberValue(row.key_version)
              });
              const envelope: EncryptedPayloadEnvelope = {
                version: numberValue(
                  row.envelope_version
                ) as EncryptedPayloadEnvelope["version"],
                providerMode: stringValue(
                  row.provider_mode
                ) as EncryptedPayloadEnvelope["providerMode"],
                keyId: stringValue(row.key_id),
                keyVersion: numberValue(row.key_version),
                scope: envelopeScope({
                  teamId: stringValue(row.team_id),
                  teamWorkspaceId: stringValue(row.team_workspace_id)
                }),
                provenance: envelopeProvenance(
                  stringValue(row.representation_id)
                ),
                algorithm: stringValue(
                  row.algorithm
                ) as EncryptedPayloadEnvelope["algorithm"],
                ciphertext: stringValue(row.ciphertext),
                nonce: stringValue(row.nonce),
                tag: stringValue(row.tag),
                wrappedDek:
                  row.wrapped_dek as EncryptedPayloadEnvelope["wrappedDek"],
                ciphertextLocation: "team_memory_representation_chunks",
                aad: row.aad as EncryptedPayloadEnvelope["aad"],
                createdAt: iso(row.envelope_created_at),
                reencryptedAt: nullableIso(row.envelope_reencrypted_at)
              };
              const parsed = JSON.parse(
                Buffer.from(await provider.decrypt(envelope)).toString("utf8")
              ) as unknown;
              if (!Array.isArray(parsed)) {
                throw new SharedMemoryConflictError(
                  "Semantic source chunk plaintext is not an item array"
                );
              }
              await options.afterSharedMemorySemanticDecryptForTest?.();
              const items: PendingSharedMemorySemanticItem[] = [];
              for (const itemRow of reauthorized.rows) {
                const item = parsed[
                  numberValue(itemRow.encrypted_chunk_item_index)
                ] as SharedMemoryCanonicalSourceItemDto | undefined;
                if (
                  !item ||
                  sharedMemoryEmbeddingInputHash(item) !==
                    stringValue(itemRow.content_hash) ||
                  sharedMemoryGrantScopedSourceId(
                    stringValue(itemRow.share_grant_id),
                    item.sourceId
                  ) !== stringValue(itemRow.pseudonymous_source_id)
                ) {
                  throw new SharedMemoryConflictError(
                    "Semantic item does not match its encrypted representation position"
                  );
                }
                const contentHash = stringValue(itemRow.content_hash);
                const sourceBinding =
                  semanticDerivative.payload.embeddingSourceBindings[
                    numberValue(itemRow.source_item_index)
                  ];
                if (
                  !sourceBinding ||
                  sourceBinding.sourceItemIndex !==
                    numberValue(itemRow.source_item_index) ||
                  sourceBinding.sanitizedInputHash !== contentHash
                ) {
                  throw new SharedMemoryConflictError(
                    "Semantic embedding source binding is incomplete"
                  );
                }
                let personalEmbeddingReuse: PendingSharedMemorySemanticItem["personalEmbeddingReuse"] =
                  null;
                if (
                  input.model &&
                  input.dimensions &&
                  input.version &&
                  sourceBinding.inputUnchanged &&
                  sourceBinding.originalInputHash === contentHash &&
                  sourceBinding.personalSourceType !== null &&
                  sourceBinding.personalSourceId !== null
                ) {
                  const personal = await client.query<Row>(
                    `select id,source_text,embedding_model,
                            embedding_dimensions,embedding_version,
                            tokenizer,input_transform,pooling,normalization
                       from memory_embeddings
                      where owner_user_id=$1 and visibility='personal'
                        and embedding_model=$2 and embedding_dimensions=$3
                        and invalidated_at is null
                        and personal_deleted_at is null
                        and source_chunk_index=0 and source_chunk_count=1
                        and (
                          (memory_event_id=$4 and $5::text='memory_event')
                          or (memory_node_id=$4 and $5::text='memory_node')
                          or (curated_memory_assertion_id=$4 and $5::text='curated_memory')
                        )
                      order by created_at desc,id desc
                      limit 1
                      for share`,
                    [
                      stringValue(row.semantic_owner_user_id),
                      input.model,
                      input.dimensions,
                      sourceBinding.personalSourceId,
                      sourceBinding.personalSourceType
                    ]
                  );
                  const personalRow = personal.rows[0];
                  if (personalRow) {
                    const ownerUserId = stringValue(row.semantic_owner_user_id);
                    const personalProvider =
                      await options.resolvePersonalEncryptionProvider({
                        ownerUserId,
                        purpose: "decrypt"
                      });
                    const decryptedSourceText =
                      await decryptAuthorizedEncryptedFieldPayloadWithClient(
                        client,
                        { userId: ownerUserId },
                        personalProvider,
                        {
                          sourceTable: "memory_embeddings",
                          sourceId: stringValue(personalRow.id),
                          sourceColumn: "source_text"
                        }
                      );
                    const personalSourceText =
                      typeof decryptedSourceText?.plaintext === "string"
                        ? decryptedSourceText.plaintext
                        : typeof personalRow.source_text === "string"
                          ? personalRow.source_text
                          : null;
                    if (
                      personalSourceText !== null &&
                      typeof personalRow.tokenizer === "string" &&
                      typeof personalRow.input_transform === "string" &&
                      typeof personalRow.pooling === "string" &&
                      typeof personalRow.normalization === "string" &&
                      teamSemanticEmbeddingGeneration({
                        model: stringValue(personalRow.embedding_model),
                        tokenizer: stringValue(personalRow.tokenizer),
                        inputTransform: stringValue(
                          personalRow.input_transform
                        ),
                        pooling: stringValue(personalRow.pooling),
                        normalization: stringValue(personalRow.normalization)
                      }) === input.version &&
                      createHash("sha256")
                        .update(personalSourceText, "utf8")
                        .digest("hex") === contentHash
                    ) {
                      personalEmbeddingReuse = {
                        memoryEmbeddingId: stringValue(personalRow.id),
                        model: stringValue(personalRow.embedding_model),
                        dimensions: numberValue(
                          personalRow.embedding_dimensions
                        ) as 384 | 1024 | 1536 | 3072,
                        version: input.version
                      };
                    }
                  }
                }
                items.push({
                  semanticItemId: stringValue(itemRow.id),
                  representationId: stringValue(itemRow.representation_id),
                  shareGrantId: stringValue(itemRow.share_grant_id),
                  sourceItemIndex: numberValue(itemRow.source_item_index),
                  text: composeSharedMemorySemanticText(item),
                  contentHash,
                  embeddingJobKey: crossIdentitySyncDigest({
                    semanticItemId: stringValue(itemRow.id),
                    contentHash,
                    model: input.model ?? null,
                    dimensions: input.dimensions ?? null,
                    version: input.version ?? null
                  }),
                  computationReuseKey: crossIdentitySyncDigest({
                    contract: "team-safe-embedding-computation/v1",
                    ownerUserId: stringValue(row.semantic_owner_user_id),
                    teamId: stringValue(row.team_id),
                    logicalMemoryId: stringValue(row.logical_memory_id),
                    sourceRevision: numberValue(row.source_revision),
                    classifierHash: stringValue(row.semantic_classifier_hash),
                    effectivePrivacyPolicyHash: stringValue(
                      row.semantic_effective_privacy_policy_hash
                    ),
                    contentHash,
                    model: input.model ?? null,
                    dimensions: input.dimensions ?? null,
                    version: input.version ?? null
                  }),
                  personalEmbeddingReuse
                });
              }
              await input.duringAuthorizedLease?.(items);
              return items;
            }
          );
          pending.push(...authorizedPending);
        } catch (error) {
          await pool.query(
            `update team_memory_semantic_items
                set embedding_state='failed',embedded_at=null,
                    last_error_class=$2,
                    next_attempt_at=now()+make_interval(
                      secs=>least(300,(power(2,least(attempt_count,5))::integer*5))
                    ),updated_at=now()
              where id=any($1::uuid[]) and embedding_state='processing'`,
            [
              rows.map((failedRow) => failedRow.id),
              (error instanceof Error
                ? error.name
                : "UnknownDecryptError"
              ).slice(0, 160)
            ]
          );
        }
      }
      return pending.sort(
        (left, right) =>
          left.representationId.localeCompare(right.representationId) ||
          left.sourceItemIndex - right.sourceItemIndex ||
          left.semanticItemId.localeCompare(right.semanticItemId)
      );
    },

    async storeSharedMemorySemanticEmbedding(input) {
      assertUuid(input.semanticItemId, "semanticItemId");
      assertHash(input.contentHash, "contentHash");
      if (
        input.vector.length !== input.dimensions ||
        input.vector.some((value) => !Number.isFinite(value))
      ) {
        throw new TypeError("vector does not match embedding dimensions");
      }
      return withTransaction(pool, async (client) => {
        const current = await client.query<Row>(
          `select id from team_memory_semantic_items
            where id=$1 and content_hash=$2 and embedding_state='processing'
            for update`,
          [input.semanticItemId, input.contentHash]
        );
        if (!current.rows[0]) return false;
        for (const dimensions of [384, 1024, 1536, 3072] as const) {
          await client.query(
            `delete from ${semanticVectorTable(dimensions)} where semantic_item_id=$1`,
            [input.semanticItemId]
          );
        }
        await client.query(
          `insert into ${semanticVectorTable(input.dimensions)} (semantic_item_id,embedding)
           values ($1,$2::${semanticVectorCast(input.dimensions)})`,
          [input.semanticItemId, JSON.stringify(input.vector)]
        );
        await client.query(
          `update team_memory_semantic_items
              set embedding_state='embedded',embedding_model=$3,
                  embedding_dimensions=$4,embedding_version=$5,
                  embedding_input_hash=$2,embedded_at=now(),updated_at=now(),
                  last_error_class=null,attempt_count=0,next_attempt_at=null
            where id=$1`,
          [
            input.semanticItemId,
            input.contentHash,
            input.model,
            input.dimensions,
            input.version
          ]
        );
        return true;
      });
    },

    async reusePersonalSharedMemorySemanticEmbedding(input) {
      assertUuid(input.semanticItemId, "semanticItemId");
      assertUuid(input.memoryEmbeddingId, "memoryEmbeddingId");
      assertHash(input.contentHash, "contentHash");
      return withTransaction(pool, async (client) => {
        const current = await client.query<Row>(
          `select smi.id,semantic.owner_user_id,semantic.team_id,
                  semantic.team_workspace_id,
                  semantic.effective_privacy_policy_hash
             from team_memory_semantic_items smi
             join team_memory_representation_records r
               on r.id=smi.representation_id
              and r.state in ('available','stale')
              and r.invalidated_at is null
             join team_memory_share_grant_records g on g.id=r.share_grant_id
              and g.lifecycle='active' and g.revoked_at is null
              and g.consent_id=r.consent_id
             join source_owner_representation_consent_records consent
               on consent.id=g.consent_id and consent.state='active'
              and consent.revoked_at is null
              and (consent.expires_at is null or consent.expires_at>now())
             join users owner on owner.id=g.owner_user_id
              and owner.disabled_at is null and owner.deleted_at is null
             join teams team on team.id=g.team_id and team.lifecycle='active'
              and team.entitlement_status in ('active','grace')
             join team_memberships membership
               on membership.team_id=g.team_id
              and membership.user_id=g.owner_user_id
              and membership.status='enabled'
              and membership.disabled_at is null
             join team_workspaces workspace
               on workspace.id=g.team_workspace_id
              and workspace.team_id=g.team_id
              and workspace.lifecycle='active'
              and workspace.archived_at is null
             join team_workspace_access_grants access
               on access.team_workspace_id=g.team_workspace_id
              and access.team_id=g.team_id
              and access.user_id=g.owner_user_id
              and access.access='write'
              and access.can_share_owned_memory=true
              and access.disabled_at is null
             join source_owner_representation_policies op
               on op.policy_id=g.source_owner_policy_id
              and op.version=g.source_owner_policy_version
              and op.superseded_at is null
             join team_representation_policies tp
               on tp.policy_id=g.team_policy_id
              and tp.version=g.team_policy_version
              and tp.team_id=g.team_id and tp.superseded_at is null
             join workspace_representation_policies wp
               on wp.policy_id=g.workspace_policy_id
              and wp.version=g.workspace_policy_version
              and wp.team_id=g.team_id
              and wp.team_workspace_id=g.team_workspace_id
              and wp.superseded_at is null
             join shared_source_semantic_previews semantic
               on semantic.id=r.sanitized_source_preview_id
              and semantic.status='ready' and semantic.invalidated_at is null
              and semantic.owner_user_id=g.owner_user_id
              and semantic.team_id=g.team_id
              and semantic.team_workspace_id=g.team_workspace_id
              and semantic.classifier_generation_id=r.privacy_classifier_generation_id
              and semantic.classifier_hash=r.privacy_classifier_hash
              and semantic.effective_privacy_policy_hash=r.effective_privacy_policy_hash
              and semantic.sanitized_content_hash=r.sanitized_content_hash
             join privacy_classifier_generations generation
               on generation.id=semantic.classifier_generation_id
              and generation.version=semantic.classifier_version
              and generation.classifier_hash=semantic.classifier_hash
              and generation.status='active' and generation.revoked_at is null
            where smi.id=$1 and smi.content_hash=$2
              and smi.embedding_state='processing'
              and ${cumulativeRepresentationAuthorizationSql("r.representation", { consent: "consent" })}
            for update of smi`,
          [input.semanticItemId, input.contentHash]
        );
        const currentRow = current.rows[0];
        if (!currentRow) return false;
        const currentPrivacyPolicy = await resolveCurrentPrivacyPolicy(client, {
          ownerUserId: stringValue(currentRow.owner_user_id),
          teamId: stringValue(currentRow.team_id),
          teamWorkspaceId: stringValue(currentRow.team_workspace_id)
        });
        if (
          currentPrivacyPolicy.effectivePolicyHash !==
          stringValue(currentRow.effective_privacy_policy_hash)
        ) {
          return false;
        }
        const personal = await client.query<Row>(
          `select id,source_text,embedding_model,embedding_dimensions,
                  tokenizer,input_transform,pooling,normalization
             from memory_embeddings
            where id=$1 and visibility='personal'
              and owner_user_id=$4
              and embedding_model=$2 and embedding_dimensions=$3
              and invalidated_at is null
              and personal_deleted_at is null
            limit 1
            for share`,
          [
            input.memoryEmbeddingId,
            input.model,
            input.dimensions,
            currentRow.owner_user_id
          ]
        );
        const personalRow = personal.rows[0];
        if (!personalRow) return false;
        if (
          typeof personalRow.tokenizer !== "string" ||
          typeof personalRow.input_transform !== "string" ||
          typeof personalRow.pooling !== "string" ||
          typeof personalRow.normalization !== "string" ||
          teamSemanticEmbeddingGeneration({
            model: stringValue(personalRow.embedding_model),
            tokenizer: stringValue(personalRow.tokenizer),
            inputTransform: stringValue(personalRow.input_transform),
            pooling: stringValue(personalRow.pooling),
            normalization: stringValue(personalRow.normalization)
          }) !== input.version
        ) {
          return false;
        }
        const ownerActor = { userId: stringValue(currentRow.owner_user_id) };
        const personalProvider =
          await options.resolvePersonalEncryptionProvider({
            ownerUserId: ownerActor.userId,
            purpose: "decrypt"
          });
        const decryptedSourceText =
          await decryptAuthorizedEncryptedFieldPayloadWithClient(
            client,
            ownerActor,
            personalProvider,
            {
              sourceTable: "memory_embeddings",
              sourceId: input.memoryEmbeddingId,
              sourceColumn: "source_text"
            }
          );
        const sourceText =
          typeof decryptedSourceText?.plaintext === "string"
            ? decryptedSourceText.plaintext
            : typeof personalRow.source_text === "string"
              ? personalRow.source_text
              : null;
        if (
          sourceText === null ||
          createHash("sha256").update(sourceText, "utf8").digest("hex") !==
            input.contentHash
        ) {
          return false;
        }
        for (const dimensions of [384, 1024, 1536, 3072] as const) {
          await client.query(
            `delete from ${semanticVectorTable(dimensions)} where semantic_item_id=$1`,
            [input.semanticItemId]
          );
        }
        const copied = await client.query(
          `insert into ${semanticVectorTable(input.dimensions)} (
             semantic_item_id,embedding
           )
           select $1,embedding
             from memory_embeddings_${input.dimensions}
            where memory_embedding_id=$2
           on conflict (semantic_item_id) do nothing`,
          [input.semanticItemId, input.memoryEmbeddingId]
        );
        if ((copied.rowCount ?? 0) !== 1) return false;
        const stored = await client.query(
          `update team_memory_semantic_items
              set embedding_state='embedded',embedding_model=$3,
                  embedding_dimensions=$4,embedding_version=$5,
                  embedding_input_hash=$2,embedded_at=now(),updated_at=now(),
                  last_error_class=null,attempt_count=0,next_attempt_at=null
            where id=$1 and content_hash=$2 and embedding_state='processing'`,
          [
            input.semanticItemId,
            input.contentHash,
            input.model,
            input.dimensions,
            input.version
          ]
        );
        if ((stored.rowCount ?? 0) !== 1) {
          throw new SharedMemoryConflictError(
            "Semantic embedding reuse lost its processing lease"
          );
        }
        return true;
      });
    },

    async markSharedMemorySemanticEmbeddingFailed(input) {
      assertUuid(input.semanticItemId, "semanticItemId");
      await pool.query(
        `update team_memory_semantic_items
            set embedding_state='failed',embedded_at=null,last_error_class=$2,
                next_attempt_at=now()+make_interval(
                  secs=>least(300,(power(2,least(attempt_count,5))::integer*5))
                ),updated_at=now()
          where id=$1 and embedding_state='processing'`,
        [input.semanticItemId, input.errorClass.slice(0, 160)]
      );
    },

    async getNextSharedMemorySemanticEmbeddingRetryAt() {
      const next = await pool.query<{ next_attempt_at: Date | null }>(
        `select min(next_attempt_at) as next_attempt_at
           from team_memory_semantic_items
          where embedding_state='failed' and attempt_count<5
            and next_attempt_at is not null`
      );
      return next.rows[0]?.next_attempt_at?.toISOString() ?? null;
    },

    async authorizeSharedMemorySemanticRecall(actor, input) {
      assertUuid(input.teamWorkspaceId, "teamWorkspaceId");
      const allowed = await pool.query(
        `select 1
           from team_workspaces tw
           join teams t on t.id=tw.team_id and t.lifecycle='active'
             and t.entitlement_status in ('active','grace')
           join users u on u.id=$1 and u.disabled_at is null and u.deleted_at is null
           join team_memberships tm on tm.team_id=t.id and tm.user_id=u.id
             and tm.status='enabled' and tm.disabled_at is null
           join team_workspace_access_grants wa on wa.team_workspace_id=tw.id
             and wa.team_id=t.id and wa.user_id=u.id and wa.disabled_at is null
             and wa.access in ('read','write')
          where tw.id=$2 and tw.lifecycle='active' and tw.archived_at is null
          limit 1`,
        [actor.userId, input.teamWorkspaceId]
      );
      if (!allowed.rows[0]) throw new SharedMemoryAuthorizationError();
    },

    async freezeSharedMemorySemanticRecallBoundary(actor, input) {
      assertUuid(input.teamWorkspaceId, "teamWorkspaceId");
      if (
        !Number.isInteger(input.maximumGrantCount) ||
        input.maximumGrantCount < 1 ||
        input.maximumGrantCount > 1024
      ) {
        throw new RangeError("maximumGrantCount must be between 1 and 1024");
      }
      const frozen = await pool.query<Row>(
        `select t.id as team_id,t.version as team_version,
                tw.version as workspace_version,tm.version as membership_version,
                wa.version as workspace_access_version,u.xmin::text as user_row_version,
                coalesce((
                  select array_agg(g.id order by g.id)
                    from (
                      select distinct grant_row.id
                        from team_memory_share_grant_records grant_row
                        join team_memory_representation_records r
                          on r.share_grant_id=grant_row.id
                         and r.consent_id=grant_row.consent_id
                         and r.state in ('available','stale') and r.invalidated_at is null
                         and (r.curated_expires_at is null or r.curated_expires_at>now())
                        join source_owner_representation_consent_records c
                          on c.id=grant_row.consent_id and c.state='active'
                         and c.revoked_at is null
                         and (c.expires_at is null or c.expires_at>now())
                        join source_owner_representation_policies op
                          on op.policy_id=grant_row.source_owner_policy_id
                         and op.version=grant_row.source_owner_policy_version
                         and op.superseded_at is null
                        join team_representation_policies tp
                          on tp.policy_id=grant_row.team_policy_id
                         and tp.version=grant_row.team_policy_version
                         and tp.team_id=grant_row.team_id and tp.superseded_at is null
                        join workspace_representation_policies wp
                          on wp.policy_id=grant_row.workspace_policy_id
                         and wp.version=grant_row.workspace_policy_version
                         and wp.team_id=grant_row.team_id
                         and wp.team_workspace_id=grant_row.team_workspace_id
                         and wp.superseded_at is null
                        left join memory_replicas mr on mr.id=grant_row.remote_replica_id
                         and mr.lifecycle='active' and mr.replica_role='target'
                         and mr.encryption_scope='owner_private_replica'
                         and mr.disabled_at is null
                        left join cross_identity_sync_relationships sr
                          on sr.local_replica_id=mr.id
                         and sr.logical_memory_id=grant_row.logical_memory_id
                         and sr.side='target' and sr.revoked_at is null
                         and sr.state in ('processing','partially_available','ready','stale')
                        join shared_source_preview_records sp
                          on sp.id=r.source_preview_id and sp.invalidated_at is null
                        join shared_source_artifact_records sa
                          on sa.id=r.source_artifact_id and sa.invalidated_at is null
                       where grant_row.team_workspace_id=tw.id
                         and grant_row.lifecycle='active' and grant_row.revoked_at is null
                         and (
                           (grant_row.source_kind='captured_session' and mr.id is not null and sr.id is not null)
                           or (grant_row.source_kind='personal_note' and grant_row.remote_replica_id is null)
                         )
                         and ${cumulativeRepresentationAuthorizationSql("r.representation", { grant: "grant_row" })}
                       order by grant_row.id
                       limit $3
                    ) g
                ),array[]::uuid[]) as share_grant_ids
           from team_workspaces tw
           join teams t on t.id=tw.team_id and t.lifecycle='active'
             and t.entitlement_status in ('active','grace')
           join users u on u.id=$1 and u.disabled_at is null and u.deleted_at is null
           join team_memberships tm on tm.team_id=t.id and tm.user_id=u.id
             and tm.status='enabled' and tm.disabled_at is null
           join team_workspace_access_grants wa on wa.team_workspace_id=tw.id
             and wa.team_id=t.id and wa.user_id=u.id and wa.disabled_at is null
             and wa.access in ('read','write')
          where tw.id=$2 and tw.lifecycle='active' and tw.archived_at is null
          limit 1`,
        [actor.userId, input.teamWorkspaceId, input.maximumGrantCount + 1]
      );
      const row = frozen.rows[0];
      if (!row) throw new SharedMemoryAuthorizationError();
      const shareGrantIds = Array.isArray(row.share_grant_ids)
        ? row.share_grant_ids.map(stringValue)
        : [];
      if (shareGrantIds.length > input.maximumGrantCount) {
        throw new SharedMemoryAuthorizationError(
          "Shared Memory authorization boundary exceeds the bounded run capacity"
        );
      }
      return {
        teamId: stringValue(row.team_id),
        teamVersion: numberValue(row.team_version),
        teamWorkspaceId: input.teamWorkspaceId,
        workspaceVersion: numberValue(row.workspace_version),
        membershipVersion: numberValue(row.membership_version),
        workspaceAccessVersion: numberValue(row.workspace_access_version),
        userRowVersion: stringValue(row.user_row_version),
        shareGrantIds
      };
    },

    async scanAuthorizedSharedMemorySemanticItems(actor, input) {
      assertUuid(input.teamWorkspaceId, "teamWorkspaceId");
      if (input.queryVector.length !== input.dimensions) {
        throw new TypeError("queryVector does not match embedding dimensions");
      }
      input.parentCandidateIds?.forEach((id) =>
        assertUuid(id, "parentCandidateId")
      );
      const perRepresentationLimit = Math.min(Math.max(input.limit, 1), 50);
      const rows = await pool.query<Row>(
        `select r.representation,
                least(count(*)::integer,$11::integer) as candidate_count,
                max(1-(v.embedding <=> $6::${semanticVectorCast(input.dimensions)})) as top_score
           from team_memory_semantic_items smi
           join ${semanticVectorTable(input.dimensions)} v on v.semantic_item_id=smi.id
           join team_memory_representation_records r on r.id=smi.representation_id
             and r.state in ('available','stale') and r.invalidated_at is null
             and (r.curated_expires_at is null or r.curated_expires_at>now())
           join team_memory_share_grant_records g on g.id=smi.share_grant_id
             and g.team_workspace_id=$2 and g.lifecycle='active' and g.revoked_at is null
             and g.consent_id=r.consent_id
           join teams t on t.id=g.team_id and t.lifecycle='active'
             and t.entitlement_status in ('active','grace')
           join team_memberships tm on tm.team_id=g.team_id and tm.user_id=$1
             and tm.status='enabled' and tm.disabled_at is null
           join users u on u.id=tm.user_id and u.disabled_at is null and u.deleted_at is null
           join team_workspaces tw on tw.id=g.team_workspace_id and tw.team_id=g.team_id
             and tw.lifecycle='active' and tw.archived_at is null
           join team_workspace_access_grants wa on wa.team_workspace_id=tw.id
             and wa.team_id=g.team_id and wa.user_id=$1 and wa.disabled_at is null
             and wa.access in ('read','write')
           join source_owner_representation_consent_records c on c.id=g.consent_id
             and c.state='active' and c.revoked_at is null
             and (c.expires_at is null or c.expires_at>now())
           join source_owner_representation_policies op on op.policy_id=g.source_owner_policy_id
             and op.version=g.source_owner_policy_version and op.superseded_at is null
           join team_representation_policies tp on tp.policy_id=g.team_policy_id
             and tp.version=g.team_policy_version and tp.team_id=g.team_id and tp.superseded_at is null
           join workspace_representation_policies wp on wp.policy_id=g.workspace_policy_id
             and wp.version=g.workspace_policy_version and wp.team_id=g.team_id
             and wp.team_workspace_id=g.team_workspace_id and wp.superseded_at is null
           left join memory_replicas mr on mr.id=g.remote_replica_id and mr.lifecycle='active'
             and mr.replica_role='target' and mr.encryption_scope='owner_private_replica'
             and mr.disabled_at is null
           left join cross_identity_sync_relationships sr on sr.local_replica_id=mr.id
             and sr.logical_memory_id=g.logical_memory_id and sr.side='target'
             and sr.revoked_at is null
             and sr.state in ('processing','partially_available','ready','stale')
           join shared_source_preview_records sp on sp.id=r.source_preview_id and sp.invalidated_at is null
           join shared_source_artifact_records sa on sa.id=r.source_artifact_id and sa.invalidated_at is null
           join logical_memories lm on lm.id=smi.logical_memory_id
           left join local_captured_session_logical_memories local_memory
             on local_memory.logical_memory_id=lm.id
            and local_memory.owner_user_id=g.owner_user_id
           left join sessions source_session on source_session.id=local_memory.local_session_id
             and source_session.owner_user_id=g.owner_user_id
          where smi.embedding_state='embedded'
            and (
              (g.source_kind='captured_session' and mr.id is not null and sr.id is not null
                and local_memory.local_session_id is not null and source_session.id is not null)
              or (g.source_kind='personal_note' and g.remote_replica_id is null
                and local_memory.local_session_id is null)
            )
            and smi.embedding_model=$3 and smi.embedding_dimensions=$4 and smi.embedding_version=$5
            and smi.team_workspace_id=$2 and smi.source_revision=r.source_revision
            and smi.representation_policy_revision=g.fidelity_policy_revision
            and smi.content_policy_version=g.content_policy_version
            and smi.classifier_version=g.classifier_version
            and r.source_owner_policy_id=g.source_owner_policy_id
            and r.source_owner_policy_version=g.source_owner_policy_version
            and r.team_policy_id=g.team_policy_id and r.team_policy_version=g.team_policy_version
            and r.workspace_policy_id=g.workspace_policy_id and r.workspace_policy_version=g.workspace_policy_version
            and ${cumulativeRepresentationAuthorizationSql("r.representation")}
            and (
              $12::text='global'
              or ($12::text='session' and local_memory.local_session_id=$13::uuid)
              or ($12::text='project' and coalesce(
                source_session.project_override_id,
                source_session.automatic_project_id
              )=$14)
            )
            and ($15::integer is null or smi.occurred_at >=
              now() - make_interval(days => $15))
            and ($7::timestamptz is null or smi.occurred_at >= $7)
            and ($8::timestamptz is null or smi.occurred_at < $8)
            and ($9::shared_memory_representation[] is null
              or r.representation=any($9))
            and ($10::uuid[] is null or exists (
              select 1 from team_memory_semantic_items parent
               where parent.id=any($10)
                 and parent.team_workspace_id=smi.team_workspace_id
                 and parent.logical_memory_id=smi.logical_memory_id
                 and parent.share_grant_id=smi.share_grant_id
                 and parent.embedding_state='embedded'
            ))
            and ($16::uuid[] is null or g.id=any($16))
            and ($17::uuid is null or (
              t.id=$17 and t.version=$18 and tw.version=$19
              and tm.version=$20 and wa.version=$21 and u.xmin::text=$22
            ))
            and not exists (
              select 1 from team_memory_representation_records newer
               where newer.share_grant_id=r.share_grant_id
                 and newer.representation=r.representation
                 and newer.state in ('available','stale')
                 and newer.source_revision>r.source_revision
            )
          group by r.representation
          order by r.representation`,
        [
          actor.userId,
          input.teamWorkspaceId,
          input.model,
          input.dimensions,
          input.version,
          JSON.stringify(input.queryVector),
          input.sourceAfter ?? null,
          input.sourceBefore ?? null,
          input.representations === undefined ? null : input.representations,
          input.parentCandidateIds?.length ? input.parentCandidateIds : null,
          perRepresentationLimit,
          input.searchDomain,
          input.sessionId ?? null,
          input.projectId ?? null,
          input.recentDays ?? null,
          input.authorizationBoundary?.shareGrantIds ?? null,
          input.authorizationBoundary?.teamId ?? null,
          input.authorizationBoundary?.teamVersion ?? null,
          input.authorizationBoundary?.workspaceVersion ?? null,
          input.authorizationBoundary?.membershipVersion ?? null,
          input.authorizationBoundary?.workspaceAccessVersion ?? null,
          input.authorizationBoundary?.userRowVersion ?? null
        ]
      );
      return rows.rows.map((row) => ({
        representation: stringValue(
          row.representation
        ) as SharedMemoryRepresentation,
        candidateCount: numberValue(row.candidate_count),
        topScore: Number(row.top_score)
      }));
    },

    async searchAuthorizedSharedMemorySemanticItems(actor, input) {
      assertUuid(input.teamWorkspaceId, "teamWorkspaceId");
      if (input.queryVector.length !== input.dimensions) {
        throw new TypeError("queryVector does not match embedding dimensions");
      }
      input.parentCandidateIds?.forEach((id) =>
        assertUuid(id, "parentCandidateId")
      );
      const candidateLimit =
        Math.min(Math.max(input.limit, 1), 50) * (input.strictLimit ? 1 : 4);
      const rows = await pool.query<Row>(
        `select smi.id,smi.share_grant_id,smi.representation_id,
                smi.pseudonymous_source_id,smi.source_item_index,
                smi.source_revision,smi.item_type,smi.occurred_at,
                smi.representation_policy_revision,smi.content_policy_version,
                smi.classifier_version,smi.embedding_model,
                smi.embedding_dimensions,smi.embedding_version,
                r.representation,r.provenance_hash,
                1-(v.embedding <=> $6::${semanticVectorCast(input.dimensions)}) as score
           from team_memory_semantic_items smi
           join ${semanticVectorTable(input.dimensions)} v on v.semantic_item_id=smi.id
           join team_memory_representation_records r on r.id=smi.representation_id
             and r.state in ('available','stale') and r.invalidated_at is null
             and (r.curated_expires_at is null or r.curated_expires_at>now())
           join team_memory_share_grant_records g on g.id=smi.share_grant_id
             and g.team_workspace_id=$2 and g.lifecycle='active' and g.revoked_at is null
             and g.consent_id=r.consent_id
           join teams t on t.id=g.team_id and t.lifecycle='active'
             and t.entitlement_status in ('active','grace')
           join team_memberships tm on tm.team_id=g.team_id and tm.user_id=$1
             and tm.status='enabled' and tm.disabled_at is null
           join users u on u.id=tm.user_id and u.disabled_at is null and u.deleted_at is null
           join team_workspaces tw on tw.id=g.team_workspace_id and tw.team_id=g.team_id
             and tw.lifecycle='active' and tw.archived_at is null
           join team_workspace_access_grants wa on wa.team_workspace_id=tw.id
             and wa.team_id=g.team_id and wa.user_id=$1 and wa.disabled_at is null
             and wa.access in ('read','write')
           join source_owner_representation_consent_records c on c.id=g.consent_id
             and c.state='active' and c.revoked_at is null
             and (c.expires_at is null or c.expires_at>now())
           join source_owner_representation_policies op on op.policy_id=g.source_owner_policy_id
             and op.version=g.source_owner_policy_version and op.superseded_at is null
           join team_representation_policies tp on tp.policy_id=g.team_policy_id
             and tp.version=g.team_policy_version and tp.team_id=g.team_id and tp.superseded_at is null
           join workspace_representation_policies wp on wp.policy_id=g.workspace_policy_id
             and wp.version=g.workspace_policy_version and wp.team_id=g.team_id
             and wp.team_workspace_id=g.team_workspace_id and wp.superseded_at is null
           left join memory_replicas mr on mr.id=g.remote_replica_id and mr.lifecycle='active'
             and mr.replica_role='target' and mr.encryption_scope='owner_private_replica'
             and mr.disabled_at is null
           left join cross_identity_sync_relationships sr on sr.local_replica_id=mr.id
             and sr.logical_memory_id=g.logical_memory_id and sr.side='target'
             and sr.revoked_at is null
             and sr.state in ('processing','partially_available','ready','stale')
           join shared_source_preview_records sp on sp.id=r.source_preview_id and sp.invalidated_at is null
           join shared_source_artifact_records sa on sa.id=r.source_artifact_id and sa.invalidated_at is null
           join logical_memories lm on lm.id=smi.logical_memory_id
           left join local_captured_session_logical_memories local_memory
             on local_memory.logical_memory_id=lm.id
            and local_memory.owner_user_id=g.owner_user_id
           left join sessions source_session on source_session.id=local_memory.local_session_id
             and source_session.owner_user_id=g.owner_user_id
          where smi.embedding_state='embedded'
            and (
              (g.source_kind='captured_session' and mr.id is not null and sr.id is not null
                and local_memory.local_session_id is not null and source_session.id is not null)
              or (g.source_kind='personal_note' and g.remote_replica_id is null
                and local_memory.local_session_id is null)
            )
            and smi.embedding_model=$3 and smi.embedding_dimensions=$4 and smi.embedding_version=$5
            and smi.team_workspace_id=$2 and smi.source_revision=r.source_revision
            and smi.representation_policy_revision=g.fidelity_policy_revision
            and smi.content_policy_version=g.content_policy_version
            and smi.classifier_version=g.classifier_version
            and r.source_owner_policy_id=g.source_owner_policy_id
            and r.source_owner_policy_version=g.source_owner_policy_version
            and r.team_policy_id=g.team_policy_id and r.team_policy_version=g.team_policy_version
            and r.workspace_policy_id=g.workspace_policy_id and r.workspace_policy_version=g.workspace_policy_version
            and ${cumulativeRepresentationAuthorizationSql("r.representation")}
            and (
              $12::text='global'
              or ($12::text='session' and local_memory.local_session_id=$13::uuid)
              or ($12::text='project' and coalesce(
                source_session.project_override_id,
                source_session.automatic_project_id
              )=$14)
            )
            and ($15::integer is null or smi.occurred_at >=
              now() - make_interval(days => $15))
            and ($7::timestamptz is null or smi.occurred_at >= $7)
            and ($8::timestamptz is null or smi.occurred_at < $8)
            and ($9::shared_memory_representation[] is null
              or r.representation=any($9))
            and ($10::uuid[] is null or exists (
              select 1 from team_memory_semantic_items parent
               where parent.id=any($10)
                 and parent.team_workspace_id=smi.team_workspace_id
                 and parent.logical_memory_id=smi.logical_memory_id
                 and parent.share_grant_id=smi.share_grant_id
                 and parent.embedding_state='embedded'
            ))
            and ($16::uuid[] is null or g.id=any($16))
            and ($17::uuid is null or (
              t.id=$17 and t.version=$18 and tw.version=$19
              and tm.version=$20 and wa.version=$21 and u.xmin::text=$22
            ))
            and not exists (
              select 1 from team_memory_representation_records newer
               where newer.share_grant_id=r.share_grant_id
                 and newer.representation=r.representation
                 and newer.state in ('available','stale')
                 and newer.source_revision>r.source_revision
            )
          order by v.embedding <=> $6::${semanticVectorCast(input.dimensions)},smi.id
          limit $11`,
        [
          actor.userId,
          input.teamWorkspaceId,
          input.model,
          input.dimensions,
          input.version,
          JSON.stringify(input.queryVector),
          input.sourceAfter ?? null,
          input.sourceBefore ?? null,
          input.representations === undefined ? null : input.representations,
          input.parentCandidateIds?.length ? input.parentCandidateIds : null,
          candidateLimit,
          input.searchDomain,
          input.sessionId ?? null,
          input.projectId ?? null,
          input.recentDays ?? null,
          input.authorizationBoundary?.shareGrantIds ?? null,
          input.authorizationBoundary?.teamId ?? null,
          input.authorizationBoundary?.teamVersion ?? null,
          input.authorizationBoundary?.workspaceVersion ?? null,
          input.authorizationBoundary?.membershipVersion ?? null,
          input.authorizationBoundary?.workspaceAccessVersion ?? null,
          input.authorizationBoundary?.userRowVersion ?? null
        ]
      );
      const hydrated = await hydrateAuthorizedSemanticCandidates(
        actor,
        rows.rows.map((row) => ({
          candidateId: stringValue(row.id),
          shareGrantId: stringValue(row.share_grant_id),
          teamWorkspaceId: input.teamWorkspaceId,
          representationId: stringValue(row.representation_id),
          representation: stringValue(
            row.representation
          ) as SharedMemoryRepresentation,
          pseudonymousSourceId: stringValue(row.pseudonymous_source_id),
          sourceItemIndex: numberValue(row.source_item_index),
          sourceRevision: numberValue(row.source_revision),
          provenanceHash: stringValue(row.provenance_hash),
          representationPolicyRevision: numberValue(
            row.representation_policy_revision
          ),
          contentPolicyVersion: numberValue(row.content_policy_version),
          classifierVersion: numberValue(row.classifier_version),
          embeddingModel: stringValue(row.embedding_model),
          embeddingDimensions: numberValue(row.embedding_dimensions),
          embeddingVersion: stringValue(row.embedding_version),
          itemType: stringValue(row.item_type) as SharedMemorySourceItemType,
          occurredAt: nullableIso(row.occurred_at),
          score: Number(row.score),
          exactHints: input.exactHints
        }))
      );
      return hydrated.slice(0, input.limit);
    },

    async expandAuthorizedSharedMemorySemanticItem(actor, input) {
      assertUuid(input.teamWorkspaceId, "teamWorkspaceId");
      assertUuid(input.candidateId, "candidateId");
      const row = await pool.query<Row>(
        `select smi.*,r.representation,r.provenance_hash
           from team_memory_semantic_items smi
           join team_memory_representation_records r on r.id=smi.representation_id
             and r.share_grant_id=smi.share_grant_id
             and r.team_id=smi.team_id and r.team_workspace_id=smi.team_workspace_id
             and r.logical_memory_id=smi.logical_memory_id
             and r.state in ('available','stale') and r.invalidated_at is null
             and (r.curated_expires_at is null or r.curated_expires_at>now())
           join team_memory_share_grant_records g on g.id=smi.share_grant_id
             and g.lifecycle='active' and g.revoked_at is null
             and g.consent_id=r.consent_id
           join teams t on t.id=g.team_id and t.lifecycle='active'
             and t.entitlement_status in ('active','grace')
           join users u on u.id=$9 and u.disabled_at is null and u.deleted_at is null
           join team_memberships tm on tm.team_id=g.team_id and tm.user_id=u.id
             and tm.status='enabled' and tm.disabled_at is null
           join team_workspaces tw on tw.id=g.team_workspace_id and tw.team_id=g.team_id
             and tw.lifecycle='active' and tw.archived_at is null
           join team_workspace_access_grants wa on wa.team_workspace_id=tw.id
             and wa.team_id=g.team_id and wa.user_id=u.id and wa.disabled_at is null
             and wa.access in ('read','write')
           join source_owner_representation_consent_records consent on consent.id=g.consent_id
             and consent.state='active' and consent.revoked_at is null
             and (consent.expires_at is null or consent.expires_at>now())
           join source_owner_representation_policies op on op.policy_id=g.source_owner_policy_id
             and op.version=g.source_owner_policy_version and op.superseded_at is null
           join team_representation_policies tp on tp.policy_id=g.team_policy_id
             and tp.version=g.team_policy_version and tp.team_id=g.team_id
             and tp.superseded_at is null
           join workspace_representation_policies wp on wp.policy_id=g.workspace_policy_id
             and wp.version=g.workspace_policy_version and wp.team_id=g.team_id
             and wp.team_workspace_id=g.team_workspace_id and wp.superseded_at is null
           left join memory_replicas mr on mr.id=g.remote_replica_id
             and mr.replica_role='target' and mr.encryption_scope='owner_private_replica'
             and mr.lifecycle='active' and mr.disabled_at is null
           left join cross_identity_sync_relationships sr on sr.local_replica_id=mr.id
             and sr.logical_memory_id=g.logical_memory_id and sr.side='target'
             and sr.revoked_at is null
             and sr.state in ('processing','partially_available','ready','stale')
           join shared_source_preview_records sp on sp.id=r.source_preview_id and sp.invalidated_at is null
           join shared_source_artifact_records sa on sa.id=r.source_artifact_id and sa.invalidated_at is null
           join logical_memories lm on lm.id=smi.logical_memory_id
           left join local_captured_session_logical_memories local_memory
             on local_memory.logical_memory_id=lm.id
            and local_memory.owner_user_id=g.owner_user_id
           left join sessions source_session on source_session.id=local_memory.local_session_id
             and source_session.owner_user_id=g.owner_user_id
          where smi.id=$1 and smi.team_workspace_id=$2 and smi.embedding_state='embedded'
            and (
              (g.source_kind='captured_session' and mr.id is not null and sr.id is not null
                and local_memory.local_session_id is not null and source_session.id is not null)
              or (g.source_kind='personal_note' and g.remote_replica_id is null
                and local_memory.local_session_id is null)
            )
            and smi.source_revision=r.source_revision
            and smi.representation_policy_revision=g.fidelity_policy_revision
            and smi.content_policy_version=g.content_policy_version
            and smi.classifier_version=g.classifier_version
            and r.source_owner_policy_id=g.source_owner_policy_id
            and r.source_owner_policy_version=g.source_owner_policy_version
            and r.team_policy_id=g.team_policy_id and r.team_policy_version=g.team_policy_version
            and r.workspace_policy_id=g.workspace_policy_id
            and r.workspace_policy_version=g.workspace_policy_version
            and ${cumulativeRepresentationAuthorizationSql("r.representation", {
              consent: "consent"
            })}
            and (
              $3::text='global'
              or ($3::text='session' and local_memory.local_session_id=$4::uuid)
              or ($3::text='project' and coalesce(
                source_session.project_override_id,
                source_session.automatic_project_id
              )=$5)
            )
            and ($6::integer is null or smi.occurred_at >=
              now() - make_interval(days => $6))
            and ($7::timestamptz is null or smi.occurred_at >= $7)
            and ($8::timestamptz is null or smi.occurred_at < $8)
            and ($10::uuid[] is null or g.id=any($10))
            and ($11::uuid is null or (
              t.id=$11 and t.version=$12 and tw.version=$13
              and tm.version=$14 and wa.version=$15 and u.xmin::text=$16
            ))
          limit 1`,
        [
          input.candidateId,
          input.teamWorkspaceId,
          input.searchDomain,
          input.sessionId ?? null,
          input.projectId ?? null,
          input.recentDays ?? null,
          input.sourceAfter ?? null,
          input.sourceBefore ?? null,
          actor.userId,
          input.authorizationBoundary?.shareGrantIds ?? null,
          input.authorizationBoundary?.teamId ?? null,
          input.authorizationBoundary?.teamVersion ?? null,
          input.authorizationBoundary?.workspaceVersion ?? null,
          input.authorizationBoundary?.membershipVersion ?? null,
          input.authorizationBoundary?.workspaceAccessVersion ?? null,
          input.authorizationBoundary?.userRowVersion ?? null
        ]
      );
      const candidate = row.rows[0];
      if (!candidate) return null;
      const parent = (
        await hydrateAuthorizedSemanticCandidates(actor, [
          {
            candidateId: stringValue(candidate.id),
            shareGrantId: stringValue(candidate.share_grant_id),
            teamWorkspaceId: input.teamWorkspaceId,
            representationId: stringValue(candidate.representation_id),
            representation: stringValue(
              candidate.representation
            ) as SharedMemoryRepresentation,
            pseudonymousSourceId: stringValue(candidate.pseudonymous_source_id),
            sourceItemIndex: numberValue(candidate.source_item_index),
            sourceRevision: numberValue(candidate.source_revision),
            provenanceHash: stringValue(candidate.provenance_hash),
            representationPolicyRevision: numberValue(
              candidate.representation_policy_revision
            ),
            contentPolicyVersion: numberValue(candidate.content_policy_version),
            classifierVersion: numberValue(candidate.classifier_version),
            embeddingModel: stringValue(candidate.embedding_model),
            embeddingDimensions: numberValue(candidate.embedding_dimensions),
            embeddingVersion: stringValue(candidate.embedding_version),
            itemType: stringValue(
              candidate.item_type
            ) as SharedMemorySourceItemType,
            occurredAt: nullableIso(candidate.occurred_at),
            score: 1
          }
        ])
      )[0];
      if (!parent) return null;
      const authorized = await repository.readGrantRepresentation(actor, {
        shareGrantId: parent.shareGrantId,
        representation: parent.representation,
        page: {
          direction: "newer",
          boundary: parent.sourceItemIndex,
          limit: 1
        },
        includeExpansionMaterial: true
      });
      const materializedParent = authorized?.items[0];
      if (
        !authorized ||
        authorized.grant.teamWorkspaceId !== input.teamWorkspaceId ||
        authorized.representation.id !== parent.representationId ||
        materializedParent?.sourceId !== parent.pseudonymousSourceId
      ) {
        return null;
      }
      const expansionItems = materializedParent.content.expansionItems;
      if (!Array.isArray(expansionItems)) return { parent, items: [] };
      const items = (expansionItems as SharedMemoryCanonicalSourceItemDto[])
        .slice(0, MAX_SOURCE_ITEMS)
        .map((item) => ({
          candidateId: item.sourceId,
          pseudonymousSourceId: item.sourceId,
          sourceChunkIndex: 0,
          itemType: item.itemType,
          occurredAt: item.occurredAt,
          text: composeSharedMemorySemanticText(item),
          lexicalAnchors: semanticItemAnchors(item)
        }));
      return {
        parent,
        items: items.filter((item) => item.candidateId !== parent.candidateId)
      };
    },

    async rewrapTeamRepresentationChunkBatch(provider, input = {}) {
      if (!provider.rewrap) {
        throw new Error(
          `Envelope provider ${provider.mode} does not support Shared Memory representation rewrap`
        );
      }
      const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
      const result = await pool.query<Row>(
        `select * from team_memory_representation_chunks
          where provider_mode=$1
            and key_id=$2
            and purged_at is null
            and ($3::uuid is null or team_id=$3)
            and ($4::boolean or key_version<>$5)
            and ($6::text is null or id::text>$6)
          order by id::text asc
          limit $7`,
        [
          provider.mode,
          provider.keyId,
          input.teamId ?? null,
          input.force ?? false,
          provider.keyVersion,
          input.afterId ?? null,
          batchSize
        ]
      );

      let rewrappedRows = 0;
      if (input.dryRun) {
        return {
          processedRows: result.rows.length,
          rewrappedRows: 0,
          wouldRewrapRows: result.rows.length,
          failedRows: 0,
          done: result.rows.length < batchSize,
          nextCursorId: nullableString(result.rows.at(-1)?.id)
        };
      }
      for (const row of result.rows) {
        try {
          const envelope: EncryptedPayloadEnvelope = {
            version: numberValue(
              row.envelope_version
            ) as EncryptedPayloadEnvelope["version"],
            providerMode: stringValue(
              row.provider_mode
            ) as EncryptedPayloadEnvelope["providerMode"],
            keyId: stringValue(row.key_id),
            keyVersion: numberValue(row.key_version),
            scope: envelopeScope({
              teamId: stringValue(row.team_id),
              teamWorkspaceId: stringValue(row.team_workspace_id)
            }),
            provenance: envelopeProvenance(stringValue(row.representation_id)),
            algorithm: stringValue(
              row.algorithm
            ) as EncryptedPayloadEnvelope["algorithm"],
            ciphertext: stringValue(row.ciphertext),
            nonce: stringValue(row.nonce),
            tag: stringValue(row.tag),
            wrappedDek:
              row.wrapped_dek as EncryptedPayloadEnvelope["wrappedDek"],
            ciphertextLocation: "team_memory_representation_chunks",
            aad: row.aad as EncryptedPayloadEnvelope["aad"],
            createdAt: iso(row.envelope_created_at),
            reencryptedAt: nullableIso(row.envelope_reencrypted_at)
          };
          const rewrapped = await provider.rewrap(envelope);
          const updated = await pool.query(
            `update team_memory_representation_chunks
                set key_version=$2,
                    wrapped_dek=$3::jsonb,
                    envelope_reencrypted_at=$4,
                    verified_at=now()
              where id=$1
                and provider_mode=$5
                and key_id=$6
                and key_version=$7
                and purged_at is null`,
            [
              row.id,
              rewrapped.keyVersion,
              JSON.stringify(rewrapped.wrappedDek),
              rewrapped.reencryptedAt,
              provider.mode,
              provider.keyId,
              row.key_version
            ]
          );
          if ((updated.rowCount ?? 0) > 0) rewrappedRows += 1;
        } catch {
          throw new Error(
            `Shared Memory representation rewrap failed after ${rewrappedRows} successful row(s)`
          );
        }
      }

      return {
        processedRows: result.rows.length,
        rewrappedRows,
        wouldRewrapRows: 0,
        failedRows: 0,
        done: result.rows.length < batchSize,
        nextCursorId: nullableString(result.rows.at(-1)?.id)
      };
    },

    async readGrantRepresentation(actor, input) {
      return withTransaction(pool, async (client) => {
        await client.query(
          "set transaction isolation level repeatable read read only"
        );
        const result = await client.query(
          `select g.*,
                r.id as representation_row_id,r.consent_id as representation_consent_id,
                r.source_preview_id,r.source_artifact_id,
                r.sanitized_source_preview_id,
                r.privacy_classifier_generation_id,
                r.privacy_classifier_hash,r.effective_privacy_policy_hash,
                r.source_manifest_hash,r.sanitized_content_hash,
                r.representation,r.source_revision as representation_source_revision,
                r.source_revision_hash,r.provenance_hash,
                r.source_owner_policy_id as representation_owner_policy_id,
                r.source_owner_policy_version as representation_owner_policy_version,
                r.team_policy_id as representation_team_policy_id,
                r.team_policy_version as representation_team_policy_version,
                r.workspace_policy_id as representation_workspace_policy_id,
                r.workspace_policy_version as representation_workspace_policy_version,
                r.fidelity_policy_revision as fidelity_policy_revision_row,
                r.content_policy_version as representation_content_policy_version,
                r.classifier_version as representation_classifier_version,
                r.record_version,r.state as representation_state,r.chunk_count,
                r.created_at as representation_created_at,r.updated_at as representation_updated_at,
                r.available_at,r.stale_at,r.invalidated_at,r.invalidation_reason_code,
                semantic.expected_manifest_hash,
                semantic.expected_chunk_count,
                semantic.result_manifest_hash,
                semantic.source_item_identity_hash,
                semantic.source_item_count,
                semantic.payload_binding_hash as semantic_payload_binding_hash,
                privacy_classifier.version as privacy_classifier_version,
                c.source_revision as consent_source_revision,
                c.source_hash as consent_source_hash,
                c.fidelity_policy_hash as consent_fidelity_policy_hash,
                c.content_policy_hash as consent_content_policy_hash,
                c.classifier_hash as consent_classifier_hash,
                c.source_content_hash as consent_source_content_hash,
                sp.preview_hash as representation_preview_hash,
                sp.source_artifact_id as preview_source_artifact_id,
                sp.source_hash as preview_source_hash,
                sp.representation as preview_representation,
                sa.artifact_hash as representation_artifact_hash,
                sa.manifest_hash as representation_manifest_hash,
                sa.representation_policy_hash as representation_fidelity_policy_hash,
                mr.freshness_status as replica_freshness_status,
                sr.state as sync_relationship_state,
                sr.target_processing_cursor,
                c.mode as consent_mode
           from team_memory_share_grant_records g
           join teams t on t.id=g.team_id and t.lifecycle='active' and t.entitlement_status in ('active','grace')
           join team_memberships tm on tm.team_id=g.team_id and tm.user_id=$2
             and tm.status='enabled' and tm.disabled_at is null
           join users u on u.id=tm.user_id and u.disabled_at is null and u.deleted_at is null
           join team_workspaces tw on tw.id=g.team_workspace_id and tw.team_id=g.team_id
             and tw.lifecycle='active' and tw.archived_at is null
           join team_workspace_access_grants wa on wa.team_workspace_id=tw.id
             and wa.team_id=g.team_id and wa.user_id=$2 and wa.disabled_at is null
             and wa.access in ('read','write')
           join source_owner_representation_consent_records c on c.id=g.consent_id
             and c.state in ('active','paused') and c.revoked_at is null
             and (c.expires_at is null or c.expires_at>now())
           join source_owner_representation_policies op on op.policy_id=g.source_owner_policy_id
             and op.version=g.source_owner_policy_version and op.superseded_at is null
           join team_representation_policies tp on tp.policy_id=g.team_policy_id
             and tp.version=g.team_policy_version and tp.team_id=g.team_id and tp.superseded_at is null
           join workspace_representation_policies wp on wp.policy_id=g.workspace_policy_id
             and wp.version=g.workspace_policy_version and wp.team_id=g.team_id
             and wp.team_workspace_id=g.team_workspace_id and wp.superseded_at is null
           left join memory_replicas mr on mr.id=g.remote_replica_id and mr.replica_role='target'
             and mr.encryption_scope='owner_private_replica' and mr.lifecycle='active' and mr.disabled_at is null
           left join cross_identity_sync_relationships sr on sr.local_replica_id=mr.id
             and sr.logical_memory_id=g.logical_memory_id and sr.side='target'
             and sr.state <> 'purge_pending'
           join lateral (
             select r0.* from team_memory_representation_records r0
              where r0.share_grant_id=g.id and r0.consent_id=g.consent_id
                and r0.representation=coalesce(
                  $3::shared_memory_representation,
                  g.activation_representation
                )
                and r0.state in ('available','stale')
                and r0.invalidated_at is null
                and (r0.curated_expires_at is null or r0.curated_expires_at>now())
                and r0.source_owner_policy_id=g.source_owner_policy_id
                and r0.source_owner_policy_version=g.source_owner_policy_version
                and r0.team_policy_id=g.team_policy_id
                and r0.team_policy_version=g.team_policy_version
                and r0.workspace_policy_id=g.workspace_policy_id
                and r0.workspace_policy_version=g.workspace_policy_version
                and r0.fidelity_policy_revision=g.fidelity_policy_revision
                and r0.content_policy_version=g.content_policy_version
                and r0.classifier_version=g.classifier_version
              order by r0.source_revision desc,r0.available_at desc limit 1
           ) r on true
           join shared_source_preview_records sp on sp.id=r.source_preview_id and sp.invalidated_at is null
           join shared_source_artifact_records sa on sa.id=r.source_artifact_id
             and sa.invalidated_at is null
           join shared_source_semantic_previews semantic
             on semantic.id=r.sanitized_source_preview_id
            and semantic.source_preview_id=r.source_preview_id
            and semantic.source_artifact_id=r.source_artifact_id
            and semantic.source_preview_revision=sp.preview_revision
            and semantic.source_preview_hash=sp.preview_hash
            and semantic.source_artifact_hash=sa.artifact_hash
            and semantic.source_hash=sp.source_hash
            and semantic.logical_memory_id=r.logical_memory_id
            and semantic.owner_user_id=g.owner_user_id
            and semantic.owner_principal_id=g.owner_principal_id
            and semantic.team_id=r.team_id
            and semantic.team_workspace_id=r.team_workspace_id
            and semantic.representation=r.representation
            and semantic.source_revision=r.source_revision
            and semantic.classifier_generation_id=r.privacy_classifier_generation_id
            and semantic.classifier_hash=r.privacy_classifier_hash
            and semantic.effective_privacy_policy_hash=r.effective_privacy_policy_hash
            and semantic.source_manifest_hash=r.source_manifest_hash
            and semantic.sanitized_content_hash=r.sanitized_content_hash
            and semantic.status='ready' and semantic.invalidated_at is null
           join privacy_classifier_generations privacy_classifier
             on privacy_classifier.id=r.privacy_classifier_generation_id
            and privacy_classifier.classifier_hash=r.privacy_classifier_hash
            and privacy_classifier.status='active'
            and privacy_classifier.revoked_at is null
          where g.id=$1 and g.lifecycle='active' and g.revoked_at is null
            and (
              (g.source_kind='captured_session' and mr.id is not null and sr.id is not null)
              or (g.source_kind='personal_note' and g.remote_replica_id is null)
            )
            and ${cumulativeRepresentationAuthorizationSql("r.representation")}
          limit 1`,
          [input.shareGrantId, actor.userId, input.representation]
        );
        const row = result.rows[0] as Row | undefined;
        if (!row) return null;

        const grant = mapGrant(row);
        const representationRow: Row = {
          id: row.representation_row_id,
          source_revision_id: row.source_revision_id,
          share_grant_id: row.id,
          consent_id: row.representation_consent_id,
          source_preview_id: row.source_preview_id,
          source_artifact_id: row.source_artifact_id,
          sanitized_source_preview_id: row.sanitized_source_preview_id,
          privacy_classifier_generation_id:
            row.privacy_classifier_generation_id,
          privacy_classifier_hash: row.privacy_classifier_hash,
          effective_privacy_policy_hash: row.effective_privacy_policy_hash,
          source_manifest_hash: row.source_manifest_hash,
          sanitized_content_hash: row.sanitized_content_hash,
          team_id: row.team_id,
          team_workspace_id: row.team_workspace_id,
          logical_memory_id: row.logical_memory_id,
          source_kind: row.source_kind,
          session_id: row.session_id,
          source_session_id: row.source_session_id,
          source_note_id: row.source_note_id,
          source_memory_event_id: row.source_memory_event_id,
          representation: row.representation,
          source_revision: row.representation_source_revision,
          source_revision_hash: row.source_revision_hash,
          provenance_hash: row.provenance_hash,
          source_owner_policy_id: row.representation_owner_policy_id,
          source_owner_policy_version: row.representation_owner_policy_version,
          team_policy_id: row.representation_team_policy_id,
          team_policy_version: row.representation_team_policy_version,
          workspace_policy_id: row.representation_workspace_policy_id,
          workspace_policy_version: row.representation_workspace_policy_version,
          fidelity_policy_revision: row.fidelity_policy_revision_row,
          content_policy_version: row.representation_content_policy_version,
          classifier_version: row.representation_classifier_version,
          record_version: row.record_version,
          state: row.representation_state,
          chunk_count: row.chunk_count,
          created_at: row.representation_created_at,
          updated_at: row.representation_updated_at,
          available_at: row.available_at,
          stale_at: row.stale_at,
          invalidated_at: row.invalidated_at,
          invalidation_reason_code: row.invalidation_reason_code
        };
        const representation = mapRepresentation(representationRow);
        const activePrivacyClassifier =
          await loadActivePrivacyClassifier(client);
        const effectivePrivacyPolicy = await resolveCurrentPrivacyPolicy(
          client,
          {
            ownerUserId: grant.ownerUserId!,
            teamId: grant.teamId,
            teamWorkspaceId: grant.teamWorkspaceId
          }
        );
        const expectedSourceRevisionHash =
          sharedMemorySanitizedSemanticSourceRevisionHash({
            sourcePreviewId: representation.sourcePreviewId,
            sourcePreviewHash: stringValue(row.representation_preview_hash),
            sourceArtifactId: representation.sourceArtifactId,
            sourceArtifactHash: stringValue(row.representation_artifact_hash),
            sourceManifestHash: representation.sourceManifestHash,
            sourceRevision: representation.sourceRevision,
            representation: representation.representation,
            sanitizedSourcePreviewId: representation.sanitizedSourcePreviewId,
            sanitizedContentHash: representation.sanitizedContentHash,
            sourceItemIdentityHash: stringValue(row.source_item_identity_hash),
            sourceItemCount: numberValue(row.source_item_count),
            privacyClassifierGenerationId:
              representation.privacyClassifierGenerationId,
            privacyClassifierHash: representation.privacyClassifierHash,
            effectivePrivacyPolicyHash:
              representation.effectivePrivacyPolicyHash
          });
        const teamSourceBinding = sharedMemorySanitizedSemanticSourceBinding({
          sourceRevision: representation.sourceRevision,
          sourceRevisionHash: expectedSourceRevisionHash,
          fidelityPolicyRevision: representation.fidelityPolicyRevision,
          fidelityPolicyHash: stringValue(
            row.representation_fidelity_policy_hash
          ),
          contentPolicyVersion: representation.contentPolicyVersion,
          effectivePrivacyPolicyHash: representation.effectivePrivacyPolicyHash,
          privacyClassifierVersion: numberValue(row.privacy_classifier_version),
          privacyClassifierHash: representation.privacyClassifierHash
        });
        const expectedProvenanceHash =
          sharedMemorySanitizedSemanticProvenanceHash({
            shareGrantId: grant.id,
            consentId: grant.consentId,
            logicalMemoryId: grant.logicalMemoryId,
            representation: representation.representation,
            binding: teamSourceBinding,
            sourcePreviewId: representation.sourcePreviewId,
            sourcePreviewHash: stringValue(row.representation_preview_hash),
            sourceArtifactId: representation.sourceArtifactId,
            sourceArtifactHash: stringValue(row.representation_artifact_hash),
            sourceManifestHash: representation.sourceManifestHash,
            sanitizedSourcePreviewId: representation.sanitizedSourcePreviewId,
            expectedManifestHash: stringValue(row.expected_manifest_hash),
            expectedChunkCount: numberValue(row.expected_chunk_count),
            resultManifestHash: stringValue(row.result_manifest_hash),
            sourceItemIdentityHash: stringValue(row.source_item_identity_hash),
            sourceItemCount: numberValue(row.source_item_count),
            semanticPayloadBindingHash: stringValue(
              row.semantic_payload_binding_hash
            ),
            privacyClassifierGenerationId:
              representation.privacyClassifierGenerationId,
            privacyClassifierHash: representation.privacyClassifierHash,
            effectivePrivacyPolicyHash:
              representation.effectivePrivacyPolicyHash,
            sanitizedContentHash: representation.sanitizedContentHash,
            sourceOwnerPolicyId: grant.sourceOwnerPolicyId,
            sourceOwnerPolicyVersion: grant.sourceOwnerPolicyVersion,
            teamPolicyId: grant.teamPolicyId,
            teamPolicyVersion: grant.teamPolicyVersion,
            workspacePolicyId: grant.workspacePolicyId,
            workspacePolicyVersion: grant.workspacePolicyVersion
          });
        if (
          stringValue(row.preview_source_artifact_id) !==
            representation.sourceArtifactId ||
          stringValue(row.preview_source_hash).length !== 64 ||
          stringValue(row.preview_representation) !==
            representation.representation ||
          stringValue(row.representation_preview_hash).length !== 64 ||
          stringValue(row.representation_artifact_hash).length !== 64 ||
          stringValue(row.representation_manifest_hash) !==
            representation.sourceManifestHash ||
          representation.sourceRevisionHash !== expectedSourceRevisionHash ||
          representation.provenanceHash !== expectedProvenanceHash ||
          representation.privacyClassifierGenerationId !==
            activePrivacyClassifier.id ||
          representation.privacyClassifierHash !==
            activePrivacyClassifier.classifierHash ||
          representation.effectivePrivacyPolicyHash !==
            effectivePrivacyPolicy.effectivePolicyHash
        ) {
          throw new SharedMemoryConflictError(
            "Team representation source preview binding mismatch"
          );
        }
        const chunksResult = await client.query(
          `select id,chunk_index,aad from team_memory_representation_chunks
          where representation_id=$1 and share_grant_id=$2 and team_id=$3
            and team_workspace_id=$4 and logical_memory_id=$5 and purged_at is null
          order by chunk_index`,
          [
            representation.id,
            grant.id,
            grant.teamId,
            grant.teamWorkspaceId,
            grant.logicalMemoryId
          ]
        );
        if (chunksResult.rows.length !== representation.chunkCount)
          throw new SharedMemoryConflictError(
            "Encrypted representation chunks are incomplete"
          );

        const chunkPages = chunksResult.rows.map((rawChunk, index) => {
          const chunk = rawChunk as Row;
          const actualAad = chunk.aad as Record<string, string>;
          const itemOffset = numberValue(actualAad.itemOffset);
          const itemCount = numberValue(actualAad.itemCount);
          const totalItemCount = numberValue(actualAad.totalItemCount);
          if (
            numberValue(chunk.chunk_index) !== index ||
            !Number.isSafeInteger(itemOffset) ||
            itemOffset < 0 ||
            !Number.isSafeInteger(itemCount) ||
            itemCount < 1 ||
            !Number.isSafeInteger(totalItemCount) ||
            totalItemCount < 1 ||
            itemOffset + itemCount > totalItemCount
          ) {
            throw new SharedMemoryConflictError(
              "Encrypted representation chunk integrity check failed"
            );
          }
          return { index, itemOffset, itemCount, totalItemCount };
        });
        let itemCount = 0;
        for (const chunkPage of chunkPages) {
          if (
            chunkPage.itemOffset !== itemCount ||
            (itemCount > 0 &&
              chunkPage.totalItemCount !== chunkPages[0]!.totalItemCount)
          ) {
            throw new SharedMemoryConflictError(
              "Encrypted representation chunk paging metadata is inconsistent"
            );
          }
          itemCount += chunkPage.itemCount;
        }
        if (
          chunkPages.length === 0 ||
          itemCount !== chunkPages[0]!.totalItemCount
        ) {
          throw new SharedMemoryConflictError(
            "Encrypted representation item count is inconsistent"
          );
        }
        const pageBoundary =
          input.page?.boundary ??
          (input.page?.direction === "newer" ? 0 : itemCount);
        if (
          !Number.isSafeInteger(pageBoundary) ||
          pageBoundary < 0 ||
          pageBoundary > itemCount ||
          (input.page &&
            (!Number.isSafeInteger(input.page.limit) ||
              input.page.limit < 1 ||
              input.page.limit > MAX_SOURCE_ITEMS))
        ) {
          throw new SharedMemoryConflictError(
            "Shared Memory source page is outside the current representation"
          );
        }
        const itemOffset =
          input.page?.direction === "newer"
            ? pageBoundary
            : Math.max(0, pageBoundary - (input.page?.limit ?? itemCount));
        const itemEnd =
          input.page?.direction === "newer"
            ? Math.min(
                itemCount,
                pageBoundary + (input.page?.limit ?? itemCount)
              )
            : pageBoundary;
        const selectedChunkPages = chunkPages.filter(
          (chunkPage) =>
            chunkPage.itemOffset < itemEnd &&
            chunkPage.itemOffset + chunkPage.itemCount > itemOffset
        );
        const selectedChunks =
          selectedChunkPages.length === 0
            ? []
            : (
                await client.query(
                  `select * from team_memory_representation_chunks
                    where representation_id=$1 and share_grant_id=$2 and team_id=$3
                      and team_workspace_id=$4 and logical_memory_id=$5
                      and purged_at is null and chunk_index=any($6::integer[])
                    order by chunk_index`,
                  [
                    representation.id,
                    grant.id,
                    grant.teamId,
                    grant.teamWorkspaceId,
                    grant.logicalMemoryId,
                    selectedChunkPages.map(({ index }) => index)
                  ]
                )
              ).rows;
        if (selectedChunks.length !== selectedChunkPages.length) {
          throw new SharedMemoryConflictError(
            "Encrypted representation page chunks are incomplete"
          );
        }

        // Every request-time authorization predicate above completes before key resolution or decryption.
        const selectedItems: SharedMemoryCanonicalSourceItemDto[] = [];
        let expectedSanitizedContentHash: string | null = null;
        for (
          let selectedIndex = 0;
          selectedIndex < selectedChunkPages.length;
          selectedIndex += 1
        ) {
          const chunkPage = selectedChunkPages[selectedIndex]!;
          const chunk = selectedChunks[selectedIndex] as Row;
          const { index } = chunkPage;
          if (
            numberValue(chunk.chunk_index) !== index ||
            ciphertextHash(stringValue(chunk.ciphertext)) !==
              chunk.ciphertext_hash
          ) {
            throw new SharedMemoryConflictError(
              "Encrypted representation chunk integrity check failed"
            );
          }
          const actualAad = chunk.aad as Record<string, string>;
          const sourceContentHash = stringValue(actualAad.sourceContentHash);
          if (sourceContentHash !== representation.sanitizedContentHash) {
            throw new SharedMemoryConflictError(
              "Encrypted representation sanitized content binding mismatch"
            );
          }
          const expectedAad = envelopeAad({
            representationId: representation.id,
            shareGrantId: grant.id,
            teamId: grant.teamId,
            teamWorkspaceId: grant.teamWorkspaceId,
            logicalMemoryId: grant.logicalMemoryId,
            consentId: grant.consentId,
            representation: representation.representation,
            chunkIndex: index,
            chunkCount: representation.chunkCount,
            itemOffset: chunkPage.itemOffset,
            itemCount: chunkPage.itemCount,
            totalItemCount: chunkPage.totalItemCount,
            binding: teamSourceBinding,
            sourceContentHash,
            provenanceHash: representation.provenanceHash
          });
          if (!aadMatches(actualAad, expectedAad))
            throw new SharedMemoryConflictError(
              "Encrypted representation AAD does not match its grant scope"
            );
          expectedSanitizedContentHash ??= sourceContentHash;
          if (expectedSanitizedContentHash !== sourceContentHash)
            throw new SharedMemoryConflictError(
              "Encrypted chunks disagree on content binding"
            );
          const provider = await options.resolveTeamEncryptionProvider({
            teamId: grant.teamId,
            purpose: "decrypt",
            keyId: stringValue(chunk.key_id),
            keyVersion: numberValue(chunk.key_version)
          });
          const envelope: EncryptedPayloadEnvelope = {
            version: numberValue(
              chunk.envelope_version
            ) as EncryptedPayloadEnvelope["version"],
            providerMode: stringValue(
              chunk.provider_mode
            ) as EncryptedPayloadEnvelope["providerMode"],
            keyId: stringValue(chunk.key_id),
            keyVersion: numberValue(chunk.key_version),
            scope: envelopeScope({
              teamId: grant.teamId,
              teamWorkspaceId: grant.teamWorkspaceId
            }),
            provenance: envelopeProvenance(representation.id),
            algorithm: stringValue(
              chunk.algorithm
            ) as EncryptedPayloadEnvelope["algorithm"],
            ciphertext: stringValue(chunk.ciphertext),
            nonce: stringValue(chunk.nonce),
            tag: stringValue(chunk.tag),
            wrappedDek:
              chunk.wrapped_dek as EncryptedPayloadEnvelope["wrappedDek"],
            ciphertextLocation: "team_memory_representation_chunks",
            aad: actualAad,
            createdAt: iso(chunk.envelope_created_at),
            reencryptedAt: nullableIso(chunk.envelope_reencrypted_at)
          };
          const plaintext = Buffer.from(
            await provider.decrypt(envelope)
          ).toString("utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(plaintext) as unknown;
          } catch {
            throw new SharedMemoryConflictError(
              "Encrypted representation plaintext is invalid JSON"
            );
          }
          if (!Array.isArray(parsed))
            throw new SharedMemoryConflictError(
              "Encrypted representation plaintext is not a source item chunk"
            );
          if (parsed.length !== chunkPage.itemCount) {
            throw new SharedMemoryConflictError(
              "Encrypted representation chunk item count is inconsistent"
            );
          }
          for (const item of parsed as SharedMemoryCanonicalSourceItemDto[]) {
            selectedItems.push(
              validateSharedMemoryCanonicalSourceItem({
                representation: representation.representation,
                logicalMemoryId: grant.logicalMemoryId,
                sourceRevision: representation.sourceRevision,
                item
              })
            );
          }
        }
        const selectedItemOffset =
          selectedChunkPages[0]?.itemOffset ?? itemOffset;
        const pageItems = selectedItems.slice(
          itemOffset - selectedItemOffset,
          itemEnd - selectedItemOffset
        );
        if (
          itemOffset === 0 &&
          itemEnd === itemCount &&
          (!expectedSanitizedContentHash ||
            crossIdentitySyncDigest(pageItems) !== expectedSanitizedContentHash)
        )
          throw new SharedMemoryConflictError(
            "Decrypted representation content hash mismatch"
          );
        const grantScopeItem = (
          item: SharedMemoryCanonicalSourceItemDto,
          includeExpansionMaterial = false
        ): SharedMemoryCanonicalSourceItemDto => {
          const content = item.content;
          const contentSourceIds = (content as { sourceIds?: unknown[] })
            .sourceIds;
          const expansionItems = (content as { expansionItems?: unknown[] })
            .expansionItems;
          const pseudonymousSourceId = sharedMemoryGrantScopedSourceId(
            grant.id,
            item.sourceId
          );
          const visibleContent = { ...content };
          delete visibleContent.expansionItems;
          const pseudonymousContent = {
            ...visibleContent,
            ...(Array.isArray(contentSourceIds) &&
            contentSourceIds.every((value) => typeof value === "string")
              ? {
                  sourceIds: (contentSourceIds as string[]).map((sourceId) =>
                    sharedMemoryGrantScopedSourceId(grant.id, sourceId)
                  )
                }
              : {}),
            ...(includeExpansionMaterial && Array.isArray(expansionItems)
              ? {
                  expansionItems: (
                    expansionItems as SharedMemoryCanonicalSourceItemDto[]
                  ).map((child) => grantScopeItem(child, true))
                }
              : {})
          };
          return {
            ...item,
            sourceId: pseudonymousSourceId,
            content: pseudonymousContent
          };
        };
        const grantScopedItems = pageItems.map((item) =>
          grantScopeItem(item, input.includeExpansionMaterial === true)
        );
        return {
          grant,
          representation,
          items: grantScopedItems,
          sourcePage: { itemOffset, itemCount },
          freshness:
            representation.state === "stale" ||
            row.replica_freshness_status === "stale" ||
            row.sync_relationship_state === "stale" ||
            row.sync_relationship_state === "revoked" ||
            (row.consent_mode === "continuous" &&
              representation.sourceRevision <
                numberValue(row.target_processing_cursor))
              ? "stale"
              : "fresh",
          companionScope: grant.companionScope
        };
      });
    }
  };
  return repository;
};
