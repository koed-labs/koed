import { randomUUID } from "node:crypto";
import type { ProjectSharePolicyRepository } from "@koed/db";
import { projectSharePolicyActionGrantBinding } from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import { highRiskActionGrantIntentSchema } from "./action-grant-protocol.js";
import { projectSharePolicyActionDefinitions } from "./project-share-policy-action-definitions.js";
import { ActionApprovalPolicyError } from "./approval-policy.js";

const ids = {
  owner: randomUUID(),
  member: randomUUID(),
  device: randomUUID(),
  team: randomUUID(),
  workspace: randomUUID(),
  project: randomUUID(),
  manifest: randomUUID(),
  approval: randomUUID()
};
const enableIntent = {
  action: "shared_memory.project_share_policy.enable" as const,
  teamId: ids.team,
  projectId: ids.project,
  expectedPolicyVersion: 0,
  manifestId: ids.manifest,
  manifestHash: "a".repeat(64)
};
type Review = Awaited<ReturnType<ProjectSharePolicyRepository["getStatus"]>>;
const review = (patch: Partial<Review> = {}): Review => ({
  policyId: null,
  ownerTeamMemberId: ids.member,
  projectId: ids.project,
  teamId: ids.team,
  workspaceId: ids.workspace,
  projectName: "Launch plan",
  policyVersion: 0,
  status: "absent",
  manifestId: ids.manifest,
  manifestHash: enableIntent.manifestHash,
  signingPublicKey: null,
  personalProjectBindingHash: null,
  deviceCredentialId: null,
  eligibleCount: 1,
  reviewSources: [
    { sessionId: randomUUID(), reviewLabel: "Launch notes", eligible: true }
  ],
  ...patch
});
const input = (state: Review | null = review()) => ({
  userId: ids.owner,
  deviceCredentialId: ids.device,
  upstreamBackendId: "enrolled-team",
  clientRequestId: ids.approval,
  intent: enableIntent,
  projectSharePolicyRepository: {
    getReview: vi.fn(async () => state)
  } as unknown as ProjectSharePolicyRepository
});
const enable = projectSharePolicyActionDefinitions[enableIntent.action];

describe("Project policy approval boundary", () => {
  it("requires Native review for summary policy and discloses separate Curated consent", async () => {
    const request = input();
    const admitted = await enable.admit(request);
    expect(admitted?.policy.disposition).toBe("native_review");
    expect(admitted?.policy.review?.description).toContain("HQ and private");
    expect(admitted?.policy.review?.description).toContain(
      "Curated Memory require separate approval"
    );
    expect(admitted?.policy.review?.reviewSources).toHaveLength(1);
    expect(request.projectSharePolicyRepository.getReview).toHaveBeenCalledWith(
      {
        userId: ids.owner,
        deviceCredentialId: ids.device,
        upstreamBackendId: "enrolled-team"
      },
      {
        projectId: ids.project,
        expectedPolicyVersion: 0,
        manifestId: ids.manifest,
        manifestHash: enableIntent.manifestHash
      }
    );
  });

  it("rejects absent device authority, a foreign Team, and unavailable or already-active policy", async () => {
    for (const request of [
      { ...input(), deviceCredentialId: undefined },
      { ...input(), upstreamBackendId: undefined },
      { ...input(), projectSharePolicyRepository: null },
      input(null),
      input(review({ teamId: randomUUID() })),
      input(review({ status: "active" }))
    ])
      await expect(enable.admit(request)).rejects.toBeInstanceOf(
        ActionApprovalPolicyError
      );
  });

  it("binds the exact manifest, version, Project and approved reference into the mutation", async () => {
    const admitted = await enable.admit(input());
    const binding = { ...enableIntent, referenceId: ids.approval };
    const expected = projectSharePolicyActionGrantBinding(binding);
    expect(admitted?.operation).toEqual(expected);
    for (const changed of [
      { ...binding, manifestHash: "b".repeat(64) },
      { ...binding, manifestId: randomUUID() },
      { ...binding, expectedPolicyVersion: 2 },
      { ...binding, projectId: randomUUID() },
      { ...binding, referenceId: randomUUID() }
    ])
      expect(
        projectSharePolicyActionGrantBinding(changed).requestHash
      ).not.toBe(expected.requestHash);
  });

  it("keeps revoke Native and explains that existing grants retain their own lifecycle", async () => {
    const action = "shared_memory.project_share_policy.revoke" as const;
    const request = {
      ...input(review({ status: "active", policyVersion: 1 })),
      intent: {
        action,
        teamId: ids.team,
        projectId: ids.project,
        expectedPolicyVersion: 1
      }
    };
    const admitted =
      await projectSharePolicyActionDefinitions[action].admit(request);
    expect(admitted?.policy.disposition).toBe("native_review");
    expect(admitted?.policy.review?.consequence).toContain(
      "Existing Share Grants keep their own consent"
    );
    expect(admitted?.policy.review?.reviewSources).toBeUndefined();
    await expect(
      projectSharePolicyActionDefinitions[action].admit({
        ...request,
        projectSharePolicyRepository: input(review({ status: "revoked" }))
          .projectSharePolicyRepository
      })
    ).rejects.toBeInstanceOf(ActionApprovalPolicyError);
  });

  it("can review the bounded 100 sources without widening the generic details limit", async () => {
    const sources = Array.from({ length: 100 }, (_, index) => ({
      sessionId: randomUUID(),
      reviewLabel: `Chat ${index + 1}`,
      eligible: true
    }));
    const admitted = await enable.admit(
      input(review({ reviewSources: sources, eligibleCount: 100 }))
    );
    expect(admitted?.policy.review?.reviewSources).toHaveLength(100);
    expect(admitted?.policy.review?.details.length).toBeLessThanOrEqual(12);
    await expect(
      enable.admit(input(review({ reviewSources: [...sources, sources[0]!] })))
    ).rejects.toThrow();
  });

  it("does not admit an unknown action or a renderer-selected source into policy approval", () => {
    expect(
      highRiskActionGrantIntentSchema.safeParse({
        ...enableIntent,
        sessionId: randomUUID()
      }).success
    ).toBe(false);
    expect(
      highRiskActionGrantIntentSchema.safeParse({
        action: "shared_memory.project_share_policy.apply_session_grant",
        projectId: ids.project,
        sessionId: randomUUID()
      }).success
    ).toBe(false);
  });
});
