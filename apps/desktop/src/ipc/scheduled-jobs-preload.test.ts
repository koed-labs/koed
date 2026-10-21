import { describe, expect, it, vi } from "vitest";
import { createScheduledJobsPreloadApi } from "./scheduled-jobs-preload.js";
import { scheduledJobsChannel } from "./scheduled-jobs-protocol.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";

describe("Scheduled Jobs preload", () => {
  it("passes an exact typed read through the dedicated channel", async () => {
    const invoke = vi.fn(async () => ({
      operation: "runs",
      jobId,
      runs: [],
      nextCursor: null
    }));
    const api = createScheduledJobsPreloadApi(invoke);
    expect(await api.command({ operation: "runs", jobId })).toEqual({
      operation: "runs",
      jobId,
      runs: [],
      nextCursor: null
    });
    expect(invoke).toHaveBeenCalledWith(scheduledJobsChannel, {
      operation: "runs",
      jobId
    });
  });
  it("rejects a changed top-level Job id even with an empty run page", async () => {
    const api = createScheduledJobsPreloadApi(async () => ({
      operation: "runs",
      jobId: otherId,
      runs: [],
      nextCursor: null
    }));
    await expect(api.command({ operation: "runs", jobId })).rejects.toThrow(
      "identity mismatch"
    );
  });
  it("rejects malformed or mismatched operations before returning to the renderer", async () => {
    const api = createScheduledJobsPreloadApi(async () => ({
      operation: "list",
      jobs: [],
      nextCursor: null
    }));
    await expect(api.command({ operation: "get", jobId })).rejects.toThrow(
      "operation mismatch"
    );
    await expect(
      api.command({ operation: "runs", jobId, unexpected: true } as never)
    ).rejects.toThrow();
  });
});
