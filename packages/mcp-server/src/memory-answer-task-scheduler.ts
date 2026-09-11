import { randomBytes } from "node:crypto";
import {
  memoryAnswerTaskIsTerminal,
  type ClaimedMemoryAnswerTask as SharedClaimedMemoryAnswerTask,
  type MemoryAnswerTask,
  type MemoryAnswerTaskStatus
} from "@koed/shared";
import { z } from "zod";
import { AnswerExecutionCapacity } from "./answer-admission.js";
import type { MemoryApiClient } from "./index.js";
import type { LocalRuntimeCallerContext } from "./local-runtime-protocol.js";
import { logger } from "./logger.js";

export type MemoryAnswerTaskView = MemoryAnswerTask;
export type MemoryAnswerTaskApi = Pick<
  MemoryApiClient,
  | "acceptMemoryAnswerTask"
  | "cancelMemoryAnswerTask"
  | "claimMemoryAnswerTask"
  | "completeMemoryAnswerTask"
  | "deleteExpiredMemoryAnswerTasks"
  | "failMemoryAnswerTask"
  | "getMemoryAnswerTask"
  | "heartbeatMemoryAnswerTask"
>;

interface ClaimedMemoryAnswerTask extends SharedClaimedMemoryAnswerTask {
  request: {
    input: Record<string, unknown>;
    caller: LocalRuntimeCallerContext;
  };
}

export interface MemoryAnswerTaskExecutor {
  executeMemoryAnswerTask(
    input: Record<string, unknown>,
    caller: LocalRuntimeCallerContext,
    taskId: string,
    signal?: AbortSignal,
    onProgress?: (status: string) => void
  ): Promise<{ questionId: string; result: Record<string, unknown> }>;
}

export interface MemoryAnswerTaskSchedulerOptions {
  maxActive?: number;
  maxQueued?: number;
  executionCapacity?: AnswerExecutionCapacity;
  leaseMs?: number;
  heartbeatMs?: number;
  reconcileMs?: number;
  noProgressTimeoutMs?: number;
  hardTimeoutMs?: number;
}

const TERMINAL = new Set<MemoryAnswerTaskStatus>([
  "completed",
  "failed",
  "cancelled"
]);

const claimedRequestSchema = z
  .object({
    input: z.record(z.string(), z.unknown()),
    caller: z
      .object({
        cwd: z.string(),
        protocolVersion: z.string().optional(),
        clientInfo: z.record(z.string(), z.unknown()).optional(),
        clientCapabilities: z.record(z.string(), z.unknown()).optional()
      })
      .strict()
  })
  .strict();

const claimedTask = (
  task: SharedClaimedMemoryAnswerTask
): ClaimedMemoryAnswerTask => ({
  ...task,
  request: claimedRequestSchema.parse(task.request)
});

const positive = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;

type AttemptEndReason =
  | "cancelled"
  | "execution_failed"
  | "hard_timeout"
  | "lease_lost"
  | "no_progress_timeout"
  | "shutdown";

class MemoryAnswerAttemptControl {
  readonly controller = new AbortController();
  endReason: AttemptEndReason | null = null;
  lastProgressAt = Date.now();
  progressPending = true;
  statusMessage = "starting";

  progress(status: string): void {
    if (this.controller.signal.aborted) return;
    this.lastProgressAt = Date.now();
    this.progressPending = true;
    this.statusMessage = status;
  }

  consumeProgress(): boolean {
    const pending = this.progressPending;
    this.progressPending = false;
    return pending;
  }

  stop(reason: AttemptEndReason, error: unknown): boolean {
    if (this.endReason) return false;
    this.endReason = reason;
    this.controller.abort(
      error instanceof Error ? error : new Error(String(error))
    );
    return true;
  }
}

export class MemoryAnswerTaskScheduler {
  private readonly leaseOwner = `local-runtime-${randomBytes(24).toString("base64url")}`;
  private readonly listeners = new Map<
    string,
    Set<(task: MemoryAnswerTaskView) => void>
  >();
  private readonly running = new Map<
    string,
    { attempt: MemoryAnswerAttemptControl; promise: Promise<void> }
  >();
  private readonly maxQueued: number;
  private readonly executionCapacity: AnswerExecutionCapacity;
  private readonly removeCapacityListener: () => void;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly noProgressTimeoutMs: number;
  private readonly hardTimeoutMs: number;
  private readonly reconcileTimer: NodeJS.Timeout;
  private readonly cleanupTimer: NodeJS.Timeout;
  private draining = false;
  private closed = false;

  constructor(
    private readonly apiClient: MemoryAnswerTaskApi,
    private readonly executor: MemoryAnswerTaskExecutor,
    options: MemoryAnswerTaskSchedulerOptions = {}
  ) {
    this.executionCapacity =
      options.executionCapacity ??
      new AnswerExecutionCapacity(positive(options.maxActive, 2));
    this.removeCapacityListener = this.executionCapacity.onAvailable(() =>
      this.nudge()
    );
    this.maxQueued = positive(options.maxQueued, 16);
    this.leaseMs = positive(options.leaseMs, 60_000);
    this.heartbeatMs = Math.min(
      positive(options.heartbeatMs, 15_000),
      Math.max(1_000, Math.floor(this.leaseMs / 2))
    );
    this.noProgressTimeoutMs = positive(
      options.noProgressTimeoutMs,
      5 * 60_000
    );
    this.hardTimeoutMs = positive(options.hardTimeoutMs, 30 * 60_000);
    this.reconcileTimer = setInterval(
      () => this.nudge(),
      positive(options.reconcileMs, 2_000)
    );
    this.reconcileTimer.unref?.();
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60 * 60_000);
    this.cleanupTimer.unref?.();
    this.cleanupExpired();
    this.nudge();
  }

  async start(input: {
    origin: "mcp" | "pi_extension";
    invocationKey?: string;
    toolInput: Record<string, unknown>;
    caller: LocalRuntimeCallerContext;
  }): Promise<MemoryAnswerTaskView> {
    const { task } = await this.apiClient.acceptMemoryAnswerTask({
      origin: input.origin,
      invocation_key: input.invocationKey,
      request: { input: input.toolInput, caller: input.caller },
      max_queued: this.maxQueued
    });
    this.publish(task);
    logger.info(
      { taskId: task.id, origin: task.origin, status: task.status },
      "memory answer task accepted"
    );
    this.nudge();
    return task;
  }

  async get(taskId: string): Promise<MemoryAnswerTaskView> {
    return (await this.apiClient.getMemoryAnswerTask(taskId)).task;
  }

  async cancel(taskId: string): Promise<MemoryAnswerTaskView> {
    const { task } = await this.apiClient.cancelMemoryAnswerTask(taskId);
    this.publish(task);
    logger.info(
      { taskId: task.id, status: task.status },
      "memory answer task cancellation requested"
    );
    if (task.status === "cancel_requested") {
      this.running
        .get(task.id)
        ?.attempt.stop(
          "cancelled",
          new Error("Memory Answer task was cancelled")
        );
    }
    return task;
  }

  subscribe(
    taskId: string,
    listener: (task: MemoryAnswerTaskView) => void
  ): () => void {
    const listeners = this.listeners.get(taskId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(taskId);
    };
  }

  async waitForTerminal(
    taskId: string,
    signal?: AbortSignal
  ): Promise<MemoryAnswerTaskView> {
    const current = await this.get(taskId);
    if (TERMINAL.has(current.status)) return current;
    return await new Promise<MemoryAnswerTaskView>((resolve, reject) => {
      let settled = false;
      const finish = (task: MemoryAnswerTaskView) => {
        if (settled || !TERMINAL.has(task.status)) return;
        settled = true;
        cleanup();
        resolve(task);
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error("Koed Memory Answer waiter detached", {
            cause: signal?.reason
          })
        );
      };
      const unsubscribe = this.subscribe(taskId, finish);
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      void this.get(taskId).then(finish, (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  nudge(): void {
    if (this.closed || this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      void this.drain()
        .catch((error) => {
          logger.warn(
            { err: error },
            "memory answer task reconciliation failed"
          );
        })
        .finally(() => {
          this.draining = false;
        });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.reconcileTimer);
    clearInterval(this.cleanupTimer);
    this.removeCapacityListener();
    for (const { attempt } of this.running.values()) {
      attempt.stop("shutdown", new Error("Local AI Runtime is shutting down"));
    }
    await Promise.allSettled(
      [...this.running.values()].map(({ promise }) => promise)
    );
    this.listeners.clear();
  }

  get diagnostics() {
    return { active: this.running.size };
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      const release = this.executionCapacity.tryAcquire();
      if (!release) return;
      let batch: Awaited<
        ReturnType<MemoryAnswerTaskApi["claimMemoryAnswerTask"]>
      >;
      try {
        batch = await this.apiClient.claimMemoryAnswerTask({
          lease_owner: this.leaseOwner,
          lease_ms: this.leaseMs
        });
      } catch (error) {
        release();
        throw error;
      }
      for (const reconciled of batch.reconciled) this.publish(reconciled);
      const claim = batch.task ? claimedTask(batch.task) : null;
      if (!claim) {
        release();
        return;
      }
      this.publish(claim);
      logger.info(
        {
          taskId: claim.id,
          attemptCount: claim.attemptCount,
          fenceGeneration: claim.fenceGeneration
        },
        "memory answer task claimed"
      );
      const attempt = new MemoryAnswerAttemptControl();
      const promise = this.executeClaim(claim, attempt).finally(() => {
        this.running.delete(claim.id);
        release();
        this.nudge();
      });
      this.running.set(claim.id, { attempt, promise });
    }
  }

  private async executeClaim(
    task: ClaimedMemoryAnswerTask,
    attempt: MemoryAnswerAttemptControl
  ): Promise<void> {
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatInFlight: Promise<void> | null = null;
    let finishing = false;
    const scheduleHeartbeat = () => {
      if (finishing || attempt.controller.signal.aborted) return;
      heartbeatTimer = setTimeout(() => {
        heartbeatInFlight = heartbeatOnce().finally(() => {
          heartbeatInFlight = null;
          scheduleHeartbeat();
        });
      }, this.heartbeatMs);
      heartbeatTimer.unref?.();
    };
    const heartbeatOnce = async (): Promise<void> => {
      if (Date.now() - attempt.lastProgressAt >= this.noProgressTimeoutMs) {
        attempt.stop(
          "no_progress_timeout",
          new Error("Memory Answer no-progress watchdog expired")
        );
        return;
      }
      try {
        const { task: current } =
          await this.apiClient.heartbeatMemoryAnswerTask(task.id, {
            lease_owner: task.leaseOwner,
            fence_generation: task.fenceGeneration,
            lease_ms: this.leaseMs,
            made_progress: attempt.consumeProgress(),
            status_message: attempt.statusMessage
          });
        this.publish(current);
        if (current.status === "cancel_requested") {
          attempt.stop(
            "cancelled",
            new Error("Memory Answer task was cancelled")
          );
        }
      } catch (error) {
        attempt.stop("lease_lost", error);
      }
    };
    scheduleHeartbeat();
    const hardTimeout = setTimeout(() => {
      attempt.stop(
        "hard_timeout",
        new Error("Memory Answer hard execution ceiling reached")
      );
    }, this.hardTimeoutMs);
    hardTimeout.unref?.();

    try {
      const completed = await this.executor.executeMemoryAnswerTask(
        task.request.input,
        task.request.caller,
        task.id,
        attempt.controller.signal,
        (status) => attempt.progress(status)
      );
      finishing = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      await Promise.resolve(heartbeatInFlight);
      if (attempt.controller.signal.aborted) {
        throw attempt.controller.signal.reason;
      }
      const { task: terminal } = await this.apiClient.completeMemoryAnswerTask(
        task.id,
        {
          lease_owner: task.leaseOwner,
          fence_generation: task.fenceGeneration,
          question_id: completed.questionId,
          result: completed.result
        }
      );
      this.publish(terminal);
      logger.info(
        {
          taskId: terminal.id,
          status: terminal.status,
          attemptCount: terminal.attemptCount,
          fenceGeneration: terminal.fenceGeneration
        },
        "memory answer task completed"
      );
    } catch (error) {
      const classified =
        error && typeof error === "object"
          ? (error as {
              memoryAnswerTaskErrorCode?: unknown;
              retryable?: unknown;
            })
          : {};
      const reason =
        attempt.endReason ??
        (typeof classified.memoryAnswerTaskErrorCode === "string"
          ? classified.memoryAnswerTaskErrorCode
          : "execution_failed");
      if (reason === "lease_lost") {
        logger.warn(
          {
            err: error,
            taskId: task.id,
            fenceGeneration: task.fenceGeneration
          },
          "memory answer task lease was lost"
        );
        return;
      }
      const retry =
        classified.retryable !== false &&
        reason !== "cancelled" &&
        reason !== "hard_timeout";
      try {
        const { task: terminal } = await this.apiClient.failMemoryAnswerTask(
          task.id,
          {
            lease_owner: task.leaseOwner,
            fence_generation: task.fenceGeneration,
            error_code: reason,
            error_message:
              error instanceof Error ? error.message : String(error),
            retry,
            retry_delay_ms: retry
              ? Math.min(1_000 * 2 ** task.attemptCount, 30_000)
              : 0
          }
        );
        this.publish(terminal);
        logger.info(
          {
            taskId: terminal.id,
            status: terminal.status,
            errorCode: terminal.lastErrorCode,
            attemptCount: terminal.attemptCount,
            fenceGeneration: terminal.fenceGeneration
          },
          "memory answer task attempt ended"
        );
      } catch (commitError) {
        logger.warn(
          {
            err: commitError,
            taskId: task.id,
            fenceGeneration: task.fenceGeneration
          },
          "memory answer task terminal transition was rejected"
        );
      }
    } finally {
      finishing = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      clearTimeout(hardTimeout);
    }
  }

  private publish(task: MemoryAnswerTaskView): void {
    for (const listener of this.listeners.get(task.id) ?? []) {
      listener(task);
    }
  }

  private cleanupExpired(): void {
    void Promise.resolve()
      .then(() => this.apiClient.deleteExpiredMemoryAnswerTasks())
      .catch((error) => {
        logger.warn(
          { err: error },
          "expired memory answer task cleanup failed"
        );
      });
  }
}

export { memoryAnswerTaskIsTerminal };
