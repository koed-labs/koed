import { describe, expect, it } from "vitest";
import {
  scheduleReplayJobs,
  type ReplaySchedulerJob
} from "./replay-scheduler.js";
import { CostAdmissionController } from "./cost-admission.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("experience replay scheduler", () => {
  it("bounds concurrency and returns input order, not completion order", async () => {
    const pending = [
      deferred<number>(),
      deferred<number>(),
      deferred<number>()
    ];
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const jobs = pending.map(
      (item, index): ReplaySchedulerJob<number> => ({
        id: `job-${index}`,
        maximumCostUsd: 2,
        run: async () => {
          starts.push(`job-${index}`);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          const value = await item.promise;
          active -= 1;
          return { value, observedCostUsd: 1 };
        }
      })
    );
    const scheduled = scheduleReplayJobs({
      mode: "paid",
      concurrency: 2,
      paidCostStopUsd: 10,
      providerSpendingLimitUsd: 10,
      jobs
    });

    await flush();
    expect(starts).toEqual(["job-0", "job-1"]);
    pending[1]!.resolve(20);
    await flush();
    expect(starts).toEqual(["job-0", "job-1", "job-2"]);
    pending[2]!.resolve(30);
    pending[0]!.resolve(10);

    const result = await scheduled;
    expect(maximumActive).toBe(2);
    expect(result.results.map((item) => item.id)).toEqual([
      "job-0",
      "job-1",
      "job-2"
    ]);
    expect(result.results.map((item) => item.status)).toEqual([
      "completed",
      "completed",
      "completed"
    ]);
    expect(result.snapshot).toMatchObject({
      admittedJobs: 3,
      completedJobs: 3,
      activeJobs: 0,
      stopReason: null,
      costAdmission: { observedCostUsd: 3, activeAttempts: 0 }
    });
  });

  it("runs different tasks concurrently but serializes jobs for one task", async () => {
    const firstA = deferred<number>();
    const secondA = deferred<number>();
    const firstB = deferred<number>();
    const starts: string[] = [];
    const jobs: ReplaySchedulerJob<number>[] = [
      { id: "a-1", exclusiveKey: "task-a", gate: firstA },
      { id: "a-2", exclusiveKey: "task-a", gate: secondA },
      { id: "b-1", exclusiveKey: "task-b", gate: firstB }
    ].map(({ id, exclusiveKey, gate }) => ({
      id,
      exclusiveKey,
      maximumCostUsd: 1,
      run: async () => {
        starts.push(id);
        return { value: await gate.promise, observedCostUsd: 0 };
      }
    }));

    const scheduled = scheduleReplayJobs({
      mode: "smoke",
      concurrency: 2,
      jobs
    });
    await flush();
    expect(starts).toEqual(["a-1", "b-1"]);

    firstB.resolve(3);
    await flush();
    expect(starts).toEqual(["a-1", "b-1"]);
    firstA.resolve(1);
    await flush();
    expect(starts).toEqual(["a-1", "b-1", "a-2"]);
    secondA.resolve(2);

    const result = await scheduled;
    expect(result.results.map((item) => item.status)).toEqual([
      "completed",
      "completed",
      "completed"
    ]);
  });

  it("records subscription cost without enforcing API-equivalent limits", async () => {
    const result = await scheduleReplayJobs({
      mode: "subscription",
      concurrency: 1,
      jobs: [
        {
          id: "subscription-job",
          maximumCostUsd: 0.01,
          run: async () => ({ value: 1, observedCostUsd: 25 })
        }
      ]
    });

    expect(result.results[0]).toMatchObject({
      status: "completed",
      observedCostUsd: 25,
      value: 1
    });
    expect(result.snapshot).toMatchObject({
      mode: "subscription",
      completedJobs: 1,
      stopReason: null,
      costAdmission: null
    });
  });

  it("finishes exactly the admitted cohort and starts nothing after paid-stop crossing", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const third = deferred<number>();
    const fourth = deferred<number>();
    const starts: string[] = [];
    const jobs = [first, second, third, fourth].map(
      (item, index): ReplaySchedulerJob<number> => ({
        id: `paid-${index}`,
        maximumCostUsd: 4,
        run: async () => {
          starts.push(`paid-${index}`);
          const cost = await item.promise;
          return { value: index, observedCostUsd: cost };
        }
      })
    );
    const scheduled = scheduleReplayJobs({
      mode: "paid",
      concurrency: 2,
      paidCostStopUsd: 5,
      providerSpendingLimitUsd: 11,
      jobs
    });
    await flush();
    first.resolve(3);
    await flush();
    expect(starts).toEqual(["paid-0", "paid-1", "paid-2"]);
    second.resolve(2);
    await flush();
    expect(starts).toEqual(["paid-0", "paid-1", "paid-2"]);
    // paid-2 was admitted before paid-1 crossed the stop and may finish.
    third.resolve(3);
    const result = await scheduled;
    expect(result.results.map((item) => item.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "not_started"
    ]);
    expect(result.snapshot).toMatchObject({
      stopReason: "paid_cost_stop",
      admittedJobs: 3,
      completedJobs: 3,
      notStartedJobs: 1,
      costAdmission: {
        observedCostUsd: 8,
        activeAttempts: 0,
        crossing: {
          triggeringAttemptId: "paid-1",
          inFlightAttempts: [
            { attemptId: "paid-1", observedCostUsd: 2 },
            { attemptId: "paid-2", observedCostUsd: 3 }
          ]
        }
      }
    });
  });

  it("waits for temporary reservations before deciding provider capacity", async () => {
    const starts: string[] = [];
    const jobs = [4, 4, 1].map((maximumCostUsd, index) => ({
      id: `cap-${index}`,
      maximumCostUsd,
      run: async () => {
        starts.push(`cap-${index}`);
        return { value: index, observedCostUsd: 1 };
      }
    }));
    const result = await scheduleReplayJobs({
      mode: "paid",
      concurrency: 2,
      paidCostStopUsd: 6,
      providerSpendingLimitUsd: 7,
      jobs
    });
    expect(starts).toEqual(["cap-0", "cap-1", "cap-2"]);
    expect(result.results.map((item) => item.status)).toEqual([
      "completed",
      "completed",
      "completed"
    ]);
    expect(result.snapshot.stopReason).toBeNull();
  });

  it("stops when an idle provider account cannot cover the next job", async () => {
    const starts: string[] = [];
    const result = await scheduleReplayJobs({
      mode: "paid",
      concurrency: 2,
      paidCostStopUsd: 6,
      providerSpendingLimitUsd: 7,
      jobs: [
        {
          id: "uncovered",
          maximumCostUsd: 8,
          run: async () => {
            starts.push("uncovered");
            return { value: 1, observedCostUsd: 1 };
          }
        }
      ]
    });
    expect(starts).toEqual([]);
    expect(result.results[0]).toMatchObject({
      status: "not_started",
      reason: "provider_cap"
    });
  });

  it("smoke mode bypasses paid admission while retaining bounded scheduling", async () => {
    const jobs = [0, 1, 2].map((index) => ({
      id: `smoke-${index}`,
      maximumCostUsd: 100,
      run: async () => ({ value: index, observedCostUsd: 100 })
    }));
    const result = await scheduleReplayJobs({
      mode: "smoke",
      concurrency: 2,
      jobs
    });
    expect(result.results.map((item) => item.status)).toEqual([
      "completed",
      "completed",
      "completed"
    ]);
    expect(result.snapshot).toMatchObject({
      mode: "smoke",
      costAdmission: null
    });
  });

  it("can preserve one paid admission ledger across execution phases", async () => {
    const gate = new CostAdmissionController(10, 12, 1);
    const first = await scheduleReplayJobs({
      mode: "paid",
      concurrency: 1,
      paidCostStopUsd: 10,
      providerSpendingLimitUsd: 12,
      costAdmission: gate,
      jobs: [
        {
          id: "source",
          maximumCostUsd: 4,
          run: async () => ({ value: "source", observedCostUsd: 3 })
        }
      ]
    });
    const second = await scheduleReplayJobs({
      mode: "paid",
      concurrency: 1,
      paidCostStopUsd: 10,
      providerSpendingLimitUsd: 12,
      costAdmission: gate,
      jobs: [
        {
          id: "replay",
          maximumCostUsd: 4,
          run: async () => ({ value: "replay", observedCostUsd: 2 })
        }
      ]
    });
    expect(first.snapshot.costAdmission?.observedCostUsd).toBe(3);
    expect(second.snapshot.costAdmission?.observedCostUsd).toBe(5);
  });

  it("cancels queued jobs, signals the admitted cohort, and waits for it to settle", async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const jobs = [0, 1, 2].map((index) => ({
      id: `abort-${index}`,
      maximumCostUsd: 1,
      run: ({ signal }: { signal: AbortSignal }) => {
        signals.push(signal);
        return new Promise<{ value: number; observedCostUsd: number }>(
          (_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            )
        );
      }
    }));
    const scheduled = scheduleReplayJobs({
      mode: "paid",
      concurrency: 2,
      paidCostStopUsd: 5,
      providerSpendingLimitUsd: 5,
      jobs,
      signal: controller.signal
    });
    await flush();
    controller.abort();
    const result = await scheduled;
    expect(signals).toEqual([controller.signal, controller.signal]);
    expect(result.results.map((item) => item.status)).toEqual([
      "cancelled",
      "cancelled",
      "not_started"
    ]);
    expect(result.snapshot).toMatchObject({
      stopReason: "cancelled",
      admittedJobs: 2,
      cancelledJobs: 2,
      notStartedJobs: 1,
      activeJobs: 0
    });
  });

  it("reports incremental cost immediately and settles it when a runner fails", async () => {
    const jobs: ReplaySchedulerJob<number>[] = [
      {
        id: "observed-failure",
        maximumCostUsd: 3,
        run: async ({ observeCost }) => {
          observeCost(2);
          throw new Error("runner failed");
        }
      },
      {
        id: "never-started",
        maximumCostUsd: 1,
        run: async () => ({ value: 2, observedCostUsd: 0 })
      }
    ];
    const result = await scheduleReplayJobs({
      mode: "paid",
      concurrency: 1,
      paidCostStopUsd: 2,
      providerSpendingLimitUsd: 3,
      jobs
    });
    expect(result.results.map((item) => item.status)).toEqual([
      "failed",
      "not_started"
    ]);
    expect(result.snapshot).toMatchObject({
      stopReason: "paid_cost_stop",
      costAdmission: { observedCostUsd: 2, activeAttempts: 0, stopped: true }
    });
  });

  it("rejects duplicate identities before starting any work", async () => {
    const jobs = [0, 1].map(() => ({
      id: "duplicate",
      maximumCostUsd: 1,
      run: async () => ({ value: 1, observedCostUsd: 0 })
    }));
    await expect(
      scheduleReplayJobs({ mode: "smoke", concurrency: 1, jobs })
    ).rejects.toThrow("unique");
  });
});
