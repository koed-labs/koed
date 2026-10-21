import { describe, expect, it, vi } from "vitest";
import { createScheduledJobsClient } from "./scheduled-jobs-client.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const authority = (key: string) => ({
  key,
  ownerId,
  apiOrigin: "http://127.0.0.1:9999",
  authorization: key
});

describe("Scheduled Jobs owner transport", () => {
  it("sends Run now with the original request id and rejects a switched profile", async () => {
    let key = "profile-a";
    const requestJson = vi.fn(async () => {
      key = "profile-b";
      return {
        id: "33333333-3333-4333-8333-333333333333",
        jobId,
        scheduledFor: new Date().toISOString(),
        trigger: "manual",
        attempt: 0,
        status: "scheduled",
        skipReason: null,
        startedAt: null,
        finishedAt: null,
        executionId: null,
        error: null
      };
    });
    const client = createScheduledJobsClient({
      authority: async () => authority(key),
      requestJson
    });
    const requestId = "44444444-4444-4444-8444-444444444444";
    await expect(
      client({ operation: "runNow", jobId, expectedVersion: 2, requestId })
    ).rejects.toThrow("profile changed");
    expect(requestJson).toHaveBeenCalledWith(
      `/v1/scheduled-jobs/${jobId}/run-now`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedVersion: 2, requestId })
      }),
      expect.objectContaining({ authorization: "profile-a" })
    );
  });
  it("rejects another Job's run even when the API returns valid data", async () => {
    const client = createScheduledJobsClient({
      authority: async () => authority("profile-a"),
      requestJson: async () => ({
        id: "33333333-3333-4333-8333-333333333333",
        jobId: ownerId,
        scheduledFor: new Date().toISOString(),
        trigger: "manual",
        attempt: 0,
        status: "scheduled",
        skipReason: null,
        startedAt: null,
        finishedAt: null,
        executionId: null,
        error: null
      })
    });
    await expect(
      client({
        operation: "runNow",
        jobId,
        expectedVersion: 2,
        requestId: "44444444-4444-4444-8444-444444444444"
      })
    ).rejects.toThrow("identity mismatch");
  });
});
