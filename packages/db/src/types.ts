import type {
  LcmSourceItem,
  MemoryActor,
  MemoryEngineRepository
} from "@koed/core";
import type { KoedWorkClass } from "@koed/shared";
import type { CapturedSessionRepository } from "./captured-session-repository.js";
import type { PersonalDeviceSyncLocalRepository } from "./personal-device-sync-local-repository.js";
import type { PersonalDeviceArtifactRepository } from "./personal-device-artifact-repository.js";
import type { PersonalDeviceSyncLifecycleRepository } from "./personal-device-sync-lifecycle-repository.js";
import type { ConversationItemRepository } from "./conversation-item-repository.js";
import type { ConversationSourceJournalRepository } from "./conversation-source-journal-repository.js";
import type {
  CollaborationRealtimeMaterializationRepository,
  CollaborationRepository
} from "./collaboration-repository.js";
import type { CrossIdentitySyncRepository } from "./cross-identity-sync-repository.js";
import type { EncryptedPayloadRepository } from "./encrypted-payload-repository.js";
import type { HighRiskActionRepository } from "./high-risk-action-repository.js";
import type { LocalEmbeddingStatusRepository } from "./local-embedding-status-repository.js";
import type { ManagedConversationRepository } from "./managed-conversation-repository.js";
import type { DevelopmentWorkspaceSnapshotRepository } from "./development-workspace-snapshot-repository.js";
import type { ManagedConversationForkRepository } from "./managed-conversation-fork-repository.js";
import type { ManagedConversationTransferRepository } from "./managed-conversation-transfer-repository.js";
import type { PersonalDeviceSyncRepository } from "./personal-device-sync-repository.js";
import type { PersonalDeviceSyncRelayRepository } from "./personal-device-sync-relay-repository.js";
import type { MemoryNodeRepository } from "./memory-node-repository.js";
import type { MemoryQuestionRepository } from "./memory-question-repository.js";
import type { SharedMemoryRepository } from "./shared-memory-repository.js";
import type { TeamConversationSourceRepository } from "./team-conversation-source-repository.js";
import type { WorkflowTokenUsageRepository } from "./workflow-token-usage-repository.js";

export type Visibility = "personal";

export type CaptureMethod = "transcript" | "mcp" | "web" | "api";

export type SourceRuntime = "codex" | "codex-cli" | "claude-code" | "pi";

export type SourceAiClient = SourceRuntime;

export type CaptureState = "enabled" | "disabled" | "ask";

export type CapturePolicyTarget = "global" | "project" | "thread";

export type MemoryQuestionStatus = "answered" | "error";

export type MemoryQuestionOrigin = "mcp_memory_answer";

export type MemoryQuestionSearchDomain = "global" | "project" | "session";

export type MemoryQuestionRetrievalScope = "personal";

export type CuratedMemoryProposalOperation =
  | "store"
  | "merge"
  | "supersede"
  | "conflict";

export type CuratedMemoryProposalStatus =
  | "pending"
  | "stored"
  | "merged"
  | "superseded"
  | "conflicted"
  | "skipped";

export type CuratedMemoryAssertionStatus =
  | "current"
  | "superseded"
  | "conflicting"
  | "suppressed";

export type CuratedMemorySensitivity =
  | "normal"
  | "sensitive"
  | "review_required";

export type CuratedMemorySourceType =
  | "conversation_item"
  | "memory_event"
  | "lcm_summary";

export type CuratedMemorySourceRole =
  | "primary_evidence"
  | "supporting_evidence"
  | "superseding_evidence"
  | "conflicting_evidence"
  | "derived_bundle"
  | "derived_summary";

export type LocalMemoryAgentSettingsFlowKey =
  | "mcp_memory_answer"
  | "manual_memory_answer"
  | "lcm_summary"
  | "curated_memory_review"
  | "session_title";

export interface ActorContext {
  userId: string;
}

export interface CreateUserInput {
  email: string;
  displayName?: string;
  passwordHash?: string;
}

export interface UserRecord {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string | null;
}

export interface UserSessionContext {
  sessionId: string;
  createdAt: Date;
  expiresAt: Date;
  user: UserRecord;
}

export type ExternalAuthProvider = "workos_authkit";

export type ExternalAuthLinkStatus = "linked" | "disabled";

export interface ExternalAuthIdentityRecord {
  id: string;
  provider: ExternalAuthProvider;
  providerEnvironment: string;
  providerUserId: string;
  userId: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  status: ExternalAuthLinkStatus;
  profile: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
}

export interface ExternalAuthOrganizationRecord {
  id: string;
  provider: ExternalAuthProvider;
  providerEnvironment: string;
  providerOrganizationId: string;
  teamId: string;
  name: string | null;
  status: ExternalAuthLinkStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
}

export interface ExternalAuthSessionResult {
  user: UserRecord;
  identity: ExternalAuthIdentityRecord;
  organization: ExternalAuthOrganizationRecord | null;
  createdUser: boolean;
}

export type TeamRole = "owner" | "admin" | "member";

export type TeamMembershipStatus = "invited" | "enabled" | "disabled";

export type TeamWorkspaceAccessLevel = "disabled" | "read" | "write";

export type TeamLifecycle =
  | "active"
  | "suspended"
  | "deletion_requested"
  | "purge_pending"
  | "purged";

export type TeamWorkspaceLifecycle =
  | "active"
  | "archived"
  | "purge_pending"
  | "purged";

export type TeamInviteLifecycle =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

export type TeamEntitlementStatus =
  | "active"
  | "grace"
  | "suspended"
  | "revoked";

export type TeamBillingSeatSyncStatus =
  | "synced"
  | "pending_provider_update"
  | "over_limit"
  | "error";

export interface TeamEntitlementGateRecord {
  teamId: string;
  version: number;
  status: TeamEntitlementStatus;
  allowsTeamAccess: boolean;
  deniedOperationFamilies: string[];
  reason: string | null;
  updatedAt: string | null;
}

export interface TeamRecord {
  id: string;
  name: string;
  version: number;
  lifecycle: TeamLifecycle;
  entitlementStatus: TeamEntitlementStatus;
  entitlementReason: string | null;
  entitlementUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  deletionRequestedAt: string | null;
  tombstonedAt: string | null;
  retainUntil: string | null;
  purgeCompletedAt: string | null;
}

export interface TeamBillingSeatStateRecord {
  teamId: string;
  version: number;
  seatLimit: number | null;
  billableSeatCount: number;
  pendingBillingSeatCount: number;
  syncStatus: TeamBillingSeatSyncStatus;
  overLimitAt: string | null;
  lastSyncedAt: string | null;
  lastErrorMessage: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamSupportOverviewRecord {
  generatedAt: string;
  supportAccess: {
    policy: "team_manager_redacted" | "hosted_operator_redacted";
    actorUserId: string;
    actorRole: Exclude<TeamRole, "member"> | "hosted_operator";
    rawContentAccess: "not_permitted";
    breakGlassRequiredForRawContent: true;
  };
  team: TeamRecord;
  entitlement: TeamEntitlementGateRecord;
  billingSeats: TeamBillingSeatStateRecord | null;
  diagnosticSurfaces: {
    auth: "browser_session";
    rawContentAccess: "not_permitted";
    operationsStatusPath: "/ops/status";
    capabilitiesPath: string;
    auditEventsPath: string;
    entitlementPath: string;
    billingSeatsPath: string;
    supportOverviewPath: string;
  };
  counts: {
    memberships: {
      enabled: number;
      invited: number;
      disabled: number;
    };
    workspaces: {
      active: number;
      archived: number;
    };
    workspaceAccess: {
      read: number;
      write: number;
      disabled: number;
    };
    invites: {
      pending: number;
      accepted: number;
      revoked: number;
      expired: number;
    };
    sessionShareGrants: {
      active: number;
      revoked: number;
      retainedAfterPersonalDeletion: number;
    };
    auditEvents: {
      teamEventCount: number;
      lastTeamEventAt: string | null;
    };
    setupAndIntegrations: {
      externalAuthOrganizations: {
        linked: number;
        disabled: number;
        lastSeenAt: string | null;
      };
      externalAuthIdentities: {
        linked: number;
        disabled: number;
        emailVerified: number;
        lastSeenAt: string | null;
      };
      deviceCredentials: {
        active: number;
        revoked: number;
        expired: number;
        lastValidatedAt: string | null;
      };
    };
  };
}

export interface TeamMembershipRecord {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  status: TeamMembershipStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  disabledAt: string | null;
}

export interface TeamRosterMemberRecord {
  userId: string;
  displayName: string | null;
  avatarReference: string | null;
  status: "enabled";
  presenceMode: "auto" | "manual";
  manualPresenceStatus: "available" | "do_not_disturb" | "out_of_office";
  presenceVersion: number;
  lastHumanActivityAt: string | null;
}

export interface TeamManagementMemberRecord extends TeamMembershipRecord {
  email: string;
  displayName: string | null;
  avatarReference: string | null;
  presenceMode: "auto" | "manual";
  manualPresenceStatus: "available" | "do_not_disturb" | "out_of_office";
  presenceVersion: number;
  lastHumanActivityAt: string | null;
  workspaceAccess: {
    teamWorkspaceId: string;
    userId: string;
    access: TeamWorkspaceAccessLevel;
    version: number;
  }[];
}

export interface TeamWorkspaceRecord {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  version: number;
  lifecycle: TeamWorkspaceLifecycle;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  retentionPolicyId: string | null;
  retentionPolicyVersion: number | null;
  retainUntil: string | null;
  purgeCompletedAt: string | null;
}

export interface TeamWorkspaceAccessRecord {
  teamWorkspaceId: string;
  teamId: string;
  userId: string;
  role: TeamRole | null;
  membershipStatus: TeamMembershipStatus | null;
  access: TeamWorkspaceAccessLevel;
  canShareOwnedMemory: boolean;
  version: number | null;
  teamEntitlementStatus: TeamEntitlementStatus;
  teamEntitlementAllowsAccess: boolean;
  canManageTeam: boolean;
  canManageWorkspace: boolean;
  canRecall: boolean;
  canCreateShare: boolean;
}

export interface TeamWorkspaceContextRecord {
  teamId: string;
  teamName: string;
  teamRole: TeamRole;
  teamWorkspaceId: string;
  teamWorkspaceName: string;
  access: Exclude<TeamWorkspaceAccessLevel, "disabled">;
}

export interface TeamInviteRecord {
  id: string;
  teamId: string;
  defaultTeamWorkspaceId: string;
  defaultWorkspaceAccess: Exclude<TeamWorkspaceAccessLevel, "disabled">;
  email: string;
  normalizedEmail: string;
  backendOriginHash: string;
  role: TeamRole;
  version: number;
  lifecycle: TeamInviteLifecycle;
  createdByUserId: string | null;
  acceptedByUserId: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface AcceptedTeamInviteRecord {
  invite: TeamInviteRecord;
  membership: TeamMembershipRecord;
  user: UserRecord;
  createdUser: boolean;
}

export interface TeamInviteReviewRecord {
  invite: TeamInviteRecord;
  team: TeamRecord;
  defaultWorkspace: Pick<TeamWorkspaceRecord, "id" | "name" | "lifecycle">;
}

export interface TeamInviteAcceptanceReviewRecord extends TeamInviteReviewRecord {
  effectiveRole: TeamRole;
}

export interface TeamInviteCreationReviewRecord {
  managerRole: Exclude<TeamRole, "member">;
  team: Pick<TeamRecord, "id" | "name">;
  defaultWorkspace: Pick<TeamWorkspaceRecord, "id" | "name" | "lifecycle">;
}

export interface TeamInviteRevocationReviewRecord {
  managerRole: Exclude<TeamRole, "member">;
  team: Pick<TeamRecord, "id" | "name">;
  invite: Pick<
    TeamInviteRecord,
    "id" | "email" | "role" | "version" | "lifecycle"
  >;
}

export interface TeamMembershipActionReviewRecord {
  managerRole: Exclude<TeamRole, "member">;
  team: Pick<TeamRecord, "id" | "name">;
  member: Pick<
    TeamMembershipRecord,
    "userId" | "role" | "status" | "version" | "disabledAt"
  > & {
    email: string;
    displayName: string | null;
  };
  activeOwnerCount: number;
}

export interface TeamLeaveReviewRecord {
  team: Pick<TeamRecord, "id" | "name">;
  membership: Pick<
    TeamMembershipRecord,
    "userId" | "role" | "status" | "version" | "disabledAt"
  >;
  activeOwnerCount: number;
}

export interface TeamWorkspaceCreationReviewRecord {
  managerRole: Exclude<TeamRole, "member">;
  team: Pick<TeamRecord, "id" | "name">;
}

export interface TeamWorkspaceLifecycleReviewRecord {
  managerRole: Exclude<TeamRole, "member">;
  team: Pick<TeamRecord, "id" | "name">;
  workspace: Pick<TeamWorkspaceRecord, "id" | "name" | "version" | "lifecycle">;
}

export interface TeamWorkspaceAccessUpdateReviewRecord extends TeamWorkspaceLifecycleReviewRecord {
  member: {
    userId: string;
    email: string;
    displayName: string | null;
  };
  currentAccess: TeamWorkspaceAccessLevel;
  currentAccessVersion: number | null;
}

export interface ApiTokenRecord {
  id: string;
  ownerUserId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export type DeviceCredentialVerifierKind = "secret_hash" | "public_key_jwk";

export interface DeviceEnrollmentChallengeRecord {
  id: string;
  upstreamBackendId: string;
  deviceInstanceId: string | null;
  rotationLineageId: string | null;
  rotationOwnerUserId: string | null;
  rotationCredentialId: string | null;
  deviceLabel: string | null;
  requestedOperationFamilies: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  boundByUserId: string | null;
  boundAt: string | null;
  redeemedAt: string | null;
}

export interface DeviceCredentialRecord {
  id: string;
  ownerUserId: string;
  enrollmentChallengeId: string | null;
  credentialKeyId: string;
  upstreamBackendId: string;
  deviceInstanceId: string;
  lineageId: string;
  deviceLabel: string | null;
  credentialVersion: number;
  verifierKind: DeviceCredentialVerifierKind;
  operationFamilies: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  lastValidatedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
}

export interface DeviceCredentialAuthContext {
  user: UserRecord;
  credential: DeviceCredentialRecord;
}

export type AuditActorType = "user" | "local_operator_script";

export interface AuditActorInput {
  actorUserId?: string | null;
  actorType: AuditActorType;
}

export interface AuditEventRecord {
  id: string;
  actorUserId: string | null;
  ownerUserId: string | null;
  visibility: Visibility | null;
  action: string;
  targetTable: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ActivationAnalyticsFunnelRecord {
  generatedAt: string;
  scope: {
    ownerUserId: string | null;
    teamId: string | null;
    teamWorkspaceId: string | null;
  };
  window: {
    since: string | null;
    until: string | null;
  };
  events: Array<{
    event: string;
    count: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    surfaces: Record<string, number>;
    deploymentProfiles: Record<string, number>;
  }>;
}

export interface RecordAuditEventInput {
  actorUserId?: string | null;
  ownerUserId?: string | null;
  visibility?: Visibility | null;
  action: string;
  targetTable?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListAuditEventsInput {
  action?: string;
  limit?: number;
}

export interface GetActivationAnalyticsFunnelInput {
  teamId?: string;
  teamWorkspaceId?: string;
  since?: Date;
  until?: Date;
}

export interface ListTeamAuditEventsInput {
  teamId: string;
  action?: string;
  limit?: number;
}

export interface CreateMemoryNodeInput {
  visibility: Visibility;
  summaryText: string;
  title?: string | null;
  bodyText?: string | null;
  captureMethod?: CaptureMethod;
  sourceRuntime?: SourceRuntime;
  idempotencyKey?: string;
  sourceHash?: string;
  summaryModel?: string;
  summaryPromptVersion?: string;
  lcmAlgorithmVersion?: string;
}

export interface MemoryNodeRecord {
  id: string;
  ownerUserId: string | null;
  visibility: Visibility;
  title: string | null;
  summaryText: string;
  createdAt?: string;
  updatedAt?: string;
  summaryStructuredJson?: Record<string, unknown> | null;
  summaryStructuredSchemaVersion?: string | null;
  pinnedAt?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
  threadId?: string | null;
  threadName?: string | null;
}

export interface CapturePolicyRecord {
  id: string;
  ownerUserId: string;
  targetType: CapturePolicyTarget;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  threadId: string | null;
  threadName: string | null;
  captureState: CaptureState | null;
  visibility: Visibility | null;
  pauseUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EffectiveCapturePolicy {
  captureState: CaptureState;
  visibility: Visibility;
  paused: boolean;
  pauseUntil: string | null;
  source: "default" | CapturePolicyTarget;
  policy: CapturePolicyRecord | null;
}

export type HistoricalImportState =
  | "discovered"
  | "eligible"
  | "queued"
  | "importing"
  | "paused"
  | "skipped"
  | "completed"
  | "failed";

export interface HistoricalImportCounters {
  discoveredRecordCount: number;
  importedRecordCount: number;
  skippedRecordCount: number;
}

export interface HistoricalImportRunRecord extends HistoricalImportCounters {
  id: string;
  ownerUserId: string;
  state: HistoricalImportState;
  sourceCount: number;
  completedSourceCount: number;
  failedSourceCount: number;
  skippedSourceCount: number;
  scannedByteCount: number;
  retryCount: number;
  failureReason: string | null;
  nextRetryAt: string | null;
  discoveredAt: string;
  eligibleAt: string | null;
  queuedAt: string | null;
  importStartedAt: string | null;
  pausedAt: string | null;
  skippedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HistoricalImportSourceIdentity {
  artifactId: string;
}

export interface HistoricalImportSourceRecord extends HistoricalImportCounters {
  id: string;
  runId: string;
  ownerUserId: string;
  state: HistoricalImportState;
  artifactId: string;
  aiClient: string;
  sourceKind: string;
  sourceAdapterVersion: string;
  sourceSessionId: string;
  sourceFingerprint: string;
  sessionId: string;
  registrationFrontierOffset: number;
  redactedSourceLabel: string;
  historicalCursorOffset: number;
  historicalCursorLine: number;
  historicalCursorDigest: string | null;
  historicalCursorCurrentTurnId?: string;
  providerCursorOffset: number;
  providerCursorLine: number;
  sourceSizeBytes: number;
  sourceModifiedAt: string | null;
  sourceEventFrom: string | null;
  sourceEventTo: string | null;
  malformedRecordCount: number;
  rawIngestedRecordCount: number;
  projectedRecordCount: number;
  embeddingEligibleEventCount: number;
  embeddedEventCount: number;
  embeddingEligibleEstimatedTokenCount: number;
  embeddedMeasuredTokenCount: number;
  pendingEmbeddingEstimatedTokenCount: number;
  embeddingQueueAheadEstimatedTokenCount: number;
  embeddingEtaLowerSeconds: number | null;
  embeddingEtaUpperSeconds: number | null;
  embeddingEtaConfidence: "conservative" | "low" | "medium";
  oldestEmbeddedSourceTime: string | null;
  newestEmbeddedSourceTime: string | null;
  lcmEligibleEventCount: number;
  lcmCompletedEventCount: number;
  rawIngested: boolean;
  projected: boolean;
  partiallyEmbedded: boolean;
  fullyEmbedded: boolean;
  semanticReady: boolean;
  lcmComplete: boolean;
  retryCount: number;
  failureReason: string | null;
  nextRetryAt: string | null;
  detectedProject: Record<string, unknown>;
  discoveredAt: string;
  eligibleAt: string | null;
  queuedAt: string | null;
  importStartedAt: string | null;
  pausedAt: string | null;
  skippedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  lastObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HistoricalImportRunDetail extends HistoricalImportRunRecord {
  sources: HistoricalImportSourceRecord[];
}

export type ConversationSourceArtifactLifecycle =
  | "active"
  | "finalizing"
  | "finalized"
  | "failed"
  | "conflicted"
  | "deletion_pending"
  | "deleted";

export type ConversationSourceConsumerKind =
  | "canonical_live"
  | "canonical_historical"
  | "remote_upload"
  | "remote_processing"
  | "projection";

export type ConversationSourceReplicaRole =
  | "origin_local"
  | "hosted_personal"
  | "peer_personal";

export type ConversationSourceOriginKeyStatus = "active" | "lost" | "revoked";
export type ConversationSourceComponentRole = "primary" | "auxiliary";
export type ConversationSourceContentFraming = "jsonl" | "immutable_blob";

export type PersonalSourceReplicationMode = "hosted_personal" | "peer_personal";

export type ConversationSourceReplicationOutboxState =
  | "pending"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "quarantined";

export type ConversationSourceReplicationAuthorizationBasis =
  | "personal_sync_policy"
  | "execution_transfer";

export interface ConversationSourceArtifactRecord {
  id: string;
  ownerUserId: string;
  sessionId: string;
  logicalSourceId: string;
  sourceGenerationId: string;
  sourceComponentId: string;
  sourceComponentRole: ConversationSourceComponentRole;
  parentSourceComponentId: string | null;
  contentFraming: ConversationSourceContentFraming;
  replicaRole: ConversationSourceReplicaRole;
  sourceKind: string;
  sourceRuntime: SourceRuntime;
  externalSessionId: string;
  sourceFingerprint: string;
  artifactFormat: string;
  artifactFormatVersion: number;
  sourceAdapterVersion: string;
  lifecycle: ConversationSourceArtifactLifecycle;
  journalStartOffset: number;
  journalStartLine: number;
  liveStartOffset: number;
  liveStartLine: number;
  providerCursorOffset: number;
  providerCursorLine: number;
  currentSourceLength: number;
  currentJournalSequence: number;
  sourceCreatedAt: string;
  sourceModifiedAt: string | null;
  storageProvider: string;
  storagePrefix: string;
  closureHash: string | null;
  closureManifest: Record<string, unknown> | null;
  closureSignature: string | null;
  sourceSetClosureHash: string | null;
  sourceSetClosureManifest: Record<string, unknown> | null;
  sourceSetClosureSignature: string | null;
  sourceSetFinalizedAt: string | null;
  originDeploymentId: string;
  originDeviceId: string;
  originKeyId: string;
  originPublicKey: string;
  originKeyStatus: ConversationSourceOriginKeyStatus;
  priorGenerationClosure: Record<string, unknown> | null;
  redactedSourceLabel: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
}

export interface ConversationSourceSegmentRecord {
  id: string;
  artifactId: string;
  segmentIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  sourceStartLine: number;
  sourceEndLine: number;
  plaintextDigest: string;
  ciphertextDigest: string | null;
  plaintextSize: number;
  storedSize: number;
  storageKey: string;
  storageProvider: string;
  encryptionEnvelope: Record<string, unknown> | null;
  signedManifest: Record<string, unknown>;
  originSignature: string;
  manifestDigest: string;
  previousContentDigest: string | null;
  contentDigest: string;
  createdAt: string;
  sealedAt: string;
}

export interface PersonalSourceReplicationPolicyRecord {
  ownerUserId: string;
  enabled: boolean;
  targetUpstreamId: string | null;
  mode: PersonalSourceReplicationMode;
  effectiveFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSourceReplicationOutboxRecord {
  id: string;
  ownerUserId: string;
  artifactId: string;
  operationKind: "registration" | "segment" | "closure";
  segmentId: string | null;
  targetUpstreamId: string;
  mode: PersonalSourceReplicationMode;
  authorizationBasis: ConversationSourceReplicationAuthorizationBasis;
  state: ConversationSourceReplicationOutboxState;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  succeededAt: string | null;
  quarantinedAt: string | null;
}

export interface ConversationSourceReplicationOutboxClaimRecord extends ConversationSourceReplicationOutboxRecord {
  artifact: ConversationSourceArtifactRecord;
  segment: ConversationSourceSegmentRecord | null;
}

export interface ConversationSourceDownloadAuthorizationRecord {
  id: string;
  ownerUserId: string;
  deviceCredentialId: string;
  artifactId: string;
  recipientKey: Record<string, unknown>;
  initiatingOperationKind: "handoff" | "fork" | null;
  initiatingOperationId: string | null;
  firstSegmentIndex: number;
  lastSegmentIndex: number;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

export interface ConversationSourceRestoreJobRecord {
  id: string;
  ownerUserId: string;
  upstreamBackendId: string;
  sourceGenerationId: string;
  targetDeploymentId: string;
  recipientKeyId: string;
  recipientKeyVersion: number;
  actionGrantId: string;
  state:
    | "awaiting_approval"
    | "ready"
    | "downloading"
    | "materializing"
    | "completed"
    | "failed"
    | "revoked";
  remoteAuthorizationId: string | null;
  registration: Record<string, unknown> | null;
  sourceDescriptor: Record<string, unknown> | null;
  sourceClosure: Record<string, unknown> | null;
  nextSegmentIndex: number;
  lastSegmentIndex: number | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ClaimedConversationSourceRestoreJob extends ConversationSourceRestoreJobRecord {
  capability: string;
}

export type ConversationSourceReplicaSegmentAcceptance =
  | {
      status: "accepted" | "replayed";
      artifact: ConversationSourceArtifactRecord;
      segment: ConversationSourceSegmentRecord;
    }
  | {
      status: "gap";
      artifact: ConversationSourceArtifactRecord;
      segment: null;
      expectedSegmentIndex: number;
    }
  | {
      status: "quarantined";
      artifact: ConversationSourceArtifactRecord;
      segment: null;
      reason:
        | "segment_identity_conflict"
        | "segment_chain_conflict"
        | "post_closure_append";
    };

export interface ConversationSourceConsumerCursorRecord {
  artifactId: string;
  consumerKind: ConversationSourceConsumerKind;
  segmentIndex: number;
  sourceOffset: number;
  sourceLine: number;
  lastVerifiedDigest: string | null;
  parserState: Record<string, unknown>;
  failureCode: string | null;
  retryCount: number;
  nextAttemptAt: string | null;
  updatedAt: string;
}

export interface HistoricalImportBatchWriteInput {
  sourceId: string;
  expectedSourceOffset: number;
  sourceOffset: number;
  sourceLine: number;
  segmentIndex: number;
  lastVerifiedDigest: string;
  parserState?: Record<string, unknown>;
  skippedRecordCount?: number;
  malformedRecordCount?: number;
  sourceEventFrom?: string;
  sourceEventTo?: string;
  items: ConversationItemInput[];
}

export interface HistoricalImportBatchWriteResult {
  items: ConversationItemRecord[];
  source: HistoricalImportSourceRecord;
  policy: EffectiveCapturePolicy;
  replayed: boolean;
}

export interface UpsertCapturePolicyInput {
  targetType: CapturePolicyTarget;
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  threadId?: string;
  threadName?: string;
  captureState?: CaptureState | null;
  visibility?: Visibility | null;
  pauseUntil?: Date | string | null;
}

export interface MemoryBrowserItem {
  id: string;
  clusterId: string;
  clusterLabel: string;
  text: string;
  title: string | null;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
  pinnedAt: string | null;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  threadId: string | null;
  threadName: string | null;
}

export interface MemoryClusterRecord {
  id: string;
  label: string;
  count: number;
  latestUpdatedAt: string;
  pinnedCount: number;
  items: MemoryBrowserItem[];
}

export interface LcmGraphOverview {
  capturedEvents: number;
  leafNodes: number;
  rollupNodes: number;
  pendingSummaries: number;
  pendingLcmDiagnostics: {
    pendingCount: number;
    oldestPendingCreatedAt: string | null;
    staleThresholdMinutes: 15;
    stale: boolean;
  };
  invalidatedRecords: number;
  embeddings: {
    enabled: boolean;
    healthy: boolean;
    model: string | null;
    dimensions: number | null;
    total: number;
    memoryNodes: number;
    memoryEvents: number;
    messages: number;
  };
}

export interface LcmGraphNode {
  id: string;
  kind: "leaf" | "rollup";
  depth: number;
  summaryText: string;
  summaryStatus: "pending" | "summarized";
  visibility: Visibility;
  ownerUserId: string | null;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  sessionId: string | null;
  threadId: string | null;
  threadName: string | null;
  createdAt: string;
  updatedAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  sourceEventCount: number;
  sourceTokenEstimate: number | null;
  summaryTokenEstimate: number | null;
  summaryModel: string | null;
  summaryPromptVersion: string | null;
  summaryStructuredJson: Record<string, unknown> | null;
  summaryStructuredSchemaVersion: string | null;
  lcmAlgorithmVersion: string | null;
  embeddingCount: number;
  summaryCorrectedAt?: string | null;
  summaryCorrectedByUserId?: string | null;
}

export interface LcmGraphEvent {
  id: string;
  actor: string | null;
  eventType: string;
  sourceRuntime: SourceRuntime | null;
  captureMethod: CaptureMethod;
  model: string | null;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  sessionId: string | null;
  threadId: string | null;
  threadName: string | null;
  timestamp: string;
  sourceEventTime: string | null;
  sourceSequence: number | null;
  capturedAt: string;
  createdAt: string;
  visibility: Visibility;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  contentPreview: string;
  content?: string;
  rawContent?: string;
  metadata: Record<string, unknown>;
  linkedNodeIds: string[];
}

export interface LcmGraphThread {
  id: string;
  name: string;
  sessionId: string | null;
  sourceAiClient: SourceAiClient | null;
  projectId: string;
  projectName: string;
  projectPath: string | null;
  projectAssignmentSource: "detected" | "user_override" | null;
  capturedProjectProvenance: Record<string, unknown>;
  eventCount: number;
  invalidatedCount: number;
  latestAt: string;
  sample: string;
  threadKind: "conversation" | "subagent";
  parentThreadId: string | null;
  parentSessionId: string | null;
}

export interface LcmGraphProjectThreads {
  id: string;
  name: string;
  path: string | null;
  eventCount: number;
  threads: LcmGraphThread[];
}

export interface LcmGraphNodeDetail extends LcmGraphNode {
  sourceItems: LcmSourceItem[];
  sources: LcmGraphEvent[];
  childNodes: LcmGraphNode[];
  parentNodes: LcmGraphNode[];
}

export interface LcmNodeForSummarization {
  id: string;
  ownerUserId: string | null;
  visibility: Visibility;
  kind: "leaf" | "rollup";
  depth: number;
  summaryText: string;
  sourceItems: LcmSourceItem[];
  sourceTokenEstimate: number | null;
  summaryTokenEstimate: number | null;
  summaryModel: string | null;
  summaryPromptVersion: string | null;
  summaryStructuredJson: Record<string, unknown> | null;
  summaryStructuredSchemaVersion: string | null;
  lcmAlgorithmVersion: string | null;
}

export type EmbeddableSourceType =
  | "memory_node"
  | "memory_event"
  | "message"
  | "curated_memory";

export interface EmbeddableSourceRecord {
  sourceType: EmbeddableSourceType;
  sourceId: string;
  ownerUserId: string | null;
  visibility: Visibility;
  text: string;
  sourceHash: string;
  workClass?: KoedWorkClass;
  reconciliationJobId?: string;
}

export interface LocalEmbeddingStatus {
  enabled: boolean;
  healthy: boolean;
  model: string | null;
  dimensions: number | null;
  error?: string;
}

export interface PersonalProjectReference {
  id: string;
  name: string;
  path: string | null;
}

export interface CapturedSessionRecord {
  id: string;
  logicalSessionId: string;
  ownerUserId: string | null;
  visibility: Visibility;
  externalSessionId: string | null;
  forkedFromExternalThreadId: string | null;
  sourceRuntime: SourceRuntime;
  captureMethod: CaptureMethod;
  model: string | null;
  cwd: string | null;
  sourceKind: string | null;
  sourceAdapterVersion: string | null;
  sourceFingerprint: string | null;
  capturedProject: Record<string, unknown>;
  importObservedAt: string | null;
  metadata: Record<string, unknown>;
  capturedProjectProvenance: Record<string, unknown>;
  automaticProject: PersonalProjectReference | null;
  projectOverride: PersonalProjectReference | null;
  project: PersonalProjectReference | null;
  projectAssignmentSource: "detected" | "user_override" | null;
  projectAssignmentUpdatedAt: string | null;
  createdAt: string;
}

export interface CapturedSessionTitleCandidate {
  id: string;
  externalSessionId: string | null;
  projectName: string | null;
  projectPath: string | null;
  currentTitle: string | null;
  eventCount: number;
  sourceItems: Array<{
    id: string;
    actor: MemoryActor;
    content: string;
    capturedAt: string;
  }>;
}

export const NORMALIZED_IMPORT_SOURCE_ADAPTER = {
  sourceKind: "codex",
  sourceAdapterVersion: "koed-normalized-import-v1",
  sourceTransport: "normalized_import",
  sourceRecordType: "normalized_import_item",
  sourceFormat: "atif",
  sourceSchemaVersion: "ATIF-v1.7",
  sourceProducer: "harbor-codex",
  normalizerAdapter: "harbor-atif",
  normalizerAdapterVersion: "1.0.0",
  projectionPolicyEquivalentAdapterVersion: "codex-transcript-v1",
  projectionDispositionVersion: "codex-transcript-policy-v1"
} as const;

export type NormalizedImportSourceAdapter =
  typeof NORMALIZED_IMPORT_SOURCE_ADAPTER;

export type NormalizedImportTranscriptType =
  | "system_message"
  | "user_message"
  | "agent_message"
  | "reasoning_summary"
  | "tool_call"
  | "tool_result";

export interface NormalizedImportAttestation {
  sessionId: string;
  projectId: string;
  externalThreadId: string;
  taskDigest: string;
  sourceAttemptId: string;
  sanitizationManifestHash: string;
  sequenceStart: number;
}

export interface ConversationItemInput {
  observationOnly?: boolean;
  visibility?: Visibility;
  sessionId?: string;
  turnId?: string;
  sourceKind: string;
  sourceAdapterVersion: string;
  sourceTransport: string;
  externalSessionId?: string;
  externalThreadId?: string;
  externalTurnId?: string;
  externalItemId?: string;
  parentExternalItemId?: string;
  sourceRecordType: string;
  sourceEventType?: string;
  sourceLineNumber?: number;
  sourceSequence?: number;
  eventTime?: string;
  observedAt?: string;
  importObservedAt?: string;
  sourceFingerprint?: string;
  capturedProject?: Record<string, unknown>;
  rawJson: unknown;
  rawText?: string;
  logicalSourceId?: string;
  transportChunkIndex?: number;
  transportChunkCount?: number;
  transportChunkText?: string;
  transportChunkEncoding?: string;
  sourceHash: string;
  idempotencyKey: string;
  canonicalItemKey?: string;
  canonicalStableItemId?: string;
  canonicalSourcePriority?: number;
  observationKind?:
    | "snapshot"
    | "lifecycle_started"
    | "lifecycle_completed"
    | "control"
    | "reconciliation";
  observationComponent?: string;
  projectionStatus?: "pending" | "held" | "projected" | "error" | "raw_only";
  projectionVersion?: string;
  projectionError?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationItemRecord {
  id: string;
  canonicalItemKey: string;
  sessionId: string | null;
  turnId: string | null;
  sourceKind: string;
  sourceAdapterVersion: string;
  sourceTransport: string;
  externalSessionId: string | null;
  externalThreadId: string | null;
  externalTurnId: string | null;
  externalItemId: string | null;
  canonicalStableItemId: string | null;
  sourceRecordType: string;
  sourceEventType: string | null;
  sourceSequence: number | null;
  idempotencyKey: string;
  observedAt: string;
  importObservedAt: string | null;
  sourceFingerprint: string | null;
  capturedProject: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowTokenUsageInput {
  visibility?: Visibility;
  workflowType: string;
  workflowId?: string;
  sessionId?: string;
  turnId?: string;
  conversationItemId?: string;
  questionId?: string;
  answerJobId?: string;
  lcmNodeId?: string;
  messageId?: string;
  toolEventId?: string;
  memoryEventId?: string;
  sourceReferences?: WorkflowTokenUsageSourceReference[];
  sourceRuntime?: SourceRuntime;
  sourceKind?: string;
  sourceAdapterVersion?: string;
  usageSource?: string;
  usageAccuracy?: string;
  usageKind?: string;
  connectorClient?: string;
  tokenizerPackage?: string;
  tokenizerEncoding?: string;
  tokenizerModel?: string;
  tokenizerExactModelMatch?: boolean | null;
  tokenizerHeuristicFallback?: boolean | null;
  tokenizerVersion?: string;
  model?: string;
  modelContextWindow?: number | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningOutputTokens?: number | null;
  totalTokens?: number | null;
  usageScope?: "last" | "total" | string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  sourceHash?: string;
}

export type WorkflowTokenUsageSourceReferenceType =
  | "question"
  | "answer_job"
  | "lcm_node"
  | "message"
  | "tool_event"
  | "memory_event";

export interface WorkflowTokenUsageSourceReference {
  type: WorkflowTokenUsageSourceReferenceType;
  id: string;
}

export interface WorkflowTokenUsageRecord {
  id: string;
  workflowType: string;
  workflowId: string | null;
  sessionId: string | null;
  turnId: string | null;
  conversationItemId: string | null;
  model: string | null;
  usageSource: string;
  usageAccuracy: string;
  usageKind: string;
  connectorClient: string | null;
  tokenizerPackage: string | null;
  tokenizerEncoding: string | null;
  tokenizerModel: string | null;
  tokenizerExactModelMatch: boolean | null;
  tokenizerHeuristicFallback: boolean | null;
  tokenizerVersion: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  usageScope: string;
  createdAt: string;
}

export interface WorkflowTokenUsageRollupInput {
  groupBy?: Array<
    | "workflow"
    | "model"
    | "owner"
    | "project"
    | "thread"
    | "connector"
    | "accuracy"
    | "date"
  >;
  includeEstimates?: boolean;
  from?: string;
  to?: string;
}

export interface WorkflowTokenUsageRollupRecord {
  group: Record<string, string | null>;
  rowCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ConversationProjectionResult {
  rawItemsScanned: number;
  rawItemsProjected: number;
  rawItemsWaitingForAgentSeal: number;
  messagesCreated: number;
  toolEventsCreated: number;
  memoryEventsCreated: number;
  tokenUsageRowsCreated: number;
  memoryEventIds: string[];
  memoryEventScopes: Array<{
    eventId: string;
    visibility: Visibility;
    includeInEmbedding: boolean;
    includeInLcm: boolean;
    workClass: KoedWorkClass;
    sourceEventTime?: string | null;
  }>;
}

export interface ConversationProjectionProcessingRecord {
  eventId: string;
  userId: string;
  visibility: Visibility;
  workClass: KoedWorkClass;
  includeInEmbedding: boolean;
  includeInLcm: boolean;
  sourceEventTime: string | null;
}

export interface HistoricalProjectionLease {
  release(): Promise<void>;
}

export interface ConversationProjectionBacklog {
  liveProjectionRows: number;
  historicalImportRows: number;
  historicalImportBytes: number;
}

export interface LcmDispatchReconciliationScope {
  ownerUserId: string;
  visibility: "personal";
  workClass: KoedWorkClass;
  pendingMemoryEventIds: string[];
  dispatchKey: string;
  jobId: string;
}

interface ConversationProjectionInput {
  limit?: number;
  maxBytes?: number;
  maxRuntimeMs?: number;
  conversationItemIds?: string[];
  visibility?: Visibility;
  workClass?: "live_capture_projection" | "historical_import_backfill";
}

export type SemanticMemoryRebuildInput = {
  limit?: number;
  leaseSeconds?: number;
};

export interface SemanticMemoryRebuildResult {
  jobsClaimed: number;
  jobsCompleted: number;
  jobsFailed: number;
  memoryEventsCreated: number;
  memoryEventIds: string[];
  memoryEventScopes: Array<{
    eventId: string;
    visibility: Visibility;
    includeInEmbedding: boolean;
    includeInLcm: boolean;
    workClass: KoedWorkClass;
    sourceEventTime?: string | null;
  }>;
}

export interface MemoryQuestionShellRecord {
  id: string;
  ownerUserId: string;
  visibility: Visibility;
  origin: MemoryQuestionOrigin;
  retrievalScope: MemoryQuestionRetrievalScope;
  teamWorkspaceId: string | null;
  searchDomain: MemoryQuestionSearchDomain;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  sessionId: string | null;
  threadId: string | null;
  threadName: string | null;
  query: string;
  answerPreview: string | null;
  errorMessage: string | null;
  status: MemoryQuestionStatus;
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
  attemptCount: number;
  evidenceCount: number;
}

export interface MemoryQuestionDetailRecord extends MemoryQuestionShellRecord {
  answerMarkdown: string | null;
  evidence: unknown[] | null;
  citations: unknown[] | null;
  retrieval: Record<string, unknown> | null;
  localMemoryWorker: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
}

export interface LocalMemoryAgentSettingRecord {
  ownerUserId: string;
  flowKey: LocalMemoryAgentSettingsFlowKey;
  provider: string;
  aiClientInstanceId: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiClientInstanceRecord {
  ownerUserId: string;
  instanceId: string;
  driverId: string;
  displayName: string;
  configIdentityHash: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiClientCapabilitySnapshotRecord {
  id: string;
  ownerUserId: string;
  instanceId: string;
  installationIdentityHash: string;
  clientVersion: string | null;
  authenticationState: "authenticated" | "unauthenticated" | "unknown";
  healthState: "healthy" | "unavailable" | "incompatible" | "error";
  models: Array<Record<string, unknown>>;
  capabilities: Record<string, unknown>;
  observedAt: string;
  expiresAt: string;
  createdAt: string;
}

export interface AiClientCapabilitySnapshotDiagnosticRecord extends AiClientCapabilitySnapshotRecord {
  stale: boolean;
}

export interface CuratedMemoryTopicRecord {
  id: string;
  ownerUserId: string;
  visibility: Visibility;
  title: string;
  normalizedTitle: string;
  createdAt: string;
  updatedAt: string;
}

export interface CuratedMemorySourceRecord {
  id: string;
  assertionId: string;
  sourceType: CuratedMemorySourceType;
  sourceRole: CuratedMemorySourceRole;
  conversationItemId: string | null;
  memoryEventId: string | null;
  lcmNodeId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CuratedMemoryAssertionRecord {
  id: string;
  ownerUserId: string;
  visibility: Visibility;
  topicId: string | null;
  topicTitle: string | null;
  assertionText: string;
  normalizedAssertion: string;
  status: CuratedMemoryAssertionStatus;
  sensitivity: CuratedMemorySensitivity;
  confidence: number;
  tags: string[];
  metadata: Record<string, unknown>;
  expiresAt: string | null;
  observedAt: string;
  supersedesAssertionId: string | null;
  supersededByAssertionId: string | null;
  conflictWithAssertionId: string | null;
  createdByModel: string | null;
  createdByPromptVersion: string | null;
  createdAt: string;
  updatedAt: string;
  suppressedAt: string | null;
  suppressionReason: string | null;
  lastReconciledAt: string | null;
  reconciliationStatus: string;
  sources: CuratedMemorySourceRecord[];
}

export interface CuratedMemoryProposalRecord {
  id: string;
  ownerUserId: string;
  visibility: Visibility;
  proposedClaim: string;
  proposedTopic: string | null;
  rationale: string | null;
  tags: string[];
  sensitivityHint: CuratedMemorySensitivity | null;
  expiresAt: string | null;
  evidenceConversationItemIds: string[];
  evidenceMemoryEventIds: string[];
  operation: CuratedMemoryProposalOperation;
  targetAssertionId: string | null;
  status: CuratedMemoryProposalStatus;
  decisionReason: string | null;
  assertionId: string | null;
  workerResult: Record<string, unknown> | null;
  processingStartedAt: string | null;
  processingLeaseUntil: string | null;
  attemptCount: number;
  lastErrorMessage: string | null;
  createdByModel: string | null;
  createdByPromptVersion: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

export interface CuratedMemorySourceInput {
  sourceType: CuratedMemorySourceType;
  sourceRole: CuratedMemorySourceRole;
  conversationItemId?: string | null;
  memoryEventId?: string | null;
  lcmNodeId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CuratedMemoryProposalUserEvidenceResult {
  sources: CuratedMemorySourceInput[];
  evidence: CuratedMemoryReviewEvidence[];
  rejectedSourceCount: number;
}

export interface CuratedMemoryReviewEvidence {
  sourceType: "conversation_item" | "memory_event";
  sourceId: string;
  sourceHash: string;
  text: string;
  occurredAt: string;
  sessionId: string | null;
  metadata: Record<string, unknown>;
}

export interface CuratedMemoryReviewCandidate {
  assertionId: string;
  assertionText: string;
  topicTitle: string | null;
  tags: string[];
  sensitivity: CuratedMemorySensitivity;
  observedAt: string;
  updatedAt: string;
}

export interface CuratedMemoryReviewBundle {
  proposal: CuratedMemoryProposalRecord;
  evidence: CuratedMemoryReviewEvidence[];
  rejectedSourceCount: number;
  currentAssertions: CuratedMemoryReviewCandidate[];
}

export interface CuratedMemoryResolvedEvidence {
  evidenceConversationItemIds: string[];
  evidenceMemoryEventIds: string[];
}

export interface CuratedMemoryCreateAssertionInput {
  proposalId?: string;
  assertionText: string;
  topicTitle?: string | null;
  sensitivity?: CuratedMemorySensitivity;
  confidence?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
  observedAt?: string | null;
  status?: CuratedMemoryAssertionStatus;
  supersedesAssertionId?: string | null;
  conflictWithAssertionId?: string | null;
  createdByModel?: string | null;
  createdByPromptVersion?: string | null;
  sources: CuratedMemorySourceInput[];
}

export interface CuratedMemoryProposalInput {
  proposedClaim: string;
  proposedTopic?: string | null;
  rationale?: string | null;
  tags?: string[];
  sensitivityHint?: CuratedMemorySensitivity | null;
  expiresAt?: string | null;
  evidenceConversationItemIds?: string[];
  evidenceMemoryEventIds?: string[];
  operation?: CuratedMemoryProposalOperation;
  targetAssertionId?: string | null;
  createdByModel?: string | null;
  createdByPromptVersion?: string | null;
}

export interface CuratedMemoryListInput {
  status?: CuratedMemoryAssertionStatus;
  topicId?: string;
  sessionId?: string;
  includeSources?: boolean;
  limit?: number;
}

export interface CuratedMemorySearchInput {
  query: string;
  searchDomain?: MemoryQuestionSearchDomain;
  sessionId?: string;
  projectId?: string;
  limit?: number;
  currentOnly?: boolean;
  sourceAfter?: string;
  sourceBefore?: string;
}

export interface CuratedMemoryReconciliationResult {
  assertionsScanned: number;
  memoryEventLinksAdded: number;
  lcmSummaryLinksAdded: number;
}

export interface CuratedMemoryExportRecords {
  topics: CuratedMemoryTopicRecord[];
  assertions: CuratedMemoryAssertionRecord[];
  proposals: CuratedMemoryProposalRecord[];
}

export interface MemorySourceRepository
  extends
    MemoryEngineRepository,
    CapturedSessionRepository,
    CollaborationRepository,
    CollaborationRealtimeMaterializationRepository,
    ConversationItemRepository,
    ConversationSourceJournalRepository,
    CrossIdentitySyncRepository,
    DevelopmentWorkspaceSnapshotRepository,
    EncryptedPayloadRepository,
    HighRiskActionRepository,
    LocalEmbeddingStatusRepository,
    ManagedConversationRepository,
    ManagedConversationForkRepository,
    ManagedConversationTransferRepository,
    PersonalDeviceArtifactRepository,
    PersonalDeviceSyncRepository,
    PersonalDeviceSyncLocalRepository,
    PersonalDeviceSyncLifecycleRepository,
    PersonalDeviceSyncRelayRepository,
    MemoryNodeRepository,
    MemoryQuestionRepository,
    SharedMemoryRepository,
    TeamConversationSourceRepository,
    WorkflowTokenUsageRepository {
  health(): Promise<boolean>;
  countUsers(): Promise<number>;
  createUser(input: CreateUserInput): Promise<{ id: string }>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  getUser(userId: string): Promise<UserRecord | null>;
  createCuratedMemoryProposal(
    actor: ActorContext,
    input: CuratedMemoryProposalInput
  ): Promise<CuratedMemoryProposalRecord>;
  listCuratedMemoryProposals(
    actor: ActorContext,
    input?: { status?: CuratedMemoryProposalStatus; limit?: number }
  ): Promise<CuratedMemoryProposalRecord[]>;
  getCuratedMemoryProposal(
    actor: ActorContext,
    proposalId: string
  ): Promise<CuratedMemoryProposalRecord | null>;
  getCuratedMemoryProposalUserEvidenceSources(
    actor: ActorContext,
    proposalId: string
  ): Promise<CuratedMemoryProposalUserEvidenceResult>;
  resolveCuratedMemoryProposalEvidence(
    actor: ActorContext,
    input: {
      projectId?: string;
      sessionId?: string;
      exactQuote?: string;
    }
  ): Promise<CuratedMemoryResolvedEvidence>;
  claimPendingCuratedMemoryProposals(
    actor: ActorContext,
    input?: { proposalId?: string; limit?: number; leaseSeconds?: number }
  ): Promise<CuratedMemoryReviewBundle[]>;
  releaseCuratedMemoryProposalReview(
    actor: ActorContext,
    proposalId: string,
    input: { attemptCount: number; lastErrorMessage: string }
  ): Promise<CuratedMemoryProposalRecord | null>;
  processCuratedMemoryProposal(
    actor: ActorContext,
    input: {
      proposalId: string;
      decision: CuratedMemoryProposalOperation | "skip";
      targetAssertionId?: string | null;
      expectedAttemptCount?: number;
      evidenceRevisions?: Array<{
        sourceType: "conversation_item" | "memory_event";
        sourceId: string;
        sourceHash: string;
      }>;
      selectedEvidenceIds?: string[];
      candidateAssertionIds?: string[];
      assertion?: CuratedMemoryCreateAssertionInput;
      decisionReason?: string | null;
      workerResult?: Record<string, unknown>;
    }
  ): Promise<CuratedMemoryProposalRecord>;
  listCuratedMemoryAssertions(
    actor: ActorContext,
    input?: CuratedMemoryListInput
  ): Promise<CuratedMemoryAssertionRecord[]>;
  getCuratedMemoryAssertion(
    actor: ActorContext,
    assertionId: string
  ): Promise<CuratedMemoryAssertionRecord | null>;
  searchCuratedMemoryAssertions(
    actor: ActorContext,
    input: CuratedMemorySearchInput
  ): Promise<CuratedMemoryAssertionRecord[]>;
  suppressCuratedMemoryAssertion(
    actor: ActorContext,
    assertionId: string,
    input: { reason?: string | null; status?: "suppressed" }
  ): Promise<CuratedMemoryAssertionRecord | null>;
  reconcileCuratedMemorySources(
    actor: ActorContext,
    input?: { limit?: number }
  ): Promise<CuratedMemoryReconciliationResult>;
  reconcileCuratedMemoryLifecycle(
    actor: ActorContext
  ): Promise<{ assertionsSuppressed: number }>;
  upsertExternalAuthSession(input: {
    provider: ExternalAuthProvider;
    providerEnvironment?: string;
    providerUserId: string;
    email: string;
    emailVerified?: boolean;
    displayName?: string | null;
    profile?: Record<string, unknown>;
    organization?: {
      providerOrganizationId: string;
      name?: string | null;
      metadata?: Record<string, unknown>;
    } | null;
  }): Promise<ExternalAuthSessionResult>;
  getExternalAuthIdentity(input: {
    provider: ExternalAuthProvider;
    providerEnvironment?: string;
    providerUserId: string;
  }): Promise<ExternalAuthIdentityRecord | null>;
  getVerifiedExternalAuthIdentityForUser(
    userId: string
  ): Promise<ExternalAuthIdentityRecord | null>;
  createTeam(
    actor: ActorContext,
    input: { name: string; idempotencyKey?: string }
  ): Promise<TeamRecord>;
  getTeamDefaultWorkspace(
    actor: ActorContext,
    teamId: string
  ): Promise<TeamWorkspaceRecord | null>;
  listTeams(actor: ActorContext): Promise<TeamRecord[]>;
  getTeamMembership(
    actor: ActorContext,
    teamId: string
  ): Promise<TeamMembershipRecord | null>;
  listTeamRoster(
    actor: ActorContext,
    teamId: string
  ): Promise<TeamRosterMemberRecord[] | null>;
  getTeamRosterMember(
    actor: ActorContext,
    teamId: string,
    userId: string
  ): Promise<TeamRosterMemberRecord | null>;
  setTeamPresence(
    actor: ActorContext,
    input: {
      teamId: string;
      mode: "auto" | "manual";
      manualPresenceStatus: "available" | "do_not_disturb" | "out_of_office";
      expectedVersion: number;
    }
  ): Promise<TeamRosterMemberRecord | null>;
  recordTeamHumanActivity(
    actor: ActorContext,
    teamIds: string[]
  ): Promise<string[]>;
  listTeamManagementMembers(
    actor: ActorContext,
    teamId: string
  ): Promise<TeamManagementMemberRecord[] | null>;
  getTeamEntitlementGate(
    actor: ActorContext,
    teamId: string
  ): Promise<TeamEntitlementGateRecord | null>;
  setTeamEntitlementState(
    actor: ActorContext,
    input: {
      teamId: string;
      expectedVersion: number;
      status: TeamEntitlementStatus;
      reason?: string | null;
    }
  ): Promise<TeamEntitlementGateRecord | null>;
  getTeamBillingSeatState(
    actor: ActorContext,
    teamId: string
  ): Promise<TeamBillingSeatStateRecord | null>;
  setTeamBillingSeatPolicy(
    actor: ActorContext,
    input: {
      teamId: string;
      expectedVersion: number;
      seatLimit: number | null;
    }
  ): Promise<TeamBillingSeatStateRecord | null>;
  getTeamSupportOverview(
    actor: ActorContext,
    teamId: string
  ): Promise<TeamSupportOverviewRecord | null>;
  getHostedSupportOverview(
    actor: ActorContext,
    teamId: string
  ): Promise<TeamSupportOverviewRecord | null>;
  createTeamWorkspace(
    actor: ActorContext,
    input: { teamId: string; name: string; description?: string | null }
  ): Promise<TeamWorkspaceRecord | null>;
  listTeamWorkspaces(
    actor: ActorContext,
    input: { teamId: string; includeArchived?: boolean; limit?: number }
  ): Promise<TeamWorkspaceRecord[] | null>;
  getTeamWorkspaceContext(
    actor: ActorContext,
    teamWorkspaceId: string
  ): Promise<{
    team: TeamRecord;
    teamWorkspace: TeamWorkspaceRecord;
    access: TeamWorkspaceAccessRecord;
  } | null>;
  createTeamInvite(
    actor: ActorContext,
    input: {
      teamId: string;
      defaultTeamWorkspaceId: string;
      defaultWorkspaceAccess: Exclude<TeamWorkspaceAccessLevel, "disabled">;
      email: string;
      role: TeamRole;
      backendOriginHash: string;
      tokenHash: string;
      expiresAt: Date;
    }
  ): Promise<TeamInviteRecord | null>;
  getTeamInviteCreationReview(
    actor: ActorContext,
    input: {
      teamId: string;
      defaultTeamWorkspaceId: string;
      role: TeamRole;
    }
  ): Promise<TeamInviteCreationReviewRecord | null>;
  getTeamInviteAcceptanceReview(
    actor: ActorContext,
    tokenHash: string
  ): Promise<TeamInviteAcceptanceReviewRecord | null>;
  getTeamInviteRevocationReview(
    actor: ActorContext,
    input: { teamId: string; inviteId: string }
  ): Promise<TeamInviteRevocationReviewRecord | null>;
  getTeamMembershipActionReview(
    actor: ActorContext,
    input: { teamId: string; userId: string }
  ): Promise<TeamMembershipActionReviewRecord | null>;
  getTeamLeaveReview(
    actor: ActorContext,
    teamId: string
  ): Promise<TeamLeaveReviewRecord | null>;
  getTeamWorkspaceCreationReview(
    actor: ActorContext,
    teamId: string
  ): Promise<TeamWorkspaceCreationReviewRecord | null>;
  getTeamWorkspaceLifecycleReview(
    actor: ActorContext,
    input: {
      teamWorkspaceId: string;
      lifecycle: TeamWorkspaceLifecycle;
    }
  ): Promise<TeamWorkspaceLifecycleReviewRecord | null>;
  getTeamWorkspaceAccessUpdateReview(
    actor: ActorContext,
    input: { teamWorkspaceId: string; userId: string }
  ): Promise<TeamWorkspaceAccessUpdateReviewRecord | null>;
  getPendingTeamInviteByTokenHash(
    tokenHash: string
  ): Promise<TeamInviteRecord | null>;
  getPendingTeamInviteReviewByTokenHash(
    tokenHash: string
  ): Promise<TeamInviteReviewRecord | null>;
  acceptTeamInvite(input: {
    tokenHash: string;
    userId: string;
    expectedVersion: number;
    expectedBackendOriginHash: string;
  }): Promise<AcceptedTeamInviteRecord | null>;
  listTeamInvites(
    actor: ActorContext,
    input: {
      teamId: string;
      includeRevoked?: boolean;
      limit?: number;
      cursor?: { createdAt: string; id: string };
    }
  ): Promise<{
    invites: TeamInviteRecord[];
    nextCursor: { createdAt: string; id: string } | null;
  } | null>;
  revokeTeamInvite(
    actor: ActorContext,
    input: { teamId: string; inviteId: string; expectedVersion: number }
  ): Promise<TeamInviteRecord | null>;
  updateTeamMemberRole(
    actor: ActorContext,
    input: {
      teamId: string;
      userId: string;
      role: TeamRole;
      expectedVersion: number;
    }
  ): Promise<TeamMembershipRecord | null>;
  leaveTeam(
    actor: ActorContext,
    input: { teamId: string; expectedVersion: number }
  ): Promise<TeamMembershipRecord | null>;
  disableTeamMember(
    actor: ActorContext,
    input: { teamId: string; userId: string; expectedVersion: number }
  ): Promise<TeamMembershipRecord | null>;
  setTeamWorkspaceAccess(
    actor: ActorContext,
    input: {
      teamWorkspaceId: string;
      userId: string;
      access: TeamWorkspaceAccessLevel;
      expectedVersion: number | null;
    }
  ): Promise<TeamWorkspaceAccessRecord | null>;
  archiveTeamWorkspace(
    actor: ActorContext,
    input: { teamWorkspaceId: string; expectedVersion: number }
  ): Promise<TeamWorkspaceRecord | null>;
  restoreTeamWorkspace(
    actor: ActorContext,
    input: { teamWorkspaceId: string; expectedVersion: number }
  ): Promise<TeamWorkspaceRecord | null>;
  getTeamWorkspaceAccess(
    actor: ActorContext,
    teamWorkspaceId: string
  ): Promise<TeamWorkspaceAccessRecord | null>;
  listTeamWorkspaceContexts(
    actor: ActorContext
  ): Promise<TeamWorkspaceContextRecord[]>;
  listTeamAuditEvents(
    actor: ActorContext,
    input: ListTeamAuditEventsInput
  ): Promise<AuditEventRecord[] | null>;
  createSession(
    userId: string,
    sessionHash: string,
    expiresAt: Date
  ): Promise<void>;
  getSessionContext(sessionHash: string): Promise<UserSessionContext | null>;
  getSessionUser(sessionHash: string): Promise<UserRecord | null>;
  revokeSession(sessionHash: string): Promise<void>;
  createApiToken(input: {
    ownerUserId: string;
    name: string;
    tokenHash: string;
    tokenPrefix: string;
    scopes?: string[];
    expiresAt?: Date;
    audit?: AuditActorInput;
  }): Promise<ApiTokenRecord>;
  listApiTokens(userId: string): Promise<ApiTokenRecord[]>;
  revokeApiToken(
    userId: string,
    tokenId: string,
    audit?: AuditActorInput
  ): Promise<boolean>;
  getApiTokenUser(tokenHash: string): Promise<UserRecord | null>;
  createDeviceEnrollmentChallenge(input: {
    challengeHash: string;
    upstreamBackendId: string;
    deviceInstanceId?: string | null;
    rotationLineageId?: string | null;
    rotationOwnerUserId?: string | null;
    rotationCredentialId?: string | null;
    deviceLabel?: string | null;
    requestedOperationFamilies: string[];
    metadata?: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<DeviceEnrollmentChallengeRecord>;
  getDeviceEnrollmentChallenge(
    challengeId: string
  ): Promise<DeviceEnrollmentChallengeRecord | null>;
  redeemDeviceEnrollmentChallenge(
    actor: ActorContext,
    input: {
      challengeHash: string;
      credentialKeyId: string;
      verifierKind: DeviceCredentialVerifierKind;
      verifierHash?: string | null;
      publicKeyJwk?: Record<string, unknown> | null;
      operationFamilies?: string[];
      metadata?: Record<string, unknown>;
      expiresAt?: Date | null;
    }
  ): Promise<DeviceCredentialRecord | null>;
  approveDeviceEnrollmentChallenge(
    actor: ActorContext,
    challengeId: string,
    input: {
      credentialKeyId: string;
      verifierKind: DeviceCredentialVerifierKind;
      verifierHash?: string | null;
      publicKeyJwk?: Record<string, unknown> | null;
      operationFamilies?: string[];
      metadata?: Record<string, unknown>;
      expiresAt?: Date | null;
    }
  ): Promise<DeviceCredentialRecord | null>;
  denyDeviceEnrollmentChallenge(
    actor: ActorContext,
    challengeId: string
  ): Promise<DeviceEnrollmentChallengeRecord | null>;
  listDeviceCredentials(
    actor: ActorContext,
    input?: { upstreamBackendId?: string }
  ): Promise<DeviceCredentialRecord[]>;
  revokeDeviceCredential(
    actor: ActorContext,
    credentialId: string,
    reason?: string
  ): Promise<boolean>;
  getDeviceCredentialUser(input: {
    credentialKeyId: string;
    verifierHash: string;
  }): Promise<DeviceCredentialAuthContext | null>;
  recordAuditEvent(input: RecordAuditEventInput): Promise<AuditEventRecord>;
  listAuditEvents(
    actor: ActorContext,
    input?: ListAuditEventsInput
  ): Promise<AuditEventRecord[]>;
  getActivationAnalyticsFunnel(
    actor: ActorContext,
    input?: GetActivationAnalyticsFunnelInput
  ): Promise<ActivationAnalyticsFunnelRecord | null>;
  projectPendingConversationItems(
    actor: ActorContext,
    input?: ConversationProjectionInput
  ): Promise<ConversationProjectionResult>;
  resetConversationProjection(
    actor: ActorContext,
    input: { sessionId: string }
  ): Promise<{
    conversationItemIds: string[];
    invalidatedMemoryEventIds: string[];
    projectionPolicyRevision: number;
  }>;
  listConversationProjectionActors(input?: {
    limit?: number;
    workClass?: "live_capture_projection" | "historical_import_backfill";
  }): Promise<ActorContext[]>;
  getConversationProjectionBacklog(): Promise<ConversationProjectionBacklog>;
  tryAcquireHistoricalProjectionLease(): Promise<HistoricalProjectionLease | null>;
  listPendingConversationProjectionProcessing(
    limit?: number
  ): Promise<ConversationProjectionProcessingRecord[]>;
  markConversationProjectionProcessingDispatched(
    eventIds: string[]
  ): Promise<number>;
  listPendingLcmDispatchScopes(input?: {
    limit?: number;
    ownerUserId?: string;
    workClass?: KoedWorkClass;
  }): Promise<LcmDispatchReconciliationScope[]>;
  listHistoricalImportSourcesNeedingLcmFinalization(): Promise<
    Array<{ sourceId: string; ownerUserId: string; sessionId: string }>
  >;
  reconcileHistoricalImportCompletion(): Promise<{
    sourcesCompleted: number;
    runsCompleted: number;
  }>;
  listSemanticMemoryRebuildActors(input?: {
    limit?: number;
  }): Promise<ActorContext[]>;
  getNextSemanticMemoryRebuildDueAt(): Promise<Date | null>;
  processDueSemanticMemoryRebuilds(
    actor: ActorContext,
    input?: SemanticMemoryRebuildInput
  ): Promise<SemanticMemoryRebuildResult>;
  listLocalMemoryAgentSettings(
    actor: ActorContext
  ): Promise<LocalMemoryAgentSettingRecord[]>;
  listAiClientInstances(actor: ActorContext): Promise<AiClientInstanceRecord[]>;
  listAiClientCapabilitySnapshots(
    actor: ActorContext
  ): Promise<AiClientCapabilitySnapshotDiagnosticRecord[]>;
  upsertAiClientInstance(
    actor: ActorContext,
    input: {
      instanceId: string;
      driverId: string;
      displayName: string;
      configIdentityHash?: string | null;
      enabled?: boolean;
    }
  ): Promise<AiClientInstanceRecord>;
  recordAiClientCapabilitySnapshot(
    actor: ActorContext,
    input: {
      instanceId: string;
      installationIdentityHash: string;
      clientVersion?: string | null;
      authenticationState: "authenticated" | "unauthenticated" | "unknown";
      healthState: "healthy" | "unavailable" | "incompatible" | "error";
      models: Array<Record<string, unknown>>;
      capabilities: Record<string, unknown>;
      observedAt: string;
      expiresAt: string;
    }
  ): Promise<AiClientCapabilitySnapshotRecord>;
  listCurrentAiClientCapabilitySnapshots(
    actor: ActorContext
  ): Promise<AiClientCapabilitySnapshotRecord[]>;
  upsertLocalMemoryAgentSetting(
    actor: ActorContext,
    input: {
      flowKey: LocalMemoryAgentSettingsFlowKey;
      provider: string;
      aiClientInstanceId: string;
      model: string;
      reasoningEffort: string;
      timeoutMs: number;
      maxAttempts: number;
    }
  ): Promise<LocalMemoryAgentSettingRecord>;
  deleteLocalMemoryAgentSetting(
    actor: ActorContext,
    flowKey: LocalMemoryAgentSettingsFlowKey
  ): Promise<boolean>;
  createHistoricalImportRun(
    actor: ActorContext
  ): Promise<HistoricalImportRunRecord>;
  listHistoricalImportRuns(
    actor: ActorContext,
    input?: { limit?: number }
  ): Promise<HistoricalImportRunRecord[]>;
  getHistoricalImportRun(
    actor: ActorContext,
    runId: string
  ): Promise<HistoricalImportRunDetail | null>;
  createHistoricalImportSource(
    actor: ActorContext,
    input: {
      runId: string;
      artifactId: string;
      aiClient: string;
      sourceEventFrom?: string;
      sourceEventTo?: string;
      discoveredRecordCount?: number;
      detectedProject?: Record<string, unknown>;
    }
  ): Promise<HistoricalImportSourceRecord | null>;
  transitionHistoricalImportRun(
    actor: ActorContext,
    input: {
      runId: string;
      expectedState: HistoricalImportState;
      state: HistoricalImportState;
      failureReason?: string | null;
      nextRetryAt?: string | null;
    }
  ): Promise<HistoricalImportRunRecord | null>;
  transitionHistoricalImportSource(
    actor: ActorContext,
    input: {
      sourceId: string;
      expectedState: HistoricalImportState;
      state: HistoricalImportState;
      failureReason?: string | null;
      nextRetryAt?: string | null;
    }
  ): Promise<HistoricalImportSourceRecord | null>;
  ingestHistoricalImportBatch(
    actor: ActorContext,
    input: HistoricalImportBatchWriteInput
  ): Promise<HistoricalImportBatchWriteResult>;
  getHistoricalImportSource(
    actor: ActorContext,
    sourceId: string
  ): Promise<HistoricalImportSourceRecord | null>;
  getHistoricalImportSourceByIdentity(
    actor: ActorContext,
    identity: HistoricalImportSourceIdentity
  ): Promise<HistoricalImportSourceRecord | null>;
  getEffectiveCapturePolicy(
    actor: ActorContext,
    input?: { projectId?: string; threadId?: string; sessionId?: string }
  ): Promise<EffectiveCapturePolicy>;
  listCapturePolicies(
    actor: ActorContext,
    targetType?: CapturePolicyTarget
  ): Promise<CapturePolicyRecord[]>;
  upsertCapturePolicy(
    actor: ActorContext,
    input: UpsertCapturePolicyInput
  ): Promise<CapturePolicyRecord>;
  deleteCapturePolicy(actor: ActorContext, policyId: string): Promise<boolean>;
  getLcmGraphOverview(actor: ActorContext): Promise<LcmGraphOverview>;
  listLcmGraphNodes(
    actor: ActorContext,
    input?: {
      query?: string;
      visibility?: Visibility;
      projectId?: string;
      threadId?: string;
      nodeIds?: string[];
      includeInvalidated?: boolean;
      limit?: number;
    }
  ): Promise<LcmGraphNode[]>;
  getLcmGraphNode(
    actor: ActorContext,
    nodeId: string,
    input?: { includeInvalidated?: boolean }
  ): Promise<LcmGraphNodeDetail | null>;
  updateLcmGraphNode(
    actor: ActorContext,
    nodeId: string,
    input: { summaryText?: string; visibility?: Visibility }
  ): Promise<LcmGraphNodeDetail | null>;
  invalidateLcmGraphNode(actor: ActorContext, nodeId: string): Promise<boolean>;
  listLcmGraphEvents(
    actor: ActorContext,
    input?: {
      eventId?: string;
      query?: string;
      visibility?: Visibility;
      projectId?: string;
      threadId?: string;
      cursorTimestamp?: string;
      cursorSourceSequence?: number;
      cursorId?: string;
      includeInvalidated?: boolean;
      includeContent?: boolean;
      includeRaw?: boolean;
      limit?: number;
    }
  ): Promise<LcmGraphEvent[]>;
  listLcmGraphThreads(
    actor: ActorContext,
    input?: {
      query?: string;
      visibility?: Visibility;
      projectId?: string;
      threadId?: string;
      includeInvalidated?: boolean;
      limit?: number;
      offset?: number;
    }
  ): Promise<LcmGraphProjectThreads[]>;
  getLcmGraphEvent(
    actor: ActorContext,
    eventId: string,
    input?: {
      includeInvalidated?: boolean;
      includeContent?: boolean;
      includeRaw?: boolean;
    }
  ): Promise<LcmGraphEvent | null>;
  updateLcmGraphEvent(
    actor: ActorContext,
    eventId: string,
    input: { visibility?: Visibility; invalidated?: boolean }
  ): Promise<LcmGraphEvent | null>;
  invalidateLcmGraphEvent(
    actor: ActorContext,
    eventId: string
  ): Promise<boolean>;
  exportMemoryRecords(actor: ActorContext): Promise<{
    exportedAt: string;
    overview: LcmGraphOverview;
    nodes: LcmGraphNodeDetail[];
    events: LcmGraphEvent[];
    curatedMemory: CuratedMemoryExportRecords;
  }>;
  listSourcesNeedingEmbeddings(
    limit?: number
  ): Promise<EmbeddableSourceRecord[]>;
  getEmbeddableSource(
    sourceType: EmbeddableSourceType,
    sourceId: string
  ): Promise<EmbeddableSourceRecord | null>;
  getCurrentSourceEmbeddingChunkCount(input: {
    source: EmbeddableSourceRecord;
    model: string;
    dimensions: number;
    version: string;
  }): Promise<number | null>;
  getRetrievalArenaIndexProof(input: {
    ownerUserId: string;
    sourceIds: string[];
    model: string;
    dimensions: number;
    version: string;
  }): Promise<{
    databaseName: string;
    schemaName: string;
    documents: Array<{
      sourceId: string;
      embeddingId: string;
      sourceHash: string;
      embeddingInputSha256: string;
      vectorSha256: string;
    }>;
  }>;
  getLcmNodeForSummarization(
    nodeId: string
  ): Promise<LcmNodeForSummarization | null>;
  listLcmNodesNeedingSummaries(
    actor: ActorContext,
    input?: { limit?: number }
  ): Promise<LcmNodeForSummarization[]>;
  getVisibleLcmNodeForSummarization(
    actor: ActorContext,
    nodeId: string
  ): Promise<LcmNodeForSummarization | null>;
  updateLcmNodeSummary(input: {
    nodeId: string;
    summaryText: string;
    summaryModel: string;
    summaryPromptVersion: string;
    summaryTokenEstimate: number;
    summaryStructuredJson?: Record<string, unknown>;
    summaryStructuredSchemaVersion?: string;
  }): Promise<void>;
  upsertSourceEmbedding(input: {
    source: EmbeddableSourceRecord;
    model: string;
    modelArtifactHash: string;
    dimensions: number;
    version: string;
    tokenizer: string;
    inputTransform: string;
    pooling: string;
    normalization: string;
    vector: number[];
    chunkIndex?: number;
    chunkCount?: number;
    inputTokenCount?: number;
    sourceText?: string;
  }): Promise<{ id: string; inserted: boolean }>;
  replaceSourceEmbeddings(input: {
    source: EmbeddableSourceRecord;
    model: string;
    modelArtifactHash: string;
    dimensions: number;
    version: string;
    tokenizer: string;
    inputTransform: string;
    pooling: string;
    normalization: string;
    chunks: Array<{
      vector: number[];
      chunkIndex: number;
      chunkCount: number;
      inputTokenCount: number;
      sourceText: string;
    }>;
  }): Promise<{ ids: string[]; inserted: boolean }>;
}
