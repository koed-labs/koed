import { describe, expect, it, vi } from "vitest";
import {
  createWorkerQueueProducer,
  createWorkerQueueRuntime
} from "./queue.js";

const createRepository = () => ({
  enqueue: vi.fn().mockResolvedValue({ id: 1 }),
  claim: vi.fn().mockResolvedValue(null),
  complete: vi.fn().mockResolvedValue(true),
  fail: vi.fn().mockResolvedValue(true),
  getJobCounts: vi.fn().mockResolvedValue({ pending: 1 })
});

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

describe("createWorkerQueueProducer", () => {
  it("creates local durable queue producer when repository exists", async () => {
    const repository = createRepository();
    const queue = createWorkerQueueProducer<{ sourceId: string }>(
      "memory-embed",
      {
        backend: "local",
        redisUrl: "redis://localhost:6379",
        localQueueRepository: repository
      }
    );

    await expect(
      queue.add("embed-source", { sourceId: "event-1" }, { jobId: "job-1" })
    ).resolves.toEqual({ id: 1 });
    expect(repository.enqueue).toHaveBeenCalledWith({
      queueName: "memory-embed",
      jobName: "embed-source",
      data: { sourceId: "event-1" },
      jobKey: "job-1",
      maxAttempts: undefined,
      backoffMs: undefined
    });
  });

  it("fails fast for local queue backend without database", () => {
    expect(() =>
      createWorkerQueueProducer("memory-embed", {
        backend: "local",
        redisUrl: "redis://localhost:6379"
      })
    ).toThrow("DATABASE_URL is required for local queue backend");
  });
});

describe("createWorkerQueueRuntime", () => {
  it("claims and completes local jobs", async () => {
    const repository = createRepository();
    repository.claim.mockResolvedValueOnce({
      id: 1,
      queueName: "memory-embed",
      jobName: "embed-source",
      data: { sourceId: "event-1" },
      attemptCount: 1,
      maxAttempts: 5,
      lockToken: "lock-1"
    });
    const handleJob = vi.fn().mockResolvedValue({ ok: true });
    const runtime = createWorkerQueueRuntime({
      backend: "local",
      redisUrl: "redis://localhost:6379",
      localQueueRepository: repository,
      logger,
      lcmEmbedQueue: { add: vi.fn(), getJobCounts: vi.fn(), close: vi.fn() },
      handleJob,
      isTransientError: () => false,
      pollIntervalMs: 60_000
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.close();

    expect(handleJob).toHaveBeenCalledWith("memory-embed", {
      sourceId: "event-1"
    });
    expect(repository.complete).toHaveBeenCalledWith({
      id: 1,
      lockToken: "lock-1"
    });
  });
});
