import type {
  MemorySourceRepository,
  SharedMemoryFidelityChangeReviewRecord,
  SharedMemoryPendingShareReviewRecord,
  SharedMemoryRevokeReviewRecord
} from "@koed/db";
import {
  sharedMemoryFidelityBundleActionGrantBinding,
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryCandidatePreviewActionGrantBinding,
  sharedMemoryPendingShareActionGrantBinding,
  sharedMemoryConversationRuleCreationActionGrantBinding,
  sharedMemoryRepositoryRuleCreationActionGrantBinding,
  sharedMemoryPublisherTakeoverActionGrantBinding,
  sharingRulePublisherTakeoverIntentSchema,
  sharingRulePublisherTakeoverReviewInputSchema,
  repositorySharingRuleCreationIntentSchema,
  repositorySharingRuleCreationReviewSchema,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryWorkspaceRestorationActionGrantBinding,
  workspaceConversationRestorationIntentSchema,
  sharedMemoryWorkspaceExclusionActionGrantBinding,
  workspaceConversationExclusionIntentSchema,
  sharedMemoryRuleControlActionGrantBinding,
  sharedMemoryRuleDetailActionGrantBinding,
  sharedMemoryRuleContentPolicyActionGrantBinding,
  sharingRuleDetailReviewInputSchema,
  sharingRuleContentPolicyReviewInputSchema,
  privacyLabels,
  sharedMemoryRepositoryRuleControlActionGrantBinding,
  repositorySharingRuleControlIntentSchema,
  sharedMemoryRepositorySnapshotActionGrantBinding,
  crossIdentitySyncDigest,
  sharedMemoryTranscriptAccessActionGrantBinding,
  sharedMemoryTranscriptRevokeActionGrantBinding,
  type SharedMemoryRepresentation,
  type CollaborationApprovalReview,
  type SharedMemoryFidelityCeiling
} from "@koed/shared";

import type { ActionApprovalPolicy } from "./approval-policy.js";
import {
  requireActionReview,
  reviewedAction
} from "./action-definition-support.js";
import type {
  HighRiskActionGrantIntent,
  HighRiskResolvedActionGrantOperation
} from "./action-grant-protocol.js";

type SharedMemoryAction =
  | "shared_memory.candidate_preview"
  | "shared_memory.pending_share"
  | "shared_memory.conversation_rule_create"
  | "shared_memory.repository_rule_create"
  | "shared_memory.preview"
  | "shared_memory.rule_control"
  | "shared_memory.rule_detail"
  | "shared_memory.rule_content_policy"
  | "shared_memory.repository_rule_control"
  | "shared_memory.publisher_takeover"
  | "shared_memory.revoke"
  | "shared_memory.workspace_restore"
  | "shared_memory.workspace_exclude"
  | "shared_memory.update_repository_snapshot"
  | "shared_memory.conversation_source_grant"
  | "shared_memory.conversation_source_revoke"
  | "shared_memory.change_fidelity";

export type SharedMemoryActionIntent = Extract<
  HighRiskActionGrantIntent,
  { action: SharedMemoryAction }
>;

type SharedMemoryActionRepository = Pick<
  MemorySourceRepository,
  | "getSharedMemoryPreviewAdmission"
  | "getSharedMemoryCandidatePreviewAdmission"
  | "getSharedMemoryPendingShareReview"
  | "getConversationSharingRuleControlReview"
  | "getSharingRuleDetailReview"
  | "getSharingRuleContentPolicyReview"
  | "getSharingRulePublisherTakeoverReview"
  | "getConversationSharingRuleCreationReview"
  | "getRepositorySharingRuleCreationReview"
  | "getRepositorySharingRuleControlReview"
  | "getSharedMemoryRevokeReview"
  | "getWorkspaceConversationRestorationReview"
  | "getWorkspaceConversationExclusionReview"
  | "reviewGrantRepositorySnapshot"
  | "getSharedMemoryFidelityChangeReview"
  | "getTeamConversationSourceGrantReview"
>;

interface SharedMemoryAdmissionInput {
  repository: SharedMemoryActionRepository;
  userId: string;
  clientRequestId: string;
  currentDeviceCredentialId?: string;
  intent: HighRiskActionGrantIntent;
}

const requireReview = <T>(value: T | null, context: string): T =>
  requireActionReview(
    value,
    `${context} requires complete current source-owner, destination, preview, policy, and grant context`
  );

export const bindSharedMemoryPublisherTakeoverOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.publisher_takeover" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryPublisherTakeoverActionGrantBinding({
    ...sharingRulePublisherTakeoverIntentSchema.strip().parse(intent),
    referenceId
  });

const reviewed = (
  disposition: "native_review" | "step_up",
  review: Omit<CollaborationApprovalReview, "version">
): ActionApprovalPolicy => reviewedAction(disposition, review);

const fidelityRank: Record<SharedMemoryFidelityCeiling, number> = {
  lcm_rollups: 0,
  lcm_leaves: 1,
  memory_events: 2
};

const representationLabel = (
  representation: SharedMemoryRepresentation
): string => {
  switch (representation) {
    case "memory_events":
      return "Memory Events";
    case "lcm_leaves":
      return "LCM Leaves";
    case "lcm_rollups":
      return "LCM Rollups";
    case "curated_assertions":
      return "Curated Assertions";
  }
};

const fidelityLabel = (fidelity: SharedMemoryFidelityCeiling): string =>
  representationLabel(fidelity);

const curatedMemoryLabel = (included: boolean): string =>
  included ? "Included" : "Excluded";

const sourceName = (review: {
  source: { title: string; logicalMemoryId: string };
}): string => review.source.title.trim() || "Captured Session";

export const bindSharedMemoryPreviewOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.preview" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryPreviewActionGrantBinding({
    referenceId,
    source: intent.source,
    sourceCapabilities: intent.sourceCapabilities,
    logicalMemoryId: intent.logicalMemoryId,
    remoteReplicaId: intent.remoteReplicaId,
    teamId: intent.teamId,
    teamWorkspaceId: intent.teamWorkspaceId,
    activationRepresentation: intent.activationRepresentation,
    maximumFidelity: intent.maximumFidelity,
    includeCuratedMemory: intent.includeCuratedMemory,
    mode: intent.mode
  });

export const bindSharedMemoryCandidatePreviewOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.candidate_preview" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryCandidatePreviewActionGrantBinding({
    referenceId,
    source: intent.source,
    sourceDeploymentProtocolId: intent.sourceDeploymentProtocolId,
    sourceOwnerPrincipalId: intent.sourceOwnerPrincipalId,
    sourceCapabilities: intent.sourceCapabilities,
    logicalMemoryId: intent.logicalMemoryId,
    candidateHash: intent.candidateHash,
    sourceRevision: intent.sourceRevision,
    itemCount: intent.itemCount,
    excludedItemCount: intent.excludedItemCount,
    manifest: intent.manifest,
    byteCount: intent.byteCount,
    teamId: intent.teamId,
    teamWorkspaceId: intent.teamWorkspaceId,
    activationRepresentation: intent.activationRepresentation,
    maximumFidelity: intent.maximumFidelity,
    includeCuratedMemory: intent.includeCuratedMemory,
    mode: intent.mode,
    expiresAt: intent.expiresAt
  });

export const bindSharedMemoryPendingShareOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.pending_share" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryPendingShareActionGrantBinding({
    referenceId,
    source: intent.source,
    sourceCapabilities: intent.sourceCapabilities,
    activationRepresentation: intent.activationRepresentation,
    mutationId: intent.mutationId,
    logicalGrantId: intent.logicalGrantId,
    expectedGrantVersion: intent.expectedGrantVersion,
    logicalMemoryId: intent.logicalMemoryId,
    teamId: intent.teamId,
    teamWorkspaceId: intent.teamWorkspaceId,
    consentId: intent.consentId,
    previewId: intent.previewId,
    mode: intent.mode,
    maximumFidelity: intent.maximumFidelity,
    includeCuratedMemory: intent.includeCuratedMemory,
    previewRevision: intent.previewRevision,
    previewHash: intent.previewHash,
    expiresAt: intent.expiresAt
  });

export const bindSharedMemoryConversationRuleCreationOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.conversation_rule_create" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryConversationRuleCreationActionGrantBinding({
    ...intent,
    referenceId
  });

export const bindSharedMemoryRepositoryRuleCreationOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.repository_rule_create" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation => {
  const scope = repositorySharingRuleCreationIntentSchema.strip().parse(intent);
  return sharedMemoryRepositoryRuleCreationActionGrantBinding({
    ...scope,
    referenceId
  });
};

export const bindSharedMemoryRuleControlOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.rule_control" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation => {
  return sharedMemoryRuleControlActionGrantBinding({ ...intent, referenceId });
};
export const bindSharedMemoryRuleDetailOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.rule_detail" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryRuleDetailActionGrantBinding({
    mutationId: intent.mutationId,
    review: intent.review,
    referenceId
  });
export const bindSharedMemoryRuleContentPolicyOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.rule_content_policy" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryRuleContentPolicyActionGrantBinding({
    mutationId: intent.mutationId,
    review: intent.review,
    referenceId
  });
export const bindSharedMemoryRepositoryRuleControlOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.repository_rule_control" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryRepositoryRuleControlActionGrantBinding({
    ...repositorySharingRuleControlIntentSchema.strip().parse(intent),
    referenceId
  });

export const bindSharedMemoryRevokeOperation = (
  intent: Extract<SharedMemoryActionIntent, { action: "shared_memory.revoke" }>,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryRevokeActionGrantBinding({
    referenceId,
    mutationId: intent.mutationId,
    teamId: intent.teamId,
    teamWorkspaceId: intent.teamWorkspaceId,
    shareGrantId: intent.shareGrantId,
    expectedGrantVersion: intent.expectedGrantVersion,
    reasonCode: intent.reasonCode
  });

export const bindSharedMemoryWorkspaceRestorationOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.workspace_restore" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryWorkspaceRestorationActionGrantBinding({
    ...workspaceConversationRestorationIntentSchema.strip().parse(intent),
    referenceId
  });

export const bindSharedMemoryWorkspaceExclusionOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.workspace_exclude" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryWorkspaceExclusionActionGrantBinding({
    ...workspaceConversationExclusionIntentSchema.strip().parse(intent),
    referenceId
  });

export const bindSharedMemoryRepositorySnapshotOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.update_repository_snapshot" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryRepositorySnapshotActionGrantBinding({ ...intent, referenceId });

export const bindSharedMemoryFidelityChangeOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.change_fidelity" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryFidelityBundleActionGrantBinding({
    referenceId,
    source: intent.source,
    sourceCapabilities: intent.sourceCapabilities,
    activationRepresentation: intent.activationRepresentation,
    mutationId: intent.mutationId,
    logicalMemoryId: intent.logicalMemoryId,
    teamId: intent.teamId,
    teamWorkspaceId: intent.teamWorkspaceId,
    shareGrantId: intent.shareGrantId,
    consentId: intent.consentId,
    previewId: intent.previewId,
    expectedGrantVersion: intent.expectedGrantVersion,
    mode: intent.mode,
    maximumFidelity: intent.maximumFidelity,
    includeCuratedMemory: intent.includeCuratedMemory,
    previewRevision: intent.previewRevision,
    previewHash: intent.previewHash,
    expiresAt: intent.expiresAt
  });

export const bindConversationSourceGrantOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.conversation_source_grant" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryTranscriptAccessActionGrantBinding({
    referenceId,
    mutationId: intent.mutationId,
    teamId: intent.teamId,
    shareGrantId: intent.shareGrantId,
    expectedVersion: intent.expectedVersion,
    mode: intent.mode
  });

export const bindConversationSourceRevokeOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.conversation_source_revoke" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryTranscriptRevokeActionGrantBinding({
    referenceId,
    mutationId: intent.mutationId,
    teamId: intent.teamId,
    shareGrantId: intent.shareGrantId,
    expectedVersion: intent.expectedVersion,
    reasonCode: intent.reasonCode
  });

const shareReview = (
  review: SharedMemoryPendingShareReviewRecord,
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.pending_share" }
  >
): ActionApprovalPolicy =>
  reviewed(
    intent.maximumFidelity === "memory_events" ? "step_up" : "native_review",
    {
      title:
        intent.expectedGrantVersion != null
          ? "Add a fixed snapshot to this Workspace?"
          : "Share Personal Memory with this Workspace?",
      description:
        intent.expectedGrantVersion != null
          ? "This adds a separately approved fixed snapshot to the existing contribution. Independent sharing rules keep their own consent, detail, and lifecycle."
          : review.sourceOwnerPolicyWillActivate
            ? "One decision activates the reviewed source policy, records exact consent, and creates the corresponding Share Grant."
            : "One decision records the exact source-owner consent and creates the corresponding Share Grant.",
      consequence: review.sourceOwnerPolicyWillReplace
        ? "This expands the owner policy ceiling for the approved detail. Existing sharing reasons retain their own consent limits."
        : "Authorized Workspace members can recall every complete Memory layer through the approved maximum fidelity under the exact mode and expiry.",
      confirmLabel:
        intent.expectedGrantVersion != null
          ? "Add fixed snapshot"
          : "Share Memory",
      details: [
        { label: "Personal Memory", value: sourceName(review) },
        { label: "Logical Memory", value: review.source.logicalMemoryId },
        { label: "Team", value: review.team.name },
        { label: "Workspace", value: review.workspace.name },
        {
          label: "Maximum fidelity",
          value: fidelityLabel(intent.maximumFidelity)
        },
        {
          label: "Curated Memory",
          value: curatedMemoryLabel(intent.includeCuratedMemory)
        },
        { label: "Mode", value: intent.mode },
        { label: "Expiry", value: intent.expiresAt ?? "No expiry" },
        ...(review.sourceOwnerPolicyWillActivate
          ? [
              {
                label: "Source policy",
                value: review.sourceOwnerPolicyWillReplace
                  ? "Expand during this share"
                  : "Activate during this share"
              }
            ]
          : [])
      ]
    }
  );

const previewPolicy = (): ActionApprovalPolicy => ({
  disposition: "direct",
  review: null
});

const revokeReview = (
  review: SharedMemoryRevokeReviewRecord,
  intent: Extract<SharedMemoryActionIntent, { action: "shared_memory.revoke" }>
): ActionApprovalPolicy =>
  reviewed("native_review", {
    title: "Revoke Shared Memory access?",
    description:
      "Remove ordinary Team recall through this Share Grant without deleting the source from Personal Memory.",
    consequence:
      "Independent sync and retention policy remain separate lifecycle boundaries.",
    confirmLabel: "Revoke access",
    details: [
      { label: "Personal Memory", value: sourceName(review) },
      { label: "Logical Memory", value: review.source.logicalMemoryId },
      { label: "Team", value: review.team.name },
      { label: "Workspace", value: review.workspace.name },
      {
        label: "Maximum fidelity",
        value: fidelityLabel(review.grant.maximumFidelity)
      },
      {
        label: "Curated Memory",
        value: curatedMemoryLabel(review.grant.includeCuratedMemory)
      },
      { label: "Share Grant", value: intent.shareGrantId }
    ]
  });

const fidelityChangeReview = (
  review: SharedMemoryFidelityChangeReviewRecord,
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.change_fidelity" }
  >
): ActionApprovalPolicy => {
  const increases =
    fidelityRank[intent.maximumFidelity] >
      fidelityRank[review.grant.maximumFidelity] ||
    (!review.grant.includeCuratedMemory && intent.includeCuratedMemory);
  const changesFidelity =
    review.grant.maximumFidelity !== intent.maximumFidelity ||
    review.grant.includeCuratedMemory !== intent.includeCuratedMemory;
  const updatesSourceOnly = review.sourceRevisionChanged && !changesFidelity;
  return reviewed(increases ? "step_up" : "native_review", {
    title: review.willReactivate
      ? "Reactivate Shared Memory with this fidelity?"
      : updatesSourceOnly
        ? "Share this newer Memory revision?"
        : "Change the Shared Memory fidelity?",
    description: review.sourceOwnerPolicyWillActivate
      ? "Compare the current and proposed detail. This decision also activates the reviewed source policy."
      : updatesSourceOnly
        ? "Replace the Workspace copy with the reviewed newer source revision."
        : "Compare the current and proposed level of Memory detail.",
    consequence: review.sourceOwnerPolicyWillReplace
      ? "This expands the owner policy ceiling for the approved detail. Independent sharing reasons keep their current consent and published content."
      : review.willReactivate
        ? "This reactivates the Share Grant and restores the approved cumulative Memory layers."
        : updatesSourceOnly
          ? "The existing Share Grant keeps its identity while the Workspace copy advances to this revision."
          : increases
            ? "This makes more detailed Memory or Curated Memory available to the Workspace."
            : "This reduces the detail available and purges unauthorized higher-fidelity cached content.",
    confirmLabel: review.willReactivate
      ? "Reactivate Share Grant"
      : updatesSourceOnly
        ? "Share newer revision"
        : "Change fidelity",
    details: [
      { label: "Personal Memory", value: sourceName(review) },
      { label: "Logical Memory", value: review.source.logicalMemoryId },
      { label: "Team", value: review.team.name },
      { label: "Workspace", value: review.workspace.name },
      {
        label: "Current maximum fidelity",
        value: fidelityLabel(review.grant.maximumFidelity)
      },
      {
        label: "New maximum fidelity",
        value: fidelityLabel(intent.maximumFidelity)
      },
      {
        label: "Current Curated Memory",
        value: curatedMemoryLabel(review.grant.includeCuratedMemory)
      },
      {
        label: "New Curated Memory",
        value: curatedMemoryLabel(intent.includeCuratedMemory)
      },
      ...(review.sourceRevisionChanged
        ? [
            {
              label: "Current source revision",
              value: String(review.grant.sourceRevision)
            },
            {
              label: "New source revision",
              value: String(review.preview.sourceRevision)
            }
          ]
        : []),
      { label: "Mode", value: intent.mode },
      { label: "Expiry", value: intent.expiresAt ?? "No expiry" }
    ]
  });
};

const previewDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.preview") return null;
    requireReview(
      await input.repository.getSharedMemoryPreviewAdmission(
        { userId: input.userId },
        {
          logicalMemoryId: input.intent.logicalMemoryId,
          remoteReplicaId: input.intent.remoteReplicaId,
          teamId: input.intent.teamId,
          teamWorkspaceId: input.intent.teamWorkspaceId,
          representation: input.intent.activationRepresentation,
          maximumFidelity: input.intent.maximumFidelity,
          includeCuratedMemory: input.intent.includeCuratedMemory
        }
      ),
      "Shared Memory preview"
    );
    return {
      operation: bindSharedMemoryPreviewOperation(
        input.intent,
        input.clientRequestId
      ),
      policy: previewPolicy()
    };
  }
};

const candidatePreviewDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.candidate_preview") return null;
    const admitted =
      await input.repository.getSharedMemoryCandidatePreviewAdmission(
        { userId: input.userId },
        {
          teamId: input.intent.teamId,
          teamWorkspaceId: input.intent.teamWorkspaceId,
          representation: input.intent.activationRepresentation,
          maximumFidelity: input.intent.maximumFidelity,
          includeCuratedMemory: input.intent.includeCuratedMemory
        }
      );
    requireReview(admitted, "Shared Memory candidate preview");
    return {
      operation: bindSharedMemoryCandidatePreviewOperation(
        input.intent,
        input.clientRequestId
      ),
      policy: previewPolicy()
    };
  }
};

const pendingShareDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.pending_share") return null;
    const review = requireReview(
      await input.repository.getSharedMemoryPendingShareReview(
        { userId: input.userId },
        {
          logicalMemoryId: input.intent.logicalMemoryId,
          logicalGrantId: input.intent.logicalGrantId,
          expectedGrantVersion: input.intent.expectedGrantVersion,
          teamId: input.intent.teamId,
          teamWorkspaceId: input.intent.teamWorkspaceId,
          consentId: input.intent.consentId,
          preview: {
            previewId: input.intent.previewId,
            previewHash: input.intent.previewHash
          },
          previewRevision: input.intent.previewRevision,
          maximumFidelity: input.intent.maximumFidelity,
          includeCuratedMemory: input.intent.includeCuratedMemory,
          expiresAt: input.intent.expiresAt
        }
      ),
      "Pending Share acceptance"
    );
    return {
      operation: bindSharedMemoryPendingShareOperation(
        input.intent,
        input.clientRequestId
      ),
      policy: shareReview(review, input.intent)
    };
  }
};

const conversationRuleCreationDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.conversation_rule_create")
      return null;
    const intent = input.intent;
    const review = requireReview(
      await input.repository.getConversationSharingRuleCreationReview(
        { userId: input.userId },
        {
          ...(intent.snapshotConversion
            ? { snapshotReasonId: intent.snapshotConversion.reasonId }
            : {}),
          previewId: intent.previewId,
          previewHash: intent.previewHash,
          previewRevision: intent.previewRevision,
          logicalMemoryId: intent.logicalMemoryId,
          teamId: intent.teamId,
          teamWorkspaceId: intent.teamWorkspaceId
        }
      ),
      "Continuous Conversation rule creation"
    );
    const expected = {
      snapshotConversion: intent.snapshotConversion ?? null,
      logicalMemoryId: intent.logicalMemoryId,
      teamId: intent.teamId,
      teamWorkspaceId: intent.teamWorkspaceId,
      previewId: intent.previewId,
      previewHash: intent.previewHash,
      previewRevision: intent.previewRevision,
      source: intent.source,
      sourceCapabilities: intent.sourceCapabilities,
      activationRepresentation: intent.activationRepresentation,
      logicalGrantId: intent.logicalGrantId,
      expectedGrantVersion: intent.expectedGrantVersion,
      effectivePrivacyPolicyHash: intent.effectivePrivacyPolicyHash,
      maximumFidelity: intent.maximumFidelity,
      includeCuratedMemory: intent.includeCuratedMemory,
      expiresAt: intent.expiresAt
    };
    const actual = {
      snapshotConversion: review.snapshotConversion ?? null,
      logicalMemoryId: review.logicalMemoryId,
      teamId: review.teamId,
      teamWorkspaceId: review.teamWorkspaceId,
      previewId: review.previewId,
      previewHash: review.previewHash,
      previewRevision: review.previewRevision,
      source: review.source,
      sourceCapabilities: review.sourceCapabilities,
      activationRepresentation: review.activationRepresentation,
      logicalGrantId: review.logicalGrantId,
      expectedGrantVersion: review.expectedGrantVersion,
      effectivePrivacyPolicyHash: review.effectivePrivacyPolicyHash,
      maximumFidelity: review.maximumFidelity,
      includeCuratedMemory: review.includeCuratedMemory,
      expiresAt: review.expiresAt
    };
    requireReview(
      crossIdentitySyncDigest(expected) === crossIdentitySyncDigest(actual)
        ? review
        : null,
      "Exact continuous rule scope"
    );
    return {
      operation: bindSharedMemoryConversationRuleCreationOperation(
        intent,
        input.clientRequestId
      ),
      policy: reviewed(
        intent.maximumFidelity === "memory_events"
          ? "step_up"
          : "native_review",
        {
          title: review.snapshotConversion
            ? "Convert this snapshot to continuous sharing?"
            : "Share this Conversation continuously?",
          description:
            "This rule shares existing eligible Memory and later eligible turns and completed summaries from this Conversation.",
          consequence: review.snapshotConversion
            ? "Only this Conversation becomes continuous. The selected fixed snapshot stays available until publication is ready, then its direct consent is retired. Other sharing reasons and Conversation Source Access keep their own authority."
            : "Existing sharing reasons keep their own consent limits. Pause retains previously shared Memory. Stop removes only this rule's access.",
          confirmLabel: review.snapshotConversion
            ? "Convert snapshot"
            : "Start continuous sharing",
          details: [
            ...(review.snapshotConversion
              ? [
                  {
                    label: "Snapshot revision",
                    value: String(review.snapshotConversion.sourceRevision)
                  }
                ]
              : []),
            { label: "Conversation", value: review.sourceTitle },
            { label: "Logical Memory", value: review.logicalMemoryId },
            { label: "Team", value: review.teamName },
            { label: "Workspace", value: review.workspaceName },
            {
              label: "Maximum fidelity",
              value: fidelityLabel(review.maximumFidelity)
            },
            {
              label: "Curated Memory",
              value: curatedMemoryLabel(review.includeCuratedMemory)
            },
            {
              label: "Scope",
              value: "This Conversation only, including later eligible content"
            },
            {
              label: "Privacy policy",
              value: review.effectivePrivacyPolicyHash
            },
            { label: "Expiry", value: review.expiresAt ?? "No expiry" }
          ]
        }
      )
    };
  }
};

const ruleControlDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.rule_control") return null;
    const intent = input.intent;
    const review = requireReview(
      await input.repository.getConversationSharingRuleControlReview(
        { userId: input.userId },
        { ...intent, action: intent.controlAction }
      ),
      "Continuous sharing rule control"
    );
    const labels = {
      pause: "Pause updates",
      resume: "Resume updates",
      stop: "Stop this rule",
      retry: "Retry catch-up"
    };
    const consequences = {
      pause:
        "Previously shared content remains available. This rule will publish no new content while paused.",
      resume:
        "Catch up currently eligible content and follow later turns and completed summaries within this rule's approved detail and policy.",
      stop: "Remove the access supplied by this rule. Independently authorized sharing and separately approved Conversation Source Access remain unchanged.",
      retry:
        "Retry eligible catch-up under this rule's existing consent. New content appears after processing."
    };
    return {
      operation: bindSharedMemoryRuleControlOperation(
        intent,
        input.clientRequestId
      ),
      policy: reviewed("native_review", {
        title: `${labels[intent.controlAction]}?`,
        description:
          "Apply this action to one Conversation sharing rule in one Workspace.",
        consequence: consequences[intent.controlAction],
        confirmLabel: labels[intent.controlAction],
        details: [
          { label: "Conversation", value: review.sourceTitle },
          { label: "Logical Memory", value: review.logicalMemoryId },
          { label: "Team", value: review.team.name },
          { label: "Workspace", value: review.workspace.name },
          {
            label: "Shared detail",
            value: fidelityLabel(review.maximumFidelity)
          },
          {
            label: "Curated Memory",
            value: curatedMemoryLabel(review.includeCuratedMemory)
          },
          { label: "Current state", value: review.state },
          { label: "Sharing rule", value: review.ruleId }
        ]
      })
    };
  }
};

const repositoryRuleControlDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.repository_rule_control")
      return null;
    const intent = input.intent;
    const review = requireReview(
      await input.repository.getRepositorySharingRuleControlReview(
        { userId: input.userId },
        intent
      ),
      "Selection sharing rule control"
    );
    const labels = {
      pause: "Pause updates",
      resume: "Resume updates",
      stop: "Stop this rule",
      retry: "Retry catch-up"
    };
    return {
      operation: bindSharedMemoryRepositoryRuleControlOperation(
        intent,
        input.clientRequestId
      ),
      policy: reviewed("native_review", {
        title: `${labels[intent.controlAction]}?`,
        description: `Apply this action to this ${review.selector.kind === "folder" ? "Folder" : review.selector.kind === "project" ? "Project" : "Git Anchor"} rule and all of its Conversation memberships in one Workspace.`,
        consequence:
          intent.controlAction === "pause"
            ? "Previously shared content remains available. No new members or revisions will publish while paused. Sources that stop matching still lose this rule's access."
            : intent.controlAction === "stop"
              ? "Remove this rule's access across all members and prevent future admission. Independent sharing and separately approved Conversation Source Access remain unchanged."
              : "Catch up eligible members and future matching Conversations within the existing approved detail and current policies. New content appears after processing.",
        confirmLabel: labels[intent.controlAction],
        details: [
          {
            label:
              review.selector.kind === "folder"
                ? "Folder identity"
                : review.selector.kind === "project"
                  ? "Project identity"
                  : "Git Anchor",
            value: review.selector.key
          },
          { label: "Team", value: review.team.name },
          { label: "Workspace", value: review.workspace.name },
          {
            label: "Shared detail",
            value: fidelityLabel(review.maximumFidelity)
          },
          {
            label: "Curated Memory",
            value: curatedMemoryLabel(review.includeCuratedMemory)
          },
          { label: "Current state", value: review.state },
          { label: "Sharing rule", value: review.ruleId }
        ]
      })
    };
  }
};

const revokeDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.revoke") return null;
    const review = requireReview(
      await input.repository.getSharedMemoryRevokeReview(
        { userId: input.userId },
        {
          teamId: input.intent.teamId,
          teamWorkspaceId: input.intent.teamWorkspaceId,
          shareGrantId: input.intent.shareGrantId,
          expectedGrantVersion: input.intent.expectedGrantVersion
        }
      ),
      "Shared Memory revocation"
    );
    return {
      operation: bindSharedMemoryRevokeOperation(
        input.intent,
        input.clientRequestId
      ),
      policy: revokeReview(review, input.intent)
    };
  }
};

const workspaceRestorationDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.workspace_restore") return null;
    const intent = input.intent;
    const current = requireReview(
      await input.repository.getWorkspaceConversationRestorationReview(
        { userId: input.userId },
        {
          logicalMemoryId: intent.scope.logicalMemoryId,
          teamId: intent.scope.teamId,
          teamWorkspaceId: intent.scope.teamWorkspaceId
        },
        intent.restoration.expiresAt
      ),
      "Workspace restoration"
    );
    requireActionReview(
      crossIdentitySyncDigest(current) ===
        crossIdentitySyncDigest(intent.restoration) &&
        crossIdentitySyncDigest(current.scope) ===
          crossIdentitySyncDigest(intent.scope)
        ? current
        : null,
      "The Workspace restoration review is stale"
    );
    return {
      operation: bindSharedMemoryWorkspaceRestorationOperation(
        intent,
        input.clientRequestId
      ),
      policy: reviewed("native_review", {
        title: "Remove this Workspace exclusion?",
        description: "Allow eligible sharing through current active rules.",
        consequence:
          "Active rules can catch up eligible history after current membership and policy checks. Paused and stopped rules stay unchanged. Revoked direct snapshots stay stopped. Without an eligible active rule, nothing is published.",
        confirmLabel: "Remove exclusion",
        details: [
          { label: "Conversation", value: current.source.title },
          { label: "Team", value: current.team.name },
          { label: "Workspace", value: current.workspace.name },
          {
            label: "Eligible active rules",
            value: String(current.rules.filter((rule) => rule.eligible).length)
          },
          ...current.rules.map((rule) => ({
            label: `Rule ${rule.ruleId}`,
            value: `${rule.selectorKind}: ${rule.state}${rule.eligible ? "; eligible to catch up" : "; no publication scheduled"}`
          }))
        ]
      })
    };
  }
};

const workspaceExclusionDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.workspace_exclude") return null;
    const intent = input.intent;
    const review = requireReview(
      await input.repository.getWorkspaceConversationExclusionReview(
        { userId: input.userId },
        {
          logicalMemoryId: intent.scope.logicalMemoryId,
          teamId: intent.scope.teamId,
          teamWorkspaceId: intent.scope.teamWorkspaceId
        }
      ),
      "Workspace exclusion"
    );
    requireActionReview(
      review.exclusion?.state === "excluded" ||
        crossIdentitySyncDigest(review.scope) !==
          crossIdentitySyncDigest(intent.scope)
        ? null
        : review,
      "The Workspace exclusion review is stale"
    );
    return {
      operation: bindSharedMemoryWorkspaceExclusionOperation(
        intent,
        input.clientRequestId
      ),
      policy: reviewed("native_review", {
        title: "Exclude this Conversation from the Workspace?",
        description:
          "Remove this Conversation's shared Memory from this Workspace through every sharing reason.",
        consequence:
          "Current and future sharing to this Workspace stays blocked until you explicitly remove the exclusion. Personal Memory and other Workspaces remain available. Existing direct snapshots stay stopped.",
        confirmLabel: "Exclude from Workspace",
        details: [
          { label: "Conversation", value: review.source.title },
          { label: "Team", value: review.team.name },
          { label: "Workspace", value: review.workspace.name },
          {
            label: "Sharing affected",
            value:
              "Direct sharing and all Conversation, Git Anchor, Folder and Project rules for this Conversation"
          }
        ]
      })
    };
  }
};

const fidelityChangeDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.change_fidelity") {
      return null;
    }
    const review = requireReview(
      await input.repository.getSharedMemoryFidelityChangeReview(
        { userId: input.userId },
        {
          logicalMemoryId: input.intent.logicalMemoryId,
          teamId: input.intent.teamId,
          teamWorkspaceId: input.intent.teamWorkspaceId,
          shareGrantId: input.intent.shareGrantId,
          expectedGrantVersion: input.intent.expectedGrantVersion,
          preview: {
            previewId: input.intent.previewId,
            previewHash: input.intent.previewHash
          },
          previewRevision: input.intent.previewRevision,
          maximumFidelity: input.intent.maximumFidelity,
          includeCuratedMemory: input.intent.includeCuratedMemory,
          expiresAt: input.intent.expiresAt
        }
      ),
      "Shared Memory fidelity change"
    );
    return {
      operation: bindSharedMemoryFidelityChangeOperation(
        input.intent,
        input.clientRequestId
      ),
      policy: fidelityChangeReview(review, input.intent)
    };
  }
};

const conversationSourceGrantDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.conversation_source_grant") {
      return null;
    }
    const review = requireReview(
      await input.repository.getTeamConversationSourceGrantReview(
        { userId: input.userId },
        {
          shareGrantId: input.intent.shareGrantId,
          teamId: input.intent.teamId,
          expectedVersion: input.intent.expectedVersion
        }
      ),
      "Conversation Source sharing"
    );
    return {
      operation: bindConversationSourceGrantOperation(
        input.intent,
        input.clientRequestId
      ),
      policy: reviewed("step_up", {
        title: "Share the Conversation Source?",
        description:
          "Allow authorized Workspace members to read the committed source records for this Captured Session.",
        consequence:
          "This is independent of semantic Memory sharing and may expose higher-fidelity source detail.",
        confirmLabel: "Share source",
        details: [
          { label: "Captured Session", value: review.sourceTitle },
          { label: "Team", value: review.teamName },
          { label: "Workspace", value: review.teamWorkspaceName },
          { label: "Mode", value: input.intent.mode }
        ]
      })
    };
  }
};

const conversationSourceRevokeDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.conversation_source_revoke") {
      return null;
    }
    const review = requireReview(
      await input.repository.getTeamConversationSourceGrantReview(
        { userId: input.userId },
        {
          shareGrantId: input.intent.shareGrantId,
          teamId: input.intent.teamId,
          expectedVersion: input.intent.expectedVersion
        }
      ),
      "Conversation Source revocation"
    );
    return {
      operation: bindConversationSourceRevokeOperation(
        input.intent,
        input.clientRequestId
      ),
      policy: reviewed("native_review", {
        title: "Stop sharing the Conversation Source?",
        description:
          "Remove read-only source access without deleting Personal Memory or changing its semantic Share Grant.",
        consequence:
          "Open source streams close and future segment or snapshot reads fail.",
        confirmLabel: "Revoke source access",
        details: [
          { label: "Captured Session", value: review.sourceTitle },
          { label: "Team", value: review.teamName },
          { label: "Workspace", value: review.teamWorkspaceName }
        ]
      })
    };
  }
};

const repositorySnapshotDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.update_repository_snapshot")
      return null;
    const review = await input.repository.reviewGrantRepositorySnapshot(
      { userId: input.userId },
      { shareGrantId: input.intent.shareGrantId }
    );
    if (
      review.teamId !== input.intent.teamId ||
      review.teamWorkspaceId !== input.intent.teamWorkspaceId ||
      crossIdentitySyncDigest(review) !==
        crossIdentitySyncDigest(input.intent.expected)
    )
      return null;
    return {
      operation: bindSharedMemoryRepositorySnapshotOperation(
        input.intent,
        input.clientRequestId
      ),
      policy: reviewedAction("native_review", {
        title: "Update shared Project?",
        description: "Apply the current source Project to this share.",
        consequence:
          "This changes which Project can recall the shared memory. Personal Memory stays unchanged.",
        confirmLabel: "Update Project",
        details: [
          {
            label: "Project",
            value:
              review.currentSnapshot.classification === "portable_repository"
                ? "Current source repository"
                : "Unresolved"
          }
        ]
      })
    };
  }
};

export const sharedMemoryActionDefinitions = {
  "shared_memory.rule_content_policy": {
    operationFamily: "share_grant_management" as const,
    async admit(input: SharedMemoryAdmissionInput) {
      if (input.intent.action !== "shared_memory.rule_content_policy")
        return null;
      const expected = input.intent.review;
      const review = requireReview(
        await input.repository.getSharingRuleContentPolicyReview(
          { userId: input.userId },
          sharingRuleContentPolicyReviewInputSchema.strip().parse(expected),
          expected.expiresAt
        ),
        "Rule content-policy amendment"
      );
      requireReview(
        crossIdentitySyncDigest(review) === crossIdentitySyncDigest(expected)
          ? review
          : null,
        "Current rule, member and policy versions"
      );
      const categories = (labels: typeof review.labels) =>
        privacyLabels
          .filter((label) => labels[label])
          .map((label) => label.replaceAll("_", " "))
          .join(", ") || "None";
      return {
        operation: bindSharedMemoryRuleContentPolicyOperation(
          input.intent,
          input.clientRequestId
        ),
        policy: reviewed(
          review.disclosureIncrease &&
            review.maximumFidelity === "memory_events"
            ? "step_up"
            : "native_review",
          {
            title: "Change this rule’s content policy?",
            description: `Apply this policy to existing and future eligible Memory in ${review.workspaceName}.`,
            consequence:
              "Restrictions apply immediately. Independently authorized content remains shared. Owner, Team and Workspace requirements still apply. Paused and stopped rules keep their state.",
            confirmLabel: review.disclosureIncrease
              ? "Confirm increased sharing"
              : "Change content policy",
            details: [
              { label: "Rule", value: review.ruleId },
              { label: "Team", value: review.teamName },
              { label: "Workspace", value: review.workspaceName },
              {
                label: "Previously masked categories",
                value:
                  review.previousEffectiveLabels === null
                    ? "Unknown; review increased sharing"
                    : categories(review.previousEffectiveLabels)
              },
              {
                label: "Rule masked categories",
                value: categories(review.labels)
              },
              {
                label: "New masked categories",
                value: categories(review.effectiveLabels)
              },
              {
                label: "Required masked categories",
                value: categories(review.requiredLabels)
              },
              { label: "Existing members", value: String(review.memberCount) },
              { label: "Rule state", value: review.state }
            ]
          }
        )
      };
    }
  },
  "shared_memory.rule_detail": {
    operationFamily: "share_grant_management" as const,
    async admit(input: SharedMemoryAdmissionInput) {
      if (input.intent.action !== "shared_memory.rule_detail") return null;
      const expected = input.intent.review;
      const review = requireReview(
        await input.repository.getSharingRuleDetailReview(
          { userId: input.userId },
          sharingRuleDetailReviewInputSchema.strip().parse(expected),
          expected.expiresAt
        ),
        "Rule detail amendment"
      );
      requireReview(
        crossIdentitySyncDigest(review) === crossIdentitySyncDigest(expected)
          ? review
          : null,
        "Current rule, member and policy versions"
      );
      return {
        operation: bindSharedMemoryRuleDetailOperation(
          input.intent,
          input.clientRequestId
        ),
        policy: reviewed(
          review.disclosureIncrease &&
            review.maximumFidelity === "memory_events"
            ? "step_up"
            : "native_review",
          {
            title: "Change this rule’s shared detail?",
            description: `Apply this detail to existing and future eligible Memory in ${review.workspaceName}.${review.ownerPolicyExpansionCount > 0 ? ` Owner permission also broadens for ${review.ownerPolicyExpansionCount} existing members.` : ""}`,
            consequence:
              "Reductions restrict this rule immediately. Independently authorized content remains shared. Paused and stopped rules keep their state.",
            confirmLabel: review.disclosureIncrease
              ? "Confirm increased sharing"
              : "Change rule detail",
            details: [
              { label: "Rule", value: review.ruleId },
              { label: "Team", value: review.teamName },
              { label: "Workspace", value: review.workspaceName },
              {
                label: "Previous detail",
                value: fidelityLabel(review.previousMaximumFidelity)
              },
              {
                label: "New detail",
                value: fidelityLabel(review.maximumFidelity)
              },
              {
                label: "Curated Memory",
                value: curatedMemoryLabel(review.includeCuratedMemory)
              },
              { label: "Existing members", value: String(review.memberCount) },
              {
                label: "Owner permission expansions",
                value: String(review.ownerPolicyExpansionCount)
              },
              { label: "Rule state", value: review.state }
            ]
          }
        )
      };
    }
  },
  "shared_memory.repository_rule_create": {
    operationFamily: "share_grant_management" as const,
    async admit(input: SharedMemoryAdmissionInput) {
      if (input.intent.action !== "shared_memory.repository_rule_create")
        return null;
      const scope = repositorySharingRuleCreationReviewSchema.shape.scope
        .strip()
        .parse(input.intent);
      const review = requireReview(
        await input.repository.getRepositorySharingRuleCreationReview(
          { userId: input.userId },
          {
            selector: scope.selector,
            teamId: scope.teamId,
            teamWorkspaceId: scope.teamWorkspaceId,
            maximumFidelity: scope.maximumFidelity,
            includeCuratedMemory: scope.includeCuratedMemory,
            includesFutureConversations: scope.includesFutureConversations,
            completedReviewHash: scope.completedReviewHash,
            selectionSnapshotVersion: scope.selectionSnapshotVersion
          }
        ),
        "Selection rule creation"
      );
      requireReview(
        crossIdentitySyncDigest(scope) === crossIdentitySyncDigest(review.scope)
          ? review
          : null,
        "Exact future-member rule policy"
      );
      return {
        operation: bindSharedMemoryRepositoryRuleCreationOperation(
          input.intent,
          input.clientRequestId
        ),
        policy: reviewed(
          scope.maximumFidelity === "memory_events"
            ? "step_up"
            : "native_review",
          {
            title: `Share this ${scope.selector.kind === "folder" ? "Folder" : scope.selector.kind === "project" ? "Project" : "Git Anchor"} continuously?`,
            description: `Share existing eligible Conversations and automatically share future Conversations that match this ${scope.selector.kind === "folder" ? "exact Folder on its originating device" : scope.selector.kind === "project" ? "private Project, including later membership changes" : "Git Anchor"}.`,
            consequence:
              "This approval authorizes future members on this publisher. Sources that stop matching lose only this rule's access. Pause retains published Memory; stop removes this rule's access.",
            confirmLabel: "Share existing and future Memory",
            details: [
              {
                label:
                  scope.selector.kind === "folder"
                    ? "Folder identity"
                    : scope.selector.kind === "project"
                      ? "Project identity"
                      : "Git Anchor",
                value: scope.selector.key
              },
              {
                label: "Scope",
                value: "Existing and future matching Conversations"
              },
              { label: "Team", value: review.teamName },
              { label: "Workspace", value: review.workspaceName },
              {
                label: "Maximum fidelity",
                value: fidelityLabel(scope.maximumFidelity)
              },
              {
                label: "Curated Memory",
                value: curatedMemoryLabel(scope.includeCuratedMemory)
              },
              {
                label: "Privacy policy",
                value: scope.effectivePrivacyPolicyHash
              }
            ]
          }
        )
      };
    }
  },
  "shared_memory.publisher_takeover": {
    operationFamily: "share_grant_management" as const,
    async admit(input: SharedMemoryAdmissionInput) {
      if (
        input.intent.action !== "shared_memory.publisher_takeover" ||
        !input.currentDeviceCredentialId
      )
        return null;
      const intent = input.intent;
      if (
        intent.review.receivingPublisher.credentialId !==
        input.currentDeviceCredentialId
      )
        return null;
      const review = requireReview(
        await input.repository.getSharingRulePublisherTakeoverReview(
          { userId: input.userId },
          {
            ...sharingRulePublisherTakeoverReviewInputSchema
              .strip()
              .parse(intent.review),
            receivingCredentialId: input.currentDeviceCredentialId
          },
          intent.review.expiresAt
        ),
        "Publisher takeover"
      );
      requireReview(
        crossIdentitySyncDigest(review) ===
          crossIdentitySyncDigest(intent.review)
          ? review
          : null,
        "Exact publisher takeover"
      );
      return {
        operation: bindSharedMemoryPublisherTakeoverOperation(
          intent,
          input.clientRequestId
        ),
        policy: reviewed("native_review", {
          title: "Continue sharing from this device?",
          description:
            "Transfer this rule's publication responsibility to the reviewed receiving device.",
          consequence:
            "The rule keeps its approved scope and current state. Previously shared Memory remains available. Future writes require the receiving publisher. Synchronized Conversations keep their original source authority.",
          confirmLabel: "Transfer publisher",
          details: [
            {
              label: "Current publisher",
              value: review.currentPublisher.label ?? "Unnamed device"
            },
            {
              label: "Receiving publisher",
              value: review.receivingPublisher.label ?? "Unnamed device"
            },
            { label: "Team", value: review.teamName },
            { label: "Workspace", value: review.workspaceName },
            {
              label: "Rule",
              value:
                review.selectorKind === "captured_session"
                  ? "Conversation"
                  : review.selectorKind === "repository"
                    ? "Git Anchor"
                    : review.selectorKind === "folder"
                      ? "Folder"
                      : "Project"
            },
            { label: "Rule identity", value: review.ruleId },
            ...(review.selectionScope
              ? [
                  {
                    label:
                      review.selectorKind === "repository"
                        ? "Git Anchor identity"
                        : review.selectorKind === "folder"
                          ? "Folder identity"
                          : "Project identity",
                    value: review.selectionScope.selector.key
                  }
                ]
              : []),
            { label: "State", value: review.state },
            {
              label: "Shared detail",
              value: fidelityLabel(review.maximumFidelity)
            },
            {
              label: "Curated Memory",
              value: curatedMemoryLabel(review.includeCuratedMemory)
            }
          ]
        })
      };
    }
  },
  "shared_memory.conversation_rule_create": conversationRuleCreationDefinition,
  "shared_memory.rule_control": ruleControlDefinition,
  "shared_memory.repository_rule_control": repositoryRuleControlDefinition,
  "shared_memory.update_repository_snapshot": repositorySnapshotDefinition,
  "shared_memory.candidate_preview": candidatePreviewDefinition,
  "shared_memory.pending_share": pendingShareDefinition,
  "shared_memory.preview": previewDefinition,
  "shared_memory.revoke": revokeDefinition,
  "shared_memory.workspace_restore": workspaceRestorationDefinition,
  "shared_memory.workspace_exclude": workspaceExclusionDefinition,
  "shared_memory.conversation_source_grant": conversationSourceGrantDefinition,
  "shared_memory.conversation_source_revoke":
    conversationSourceRevokeDefinition,
  "shared_memory.change_fidelity": fidelityChangeDefinition
};
