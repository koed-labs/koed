import { describe, expect, it, vi } from "vitest";
import { handleHqSourceControlMerge } from "./hq-source-control-merge-client.js";
import { reviewAndDispatchSourceControlMerge } from "./source-control-merge-native-client.js";
vi.mock("./source-control-merge-native-client.js", () => ({
  reviewAndDispatchSourceControlMerge: vi.fn(async () => null)
}));
const request = {
  operation: "source_control_merge" as const,
  requestId: "test-request",
  executionId: "run",
  executionGeneration: 2,
  remoteIdentityHash: "a".repeat(64),
  reviewRequestNumber: 17,
  mergeMethod: "squash" as const,
  proposalItemId: "proposal"
};
const proposal = {
  id: "proposal",
  executionGeneration: 2,
  providerRequestId: "review-request-merge-propose:17",
  payload: { mergeProposal: { reviewRequestNumber: 17 } }
};
describe("HQ merge proposal orchestration", () => {
  it("rejects a changed proposal before Native review and does not record a decline", async () => {
    vi.mocked(reviewAndDispatchSourceControlMerge).mockClear();
    const requestJson = vi.fn(async () => ({
      items: [{ ...proposal, executionGeneration: 3 }]
    }));
    await expect(
      handleHqSourceControlMerge({
        request,
        requestJson,
        access: async () => ({ authorization: "secret" })
      })
    ).rejects.toThrow("no longer matches");
    expect(reviewAndDispatchSourceControlMerge).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledTimes(1);
  });
  it("persists a Native decline only against the exact validated proposal and generation", async () => {
    const requestJson = vi.fn<
      Parameters<typeof handleHqSourceControlMerge>[0]["requestJson"]
    >(async () => ({ items: [proposal] }));
    expect(
      await handleHqSourceControlMerge({
        request,
        requestJson,
        access: async () => ({ authorization: "secret" })
      })
    ).toMatchObject({
      operation: "source_control_merge",
      result: { kind: "declined" }
    });
    expect(requestJson.mock.calls[1]).toEqual([
      "/v1/managed-conversations/run/merge-proposals/proposal/decline",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionGeneration: 2 })
      },
      256 * 1024
    ]);
  });
});
