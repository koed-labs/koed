import type {
  MemorySourceRepository,
  SharedMemoryPreviewAdmissionRecord,
  SharedMemoryRepresentation,
  SharedMemoryRepresentationChangeReviewRecord,
  SharedMemoryRevokeReviewRecord,
  SharedMemoryShareReviewRecord
} from "@koed/db";
import {
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryRepresentationBundleActionGrantBinding,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryShareBundleActionGrantBinding,
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
  | "shared_memory.preview"
  | "shared_memory.share"
  | "shared_memory.revoke"
  | "shared_memory.change_representation";

export type SharedMemoryActionIntent = Extract<
  HighRiskActionGrantIntent,
  { action: SharedMemoryAction }
>;

type SharedMemoryActionRepository = Pick<
  MemorySourceRepository,
  | "getSharedMemoryPreviewAdmission"
  | "getSharedMemoryShareReview"
  | "getSharedMemoryRevokeReview"
  | "getSharedMemoryRepresentationChangeReview"
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
  memory_events: 2
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
    expiresAt: intent.expiresAt
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

const shareReview = (
  review: SharedMemoryShareReviewRecord,
  intent: Extract<SharedMemoryActionIntent, { action: "shared_memory.share" }>
): ActionApprovalPolicy =>
  reviewed(
    intent.selectedRepresentation === "memory_events"
      ? "step_up"
      : "native_review",
    {
      title: "Share Personal Memory with this Workspace?",
      description:
        "One decision records the exact source-owner consent and creates the corresponding Share Grant.",
      consequence:
        "Authorized Workspace members can recall the selected representation under the exact mode and expiry.",
      confirmLabel: "Share Memory",
      details: [
        { label: "Personal Memory", value: sourceName(review) },
        { label: "Logical Memory", value: review.source.logicalMemoryId },
        { label: "Team", value: review.team.name },
        { label: "Workspace", value: review.workspace.name },
        { label: "Representation", value: intent.selectedRepresentation },
        { label: "Mode", value: intent.mode },
        { label: "Expiry", value: intent.expiresAt ?? "No expiry" }
      ]
    }
  );

const previewPolicy = (
  review: SharedMemoryPreviewAdmissionRecord
): ActionApprovalPolicy =>
  review.sourceOwnerPolicyWillChange
    ? reviewed("step_up", {
        title: "Change the source policy and preview this Memory?",
        description:
          "This preview request also creates or replaces the source-owner representation policy.",
        consequence:
          "Replacing an existing policy pauses active consents and invalidates affected Share Grants before the preview is created.",
        confirmLabel: "Change policy and preview",
        details: [
          { label: "Personal Memory", value: sourceName(review) },
          { label: "Logical Memory", value: review.source.logicalMemoryId },
          { label: "Team", value: review.team.name },
          { label: "Workspace", value: review.workspace.name },
          { label: "Representation", value: review.representation },
          {
            label: "Allowed representations",
            value: review.requestedAllowedRepresentations.join(", ")
          }
        ]
      })
    : { disposition: "direct", review: null };

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
        value: review.grant.activeRepresentation ?? "Unavailable"
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
    description: "Compare the current and proposed level of Memory detail.",
    consequence: review.willReactivate
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
      { label: "Current representation", value: current },
      { label: "New representation", value: intent.representation },
      { label: "Mode", value: intent.mode },
      { label: "Expiry", value: intent.expiresAt ?? "No expiry" }
    ]
  });
};

const previewDefinition = {
  operationFamily: "share_grant_management" as const,
  async admit(input: SharedMemoryAdmissionInput) {
    if (input.intent.action !== "shared_memory.preview") return null;
    const review = requireReview(
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
      policy: previewPolicy(review)
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

export const sharedMemoryActionDefinitions = {
  "shared_memory.preview": previewDefinition,
  "shared_memory.share": shareDefinition,
  "shared_memory.revoke": revokeDefinition,
  "shared_memory.change_representation": representationChangeDefinition
};
