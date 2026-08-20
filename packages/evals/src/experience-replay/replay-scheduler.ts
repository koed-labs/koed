import {
  CostAdmissionController,
  type CostAdmissionSnapshot
} from "./cost-admission.js";

export interface ReplaySchedulerExecution<T> {
  value: T;
  /** Final total for this job, including costs already reported with observeCost. */
  observedCostUsd: number;
}

export interface ReplaySchedulerContext {
  signal: AbortSignal;
  /** Report provider cost while a job is running so the paid stop closes immediately. */
  observeCost(incrementalCostUsd: number): void;
}

export interface ReplaySchedulerJob<T> {
  id: string;
  /** Jobs sharing this key never run concurrently. */
  exclusiveKey?: string;
  maximumCostUsd: number;
  run(context: ReplaySchedulerContext): Promise<ReplaySchedulerExecution<T>>;
}

export type ReplaySchedulerStopReason =
  | "paid_cost_stop"
  | "provider_cap"
  | "cancelled"
  | null;

export type ReplaySchedulerJobResult<T> =
  | {
      id: string;
      index: number;
      status: "completed";
      admitted: true;
      observedCostUsd: number;
      value: T;
    }
  | {
      id: string;
      index: number;
      status: "failed" | "cancelled";
      admitted: true;
      observedCostUsd: number;
      error: unknown;
    }
  | {
      id: string;
      index: number;
      status: "not_started";
      admitted: false;
      observedCostUsd: 0;
      reason: Exclude<ReplaySchedulerStopReason, null>;
    };

export interface ReplaySchedulerSnapshot {
  mode: "paid" | "subscription" | "smoke";
  totalJobs: number;
  admittedJobs: number;
  completedJobs: number;
  failedJobs: number;
  cancelledJobs: number;
  notStartedJobs: number;
  activeJobs: number;
  stopReason: ReplaySchedulerStopReason;
  costAdmission: CostAdmissionSnapshot | null;
}

export interface ReplaySchedulerResult<T> {
  results: readonly ReplaySchedulerJobResult<T>[];
  snapshot: ReplaySchedulerSnapshot;
}

interface ReplaySchedulerBaseOptions<T> {
  jobs: readonly ReplaySchedulerJob<T>[];
  concurrency: number;
  signal?: AbortSignal;
}

export type ReplaySchedulerOptions<T> = ReplaySchedulerBaseOptions<T> &
  (
    | {
        mode: "paid";
        paidCostStopUsd: number;
        providerSpendingLimitUsd: number;
        costAdmission?: CostAdmissionController;
      }
    | { mode: "subscription" | "smoke" }
  );

const assertConcurrency = (concurrency: number): void => {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Scheduler concurrency must be a positive integer");
  }
};

const validateJobs = <T>(jobs: readonly ReplaySchedulerJob<T>[]): void => {
  const identities = new Set<string>();
  for (const job of jobs) {
    if (!job.id || job.id.trim() !== job.id || identities.has(job.id)) {
      throw new Error("Job identity must be unique, exact and non-empty");
    }
    if (!Number.isFinite(job.maximumCostUsd) || job.maximumCostUsd <= 0) {
      throw new Error("Maximum job cost must be a finite positive number");
    }
    if (
      job.exclusiveKey !== undefined &&
      (!job.exclusiveKey || job.exclusiveKey.trim() !== job.exclusiveKey)
    ) {
      throw new Error("Exclusive key must be exact and non-empty");
    }
    identities.add(job.id);
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isProviderAdmissionError = (error: unknown): boolean =>
  errorMessage(error).includes("Provider spending limit");

/**
 * Run replay jobs with bounded concurrency and deterministic, input-aligned output.
 * Paid mode reserves every job's maximum cost before invoking it. Subscription
 * mode records API-equivalent job cost without treating it as provider spend.
 * Smoke mode uses the same concurrency and cancellation semantics without a gate.
 */
export const scheduleReplayJobs = async <T>(
  options: ReplaySchedulerOptions<T>
): Promise<ReplaySchedulerResult<T>> => {
  assertConcurrency(options.concurrency);
  validateJobs(options.jobs);

  const gate =
    options.mode === "paid"
      ? (options.costAdmission ??
        new CostAdmissionController(
          options.paidCostStopUsd,
          options.providerSpendingLimitUsd,
          options.concurrency
        ))
      : null;
  const results = new Array<ReplaySchedulerJobResult<T>>(options.jobs.length);
  const pendingIndexes = options.jobs.map((_job, index) => index);
  const activeExclusiveKeys = new Set<string>();
  let activeJobs = 0;
  let admittedJobs = 0;
  let stopReason: ReplaySchedulerStopReason = options.signal?.aborted
    ? "cancelled"
    : null;

  const markRemaining = (
    reason: Exclude<ReplaySchedulerStopReason, null>
  ): void => {
    while (pendingIndexes.length > 0) {
      const index = pendingIndexes.shift()!;
      results[index] = {
        id: options.jobs[index]!.id,
        index,
        status: "not_started",
        admitted: false,
        observedCostUsd: 0,
        reason
      };
    }
  };

  await new Promise<void>((resolve) => {
    let settled = false;
    const finishIfDone = (): void => {
      if (!settled && activeJobs === 0 && pendingIndexes.length === 0) {
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      }
    };
    const stop = (reason: Exclude<ReplaySchedulerStopReason, null>): void => {
      if (stopReason === null) stopReason = reason;
      markRemaining(stopReason ?? reason);
      finishIfDone();
    };
    const onAbort = (): void => stop("cancelled");

    const runJob = (job: ReplaySchedulerJob<T>, index: number): void => {
      activeJobs += 1;
      admittedJobs += 1;
      if (job.exclusiveKey) activeExclusiveKeys.add(job.exclusiveKey);
      let incrementallyObservedCostUsd = 0;
      let reservationSettled = false;
      let finalObservedCostUsd = 0;
      const observeCost = (incrementalCostUsd: number): void => {
        if (!Number.isFinite(incrementalCostUsd) || incrementalCostUsd < 0) {
          throw new Error(
            "Observed incremental cost must be a finite non-negative number"
          );
        }
        // The controller accounts before throwing on a limit violation, so retain
        // the same total for final settlement even in that failure path.
        incrementallyObservedCostUsd += incrementalCostUsd;
        if (gate) gate.observe(job.id, incrementalCostUsd);
      };

      void job
        .run({
          signal: options.signal ?? new AbortController().signal,
          observeCost
        })
        .then((execution) => {
          if (
            !Number.isFinite(execution.observedCostUsd) ||
            execution.observedCostUsd < incrementallyObservedCostUsd
          ) {
            throw new Error(
              "Observed job cost must be finite and not below incrementally observed cost"
            );
          }
          finalObservedCostUsd = execution.observedCostUsd;
          if (gate) {
            // Once a valid final total reaches settle(), the controller removes the
            // reservation even when it then reports a maximum/cap violation.
            reservationSettled = true;
            gate.settle(job.id, execution.observedCostUsd);
          }
          results[index] = {
            id: job.id,
            index,
            status: "completed",
            admitted: true,
            observedCostUsd: execution.observedCostUsd,
            value: execution.value
          };
        })
        .catch((error: unknown) => {
          let accountingError: unknown;
          finalObservedCostUsd = Math.max(
            finalObservedCostUsd,
            incrementallyObservedCostUsd
          );
          if (gate && !reservationSettled) {
            try {
              gate.settle(job.id, incrementallyObservedCostUsd);
            } catch (settleError) {
              accountingError = settleError;
            }
          }
          const cancelled = options.signal?.aborted === true;
          results[index] = {
            id: job.id,
            index,
            status: cancelled ? "cancelled" : "failed",
            admitted: true,
            observedCostUsd: finalObservedCostUsd,
            error: accountingError
              ? new AggregateError(
                  [error, accountingError],
                  "Job and cost settlement failed"
                )
              : error
          };
        })
        .finally(() => {
          activeJobs -= 1;
          if (job.exclusiveKey) activeExclusiveKeys.delete(job.exclusiveKey);
          if (stopReason === null && gate?.snapshot().stopped) {
            stop("paid_cost_stop");
          } else {
            pump();
          }
          finishIfDone();
        });
    };

    function pump(): void {
      if (stopReason !== null) {
        markRemaining(stopReason);
        finishIfDone();
        return;
      }
      while (
        activeJobs < options.concurrency &&
        pendingIndexes.length > 0 &&
        stopReason === null
      ) {
        const pendingPosition = pendingIndexes.findIndex((index) => {
          const key = options.jobs[index]!.exclusiveKey;
          return key === undefined || !activeExclusiveKeys.has(key);
        });
        if (pendingPosition === -1) return;
        const index = pendingIndexes[pendingPosition]!;
        const job = options.jobs[index]!;
        if (gate) {
          try {
            gate.admit(job.id, job.maximumCostUsd);
          } catch (error) {
            if (isProviderAdmissionError(error) && activeJobs > 0) {
              // Existing reservations may shrink when their attempts settle.
              // Keep this job queued and retry from the completion callback.
              return;
            }
            stop(
              isProviderAdmissionError(error)
                ? "provider_cap"
                : "paid_cost_stop"
            );
            return;
          }
        }
        pendingIndexes.splice(pendingPosition, 1);
        runJob(job, index);
      }
      finishIfDone();
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Close the race between the initial check and listener registration.
    if (options.signal?.aborted) onAbort();
    pump();
  });

  const completedJobs = results.filter(
    (result) => result.status === "completed"
  ).length;
  const failedJobs = results.filter(
    (result) => result.status === "failed"
  ).length;
  const cancelledJobs = results.filter(
    (result) => result.status === "cancelled"
  ).length;
  const notStartedJobs = results.filter(
    (result) => result.status === "not_started"
  ).length;
  return {
    results: Object.freeze(results.map((result) => Object.freeze(result))),
    snapshot: {
      mode: options.mode,
      totalJobs: options.jobs.length,
      admittedJobs,
      completedJobs,
      failedJobs,
      cancelledJobs,
      notStartedJobs,
      activeJobs,
      stopReason,
      costAdmission: gate?.snapshot() ?? null
    }
  };
};
