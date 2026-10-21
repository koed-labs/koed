import type { ProjectSharePolicyRepository } from "@koed/db";
import { projectSharePolicyActionGrantBinding } from "@koed/shared";
import type { HighRiskActionGrantIntent } from "./action-grant-protocol.js";
import { reviewedAction } from "./action-definition-support.js";
import { ActionApprovalPolicyError } from "./approval-policy.js";

const requireReview = (valid: boolean): void => {
  if (!valid)
    throw new ActionApprovalPolicyError(
      "Current Project share policy authority is unavailable or stale"
    );
};

const definition = (
  action:
    | "shared_memory.project_share_policy.enable"
    | "shared_memory.project_share_policy.revoke"
) => ({
  operationFamily: "share_grant_management" as const,
  async admit(input: {
    projectSharePolicyRepository?: ProjectSharePolicyRepository | null;
    userId: string;
    deviceCredentialId?: string;
    upstreamBackendId?: string;
    clientRequestId: string;
    intent: HighRiskActionGrantIntent;
  }) {
    if (input.intent.action !== action) return null;
    requireReview(
      Boolean(
        input.projectSharePolicyRepository &&
        input.deviceCredentialId &&
        input.upstreamBackendId
      )
    );
    const intent = input.intent as Extract<
      HighRiskActionGrantIntent,
      { action: typeof action }
    >;
    const review = await input.projectSharePolicyRepository!.getReview(
      {
        userId: input.userId,
        deviceCredentialId: input.deviceCredentialId!,
        upstreamBackendId: input.upstreamBackendId!
      },
      {
        projectId: intent.projectId,
        expectedPolicyVersion: intent.expectedPolicyVersion,
        ...(intent.action === "shared_memory.project_share_policy.enable"
          ? { manifestId: intent.manifestId, manifestHash: intent.manifestHash }
          : {})
      }
    );
    requireReview(
      Boolean(
        review &&
        review.teamId === intent.teamId &&
        (intent.action === "shared_memory.project_share_policy.enable"
          ? review.status !== "active" &&
            review.manifestId === intent.manifestId
          : review.status === "active")
      )
    );
    return {
      operation: projectSharePolicyActionGrantBinding({
        action: intent.action,
        teamId: intent.teamId,
        projectId: intent.projectId,
        referenceId: input.clientRequestId,
        expectedPolicyVersion: intent.expectedPolicyVersion,
        ...(intent.action === "shared_memory.project_share_policy.enable"
          ? { manifestId: intent.manifestId, manifestHash: intent.manifestHash }
          : {})
      }),
      policy: reviewedAction("native_review", {
        title:
          intent.action === "shared_memory.project_share_policy.enable"
            ? `Share summaries from ${review!.projectName}?`
            : `Stop automatic summary sharing for ${review!.projectName}?`,
        description:
          intent.action === "shared_memory.project_share_policy.enable"
            ? "Eligible Conversations in this Project can share summaries and later summary updates with Project members. HQ and private Conversations stay private. Exact source records and Curated Memory require separate approval."
            : "Future Captured Sessions will no longer be shared by this Project policy.",
        consequence:
          intent.action === "shared_memory.project_share_policy.enable"
            ? "Each eligible Captured Session uses a separate owner-authorized Pending Share before its summary or later updates become available."
            : "Existing Share Grants keep their own consent and lifecycle until separately frozen or revoked.",
        confirmLabel:
          intent.action === "shared_memory.project_share_policy.enable"
            ? "Share eligible summaries"
            : "Stop automatic sharing",
        details: [
          { label: "Project", value: review!.projectName },
          {
            label: "Eligible Captured Sessions",
            value: String(review!.eligibleCount)
          },
          { label: "Summary fidelity", value: "LCM Leaves" },
          { label: "Policy version", value: String(review!.policyVersion) }
        ],
        ...(intent.action === "shared_memory.project_share_policy.enable"
          ? { reviewSources: review!.reviewSources }
          : {})
      })
    };
  }
});

export const projectSharePolicyActionDefinitions = {
  "shared_memory.project_share_policy.enable": definition(
    "shared_memory.project_share_policy.enable"
  ),
  "shared_memory.project_share_policy.revoke": definition(
    "shared_memory.project_share_policy.revoke"
  )
};
