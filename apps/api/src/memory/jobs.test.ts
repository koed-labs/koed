import { describe, expect, it, vi } from "vitest";
import { createMemoryJobScheduler } from "./jobs.js";

const createQueue = () => ({
  add: vi.fn().mockResolvedValue({ id: "job-1" }),
  getJobCounts: vi.fn(),
  close: vi.fn()
});

const createScheduler = () => {
  const embeddingQueue = createQueue();
  const compactionQueue = createQueue();
  const scheduler = createMemoryJobScheduler({
    embeddingQueue,
    compactionQueue,
    embeddingDispatchKey: "qwen3-0.6b-1024",
    log: { warn: vi.fn() }
  });
  const repository = {
    listPendingLcmDispatchScopes: vi.fn().mockResolvedValue([
      {
        ownerUserId: "user-1",
        visibility: "personal",
        workClass: "normal_embedding_lcm",
        pendingMemoryEventIds: ["event-1"],
        dispatchKey: "lcm-dispatch-user-1",
        jobId: "compact-user-1-personal-live"
      }
    ]),
    markConversationProjectionProcessingDispatched: vi.fn().mockResolvedValue(1)
  };
  return { scheduler, embeddingQueue, compactionQueue, repository };
};

describe("memory job scheduler", () => {
  it("queues Memory processing with identifiers only", async () => {
    const { scheduler, embeddingQueue, compactionQueue, repository } =
      createScheduler();

    await expect(
      scheduler.scheduleMemoryEventProcessing(
        repository as never,
        { userId: "user-1" },
        "event-1",
        "personal"
      )
    ).resolves.toMatchObject({
      embedding: { queued: true },
      compaction: { queued: true }
    });

    expect(embeddingQueue.add).toHaveBeenCalledWith(
      "embed-source",
      {
        sourceType: "memory_event",
        sourceId: "event-1",
        workClass: "normal_embedding_lcm"
      },
      expect.objectContaining({
        priority: 10,
        jobId: "embed-qwen3-0-6b-1024-memory_event-event-1"
      })
    );
    expect(compactionQueue.add).toHaveBeenCalledWith(
      "compact-scope",
      {
        userId: "user-1",
        visibility: "personal",
        workClass: "normal_embedding_lcm"
      },
      expect.objectContaining({
        priority: 10,
        jobId: "compact-user-1-personal-live"
      })
    );
    const queuedPayloads = JSON.stringify([
      embeddingQueue.add.mock.calls[0]?.[1],
      compactionQueue.add.mock.calls[0]?.[1]
    ]);
    expect(queuedPayloads).not.toContain("content");
    expect(queuedPayloads).not.toContain("payload");
    expect(queuedPayloads).not.toContain("query");
    expect(queuedPayloads).not.toContain("answer");
  });

  it("uses a distinct job identity for a revised mutable source", async () => {
    const { scheduler, embeddingQueue } = createScheduler();

    await scheduler.enqueueEmbedding(
      "memory_node",
      "node-1",
      "normal_embedding_lcm",
      undefined,
      "revision-hash-2"
    );

    expect(embeddingQueue.add).toHaveBeenCalledWith(
      "embed-source",
      {
        sourceType: "memory_node",
        sourceId: "node-1",
        workClass: "normal_embedding_lcm"
      },
      expect.objectContaining({
        jobId: "embed-qwen3-0-6b-1024-memory_node-node-1-revision-hash-2"
      })
    );
  });

  it("queues projected Memory Event processing without source text", async () => {
    const { scheduler, embeddingQueue, compactionQueue, repository } =
      createScheduler();
    repository.listPendingLcmDispatchScopes.mockResolvedValue([
      {
        ownerUserId: "user-2",
        visibility: "personal",
        workClass: "live_capture_projection",
        pendingMemoryEventIds: ["event-2"],
        dispatchKey: "lcm-dispatch-user-2",
        jobId: "compact-user-2-personal-live"
      }
    ]);

    await expect(
      scheduler.scheduleProjectedMemoryEventProcessing(
        repository as never,
        { userId: "user-2" },
        [
          {
            eventId: "event-2",
            visibility: "personal",
            includeInEmbedding: true,
            includeInLcm: true,
            workClass: "live_capture_projection"
          },
          {
            eventId: "event-3",
            visibility: "personal",
            includeInEmbedding: true,
            includeInLcm: false,
            workClass: "historical_import_backfill"
          }
        ]
      )
    ).resolves.toMatchObject({
      embeddings: [{ queued: true }, { queued: true }],
      compactions: [{ queued: true }]
    });

    const queuedPayloads = JSON.stringify([
      embeddingQueue.add.mock.calls.map((call) => call[1]),
      compactionQueue.add.mock.calls.map((call) => call[1])
    ]);
    expect(queuedPayloads).toContain("event-2");
    expect(queuedPayloads).toContain("event-3");
    expect(queuedPayloads).not.toContain("content");
    expect(queuedPayloads).not.toContain("payload");
    expect(queuedPayloads).not.toContain("query");
    expect(queuedPayloads).not.toContain("answer");
    expect(embeddingQueue.add.mock.calls.map((call) => call[2]?.jobId)).toEqual(
      ["projection-embed-event-2", "projection-embed-event-3"]
    );
    expect(
      compactionQueue.add.mock.calls.map((call) => call[2]?.jobId)
    ).toEqual(["compact-user-2-personal-live"]);
    expect(
      repository.markConversationProjectionProcessingDispatched
    ).toHaveBeenCalledWith(["event-2", "event-3"]);
  });

  it("leaves projected processing pending when queue admission fails", async () => {
    const { scheduler, compactionQueue, repository } = createScheduler();
    compactionQueue.add.mockRejectedValueOnce(new Error("queue degraded"));

    const result = await scheduler.scheduleProjectedMemoryEventProcessing(
      repository as never,
      { userId: "user-3" },
      [
        {
          eventId: "event-4",
          visibility: "personal",
          includeInEmbedding: true,
          includeInLcm: true,
          workClass: "historical_import_backfill"
        }
      ]
    );

    expect(result.compactions[0]).toMatchObject({ queued: false });
    expect(
      repository.markConversationProjectionProcessingDispatched
    ).not.toHaveBeenCalled();
  });
});
