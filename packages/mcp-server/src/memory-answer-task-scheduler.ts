import { randomBytes } from "node:crypto";
import type { MemoryApiClient } from "./index.js";
import type { LocalRuntimeCallerContext } from "./local-runtime-protocol.js";
import { logger } from "./logger.js";

export type MemoryAnswerTaskStatus =
  | "accepted"
  | "running"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled";

export interface MemoryAnswerTaskView {
  id: string;
  origin: "mcp" | "pi_extension";
  questionId: string | null;
  status: MemoryAnswerTaskStatus;
  statusMessage: string | null;
  attemptCount: number;
  maxAttempts: number;
  fenceGeneration: number;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  result: Record<string, unknown> | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface ClaimedMemoryAnswerTask extends MemoryAnswerTaskView {
  leaseOwner: string;
  leaseUntil: string;
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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const taskFromResponse = (
  response: Record<string, unknown>
): MemoryAnswerTaskView => {
  const task = asRecord(response.task);
  if (
    !task ||
    typeof task.id !== "string" ||
    !["mcp", "pi_extension"].includes(String(task.origin)) ||
    ![
      "accepted",
      "running",
      "cancel_requested",
      "completed",
      "failed",
      "cancelled"
    ].includes(String(task.status)) ||
    typeof task.version !== "number"
  ) {
    throw new Error("Memory Answer task API returned an invalid task");
  }
  return task as unknown as MemoryAnswerTaskView;
};

const claimedTaskFromResponse = (
  response: Record<string, unknown>
): ClaimedMemoryAnswerTask | null => {
  if (response.task === null) return null;
  const task = taskFromResponse(response) as ClaimedMemoryAnswerTask;
  if (
    typeof task.leaseOwner !== "string" ||
    typeof task.leaseUntil !== "string" ||
    !asRecord(task.request) ||
    !asRecord(task.request.input) ||
    !asRecord(task.request.caller) ||
    typeof task.request.caller.cwd !== "string"
  ) {
    throw new Error("Memory Answer task API returned an invalid claim");
  }
  return task;
};

const positive = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;

export class MemoryAnswerTaskScheduler {
  private readonly leaseOwner = `local-runtime-${randomBytes(24).toString("base64url")}`;
  private readonly listeners = new Map<
    string,
    Set<(task: MemoryAnswerTaskView) => void>
  >();
  private readonly running = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly maxActive: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly noProgressTimeoutMs: number;
  private readonly hardTimeoutMs: number;
  private readonly reconcileTimer: NodeJS.Timeout;
  private readonly cleanupTimer: NodeJS.Timeout;
  private draining = false;
  private closed = false;

  constructor(
    private readonly apiClient: MemoryApiClient,
    private readonly executor: MemoryAnswerTaskExecutor,
    options: MemoryAnswerTaskSchedulerOptions = {}
  ) {
    this.maxActive = positive(options.maxActive, 2);
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
    const task = taskFromResponse(
      await this.apiClient.acceptMemoryAnswerTask({
        origin: input.origin,
        invocation_key: input.invocationKey,
        request: { input: input.toolInput, caller: input.caller }
      })
    );
    this.publish(task);
    logger.info(
      { taskId: task.id, origin: task.origin, status: task.status },
      "memory answer task accepted"
    );
    this.nudge();
    return task;
  }

  async get(taskId: string): Promise<MemoryAnswerTaskView> {
    return taskFromResponse(await this.apiClient.getMemoryAnswerTask(taskId));
  }

  async cancel(taskId: string): Promise<MemoryAnswerTaskView> {
    const task = taskFromResponse(
      await this.apiClient.cancelMemoryAnswerTask(taskId)
    );
    this.publish(task);
    logger.info(
      { taskId: task.id, status: task.status },
      "memory answer task cancellation requested"
    );
    if (task.status === "cancel_requested") {
      this.running
        .get(task.id)
        ?.controller.abort(new Error("Memory Answer task was cancelled"));
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
    for (const { controller } of this.running.values()) {
      controller.abort(new Error("Local AI Runtime is shutting down"));
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
    while (!this.closed && this.running.size < this.maxActive) {
      const claim = claimedTaskFromResponse(
        await this.apiClient.claimMemoryAnswerTask({
          lease_owner: this.leaseOwner,
          lease_ms: this.leaseMs
        })
      );
      if (!claim) return;
      this.publish(claim);
      logger.info(
        {
          taskId: claim.id,
          attemptCount: claim.attemptCount,
          fenceGeneration: claim.fenceGeneration
        },
        "memory answer task claimed"
      );
      const controller = new AbortController();
      const promise = this.executeClaim(claim, controller).finally(() => {
        this.running.delete(claim.id);
        this.nudge();
      });
      this.running.set(claim.id, { controller, promise });
    }
  }

  private async executeClaim(
    task: ClaimedMemoryAnswerTask,
    controller: AbortController
  ): Promise<void> {
    let reason = "execution_failed";
    let lastProgressAt = Date.now();
    let progressPending = true;
    let statusMessage = "starting";
    const heartbeat = setInterval(() => {
      if (Date.now() - lastProgressAt >= this.noProgressTimeoutMs) {
        reason = "no_progress_timeout";
        controller.abort(
          new Error("Memory Answer no-progress watchdog expired")
        );
        return;
      }
      const madeProgress = progressPending;
      progressPending = false;
      void this.apiClient
        .heartbeatMemoryAnswerTask(task.id, {
          lease_owner: task.leaseOwner,
          fence_generation: task.fenceGeneration,
          lease_ms: this.leaseMs,
          made_progress: madeProgress,
          status_message: statusMessage
        })
        .then((response) => {
          const current = taskFromResponse(response);
          this.publish(current);
          if (current.status === "cancel_requested") {
            reason = "cancelled";
            controller.abort(new Error("Memory Answer task was cancelled"));
          }
        })
        .catch((error) => {
          reason = "lease_lost";
          controller.abort(error);
        });
    }, this.heartbeatMs);
    heartbeat.unref?.();
    const hardTimeout = setTimeout(() => {
      reason = "hard_timeout";
      controller.abort(
        new Error("Memory Answer hard execution ceiling reached")
      );
    }, this.hardTimeoutMs);
    hardTimeout.unref?.();

    try {
      const completed = await this.executor.executeMemoryAnswerTask(
        task.request.input,
        task.request.caller,
        task.id,
        controller.signal,
        (status) => {
          lastProgressAt = Date.now();
          progressPending = true;
          statusMessage = status;
        }
      );
      const terminal = taskFromResponse(
        await this.apiClient.completeMemoryAnswerTask(task.id, {
          lease_owner: task.leaseOwner,
          fence_generation: task.fenceGeneration,
          question_id: completed.questionId,
          result: completed.result
        })
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
      if (
        reason === "execution_failed" &&
        controller.signal.aborted &&
        /cancelled/i.test(
          controller.signal.reason instanceof Error
            ? controller.signal.reason.message
            : String(controller.signal.reason)
        )
      ) {
        reason = "cancelled";
      }
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
      const retry = reason !== "cancelled" && reason !== "hard_timeout";
      try {
        const terminal = taskFromResponse(
          await this.apiClient.failMemoryAnswerTask(task.id, {
            lease_owner: task.leaseOwner,
            fence_generation: task.fenceGeneration,
            error_code: reason,
            error_message:
              error instanceof Error ? error.message : String(error),
            retry,
            retry_delay_ms: retry
              ? Math.min(1_000 * 2 ** task.attemptCount, 30_000)
              : 0
          })
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
      clearInterval(heartbeat);
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

export const memoryAnswerTaskIsTerminal = (
  task: MemoryAnswerTaskView
): boolean => TERMINAL.has(task.status);
