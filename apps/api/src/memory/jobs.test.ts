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
    log: { warn: vi.fn() }
  });
  return { scheduler, embeddingQueue, compactionQueue };
};

describe("memory job scheduler", () => {
  it("queues Memory processing with identifiers only", async () => {
    const { scheduler, embeddingQueue, compactionQueue } = createScheduler();

    await expect(
      scheduler.scheduleMemoryEventProcessing(
        {} as never,
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
      { sourceType: "memory_event", sourceId: "event-1" },
      expect.any(Object)
    );
    expect(compactionQueue.add).toHaveBeenCalledWith(
      "compact-scope",
      { userId: "user-1", visibility: "personal" },
      expect.any(Object)
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

  it("queues projected Memory Event processing without source text", async () => {
    const { scheduler, embeddingQueue, compactionQueue } = createScheduler();

    await expect(
      scheduler.scheduleProjectedMemoryEventProcessing(
        {} as never,
        { userId: "user-2" },
        [
          { eventId: "event-2", visibility: "personal" },
          { eventId: "event-3", visibility: "personal" }
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
  });
});
