import { randomUUID } from "node:crypto";
import { sharedMemoryCuratedPolicyOptInBinding } from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import { admitHighRiskActionGrant } from "./action-definitions.js";
import { ActionApprovalPolicyError } from "./approval-policy.js";
import { highRiskActionGrantIntentSchema } from "./action-grant-protocol.js";

const ids = {
  user: randomUUID(),
  team: randomUUID(),
  workspace: randomUUID(),
  policy: randomUUID(),
  mutation: randomUUID(),
  request: randomUUID(),
  device: randomUUID(),
  backend: randomUUID()
};

const intent = highRiskActionGrantIntentSchema.parse({
  action: "shared_memory.workspace_policy.curated_opt_in",
  teamId: ids.team,
  teamWorkspaceId: ids.workspace,
  mutationId: ids.mutation,
  policyId: ids.policy,
  expectedCurrentVersion: 1,
  maximumFidelity: "lcm_leaves"
});

describe("Curated policy administrator Action Grant", () => {
  it("binds exact Workspace policy and requires Step-up review", async () => {
    const getCuratedPolicyOptInReview = vi.fn(async () => ({
      policyId: ids.policy,
      version: 1,
      maximumFidelity: "lcm_leaves" as const
    }));
    const admitted = await admitHighRiskActionGrant({
      repository: {} as never,
      sharedMemoryRepository: { getCuratedPolicyOptInReview } as never,
      userId: ids.user,
      upstreamBackendId: ids.backend,
      deviceCredentialId: ids.device,
      clientRequestId: ids.request,
      hashSecret: () => "a".repeat(64),
      intent
    });
    expect(admitted?.policy.disposition).toBe("step_up");
    expect(admitted?.operation).toEqual(
      sharedMemoryCuratedPolicyOptInBinding({
        action: "shared_memory.workspace_policy.curated_opt_in",
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        referenceId: ids.request,
        mutationId: ids.mutation,
        policyId: ids.policy,
        expectedCurrentVersion: 1,
        maximumFidelity: "lcm_leaves"
      })
    );
    expect(getCuratedPolicyOptInReview).toHaveBeenCalledWith(
      { userId: ids.user },
      {
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        policyId: ids.policy,
        expectedCurrentVersion: 1,
        maximumFidelity: "lcm_leaves"
      }
    );
  });

  it("rejects stale review and absent enrolled device authority", async () => {
    const base = {
      repository: {} as never,
      sharedMemoryRepository: {
        getCuratedPolicyOptInReview: vi.fn(async () => null)
      } as never,
      userId: ids.user,
      upstreamBackendId: ids.backend,
      deviceCredentialId: ids.device,
      clientRequestId: ids.request,
      hashSecret: () => "a".repeat(64),
      intent
    };
    await expect(admitHighRiskActionGrant(base)).rejects.toBeInstanceOf(
      ActionApprovalPolicyError
    );
    await expect(
      admitHighRiskActionGrant({ ...base, deviceCredentialId: undefined })
    ).rejects.toBeInstanceOf(ActionApprovalPolicyError);
  });
});
