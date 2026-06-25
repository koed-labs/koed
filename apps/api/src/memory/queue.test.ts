import { describe, expect, it, vi } from "vitest";
import { createMemoryJobQueue } from "./queue.js";

const createRepository = () => ({
  enqueue: vi.fn().mockResolvedValue({ id: 1 }),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  getJobCounts: vi.fn().mockResolvedValue({ pending: 1 })
});

describe("createMemoryJobQueue", () => {
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
      maxAttempts: 5,
      backoffMs: 1000
    });
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
