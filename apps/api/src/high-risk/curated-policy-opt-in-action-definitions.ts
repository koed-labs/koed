import type { SharedMemoryRepository } from "@koed/db";
import { sharedMemoryCuratedPolicyOptInBinding } from "@koed/shared";
import type { HighRiskActionGrantIntent } from "./action-grant-protocol.js";
import { reviewedAction } from "./action-definition-support.js";
import { ActionApprovalPolicyError } from "./approval-policy.js";

type Action =
  | "shared_memory.team_policy.curated_opt_in"
  | "shared_memory.workspace_policy.curated_opt_in";

const definition = (action: Action) => ({
  operationFamily: "share_grant_management" as const,
  async admit(input: {
    sharedMemoryRepository?: Pick<
      SharedMemoryRepository,
      "getCuratedPolicyOptInReview"
    > | null;
    userId: string;
    deviceCredentialId?: string;
    upstreamBackendId?: string;
    clientRequestId: string;
    intent: HighRiskActionGrantIntent;
  }) {
    if (input.intent.action !== action) return null;
    if (
      !input.sharedMemoryRepository ||
      !input.deviceCredentialId ||
      !input.upstreamBackendId
    )
      throw new ActionApprovalPolicyError(
        "Current Curated policy authority is unavailable"
      );
    const intent = input.intent as Extract<
      HighRiskActionGrantIntent,
      { action: typeof action }
    >;
    const teamWorkspaceId =
      intent.action === "shared_memory.workspace_policy.curated_opt_in"
        ? intent.teamWorkspaceId
        : undefined;
    const current =
      await input.sharedMemoryRepository.getCuratedPolicyOptInReview(
        { userId: input.userId },
        {
          teamId: intent.teamId,
          ...(teamWorkspaceId ? { teamWorkspaceId } : {}),
          policyId: intent.policyId,
          expectedCurrentVersion: intent.expectedCurrentVersion,
          maximumFidelity: intent.maximumFidelity
        }
      );
    if (!current)
      throw new ActionApprovalPolicyError(
        "Current Curated policy review is unavailable or stale"
      );
    return {
      operation: sharedMemoryCuratedPolicyOptInBinding({
        action,
        teamId: intent.teamId,
        ...(teamWorkspaceId ? { teamWorkspaceId } : {}),
        referenceId: input.clientRequestId,
        mutationId: intent.mutationId,
        policyId: intent.policyId,
        expectedCurrentVersion: intent.expectedCurrentVersion,
        maximumFidelity: intent.maximumFidelity
      }),
      policy: reviewedAction("step_up", {
        title: teamWorkspaceId
          ? "Allow Curated Memory in this Workspace?"
          : "Allow Curated Memory in this Team?",
        description:
          "This enables Curated Memory as an option for new shares. Each source owner must separately approve Curated sharing for one exact Captured Session with eligible direct provenance.",
        consequence:
          "Existing grants keep their approved content and lifecycle. This does not grant access to transcripts or source items.",
        confirmLabel: "Allow Curated Memory",
        details: [
          { label: "Team ID", value: intent.teamId },
          { label: "Policy ID", value: current.policyId },
          {
            label: "Policy version",
            value: `${current.version} → ${current.version + 1}`
          },
          { label: "Curated Memory", value: "Off → On" },
          {
            label: "Maximum fidelity (unchanged)",
            value: current.maximumFidelity
          },
          ...(teamWorkspaceId
            ? [{ label: "Workspace ID", value: teamWorkspaceId }]
            : [])
        ]
      })
    };
  }
});

export const curatedPolicyOptInActionDefinitions = {
  "shared_memory.team_policy.curated_opt_in": definition(
    "shared_memory.team_policy.curated_opt_in"
  ),
  "shared_memory.workspace_policy.curated_opt_in": definition(
    "shared_memory.workspace_policy.curated_opt_in"
  )
};
