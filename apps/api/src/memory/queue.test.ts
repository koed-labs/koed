import { beforeEach, describe, expect, it, vi } from "vitest";

const bullQueue = vi.hoisted(() => ({
  add: vi.fn(),
  close: vi.fn(),
  getJobCounts: vi.fn(),
  getJobs: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = bullQueue.add;
    close = bullQueue.close;
    getJobCounts = bullQueue.getJobCounts;
    getJobs = bullQueue.getJobs;
  }
}));

import { createMemoryJobQueue } from "./queue.js";

const createRepository = () => ({
  enqueue: vi.fn().mockResolvedValue({ id: 1 }),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  tryAcquireRuntimeLease: vi.fn(),
  getJobCounts: vi.fn().mockResolvedValue({ pending: 1 }),
  getOldestPendingAgeMs: vi.fn().mockResolvedValue(300)
});

describe("createMemoryJobQueue", () => {
  beforeEach(() => {
    bullQueue.add.mockReset();
    bullQueue.close.mockReset();
    bullQueue.getJobCounts.mockReset();
    bullQueue.getJobs.mockReset().mockResolvedValue([]);
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

  it("reports oldest pending age for local and BullMQ queues", async () => {
    const repository = createRepository();
    const local = createMemoryJobQueue("memory-embed", {
      backend: "local",
      localQueueRepository: repository
    });
    const now = Date.now();
    bullQueue.getJobs.mockResolvedValueOnce([{ timestamp: now - 600 }]);
    const bullmq = createMemoryJobQueue("memory-embed", {
      backend: "bullmq",
      redisUrl: "redis://operator:6379"
    });

    await expect(local?.getOldestPendingAgeMs?.()).resolves.toBe(300);
    await expect(
      bullmq?.getOldestPendingAgeMs?.()
    ).resolves.toBeGreaterThanOrEqual(600);
    expect(repository.getOldestPendingAgeMs).toHaveBeenCalledWith(
      "memory-embed"
    );
    expect(bullQueue.getJobs).toHaveBeenCalledWith(
      ["wait", "paused", "prioritized", "delayed"],
      0,
      0,
      true
    );
  });

  it("reports prioritized BullMQ jobs as waiting", async () => {
    bullQueue.getJobCounts.mockResolvedValueOnce({
      waiting: 2,
      prioritized: 3,
      active: 1
    });
    const queue = createMemoryJobQueue("memory-embed", {
      backend: "bullmq",
      redisUrl: "redis://operator:6379"
    });

    await expect(queue?.getJobCounts("waiting", "active")).resolves.toEqual({
      waiting: 5,
      active: 1
    });
    expect(bullQueue.getJobCounts).toHaveBeenCalledWith(
      "waiting",
      "active",
      "prioritized"
    );
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
