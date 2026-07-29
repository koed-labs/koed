import { beforeEach, describe, expect, it, vi } from "vitest";

const bullQueue = vi.hoisted(() => ({
  add: vi.fn(),
  close: vi.fn(),
  getJobCounts: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = bullQueue.add;
    close = bullQueue.close;
    getJobCounts = bullQueue.getJobCounts;
  }
}));

import { createMemoryJobQueue } from "./queue.js";

const createRepository = () => ({
  enqueue: vi.fn().mockResolvedValue({ id: 1 }),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  tryAcquireRuntimeLease: vi.fn(),
  getJobCounts: vi.fn().mockResolvedValue({ pending: 1 })
});

describe("createMemoryJobQueue", () => {
  beforeEach(() => {
    bullQueue.add.mockReset();
    bullQueue.close.mockReset();
    bullQueue.getJobCounts.mockReset();
  });

  it("creates local durable queue producer when repository exists", async () => {
    const repository = createRepository();
    const queue = createMemoryJobQueue<{ sourceId: string }>("memory-embed", {
      backend: "local",
      localQueueRepository: repository
    });

    await expect(
      queue?.add(
        "embed-source",
        { sourceId: "event-1" },
        {
          jobId: "job-1",
          priority: 20,
          attempts: 5,
          backoff: { type: "exponential", delay: 1000 }
        }
      )
    ).resolves.toEqual({ id: 1 });
    expect(repository.enqueue).toHaveBeenCalledWith({
      queueName: "memory-embed",
      jobName: "embed-source",
      data: { sourceId: "event-1" },
      jobKey: "job-1",
      priority: 20,
      maxAttempts: 5,
      backoffMs: 1000
    });
  });

  it("defaults unspecified local and BullMQ jobs to normal priority", async () => {
    const repository = createRepository();
    const local = createMemoryJobQueue<{ sourceId: string }>("memory-embed", {
      backend: "local",
      localQueueRepository: repository
    });
    const bullmq = createMemoryJobQueue<{ sourceId: string }>("memory-embed", {
      backend: "bullmq",
      redisUrl: "redis://operator:6379"
    });
    bullQueue.add.mockResolvedValueOnce({ id: "normal" });

    await local?.add("embed-source", { sourceId: "local-normal" });
    await bullmq?.add("embed-source", { sourceId: "bull-normal" });

    expect(repository.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 10 })
    );
    expect(bullQueue.add).toHaveBeenCalledWith(
      "embed-source",
      { sourceId: "bull-normal" },
      { priority: 10 }
    );
  });

  it("passes matching live-over-history priorities to BullMQ", async () => {
    bullQueue.add
      .mockResolvedValueOnce({ id: "historical" })
      .mockResolvedValueOnce({ id: "live" });
    const queue = createMemoryJobQueue<{ sourceId: string }>("memory-embed", {
      backend: "bullmq",
      redisUrl: "redis://operator:6379"
    });

    await queue?.add(
      "embed-source",
      { sourceId: "historical" },
      { priority: 20 }
    );
    await queue?.add("embed-source", { sourceId: "live" }, { priority: 5 });

    expect(bullQueue.add).toHaveBeenNthCalledWith(
      1,
      "embed-source",
      { sourceId: "historical" },
      { priority: 20 }
    );
    expect(bullQueue.add).toHaveBeenNthCalledWith(
      2,
      "embed-source",
      { sourceId: "live" },
      { priority: 5 }
    );
    expect([20, 5].sort((left, right) => left - right)[0]).toBe(5);
  });

  it("returns no queue when local backend lacks database", () => {
    expect(
      createMemoryJobQueue("memory-embed", {
        backend: "local",
        redisUrl: "redis://localhost:6379"
      })
    ).toBeNull();
  });

  it("returns no queue when BullMQ backend lacks Redis config", () => {
    expect(
      createMemoryJobQueue("memory-embed", {
        backend: "bullmq"
      })
    ).toBeNull();
  });
});
