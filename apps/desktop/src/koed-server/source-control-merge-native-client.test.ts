import { describe, expect, it, vi } from "vitest";

import { reviewAndDispatchSourceControlMerge } from "./source-control-merge-native-client.js";

const selector = {
  executionId: "11111111-1111-4111-8111-111111111111",
  executionGeneration: 2,
  remoteIdentityHash: "a".repeat(64),
  reviewRequestNumber: 7,
  mergeMethod: "squash" as const
};
const prepared = {
  kind: "review_request_merge_prepared",
  operationId: "22222222-2222-4222-8222-222222222222",
  operationGeneration: 1,
  idempotencyKey: "merge:22222222-2222-4222-8222-222222222222",
  readinessSnapshotDigest: "b".repeat(64),
  expiresAt: "2026-10-20T22:00:00.000Z",
  readiness: {
    provider: "github",
    accountLabel: "Account",
    host: "github.com",
    apiOrigin: "https://api.github.com",
    repository: "acme/repo",
    remoteIdentityHash: selector.remoteIdentityHash,
    connectionId: "33333333-3333-4333-8333-333333333333",
    executionId: selector.executionId,
    executionGeneration: 2,
    runnerDeploymentId: "44444444-4444-4444-8444-444444444444",
    runnerDeviceId: "55555555-5555-4555-8555-555555555555",
    credentialGeneration: 4,
    policyVersion: 1,
    policyDigest: "e".repeat(64),
    reviewRequestNumber: 7,
    title: "Ship feature",
    targetBranch: "main",
    expectedHeadObjectId: "c".repeat(40),
    mergeability: "mergeable",
    reviewDecision: "approved",
    requiredReviewCount: 1,
    approvedReviewCount: 1,
    reviews: [
      {
        id: "1",
        user: "reviewer",
        commitObjectId: "c".repeat(40),
        state: "APPROVED",
        submittedAt: "2026-10-20T00:00:00.000Z"
      }
    ],
    checks: [
      {
        id: "2",
        name: "ci",
        source: "check_run",
        state: "success",
        required: true,
        appId: 7,
        objectId: "c".repeat(40)
      }
    ],
    allowedMergeMethods: ["squash"],
    mergeMethod: "squash",
    protectionDigest: "d".repeat(64)
  }
};
const result = {
  kind: "review_request_merge_result",
  operationId: prepared.operationId,
  outcome: "pending",
  providerOperationId: null,
  mergeCommitObjectId: null
};

describe("native merge client", () => {
  it("does not show private PR details if the Desktop profile changes during preparation", async () => {
    const access = vi
      .fn()
      .mockResolvedValueOnce({ authorization: "Koed-Desktop original:secret" })
      .mockResolvedValueOnce({ authorization: "Koed-Desktop switched:secret" });
    const request = vi.fn(
      async () => prepared as unknown as Record<string, unknown>
    );
    const confirm = vi.fn(async () => true);
    await expect(
      reviewAndDispatchSourceControlMerge({
        selector,
        access,
        request,
        confirm
      })
    ).rejects.toThrow("Desktop credential changed before merge review");
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not show a prepared PR that differs from the requested selector", async () => {
    const request = vi.fn(
      async () =>
        ({
          ...prepared,
          readiness: {
            ...prepared.readiness,
            reviewRequestNumber: 8
          }
        }) as unknown as Record<string, unknown>
    );
    const confirm = vi.fn(async () => true);
    await expect(
      reviewAndDispatchSourceControlMerge({
        selector,
        access: async () => ({ authorization: "Koed-Desktop fixture:secret" }),
        request,
        confirm
      })
    ).rejects.toThrow("Merge preparation does not match the requested review");
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never dispatches a merge when Native review is declined regardless of permission mode", async () => {
    const request = vi.fn(
      async () => prepared as unknown as Record<string, unknown>
    );
    const reviewed = await reviewAndDispatchSourceControlMerge({
      selector,
      access: async () => ({ authorization: "Koed-Desktop fixture:secret" }),
      request,
      confirm: async () => false
    });
    expect(reviewed).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("binds proof to the exact prepared operation after Native review", async () => {
    const requests: Record<string, unknown>[] = [];
    const request = vi.fn(async (_path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push(body);
      return (requests.length === 1 ? prepared : result) as unknown as Record<
        string,
        unknown
      >;
    });
    const reviewed = await reviewAndDispatchSourceControlMerge({
      selector,
      access: async () => ({ authorization: "Koed-Desktop fixture:secret" }),
      request,
      confirm: async (shown) => {
        expect(shown).toMatchObject({
          operationId: prepared.operationId,
          readinessSnapshotDigest: prepared.readinessSnapshotDigest
        });
        return true;
      }
    });
    expect(reviewed).toMatchObject({ outcome: "pending" });
    expect(requests[0]).not.toHaveProperty("approvalProof");
    expect(requests[1]).toMatchObject({
      kind: "review_request_merge",
      operationId: prepared.operationId
    });
    expect(requests[1]?.approvalProof).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(requests)).not.toContain("fixture:secret");
    expect(JSON.stringify(reviewed)).not.toContain("fixture:secret");
    expect(JSON.stringify(prepared)).not.toContain("fixture:secret");
  });
});
