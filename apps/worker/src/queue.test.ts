import { beforeEach, describe, expect, it, vi } from "vitest";

const bullQueue = vi.hoisted(() => ({
  add: vi.fn(),
  close: vi.fn(),
  getJobCounts: vi.fn(),
  getJobs: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    name: string;
    add = bullQueue.add;
    close = bullQueue.close;
    getJobCounts = bullQueue.getJobCounts;
    getJobs = bullQueue.getJobs;

    constructor(name: string) {
      this.name = name;
    }

    toKey(type: string) {
      return `bull:${this.name}:${type}`;
    }
  },
  Worker: class {
    close = vi.fn();
    on = vi.fn();
  }
}));

import {
  createWorkerQueueProducer,
  createWorkerQueueRuntime
} from "./queue.js";

const createRepository = () => ({
  enqueue: vi.fn().mockResolvedValue({ id: 1 }),
  tryAcquireRuntimeLease: vi.fn().mockResolvedValue({
    requeueAbandonedJobs: vi.fn().mockResolvedValue(0),
    release: vi.fn().mockResolvedValue(undefined)
  }),
  claim: vi.fn().mockResolvedValue(null),
  complete: vi.fn().mockResolvedValue(true),
  fail: vi.fn().mockResolvedValue(true),
  getJobCounts: vi.fn().mockResolvedValue({ pending: 1 }),
  getOldestPendingAgeMs: vi.fn().mockResolvedValue(250)
});

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

describe("createWorkerQueueProducer", () => {
  beforeEach(() => {
    bullQueue.add.mockReset();
    bullQueue.close.mockReset();
    bullQueue.getJobCounts.mockReset();
    bullQueue.getJobs.mockReset().mockResolvedValue([]);
  });

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
      priority: 10,
      maxAttempts: undefined,
      backoffMs: undefined
    });
  });

  it("passes live priority ahead of historical priority to BullMQ", async () => {
    bullQueue.add
      .mockResolvedValueOnce({ id: "historical" })
      .mockResolvedValueOnce({ id: "live" });
    const queue = createWorkerQueueProducer<{ sourceId: string }>(
      "memory-embed",
      { backend: "bullmq", redisUrl: "redis://operator:6379" }
    );

    await queue.add(
      "embed-source",
      { sourceId: "historical" },
      { priority: 20 }
    );
    await queue.add("embed-source", { sourceId: "live" }, { priority: 5 });

    expect(bullQueue.add.mock.calls.map((call) => call[2]?.priority)).toEqual([
      20, 5
    ]);
  });

  it("reports oldest pending age for local and BullMQ queues", async () => {
    const repository = createRepository();
    const local = createWorkerQueueProducer("memory-embed", {
      backend: "local",
      redisUrl: "redis://localhost:6379",
      localQueueRepository: repository
    });
    const now = Date.now();
    bullQueue.getJobs.mockResolvedValueOnce([{ timestamp: now - 750 }]);
    const bullmq = createWorkerQueueProducer("memory-embed", {
      backend: "bullmq",
      redisUrl: "redis://localhost:6379"
    });

    await expect(local.getOldestPendingAgeMs?.()).resolves.toBe(250);
    await expect(
      bullmq.getOldestPendingAgeMs?.()
    ).resolves.toBeGreaterThanOrEqual(750);
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
    const queue = createWorkerQueueProducer("memory-embed", {
      backend: "bullmq",
      redisUrl: "redis://operator:6379"
    });

    await expect(queue.getJobCounts("waiting", "active")).resolves.toEqual({
      waiting: 5,
      active: 1
    });
    expect(bullQueue.getJobCounts).toHaveBeenCalledWith(
      "waiting",
      "active",
      "prioritized"
    );
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
    const createdAt = new Date(Date.now() - 100);
    repository.claim.mockResolvedValueOnce({
      id: 1,
      queueName: "memory-embed",
      jobName: "embed-source",
      data: { sourceId: "event-1" },
      attemptCount: 1,
      maxAttempts: 5,
      priority: 5,
      lockToken: "lock-1",
      createdAt
    });
    const handleJob = vi.fn().mockResolvedValue({ ok: true });
    const recordTelemetry = vi.fn().mockResolvedValue(undefined);
    const runtime = await createWorkerQueueRuntime({
      backend: "local",
      redisUrl: "redis://localhost:6379",
      localQueueRepository: repository,
      logger,
      lcmEmbedQueue: { add: vi.fn(), getJobCounts: vi.fn(), close: vi.fn() },
      handleJob,
      isTransientError: () => false,
      recordTelemetry,
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
    expect(recordTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: "memory-embed",
        data: { sourceId: "event-1" },
        outcome: "completed",
        result: { ok: true },
        createdAt,
        startedAt: expect.any(Date),
        finishedAt: expect.any(Date)
      })
    );
  });

  it("recovers abandoned local jobs before workers start", async () => {
    const repository = createRepository();
    const runtimeLease = {
      requeueAbandonedJobs: vi.fn().mockResolvedValue(2),
      release: vi.fn().mockResolvedValue(undefined)
    };
    repository.tryAcquireRuntimeLease.mockResolvedValue(runtimeLease);

    const runtime = await createWorkerQueueRuntime({
      backend: "local",
      redisUrl: "redis://localhost:6379",
      localQueueRepository: repository,
      logger,
      lcmEmbedQueue: { add: vi.fn(), getJobCounts: vi.fn(), close: vi.fn() },
      handleJob: vi.fn(),
      isTransientError: () => false,
      pollIntervalMs: 60_000
    });
    await runtime.close();

    expect(runtimeLease.requeueAbandonedJobs).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: {
          name: "worker.queue.abandoned_jobs_recovered",
          category: "job"
        },
        jobs: { recovered: 2 }
      }),
      "abandoned local queue jobs recovered"
    );
    expect(runtimeLease.release).toHaveBeenCalledOnce();
  });

  it.each([
    { transient: true, outcome: "retry" as const },
    { transient: false, outcome: "failed" as const }
  ])(
    "records $outcome telemetry for failed local work",
    async ({ transient, outcome }) => {
      const repository = createRepository();
      const createdAt = new Date(Date.now() - 100);
      repository.claim.mockResolvedValueOnce({
        id: 2,
        queueName: "memory-embed",
        jobName: "embed-source",
        data: { sourceId: "event-2" },
        attemptCount: 1,
        maxAttempts: 5,
        priority: 5,
        lockToken: "lock-2",
        createdAt
      });
      const recordTelemetry = vi.fn().mockResolvedValue(undefined);
      const runtime = await createWorkerQueueRuntime({
        backend: "local",
        redisUrl: "redis://localhost:6379",
        localQueueRepository: repository,
        logger,
        lcmEmbedQueue: { add: vi.fn(), getJobCounts: vi.fn(), close: vi.fn() },
        handleJob: vi.fn().mockRejectedValue(new Error("embedding failed")),
        isTransientError: () => transient,
        recordTelemetry,
        pollIntervalMs: 60_000
      });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await runtime.close();

      expect(repository.fail).toHaveBeenCalledWith({
        id: 2,
        lockToken: "lock-2",
        errorMessage: "embedding failed",
        retry: transient
      });
      expect(recordTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({ outcome, createdAt })
      );
    }
  );

  it("rejects a second Postgres-backed local queue runtime", async () => {
    const repository = createRepository();
    repository.tryAcquireRuntimeLease.mockResolvedValue(null);

    await expect(
      createWorkerQueueRuntime({
        backend: "local",
        redisUrl: "redis://localhost:6379",
        localQueueRepository: repository,
        logger,
        lcmEmbedQueue: { add: vi.fn(), getJobCounts: vi.fn(), close: vi.fn() },
        handleJob: vi.fn(),
        isTransientError: () => false
      })
    ).rejects.toThrow(
      "Another Postgres-backed local work queue runtime is already active"
    );
  });

  it("reconciles unprioritized BullMQ jobs before starting workers", async () => {
    const legacyJob = {
      opts: {},
      changePriority: vi.fn().mockResolvedValue(undefined)
    };
    const prioritizedJob = {
      opts: { priority: 5 },
      changePriority: vi.fn()
    };
    const delayedLegacyJob = {
      id: "delayed-1",
      opts: { priority: 0 },
      changePriority: vi.fn()
    };
    bullQueue.getJobs
      .mockResolvedValueOnce([legacyJob, prioritizedJob])
      .mockResolvedValueOnce([delayedLegacyJob])
      .mockResolvedValue([]);

    const runtime = await createWorkerQueueRuntime({
      backend: "bullmq",
      redisUrl: "redis://localhost:6379",
      logger,
      lcmEmbedQueue: { add: vi.fn(), getJobCounts: vi.fn(), close: vi.fn() },
      handleJob: vi.fn(),
      isTransientError: () => false
    });
    await runtime.close();

    expect(legacyJob.changePriority).toHaveBeenCalledWith({ priority: 10 });
    expect(prioritizedJob.changePriority).not.toHaveBeenCalled();
    expect(delayedLegacyJob.changePriority).toHaveBeenCalledWith({
      priority: 10
    });
    expect(bullQueue.getJobs).toHaveBeenCalledTimes(6);
  });
});
