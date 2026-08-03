import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDbPool,
  createLocalWorkQueueRepository,
  runDbMigrations
} from "../src/index.js";

const createPool = () => ({
  query: vi.fn()
});

describe("local work queue repository", () => {
  it("enqueues jobs with retry and delay metadata", async () => {
    const pool = createPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "42" }] });
    const repo = createLocalWorkQueueRepository(pool as never);

    await expect(
      repo.enqueue({
        queueName: "memory-embed",
        jobName: "embed-source",
        data: { sourceId: "event-1" },
        jobKey: "job-1",
        priority: 20,
        maxAttempts: 5,
        backoffMs: 10_000,
        delayMs: 500
      })
    ).resolves.toEqual({ id: 42 });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("insert into local_work_queue"),
      [
        "memory-embed",
        "embed-source",
        "job-1",
        JSON.stringify({ sourceId: "event-1" }),
        20,
        5,
        10_000,
        "500 milliseconds"
      ]
    );
    const sql = String(pool.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("where job_key is not null");
    expect(sql).toContain("local_work_queue.status in ('failed', 'completed')");
    expect(sql).toContain("priority = case");
    expect(sql).toContain("then excluded.priority");
    expect(sql).toContain("then 'pending'");
  });

  it("defaults unspecified jobs to normal work priority", async () => {
    const pool = createPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "43" }] });
    const repo = createLocalWorkQueueRepository(pool as never);

    await repo.enqueue({
      queueName: "memory-embed",
      jobName: "embed-source",
      data: { sourceId: "event-2" }
    });

    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [
      "memory-embed",
      "embed-source",
      null,
      JSON.stringify({ sourceId: "event-2" }),
      10,
      1,
      null,
      "0 milliseconds"
    ]);
  });

  it("claims newer live work ahead of queued historical work", async () => {
    const pool = createPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "7",
          queue_name: "lcm-compact",
          job_name: "compact-live-scope",
          data: { userId: "user-1", workClass: "live_capture_projection" },
          attempt_count: 1,
          max_attempts: 5,
          priority: 5,
          lock_token: "lock-1"
        }
      ]
    });
    const repo = createLocalWorkQueueRepository(pool as never);

    await expect(
      repo.claim<{ userId: string }>({
        queueName: "lcm-compact",
        leaseMs: 60_000
      })
    ).resolves.toEqual({
      id: 7,
      queueName: "lcm-compact",
      jobName: "compact-live-scope",
      data: { userId: "user-1", workClass: "live_capture_projection" },
      attemptCount: 1,
      maxAttempts: 5,
      priority: 5,
      lockToken: "lock-1"
    });

    const sql = String(pool.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("expired_failed");
    expect(sql).toContain("attempt_count >= max_attempts");
    expect(sql).toContain("attempt_count < max_attempts");
    expect(sql).toContain("order by priority asc, available_at asc, id asc");
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [
      "lcm-compact",
      expect.any(String),
      "60000 milliseconds"
    ]);
  });

  it("marks claimed jobs complete or failed with lock token guard", async () => {
    const pool = createPool();
    pool.query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });
    const repo = createLocalWorkQueueRepository(pool as never);

    await expect(repo.complete({ id: 1, lockToken: "lock-1" })).resolves.toBe(
      true
    );
    await expect(
      repo.fail({
        id: 2,
        lockToken: "lock-2",
        errorMessage: "boom",
        retry: true
      })
    ).resolves.toBe(true);

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("set status = 'completed'"),
      [1, "lock-1"]
    );
    expect(String(pool.query.mock.calls[0]?.[0] ?? "")).toContain(
      "last_error = null"
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("set status = case when $3::boolean"),
      [2, "lock-2", true, "boom"]
    );
  });

  it("counts delayed pending jobs separately", async () => {
    const pool = createPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { status: "pending", count: "2" },
        { status: "delayed", count: "1" }
      ]
    });
    const repo = createLocalWorkQueueRepository(pool as never);

    await expect(repo.getJobCounts(["pending", "delayed"])).resolves.toEqual({
      pending: 2,
      delayed: 1
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("available_at > now()"),
      [["pending", "delayed"]]
    );
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("local work queue priority integration", () => {
  beforeAll(async () => {
    const pool = createDbPool();
    try {
      await runDbMigrations(pool);
    } finally {
      await pool.end();
    }
  });

  it("claims newly arrived live work before sustained queued historical work", async () => {
    const pool = createDbPool();
    const repository = createLocalWorkQueueRepository(pool);
    const queueName = `priority-${randomUUID()}`;
    try {
      for (let index = 0; index < 10; index += 1) {
        await repository.enqueue({
          queueName,
          jobName: `historical-${index}`,
          data: {},
          priority: 20
        });
      }
      const activeHistorical = await repository.claim({
        queueName,
        leaseMs: 60_000
      });
      await repository.enqueue({
        queueName,
        jobName: "live",
        data: {},
        priority: 5
      });

      const next = await repository.claim({ queueName, leaseMs: 60_000 });
      const later = await repository.claim({ queueName, leaseMs: 60_000 });

      expect(activeHistorical?.jobName).toBe("historical-0");
      expect(next?.jobName).toBe("live");
      expect(later?.jobName).toBe("historical-1");
    } finally {
      await pool.query("delete from local_work_queue where queue_name = $1", [
        queueName
      ]);
      await pool.end();
    }
  });

  it("excludes concurrent local queue runtimes and requeues interrupted work immediately", async () => {
    const firstPool = createDbPool();
    const secondPool = createDbPool();
    const firstRepository = createLocalWorkQueueRepository(firstPool);
    const secondRepository = createLocalWorkQueueRepository(secondPool);
    const queueName = `restart-${randomUUID()}`;
    let firstLease: Awaited<
      ReturnType<typeof firstRepository.tryAcquireRuntimeLease>
    > | null = null;
    let replacementLease: Awaited<
      ReturnType<typeof secondRepository.tryAcquireRuntimeLease>
    > | null = null;
    try {
      await firstRepository.enqueue({
        queueName,
        jobName: "interrupted",
        data: {},
        maxAttempts: 1
      });
      const interrupted = await firstRepository.claim({
        queueName,
        leaseMs: 600_000
      });
      expect(interrupted?.attemptCount).toBe(1);

      firstLease = await firstRepository.tryAcquireRuntimeLease();
      expect(firstLease).not.toBeNull();
      await expect(
        secondRepository.tryAcquireRuntimeLease()
      ).resolves.toBeNull();

      await firstLease?.release();
      firstLease = null;
      replacementLease = await secondRepository.tryAcquireRuntimeLease();
      expect(replacementLease).not.toBeNull();
      await expect(replacementLease?.requeueAbandonedJobs()).resolves.toBe(1);

      const retried = await secondRepository.claim({
        queueName,
        leaseMs: 600_000
      });
      expect(retried?.jobName).toBe("interrupted");
      expect(retried?.attemptCount).toBe(1);
    } finally {
      await firstLease?.release();
      await replacementLease?.release();
      await firstPool.query(
        "delete from local_work_queue where queue_name = $1",
        [queueName]
      );
      await firstPool.end();
      await secondPool.end();
    }
  });
});
