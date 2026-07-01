import { describe, expect, it, vi } from "vitest";
import { createLocalWorkQueueRepository } from "../src/index.js";

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
        5,
        10_000,
        "500 milliseconds"
      ]
    );
  });

  it("claims pending jobs with a lease token", async () => {
    const pool = createPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "7",
          queue_name: "lcm-compact",
          job_name: "compact-scope",
          data: { userId: "user-1" },
          attempt_count: 1,
          max_attempts: 5,
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
      jobName: "compact-scope",
      data: { userId: "user-1" },
      attemptCount: 1,
      maxAttempts: 5,
      lockToken: "lock-1"
    });

    const sql = String(pool.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("expired_failed");
    expect(sql).toContain("attempt_count >= max_attempts");
    expect(sql).toContain("attempt_count < max_attempts");
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
