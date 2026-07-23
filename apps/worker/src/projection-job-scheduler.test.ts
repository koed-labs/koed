import { describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository } from "@koed/db";
import { createProjectionJobScheduler } from "./projection-job-scheduler.js";

const createQueue = () => ({
  add: vi.fn().mockResolvedValue({ id: "job-1" }),
  getJobCounts: vi.fn(),
  close: vi.fn()
});

const createRepository = () => ({
  listPendingConversationProjectionProcessing: vi.fn().mockResolvedValue([]),
  listPendingLcmDispatchScopes: vi.fn(({ ownerUserId, workClass }) =>
    Promise.resolve([
      {
        ownerUserId,
        visibility: "personal",
        workClass,
        pendingMemoryEventIds: ["event-1"],
        dispatchKey: `dispatch-${workClass}`,
        jobId: `compact-${ownerUserId}-personal-${workClass}`
      }
    ])
  ),
  markConversationProjectionProcessingDispatched: vi.fn().mockResolvedValue(1)
});

const historicalScope = {
  eventId: "event-1",
  visibility: "personal" as const,
  workClass: "historical_import_backfill" as const,
  includeInEmbedding: true,
  includeInLcm: true
};

const createScheduler = () => {
  const embeddingQueue = createQueue();
  const compactionQueue = createQueue();
  const repository = createRepository();
  const logger = { warn: vi.fn() };
  const scheduler = createProjectionJobScheduler({
    embeddingQueue,
    compactionQueue,
    repository: repository as unknown as MemorySourceRepository,
    logger
  });
  return { scheduler, embeddingQueue, compactionQueue, repository, logger };
};

describe("projection job scheduler", () => {
  it("uses deterministic prioritized jobs before acknowledging outbox work", async () => {
    const { scheduler, embeddingQueue, compactionQueue, repository } =
      createScheduler();

    await scheduler.enqueue({ userId: "user-1" }, [historicalScope]);

    expect(embeddingQueue.add).toHaveBeenCalledWith(
      "embed-source",
      {
        sourceType: "memory_event",
        sourceId: "event-1",
        workClass: "historical_import_backfill"
      },
      expect.objectContaining({
        jobId: "projection-embed-event-1",
        priority: 20
      })
    );
    expect(compactionQueue.add).toHaveBeenCalledWith(
      "compact-scope",
      {
        userId: "user-1",
        visibility: "personal",
        workClass: "historical_import_backfill"
      },
      expect.objectContaining({
        jobId: "compact-user-1-personal-historical_import_backfill",
        priority: 20
      })
    );
    expect(
      repository.markConversationProjectionProcessingDispatched
    ).toHaveBeenCalledWith(["event-1"]);
  });

  it("coalesces compaction by scope while acknowledging every event", async () => {
    const { scheduler, embeddingQueue, compactionQueue, repository } =
      createScheduler();

    await scheduler.enqueue({ userId: "user-1" }, [
      historicalScope,
      { ...historicalScope, eventId: "event-2" }
    ]);

    expect(embeddingQueue.add).toHaveBeenCalledTimes(2);
    expect(compactionQueue.add).toHaveBeenCalledTimes(1);
    expect(compactionQueue.add).toHaveBeenCalledWith(
      "compact-scope",
      expect.any(Object),
      expect.objectContaining({
        jobId: "compact-user-1-personal-historical_import_backfill"
      })
    );
    expect(
      repository.markConversationProjectionProcessingDispatched
    ).toHaveBeenCalledWith(["event-1", "event-2"]);
  });

  it("leaves outbox pending when either queue rejects", async () => {
    const { scheduler, compactionQueue, repository } = createScheduler();
    compactionQueue.add.mockRejectedValueOnce(new Error("queue degraded"));

    await expect(
      scheduler.enqueue({ userId: "user-1" }, [historicalScope])
    ).rejects.toThrow("queue degraded");
    expect(
      repository.markConversationProjectionProcessingDispatched
    ).not.toHaveBeenCalled();
  });

  it("admits eligible historical Memory Event embeddings newest-first", async () => {
    const { scheduler, embeddingQueue } = createScheduler();
    await scheduler.enqueue({ userId: "user-1" }, [
      {
        ...historicalScope,
        eventId: "oldest",
        sourceEventTime: "2026-01-01T00:00:00.000Z"
      },
      {
        ...historicalScope,
        eventId: "newest",
        sourceEventTime: "2026-07-01T00:00:00.000Z"
      },
      {
        ...historicalScope,
        eventId: "middle",
        sourceEventTime: "2026-04-01T00:00:00.000Z"
      }
    ]);

    expect(
      embeddingQueue.add.mock.calls.map((call) => call[1].sourceId)
    ).toEqual(["newest", "middle", "oldest"]);
  });

  it("replays a bounded durable outbox batch after restart", async () => {
    const { scheduler, embeddingQueue, compactionQueue, repository } =
      createScheduler();
    repository.listPendingConversationProjectionProcessing.mockResolvedValue([
      { ...historicalScope, userId: "user-1" }
    ]);

    await expect(scheduler.recover()).resolves.toBe(1);
    expect(
      repository.listPendingConversationProjectionProcessing
    ).toHaveBeenCalledWith(25);
    expect(embeddingQueue.add).toHaveBeenCalledTimes(1);
    expect(compactionQueue.add).toHaveBeenCalledTimes(1);
    expect(
      repository.markConversationProjectionProcessingDispatched
    ).toHaveBeenCalledWith(["event-1"]);
  });

  it("logs one failed recovery and continues with later live work", async () => {
    const { scheduler, compactionQueue, repository, logger } =
      createScheduler();
    repository.listPendingConversationProjectionProcessing.mockResolvedValue([
      { ...historicalScope, userId: "user-1" },
      {
        ...historicalScope,
        eventId: "event-2",
        userId: "user-2",
        workClass: "live_capture_projection"
      }
    ]);
    compactionQueue.add.mockRejectedValueOnce(new Error("queue degraded"));

    await expect(scheduler.recover()).resolves.toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: {
          name: "worker.projection_processing.recovery_failed",
          category: "job"
        },
        resource: { type: "memory_event", id: "event-1" }
      }),
      "projection processing recovery failed"
    );
    expect(
      repository.markConversationProjectionProcessingDispatched
    ).toHaveBeenCalledWith(["event-2"]);
  });
});
