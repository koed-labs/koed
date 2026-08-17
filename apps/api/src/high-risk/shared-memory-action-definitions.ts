import type {
  MemorySourceRepository,
  SharedMemoryRepresentation,
  SharedMemoryPendingShareReviewRecord,
  SharedMemoryRepresentationChangeReviewRecord,
  SharedMemoryRevokeReviewRecord,
  SharedMemoryShareReviewRecord
} from "@koed/db";
import {
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryCandidatePreviewActionGrantBinding,
  sharedMemoryPendingShareActionGrantBinding,
  sharedMemoryRepresentationBundleActionGrantBinding,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryShareBundleActionGrantBinding,
  sharedMemoryTranscriptAccessActionGrantBinding,
  sharedMemoryTranscriptRevokeActionGrantBinding,
  type CollaborationApprovalReview
} from "@koed/shared";

import type { ActionApprovalPolicy } from "./approval-policy.js";
import {
  requireActionReview,
  reviewedAction,
  unavailableAction
} from "./action-definition-support.js";
import type {
  HighRiskActionGrantIntent,
  HighRiskResolvedActionGrantOperation
} from "./action-grant-protocol.js";

type SharedMemoryAction =
  | "shared_memory.candidate_preview"
  | "shared_memory.pending_share"
  | "shared_memory.preview"
  | "shared_memory.share"
  | "shared_memory.revoke"
  | "shared_memory.conversation_source_grant"
  | "shared_memory.conversation_source_revoke"
  | "shared_memory.change_representation";

export type SharedMemoryActionIntent = Extract<
  HighRiskActionGrantIntent,
  { action: SharedMemoryAction }
>;

type SharedMemoryActionRepository = Pick<
  MemorySourceRepository,
  | "getSharedMemoryPreviewAdmission"
  | "getSharedMemoryCandidatePreviewAdmission"
  | "getSharedMemoryPendingShareReview"
  | "getSharedMemoryShareReview"
  | "getSharedMemoryRevokeReview"
  | "getSharedMemoryRepresentationChangeReview"
  | "getTeamConversationSourceGrantReview"
>;

interface SharedMemoryAdmissionInput {
  repository: SharedMemoryActionRepository;
  userId: string;
  clientRequestId: string;
  intent: HighRiskActionGrantIntent;
}

const unavailable = (context: string): never =>
  unavailableAction(
    `${context} requires complete current source-owner, destination, preview, policy, and grant context`
  );

const requireReview = <T>(value: T | null, context: string): T =>
  requireActionReview(
    value,
    `${context} requires complete current source-owner, destination, preview, policy, and grant context`
  );

const reviewed = (
  disposition: "native_review" | "step_up",
  review: Omit<CollaborationApprovalReview, "version">
): ActionApprovalPolicy => reviewedAction(disposition, review);

const representationRank: Record<SharedMemoryRepresentation, number> = {
  lcm_rollups: 0,
  lcm_leaves: 1,
  curated_assertions: 2,
  memory_events: 3
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
    logicalMemoryId: intent.logicalMemoryId,
    remoteReplicaId: intent.remoteReplicaId,
    teamId: intent.teamId,
    teamWorkspaceId: intent.teamWorkspaceId,
    representation: intent.representation,
    allowedRepresentations: intent.allowedRepresentations
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
    logicalMemoryId: intent.logicalMemoryId,
    candidateHash: intent.candidateHash,
    sourceRevision: intent.sourceRevision,
    itemCount: intent.itemCount,
    excludedItemCount: intent.excludedItemCount,
    manifest: intent.manifest,
    byteCount: intent.byteCount,
    teamId: intent.teamId,
    teamWorkspaceId: intent.teamWorkspaceId,
    representation: intent.representation,
    allowedRepresentations: intent.allowedRepresentations,
    mode: intent.mode,
    expiresAt: intent.expiresAt
  });

export const bindSharedMemoryShareOperation = (
  intent: Extract<SharedMemoryActionIntent, { action: "shared_memory.share" }>,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryShareBundleActionGrantBinding({
    referenceId,
    mutationId: intent.mutationId,
    logicalGrantId: intent.logicalGrantId,
    logicalMemoryId: intent.logicalMemoryId,
    teamId: intent.teamId,
    teamWorkspaceId: intent.teamWorkspaceId,
    consentId: intent.consentId,
    previewId: intent.previewId,
    mode: intent.mode,
    allowedRepresentations: intent.allowedRepresentations,
    selectedRepresentation: intent.selectedRepresentation,
    previewRevision: intent.previewRevision,
    previewHash: intent.previewHash,
    expiresAt: intent.expiresAt,
    title: intent.title
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
    mutationId: intent.mutationId,
    logicalGrantId: intent.logicalGrantId,
    logicalMemoryId: intent.logicalMemoryId,
    teamId: intent.teamId,
    teamWorkspaceId: intent.teamWorkspaceId,
    consentId: intent.consentId,
    previewId: intent.previewId,
    mode: intent.mode,
    allowedRepresentations: intent.allowedRepresentations,
    selectedRepresentation: intent.selectedRepresentation,
    previewRevision: intent.previewRevision,
    previewHash: intent.previewHash,
    expiresAt: intent.expiresAt,
    title: intent.title
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

export const bindSharedMemoryRepresentationChangeOperation = (
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.change_representation" }
  >,
  referenceId: string
): HighRiskResolvedActionGrantOperation =>
  sharedMemoryRepresentationBundleActionGrantBinding({
    referenceId,
    mutationId: intent.mutationId,
    logicalMemoryId: intent.logicalMemoryId,
    teamId: intent.teamId,
    teamWorkspaceId: intent.teamWorkspaceId,
    shareGrantId: intent.shareGrantId,
    consentId: intent.consentId,
    previewId: intent.previewId,
    representation: intent.representation,
    expectedGrantVersion: intent.expectedGrantVersion,
    mode: intent.mode,
    allowedRepresentations: intent.allowedRepresentations,
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
  review: SharedMemoryShareReviewRecord | SharedMemoryPendingShareReviewRecord,
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.share" | "shared_memory.pending_share" }
  >
): ActionApprovalPolicy =>
  reviewed(
    intent.selectedRepresentation === "memory_events"
      ? "step_up"
      : "native_review",
    {
      title: "Share Personal Memory with this Workspace?",
      description: review.sourceOwnerPolicyWillActivate
        ? "One decision activates the reviewed source policy, records exact consent, and creates the corresponding Share Grant."
        : "One decision records the exact source-owner consent and creates the corresponding Share Grant.",
      consequence: review.sourceOwnerPolicyWillReplace
        ? "The new source policy pauses existing consent and invalidates other Share Grants before this Workspace receives the selected representation."
        : "Authorized Workspace members can recall the selected representation under the exact mode and expiry.",
      confirmLabel: "Share Memory",
      details: [
        { label: "Personal Memory", value: sourceName(review) },
        { label: "Logical Memory", value: review.source.logicalMemoryId },
        { label: "Team", value: review.team.name },
        { label: "Workspace", value: review.workspace.name },
        {
          label: "Representation",
          value: representationLabel(intent.selectedRepresentation)
        },
        { label: "Mode", value: intent.mode },
        { label: "Expiry", value: intent.expiresAt ?? "No expiry" },
        ...(review.sourceOwnerPolicyWillActivate
          ? [
              {
                label: "Source policy",
                value: review.sourceOwnerPolicyWillReplace
                  ? "Replace during this share"
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
        label: "Representation",
        value: review.grant.activeRepresentation
          ? representationLabel(review.grant.activeRepresentation)
          : "Unavailable"
      },
      { label: "Share Grant", value: intent.shareGrantId }
    ]
  });

const representationChangeReview = (
  review: SharedMemoryRepresentationChangeReviewRecord,
  intent: Extract<
    SharedMemoryActionIntent,
    { action: "shared_memory.change_representation" }
  >
): ActionApprovalPolicy => {
  const current = review.grant.activeRepresentation;
  if (current === null) {
    return unavailable("Shared Memory representation change");
  }
  const increases =
    representationRank[intent.representation] > representationRank[current];
  return reviewed(increases ? "step_up" : "native_review", {
    title: review.willReactivate
      ? "Reactivate Shared Memory with this representation?"
      : "Change the Shared Memory representation?",
    description: review.sourceOwnerPolicyWillActivate
      ? "Compare the current and proposed detail. This decision also activates the reviewed source policy."
      : "Compare the current and proposed level of Memory detail.",
    consequence: review.sourceOwnerPolicyWillReplace
      ? "The new source policy pauses existing consent and invalidates other affected Share Grants while this Share Grant changes representation."
      : review.willReactivate
        ? "This reactivates the Share Grant and makes the selected Memory representation available again."
        : increases
          ? "This makes more detailed Memory available to the Workspace."
          : "This reduces the detail available and purges unauthorized higher-fidelity cached content.",
    confirmLabel: review.willReactivate
      ? "Reactivate Share Grant"
      : "Change representation",
    details: [
      { label: "Personal Memory", value: sourceName(review) },
      { label: "Logical Memory", value: review.source.logicalMemoryId },
      { label: "Team", value: review.team.name },
      { label: "Workspace", value: review.workspace.name },
      {
        label: "Current representation",
        value: representationLabel(current)
      },
      {
        label: "New representation",
        value: representationLabel(intent.representation)
      },
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
          representation: input.intent.representation,
          allowedRepresentations: input.intent.allowedRepresentations
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
          representation: input.intent.representation,
          allowedRepresentations: input.intent.allowedRepresentations
        }
      );
    if (!admitted) unavailable("Shared Memory candidate preview");
    return {
      operation: bindSharedMemoryCandidatePreviewOperation(
        input.intent,
        input.clientRequestId
      ),
      policy: previewPolicy()
    };
  }
};

const shareDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.share") return null;
    const review = requireReview(
      await input.repository.getSharedMemoryShareReview(
        { userId: input.userId },
        {
          logicalMemoryId: input.intent.logicalMemoryId,
          logicalGrantId: input.intent.logicalGrantId,
          teamId: input.intent.teamId,
          teamWorkspaceId: input.intent.teamWorkspaceId,
          consentId: input.intent.consentId,
          preview: {
            previewId: input.intent.previewId,
            previewHash: input.intent.previewHash
          },
          previewRevision: input.intent.previewRevision,
          selectedRepresentation: input.intent.selectedRepresentation,
          allowedRepresentations: input.intent.allowedRepresentations,
          expiresAt: input.intent.expiresAt
        }
      ),
      "Shared Memory sharing"
    );
    return {
      operation: bindSharedMemoryShareOperation(
        input.intent,
        input.clientRequestId
      ),
      policy: shareReview(review, input.intent)
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
          teamId: input.intent.teamId,
          teamWorkspaceId: input.intent.teamWorkspaceId,
          consentId: input.intent.consentId,
          preview: {
            previewId: input.intent.previewId,
            previewHash: input.intent.previewHash
          },
          previewRevision: input.intent.previewRevision,
          selectedRepresentation: input.intent.selectedRepresentation,
          allowedRepresentations: input.intent.allowedRepresentations,
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

const representationChangeDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.change_representation") {
      return null;
    }
    const review = requireReview(
      await input.repository.getSharedMemoryRepresentationChangeReview(
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
          representation: input.intent.representation,
          allowedRepresentations: input.intent.allowedRepresentations,
          expiresAt: input.intent.expiresAt
        }
      ),
      "Shared Memory representation change"
    );
    return {
      operation: bindSharedMemoryRepresentationChangeOperation(
        input.intent,
        input.clientRequestId
      ),
      policy: representationChangeReview(review, input.intent)
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

export const sharedMemoryActionDefinitions = {
  "shared_memory.candidate_preview": candidatePreviewDefinition,
  "shared_memory.pending_share": pendingShareDefinition,
  "shared_memory.preview": previewDefinition,
  "shared_memory.share": shareDefinition,
  "shared_memory.revoke": revokeDefinition,
  "shared_memory.conversation_source_grant": conversationSourceGrantDefinition,
  "shared_memory.conversation_source_revoke":
    conversationSourceRevokeDefinition,
  "shared_memory.change_representation": representationChangeDefinition
};
