import { describe, expect, it, vi } from "vitest";
import { createCollaborationReplayPruneService } from "./collaboration-replay-prune-service.js";

describe("collaboration replay prune service", () => {
  it("runs bounded pruning and reports removed records without content", async () => {
    const pruneExpiredReplayHistory = vi.fn().mockResolvedValue({
      deletedEventCount: 7,
      deletedSubscriptionCount: 2
    });
    const logger = { info: vi.fn(), error: vi.fn() };
    const service = createCollaborationReplayPruneService({
      repository: { pruneExpiredReplayHistory },
      logger,
      batchLimit: 250
    });

    await expect(service.processOnce()).resolves.toEqual({
      deletedEventCount: 7,
      deletedSubscriptionCount: 2
    });
    expect(pruneExpiredReplayHistory).toHaveBeenCalledWith({ limit: 250 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedEventCount: 7,
        deletedSubscriptionCount: 2
      }),
      "expired collaboration replay history pruned"
    );
  });

  it("logs a sanitized error and continues scheduling after a failure", async () => {
    vi.useFakeTimers();
    const pruneExpiredReplayHistory = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("sensitive database detail"))
      .mockResolvedValue({
        deletedEventCount: 0,
        deletedSubscriptionCount: 0
      });
    const logger = { info: vi.fn(), error: vi.fn() };
    const service = createCollaborationReplayPruneService({
      repository: { pruneExpiredReplayHistory },
      logger,
      intervalMs: 1_000
    });

    service.start();
    await vi.runOnlyPendingTimersAsync();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: "TypeError" }),
      "collaboration replay history prune failed"
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "sensitive database detail"
    );
    service.stop();
    vi.useRealTimers();
  });
});
