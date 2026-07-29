import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  cleanupPurgeTargetArtifact,
  lockPurgeTarget,
  preparePurgeTargetForClaim,
  preparePurgeTargetCompletion,
  recordPurgeTargetCompletion,
  requiredArtifactsForPurgeTarget,
  validatePurgeTargetAttempt,
  validatePurgeTargetEvidenceArtifacts,
  type ExecutablePurgeTarget
} from "./retention/purge-target-registry.js";
import { createPurgeTargetStrategies } from "./retention/purge-target-strategies.js";

export type RetentionPolicyScope =
  | "team"
  | "workspace"
  | "share_grant"
  | "thread"
  | "owner_private_replica";

export type RetentionTrigger =
  | "share_revoked"
  | "team_deletion"
  | "workspace_policy"
  | "user_erasure"
  | "source_purge"
  | "policy_migration";

export type LegalHoldScope =
  | "team"
  | "workspace"
  | "thread"
  | "grant_representation"
  | "team_message_range"
  | "owner_private_replica";

export type PurgeTargetKind =
  | "team"
  | "workspace"
  | "thread"
  | "message"
  | "share_grant"
  | "grant_representation"
  | "owner_private_replica";

export type PurgeArtifactKind =
  | "database_row"
  | "encrypted_payload"
  | "wrapped_key"
  | "search_index"
  | "vector"
  | "outbox_replay"
  | "backup_copy";

export type PurgeEvidenceState =
  | "pending"
  | "cleaned"
  | "scheduled_expiry"
  | "verified"
  | "not_applicable"
  | "failed";

export type SharedMemoryRepresentation =
  | "memory_events"
  | "lcm_leaves"
  | "lcm_rollups";

export type RetentionPolicyTarget =
  | { scope: "team"; teamId: string }
  | { scope: "workspace"; teamId: string; teamWorkspaceId: string }
  | {
      scope: "share_grant";
      teamId: string;
      teamWorkspaceId: string;
      shareGrantId: string;
      logicalMemoryId: string;
    }
  | {
      scope: "thread";
      teamId: string;
      teamWorkspaceId?: string | null;
      threadId: string;
    }
  | {
      scope: "owner_private_replica";
      ownerPrivateReplicaId: string;
      logicalMemoryId: string;
    };

export type LegalHoldTarget =
  | { scope: "team"; teamId: string }
  | { scope: "workspace"; teamId: string; teamWorkspaceId: string }
  | {
      scope: "thread";
      teamId: string;
      teamWorkspaceId?: string | null;
      threadId: string;
    }
  | {
      scope: "grant_representation";
      teamId: string;
      teamWorkspaceId: string;
      shareGrantId: string;
      representationId: string;
      representation: SharedMemoryRepresentation;
      sourceRevision: number;
      logicalMemoryId: string;
    }
  | {
      scope: "team_message_range";
      teamId: string;
      teamWorkspaceId?: string | null;
      threadId: string;
      messageRangeStart?: number | null;
      messageRangeEnd?: number | null;
      messageTimeStart?: Date | null;
      messageTimeEnd?: Date | null;
    }
  | {
      scope: "owner_private_replica";
      ownerPrivateReplicaId: string;
      logicalMemoryId: string;
    };

interface TeamTargetFields {
  teamId: string;
  teamWorkspaceId?: string | null;
  shareGrantId?: string | null;
  representationId?: string | null;
  logicalMemoryId?: string | null;
  threadId?: string | null;
}

export type RetentionDecisionTarget =
  | ({ kind: "team"; targetId: string } & TeamTargetFields)
  | ({
      kind: "workspace";
      targetId: string;
      teamWorkspaceId: string;
    } & TeamTargetFields)
  | ({ kind: "thread"; targetId: string; threadId: string } & TeamTargetFields)
  | ({
      kind: "message";
      targetId: string;
      threadId: string;
      messageSequence?: number | null;
      messageAt?: Date | null;
    } & TeamTargetFields)
  | ({
      kind: "share_grant";
      targetId: string;
      teamWorkspaceId: string;
      shareGrantId: string;
      logicalMemoryId: string;
    } & TeamTargetFields)
  | ({
      kind: "grant_representation";
      targetId: string;
      teamWorkspaceId: string;
      shareGrantId: string;
      representationId: string;
      logicalMemoryId: string;
      representation?: SharedMemoryRepresentation | null;
      sourceRevision?: number | null;
    } & TeamTargetFields)
  | {
      kind: "owner_private_replica";
      targetId: string;
      ownerPrivateReplicaId: string;
      logicalMemoryId: string;
    };

export type RetentionPolicyRecord = RetentionPolicyTarget & {
  id: string;
  policyId: string;
  version: number;
  retentionSeconds: number;
  deletionGraceSeconds: number;
  backupRetentionSeconds: number;
  policyHash: string;
  createdByUserId: string | null;
  effectiveAt: Date;
  supersededAt: Date | null;
  createdAt: Date;
};

export interface LegalHoldRecord {
  id: string;
  target: LegalHoldTarget;
  authority: string;
  reasonCode: string;
  reasonHash: string;
  state: "active" | "release_pending" | "released";
  placedByUserId: string | null;
  freshlyAuthenticatedAt: Date;
  placedAt: Date;
  releaseRequestedByUserId: string | null;
  releaseRequestedAt: Date | null;
  releaseConfirmedByUserId: string | null;
  releaseConfirmedAt: Date | null;
  singleHolderReleaseException: boolean;
  releasedAt: Date | null;
}

export interface RetentionDecisionRecord {
  id: string;
  decisionVersion: number;
  policyId: string;
  policyVersion: number;
  target: RetentionDecisionTarget;
  trigger: RetentionTrigger;
  triggerEpoch: number;
  policyEffectiveAt: Date;
  triggeredAt: Date;
  retainUntil: Date;
  applicableLegalHoldIds: string[];
  eligible: boolean;
  eligibilityReasonCode:
    | "eligible"
    | "retention_period_active"
    | "active_legal_hold";
  decisionSnapshotHash: string;
  decidedAt: Date;
}

export interface RequiredPurgeArtifact {
  artifactKind: PurgeArtifactKind;
  artifactLocatorHash: string;
}

export interface PurgeEvidenceRecord extends RequiredPurgeArtifact {
  id: string;
  purgeJobId: string;
  purgeAttemptId: string | null;
  state: PurgeEvidenceState;
  removedRecordCount: number;
  removedByteCount: number;
  evidenceHash: string | null;
  backupExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  verifiedAt: Date | null;
}

export type PurgeJobTarget =
  | { kind: "team"; targetId: string; teamId: string }
  | {
      kind: "workspace";
      targetId: string;
      teamId: string;
      teamWorkspaceId: string;
    }
  | {
      kind: "thread";
      targetId: string;
      teamId: string;
      teamWorkspaceId: string | null;
    }
  | {
      kind: "message";
      targetId: string;
      teamId: string;
      teamWorkspaceId: string | null;
    }
  | {
      kind: "share_grant";
      targetId: string;
      teamId: string;
      teamWorkspaceId: string;
      shareGrantId: string;
      logicalMemoryId: string;
    }
  | {
      kind: "grant_representation";
      targetId: string;
      teamId: string;
      teamWorkspaceId: string;
      shareGrantId: string;
      representationId: string;
      logicalMemoryId: string;
    }
  | {
      kind: "owner_private_replica";
      targetId: string;
      ownerPrivateReplicaId: string;
      logicalMemoryId: string;
    };

export interface PurgeJobRecord {
  id: string;
  retentionDecisionId: string;
  target: PurgeJobTarget;
  state:
    | "pending"
    | "canceled"
    | "blocked"
    | "running"
    | "retry_wait"
    | "failed"
    | "verified";
  targetEpoch: number;
  idempotencyKey: string;
  resumeArtifactKind: PurgeArtifactKind | null;
  resumeCursor: string | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  nextAttemptAt: Date | null;
  verifiedAt: Date | null;
  terminalErrorCode: string | null;
  canceledAt: Date | null;
  cancellationReasonCode: string | null;
  canceledByUserId: string | null;
  canceledByMutationId: string | null;
}

export interface TeamDeletionRetentionRecord {
  id: string;
  name: string;
  version: number;
  lifecycle:
    | "active"
    | "suspended"
    | "deletion_requested"
    | "purge_pending"
    | "purged";
  deletionRequestedAt: Date | null;
  tombstonedAt: Date | null;
  retainUntil: Date | null;
  purgeCompletedAt: Date | null;
}

export interface RootTeamDeletionResult {
  team: TeamDeletionRetentionRecord;
  decision: RetentionDecisionRecord;
  purgeJob: PurgeJobRecord;
  requiredArtifacts: PurgeEvidenceRecord[];
}

export interface OwnerPrivateReplicaRetentionRecord {
  id: string;
  logicalMemoryId: string;
  ownerUserId: string;
  ownerPrincipalId: string;
  version: number;
  lifecycle:
    | "active"
    | "stale"
    | "revoked"
    | "tombstoned"
    | "purge_pending"
    | "purged";
  freshnessStatus: "unknown" | "fresh" | "stale" | "revoked" | "failed";
  tombstonedAt: Date | null;
  retainUntil: Date | null;
  purgeCompletedAt: Date | null;
}

export interface OwnerPrivateReplicaPurgeResult {
  ownerPrivateReplica: OwnerPrivateReplicaRetentionRecord;
  decision: RetentionDecisionRecord;
  purgeJob: PurgeJobRecord;
  requiredArtifacts: PurgeEvidenceRecord[];
}

export interface OwnerPrivateReplicaErasureCandidate {
  id: string;
  logicalMemoryId: string;
  version: number;
}

export interface UserErasureTombstoneRecord {
  userId: string;
  erasedAt: Date;
}

export interface ClaimedPurgeJob {
  job: PurgeJobRecord;
  attempt: {
    id: string;
    attemptNumber: number;
    startedAt: Date;
  };
  requiredArtifacts: PurgeEvidenceRecord[];
}

export type HoldLifecycleAction =
  | "place"
  | "request_release"
  | "confirm_release"
  | "single_holder_release";

export interface HoldAuthorizationContext {
  action: HoldLifecycleAction;
  actorUserId: string;
  target: LegalHoldTarget;
  holdId?: string;
  authority: string;
}

/**
 * This hook authorizes hold lifecycle mutations only. A successful result must
 * never be reused as authority to read the held content.
 */
export type AuthorizeHoldActor = (
  context: HoldAuthorizationContext
) => boolean | Promise<boolean>;

export interface RetentionLifecycleRepositoryOptions {
  authorizeHoldActor: AuthorizeHoldActor;
  clock?: () => Date;
  freshAuthenticationMaxAgeMs?: number;
  blockedHoldRecheckMs?: number;
  staleRunningAttemptMs?: number;
}

export interface RetentionPolicyShorteningAffectedScope {
  retentionDecisionId: string;
  targetKind: PurgeTargetKind;
  targetId: string;
  previousRetainUntil: Date;
  shortenedRetainUntil: Date;
  applicableLegalHoldIds: string[];
}

export interface RetentionPolicyShorteningPreviewRecord {
  id: string;
  teamId: string;
  policyId: string;
  policyVersion: number;
  state: "pending" | "confirmed" | "invalidated";
  previewedByUserId: string;
  previewedAt: Date;
  graceUntil: Date;
  previewHash: string;
  affectedScopes: RetentionPolicyShorteningAffectedScope[];
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
  invalidatedAt: Date | null;
  invalidationReasonCode: string | null;
}

export interface RetentionPolicyShorteningConfirmationRecord {
  previewId: string;
  previewHash: string;
  confirmedByUserId: string;
  confirmedAt: Date;
  migratedDecisionIds: string[];
}

export interface CreateRetentionPolicyInput {
  target: RetentionPolicyTarget;
  retentionSeconds: number;
  deletionGraceSeconds?: number;
  backupRetentionSeconds?: number;
  effectiveAt: Date;
  createdByUserId?: string | null;
}

export interface VersionRetentionPolicyInput {
  policyId: string;
  retentionSeconds: number;
  deletionGraceSeconds?: number;
  backupRetentionSeconds?: number;
  effectiveAt: Date;
  actorUserId: string;
  expectedTeamId?: string;
}

export interface PreviewRetentionPolicyShorteningInput {
  policyId: string;
  policyVersion: number;
  actorUserId: string;
  expectedTeamId: string;
  graceSeconds: number;
}

export interface ConfirmRetentionPolicyShorteningInput {
  previewId: string;
  previewHash: string;
  expectedAffectedScopeCount: number;
  actorUserId: string;
  expectedTeamId: string;
  expectedPolicyId: string;
}

export interface PlaceLegalHoldInput {
  target: LegalHoldTarget;
  actorUserId: string;
  authority: string;
  reasonCode: string;
  reasonHash: string;
  freshlyAuthenticatedAt: Date;
}

export interface SnapshotRetentionDecisionInput {
  policyId: string;
  decisionVersion?: number;
  target: RetentionDecisionTarget;
  trigger: RetentionTrigger;
  triggeredAt: Date;
  decidedAt?: Date;
}

export interface CreatePurgeJobInput {
  retentionDecisionId: string;
  idempotencyKey: string;
  requiredArtifacts: RequiredPurgeArtifact[];
}

export interface RequestRootTeamDeletionInput {
  teamId: string;
  actorUserId: string;
  expectedVersion: number;
  triggeredAt?: Date;
  idempotencyKey?: string;
}

export interface RequestOwnerPrivateReplicaPurgeInput {
  ownerPrivateReplicaId: string;
  actorUserId: string;
  expectedVersion: number;
  trigger?: "source_purge" | "user_erasure";
  triggeredAt?: Date;
  idempotencyKey?: string;
}

export interface PurgeAttemptCheckpointInput {
  purgeJobId: string;
  purgeAttemptId: string;
  resumeArtifactKind: PurgeArtifactKind | null;
  resumeCursor: string | null;
}

export interface RecordPurgeEvidenceInput extends RequiredPurgeArtifact {
  purgeJobId: string;
  purgeAttemptId: string;
  state: Exclude<PurgeEvidenceState, "pending">;
  removedRecordCount: number;
  removedByteCount: number;
  evidenceHash?: string | null;
  backupExpiresAt?: Date | null;
  observedAt?: Date;
}

export interface FinishPurgeAttemptInput {
  purgeJobId: string;
  purgeAttemptId: string;
  outcome: "completed" | "retryable_failure" | "terminal_failure";
  resumeArtifactKind?: PurgeArtifactKind | null;
  resumeCursor?: string | null;
  errorCode?: string | null;
  errorHash?: string | null;
  retryAt?: Date;
}

export interface ProcessClaimedPurgeJobInput {
  purgeJobId: string;
  purgeAttemptId: string;
  failBeforeArtifactKind?: PurgeArtifactKind;
}

export type PurgeCompletionResult =
  | { completed: true; job: PurgeJobRecord }
  | {
      completed: false;
      reason:
        | "active_attempt"
        | "active_legal_hold"
        | "missing_evidence"
        | "unverified_artifacts"
        | "job_not_completable";
      unverifiedArtifacts?: RequiredPurgeArtifact[];
    };

export interface RetentionLifecycleRepository {
  createPolicy(
    input: CreateRetentionPolicyInput
  ): Promise<RetentionPolicyRecord>;
  versionPolicy(
    input: VersionRetentionPolicyInput
  ): Promise<RetentionPolicyRecord>;
  previewPolicyShortening(
    input: PreviewRetentionPolicyShorteningInput
  ): Promise<RetentionPolicyShorteningPreviewRecord>;
  confirmPolicyShortening(
    input: ConfirmRetentionPolicyShorteningInput
  ): Promise<RetentionPolicyShorteningConfirmationRecord>;
  placeLegalHold(input: PlaceLegalHoldInput): Promise<LegalHoldRecord>;
  requestLegalHoldRelease(input: {
    holdId: string;
    actorUserId: string;
  }): Promise<LegalHoldRecord>;
  confirmLegalHoldRelease(input: {
    holdId: string;
    actorUserId: string;
    singleHolderReleaseException?: boolean;
  }): Promise<LegalHoldRecord>;
  snapshotDecision(
    input: SnapshotRetentionDecisionInput
  ): Promise<RetentionDecisionRecord>;
  requestRootTeamDeletion(
    input: RequestRootTeamDeletionInput
  ): Promise<RootTeamDeletionResult | null>;
  requestOwnerPrivateReplicaPurge(
    input: RequestOwnerPrivateReplicaPurgeInput
  ): Promise<OwnerPrivateReplicaPurgeResult | null>;
  listOwnerPrivateReplicasForUserErasure(
    userId: string
  ): Promise<OwnerPrivateReplicaErasureCandidate[]>;
  completeUserErasureTombstone(input: {
    userId: string;
    erasedAt?: Date;
  }): Promise<UserErasureTombstoneRecord | null>;
  createPurgeJob(input: CreatePurgeJobInput): Promise<PurgeJobRecord>;
  claimNextPurgeJob(): Promise<ClaimedPurgeJob | null>;
  processClaimedPurgeJob(
    input: ProcessClaimedPurgeJobInput
  ): Promise<PurgeJobRecord>;
  checkpointPurgeAttempt(
    input: PurgeAttemptCheckpointInput
  ): Promise<PurgeJobRecord>;
  recordPurgeEvidence(
    input: RecordPurgeEvidenceInput
  ): Promise<PurgeEvidenceRecord>;
  finishPurgeAttempt(input: FinishPurgeAttemptInput): Promise<PurgeJobRecord>;
  completePurgeJob(purgeJobId: string): Promise<PurgeCompletionResult>;
}

export class PurgeArtifactProcessingError extends Error {
  readonly artifactKind: PurgeArtifactKind;
  readonly artifactLocatorHash: string;

  constructor(input: RequiredPurgeArtifact, options?: ErrorOptions) {
    super(
      `Purge artifact processing failed for ${input.artifactKind}`,
      options
    );
    this.name = "PurgeArtifactProcessingError";
    this.artifactKind = input.artifactKind;
    this.artifactLocatorHash = input.artifactLocatorHash;
  }
}

type PolicyRow = QueryResultRow & {
  id: string;
  policy_id: string;
  version: number;
  scope: RetentionPolicyScope;
  team_id: string | null;
  team_workspace_id: string | null;
  share_grant_id: string | null;
  thread_id: string | null;
  owner_private_replica_id: string | null;
  logical_memory_id: string | null;
  retention_seconds: string | number;
  deletion_grace_seconds: string | number;
  backup_retention_seconds: string | number;
  policy_hash: string;
  created_by_user_id: string | null;
  effective_at: Date;
  superseded_at: Date | null;
  created_at: Date;
};

type HoldRow = QueryResultRow & {
  id: string;
  scope: LegalHoldScope;
  team_id: string | null;
  team_workspace_id: string | null;
  thread_id: string | null;
  share_grant_id: string | null;
  representation_id: string | null;
  representation: SharedMemoryRepresentation | null;
  source_revision: string | number | null;
  owner_private_replica_id: string | null;
  logical_memory_id: string | null;
  message_range_start: string | number | null;
  message_range_end: string | number | null;
  message_time_start: Date | null;
  message_time_end: Date | null;
  authority: string;
  reason_code: string;
  reason_hash: string;
  state: "active" | "release_pending" | "released";
  placed_by_user_id: string | null;
  freshly_authenticated_at: Date;
  placed_at: Date;
  release_requested_by_user_id: string | null;
  release_requested_at: Date | null;
  release_confirmed_by_user_id: string | null;
  release_confirmed_at: Date | null;
  single_holder_release_exception: boolean;
  released_at: Date | null;
};

type DecisionRow = QueryResultRow & {
  id: string;
  decision_version: number;
  policy_id: string;
  policy_version: number;
  target_kind: PurgeTargetKind;
  team_id: string | null;
  team_workspace_id: string | null;
  share_grant_id: string | null;
  representation_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  owner_private_replica_id: string | null;
  logical_memory_id: string | null;
  trigger: RetentionTrigger;
  trigger_epoch: string | number | bigint;
  policy_effective_at: Date;
  triggered_at: Date;
  retain_until: Date;
  applicable_legal_hold_ids: string[];
  eligible: boolean;
  eligibility_reason_code: RetentionDecisionRecord["eligibilityReasonCode"];
  decision_snapshot_hash: string;
  decided_at: Date;
};

type JobRow = QueryResultRow & {
  id: string;
  retention_decision_id: string;
  target_kind: PurgeTargetKind;
  target_id: string;
  team_id: string | null;
  team_workspace_id: string | null;
  share_grant_id: string | null;
  representation_id: string | null;
  logical_memory_id: string | null;
  state: PurgeJobRecord["state"];
  target_epoch: string | number;
  idempotency_key: string;
  resume_artifact_kind: PurgeArtifactKind | null;
  resume_cursor: string | null;
  attempt_count: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  next_attempt_at: Date | null;
  verified_at: Date | null;
  terminal_error_code: string | null;
  canceled_at: Date | null;
  cancellation_reason_code: string | null;
  canceled_by_user_id: string | null;
  canceled_by_mutation_id: string | null;
};

type EvidenceRow = QueryResultRow & {
  id: string;
  purge_job_id: string;
  purge_attempt_id: string | null;
  artifact_kind: PurgeArtifactKind;
  artifact_locator_hash: string;
  state: PurgeEvidenceState;
  removed_record_count: string | number;
  removed_byte_count: string | number;
  evidence_hash: string | null;
  backup_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  verified_at: Date | null;
};

type ShorteningPreviewRow = QueryResultRow & {
  id: string;
  retention_policy_row_id: string;
  team_id: string;
  policy_id: string;
  policy_version: number;
  policy_hash: string;
  state: RetentionPolicyShorteningPreviewRecord["state"];
  affected_scope_count: number;
  preview_hash: string;
  previewed_by_user_id: string;
  previewed_at: Date;
  grace_until: Date;
  confirmed_by_user_id: string | null;
  confirmed_at: Date | null;
  invalidated_at: Date | null;
  invalidation_reason_code: string | null;
  created_at: Date;
  updated_at: Date;
};

type ShorteningAffectedScopeRow = QueryResultRow & {
  id: string;
  preview_id: string;
  ordinal: number;
  retention_decision_id: string;
  target_kind: PurgeTargetKind;
  target_id: string;
  previous_retain_until: Date;
  shortened_retain_until: Date;
  applicable_legal_hold_ids: string[];
  scope_snapshot_hash: string;
  created_at: Date;
};

type ShorteningMigrationRow = QueryResultRow & {
  id: string;
  preview_id: string;
  affected_scope_id: string;
  previous_retention_decision_id: string;
  migrated_retention_decision_id: string;
  migrated_at: Date;
  created_at: Date;
};

type TeamDeletionRow = QueryResultRow & {
  id: string;
  name: string;
  version: number;
  lifecycle: TeamDeletionRetentionRecord["lifecycle"];
  deletion_requested_at: Date | null;
  tombstoned_at: Date | null;
  retain_until: Date | null;
  purge_completed_at: Date | null;
};

type OwnerPrivateReplicaRow = QueryResultRow & {
  id: string;
  logical_memory_id: string;
  owner_user_id: string;
  owner_principal_id: string;
  version: number;
  lifecycle: OwnerPrivateReplicaRetentionRecord["lifecycle"];
  freshness_status: OwnerPrivateReplicaRetentionRecord["freshnessStatus"];
  tombstoned_at: Date | null;
  retain_until: Date | null;
  purge_completed_at: Date | null;
};

type CleanupResult = {
  removedRecordCount: number;
  removedByteCount: number;
};

const defaultFreshAuthenticationMaxAgeMs = 5 * 60_000;
const defaultBlockedHoldRecheckMs = 60_000;
const defaultStaleRunningAttemptMs = 15 * 60_000;
const nilUuid = "00000000-0000-0000-0000-000000000000";
const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
};

const snapshotHash = (value: unknown): string =>
  sha256(JSON.stringify(canonicalize(value)));

export const DEFAULT_TEAM_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_TEAM_DELETION_GRACE_SECONDS = 0;
export const DEFAULT_TEAM_BACKUP_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const retentionPolicySnapshotHash = (input: {
  policyId: string;
  version: number;
  target: RetentionPolicyTarget;
  retentionSeconds: number;
  deletionGraceSeconds: number;
  backupRetentionSeconds: number;
  effectiveAt: Date;
}): string => snapshotHash(input);

const requireHash = (name: string, value: string): void => {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${name} must be a 64-character hexadecimal hash`);
  }
};

const requireNonEmpty = (name: string, value: string): void => {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
};

const requireNonNegativeInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
};

const requirePositiveInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
};

const requireValidDate = (name: string, value: Date): void => {
  if (!Number.isFinite(value.getTime())) throw new Error(`${name} is invalid`);
};

const numberFromDb = (value: unknown): number => {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "bigint"
  ) {
    throw new Error(
      "Database integer must be returned as a string, number, or bigint"
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Database integer exceeds JavaScript safe integer range");
  }
  return parsed;
};

const withTransaction = async <T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

const lockScopeKeys = async (
  client: PoolClient,
  keys: readonly string[]
): Promise<void> => {
  for (const key of [...new Set(keys)].sort()) {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [`koed.retention.${key}`]
    );
  }
};

const policyTargetFields = (target: RetentionPolicyTarget) => ({
  teamId: "teamId" in target ? target.teamId : null,
  teamWorkspaceId:
    "teamWorkspaceId" in target ? (target.teamWorkspaceId ?? null) : null,
  shareGrantId: "shareGrantId" in target ? target.shareGrantId : null,
  threadId: "threadId" in target ? target.threadId : null,
  ownerPrivateReplicaId:
    "ownerPrivateReplicaId" in target ? target.ownerPrivateReplicaId : null,
  logicalMemoryId: "logicalMemoryId" in target ? target.logicalMemoryId : null
});

const holdTargetFields = (target: LegalHoldTarget) => ({
  teamId: "teamId" in target ? target.teamId : null,
  teamWorkspaceId:
    "teamWorkspaceId" in target ? (target.teamWorkspaceId ?? null) : null,
  threadId: "threadId" in target ? target.threadId : null,
  shareGrantId: "shareGrantId" in target ? target.shareGrantId : null,
  representationId:
    "representationId" in target ? target.representationId : null,
  representation: "representation" in target ? target.representation : null,
  sourceRevision: "sourceRevision" in target ? target.sourceRevision : null,
  ownerPrivateReplicaId:
    "ownerPrivateReplicaId" in target ? target.ownerPrivateReplicaId : null,
  logicalMemoryId: "logicalMemoryId" in target ? target.logicalMemoryId : null,
  messageRangeStart:
    "messageRangeStart" in target ? (target.messageRangeStart ?? null) : null,
  messageRangeEnd:
    "messageRangeEnd" in target ? (target.messageRangeEnd ?? null) : null,
  messageTimeStart:
    "messageTimeStart" in target ? (target.messageTimeStart ?? null) : null,
  messageTimeEnd:
    "messageTimeEnd" in target ? (target.messageTimeEnd ?? null) : null
});

const validatePolicyTarget = (target: RetentionPolicyTarget): void => {
  if (target.scope === "thread" && target.teamWorkspaceId === undefined) {
    target.teamWorkspaceId = null;
  }
};

const validateHoldTarget = (target: LegalHoldTarget): void => {
  if (target.scope === "grant_representation") {
    requireNonNegativeInteger("Hold source revision", target.sourceRevision);
  }
  if (target.scope === "team_message_range") {
    const hasSequenceRange =
      target.messageRangeStart != null || target.messageRangeEnd != null;
    const hasTimeRange =
      target.messageTimeStart != null || target.messageTimeEnd != null;
    if (hasSequenceRange === hasTimeRange) {
      throw new Error(
        "A message hold requires exactly one complete sequence or time range"
      );
    }
    if (hasSequenceRange) {
      requirePositiveInteger(
        "Hold message range start",
        target.messageRangeStart!
      );
      requirePositiveInteger("Hold message range end", target.messageRangeEnd!);
      if (target.messageRangeEnd! < target.messageRangeStart!) {
        throw new Error("Hold message range end precedes its start");
      }
    } else {
      requireValidDate("Hold message time start", target.messageTimeStart!);
      requireValidDate("Hold message time end", target.messageTimeEnd!);
      if (
        target.messageTimeEnd!.getTime() < target.messageTimeStart!.getTime()
      ) {
        throw new Error("Hold message time end precedes its start");
      }
    }
  }
};

const scopeKeysForTeamFields = (fields: {
  teamId?: string | null;
  teamWorkspaceId?: string | null;
  shareGrantId?: string | null;
  representationId?: string | null;
  threadId?: string | null;
}): string[] => [
  ...(fields.teamId ? [`team:${fields.teamId}`] : []),
  ...(fields.teamWorkspaceId ? [`workspace:${fields.teamWorkspaceId}`] : []),
  ...(fields.shareGrantId ? [`grant:${fields.shareGrantId}`] : []),
  ...(fields.representationId
    ? [`representation:${fields.representationId}`]
    : []),
  ...(fields.threadId ? [`thread:${fields.threadId}`] : [])
];

const scopeKeysForPolicyTarget = (target: RetentionPolicyTarget): string[] => {
  const fields = policyTargetFields(target);
  return target.scope === "owner_private_replica"
    ? [`owner-replica:${target.ownerPrivateReplicaId}`]
    : scopeKeysForTeamFields(fields);
};

const scopeKeysForHoldTarget = (target: LegalHoldTarget): string[] => {
  const fields = holdTargetFields(target);
  return target.scope === "owner_private_replica"
    ? [`owner-replica:${target.ownerPrivateReplicaId}`]
    : scopeKeysForTeamFields(fields);
};

const scopeKeysForDecisionTarget = (
  target: RetentionDecisionTarget
): string[] =>
  target.kind === "owner_private_replica"
    ? [`owner-replica:${target.ownerPrivateReplicaId}`]
    : scopeKeysForTeamFields(target);

const targetFromPolicyRow = (row: PolicyRow): RetentionPolicyTarget => {
  switch (row.scope) {
    case "team":
      return { scope: row.scope, teamId: row.team_id! };
    case "workspace":
      return {
        scope: row.scope,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id!
      };
    case "share_grant":
      return {
        scope: row.scope,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id!,
        shareGrantId: row.share_grant_id!,
        logicalMemoryId: row.logical_memory_id!
      };
    case "thread":
      return {
        scope: row.scope,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id,
        threadId: row.thread_id!
      };
    case "owner_private_replica":
      return {
        scope: row.scope,
        ownerPrivateReplicaId: row.owner_private_replica_id!,
        logicalMemoryId: row.logical_memory_id!
      };
  }
};

const lockPolicyScope = async (
  client: PoolClient,
  policyId: string
): Promise<void> => {
  const current = await client.query<PolicyRow>(
    `select * from retention_policies
      where policy_id = $1
      order by version desc
      limit 1`,
    [policyId]
  );
  const policy = current.rows[0];
  if (!policy) throw new Error("Retention policy not found");
  await lockScopeKeys(client, [
    `policy:${policyId}`,
    ...scopeKeysForPolicyTarget(targetFromPolicyRow(policy))
  ]);
};

const targetFromHoldRow = (row: HoldRow): LegalHoldTarget => {
  switch (row.scope) {
    case "team":
      return { scope: row.scope, teamId: row.team_id! };
    case "workspace":
      return {
        scope: row.scope,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id!
      };
    case "thread":
      return {
        scope: row.scope,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id,
        threadId: row.thread_id!
      };
    case "grant_representation":
      return {
        scope: row.scope,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id!,
        shareGrantId: row.share_grant_id!,
        representationId: row.representation_id!,
        representation: row.representation!,
        sourceRevision: numberFromDb(row.source_revision!),
        logicalMemoryId: row.logical_memory_id!
      };
    case "team_message_range":
      return {
        scope: row.scope,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id,
        threadId: row.thread_id!,
        messageRangeStart:
          row.message_range_start == null
            ? null
            : numberFromDb(row.message_range_start),
        messageRangeEnd:
          row.message_range_end == null
            ? null
            : numberFromDb(row.message_range_end),
        messageTimeStart: row.message_time_start,
        messageTimeEnd: row.message_time_end
      };
    case "owner_private_replica":
      return {
        scope: row.scope,
        ownerPrivateReplicaId: row.owner_private_replica_id!,
        logicalMemoryId: row.logical_memory_id!
      };
  }
};

const mapPolicy = (row: PolicyRow): RetentionPolicyRecord => ({
  ...targetFromPolicyRow(row),
  id: row.id,
  policyId: row.policy_id,
  version: row.version,
  retentionSeconds: numberFromDb(row.retention_seconds),
  deletionGraceSeconds: numberFromDb(row.deletion_grace_seconds),
  backupRetentionSeconds: numberFromDb(row.backup_retention_seconds),
  policyHash: row.policy_hash,
  createdByUserId: row.created_by_user_id,
  effectiveAt: row.effective_at,
  supersededAt: row.superseded_at,
  createdAt: row.created_at
});

const mapHold = (row: HoldRow): LegalHoldRecord => ({
  id: row.id,
  target: targetFromHoldRow(row),
  authority: row.authority,
  reasonCode: row.reason_code,
  reasonHash: row.reason_hash,
  state: row.state,
  placedByUserId: row.placed_by_user_id,
  freshlyAuthenticatedAt: row.freshly_authenticated_at,
  placedAt: row.placed_at,
  releaseRequestedByUserId: row.release_requested_by_user_id,
  releaseRequestedAt: row.release_requested_at,
  releaseConfirmedByUserId: row.release_confirmed_by_user_id,
  releaseConfirmedAt: row.release_confirmed_at,
  singleHolderReleaseException: row.single_holder_release_exception,
  releasedAt: row.released_at
});

const targetFromDecisionRow = (row: DecisionRow): RetentionDecisionTarget => {
  switch (row.target_kind) {
    case "team":
      return {
        kind: "team",
        targetId: row.team_id!,
        teamId: row.team_id!
      };
    case "workspace":
      return {
        kind: "workspace",
        targetId: row.team_workspace_id!,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id!
      };
    case "thread":
      return {
        kind: "thread",
        targetId: row.thread_id!,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id,
        threadId: row.thread_id!
      };
    case "message":
      return {
        kind: "message",
        targetId: row.message_id!,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id,
        threadId: row.thread_id!
      };
    case "share_grant":
      return {
        kind: "share_grant",
        targetId: row.share_grant_id!,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id!,
        shareGrantId: row.share_grant_id!,
        logicalMemoryId: row.logical_memory_id!
      };
    case "grant_representation":
      return {
        kind: "grant_representation",
        targetId: row.representation_id!,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id!,
        shareGrantId: row.share_grant_id!,
        representationId: row.representation_id!,
        logicalMemoryId: row.logical_memory_id!
      };
    case "owner_private_replica":
      return {
        kind: "owner_private_replica",
        targetId: row.owner_private_replica_id!,
        ownerPrivateReplicaId: row.owner_private_replica_id!,
        logicalMemoryId: row.logical_memory_id!
      };
  }
};

const mapDecision = (row: DecisionRow): RetentionDecisionRecord => ({
  id: row.id,
  decisionVersion: row.decision_version,
  policyId: row.policy_id,
  policyVersion: row.policy_version,
  target: targetFromDecisionRow(row),
  trigger: row.trigger,
  triggerEpoch: numberFromDb(row.trigger_epoch),
  policyEffectiveAt: row.policy_effective_at,
  triggeredAt: row.triggered_at,
  retainUntil: row.retain_until,
  applicableLegalHoldIds: row.applicable_legal_hold_ids,
  eligible: row.eligible,
  eligibilityReasonCode: row.eligibility_reason_code,
  decisionSnapshotHash: row.decision_snapshot_hash,
  decidedAt: row.decided_at
});

const targetFromJobRow = (row: JobRow): PurgeJobTarget => {
  switch (row.target_kind) {
    case "team":
      return {
        kind: row.target_kind,
        targetId: row.target_id,
        teamId: row.team_id!
      };
    case "workspace":
      return {
        kind: row.target_kind,
        targetId: row.target_id,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id!
      };
    case "thread":
    case "message":
      return {
        kind: row.target_kind,
        targetId: row.target_id,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id
      };
    case "share_grant":
      return {
        kind: row.target_kind,
        targetId: row.target_id,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id!,
        shareGrantId: row.share_grant_id!,
        logicalMemoryId: row.logical_memory_id!
      };
    case "grant_representation":
      return {
        kind: row.target_kind,
        targetId: row.target_id,
        teamId: row.team_id!,
        teamWorkspaceId: row.team_workspace_id!,
        shareGrantId: row.share_grant_id!,
        representationId: row.representation_id!,
        logicalMemoryId: row.logical_memory_id!
      };
    case "owner_private_replica":
      return {
        kind: row.target_kind,
        targetId: row.target_id,
        ownerPrivateReplicaId: row.target_id,
        logicalMemoryId: row.logical_memory_id!
      };
  }
};

const mapJob = (row: JobRow): PurgeJobRecord => ({
  id: row.id,
  retentionDecisionId: row.retention_decision_id,
  target: targetFromJobRow(row),
  state: row.state,
  targetEpoch: numberFromDb(row.target_epoch),
  idempotencyKey: row.idempotency_key,
  resumeArtifactKind: row.resume_artifact_kind,
  resumeCursor: row.resume_cursor,
  attemptCount: row.attempt_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  nextAttemptAt: row.next_attempt_at,
  verifiedAt: row.verified_at,
  terminalErrorCode: row.terminal_error_code,
  canceledAt: row.canceled_at,
  cancellationReasonCode: row.cancellation_reason_code,
  canceledByUserId: row.canceled_by_user_id,
  canceledByMutationId: row.canceled_by_mutation_id
});

const mapEvidence = (row: EvidenceRow): PurgeEvidenceRecord => ({
  id: row.id,
  purgeJobId: row.purge_job_id,
  purgeAttemptId: row.purge_attempt_id,
  artifactKind: row.artifact_kind,
  artifactLocatorHash: row.artifact_locator_hash,
  state: row.state,
  removedRecordCount: numberFromDb(row.removed_record_count),
  removedByteCount: numberFromDb(row.removed_byte_count),
  evidenceHash: row.evidence_hash,
  backupExpiresAt: row.backup_expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  verifiedAt: row.verified_at
});

const mapTeamDeletion = (
  row: TeamDeletionRow
): TeamDeletionRetentionRecord => ({
  id: row.id,
  name: row.name,
  version: row.version,
  lifecycle: row.lifecycle,
  deletionRequestedAt: row.deletion_requested_at,
  tombstonedAt: row.tombstoned_at,
  retainUntil: row.retain_until,
  purgeCompletedAt: row.purge_completed_at
});

const mapOwnerPrivateReplica = (
  row: OwnerPrivateReplicaRow
): OwnerPrivateReplicaRetentionRecord => ({
  id: row.id,
  logicalMemoryId: row.logical_memory_id,
  ownerUserId: row.owner_user_id,
  ownerPrincipalId: row.owner_principal_id,
  version: row.version,
  lifecycle: row.lifecycle,
  freshnessStatus: row.freshness_status,
  tombstonedAt: row.tombstoned_at,
  retainUntil: row.retain_until,
  purgeCompletedAt: row.purge_completed_at
});

const validateDecisionTarget = (target: RetentionDecisionTarget): void => {
  const expectedTargetId =
    target.kind === "team"
      ? target.teamId
      : target.kind === "workspace"
        ? target.teamWorkspaceId
        : target.kind === "thread"
          ? target.threadId
          : target.kind === "share_grant"
            ? target.shareGrantId
            : target.kind === "grant_representation"
              ? target.representationId
              : target.kind === "owner_private_replica"
                ? target.ownerPrivateReplicaId
                : target.targetId;
  if (target.targetId !== expectedTargetId) {
    throw new Error("Retention decision target ID does not match its kind");
  }
  if (target.kind === "message") {
    if (target.messageSequence != null) {
      requirePositiveInteger("Message sequence", target.messageSequence);
    }
    if (target.messageAt != null)
      requireValidDate("Message timestamp", target.messageAt);
  }
};

const policyAppliesToTarget = (
  policy: RetentionPolicyTarget,
  target: RetentionDecisionTarget
): boolean => {
  if (policy.scope === "owner_private_replica") {
    return (
      target.kind === "owner_private_replica" &&
      target.ownerPrivateReplicaId === policy.ownerPrivateReplicaId &&
      target.logicalMemoryId === policy.logicalMemoryId
    );
  }
  if (target.kind === "owner_private_replica") return false;
  if (policy.teamId !== target.teamId) return false;
  switch (policy.scope) {
    case "team":
      return true;
    case "workspace":
      return target.teamWorkspaceId === policy.teamWorkspaceId;
    case "share_grant":
      return (
        target.shareGrantId === policy.shareGrantId &&
        target.logicalMemoryId === policy.logicalMemoryId
      );
    case "thread":
      return target.threadId === policy.threadId;
  }
};

const holdAppliesToTarget = (
  hold: HoldRow,
  target: RetentionDecisionTarget
): boolean => {
  if (target.kind === "owner_private_replica") {
    return (
      hold.scope === "owner_private_replica" &&
      hold.owner_private_replica_id === target.ownerPrivateReplicaId &&
      hold.logical_memory_id === target.logicalMemoryId
    );
  }
  if (
    hold.scope === "owner_private_replica" ||
    hold.team_id !== target.teamId
  ) {
    return false;
  }
  if (target.kind === "team") return true;
  if (hold.scope === "team") return true;
  if (
    hold.team_workspace_id != null &&
    hold.team_workspace_id !== target.teamWorkspaceId
  ) {
    return false;
  }
  if (target.kind === "workspace")
    return hold.team_workspace_id === target.teamWorkspaceId;
  if (hold.scope === "workspace") return true;
  if (hold.scope === "grant_representation") {
    if (hold.share_grant_id !== target.shareGrantId) return false;
    return (
      target.kind === "share_grant" ||
      (target.kind === "grant_representation" &&
        hold.representation_id === target.representationId &&
        (target.representation == null ||
          hold.representation === target.representation) &&
        (target.sourceRevision == null ||
          numberFromDb(hold.source_revision!) === target.sourceRevision))
    );
  }
  if (hold.scope === "thread") return hold.thread_id === target.threadId;
  if (hold.scope === "team_message_range") {
    if (hold.thread_id !== target.threadId) return false;
    if (target.kind === "thread") return true;
    if (target.kind !== "message") return false;
    // Sequence and event time are snapshot inputs but are not retained by the
    // current decision schema. A later lifecycle check therefore fails closed
    // for any range on the same thread when neither value can be reconstructed.
    if (target.messageSequence == null && target.messageAt == null) return true;
    const sequenceMatches =
      target.messageSequence != null &&
      hold.message_range_start != null &&
      target.messageSequence >= numberFromDb(hold.message_range_start) &&
      target.messageSequence <= numberFromDb(hold.message_range_end!);
    const timeMatches =
      target.messageAt != null &&
      hold.message_time_start != null &&
      target.messageAt >= hold.message_time_start &&
      target.messageAt <= hold.message_time_end!;
    return sequenceMatches || timeMatches;
  }
  return false;
};

const activeHoldsForTarget = async (
  client: PoolClient,
  target: RetentionDecisionTarget
): Promise<HoldRow[]> => {
  const result =
    target.kind === "owner_private_replica"
      ? await client.query<HoldRow>(
          `select * from legal_holds
             where state <> 'released'
               and owner_private_replica_id = $1
             order by id
             for share`,
          [target.ownerPrivateReplicaId]
        )
      : await client.query<HoldRow>(
          `select * from legal_holds
             where state <> 'released' and team_id = $1
             order by id
             for share`,
          [target.teamId]
        );
  return result.rows.filter((hold) => holdAppliesToTarget(hold, target));
};

const activeHoldsForPurgeTarget = async (
  client: PoolClient,
  target: RetentionDecisionTarget
): Promise<HoldRow[]> => {
  const holds = await activeHoldsForTarget(client, target);
  if (target.kind !== "share_grant") return holds;
  const companionHolds = await client.query<HoldRow>(
    `select hold.*
       from legal_holds hold
       join collaboration_threads thread on thread.id = hold.thread_id
      where hold.state <> 'released'
        and thread.share_grant_id = $1
        and thread.kind = 'shared_session_discussion'
        and thread.team_id = $2
        and thread.team_workspace_id = $3
      order by hold.id
      for share of hold`,
    [target.shareGrantId, target.teamId, target.teamWorkspaceId]
  );
  return [
    ...new Map(
      [...holds, ...companionHolds.rows].map((hold) => [hold.id, hold])
    ).values()
  ];
};

const decisionInsertFields = (target: RetentionDecisionTarget) => ({
  teamId: target.kind === "owner_private_replica" ? null : target.teamId,
  teamWorkspaceId:
    target.kind === "owner_private_replica"
      ? null
      : (target.teamWorkspaceId ?? null),
  shareGrantId:
    target.kind === "owner_private_replica"
      ? null
      : (target.shareGrantId ?? null),
  representationId:
    target.kind === "owner_private_replica"
      ? null
      : (target.representationId ?? null),
  threadId:
    target.kind === "owner_private_replica" ? null : (target.threadId ?? null),
  messageId: target.kind === "message" ? target.targetId : null,
  ownerPrivateReplicaId:
    target.kind === "owner_private_replica"
      ? target.ownerPrivateReplicaId
      : null,
  logicalMemoryId: target.logicalMemoryId ?? null
});

const targetFromDecisionForJob = (row: DecisionRow): RetentionDecisionTarget =>
  targetFromDecisionRow(row);

const requiredArtifactKey = (artifact: RequiredPurgeArtifact): string =>
  `${artifact.artifactKind}:${artifact.artifactLocatorHash}`;

const validateRequiredArtifacts = (
  artifacts: RequiredPurgeArtifact[]
): RequiredPurgeArtifact[] => {
  if (artifacts.length === 0) {
    throw new Error("A purge job requires at least one artifact");
  }
  const sorted = [...artifacts].sort((left, right) =>
    requiredArtifactKey(left).localeCompare(requiredArtifactKey(right))
  );
  for (const artifact of sorted) {
    requireHash("Artifact locator hash", artifact.artifactLocatorHash);
  }
  if (new Set(sorted.map(requiredArtifactKey)).size !== sorted.length) {
    throw new Error("A purge job cannot contain duplicate required artifacts");
  }
  return sorted;
};

const assertSameRequiredArtifacts = (
  expected: RequiredPurgeArtifact[],
  actual: EvidenceRow[]
): void => {
  assertSameArtifactSet(
    expected,
    actual.map((row) => ({
      artifactKind: row.artifact_kind,
      artifactLocatorHash: row.artifact_locator_hash
    }))
  );
};

const assertSameArtifactSet = (
  expected: RequiredPurgeArtifact[],
  actual: RequiredPurgeArtifact[]
): void => {
  const actualKeys = actual.map(requiredArtifactKey).sort();
  const expectedKeys = expected.map(requiredArtifactKey).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      "Purge job idempotency key was reused with different artifacts"
    );
  }
};

const ensureAuthorized = async (
  authorize: AuthorizeHoldActor,
  context: HoldAuthorizationContext
): Promise<void> => {
  if (!(await authorize(context))) {
    throw new Error(
      `Actor is not authorized to ${context.action} this legal hold`
    );
  }
};

const forbiddenRetentionPolicyManagement = (): Error =>
  Object.assign(
    new Error("Actor is not authorized to manage this retention policy"),
    { statusCode: 403 }
  );

const ensureTeamPolicyManager = async (
  client: PoolClient,
  actorUserId: string,
  target: RetentionPolicyTarget,
  expectedTeamId: string
): Promise<string> => {
  requireNonEmpty("Actor user ID", actorUserId);
  requireNonEmpty("Expected Team ID", expectedTeamId);
  if (
    target.scope === "owner_private_replica" ||
    target.teamId !== expectedTeamId
  ) {
    throw forbiddenRetentionPolicyManagement();
  }
  const authorized = await client.query(
    `select 1
       from teams team
       join team_memberships membership on membership.team_id = team.id
      where team.id = $1
        and team.lifecycle = 'active'
        and membership.user_id = $2
        and membership.role in ('owner', 'admin')
        and membership.status = 'enabled'
        and membership.disabled_at is null
      limit 1
      for share of team, membership`,
    [expectedTeamId, actorUserId]
  );
  if (!authorized.rowCount) throw forbiddenRetentionPolicyManagement();
  return expectedTeamId;
};

const shorteningAffectedScopeSnapshot = (
  row: DecisionRow,
  shortenedRetainUntil: Date,
  applicableLegalHoldIds: string[]
): RetentionPolicyShorteningAffectedScope => ({
  retentionDecisionId: row.id,
  targetKind: row.target_kind,
  targetId: targetFromDecisionRow(row).targetId,
  previousRetainUntil: row.retain_until,
  shortenedRetainUntil,
  applicableLegalHoldIds
});

const shorteningPreviewHash = (input: {
  teamId: string;
  policyId: string;
  policyVersion: number;
  policyHash: string;
  previewedByUserId: string;
  previewedAt: Date;
  graceUntil: Date;
  affectedScopes: RetentionPolicyShorteningAffectedScope[];
}): string =>
  snapshotHash({
    previewVersion: 1,
    ...input,
    affectedScopes: input.affectedScopes.map((scope) => ({
      retentionDecisionId: scope.retentionDecisionId,
      targetKind: scope.targetKind,
      targetId: scope.targetId,
      previousRetainUntil: scope.previousRetainUntil,
      shortenedRetainUntil: scope.shortenedRetainUntil,
      applicableLegalHoldIds: scope.applicableLegalHoldIds
    }))
  });

const shorteningAffectedScopeHash = (
  scope: RetentionPolicyShorteningAffectedScope
): string =>
  snapshotHash({
    affectedScopeVersion: 1,
    retentionDecisionId: scope.retentionDecisionId,
    targetKind: scope.targetKind,
    targetId: scope.targetId,
    previousRetainUntil: scope.previousRetainUntil,
    shortenedRetainUntil: scope.shortenedRetainUntil,
    applicableLegalHoldIds: scope.applicableLegalHoldIds
  });

const mapShorteningAffectedScope = (
  row: ShorteningAffectedScopeRow
): RetentionPolicyShorteningAffectedScope => ({
  retentionDecisionId: row.retention_decision_id,
  targetKind: row.target_kind,
  targetId: row.target_id,
  previousRetainUntil: row.previous_retain_until,
  shortenedRetainUntil: row.shortened_retain_until,
  applicableLegalHoldIds: row.applicable_legal_hold_ids
});

const mapShorteningPreview = (
  row: ShorteningPreviewRow,
  affectedRows: ShorteningAffectedScopeRow[]
): RetentionPolicyShorteningPreviewRecord => {
  if (affectedRows.length !== row.affected_scope_count) {
    throw new Error(
      "Retention policy shortening preview scope count is invalid"
    );
  }
  const affectedScopes = affectedRows.map(mapShorteningAffectedScope);
  for (const [index, affected] of affectedScopes.entries()) {
    const persisted = affectedRows[index]!;
    if (
      shorteningAffectedScopeHash(affected) !== persisted.scope_snapshot_hash
    ) {
      throw new Error("Retention policy shortening scope snapshot is invalid");
    }
  }
  return {
    id: row.id,
    teamId: row.team_id,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    state: row.state,
    previewedByUserId: row.previewed_by_user_id,
    previewedAt: row.previewed_at,
    graceUntil: row.grace_until,
    previewHash: row.preview_hash,
    affectedScopes,
    confirmedByUserId: row.confirmed_by_user_id,
    confirmedAt: row.confirmed_at,
    invalidatedAt: row.invalidated_at,
    invalidationReasonCode: row.invalidation_reason_code
  };
};

const mapShorteningConfirmation = (
  preview: ShorteningPreviewRow,
  migrations: ShorteningMigrationRow[]
): RetentionPolicyShorteningConfirmationRecord => {
  if (
    preview.state !== "confirmed" ||
    !preview.confirmed_by_user_id ||
    !preview.confirmed_at ||
    migrations.length !== preview.affected_scope_count
  ) {
    throw new Error("Retention policy shortening confirmation is incomplete");
  }
  return {
    previewId: preview.id,
    previewHash: preview.preview_hash,
    confirmedByUserId: preview.confirmed_by_user_id,
    confirmedAt: preview.confirmed_at,
    migratedDecisionIds: migrations.map(
      (migration) => migration.migrated_retention_decision_id
    )
  };
};

const loadShorteningPreviewAggregate = async (
  client: PoolClient,
  previewId: string,
  options: { forUpdate?: boolean } = {}
): Promise<{
  previewRow: ShorteningPreviewRow;
  affectedRows: ShorteningAffectedScopeRow[];
}> => {
  const previewResult = await client.query<ShorteningPreviewRow>(
    `select * from retention_policy_shortening_previews
      where id = $1${options.forUpdate ? " for update" : ""}`,
    [previewId]
  );
  const previewRow = previewResult.rows[0];
  if (!previewRow)
    throw new Error("Retention policy shortening preview not found");
  const affected = await client.query<ShorteningAffectedScopeRow>(
    `select * from retention_policy_shortening_affected_scopes
      where preview_id = $1
      order by ordinal
      ${options.forUpdate ? "for share" : ""}`,
    [previewId]
  );
  return { previewRow, affectedRows: affected.rows };
};

const loadShorteningMigrations = async (
  client: PoolClient,
  previewId: string
): Promise<ShorteningMigrationRow[]> => {
  const result = await client.query<ShorteningMigrationRow>(
    `select * from retention_policy_shortening_migrations
      where preview_id = $1
      order by previous_retention_decision_id`,
    [previewId]
  );
  return result.rows;
};

const loadJobAndDecision = async (
  client: PoolClient,
  purgeJobId: string
): Promise<{ job: JobRow; decision: DecisionRow }> => {
  const jobs = await client.query<JobRow>(
    "select * from purge_jobs where id = $1 for update",
    [purgeJobId]
  );
  const job = jobs.rows[0];
  if (!job) throw new Error("Purge job not found");
  const decisions = await client.query<DecisionRow>(
    "select * from retention_decisions where id = $1 for share",
    [job.retention_decision_id]
  );
  const decision = decisions.rows[0];
  if (!decision) throw new Error("Retention decision not found");
  return { job, decision };
};

const closeRunningAttemptsForHold = async (
  client: PoolClient,
  purgeJobId: string,
  completedAt: Date
): Promise<void> => {
  await client.query(
    `update purge_job_attempts
        set state = 'retryable_failure', completed_at = $2,
            error_code = 'legal_hold_activated', error_hash = $3
      where purge_job_id = $1 and state = 'running'`,
    [purgeJobId, completedAt, sha256("legal_hold_activated")]
  );
};

const artifactCompletionOrder: PurgeArtifactKind[] = [
  "outbox_replay",
  "vector",
  "encrypted_payload",
  "wrapped_key",
  "search_index",
  "database_row",
  "backup_copy"
];

const teamDeletionArtifacts = (teamId: string): RequiredPurgeArtifact[] =>
  artifactCompletionOrder.map((artifactKind) => ({
    artifactKind,
    artifactLocatorHash: sha256(`team:${teamId}:${artifactKind}:v1`)
  }));

const ownerPrivateReplicaArtifacts = (
  ownerPrivateReplicaId: string
): RequiredPurgeArtifact[] =>
  artifactCompletionOrder.map((artifactKind) => ({
    artifactKind,
    artifactLocatorHash: sha256(
      `owner-private-replica:${ownerPrivateReplicaId}:${artifactKind}:v1`
    )
  }));

const shareGrantArtifacts = (shareGrantId: string): RequiredPurgeArtifact[] =>
  artifactCompletionOrder.map((artifactKind) => ({
    artifactKind,
    artifactLocatorHash: sha256(
      `share-grant:${shareGrantId}:${artifactKind}:v1`
    )
  }));

export const lockShareGrantRetentionScopeWithClient = async (
  client: PoolClient,
  shareGrantId: string
): Promise<boolean> => {
  const scope = await client.query<
    QueryResultRow & {
      team_id: string;
      team_workspace_id: string;
    }
  >(
    `select team_id, team_workspace_id
       from team_session_share_grants
      where id = $1`,
    [shareGrantId]
  );
  const row = scope.rows[0];
  if (!row) return false;
  await lockScopeKeys(
    client,
    scopeKeysForTeamFields({
      teamId: row.team_id,
      teamWorkspaceId: row.team_workspace_id,
      shareGrantId
    })
  );
  return true;
};

export const scheduleShareGrantRevocationRetentionWithClient = async (
  client: PoolClient,
  input: {
    shareGrantId: string;
    actorUserId: string;
    mutationId: string;
    revocationEpoch: number;
    triggeredAt: Date;
  }
): Promise<void> => {
  const grantResult = await client.query<
    QueryResultRow & {
      id: string;
      team_id: string;
      team_workspace_id: string;
      logical_memory_id: string;
      lifecycle: string;
    }
  >(
    `select id, team_id, team_workspace_id, logical_memory_id, lifecycle
       from team_session_share_grants
      where id = $1
      for update`,
    [input.shareGrantId]
  );
  const grant = grantResult.rows[0];
  if (!grant || grant.lifecycle !== "revoked") {
    throw new Error("Revoked Share Grant retention target is unavailable");
  }

  const idempotencyKey = `share-grant:${input.shareGrantId}:revocation:${input.mutationId}`;
  const existingJob = await client.query<JobRow>(
    "select * from purge_jobs where idempotency_key = $1 for update",
    [idempotencyKey]
  );
  if (existingJob.rows[0]) {
    const evidence = await client.query<EvidenceRow>(
      "select * from purge_job_evidence where purge_job_id = $1 order by artifact_kind, artifact_locator_hash",
      [existingJob.rows[0].id]
    );
    assertSameRequiredArtifacts(
      requiredArtifactsForPurgeTarget(purgeTargetStrategies, {
        kind: "share_grant",
        targetId: input.shareGrantId,
        teamId: grant.team_id,
        teamWorkspaceId: grant.team_workspace_id,
        shareGrantId: input.shareGrantId,
        logicalMemoryId: grant.logical_memory_id
      }),
      evidence.rows
    );
    return;
  }

  requirePositiveInteger("Share Grant revocation epoch", input.revocationEpoch);
  const policyResult = await client.query<PolicyRow>(
    `select *
       from retention_policies
      where effective_at <= $4
        and (superseded_at is null or superseded_at > $4)
        and (
          (scope = 'share_grant' and share_grant_id = $1
            and team_id = $2 and team_workspace_id = $3)
          or (scope = 'workspace' and team_id = $2
            and team_workspace_id = $3)
          or (scope = 'team' and team_id = $2)
        )
      order by case scope
        when 'share_grant' then 1
        when 'workspace' then 2
        when 'team' then 3
        else 4
      end, version desc, policy_id
      for share`,
    [
      input.shareGrantId,
      grant.team_id,
      grant.team_workspace_id,
      input.triggeredAt
    ]
  );
  if (!policyResult.rows.length) {
    throw new Error(
      "No retention policy was effective for the Share Grant at revocation time"
    );
  }

  const evaluatedPolicies = policyResult.rows.map((candidate) => {
    const retainUntilMs =
      input.triggeredAt.getTime() +
      (numberFromDb(candidate.retention_seconds) +
        numberFromDb(candidate.deletion_grace_seconds)) *
        1_000;
    if (!Number.isSafeInteger(retainUntilMs)) {
      throw new Error("Retention deadline exceeds the supported date range");
    }
    return { policy: candidate, retainUntil: new Date(retainUntilMs) };
  });
  evaluatedPolicies.sort((left, right) => {
    const deadline = right.retainUntil.getTime() - left.retainUntil.getTime();
    if (deadline !== 0) return deadline;
    const specificity = (scope: RetentionPolicyScope): number =>
      scope === "share_grant" ? 1 : scope === "workspace" ? 2 : 3;
    const scopeOrder =
      specificity(left.policy.scope) - specificity(right.policy.scope);
    if (scopeOrder !== 0) return scopeOrder;
    return left.policy.policy_id.localeCompare(right.policy.policy_id);
  });
  const controlling = evaluatedPolicies[0]!;
  const policy = controlling.policy;

  const target: RetentionDecisionTarget = {
    kind: "share_grant",
    targetId: input.shareGrantId,
    teamId: grant.team_id,
    teamWorkspaceId: grant.team_workspace_id,
    shareGrantId: input.shareGrantId,
    logicalMemoryId: grant.logical_memory_id
  };
  const holds = await activeHoldsForPurgeTarget(client, target);
  const holdIds = holds.map((hold) => hold.id).sort();
  const retainUntil = controlling.retainUntil;
  requireValidDate("Retention deadline", retainUntil);
  const eligible = holdIds.length === 0 && input.triggeredAt >= retainUntil;
  const eligibilityReasonCode =
    holdIds.length > 0
      ? "active_legal_hold"
      : input.triggeredAt < retainUntil
        ? "retention_period_active"
        : "eligible";
  const decisionSnapshotHash = snapshotHash({
    decisionVersion: 1,
    policy: {
      policyId: policy.policy_id,
      version: policy.version,
      policyHash: policy.policy_hash,
      effectiveAt: policy.effective_at
    },
    target,
    trigger: "share_revoked",
    triggerEpoch: input.revocationEpoch,
    triggeredAt: input.triggeredAt,
    retainUntil,
    applicableLegalHoldIds: holdIds,
    eligible,
    eligibilityReasonCode,
    decidedAt: input.triggeredAt,
    evaluatedPolicies: evaluatedPolicies.map((candidate) => ({
      policyId: candidate.policy.policy_id,
      version: candidate.policy.version,
      policyHash: candidate.policy.policy_hash,
      scope: candidate.policy.scope,
      effectiveAt: candidate.policy.effective_at,
      retainUntil: candidate.retainUntil
    }))
  });
  const decisionResult = await client.query<DecisionRow>(
    `insert into retention_decisions (
       decision_version, policy_id, policy_version, target_kind, team_id,
       team_workspace_id, share_grant_id, logical_memory_id, trigger,
       trigger_epoch,
       policy_effective_at, triggered_at, retain_until,
       applicable_legal_hold_ids, eligible, eligibility_reason_code,
       decision_snapshot_hash, decided_at
     ) values (
       1, $1, $2, 'share_grant', $3, $4, $5, $6, 'share_revoked', $7,
       $8, $9, $10, $11, $12, $13, $14, $9
     ) returning *`,
    [
      policy.policy_id,
      policy.version,
      grant.team_id,
      grant.team_workspace_id,
      input.shareGrantId,
      grant.logical_memory_id,
      input.revocationEpoch,
      policy.effective_at,
      input.triggeredAt,
      retainUntil,
      holdIds,
      eligible,
      eligibilityReasonCode,
      decisionSnapshotHash
    ]
  );
  const decision = decisionResult.rows[0]!;
  const jobResult = await client.query<JobRow>(
    `insert into purge_jobs (
       retention_decision_id, target_kind, target_id, team_id,
       team_workspace_id, share_grant_id, logical_memory_id, target_epoch,
       idempotency_key
     ) values ($1, 'share_grant', $2, $3, $4, $2, $5, $6, $7)
     returning *`,
    [
      decision.id,
      input.shareGrantId,
      grant.team_id,
      grant.team_workspace_id,
      grant.logical_memory_id,
      input.revocationEpoch,
      idempotencyKey
    ]
  );
  const job = jobResult.rows[0]!;
  for (const artifact of requiredArtifactsForPurgeTarget(
    purgeTargetStrategies,
    target
  )) {
    await client.query(
      `insert into purge_job_evidence (
         purge_job_id, artifact_kind, artifact_locator_hash,
         removed_record_count, removed_byte_count
       ) values ($1, $2, $3, 0, 0)`,
      [job.id, artifact.artifactKind, artifact.artifactLocatorHash]
    );
  }

  await client.query(
    `update team_session_share_grants
        set retention_policy_id = $2, retention_policy_version = $3,
            retention_triggered_at = $4, retain_until = $5,
            active_retention_decision_id = $6, active_purge_job_id = $7,
            updated_at = $4
      where id = $1`,
    [
      input.shareGrantId,
      policy.policy_id,
      policy.version,
      input.triggeredAt,
      retainUntil,
      decision.id,
      job.id
    ]
  );
  await client.query(
    `update team_memory_representations
        set retain_until = $2, updated_at = $3
      where share_grant_id = $1 and state <> 'purged'`,
    [input.shareGrantId, retainUntil, input.triggeredAt]
  );
  await client.query(
    `update collaboration_threads
        set retention_policy_id = $2, retention_policy_version = $3,
            retention_triggered_at = $4, retain_until = $5,
            updated_at = $4
      where share_grant_id = $1
        and kind = 'shared_session_discussion'
        and lifecycle <> 'purged'`,
    [
      input.shareGrantId,
      policy.policy_id,
      policy.version,
      input.triggeredAt,
      retainUntil
    ]
  );
  await client.query(
    `insert into audit_events (
       actor_user_id, action, target_table, target_id, metadata
     ) values ($1, 'share_grant.retention_started',
       'team_session_share_grants', $2, $3::jsonb)`,
    [
      input.actorUserId,
      input.shareGrantId,
      JSON.stringify({
        teamId: grant.team_id,
        teamWorkspaceId: grant.team_workspace_id,
        shareGrantId: input.shareGrantId,
        retentionDecisionId: decision.id,
        purgeJobId: job.id,
        policyId: policy.policy_id,
        policyVersion: policy.version,
        revocationEpoch: input.revocationEpoch,
        triggeredAt: input.triggeredAt.toISOString(),
        retainUntil: retainUntil.toISOString(),
        applicableLegalHoldIds: holdIds,
        decisionSnapshotHash,
        evaluatedPolicies: evaluatedPolicies.map((candidate) => ({
          policyId: candidate.policy.policy_id,
          version: candidate.policy.version,
          scope: candidate.policy.scope,
          retainUntil: candidate.retainUntil.toISOString()
        }))
      })
    ]
  );
};

export const cancelShareGrantRevocationRetentionWithClient = async (
  client: PoolClient,
  input: {
    shareGrantId: string;
    actorUserId: string;
    mutationId: string;
    canceledAt: Date;
  }
): Promise<"none" | "canceled" | "purge_started"> => {
  const grantResult = await client.query<
    QueryResultRow & {
      retention_triggered_at: Date | null;
      active_purge_job_id: string | null;
    }
  >(
    `select retention_triggered_at, active_purge_job_id
       from team_session_share_grants
      where id = $1
      for update`,
    [input.shareGrantId]
  );
  const triggeredAt = grantResult.rows[0]?.retention_triggered_at ?? null;
  const activePurgeJobId = grantResult.rows[0]?.active_purge_job_id ?? null;
  if (!triggeredAt) return "none";
  if (!activePurgeJobId) {
    throw new Error("Share Grant active purge job is missing");
  }
  const jobResult = await client.query<JobRow>(
    `select job.*
       from purge_jobs job
       join retention_decisions decision
         on decision.id = job.retention_decision_id
      where job.id = $1
        and decision.target_kind = 'share_grant'
        and decision.share_grant_id = $2
        and decision.trigger = 'share_revoked'
      for update of job`,
    [activePurgeJobId, input.shareGrantId]
  );
  const job = jobResult.rows[0];
  if (!job) {
    throw new Error("Share Grant retention job is missing");
  }
  if (job.state === "canceled") return "canceled";
  if (job.state !== "pending" || job.started_at !== null) {
    return "purge_started";
  }
  const touched = await client.query(
    `select 1
      where exists (
        select 1
          from purge_job_evidence
         where purge_job_id = $1
           and (state <> 'pending' or purge_attempt_id is not null)
         for share
      ) or exists (
        select 1 from purge_job_attempts where purge_job_id = $1
      )`,
    [job.id]
  );
  if (touched.rowCount) return "purge_started";
  const canceled = await client.query(
    `update purge_jobs
        set state = 'canceled', next_attempt_at = null,
            resume_artifact_kind = null, resume_cursor = null,
            terminal_error_code = null, canceled_at = $2,
            cancellation_reason_code = 'restored_before_purge',
            canceled_by_user_id = $3, canceled_by_mutation_id = $4,
            updated_at = $2
      where id = $1 and state = 'pending' and attempt_count = 0
        and started_at is null and resume_artifact_kind is null
        and resume_cursor is null
      returning id`,
    [job.id, input.canceledAt, input.actorUserId, input.mutationId]
  );
  if (!canceled.rowCount) return "purge_started";
  await client.query(
    `update team_session_share_grants
        set retention_policy_id = null, retention_policy_version = null,
            retention_triggered_at = null, retain_until = null,
            active_retention_decision_id = null, active_purge_job_id = null,
            tombstoned_at = null, updated_at = $2
      where id = $1`,
    [input.shareGrantId, input.canceledAt]
  );
  await client.query(
    `update team_memory_representations
        set retain_until = null, updated_at = $2
      where share_grant_id = $1 and state <> 'purged'`,
    [input.shareGrantId, input.canceledAt]
  );
  await client.query(
    `update collaboration_threads
        set retention_policy_id = null, retention_policy_version = null,
            retention_triggered_at = null, retain_until = null,
            tombstoned_at = null, updated_at = $2
      where share_grant_id = $1
        and kind = 'shared_session_discussion'
        and lifecycle <> 'purged'`,
    [input.shareGrantId, input.canceledAt]
  );
  await client.query(
    `insert into audit_events (
       actor_user_id, action, target_table, target_id, metadata
     ) values ($1, 'share_grant.retention_canceled',
       'team_session_share_grants', $2, $3::jsonb)`,
    [
      input.actorUserId,
      input.shareGrantId,
      JSON.stringify({
        shareGrantId: input.shareGrantId,
        purgeJobId: job.id,
        canceledAt: input.canceledAt.toISOString()
      })
    ]
  );
  return "canceled";
};

const evidenceHashForArtifact = (input: {
  purgeJobId: string;
  artifactKind: PurgeArtifactKind;
  artifactLocatorHash: string;
  state: Exclude<PurgeEvidenceState, "pending" | "failed">;
  removedRecordCount: number;
  removedByteCount: number;
  observedAt: Date;
  backupExpiresAt?: Date | null;
}): string =>
  snapshotHash({
    evidenceVersion: 1,
    purgeJobId: input.purgeJobId,
    artifactKind: input.artifactKind,
    artifactLocatorHash: input.artifactLocatorHash,
    state: input.state,
    removedRecordCount: input.removedRecordCount,
    removedByteCount: input.removedByteCount,
    observedAt: input.observedAt,
    backupExpiresAt: input.backupExpiresAt ?? null
  });

const sumCount = (rows: QueryResultRow[], column: string): number =>
  rows.reduce((sum, row) => sum + numberFromDb(row[column] ?? 0), 0);

const cleanupTeamOutboxReplay = async (
  client: PoolClient,
  teamId: string
): Promise<CleanupResult> => {
  const result = await client.query<QueryResultRow>(
    `with
       deleted_stream_subscriptions as (
         delete from collaboration_stream_subscriptions
          where team_id = $1
          returning 1
       ),
       deleted_local_edge_subscriptions as (
         delete from local_edge_collaboration_subscriptions
          where team_id = $1
          returning 1
       ),
       deleted_outbox as (
         delete from collaboration_outbox
          where team_id = $1
          returning 1
       )
     select
       (select count(*) from deleted_stream_subscriptions)::bigint
       + (select count(*) from deleted_local_edge_subscriptions)::bigint
       + (select count(*) from deleted_outbox)::bigint as removed_count`,
    [teamId]
  );
  return {
    removedRecordCount: numberFromDb(result.rows[0]?.removed_count ?? 0),
    removedByteCount: 0
  };
};

const cleanupTeamEncryptedPayloads = async (
  client: PoolClient,
  teamId: string
): Promise<CleanupResult> => {
  const result = await client.query<QueryResultRow>(
    `with deleted_representation_chunks as (
       delete from team_memory_representation_chunks
        where team_id = $1
        returning
          length(ciphertext)::bigint
          + length(nonce)::bigint
          + length(tag)::bigint
          + length(wrapped_dek::text)::bigint as removed_bytes
     ),
     deleted_payloads as (
       delete from encrypted_field_payloads
        where team_id = $1
          and encryption_scope = 'team'
        returning
          length(ciphertext)::bigint
          + length(nonce)::bigint
          + length(tag)::bigint
          + length(wrapped_dek::text)::bigint as removed_bytes
     )
     select
       (
         (select count(*) from deleted_representation_chunks)
         + (select count(*) from deleted_payloads)
       )::bigint as removed_count,
       (
         coalesce((select sum(removed_bytes) from deleted_representation_chunks), 0)
         + coalesce((select sum(removed_bytes) from deleted_payloads), 0)
       )::bigint as removed_bytes`,
    [teamId]
  );
  return {
    removedRecordCount: numberFromDb(result.rows[0]?.removed_count ?? 0),
    removedByteCount: numberFromDb(result.rows[0]?.removed_bytes ?? 0)
  };
};

const cleanupTeamWrappedKeys = async (
  client: PoolClient,
  teamId: string
): Promise<CleanupResult> => {
  const result = await client.query<QueryResultRow>(
    `select (
       (select count(*)
          from encrypted_field_payloads
         where team_id = $1
           and encryption_scope = 'team'
           and wrapped_dek is not null
           and invalidated_at is null)
       +
       (select count(*)
          from team_memory_representation_chunks
         where team_id = $1
           and wrapped_dek is not null)
     )::bigint as remaining_count`,
    [teamId]
  );
  const remaining = numberFromDb(result.rows[0]?.remaining_count ?? 0);
  if (remaining > 0) {
    throw new Error("Team wrapped keys remain after encrypted payload purge");
  }
  return { removedRecordCount: 0, removedByteCount: 0 };
};

const cleanupTeamVectors = async (
  client: PoolClient,
  teamId: string
): Promise<CleanupResult> => {
  const removed384 = await client.query(
    `delete from memory_embeddings_384
        where memory_embedding_id in (
          select id from memory_embeddings
           where id in (
             select source_id from encrypted_field_payloads
              where source_table = 'memory_embeddings' and team_id = $1
           )
        )`,
    [teamId]
  );
  const removed1024 = await client.query(
    `delete from memory_embeddings_1024
        where memory_embedding_id in (
          select id from memory_embeddings
           where id in (
             select source_id from encrypted_field_payloads
              where source_table = 'memory_embeddings' and team_id = $1
           )
        )`,
    [teamId]
  );
  const removed1536 = await client.query(
    `delete from memory_embeddings_1536
        where memory_embedding_id in (
          select id from memory_embeddings
           where id in (
             select source_id from encrypted_field_payloads
              where source_table = 'memory_embeddings' and team_id = $1
           )
        )`,
    [teamId]
  );
  const removed3072 = await client.query(
    `delete from memory_embeddings_3072
        where memory_embedding_id in (
          select id from memory_embeddings
           where id in (
             select source_id from encrypted_field_payloads
              where source_table = 'memory_embeddings' and team_id = $1
           )
        )`,
    [teamId]
  );
  return {
    removedRecordCount:
      (removed384.rowCount ?? 0) +
      (removed1024.rowCount ?? 0) +
      (removed1536.rowCount ?? 0) +
      (removed3072.rowCount ?? 0),
    removedByteCount: 0
  };
};

const cleanupTeamSearchIndex = async (
  client: PoolClient,
  teamId: string,
  observedAt: Date
): Promise<CleanupResult> => {
  const representations = await client.query(
    `update team_memory_representations
          set state = 'purged',
              chunk_count = 0,
              tombstoned_at = coalesce(tombstoned_at, $2),
              purge_completed_at = $2,
              updated_at = $2
        where team_id = $1
          and state <> 'purged'`,
    [teamId, observedAt]
  );
  const shareGrants = await client.query(
    `update team_session_share_grants
          set lifecycle = 'purged',
              active_representation = null,
              tombstoned_at = coalesce(tombstoned_at, $2),
              purge_completed_at = $2,
              updated_at = $2
        where team_id = $1
          and lifecycle <> 'purged'`,
    [teamId, observedAt]
  );
  return {
    removedRecordCount:
      (representations.rowCount ?? 0) + (shareGrants.rowCount ?? 0),
    removedByteCount: 0
  };
};

const cleanupTeamDatabaseRows = async (
  client: PoolClient,
  teamId: string,
  observedAt: Date
): Promise<CleanupResult> => {
  const result = await client.query<QueryResultRow>(
    `with
       team_threads as (
         select id from collaboration_threads where team_id = $1
       ),
       deleted_read_states as (
         delete from collaboration_read_states
          where thread_id in (select id from team_threads)
          returning 1
       ),
       deleted_participants as (
         delete from collaboration_participants
          where team_id = $1
          returning 1
       ),
       deleted_messages as (
         delete from collaboration_messages
          where team_id = $1
          returning 1
       ),
       deleted_threads as (
         delete from collaboration_threads
          where team_id = $1
          returning 1
       ),
       updated_workspaces as (
         update team_workspaces
            set lifecycle = 'purged',
                purge_completed_at = $2,
                updated_at = $2
          where team_id = $1
            and lifecycle <> 'purged'
          returning 1
       )
     select
       (select count(*) from deleted_read_states)::bigint as read_states,
       (select count(*) from deleted_participants)::bigint as participants,
       (select count(*) from deleted_messages)::bigint as messages,
       (select count(*) from deleted_threads)::bigint as threads,
       (select count(*) from updated_workspaces)::bigint as workspaces`,
    [teamId, observedAt]
  );
  return {
    removedRecordCount:
      sumCount(result.rows, "read_states") +
      sumCount(result.rows, "participants") +
      sumCount(result.rows, "messages") +
      sumCount(result.rows, "threads") +
      sumCount(result.rows, "workspaces"),
    removedByteCount: 0
  };
};

type OwnerPrivateCleanupTarget = {
  ownerPrivateReplicaId: string;
  logicalMemoryId: string;
  ownerUserId: string;
  ownerPrincipalId: string;
  localSessionId: string;
};

const loadOwnerPrivateCleanupTarget = async (
  client: PoolClient,
  ownerPrivateReplicaId: string,
  logicalMemoryId: string
): Promise<OwnerPrivateCleanupTarget> => {
  const result = await client.query<
    QueryResultRow & {
      id: string;
      logical_memory_id: string;
      owner_user_id: string;
      owner_principal_id: string;
      local_session_id: string;
    }
  >(
    `select id, logical_memory_id, owner_user_id, owner_principal_id,
            local_session_id
       from memory_replicas
      where id = $1 and logical_memory_id = $2
        and replica_role = 'target'
        and encryption_scope = 'owner_private_replica'
        and owner_user_id is not null
        and owner_principal_id is not null
        and local_session_id is not null
      for update`,
    [ownerPrivateReplicaId, logicalMemoryId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Owner-private replica purge target not found");
  return {
    ownerPrivateReplicaId: row.id,
    logicalMemoryId: row.logical_memory_id,
    ownerUserId: row.owner_user_id,
    ownerPrincipalId: row.owner_principal_id,
    localSessionId: row.local_session_id
  };
};

const loadOwnerPrivateDerivedNodeIds = async (
  client: PoolClient,
  target: OwnerPrivateCleanupTarget
): Promise<string[]> => {
  const result = await client.query<{ id: string }>(
    `with recursive direct_nodes as (
       select node.id
         from memory_nodes node
        where node.session_id = $1
          and node.visibility = 'personal'
          and node.owner_user_id = $2
       union
       select source.memory_node_id
         from memory_node_sources source
         join memory_nodes node on node.id = source.memory_node_id
        where node.visibility = 'personal'
          and node.owner_user_id = $2
          and (
            source.memory_event_id in (
              select id from memory_events where session_id = $1
            )
            or source.message_id in (
              select id from messages where session_id = $1
            )
            or source.tool_event_id in (
              select id from tool_events where session_id = $1
            )
          )
     ), affected_nodes as (
       select id from direct_nodes
       union
       select child.parent_memory_node_id
         from memory_node_children child
         join affected_nodes affected
           on affected.id = child.child_memory_node_id
         join memory_nodes parent on parent.id = child.parent_memory_node_id
        where parent.visibility = 'personal'
          and parent.owner_user_id = $2
     )
     select id from affected_nodes order by id`,
    [target.localSessionId, target.ownerUserId]
  );
  return result.rows.map((row) => row.id);
};

const cleanupOwnerPrivateOutboxReplay = async (
  client: PoolClient,
  target: OwnerPrivateCleanupTarget
): Promise<CleanupResult> => {
  const result = await client.query<QueryResultRow>(
    `with
       target_relationships as materialized (
         select id from cross_identity_sync_relationships
          where local_replica_id = $1 and logical_memory_id = $2
       ),
       target_uploads as materialized (
         select id from sync_package_upload_sessions
          where sync_relationship_id in (select id from target_relationships)
       ),
       deleted_outbox as (
         delete from sync_outbox_entries
          where sync_relationship_id in (select id from target_relationships)
          returning 1
       ),
       deleted_inbox as (
         delete from sync_inbox_entries
          where sync_relationship_id in (select id from target_relationships)
          returning 1
       ),
       deleted_chunks as (
         delete from sync_package_chunks
          where upload_session_id in (select id from target_uploads)
          returning byte_count
       ),
       deleted_uploads as (
         delete from sync_package_upload_sessions
          where id in (select id from target_uploads)
          returning 1
       ),
       deleted_replay as (
         delete from sync_semantic_changes where session_id = $3 returning 1
       )
     select (
       (select count(*) from deleted_outbox)
       + (select count(*) from deleted_inbox)
       + (select count(*) from deleted_chunks)
       + (select count(*) from deleted_uploads)
       + (select count(*) from deleted_replay)
     )::bigint as removed_count,
     coalesce((select sum(byte_count) from deleted_chunks), 0)::bigint
       as removed_bytes`,
    [
      target.ownerPrivateReplicaId,
      target.logicalMemoryId,
      target.localSessionId
    ]
  );
  return {
    removedRecordCount: numberFromDb(result.rows[0]?.removed_count ?? 0),
    removedByteCount: numberFromDb(result.rows[0]?.removed_bytes ?? 0)
  };
};

const ownerPrivatePayloadDeleteSql = `with
  target as materialized (
    select id, logical_memory_id, owner_user_id, owner_principal_id,
           local_session_id
      from memory_replicas
     where id = $1 and logical_memory_id = $2
       and replica_role = 'target'
       and encryption_scope = 'owner_private_replica'
  ),
  target_relationships as materialized (
    select id from cross_identity_sync_relationships
     where local_replica_id = $1 and logical_memory_id = $2
  ),
  target_source_ids as materialized (
    select 'conversation_items'::text as source_table, id as source_id
      from conversation_items where session_id = (select local_session_id from target)
    union all
    select 'conversation_item_observations', id
      from conversation_item_observations
     where session_id = (select local_session_id from target)
    union all
    select 'memory_events', id from memory_events
     where session_id = (select local_session_id from target)
    union all
    select 'memory_nodes', id from memory_nodes
     where id = any($3::uuid[])
    union all
    select 'messages', id from messages
     where session_id = (select local_session_id from target)
    union all
    select 'tool_events', id from tool_events
     where session_id = (select local_session_id from target)
    union all
    select 'memory_embeddings', e.id from memory_embeddings e
     where e.memory_event_id in (
       select id from memory_events
        where session_id = (select local_session_id from target)
     ) or e.memory_node_id = any($3::uuid[])
       or e.message_id in (
       select id from messages
        where session_id = (select local_session_id from target)
     )
    union all
    select 'shared_source_artifacts', id from shared_source_artifacts
     where remote_replica_id = $1
    union all
    select 'shared_source_previews', id from shared_source_previews
     where remote_replica_id = $1
    union all
    select 'memory_replica_revisions', $1::uuid
  ),
  deleted as (
    delete from encrypted_field_payloads payload
     using target
     where payload.encryption_scope = 'owner_private_replica'
       and payload.owner_user_id = target.owner_user_id
       and payload.owner_principal_id = target.owner_principal_id
       and (
         (payload.source_table, payload.source_id) in (
           select source_table, source_id from target_source_ids
         )
         or payload.aad ->> 'syncRelationshipId' in (
           select id::text from target_relationships
         )
       )
     returning length(ciphertext)::bigint + length(nonce)::bigint
       + length(tag)::bigint + length(wrapped_dek::text)::bigint
       as removed_bytes
  )
select count(*)::bigint as removed_count,
       coalesce(sum(removed_bytes), 0)::bigint as removed_bytes
  from deleted`;

const cleanupOwnerPrivateEncryptedPayloads = async (
  client: PoolClient,
  target: OwnerPrivateCleanupTarget
): Promise<CleanupResult> => {
  const derivedNodeIds = await loadOwnerPrivateDerivedNodeIds(client, target);
  const result = await client.query<QueryResultRow>(
    ownerPrivatePayloadDeleteSql,
    [target.ownerPrivateReplicaId, target.logicalMemoryId, derivedNodeIds]
  );
  return {
    removedRecordCount: numberFromDb(result.rows[0]?.removed_count ?? 0),
    removedByteCount: numberFromDb(result.rows[0]?.removed_bytes ?? 0)
  };
};

const cleanupOwnerPrivateWrappedKeys = async (
  client: PoolClient,
  target: OwnerPrivateCleanupTarget
): Promise<CleanupResult> => {
  const retriedCleanup = await cleanupOwnerPrivateEncryptedPayloads(
    client,
    target
  );
  const packages = await client.query<QueryResultRow>(
    `select count(*)::bigint as remaining_count
       from sync_package_chunks chunk
       join sync_package_upload_sessions upload
         on upload.id = chunk.upload_session_id
       join cross_identity_sync_relationships relationship
         on relationship.id = upload.sync_relationship_id
      where relationship.local_replica_id = $1
        and relationship.logical_memory_id = $2`,
    [target.ownerPrivateReplicaId, target.logicalMemoryId]
  );
  if (numberFromDb(packages.rows[0]?.remaining_count ?? 0) > 0) {
    throw new Error("Owner-private wrapped package keys remain after purge");
  }
  return retriedCleanup;
};

const ownerPrivateEmbeddingIdsSql = `select embedding.id
  from memory_embeddings embedding
 where embedding.memory_event_id in (
   select id from memory_events where session_id = $1
 ) or embedding.memory_node_id = any($2::uuid[])
    or embedding.message_id in (
   select id from messages where session_id = $1
 )`;

const cleanupOwnerPrivateVectors = async (
  client: PoolClient,
  target: OwnerPrivateCleanupTarget
): Promise<CleanupResult> => {
  const derivedNodeIds = await loadOwnerPrivateDerivedNodeIds(client, target);
  let removedRecordCount = 0;
  for (const table of [
    "memory_embeddings_384",
    "memory_embeddings_1024",
    "memory_embeddings_1536",
    "memory_embeddings_3072"
  ]) {
    const removed = await client.query(
      `delete from ${table}
        where memory_embedding_id in (${ownerPrivateEmbeddingIdsSql})`,
      [target.localSessionId, derivedNodeIds]
    );
    removedRecordCount += removed.rowCount ?? 0;
  }
  return { removedRecordCount, removedByteCount: 0 };
};

const cleanupOwnerPrivateSearchIndex = async (
  client: PoolClient,
  target: OwnerPrivateCleanupTarget
): Promise<CleanupResult> => {
  const derivedNodeIds = await loadOwnerPrivateDerivedNodeIds(client, target);
  const result = await client.query<QueryResultRow>(
    `with
       target_events as materialized (
         select id from memory_events where session_id = $1
       ),
       target_nodes as materialized (
         select unnest($2::uuid[]) as id
       ),
       target_messages as materialized (
         select id from messages where session_id = $1
       ),
       deleted_local_jobs as (
         delete from local_work_queue
          where queue_name in ('memory-embed', 'lcm-embed')
            and data ->> 'sourceId' in (
              select id::text from target_events
              union all select id::text from target_nodes
              union all select id::text from target_messages
            )
          returning 1
       ),
       deleted_rebuild_jobs as (
         delete from semantic_memory_rebuild_jobs
          where memory_event_id in (select id from target_events)
          returning 1
       ),
       deleted_embeddings as (
         delete from memory_embeddings
          where memory_event_id in (select id from target_events)
             or memory_node_id in (select id from target_nodes)
             or message_id in (select id from target_messages)
          returning 1
       )
     select (
       (select count(*) from deleted_local_jobs)
       + (select count(*) from deleted_rebuild_jobs)
       + (select count(*) from deleted_embeddings)
     )::bigint as removed_count`,
    [target.localSessionId, derivedNodeIds]
  );
  return {
    removedRecordCount: numberFromDb(result.rows[0]?.removed_count ?? 0),
    removedByteCount: 0
  };
};

const cleanupOwnerPrivateDatabaseRows = async (
  client: PoolClient,
  target: OwnerPrivateCleanupTarget,
  observedAt: Date
): Promise<CleanupResult> => {
  const derivedNodeIds = await loadOwnerPrivateDerivedNodeIds(client, target);
  const relationshipIds = await client.query<{ id: string }>(
    `select id from cross_identity_sync_relationships
      where local_replica_id=$1 and logical_memory_id=$2`,
    [target.ownerPrivateReplicaId, target.logicalMemoryId]
  );
  const relationshipIdValues = relationshipIds.rows.map((row) => row.id);
  let removedRecordCount = 0;
  if (relationshipIdValues.length > 0) {
    removedRecordCount +=
      (
        await client.query(
          `delete from sync_summary_node_mappings
            where sync_relationship_id=any($1::uuid[])`,
          [relationshipIdValues]
        )
      ).rowCount ?? 0;
    removedRecordCount +=
      (
        await client.query(
          `delete from sync_event_mappings
            where sync_relationship_id=any($1::uuid[])`,
          [relationshipIdValues]
        )
      ).rowCount ?? 0;
  }
  const deleteSessionRows = async (table: string): Promise<void> => {
    const result = await client.query(
      `delete from ${table} where session_id=$1`,
      [target.localSessionId]
    );
    removedRecordCount += result.rowCount ?? 0;
  };
  await deleteSessionRows("sync_semantic_changes");
  // Delete in restrictive-FK dependency order. Data-modifying CTEs do not
  // provide ordering guarantees between sibling deletes.
  const deletedNodes = await client.query(
    "delete from memory_nodes where id = any($1::uuid[])",
    [derivedNodeIds]
  );
  removedRecordCount += deletedNodes.rowCount ?? 0;
  await deleteSessionRows("memory_events");
  await deleteSessionRows("conversation_item_observations");
  await deleteSessionRows("conversation_items");
  await deleteSessionRows("tool_events");
  await deleteSessionRows("messages");
  // Deleting synchronized Memory Events emits a final semantic-change
  // tombstone. Sweep after the source-row statement so trigger-generated
  // replay state cannot outlive the replica purge.
  const triggerReplay = await client.query(
    "delete from sync_semantic_changes where session_id = $1",
    [target.localSessionId]
  );

  const references = await client.query<QueryResultRow>(
    `select (
       exists(select 1 from team_session_share_grants where remote_replica_id = $1)
       or exists(select 1 from shared_source_artifacts where remote_replica_id = $1)
       or exists(select 1 from shared_source_previews where remote_replica_id = $1)
       or exists(select 1 from source_owner_representation_consents where remote_replica_id = $1)
     ) as retained_by_team`,
    [target.ownerPrivateReplicaId]
  );
  const retainedByTeam = references.rows[0]?.retained_by_team === true;

  await client.query(
    `update cross_identity_sync_relationships
        set state = 'revoked', paused_at = null, state_before_pause = null,
            policy_manifest = '{}'::jsonb, consent_manifest = '{}'::jsonb,
            last_package_id = null, failed_at = null, last_error_class = null,
            revoked_at = coalesce(revoked_at, $3),
            revocation_reason = 'owner_private_replica_purged',
            updated_at = $3
      where local_replica_id = $1 and logical_memory_id = $2`,
    [target.ownerPrivateReplicaId, target.logicalMemoryId, observedAt]
  );

  if (!retainedByTeam) {
    await client.query(
      `delete from cross_identity_sync_relationships
        where local_replica_id = $1 and logical_memory_id = $2`,
      [target.ownerPrivateReplicaId, target.logicalMemoryId]
    );
  }

  await client.query(
    `update memory_replicas
        set lifecycle = 'purged',
            freshness_status = 'revoked',
            tombstoned_at = coalesce(tombstoned_at, $2),
            retain_until = coalesce(retain_until, $2),
            purge_completed_at = $2,
            updated_at = $2
      where id = $1`,
    [target.ownerPrivateReplicaId, observedAt]
  );
  if (!retainedByTeam) {
    await client.query(
      `update logical_memories logical
          set lifecycle = 'purged',
              tombstoned_at = coalesce(tombstoned_at, $2),
              retain_until = coalesce(retain_until, $2),
              purge_completed_at = $2,
              updated_at = $2
        where logical.id = $1
          and not exists (
            select 1 from memory_replicas replica
             where replica.logical_memory_id = logical.id
               and replica.lifecycle <> 'purged'
          )
          and not exists (
            select 1 from team_session_share_grants grant_row
             where grant_row.logical_memory_id = logical.id
          )`,
      [target.logicalMemoryId, observedAt]
    );
  }
  await client.query(
    `update sessions
        set external_session_id = null, metadata = '{}'::jsonb,
            updated_at = $2
      where id = $1`,
    [target.localSessionId, observedAt]
  );

  return {
    removedRecordCount: removedRecordCount + (triggerReplay.rowCount ?? 0),
    removedByteCount: 0
  };
};

const cleanupOwnerPrivateArtifact = async (
  client: PoolClient,
  input: {
    target: OwnerPrivateCleanupTarget;
    artifactKind: PurgeArtifactKind;
    observedAt: Date;
    backupExpiresAt: Date;
  }
): Promise<
  CleanupResult & {
    state: Exclude<PurgeEvidenceState, "pending" | "failed">;
    backupExpiresAt?: Date | null;
  }
> => {
  switch (input.artifactKind) {
    case "outbox_replay":
      return {
        state: "verified",
        ...(await cleanupOwnerPrivateOutboxReplay(client, input.target))
      };
    case "vector":
      return {
        state: "verified",
        ...(await cleanupOwnerPrivateVectors(client, input.target))
      };
    case "encrypted_payload":
      return {
        state: "verified",
        ...(await cleanupOwnerPrivateEncryptedPayloads(client, input.target))
      };
    case "wrapped_key":
      return {
        state: "verified",
        ...(await cleanupOwnerPrivateWrappedKeys(client, input.target))
      };
    case "search_index":
      return {
        state: "verified",
        ...(await cleanupOwnerPrivateSearchIndex(client, input.target))
      };
    case "database_row":
      return {
        state: "verified",
        ...(await cleanupOwnerPrivateDatabaseRows(
          client,
          input.target,
          input.observedAt
        ))
      };
    case "backup_copy":
      return {
        state: "scheduled_expiry",
        removedRecordCount: 0,
        removedByteCount: 0,
        backupExpiresAt: input.backupExpiresAt
      };
  }
};

const cleanupTeamArtifact = async (
  client: PoolClient,
  input: {
    teamId: string;
    artifactKind: PurgeArtifactKind;
    observedAt: Date;
    backupExpiresAt: Date;
  }
): Promise<
  CleanupResult & {
    state: Exclude<PurgeEvidenceState, "pending" | "failed">;
    backupExpiresAt?: Date | null;
  }
> => {
  switch (input.artifactKind) {
    case "outbox_replay":
      return {
        state: "verified",
        ...(await cleanupTeamOutboxReplay(client, input.teamId))
      };
    case "encrypted_payload":
      return {
        state: "verified",
        ...(await cleanupTeamEncryptedPayloads(client, input.teamId))
      };
    case "wrapped_key":
      return {
        state: "verified",
        ...(await cleanupTeamWrappedKeys(client, input.teamId))
      };
    case "vector":
      return {
        state: "verified",
        ...(await cleanupTeamVectors(client, input.teamId))
      };
    case "search_index":
      return {
        state: "verified",
        ...(await cleanupTeamSearchIndex(
          client,
          input.teamId,
          input.observedAt
        ))
      };
    case "database_row":
      return {
        state: "verified",
        ...(await cleanupTeamDatabaseRows(
          client,
          input.teamId,
          input.observedAt
        ))
      };
    case "backup_copy":
      return {
        state: "scheduled_expiry",
        removedRecordCount: 0,
        removedByteCount: 0,
        backupExpiresAt: input.backupExpiresAt
      };
  }
};

const markShareGrantPurgePending = async (
  client: PoolClient,
  target: Extract<RetentionDecisionTarget, { kind: "share_grant" }>,
  observedAt: Date
): Promise<void> => {
  const grant = await client.query(
    `update team_session_share_grants
        set lifecycle = 'purge_pending',
            tombstoned_at = coalesce(tombstoned_at, $2),
            updated_at = $2
      where id = $1 and lifecycle = 'revoked'
      returning id`,
    [target.shareGrantId, observedAt]
  );
  if (!grant.rowCount) {
    const current = await client.query<{ lifecycle: string }>(
      "select lifecycle from team_session_share_grants where id = $1",
      [target.shareGrantId]
    );
    if (current.rows[0]?.lifecycle !== "purge_pending") {
      throw new Error("Share Grant is not eligible to enter purge");
    }
  }
  await client.query(
    `update team_memory_representations
        set state = 'purge_pending',
            tombstoned_at = coalesce(tombstoned_at, $2),
            updated_at = $2
      where share_grant_id = $1 and state <> 'purged'`,
    [target.shareGrantId, observedAt]
  );
  await client.query(
    `update collaboration_threads
        set lifecycle = 'purge_pending', archived_at = null,
            tombstoned_at = coalesce(tombstoned_at, $2),
            version = version + 1, updated_at = $2
      where share_grant_id = $1
        and kind = 'shared_session_discussion'
        and lifecycle not in ('purge_pending', 'purged')`,
    [target.shareGrantId, observedAt]
  );
};

const cleanupShareGrantOutboxReplay = async (
  client: PoolClient,
  shareGrantId: string
): Promise<CleanupResult> => {
  const targetPredicate = `share_grant_id = $1
    or thread_id in (
      select id from collaboration_threads
       where share_grant_id = $1
         and kind = 'shared_session_discussion'
    )
    or (resource_type = 'team_memory_representation' and resource_id in (
      select id from team_memory_representations where share_grant_id = $1
    ))`;
  const reset = await client.query(
    `update collaboration_stream_subscriptions
        set acknowledged_event_id = null, acknowledged_cursor = 0,
            snapshot_high_water_cursor = null, updated_at = now()
      where acknowledged_event_id in (
        select id from collaboration_outbox where ${targetPredicate}
      )
      returning id`,
    [shareGrantId]
  );
  const removed = await client.query(
    `delete from collaboration_outbox where ${targetPredicate} returning id`,
    [shareGrantId]
  );
  return {
    removedRecordCount: (reset.rowCount ?? 0) + (removed.rowCount ?? 0),
    removedByteCount: 0
  };
};

const cleanupShareGrantEncryptedPayloads = async (
  client: PoolClient,
  target: Extract<RetentionDecisionTarget, { kind: "share_grant" }>
): Promise<CleanupResult> => {
  const result = await client.query<QueryResultRow>(
    `with target_threads as materialized (
       select id from collaboration_threads
        where share_grant_id = $1
          and kind = 'shared_session_discussion'
          and team_id = $2 and team_workspace_id = $3
     ),
     target_messages as materialized (
       select id from collaboration_messages
        where thread_id in (select id from target_threads)
     ),
     target_representations as materialized (
       select id from team_memory_representations
        where share_grant_id = $1
          and team_id = $2 and team_workspace_id = $3
     ),
     deleted_chunks as (
       delete from team_memory_representation_chunks
        where share_grant_id = $1
          and team_id = $2 and team_workspace_id = $3
        returning length(ciphertext)::bigint + length(nonce)::bigint
          + length(tag)::bigint + length(wrapped_dek::text)::bigint
          as removed_bytes
     ),
     deleted_payloads as (
       delete from encrypted_field_payloads
        where encryption_scope = 'team'
          and team_id = $2 and team_workspace_id = $3
          and (
            (source_table = 'collaboration_threads'
              and source_id in (select id from target_threads))
            or (source_table = 'collaboration_messages'
              and source_id in (select id from target_messages))
            or (source_table = 'team_memory_representations'
              and source_id in (select id from target_representations))
          )
        returning length(ciphertext)::bigint + length(nonce)::bigint
          + length(tag)::bigint + length(wrapped_dek::text)::bigint
          as removed_bytes
     )
     select
       ((select count(*) from deleted_chunks)
        + (select count(*) from deleted_payloads))::bigint as removed_count,
       (coalesce((select sum(removed_bytes) from deleted_chunks), 0)
        + coalesce((select sum(removed_bytes) from deleted_payloads), 0))::bigint
        as removed_bytes`,
    [target.shareGrantId, target.teamId, target.teamWorkspaceId]
  );
  return {
    removedRecordCount: numberFromDb(result.rows[0]?.removed_count ?? 0),
    removedByteCount: numberFromDb(result.rows[0]?.removed_bytes ?? 0)
  };
};

const cleanupShareGrantWrappedKeys = async (
  client: PoolClient,
  target: Extract<RetentionDecisionTarget, { kind: "share_grant" }>
): Promise<CleanupResult> => {
  const remaining = await client.query<QueryResultRow>(
    `select (
       (select count(*) from team_memory_representation_chunks
         where share_grant_id = $1)
       +
       (select count(*) from encrypted_field_payloads payload
         where payload.encryption_scope = 'team'
           and payload.team_id = $2 and payload.team_workspace_id = $3
           and (
             (payload.source_table = 'collaboration_threads' and exists (
               select 1 from collaboration_threads thread
                where thread.id = payload.source_id
                  and thread.share_grant_id = $1
             ))
             or (payload.source_table = 'collaboration_messages' and exists (
               select 1 from collaboration_messages message
               join collaboration_threads thread on thread.id = message.thread_id
                where message.id = payload.source_id
                  and thread.share_grant_id = $1
             ))
             or (payload.source_table = 'team_memory_representations' and exists (
               select 1 from team_memory_representations representation
                where representation.id = payload.source_id
                  and representation.share_grant_id = $1
             ))
           ))
     )::bigint as remaining_count`,
    [target.shareGrantId, target.teamId, target.teamWorkspaceId]
  );
  if (numberFromDb(remaining.rows[0]?.remaining_count ?? 0) > 0) {
    throw new Error("Share Grant wrapped keys remain after payload purge");
  }
  return { removedRecordCount: 0, removedByteCount: 0 };
};

const cleanupShareGrantDatabaseRows = async (
  client: PoolClient,
  target: Extract<RetentionDecisionTarget, { kind: "share_grant" }>,
  observedAt: Date
): Promise<CleanupResult> => {
  const targetThreads = `select id from collaboration_threads
    where share_grant_id = $1 and kind = 'shared_session_discussion'
      and team_id = $2 and team_workspace_id = $3`;
  const counts: number[] = [];
  for (const table of [
    "collaboration_read_states",
    "collaboration_participants",
    "collaboration_messages"
  ] as const) {
    const removed = await client.query(
      `delete from ${table}
        where thread_id in (${targetThreads})
        returning 1`,
      [target.shareGrantId, target.teamId, target.teamWorkspaceId]
    );
    counts.push(removed.rowCount ?? 0);
  }
  const threads = await client.query(
    `update collaboration_threads
        set lifecycle = 'purged', archived_at = null,
            tombstoned_at = coalesce(tombstoned_at, $4),
            purge_completed_at = $4, version = version + 1,
            next_sequence = 1, last_activity_at = $4, updated_at = $4
      where id in (${targetThreads}) and lifecycle <> 'purged'
      returning id`,
    [target.shareGrantId, target.teamId, target.teamWorkspaceId, observedAt]
  );
  const representations = await client.query(
    `update team_memory_representations
        set state = 'purged', chunk_count = 0,
            tombstoned_at = coalesce(tombstoned_at, $4),
            purge_completed_at = $4, updated_at = $4
      where share_grant_id = $1
        and team_id = $2 and team_workspace_id = $3
        and state <> 'purged'
      returning id`,
    [target.shareGrantId, target.teamId, target.teamWorkspaceId, observedAt]
  );
  const grants = await client.query(
    `update team_session_share_grants
        set lifecycle = 'purged', active_representation = null,
            active_retention_decision_id = null, active_purge_job_id = null,
            tombstoned_at = coalesce(tombstoned_at, $4),
            purge_completed_at = $4, updated_at = $4
      where id = $1 and team_id = $2 and team_workspace_id = $3
        and lifecycle <> 'purged'
      returning id`,
    [target.shareGrantId, target.teamId, target.teamWorkspaceId, observedAt]
  );
  return {
    removedRecordCount:
      counts.reduce((total, count) => total + count, 0) +
      (threads.rowCount ?? 0) +
      (representations.rowCount ?? 0) +
      (grants.rowCount ?? 0),
    removedByteCount: 0
  };
};

const cleanupShareGrantArtifact = async (
  client: PoolClient,
  input: {
    target: Extract<RetentionDecisionTarget, { kind: "share_grant" }>;
    artifactKind: PurgeArtifactKind;
    observedAt: Date;
    backupExpiresAt: Date;
  }
): Promise<
  CleanupResult & {
    state: Exclude<PurgeEvidenceState, "pending" | "failed">;
    backupExpiresAt?: Date | null;
  }
> => {
  switch (input.artifactKind) {
    case "outbox_replay":
      return {
        state: "verified",
        ...(await cleanupShareGrantOutboxReplay(
          client,
          input.target.shareGrantId
        ))
      };
    case "vector":
    case "search_index":
      return {
        state: "not_applicable",
        removedRecordCount: 0,
        removedByteCount: 0
      };
    case "encrypted_payload":
      return {
        state: "verified",
        ...(await cleanupShareGrantEncryptedPayloads(client, input.target))
      };
    case "wrapped_key":
      return {
        state: "verified",
        ...(await cleanupShareGrantWrappedKeys(client, input.target))
      };
    case "database_row":
      return {
        state: "verified",
        ...(await cleanupShareGrantDatabaseRows(
          client,
          input.target,
          input.observedAt
        ))
      };
    case "backup_copy":
      return {
        state: "scheduled_expiry",
        removedRecordCount: 0,
        removedByteCount: 0,
        backupExpiresAt: input.backupExpiresAt
      };
  }
};

const purgeTargetStrategies = createPurgeTargetStrategies({
  teamArtifacts: teamDeletionArtifacts,
  shareGrantArtifacts,
  ownerPrivateReplicaArtifacts,
  prepareShareGrantForClaim: markShareGrantPurgePending,
  cleanupTeamArtifact: (client, input) =>
    cleanupTeamArtifact(client, {
      teamId: input.target.teamId,
      artifactKind: input.artifactKind,
      observedAt: input.observedAt,
      backupExpiresAt: input.backupExpiresAt
    }),
  cleanupShareGrantArtifact,
  cleanupOwnerPrivateArtifact: async (client, input) => {
    const cleanupTarget = await loadOwnerPrivateCleanupTarget(
      client,
      input.target.ownerPrivateReplicaId,
      input.target.logicalMemoryId
    );
    return cleanupOwnerPrivateArtifact(client, {
      target: cleanupTarget,
      artifactKind: input.artifactKind,
      observedAt: input.observedAt,
      backupExpiresAt: input.backupExpiresAt
    });
  }
});

const isExecutablePurgeTarget = (
  target: RetentionDecisionTarget
): target is ExecutablePurgeTarget =>
  target.kind === "team" ||
  target.kind === "share_grant" ||
  target.kind === "owner_private_replica";

const executablePurgeTarget = (
  target: RetentionDecisionTarget
): ExecutablePurgeTarget => {
  if (!isExecutablePurgeTarget(target)) {
    throw new Error(
      "Only root Team, Share Grant, and owner-private replica purge jobs can be processed here"
    );
  }
  return target;
};

export const createRetentionLifecycleRepository = (
  pool: Pool,
  options: RetentionLifecycleRepositoryOptions
): RetentionLifecycleRepository => {
  if (typeof options.authorizeHoldActor !== "function") {
    throw new Error("A legal hold lifecycle authorizer is required");
  }
  const clock = options.clock ?? (() => new Date());
  const freshAuthenticationMaxAgeMs =
    options.freshAuthenticationMaxAgeMs ?? defaultFreshAuthenticationMaxAgeMs;
  const blockedHoldRecheckMs =
    options.blockedHoldRecheckMs ?? defaultBlockedHoldRecheckMs;
  const staleRunningAttemptMs =
    options.staleRunningAttemptMs ?? defaultStaleRunningAttemptMs;
  requirePositiveInteger(
    "Fresh authentication maximum age",
    freshAuthenticationMaxAgeMs
  );
  requirePositiveInteger("Blocked hold recheck delay", blockedHoldRecheckMs);
  requirePositiveInteger("Stale attempt timeout", staleRunningAttemptMs);

  const insertPolicy = async (
    client: PoolClient,
    input: {
      policyId: string;
      version: number;
      target: RetentionPolicyTarget;
      retentionSeconds: number;
      deletionGraceSeconds: number;
      backupRetentionSeconds: number;
      effectiveAt: Date;
      createdByUserId: string | null;
    }
  ): Promise<RetentionPolicyRecord> => {
    const fields = policyTargetFields(input.target);
    const policyHash = snapshotHash({
      policyId: input.policyId,
      version: input.version,
      target: input.target,
      retentionSeconds: input.retentionSeconds,
      deletionGraceSeconds: input.deletionGraceSeconds,
      backupRetentionSeconds: input.backupRetentionSeconds,
      effectiveAt: input.effectiveAt
    });
    const result = await client.query<PolicyRow>(
      `insert into retention_policies (
         policy_id, version, scope, team_id, team_workspace_id, share_grant_id,
         thread_id, owner_private_replica_id, logical_memory_id,
         retention_seconds, deletion_grace_seconds, backup_retention_seconds,
         policy_hash, created_by_user_id, effective_at
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15
       ) returning *`,
      [
        input.policyId,
        input.version,
        input.target.scope,
        fields.teamId,
        fields.teamWorkspaceId,
        fields.shareGrantId,
        fields.threadId,
        fields.ownerPrivateReplicaId,
        fields.logicalMemoryId,
        input.retentionSeconds,
        input.deletionGraceSeconds,
        input.backupRetentionSeconds,
        policyHash,
        input.createdByUserId,
        input.effectiveAt
      ]
    );
    return mapPolicy(result.rows[0]!);
  };

  const loadShorteningAffectedScopes = async (
    client: PoolClient,
    input: {
      policy: PolicyRow;
      previewedAt: Date;
      graceUntil: Date;
    }
  ): Promise<RetentionPolicyShorteningAffectedScope[]> => {
    const durationSeconds =
      numberFromDb(input.policy.retention_seconds) +
      numberFromDb(input.policy.deletion_grace_seconds);
    const decisions = await client.query<DecisionRow>(
      `select decision.*
         from retention_decisions decision
        where decision.policy_id = $1
          and decision.policy_version < $2
          and decision.retain_until > $3
          and not exists (
            select 1 from purge_jobs job
             where job.retention_decision_id = decision.id
               and job.state in ('running', 'failed', 'verified')
          )
          and not exists (
            select 1 from retention_policy_shortening_migrations migration
             where migration.previous_retention_decision_id = decision.id
          )
        order by decision.id
        for share of decision`,
      [input.policy.policy_id, input.policy.version, input.previewedAt]
    );
    const affectedScopes: RetentionPolicyShorteningAffectedScope[] = [];
    for (const decision of decisions.rows) {
      const target = targetFromDecisionRow(decision);
      const policyTarget = targetFromPolicyRow(input.policy);
      if (!policyAppliesToTarget(policyTarget, target)) continue;
      const policyDeadlineMs =
        decision.triggered_at.getTime() + durationSeconds * 1_000;
      if (!Number.isSafeInteger(policyDeadlineMs)) {
        throw new Error(
          "Shortened retention deadline exceeds the supported range"
        );
      }
      const shortenedRetainUntil = new Date(
        Math.max(policyDeadlineMs, input.graceUntil.getTime())
      );
      requireValidDate("Shortened retention deadline", shortenedRetainUntil);
      if (shortenedRetainUntil >= decision.retain_until) continue;
      const holds = await activeHoldsForTarget(client, target);
      affectedScopes.push(
        shorteningAffectedScopeSnapshot(
          decision,
          shortenedRetainUntil,
          holds.map((hold) => hold.id).sort()
        )
      );
    }
    return affectedScopes;
  };

  return {
    async createPolicy(input) {
      validatePolicyTarget(input.target);
      requireValidDate("Policy effective timestamp", input.effectiveAt);
      const deletionGraceSeconds = input.deletionGraceSeconds ?? 0;
      const backupRetentionSeconds = input.backupRetentionSeconds ?? 0;
      requireNonNegativeInteger("Retention seconds", input.retentionSeconds);
      requireNonNegativeInteger("Deletion grace seconds", deletionGraceSeconds);
      requireNonNegativeInteger(
        "Backup retention seconds",
        backupRetentionSeconds
      );
      const policyId = randomUUID();
      return withTransaction(pool, async (client) => {
        await lockScopeKeys(client, scopeKeysForPolicyTarget(input.target));
        const fields = policyTargetFields(input.target);
        const existing = await client.query(
          `select id from retention_policies
             where scope = $1
               and coalesce(team_id, $7::uuid) = coalesce($2::uuid, $7::uuid)
               and coalesce(team_workspace_id, $7::uuid) = coalesce($3::uuid, $7::uuid)
               and coalesce(share_grant_id, $7::uuid) = coalesce($4::uuid, $7::uuid)
               and coalesce(thread_id, $7::uuid) = coalesce($5::uuid, $7::uuid)
               and coalesce(owner_private_replica_id, $7::uuid) = coalesce($6::uuid, $7::uuid)
               and superseded_at is null
             for update`,
          [
            input.target.scope,
            fields.teamId,
            fields.teamWorkspaceId,
            fields.shareGrantId,
            fields.threadId,
            fields.ownerPrivateReplicaId,
            nilUuid
          ]
        );
        if (existing.rowCount) {
          throw new Error(
            "An active retention policy already exists for this scope"
          );
        }
        return insertPolicy(client, {
          policyId,
          version: 1,
          target: input.target,
          retentionSeconds: input.retentionSeconds,
          deletionGraceSeconds,
          backupRetentionSeconds,
          effectiveAt: input.effectiveAt,
          createdByUserId: input.createdByUserId ?? null
        });
      });
    },

    async versionPolicy(input) {
      requireNonEmpty("Policy ID", input.policyId);
      requireValidDate("Policy effective timestamp", input.effectiveAt);
      const deletionGraceSeconds = input.deletionGraceSeconds ?? 0;
      const backupRetentionSeconds = input.backupRetentionSeconds ?? 0;
      requireNonNegativeInteger("Retention seconds", input.retentionSeconds);
      requireNonNegativeInteger("Deletion grace seconds", deletionGraceSeconds);
      requireNonNegativeInteger(
        "Backup retention seconds",
        backupRetentionSeconds
      );
      if (input.effectiveAt.getTime() < clock().getTime()) {
        throw new Error("A new policy version must take effect prospectively");
      }
      return withTransaction(pool, async (client) => {
        await lockPolicyScope(client, input.policyId);
        const policies = await client.query<PolicyRow>(
          `select * from retention_policies
             where policy_id = $1
             order by version desc
             for update`,
          [input.policyId]
        );
        const latest = policies.rows[0];
        if (!latest) throw new Error("Retention policy not found");
        if (latest.superseded_at) {
          throw new Error("Retention policy family has no current version");
        }
        if (input.effectiveAt <= latest.effective_at) {
          throw new Error("Policy version effective time must advance");
        }
        const target = targetFromPolicyRow(latest);
        await ensureTeamPolicyManager(
          client,
          input.actorUserId,
          target,
          input.expectedTeamId ??
            (target.scope === "owner_private_replica" ? "" : target.teamId)
        );
        await client.query(
          `update retention_policies
             set superseded_at = $2
             where id = $1 and superseded_at is null`,
          [latest.id, input.effectiveAt]
        );
        return insertPolicy(client, {
          policyId: input.policyId,
          version: latest.version + 1,
          target,
          retentionSeconds: input.retentionSeconds,
          deletionGraceSeconds,
          backupRetentionSeconds,
          effectiveAt: input.effectiveAt,
          createdByUserId: input.actorUserId
        });
      });
    },

    async previewPolicyShortening(input) {
      requireNonEmpty("Policy ID", input.policyId);
      requirePositiveInteger("Policy version", input.policyVersion);
      requirePositiveInteger(
        "Policy shortening grace seconds",
        input.graceSeconds
      );
      return withTransaction(pool, async (client) => {
        await lockPolicyScope(client, input.policyId);
        const policies = await client.query<PolicyRow>(
          `select * from retention_policies
            where policy_id = $1
            order by version desc
            for update`,
          [input.policyId]
        );
        const policy = policies.rows.find(
          (candidate) => candidate.version === input.policyVersion
        );
        const previous = policies.rows.find(
          (candidate) => candidate.version === input.policyVersion - 1
        );
        if (!policy || !previous || policies.rows[0]?.id !== policy.id) {
          throw new Error(
            "Policy shortening preview requires the current policy version"
          );
        }
        const target = targetFromPolicyRow(policy);
        const teamId = await ensureTeamPolicyManager(
          client,
          input.actorUserId,
          target,
          input.expectedTeamId
        );
        const currentDuration =
          numberFromDb(policy.retention_seconds) +
          numberFromDb(policy.deletion_grace_seconds);
        const previousDuration =
          numberFromDb(previous.retention_seconds) +
          numberFromDb(previous.deletion_grace_seconds);
        if (currentDuration >= previousDuration) {
          throw new Error(
            "The current policy version does not shorten retention"
          );
        }
        const previewedAt = clock();
        const graceUntilMs = Math.max(
          previewedAt.getTime() + input.graceSeconds * 1_000,
          policy.effective_at.getTime()
        );
        if (!Number.isSafeInteger(graceUntilMs)) {
          throw new Error(
            "Policy shortening grace deadline exceeds the supported range"
          );
        }
        const graceUntil = new Date(graceUntilMs);
        requireValidDate("Policy shortening grace deadline", graceUntil);
        if (graceUntil <= previewedAt) {
          throw new Error("Policy shortening requires a future grace deadline");
        }
        const affectedScopes = await loadShorteningAffectedScopes(client, {
          policy,
          previewedAt,
          graceUntil
        });
        const previewHash = shorteningPreviewHash({
          teamId,
          policyId: policy.policy_id,
          policyVersion: policy.version,
          policyHash: policy.policy_hash,
          previewedByUserId: input.actorUserId,
          previewedAt,
          graceUntil,
          affectedScopes
        });
        const inserted = await client.query<ShorteningPreviewRow>(
          `insert into retention_policy_shortening_previews (
             retention_policy_row_id, team_id, policy_id, policy_version,
             policy_hash, affected_scope_count, preview_hash,
             previewed_by_user_id, previewed_at, grace_until
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
           ) returning *`,
          [
            policy.id,
            teamId,
            policy.policy_id,
            policy.version,
            policy.policy_hash,
            affectedScopes.length,
            previewHash,
            input.actorUserId,
            previewedAt,
            graceUntil
          ]
        );
        const previewRow = inserted.rows[0]!;
        const affectedRows: ShorteningAffectedScopeRow[] = [];
        for (const [ordinal, scope] of affectedScopes.entries()) {
          const affected = await client.query<ShorteningAffectedScopeRow>(
            `insert into retention_policy_shortening_affected_scopes (
               preview_id, ordinal, retention_decision_id, target_kind,
               target_id, previous_retain_until, shortened_retain_until,
               applicable_legal_hold_ids, scope_snapshot_hash
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             returning *`,
            [
              previewRow.id,
              ordinal,
              scope.retentionDecisionId,
              scope.targetKind,
              scope.targetId,
              scope.previousRetainUntil,
              scope.shortenedRetainUntil,
              scope.applicableLegalHoldIds,
              shorteningAffectedScopeHash(scope)
            ]
          );
          affectedRows.push(affected.rows[0]!);
        }
        await client.query(
          `insert into audit_events (
             actor_user_id, action, target_table, target_id, metadata
           ) values (
             $1, 'team.retention_policy.shortening_previewed',
             'retention_policy_shortening_previews', $2, $3::jsonb
           )`,
          [
            input.actorUserId,
            previewRow.id,
            JSON.stringify({
              teamId,
              policyId: policy.policy_id,
              policyVersion: policy.version,
              previewId: previewRow.id,
              previewHash,
              affectedScopeCount: affectedScopes.length,
              previewedAt: previewedAt.toISOString(),
              graceUntil: graceUntil.toISOString()
            })
          ]
        );
        return mapShorteningPreview(previewRow, affectedRows);
      });
    },

    async confirmPolicyShortening(input) {
      requireNonEmpty("Policy shortening preview ID", input.previewId);
      requireHash("Policy shortening preview hash", input.previewHash);
      requireNonNegativeInteger(
        "Expected affected scope count",
        input.expectedAffectedScopeCount
      );
      const outcome = await withTransaction<
        | {
            kind: "confirmed";
            confirmation: RetentionPolicyShorteningConfirmationRecord;
          }
        | { kind: "invalidated"; message: string }
      >(pool, async (client) => {
        const scopePreview = await loadShorteningPreviewAggregate(
          client,
          input.previewId
        );
        await lockPolicyScope(client, scopePreview.previewRow.policy_id);
        const { previewRow, affectedRows } =
          await loadShorteningPreviewAggregate(client, input.previewId, {
            forUpdate: true
          });
        const preview = mapShorteningPreview(previewRow, affectedRows);
        if (
          preview.teamId !== input.expectedTeamId ||
          preview.policyId !== input.expectedPolicyId ||
          preview.previewHash !== input.previewHash ||
          preview.affectedScopes.length !== input.expectedAffectedScopeCount
        ) {
          throw new Error(
            "Retention policy shortening confirmation does not match its preview"
          );
        }
        const policies = await client.query<PolicyRow>(
          `select * from retention_policies
            where policy_id = $1
            order by version desc
            for update`,
          [preview.policyId]
        );
        const policy = policies.rows.find(
          (candidate) => candidate.version === preview.policyVersion
        );
        if (!policy)
          throw new Error(
            "Retention policy shortening policy no longer exists"
          );
        await ensureTeamPolicyManager(
          client,
          input.actorUserId,
          targetFromPolicyRow(policy),
          input.expectedTeamId
        );
        if (previewRow.state === "confirmed") {
          return {
            kind: "confirmed",
            confirmation: mapShorteningConfirmation(
              previewRow,
              await loadShorteningMigrations(client, preview.id)
            )
          };
        }
        if (previewRow.state === "invalidated") {
          return {
            kind: "invalidated",
            message: "Retention policy shortening preview is invalidated"
          };
        }
        const confirmedAt = clock();
        const invalidate = async (
          reasonCode: string,
          message: string
        ): Promise<{ kind: "invalidated"; message: string }> => {
          await client.query(
            `update retention_policy_shortening_previews
                set state = 'invalidated', invalidated_at = $2,
                    invalidation_reason_code = $3, updated_at = $2
              where id = $1 and state = 'pending'`,
            [preview.id, confirmedAt, reasonCode]
          );
          await client.query(
            `insert into audit_events (
               actor_user_id, action, target_table, target_id, metadata
             ) values (
               $1, 'team.retention_policy.shortening_invalidated',
               'retention_policy_shortening_previews', $2, $3::jsonb
             )`,
            [
              input.actorUserId,
              preview.id,
              JSON.stringify({
                teamId: preview.teamId,
                policyId: preview.policyId,
                policyVersion: preview.policyVersion,
                previewId: preview.id,
                previewHash: preview.previewHash,
                invalidatedAt: confirmedAt.toISOString(),
                reasonCode
              })
            ]
          );
          return { kind: "invalidated", message };
        };
        if (policies.rows[0]?.id !== policy.id) {
          return invalidate(
            "policy_version_superseded",
            "Retention policy shortening preview is stale"
          );
        }
        if (confirmedAt < preview.graceUntil) {
          throw new Error(
            "Retention policy shortening grace period is still active"
          );
        }
        const affectedScopes = await loadShorteningAffectedScopes(client, {
          policy,
          previewedAt: preview.previewedAt,
          graceUntil: preview.graceUntil
        });
        const currentHash = shorteningPreviewHash({
          teamId: preview.teamId,
          policyId: preview.policyId,
          policyVersion: preview.policyVersion,
          policyHash: policy.policy_hash,
          previewedByUserId: preview.previewedByUserId,
          previewedAt: preview.previewedAt,
          graceUntil: preview.graceUntil,
          affectedScopes
        });
        if (currentHash !== preview.previewHash) {
          return invalidate(
            "affected_scope_changed",
            "Retention policy shortening preview is stale after hold or scope re-evaluation"
          );
        }
        const migrations: ShorteningMigrationRow[] = [];
        for (const [index, affected] of preview.affectedScopes.entries()) {
          const affectedRow = affectedRows[index]!;
          const oldResult = await client.query<DecisionRow>(
            "select * from retention_decisions where id = $1 for update",
            [affected.retentionDecisionId]
          );
          const oldDecision = oldResult.rows[0];
          if (!oldDecision)
            throw new Error("Affected retention decision no longer exists");
          const target = targetFromDecisionRow(oldDecision);
          const retainUntil = new Date(
            Math.max(
              affected.shortenedRetainUntil.getTime(),
              confirmedAt.getTime()
            )
          );
          const eligible =
            affected.applicableLegalHoldIds.length === 0 &&
            confirmedAt >= retainUntil;
          const eligibilityReasonCode =
            affected.applicableLegalHoldIds.length > 0
              ? "active_legal_hold"
              : confirmedAt < retainUntil
                ? "retention_period_active"
                : "eligible";
          const decisionSnapshotHash = snapshotHash({
            decisionVersion: oldDecision.decision_version + 1,
            policy: {
              policyId: policy.policy_id,
              version: policy.version,
              policyHash: policy.policy_hash,
              effectiveAt: policy.effective_at
            },
            target,
            trigger: "policy_migration",
            triggeredAt: confirmedAt,
            retainUntil,
            applicableLegalHoldIds: affected.applicableLegalHoldIds,
            eligible,
            eligibilityReasonCode,
            decidedAt: confirmedAt,
            migration: {
              previewId: preview.id,
              previewHash: preview.previewHash,
              previousDecisionId: oldDecision.id,
              previousRetainUntil: oldDecision.retain_until
            }
          });
          const fields = decisionInsertFields(target);
          const inserted = await client.query<DecisionRow>(
            `insert into retention_decisions (
               decision_version, policy_id, policy_version, target_kind,
               team_id, team_workspace_id, share_grant_id, representation_id,
               thread_id, message_id, owner_private_replica_id,
               logical_memory_id, trigger, policy_effective_at, triggered_at,
               retain_until, applicable_legal_hold_ids, eligible,
               eligibility_reason_code, decision_snapshot_hash, decided_at
             ) values (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, 'policy_migration', $13, $14, $15, $16, $17, $18, $19, $14
             ) returning *`,
            [
              oldDecision.decision_version + 1,
              policy.policy_id,
              policy.version,
              target.kind,
              fields.teamId,
              fields.teamWorkspaceId,
              fields.shareGrantId,
              fields.representationId,
              fields.threadId,
              fields.messageId,
              fields.ownerPrivateReplicaId,
              fields.logicalMemoryId,
              policy.effective_at,
              confirmedAt,
              retainUntil,
              affected.applicableLegalHoldIds,
              eligible,
              eligibilityReasonCode,
              decisionSnapshotHash
            ]
          );
          const migrated = inserted.rows[0]!;
          const migration = await client.query<ShorteningMigrationRow>(
            `insert into retention_policy_shortening_migrations (
               preview_id, affected_scope_id, previous_retention_decision_id,
               migrated_retention_decision_id, migrated_at
             ) values ($1, $2, $3, $4, $5)
             returning *`,
            [
              preview.id,
              affectedRow.id,
              oldDecision.id,
              migrated.id,
              confirmedAt
            ]
          );
          migrations.push(migration.rows[0]!);
          await client.query(
            `update purge_jobs
                set retention_decision_id = $2, updated_at = $3
              where retention_decision_id = $1
                and state in ('pending', 'blocked', 'retry_wait')`,
            [oldDecision.id, migrated.id, confirmedAt]
          );
          if (target.kind === "team") {
            await client.query(
              `update teams
                  set retain_until = least(retain_until, $2), updated_at = $3
                where id = $1
                  and lifecycle in ('deletion_requested', 'purge_pending')
                  and retain_until is not null`,
              [target.teamId, retainUntil, confirmedAt]
            );
          }
        }
        const confirmed = await client.query<ShorteningPreviewRow>(
          `update retention_policy_shortening_previews
              set state = 'confirmed', confirmed_by_user_id = $2,
                  confirmed_at = $3, updated_at = $3
            where id = $1 and state = 'pending'
            returning *`,
          [preview.id, input.actorUserId, confirmedAt]
        );
        const confirmedPreview = confirmed.rows[0];
        if (!confirmedPreview) {
          throw new Error("Retention policy shortening preview state changed");
        }
        await client.query(
          `insert into audit_events (
             actor_user_id, action, target_table, target_id, metadata
           ) values (
             $1, 'team.retention_policy.shortening_confirmed',
             'retention_policy_shortening_previews', $2, $3::jsonb
           )`,
          [
            input.actorUserId,
            preview.id,
            JSON.stringify({
              teamId: preview.teamId,
              policyId: preview.policyId,
              policyVersion: preview.policyVersion,
              previewId: preview.id,
              previewHash: preview.previewHash,
              confirmedByUserId: input.actorUserId,
              confirmedAt: confirmedAt.toISOString(),
              migratedFromDecisionIds: preview.affectedScopes.map(
                (scope) => scope.retentionDecisionId
              ),
              migratedDecisionIds: migrations.map(
                (migration) => migration.migrated_retention_decision_id
              )
            })
          ]
        );
        return {
          kind: "confirmed",
          confirmation: mapShorteningConfirmation(confirmedPreview, migrations)
        };
      });
      if (outcome.kind === "invalidated") throw new Error(outcome.message);
      return outcome.confirmation;
    },

    async placeLegalHold(input) {
      validateHoldTarget(input.target);
      requireNonEmpty("Legal hold authority", input.authority);
      requireNonEmpty("Legal hold reason code", input.reasonCode);
      requireHash("Legal hold reason hash", input.reasonHash);
      requireValidDate(
        "Fresh authentication timestamp",
        input.freshlyAuthenticatedAt
      );
      const now = clock();
      const authenticationAge =
        now.getTime() - input.freshlyAuthenticatedAt.getTime();
      if (
        authenticationAge < 0 ||
        authenticationAge > freshAuthenticationMaxAgeMs
      ) {
        throw new Error(
          "Fresh authentication timestamp is outside the allowed window"
        );
      }
      return withTransaction(pool, async (client) => {
        await lockScopeKeys(client, scopeKeysForHoldTarget(input.target));
        await ensureAuthorized(options.authorizeHoldActor, {
          action: "place",
          actorUserId: input.actorUserId,
          target: input.target,
          authority: input.authority
        });
        const fields = holdTargetFields(input.target);
        const result = await client.query<HoldRow>(
          `insert into legal_holds (
             scope, team_id, team_workspace_id, thread_id, share_grant_id,
             representation_id, representation, source_revision,
             owner_private_replica_id, logical_memory_id, message_range_start,
             message_range_end, message_time_start, message_time_end, authority,
             reason_code, reason_hash, placed_by_user_id,
             freshly_authenticated_at, placed_at
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
           ) returning *`,
          [
            input.target.scope,
            fields.teamId,
            fields.teamWorkspaceId,
            fields.threadId,
            fields.shareGrantId,
            fields.representationId,
            fields.representation,
            fields.sourceRevision,
            fields.ownerPrivateReplicaId,
            fields.logicalMemoryId,
            fields.messageRangeStart,
            fields.messageRangeEnd,
            fields.messageTimeStart,
            fields.messageTimeEnd,
            input.authority,
            input.reasonCode,
            input.reasonHash,
            input.actorUserId,
            input.freshlyAuthenticatedAt,
            now
          ]
        );
        return mapHold(result.rows[0]!);
      });
    },

    async requestLegalHoldRelease(input) {
      return withTransaction(pool, async (client) => {
        const scope = await client.query<HoldRow>(
          "select * from legal_holds where id = $1",
          [input.holdId]
        );
        const scopedHold = scope.rows[0];
        if (!scopedHold) throw new Error("Legal hold not found");
        await lockScopeKeys(
          client,
          scopeKeysForHoldTarget(targetFromHoldRow(scopedHold))
        );
        const result = await client.query<HoldRow>(
          "select * from legal_holds where id = $1 for update",
          [input.holdId]
        );
        const hold = result.rows[0];
        if (!hold) throw new Error("Legal hold not found");
        if (hold.state !== "active") {
          throw new Error("Legal hold is not active");
        }
        const target = targetFromHoldRow(hold);
        await ensureAuthorized(options.authorizeHoldActor, {
          action: "request_release",
          actorUserId: input.actorUserId,
          target,
          holdId: hold.id,
          authority: hold.authority
        });
        const updated = await client.query<HoldRow>(
          `update legal_holds
             set state = 'release_pending',
                 release_requested_by_user_id = $2,
                 release_requested_at = $3
             where id = $1 and state = 'active'
             returning *`,
          [hold.id, input.actorUserId, clock()]
        );
        if (!updated.rows[0])
          throw new Error("Legal hold state changed concurrently");
        return mapHold(updated.rows[0]);
      });
    },

    async confirmLegalHoldRelease(input) {
      return withTransaction(pool, async (client) => {
        const scope = await client.query<HoldRow>(
          "select * from legal_holds where id = $1",
          [input.holdId]
        );
        const scopedHold = scope.rows[0];
        if (!scopedHold) throw new Error("Legal hold not found");
        await lockScopeKeys(
          client,
          scopeKeysForHoldTarget(targetFromHoldRow(scopedHold))
        );
        const result = await client.query<HoldRow>(
          "select * from legal_holds where id = $1 for update",
          [input.holdId]
        );
        const hold = result.rows[0];
        if (!hold) throw new Error("Legal hold not found");
        if (
          hold.state !== "release_pending" ||
          !hold.release_requested_by_user_id
        ) {
          throw new Error("Legal hold release has not been requested");
        }
        const singleHolderReleaseException =
          input.singleHolderReleaseException === true;
        const isIndependent =
          input.actorUserId !== hold.release_requested_by_user_id;
        if (!isIndependent && !singleHolderReleaseException) {
          throw new Error(
            "Legal hold release requires an independent confirmer"
          );
        }
        if (isIndependent && singleHolderReleaseException) {
          throw new Error(
            "Single-holder release exception is only valid for the requesting actor"
          );
        }
        const target = targetFromHoldRow(hold);
        await ensureAuthorized(options.authorizeHoldActor, {
          action: singleHolderReleaseException
            ? "single_holder_release"
            : "confirm_release",
          actorUserId: input.actorUserId,
          target,
          holdId: hold.id,
          authority: hold.authority
        });
        const releasedAt = clock();
        const updated = await client.query<HoldRow>(
          `update legal_holds
             set state = 'released',
                 release_confirmed_by_user_id = $2,
                 release_confirmed_at = $3,
                 single_holder_release_exception = $4,
                 released_at = $3
             where id = $1 and state = 'release_pending'
             returning *`,
          [hold.id, input.actorUserId, releasedAt, singleHolderReleaseException]
        );
        if (!updated.rows[0])
          throw new Error("Legal hold state changed concurrently");
        return mapHold(updated.rows[0]);
      });
    },

    async snapshotDecision(input) {
      validateDecisionTarget(input.target);
      requirePositiveInteger("Decision version", input.decisionVersion ?? 1);
      requireValidDate("Retention trigger timestamp", input.triggeredAt);
      const decidedAt = input.decidedAt ?? clock();
      requireValidDate("Retention decision timestamp", decidedAt);
      return withTransaction(pool, async (client) => {
        await lockScopeKeys(client, scopeKeysForDecisionTarget(input.target));
        const policies = await client.query<PolicyRow>(
          `select * from retention_policies
             where policy_id = $1
               and effective_at <= $2
               and (superseded_at is null or superseded_at > $2)
             order by version desc
             limit 1
             for share`,
          [input.policyId, input.triggeredAt]
        );
        const policy = policies.rows[0];
        if (!policy) {
          throw new Error(
            "No policy version was effective at the retention trigger"
          );
        }
        const policyTarget = targetFromPolicyRow(policy);
        if (!policyAppliesToTarget(policyTarget, input.target)) {
          throw new Error(
            "Retention policy does not apply to the decision target"
          );
        }
        const holds = await activeHoldsForTarget(client, input.target);
        const holdIds = holds.map((hold) => hold.id).sort();
        const retentionSeconds = numberFromDb(policy.retention_seconds);
        const deletionGraceSeconds = numberFromDb(
          policy.deletion_grace_seconds
        );
        const retainUntilMs =
          input.triggeredAt.getTime() +
          (retentionSeconds + deletionGraceSeconds) * 1_000;
        if (!Number.isSafeInteger(retainUntilMs)) {
          throw new Error(
            "Retention deadline exceeds the supported date range"
          );
        }
        const retainUntil = new Date(retainUntilMs);
        requireValidDate("Retention deadline", retainUntil);
        const eligible = holdIds.length === 0 && decidedAt >= retainUntil;
        const eligibilityReasonCode =
          holdIds.length > 0
            ? "active_legal_hold"
            : decidedAt < retainUntil
              ? "retention_period_active"
              : "eligible";
        const decisionVersion = input.decisionVersion ?? 1;
        const decisionSnapshotHash = snapshotHash({
          decisionVersion,
          policy: {
            policyId: policy.policy_id,
            version: policy.version,
            policyHash: policy.policy_hash,
            effectiveAt: policy.effective_at
          },
          target: input.target,
          trigger: input.trigger,
          triggeredAt: input.triggeredAt,
          retainUntil,
          applicableLegalHoldIds: holdIds,
          eligible,
          eligibilityReasonCode,
          decidedAt
        });
        const fields = decisionInsertFields(input.target);
        const inserted = await client.query<DecisionRow>(
          `insert into retention_decisions (
             decision_version, policy_id, policy_version, target_kind, team_id,
             team_workspace_id, share_grant_id, representation_id, thread_id,
             message_id, owner_private_replica_id, logical_memory_id, trigger,
             policy_effective_at, triggered_at, retain_until,
             applicable_legal_hold_ids, eligible, eligibility_reason_code,
             decision_snapshot_hash, decided_at
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
           ) returning *`,
          [
            decisionVersion,
            policy.policy_id,
            policy.version,
            input.target.kind,
            fields.teamId,
            fields.teamWorkspaceId,
            fields.shareGrantId,
            fields.representationId,
            fields.threadId,
            fields.messageId,
            fields.ownerPrivateReplicaId,
            fields.logicalMemoryId,
            input.trigger,
            policy.effective_at,
            input.triggeredAt,
            retainUntil,
            holdIds,
            eligible,
            eligibilityReasonCode,
            decisionSnapshotHash,
            decidedAt
          ]
        );
        return mapDecision(inserted.rows[0]!);
      });
    },

    async requestRootTeamDeletion(input) {
      requireNonEmpty("Team ID", input.teamId);
      requireNonEmpty("Actor user ID", input.actorUserId);
      requirePositiveInteger("Expected Team version", input.expectedVersion);
      const triggeredAt = input.triggeredAt ?? clock();
      requireValidDate("Team deletion trigger timestamp", triggeredAt);
      const idempotencyKey =
        input.idempotencyKey ?? `team:${input.teamId}:root-deletion:v1`;
      requireNonEmpty("Purge idempotency key", idempotencyKey);

      return withTransaction(pool, async (client) => {
        await lockScopeKeys(client, [`team:${input.teamId}`]);
        const existingJob = await client.query<JobRow>(
          "select * from purge_jobs where idempotency_key = $1 for update",
          [idempotencyKey]
        );
        if (existingJob.rows[0]) {
          const team = await client.query<TeamDeletionRow>(
            `select id, name, version, lifecycle, deletion_requested_at,
                    tombstoned_at, retain_until, purge_completed_at
               from teams where id = $1`,
            [input.teamId]
          );
          const decision = await client.query<DecisionRow>(
            "select * from retention_decisions where id = $1",
            [existingJob.rows[0].retention_decision_id]
          );
          const evidence = await client.query<EvidenceRow>(
            "select * from purge_job_evidence where purge_job_id = $1 order by artifact_kind, artifact_locator_hash",
            [existingJob.rows[0].id]
          );
          if (!team.rows[0] || !decision.rows[0]) return null;
          assertSameRequiredArtifacts(
            teamDeletionArtifacts(input.teamId),
            evidence.rows
          );
          return {
            team: mapTeamDeletion(team.rows[0]),
            decision: mapDecision(decision.rows[0]),
            purgeJob: mapJob(existingJob.rows[0]),
            requiredArtifacts: evidence.rows.map(mapEvidence)
          };
        }

        const teamResult = await client.query<TeamDeletionRow>(
          `select t.id, t.name, t.version, t.lifecycle,
                  t.deletion_requested_at, t.tombstoned_at, t.retain_until,
                  t.purge_completed_at
             from teams t
             join team_memberships tm on tm.team_id = t.id
            where t.id = $1
              and t.lifecycle = 'active'
              and tm.user_id = $2
              and tm.role in ('owner', 'admin')
              and tm.status = 'enabled'
              and tm.disabled_at is null
            limit 1
            for update of t`,
          [input.teamId, input.actorUserId]
        );
        const existing = teamResult.rows[0];
        if (!existing) return null;
        if (existing.version !== input.expectedVersion) {
          throw Object.assign(new Error("Stale version"), {
            code: "STALE_VERSION"
          });
        }

        const policies = await client.query<PolicyRow>(
          `select * from retention_policies
             where scope = 'team'
               and team_id = $1
               and effective_at <= $2
               and (superseded_at is null or superseded_at > $2)
             order by version desc
             limit 1
             for share`,
          [input.teamId, triggeredAt]
        );
        const policy = policies.rows[0];
        if (!policy) {
          throw new Error(
            "No Team retention policy was effective at deletion request time"
          );
        }

        const target: RetentionDecisionTarget = {
          kind: "team",
          targetId: input.teamId,
          teamId: input.teamId
        };
        const holds = await activeHoldsForTarget(client, target);
        const holdIds = holds.map((hold) => hold.id).sort();
        const retainUntil = new Date(
          triggeredAt.getTime() +
            (numberFromDb(policy.retention_seconds) +
              numberFromDb(policy.deletion_grace_seconds)) *
              1_000
        );
        requireValidDate("Retention deadline", retainUntil);
        const eligible = holdIds.length === 0 && triggeredAt >= retainUntil;
        const eligibilityReasonCode =
          holdIds.length > 0
            ? "active_legal_hold"
            : triggeredAt < retainUntil
              ? "retention_period_active"
              : "eligible";
        const decisionSnapshotHash = snapshotHash({
          decisionVersion: 1,
          policy: {
            policyId: policy.policy_id,
            version: policy.version,
            policyHash: policy.policy_hash,
            effectiveAt: policy.effective_at
          },
          target,
          trigger: "team_deletion",
          triggeredAt,
          retainUntil,
          applicableLegalHoldIds: holdIds,
          eligible,
          eligibilityReasonCode,
          decidedAt: triggeredAt
        });
        const decisionResult = await client.query<DecisionRow>(
          `insert into retention_decisions (
             decision_version, policy_id, policy_version, target_kind, team_id,
             trigger, policy_effective_at, triggered_at, retain_until,
             applicable_legal_hold_ids, eligible, eligibility_reason_code,
             decision_snapshot_hash, decided_at
           ) values (
             1, $1, $2, 'team', $3, 'team_deletion', $4, $5, $6,
             $7, $8, $9, $10, $5
           ) returning *`,
          [
            policy.policy_id,
            policy.version,
            input.teamId,
            policy.effective_at,
            triggeredAt,
            retainUntil,
            holdIds,
            eligible,
            eligibilityReasonCode,
            decisionSnapshotHash
          ]
        );
        const decision = decisionResult.rows[0]!;

        const teamUpdate = await client.query<TeamDeletionRow>(
          `update teams
              set lifecycle = 'deletion_requested',
                  suspended_at = $2,
                  deletion_requested_at = $2,
                  tombstoned_at = $2,
                  retain_until = $3,
                  version = version + 1,
                  updated_at = $2
            where id = $1
              and lifecycle = 'active'
              and version = $4
            returning id, name, version, lifecycle, deletion_requested_at,
                      tombstoned_at, retain_until, purge_completed_at`,
          [input.teamId, triggeredAt, retainUntil, input.expectedVersion]
        );
        const team = teamUpdate.rows[0];
        if (!team) {
          throw Object.assign(new Error("Stale version"), {
            code: "STALE_VERSION"
          });
        }
        await client.query(
          `update collaboration_threads
              set lifecycle = 'tombstoned',
                  tombstoned_at = coalesce(tombstoned_at, $2),
                  archived_at = null,
                  retention_policy_id = $3,
                  retention_policy_version = $4,
                  retention_triggered_at = $2,
                  retain_until = $5,
                  version = version + 1,
                  updated_at = $2
            where team_id = $1
              and lifecycle in ('active', 'archived')`,
          [
            input.teamId,
            triggeredAt,
            policy.policy_id,
            policy.version,
            retainUntil
          ]
        );
        await client.query(
          `update team_memory_representations
              set state = 'purge_pending',
                  tombstoned_at = coalesce(tombstoned_at, $2),
                  retain_until = $3,
                  updated_at = $2
            where team_id = $1
              and state in ('pending', 'available', 'stale', 'invalidated')`,
          [input.teamId, triggeredAt, retainUntil]
        );
        await client.query(
          `update team_session_share_grants
              set lifecycle = 'purge_pending',
                  tombstoned_at = coalesce(tombstoned_at, $2),
                  retention_policy_id = $3,
                  retention_policy_version = $4,
                  retention_triggered_at = $2,
                  retain_until = $5,
                  updated_at = $2
            where team_id = $1
              and lifecycle <> 'purged'`,
          [
            input.teamId,
            triggeredAt,
            policy.policy_id,
            policy.version,
            retainUntil
          ]
        );

        const jobResult = await client.query<JobRow>(
          `insert into purge_jobs (
             retention_decision_id, target_kind, target_id, team_id,
             idempotency_key
           ) values ($1, 'team', $2, $2, $3)
           returning *`,
          [decision.id, input.teamId, idempotencyKey]
        );
        const job = jobResult.rows[0]!;
        for (const artifact of requiredArtifactsForPurgeTarget(
          purgeTargetStrategies,
          executablePurgeTarget(target)
        )) {
          await client.query(
            `insert into purge_job_evidence (
               purge_job_id, artifact_kind, artifact_locator_hash,
               removed_record_count, removed_byte_count
             ) values ($1, $2, $3, 0, 0)`,
            [job.id, artifact.artifactKind, artifact.artifactLocatorHash]
          );
        }
        await client.query(
          `insert into audit_events (
             actor_user_id, action, target_table, target_id, metadata
           ) values ($1, 'team.deletion_requested', 'teams', $2, $3::jsonb)`,
          [
            input.actorUserId,
            input.teamId,
            JSON.stringify({
              teamId: input.teamId,
              retentionDecisionId: decision.id,
              purgeJobId: job.id,
              policyId: policy.policy_id,
              policyVersion: policy.version,
              triggeredAt: triggeredAt.toISOString(),
              retainUntil: retainUntil.toISOString(),
              applicableLegalHoldIds: holdIds,
              decisionSnapshotHash
            })
          ]
        );
        const evidence = await client.query<EvidenceRow>(
          "select * from purge_job_evidence where purge_job_id = $1 order by artifact_kind, artifact_locator_hash",
          [job.id]
        );
        return {
          team: mapTeamDeletion(team),
          decision: mapDecision(decision),
          purgeJob: mapJob(job),
          requiredArtifacts: evidence.rows.map(mapEvidence)
        };
      });
    },

    async listOwnerPrivateReplicasForUserErasure(userId) {
      requireNonEmpty("User ID", userId);
      const result = await pool.query<
        QueryResultRow & {
          id: string;
          logical_memory_id: string;
          version: number;
        }
      >(
        `select id, logical_memory_id, version
           from memory_replicas
          where owner_user_id=$1
            and replica_role='target'
            and encryption_scope='owner_private_replica'
            and lifecycle in ('active','stale','revoked','tombstoned')
          order by created_at, id`,
        [userId]
      );
      return result.rows.map((row) => ({
        id: row.id,
        logicalMemoryId: row.logical_memory_id,
        version: row.version
      }));
    },

    async completeUserErasureTombstone(input) {
      requireNonEmpty("User ID", input.userId);
      const erasedAt = input.erasedAt ?? clock();
      requireValidDate("User erasure timestamp", erasedAt);
      return withTransaction(pool, async (client) => {
        const user = await client.query<
          QueryResultRow & { deleted_at: Date | null }
        >("select deleted_at from users where id=$1 for update", [
          input.userId
        ]);
        if (!user.rows[0]) return null;
        if (user.rows[0].deleted_at) {
          return { userId: input.userId, erasedAt: user.rows[0].deleted_at };
        }
        const soleOwner = await client.query(
          `select 1
             from team_memberships membership
            where membership.user_id=$1
              and membership.role='owner'
              and membership.status='enabled'
              and membership.disabled_at is null
              and not exists (
                select 1
                  from team_memberships replacement
                 where replacement.team_id=membership.team_id
                   and replacement.user_id<>membership.user_id
                   and replacement.role='owner'
                   and replacement.status='enabled'
                   and replacement.disabled_at is null
              )
            limit 1`,
          [input.userId]
        );
        if (soleOwner.rowCount) {
          throw new Error(
            "Team ownership must be transferred before User erasure"
          );
        }
        const remainingReplica = await client.query(
          `select 1
             from memory_replicas
            where owner_user_id=$1
              and replica_role='target'
              and encryption_scope='owner_private_replica'
              and lifecycle not in ('purge_pending','purged')
            limit 1`,
          [input.userId]
        );
        if (remainingReplica.rowCount) {
          throw new Error("Owner-private replica erasure is incomplete");
        }
        const pseudonymousEmail = `erased-${sha256(input.userId).slice(0, 24)}@deleted.koed.invalid`;
        await client.query(
          `update user_sessions
              set revoked_at=coalesce(revoked_at,$2)
            where user_id=$1 and revoked_at is null`,
          [input.userId, erasedAt]
        );
        await client.query(
          `update api_tokens
              set revoked_at=coalesce(revoked_at,$2)
            where owner_user_id=$1 and revoked_at is null`,
          [input.userId, erasedAt]
        );
        await client.query(
          `update device_credentials
              set revoked_at=coalesce(revoked_at,$2),
                  revoked_by_user_id=null,
                  revocation_reason='user_erasure',
                  device_label=null,
                  metadata='{}'::jsonb,
                  updated_at=$2
            where owner_user_id=$1`,
          [input.userId, erasedAt]
        );
        await client.query(
          `delete from device_enrollment_challenges
            where rotation_owner_user_id=$1 or bound_by_user_id=$1`,
          [input.userId]
        );
        await client.query(
          "delete from sync_principal_links where local_user_id=$1",
          [input.userId]
        );
        await client.query(
          "delete from external_auth_identities where user_id=$1",
          [input.userId]
        );
        await client.query(
          `update team_workspace_access_grants
              set access='disabled', can_share_owned_memory=false,
                  disabled_at=coalesce(disabled_at,$2),
                  disabled_reason='user_erasure', version=version+1,
                  updated_at=$2
            where user_id=$1 and access<>'disabled'`,
          [input.userId, erasedAt]
        );
        await client.query(
          `update team_memberships
              set status='disabled',
                  disabled_at=coalesce(disabled_at,$2),
                  disabled_reason='user_erasure', version=version+1,
                  updated_at=$2
            where user_id=$1 and status<>'disabled'`,
          [input.userId, erasedAt]
        );
        await client.query(
          `update users
              set email=$2, display_name=null, avatar_reference=null,
                  password_hash=null, disabled_at=$3,
                  disabled_reason='user_erasure', deleted_at=$3,
                  deletion_reason='user_erasure', updated_at=$3
            where id=$1`,
          [input.userId, pseudonymousEmail, erasedAt]
        );
        await client.query(
          `insert into audit_events (
             actor_user_id, action, target_table, target_id, metadata
           ) values (null,'user.erasure_tombstoned','users',$1,$2::jsonb)`,
          [
            input.userId,
            JSON.stringify({
              userId: input.userId,
              erasedAt: erasedAt.toISOString()
            })
          ]
        );
        return { userId: input.userId, erasedAt };
      });
    },

    async requestOwnerPrivateReplicaPurge(input) {
      requireNonEmpty("Owner-private replica ID", input.ownerPrivateReplicaId);
      requireNonEmpty("Actor user ID", input.actorUserId);
      requirePositiveInteger("Expected replica version", input.expectedVersion);
      const triggeredAt = input.triggeredAt ?? clock();
      const trigger = input.trigger ?? "source_purge";
      requireValidDate("Owner-private purge trigger timestamp", triggeredAt);
      const idempotencyKey =
        input.idempotencyKey ??
        `owner-private-replica:${input.ownerPrivateReplicaId}:${trigger}:v1`;
      requireNonEmpty("Purge idempotency key", idempotencyKey);

      return withTransaction(pool, async (client) => {
        await lockScopeKeys(client, [
          `owner-private-replica:${input.ownerPrivateReplicaId}`
        ]);
        const replicaResult = await client.query<OwnerPrivateReplicaRow>(
          `select id, logical_memory_id, owner_user_id, owner_principal_id,
                  version, lifecycle, freshness_status, tombstoned_at,
                  retain_until, purge_completed_at
             from memory_replicas
            where id = $1 and owner_user_id = $2
              and replica_role = 'target'
              and encryption_scope = 'owner_private_replica'
            for update`,
          [input.ownerPrivateReplicaId, input.actorUserId]
        );
        const existingReplica = replicaResult.rows[0];
        if (!existingReplica) return null;

        const requiredArtifacts = requiredArtifactsForPurgeTarget(
          purgeTargetStrategies,
          {
            kind: "owner_private_replica",
            targetId: input.ownerPrivateReplicaId,
            ownerPrivateReplicaId: input.ownerPrivateReplicaId,
            logicalMemoryId: existingReplica.logical_memory_id
          }
        );
        const existingJob = await client.query<JobRow>(
          "select * from purge_jobs where idempotency_key = $1 for update",
          [idempotencyKey]
        );
        if (existingJob.rows[0]) {
          const decision = await client.query<DecisionRow>(
            "select * from retention_decisions where id = $1",
            [existingJob.rows[0].retention_decision_id]
          );
          const decisionRow = decision.rows[0];
          if (
            !decisionRow ||
            decisionRow.target_kind !== "owner_private_replica" ||
            decisionRow.owner_private_replica_id !==
              input.ownerPrivateReplicaId ||
            decisionRow.logical_memory_id !== existingReplica.logical_memory_id
          ) {
            throw new Error(
              "Purge idempotency key was reused for another target"
            );
          }
          const evidence = await client.query<EvidenceRow>(
            "select * from purge_job_evidence where purge_job_id = $1 order by artifact_kind, artifact_locator_hash",
            [existingJob.rows[0].id]
          );
          assertSameRequiredArtifacts(requiredArtifacts, evidence.rows);
          return {
            ownerPrivateReplica: mapOwnerPrivateReplica(existingReplica),
            decision: mapDecision(decisionRow),
            purgeJob: mapJob(existingJob.rows[0]),
            requiredArtifacts: evidence.rows.map(mapEvidence)
          };
        }

        if (existingReplica.version !== input.expectedVersion) {
          throw Object.assign(new Error("Stale version"), {
            code: "STALE_VERSION"
          });
        }
        if (
          !["active", "stale", "revoked", "tombstoned"].includes(
            existingReplica.lifecycle
          )
        ) {
          throw new Error("Owner-private replica cannot be purged");
        }

        const policies = await client.query<PolicyRow>(
          `select * from retention_policies
             where scope = 'owner_private_replica'
               and owner_private_replica_id = $1
               and logical_memory_id = $2
               and effective_at <= $3
               and (superseded_at is null or superseded_at > $3)
             order by version desc
             limit 1
             for share`,
          [
            input.ownerPrivateReplicaId,
            existingReplica.logical_memory_id,
            triggeredAt
          ]
        );
        const policy = policies.rows[0];
        if (!policy) {
          throw new Error(
            "No owner-private retention policy was effective at purge request time"
          );
        }

        const target: RetentionDecisionTarget = {
          kind: "owner_private_replica",
          targetId: input.ownerPrivateReplicaId,
          ownerPrivateReplicaId: input.ownerPrivateReplicaId,
          logicalMemoryId: existingReplica.logical_memory_id
        };
        const holds = await activeHoldsForTarget(client, target);
        const holdIds = holds.map((hold) => hold.id).sort();
        const retainUntil = new Date(
          triggeredAt.getTime() +
            (numberFromDb(policy.retention_seconds) +
              numberFromDb(policy.deletion_grace_seconds)) *
              1_000
        );
        requireValidDate("Retention deadline", retainUntil);
        const eligible = holdIds.length === 0 && triggeredAt >= retainUntil;
        const eligibilityReasonCode =
          holdIds.length > 0
            ? "active_legal_hold"
            : triggeredAt < retainUntil
              ? "retention_period_active"
              : "eligible";
        const decisionSnapshotHash = snapshotHash({
          decisionVersion: 1,
          policy: {
            policyId: policy.policy_id,
            version: policy.version,
            policyHash: policy.policy_hash,
            effectiveAt: policy.effective_at
          },
          target,
          trigger,
          triggeredAt,
          retainUntil,
          applicableLegalHoldIds: holdIds,
          eligible,
          eligibilityReasonCode,
          decidedAt: triggeredAt
        });
        const decisionResult = await client.query<DecisionRow>(
          `insert into retention_decisions (
             decision_version, policy_id, policy_version, target_kind,
             owner_private_replica_id, logical_memory_id, trigger,
             policy_effective_at, triggered_at, retain_until,
             applicable_legal_hold_ids, eligible, eligibility_reason_code,
             decision_snapshot_hash, decided_at
           ) values (
             1, $1, $2, 'owner_private_replica', $3, $4, $5::retention_trigger,
             $6, $7, $8, $9, $10, $11, $12, $7
           ) returning *`,
          [
            policy.policy_id,
            policy.version,
            input.ownerPrivateReplicaId,
            existingReplica.logical_memory_id,
            trigger,
            policy.effective_at,
            triggeredAt,
            retainUntil,
            holdIds,
            eligible,
            eligibilityReasonCode,
            decisionSnapshotHash
          ]
        );
        const decision = decisionResult.rows[0]!;

        const teamReferences = await client.query<QueryResultRow>(
          `select (
             exists(select 1 from team_session_share_grants where remote_replica_id = $1)
             or exists(select 1 from shared_source_artifacts where remote_replica_id = $1)
             or exists(select 1 from shared_source_previews where remote_replica_id = $1)
             or exists(select 1 from source_owner_representation_consents where remote_replica_id = $1)
           ) as retained_by_team`,
          [input.ownerPrivateReplicaId]
        );
        const retainedByTeam =
          teamReferences.rows[0]?.retained_by_team === true;
        await client.query(
          `update cross_identity_sync_relationships
              set state = 'revoked', paused_at = null,
                  state_before_pause = null,
                  revoked_at = coalesce(revoked_at, $3),
                  revocation_reason = $4,
                  updated_at = $3
            where local_replica_id = $1 and logical_memory_id = $2`,
          [
            input.ownerPrivateReplicaId,
            existingReplica.logical_memory_id,
            triggeredAt,
            `owner_private_replica_${trigger}_requested`
          ]
        );
        const updatedReplica = await client.query<OwnerPrivateReplicaRow>(
          `update memory_replicas
              set lifecycle = 'purge_pending',
                  freshness_status = 'revoked',
                  tombstoned_at = coalesce(tombstoned_at, $2),
                  retain_until = $3,
                  version = version + 1,
                  updated_at = $2
            where id = $1 and version = $4
            returning id, logical_memory_id, owner_user_id,
                      owner_principal_id, version, lifecycle,
                      freshness_status, tombstoned_at, retain_until,
                      purge_completed_at`,
          [
            input.ownerPrivateReplicaId,
            triggeredAt,
            retainUntil,
            input.expectedVersion
          ]
        );
        if (!updatedReplica.rows[0]) {
          throw Object.assign(new Error("Stale version"), {
            code: "STALE_VERSION"
          });
        }

        const jobResult = await client.query<JobRow>(
          `insert into purge_jobs (
             retention_decision_id, target_kind, target_id,
             logical_memory_id, idempotency_key
           ) values ($1, 'owner_private_replica', $2, $3, $4)
           returning *`,
          [
            decision.id,
            input.ownerPrivateReplicaId,
            existingReplica.logical_memory_id,
            idempotencyKey
          ]
        );
        const job = jobResult.rows[0]!;
        for (const artifact of requiredArtifacts) {
          await client.query(
            `insert into purge_job_evidence (
               purge_job_id, artifact_kind, artifact_locator_hash,
               removed_record_count, removed_byte_count
             ) values ($1, $2, $3, 0, 0)`,
            [job.id, artifact.artifactKind, artifact.artifactLocatorHash]
          );
        }
        await client.query(
          `insert into audit_events (
             actor_user_id, owner_user_id, visibility, action,
             target_table, target_id, metadata
           ) values (
             $1, $1, 'personal', 'owner_private_replica.deletion_requested',
             'memory_replicas', $2, $3::jsonb
           )`,
          [
            input.actorUserId,
            input.ownerPrivateReplicaId,
            JSON.stringify({
              ownerPrivateReplicaId: input.ownerPrivateReplicaId,
              logicalMemoryId: existingReplica.logical_memory_id,
              retentionDecisionId: decision.id,
              purgeJobId: job.id,
              policyId: policy.policy_id,
              policyVersion: policy.version,
              triggeredAt: triggeredAt.toISOString(),
              retainUntil: retainUntil.toISOString(),
              applicableLegalHoldIds: holdIds,
              decisionSnapshotHash,
              trigger,
              teamRepresentationsRetained: retainedByTeam
            })
          ]
        );
        const evidence = await client.query<EvidenceRow>(
          "select * from purge_job_evidence where purge_job_id = $1 order by artifact_kind, artifact_locator_hash",
          [job.id]
        );
        return {
          ownerPrivateReplica: mapOwnerPrivateReplica(updatedReplica.rows[0]),
          decision: mapDecision(decision),
          purgeJob: mapJob(job),
          requiredArtifacts: evidence.rows.map(mapEvidence)
        };
      });
    },

    async createPurgeJob(input) {
      requireNonEmpty("Purge idempotency key", input.idempotencyKey);
      const suppliedArtifacts = validateRequiredArtifacts(
        input.requiredArtifacts
      );
      return withTransaction(pool, async (client) => {
        const decisions = await client.query<DecisionRow>(
          "select * from retention_decisions where id = $1 for update",
          [input.retentionDecisionId]
        );
        const decision = decisions.rows[0];
        if (!decision) throw new Error("Retention decision not found");
        const target = targetFromDecisionForJob(decision);
        const requiredArtifacts =
          target.kind === "team" ||
          target.kind === "share_grant" ||
          target.kind === "owner_private_replica"
            ? requiredArtifactsForPurgeTarget(
                purgeTargetStrategies,
                target,
                suppliedArtifacts
              )
            : suppliedArtifacts;
        const existing = await client.query<JobRow>(
          "select * from purge_jobs where idempotency_key = $1 for update",
          [input.idempotencyKey]
        );
        if (existing.rows[0]) {
          if (
            existing.rows[0].retention_decision_id !== input.retentionDecisionId
          ) {
            throw new Error(
              "Purge job idempotency key was reused for another decision"
            );
          }
          const evidence = await client.query<EvidenceRow>(
            "select * from purge_job_evidence where purge_job_id = $1 order by artifact_kind, artifact_locator_hash",
            [existing.rows[0].id]
          );
          assertSameRequiredArtifacts(requiredArtifacts, evidence.rows);
          return mapJob(existing.rows[0]);
        }
        await lockScopeKeys(client, scopeKeysForDecisionTarget(target));
        const fields = decisionInsertFields(target);
        const inserted = await client.query<JobRow>(
          `insert into purge_jobs (
             retention_decision_id, target_kind, target_id, team_id,
             team_workspace_id, share_grant_id, representation_id,
             logical_memory_id, idempotency_key
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (idempotency_key) do nothing
           returning *`,
          [
            decision.id,
            target.kind,
            target.targetId,
            fields.teamId,
            fields.teamWorkspaceId,
            fields.shareGrantId,
            fields.representationId,
            fields.logicalMemoryId,
            input.idempotencyKey
          ]
        );
        let job = inserted.rows[0];
        if (!job) {
          const raced = await client.query<JobRow>(
            "select * from purge_jobs where idempotency_key = $1 for update",
            [input.idempotencyKey]
          );
          job = raced.rows[0];
          if (!job || job.retention_decision_id !== input.retentionDecisionId) {
            throw new Error("Purge job idempotency conflict");
          }
        } else {
          for (const artifact of requiredArtifacts) {
            await client.query(
              `insert into purge_job_evidence (
                 purge_job_id, artifact_kind, artifact_locator_hash,
                 removed_record_count, removed_byte_count
               ) values ($1, $2, $3, 0, 0)`,
              [job.id, artifact.artifactKind, artifact.artifactLocatorHash]
            );
          }
        }
        const evidence = await client.query<EvidenceRow>(
          "select * from purge_job_evidence where purge_job_id = $1 order by artifact_kind, artifact_locator_hash",
          [job.id]
        );
        assertSameRequiredArtifacts(requiredArtifacts, evidence.rows);
        return mapJob(job);
      });
    },

    async claimNextPurgeJob() {
      return withTransaction(pool, async (client) => {
        const now = clock();
        for (let inspected = 0; inspected < 32; inspected += 1) {
          const candidates = await client.query<JobRow & DecisionRow>(
            `select j.*, d.decision_version, d.policy_id, d.policy_version,
                    d.thread_id, d.message_id, d.owner_private_replica_id,
                    d.trigger, d.trigger_epoch, d.policy_effective_at, d.triggered_at,
                    d.retain_until, d.applicable_legal_hold_ids, d.eligible,
                    d.eligibility_reason_code, d.decision_snapshot_hash,
                    d.decided_at
               from purge_jobs j
               join retention_decisions d on d.id = j.retention_decision_id
              where d.retain_until <= $1
                and (
                  (j.state in ('pending', 'retry_wait', 'blocked')
                    and (j.next_attempt_at is null or j.next_attempt_at <= $1))
                  or (j.state = 'running'
                    and j.updated_at <= $1 - ($2::text)::interval)
              )
              order by coalesce(j.next_attempt_at, j.created_at), j.created_at, j.id
              limit 1`,
            [now, `${staleRunningAttemptMs} milliseconds`]
          );
          const unlockedCandidate = candidates.rows[0];
          if (!unlockedCandidate) return null;
          const unlockedTarget = targetFromDecisionRow(unlockedCandidate);
          await lockScopeKeys(
            client,
            scopeKeysForDecisionTarget(unlockedTarget)
          );
          if (isExecutablePurgeTarget(unlockedTarget)) {
            try {
              await lockPurgeTarget(
                purgeTargetStrategies,
                client,
                unlockedTarget
              );
            } catch (error) {
              if (
                unlockedTarget.kind === "share_grant" &&
                error instanceof Error &&
                error.message === "Share Grant purge target is unavailable"
              ) {
                return null;
              }
              throw error;
            }
          }
          const lockedCandidates = await client.query<JobRow & DecisionRow>(
            `select j.*, d.decision_version, d.policy_id, d.policy_version,
                    d.thread_id, d.message_id, d.owner_private_replica_id,
                    d.trigger, d.trigger_epoch, d.policy_effective_at, d.triggered_at,
                    d.retain_until, d.applicable_legal_hold_ids, d.eligible,
                    d.eligibility_reason_code, d.decision_snapshot_hash,
                    d.decided_at
               from purge_jobs j
               join retention_decisions d on d.id = j.retention_decision_id
              where j.id = $1 and d.retain_until <= $2
                and (
                  (j.state in ('pending', 'retry_wait', 'blocked')
                    and (j.next_attempt_at is null or j.next_attempt_at <= $2))
                  or (j.state = 'running'
                    and j.updated_at <= $2 - ($3::text)::interval)
                )
              for update of j skip locked`,
            [unlockedCandidate.id, now, `${staleRunningAttemptMs} milliseconds`]
          );
          const candidate = lockedCandidates.rows[0];
          if (!candidate) return null;
          const target = targetFromDecisionRow(candidate);
          if (isExecutablePurgeTarget(target)) {
            await preparePurgeTargetForClaim(
              purgeTargetStrategies,
              client,
              target,
              now
            );
          }
          const holds = await activeHoldsForPurgeTarget(client, target);
          if (holds.length > 0) {
            await closeRunningAttemptsForHold(client, candidate.id, now);
            await client.query(
              `update purge_jobs
                  set state = 'blocked', started_at = coalesce(started_at, $2),
                      next_attempt_at = $3, updated_at = $2
                where id = $1`,
              [
                candidate.id,
                now,
                new Date(now.getTime() + blockedHoldRecheckMs)
              ]
            );
            return null;
          }
          if (candidate.state === "running") {
            await client.query(
              `update purge_job_attempts
                  set state = 'retryable_failure', completed_at = $2,
                      error_code = 'claim_lease_expired', error_hash = $3
                where purge_job_id = $1 and state = 'running'`,
              [candidate.id, now, sha256("claim_lease_expired")]
            );
          }
          const claimed = await client.query<JobRow>(
            `update purge_jobs
                set state = 'running', started_at = coalesce(started_at, $2),
                    next_attempt_at = null, attempt_count = attempt_count + 1,
                    terminal_error_code = null, updated_at = $2
              where id = $1
              returning *`,
            [candidate.id, now]
          );
          const job = claimed.rows[0]!;
          const attempt = await client.query<
            QueryResultRow & {
              id: string;
              attempt_number: number;
              started_at: Date;
            }
          >(
            `insert into purge_job_attempts (
               purge_job_id, attempt_number, resume_artifact_kind, resume_cursor,
               started_at
             ) values ($1, $2, $3, $4, $5)
             returning id, attempt_number, started_at`,
            [
              job.id,
              job.attempt_count,
              job.resume_artifact_kind,
              job.resume_cursor,
              now
            ]
          );
          const evidence = await client.query<EvidenceRow>(
            "select * from purge_job_evidence where purge_job_id = $1 order by artifact_kind, artifact_locator_hash",
            [job.id]
          );
          return {
            job: mapJob(job),
            attempt: {
              id: attempt.rows[0]!.id,
              attemptNumber: attempt.rows[0]!.attempt_number,
              startedAt: attempt.rows[0]!.started_at
            },
            requiredArtifacts: evidence.rows.map(mapEvidence)
          };
        }
        return null;
      });
    },

    async processClaimedPurgeJob(input) {
      for (;;) {
        const result = await withTransaction(pool, async (client) => {
          const scopeResult = await client.query<DecisionRow>(
            `select decision.*
               from purge_job_attempts attempt
               join purge_jobs job on job.id = attempt.purge_job_id
               join retention_decisions decision
                 on decision.id = job.retention_decision_id
              where attempt.id = $1 and attempt.purge_job_id = $2
                and attempt.state = 'running' and job.state = 'running'`,
            [input.purgeAttemptId, input.purgeJobId]
          );
          const scopeDecision = scopeResult.rows[0];
          if (!scopeDecision) {
            throw new Error("Purge attempt is not active");
          }
          await lockScopeKeys(
            client,
            scopeKeysForDecisionTarget(targetFromDecisionRow(scopeDecision))
          );
          const scopeTarget = targetFromDecisionRow(scopeDecision);
          if (isExecutablePurgeTarget(scopeTarget)) {
            await lockPurgeTarget(purgeTargetStrategies, client, scopeTarget);
          }
          const active = await client.query<
            QueryResultRow & {
              attempt_number: number;
              attempt_count: number;
              target_kind: PurgeTargetKind;
              team_id: string | null;
              policy_id: string;
              policy_version: number;
            }
          >(
            `select a.attempt_number, j.attempt_count, j.target_kind, j.team_id,
                  d.policy_id, d.policy_version
             from purge_job_attempts a
             join purge_jobs j on j.id = a.purge_job_id
             join retention_decisions d on d.id = j.retention_decision_id
            where a.id = $1 and a.purge_job_id = $2
              and a.state = 'running' and j.state = 'running'
            for update of a, j`,
            [input.purgeAttemptId, input.purgeJobId]
          );
          const attempt = active.rows[0];
          if (!attempt || attempt.attempt_number !== attempt.attempt_count) {
            throw new Error("Purge attempt is not the active job attempt");
          }
          const { decision } = await loadJobAndDecision(
            client,
            input.purgeJobId
          );
          const target = targetFromDecisionForJob(decision);
          const executableTarget = executablePurgeTarget(target);
          validatePurgeTargetAttempt(purgeTargetStrategies, executableTarget, {
            teamId: attempt.team_id
          });
          const policy = await client.query<
            QueryResultRow & { backup_retention_seconds: string | number }
          >(
            `select backup_retention_seconds
             from retention_policies
            where policy_id = $1 and version = $2
            limit 1`,
            [attempt.policy_id, attempt.policy_version]
          );
          const backupRetentionSeconds = numberFromDb(
            policy.rows[0]?.backup_retention_seconds ?? 0
          );
          const evidence = await client.query<EvidenceRow>(
            `select * from purge_job_evidence
            where purge_job_id = $1
            order by case artifact_kind
              when 'outbox_replay' then 1
              when 'vector' then 2
              when 'encrypted_payload' then 3
              when 'wrapped_key' then 4
              when 'search_index' then 5
              when 'database_row' then 6
              when 'backup_copy' then 7
              else 99
            end
            for update`,
            [input.purgeJobId]
          );
          validatePurgeTargetEvidenceArtifacts(
            purgeTargetStrategies,
            executableTarget,
            evidence.rows.map((row) => ({
              artifactKind: row.artifact_kind,
              artifactLocatorHash: row.artifact_locator_hash
            }))
          );
          const artifact = evidence.rows.find((candidate) => {
            const terminal =
              candidate.state === "verified" ||
              candidate.state === "not_applicable" ||
              (candidate.artifact_kind === "backup_copy" &&
                candidate.state === "scheduled_expiry" &&
                candidate.backup_expires_at != null);
            return !terminal;
          });
          if (artifact) {
            if (input.failBeforeArtifactKind === artifact.artifact_kind) {
              throw new PurgeArtifactProcessingError(
                {
                  artifactKind: artifact.artifact_kind,
                  artifactLocatorHash: artifact.artifact_locator_hash
                },
                { cause: new Error("Injected purge artifact failure") }
              );
            }
            const now = clock();
            if ((await activeHoldsForPurgeTarget(client, target)).length > 0) {
              await closeRunningAttemptsForHold(client, input.purgeJobId, now);
              const blocked = await client.query<JobRow>(
                `update purge_jobs
                  set state = 'blocked', next_attempt_at = $2, updated_at = $3
                where id = $1
                returning *`,
                [
                  input.purgeJobId,
                  new Date(now.getTime() + blockedHoldRecheckMs),
                  now
                ]
              );
              return { done: true as const, job: mapJob(blocked.rows[0]!) };
            }
            const backupExpiresAt = new Date(
              now.getTime() + backupRetentionSeconds * 1_000
            );
            requireValidDate("Backup expiry timestamp", backupExpiresAt);
            let cleanup: CleanupResult & {
              state: Exclude<PurgeEvidenceState, "pending" | "failed">;
              backupExpiresAt?: Date | null;
            };
            try {
              cleanup = await cleanupPurgeTargetArtifact(
                purgeTargetStrategies,
                client,
                {
                  target: executableTarget,
                  artifactKind: artifact.artifact_kind,
                  observedAt: now,
                  backupExpiresAt
                }
              );
            } catch (error) {
              throw new PurgeArtifactProcessingError(
                {
                  artifactKind: artifact.artifact_kind,
                  artifactLocatorHash: artifact.artifact_locator_hash
                },
                { cause: error }
              );
            }
            const evidenceHash = evidenceHashForArtifact({
              purgeJobId: input.purgeJobId,
              artifactKind: artifact.artifact_kind,
              artifactLocatorHash: artifact.artifact_locator_hash,
              state: cleanup.state,
              removedRecordCount: cleanup.removedRecordCount,
              removedByteCount: cleanup.removedByteCount,
              observedAt: now,
              backupExpiresAt: cleanup.backupExpiresAt ?? null
            });
            await client.query(
              `update purge_job_evidence
                set purge_attempt_id = $4, state = $5::purge_evidence_state,
                    removed_record_count = $6, removed_byte_count = $7,
                    evidence_hash = $8, backup_expires_at = $9,
                    verified_at = case
                      when $5::purge_evidence_state in ('verified', 'not_applicable') then $10
                      else verified_at
                    end,
                    updated_at = $10
              where id = $1 and purge_job_id = $2
                and artifact_locator_hash = $3`,
              [
                artifact.id,
                input.purgeJobId,
                artifact.artifact_locator_hash,
                input.purgeAttemptId,
                cleanup.state,
                cleanup.removedRecordCount,
                cleanup.removedByteCount,
                evidenceHash,
                cleanup.backupExpiresAt ?? null,
                now
              ]
            );
            await client.query(
              "update purge_jobs set updated_at = $2 where id = $1",
              [input.purgeJobId, now]
            );
            return { done: false as const };
          }
          const completedAt = clock();
          await client.query(
            `update purge_job_attempts
              set state = 'completed', completed_at = $3
            where id = $1 and purge_job_id = $2 and state = 'running'`,
            [input.purgeAttemptId, input.purgeJobId, completedAt]
          );
          const updated = await client.query<JobRow>(
            `update purge_jobs
              set state = 'retry_wait', next_attempt_at = $2,
                  updated_at = $2, resume_artifact_kind = null,
                  resume_cursor = null, terminal_error_code = null
            where id = $1
            returning *`,
            [input.purgeJobId, completedAt]
          );
          return { done: true as const, job: mapJob(updated.rows[0]!) };
        });
        if (result.done) return result.job;
      }
    },

    async checkpointPurgeAttempt(input) {
      const hasKind = input.resumeArtifactKind != null;
      const hasCursor = input.resumeCursor != null;
      if (hasKind !== hasCursor) {
        throw new Error(
          "Purge resume artifact and cursor must be set together"
        );
      }
      if (input.resumeCursor != null)
        requireNonEmpty("Purge resume cursor", input.resumeCursor);
      return withTransaction(pool, async (client) => {
        const locked = await client.query<
          QueryResultRow & { attempt_number: number; job_attempt_count: number }
        >(
          `select a.attempt_number, j.attempt_count as job_attempt_count
             from purge_job_attempts a
             join purge_jobs j on j.id = a.purge_job_id
            where a.id = $1 and a.purge_job_id = $2
              and a.state = 'running' and j.state = 'running'
            for update of a, j`,
          [input.purgeAttemptId, input.purgeJobId]
        );
        const current = locked.rows[0];
        if (!current || current.attempt_number !== current.job_attempt_count) {
          throw new Error("Purge attempt is not the active job attempt");
        }
        const now = clock();
        await client.query(
          `update purge_job_attempts
              set resume_artifact_kind = $2, resume_cursor = $3
            where id = $1`,
          [input.purgeAttemptId, input.resumeArtifactKind, input.resumeCursor]
        );
        const updated = await client.query<JobRow>(
          `update purge_jobs
              set resume_artifact_kind = $2, resume_cursor = $3, updated_at = $4
            where id = $1
            returning *`,
          [input.purgeJobId, input.resumeArtifactKind, input.resumeCursor, now]
        );
        return mapJob(updated.rows[0]!);
      });
    },

    async recordPurgeEvidence(input) {
      requireHash("Artifact locator hash", input.artifactLocatorHash);
      requireNonNegativeInteger(
        "Removed record count",
        input.removedRecordCount
      );
      requireNonNegativeInteger("Removed byte count", input.removedByteCount);
      const requiresProof = [
        "cleaned",
        "scheduled_expiry",
        "verified",
        "not_applicable"
      ].includes(input.state);
      if (requiresProof)
        requireHash("Purge evidence hash", input.evidenceHash ?? "");
      if (!requiresProof && input.evidenceHash != null) {
        throw new Error("Failed purge evidence cannot carry a proof hash");
      }
      if (input.state === "scheduled_expiry") {
        if (!input.backupExpiresAt) {
          throw new Error(
            "Scheduled backup expiry requires an expiry timestamp"
          );
        }
        requireValidDate("Backup expiry timestamp", input.backupExpiresAt);
      } else if (input.backupExpiresAt != null) {
        throw new Error(
          "Backup expiry is only valid for scheduled expiry evidence"
        );
      }
      return withTransaction(pool, async (client) => {
        const active = await client.query(
          `select 1
             from purge_job_attempts a
             join purge_jobs j on j.id = a.purge_job_id
            where a.id = $1 and a.purge_job_id = $2
              and a.state = 'running' and j.state = 'running'
              and a.attempt_number = j.attempt_count
            for update of a, j`,
          [input.purgeAttemptId, input.purgeJobId]
        );
        if (!active.rowCount) throw new Error("Purge attempt is not active");
        const currentResult = await client.query<EvidenceRow>(
          `select * from purge_job_evidence
            where purge_job_id = $1 and artifact_kind = $2
              and artifact_locator_hash = $3
            for update`,
          [input.purgeJobId, input.artifactKind, input.artifactLocatorHash]
        );
        const current = currentResult.rows[0];
        if (!current)
          throw new Error("Artifact is not required by this purge job");
        if (["verified", "not_applicable"].includes(current.state)) {
          const isIdempotent =
            current.state === input.state &&
            numberFromDb(current.removed_record_count) ===
              input.removedRecordCount &&
            numberFromDb(current.removed_byte_count) ===
              input.removedByteCount &&
            current.evidence_hash === (input.evidenceHash ?? null);
          if (!isIdempotent) {
            throw new Error("Verified purge evidence is immutable");
          }
          return mapEvidence(current);
        }
        const observedAt = input.observedAt ?? clock();
        requireValidDate("Purge evidence timestamp", observedAt);
        const verifiedAt = ["verified", "not_applicable"].includes(input.state)
          ? observedAt
          : null;
        const updated = await client.query<EvidenceRow>(
          `update purge_job_evidence
              set purge_attempt_id = $4, state = $5, removed_record_count = $6,
                  removed_byte_count = $7, evidence_hash = $8,
                  backup_expires_at = $9, verified_at = $10, updated_at = $11
            where id = $1 and purge_job_id = $2 and artifact_locator_hash = $3
            returning *`,
          [
            current.id,
            input.purgeJobId,
            input.artifactLocatorHash,
            input.purgeAttemptId,
            input.state,
            input.removedRecordCount,
            input.removedByteCount,
            input.evidenceHash ?? null,
            input.backupExpiresAt ?? null,
            verifiedAt,
            observedAt
          ]
        );
        await client.query(
          "update purge_jobs set updated_at = $2 where id = $1",
          [input.purgeJobId, observedAt]
        );
        return mapEvidence(updated.rows[0]!);
      });
    },

    async finishPurgeAttempt(input) {
      const resumeArtifactKind = input.resumeArtifactKind ?? null;
      const resumeCursor = input.resumeCursor ?? null;
      if ((resumeArtifactKind == null) !== (resumeCursor == null)) {
        throw new Error(
          "Purge resume artifact and cursor must be set together"
        );
      }
      const hasError = input.errorCode != null || input.errorHash != null;
      if (input.outcome === "completed" && hasError) {
        throw new Error("A completed purge attempt cannot carry an error");
      }
      if (input.outcome !== "completed") {
        requireNonEmpty("Purge error code", input.errorCode ?? "");
        requireHash("Purge error hash", input.errorHash ?? "");
      }
      return withTransaction(pool, async (client) => {
        const active = await client.query<
          QueryResultRow & { attempt_number: number; attempt_count: number }
        >(
          `select a.attempt_number, j.attempt_count
             from purge_job_attempts a
             join purge_jobs j on j.id = a.purge_job_id
            where a.id = $1 and a.purge_job_id = $2
              and a.state = 'running' and j.state = 'running'
            for update of a, j`,
          [input.purgeAttemptId, input.purgeJobId]
        );
        const row = active.rows[0];
        if (!row || row.attempt_number !== row.attempt_count) {
          throw new Error("Purge attempt is not the active job attempt");
        }
        const now = clock();
        await client.query(
          `update purge_job_attempts
              set state = $2, completed_at = $3, resume_artifact_kind = $4,
                  resume_cursor = $5, error_code = $6, error_hash = $7
            where id = $1`,
          [
            input.purgeAttemptId,
            input.outcome,
            now,
            resumeArtifactKind,
            resumeCursor,
            input.errorCode ?? null,
            input.errorHash ?? null
          ]
        );
        const jobState =
          input.outcome === "terminal_failure" ? "failed" : "retry_wait";
        const nextAttemptAt =
          input.outcome === "terminal_failure" ? null : (input.retryAt ?? now);
        const updated = await client.query<JobRow>(
          `update purge_jobs
              set state = $2, resume_artifact_kind = $3, resume_cursor = $4,
                  next_attempt_at = $5, terminal_error_code = $6,
                  updated_at = $7
            where id = $1
            returning *`,
          [
            input.purgeJobId,
            jobState,
            resumeArtifactKind,
            resumeCursor,
            nextAttemptAt,
            input.outcome === "terminal_failure" ? input.errorCode : null,
            now
          ]
        );
        if (input.outcome === "terminal_failure") {
          const decisionResult = await client.query<DecisionRow>(
            `select decision.*
               from retention_decisions decision
               join purge_jobs job on job.retention_decision_id = decision.id
              where job.id = $1
              for share of decision`,
            [input.purgeJobId]
          );
          const decision = decisionResult.rows[0];
          if (!decision) throw new Error("Retention decision not found");
          const target = targetFromDecisionRow(decision);
          await client.query(
            `insert into audit_events (
               actor_user_id, action, target_table, target_id, metadata
             ) values (
               null, 'retention.purge_terminal_failure',
               'purge_jobs', $1, $2::jsonb
             )`,
            [
              input.purgeJobId,
              JSON.stringify({
                purgeJobId: input.purgeJobId,
                targetKind: target.kind,
                targetId: target.targetId,
                ...(target.kind === "owner_private_replica"
                  ? {}
                  : { teamId: target.teamId }),
                attemptNumber: numberFromDb(row.attempt_count),
                artifactKind: resumeArtifactKind,
                errorCode: input.errorCode,
                errorHash: input.errorHash,
                terminalAt: now.toISOString()
              })
            ]
          );
        }
        return mapJob(updated.rows[0]!);
      });
    },

    async completePurgeJob(purgeJobId) {
      return withTransaction(pool, async (client) => {
        const scope = await client.query<DecisionRow>(
          `select decision.*
             from purge_jobs job
             join retention_decisions decision
               on decision.id = job.retention_decision_id
            where job.id = $1`,
          [purgeJobId]
        );
        if (!scope.rows[0]) throw new Error("Purge job not found");
        await lockScopeKeys(
          client,
          scopeKeysForDecisionTarget(targetFromDecisionRow(scope.rows[0]))
        );
        const scopeTarget = targetFromDecisionRow(scope.rows[0]);
        if (isExecutablePurgeTarget(scopeTarget)) {
          await lockPurgeTarget(purgeTargetStrategies, client, scopeTarget);
        }
        const { job, decision } = await loadJobAndDecision(client, purgeJobId);
        if (job.state === "verified") {
          return { completed: true, job: mapJob(job) };
        }
        if (["pending", "canceled", "failed"].includes(job.state)) {
          return { completed: false, reason: "job_not_completable" };
        }
        const target = targetFromDecisionForJob(decision);
        if ((await activeHoldsForPurgeTarget(client, target)).length > 0) {
          const now = clock();
          await closeRunningAttemptsForHold(client, purgeJobId, now);
          await client.query(
            `update purge_jobs
                set state = 'blocked', next_attempt_at = $2, updated_at = $3
              where id = $1`,
            [purgeJobId, new Date(now.getTime() + blockedHoldRecheckMs), now]
          );
          return { completed: false, reason: "active_legal_hold" };
        }
        const running = await client.query(
          "select 1 from purge_job_attempts where purge_job_id = $1 and state = 'running' limit 1 for update",
          [purgeJobId]
        );
        if (running.rowCount) {
          return { completed: false, reason: "active_attempt" };
        }
        const evidence = await client.query<EvidenceRow>(
          "select * from purge_job_evidence where purge_job_id = $1 order by artifact_kind, artifact_locator_hash for update",
          [purgeJobId]
        );
        if (evidence.rows.length === 0) {
          return { completed: false, reason: "missing_evidence" };
        }
        const unverifiedArtifacts = evidence.rows
          .filter(
            (row) =>
              !(
                row.state === "verified" ||
                row.state === "not_applicable" ||
                (row.artifact_kind === "backup_copy" &&
                  row.state === "scheduled_expiry" &&
                  row.backup_expires_at != null)
              )
          )
          .map((row) => ({
            artifactKind: row.artifact_kind,
            artifactLocatorHash: row.artifact_locator_hash
          }));
        if (unverifiedArtifacts.length > 0) {
          return {
            completed: false,
            reason: "unverified_artifacts",
            unverifiedArtifacts
          };
        }
        const now = clock();
        const completionContext = {
          retentionDecisionId: job.retention_decision_id,
          purgeJobId,
          completedAt: now,
          verifiedArtifactCount: evidence.rows.length
        };
        if (isExecutablePurgeTarget(target)) {
          await preparePurgeTargetCompletion(
            purgeTargetStrategies,
            client,
            target,
            completionContext
          );
        }
        const completed = await client.query<JobRow>(
          `update purge_jobs
              set state = 'verified', verified_at = $2, updated_at = $2,
                  next_attempt_at = null, resume_artifact_kind = null,
                  resume_cursor = null, terminal_error_code = null
            where id = $1
            returning *`,
          [purgeJobId, now]
        );
        if (isExecutablePurgeTarget(target)) {
          await recordPurgeTargetCompletion(
            purgeTargetStrategies,
            client,
            target,
            completionContext
          );
        }
        return { completed: true, job: mapJob(completed.rows[0]!) };
      });
    }
  };
};
