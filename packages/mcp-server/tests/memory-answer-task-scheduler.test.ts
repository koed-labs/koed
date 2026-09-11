import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AnswerExecutionCapacity,
  BlockingAnswerAdmission
} from "../src/answer-admission.js";
import {
  MemoryAnswerTaskScheduler,
  type MemoryAnswerTaskApi,
  type MemoryAnswerTaskView
} from "../src/memory-answer-task-scheduler.js";

const view = (
  overrides: Partial<MemoryAnswerTaskView> = {}
): MemoryAnswerTaskView => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    origin: "mcp",
    invocationKey: null,
    questionId: null,
    status: "accepted",
    statusMessage: null,
    attemptCount: 0,
    maxAttempts: 3,
    fenceGeneration: 0,
    cancelRequestedAt: null,
    startedAt: null,
    lastProgressAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    result: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides
  };
};

const taskApi = (
  fallback: MemoryAnswerTaskView,
  overrides: Partial<MemoryAnswerTaskApi> = {}
): MemoryAnswerTaskApi => ({
  acceptMemoryAnswerTask: vi.fn(async () => ({ task: fallback })),
  getMemoryAnswerTask: vi.fn(async () => ({ task: fallback })),
  claimMemoryAnswerTask: vi.fn(async () => ({ task: null, reconciled: [] })),
  heartbeatMemoryAnswerTask: vi.fn(async () => ({ task: fallback })),
  cancelMemoryAnswerTask: vi.fn(async () => ({ task: fallback })),
  completeMemoryAnswerTask: vi.fn(async () => ({ task: fallback })),
  failMemoryAnswerTask: vi.fn(async () => ({ task: fallback })),
  deleteExpiredMemoryAnswerTasks: vi.fn(async () => ({ deleted: 0 })),
  ...overrides
});

describe("MemoryAnswerTaskScheduler", () => {
  it("runs accepted work once and pushes its fenced terminal result", async () => {
    const accepted = view();
    const running = {
      ...accepted,
      status: "running" as const,
      attemptCount: 1,
      fenceGeneration: 1,
      version: 2,
      leaseOwner: "runtime-lease",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      request: { input: { query: "decision" }, caller: { cwd: "/work" } }
    };
    const completed = view({
      ...running,
      status: "completed",
      questionId: randomUUID(),
      result: { markdown: "answer" },
      completedAt: new Date().toISOString(),
      version: 3
    });
    let claimAvailable = true;
    let current: MemoryAnswerTaskView = accepted;
    const api = taskApi(accepted, {
      acceptMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
      getMemoryAnswerTask: vi.fn(async () => ({ task: current })),
      claimMemoryAnswerTask: vi.fn(async () => {
        if (!claimAvailable) return { task: null, reconciled: [] };
        claimAvailable = false;
        return { task: running, reconciled: [] };
      }),
      heartbeatMemoryAnswerTask: vi.fn(async () => ({ task: running })),
      completeMemoryAnswerTask: vi.fn(async () => {
        current = completed;
        return { task: completed };
      }),
      failMemoryAnswerTask: vi.fn(),
      cancelMemoryAnswerTask: vi.fn()
    });
    const execute = vi.fn(async () => ({
      questionId: completed.questionId!,
      result: completed.result!
    }));
    const scheduler = new MemoryAnswerTaskScheduler(api, {
      executeMemoryAnswerTask: execute
    });

    try {
      const task = await scheduler.start({
        origin: "mcp",
        invocationKey: "session:call-1",
        toolInput: { query: "decision" },
        caller: { cwd: "/work" }
      });
      const terminal = await scheduler.waitForTerminal(task.id);

      expect(terminal).toMatchObject({
        status: "completed",
        result: { markdown: "answer" }
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(api.acceptMemoryAnswerTask).toHaveBeenCalledWith(
        expect.objectContaining({ max_queued: 16 })
      );
      expect(api.completeMemoryAnswerTask).toHaveBeenCalledWith(task.id, {
        lease_owner: running.leaseOwner,
        fence_generation: 1,
        question_id: completed.questionId,
        result: completed.result
      });
      expect(api.failMemoryAnswerTask).not.toHaveBeenCalled();
    } finally {
      await scheduler.close();
    }
  });

  it("propagates explicit cancellation to the exact claimed attempt", async () => {
    const accepted = view();
    const running = {
      ...accepted,
      status: "running" as const,
      attemptCount: 1,
      fenceGeneration: 1,
      version: 2,
      leaseOwner: "runtime-lease",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      request: { input: { query: "decision" }, caller: { cwd: "/work" } }
    };
    const cancelling = view({
      ...running,
      status: "cancel_requested",
      cancelRequestedAt: new Date().toISOString(),
      version: 3
    });
    const cancelled = view({
      ...running,
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      version: 4
    });
    let claimAvailable = true;
    const api = taskApi(accepted, {
      deleteExpiredMemoryAnswerTasks: vi.fn(async () => ({ deleted: 0 })),
      claimMemoryAnswerTask: vi.fn(async () => {
        if (!claimAvailable) return { task: null, reconciled: [] };
        claimAvailable = false;
        return { task: running, reconciled: [] };
      }),
      heartbeatMemoryAnswerTask: vi.fn(async () => ({ task: running })),
      cancelMemoryAnswerTask: vi.fn(async () => ({ task: cancelling })),
      failMemoryAnswerTask: vi.fn(async () => ({ task: cancelled }))
    });
    let attemptSignal: AbortSignal | undefined;
    const scheduler = new MemoryAnswerTaskScheduler(api, {
      executeMemoryAnswerTask: async (_input, _caller, _taskId, signal) => {
        attemptSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        });
        throw new Error("unreachable");
      }
    });

    try {
      await vi.waitFor(() => expect(attemptSignal).toBeDefined());
      await expect(scheduler.cancel(running.id)).resolves.toMatchObject({
        status: "cancel_requested"
      });
      await vi.waitFor(() => expect(attemptSignal?.aborted).toBe(true));
      await vi.waitFor(() =>
        expect(api.failMemoryAnswerTask).toHaveBeenCalledWith(running.id, {
          lease_owner: running.leaseOwner,
          fence_generation: 1,
          error_code: "cancelled",
          error_message: "Memory Answer task was cancelled",
          retry: false,
          retry_delay_ms: 0
        })
      );
    } finally {
      await scheduler.close();
    }
  });

  it("detaches a waiter without cancelling accepted work", async () => {
    const accepted = view();
    const api = taskApi(accepted, {
      acceptMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
      getMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
      claimMemoryAnswerTask: vi.fn(async () => ({
        task: null,
        reconciled: []
      })),
      cancelMemoryAnswerTask: vi.fn()
    });
    const scheduler = new MemoryAnswerTaskScheduler(api, {
      executeMemoryAnswerTask: vi.fn()
    });
    const controller = new AbortController();

    try {
      const pending = scheduler.waitForTerminal(accepted.id, controller.signal);
      controller.abort(new Error("adapter disconnected"));
      await expect(pending).rejects.toThrow("waiter detached");
      expect(api.cancelMemoryAnswerTask).not.toHaveBeenCalled();
    } finally {
      await scheduler.close();
    }
  });

  it("does not write failure through a lease generation it has lost", async () => {
    const accepted = view();
    const running = {
      ...accepted,
      status: "running" as const,
      attemptCount: 1,
      fenceGeneration: 4,
      version: 2,
      leaseOwner: "runtime-lease",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      request: { input: { query: "decision" }, caller: { cwd: "/work" } }
    };
    let claimAvailable = true;
    const api = taskApi(accepted, {
      claimMemoryAnswerTask: vi.fn(async () => {
        if (!claimAvailable) return { task: null, reconciled: [] };
        claimAvailable = false;
        return { task: running, reconciled: [] };
      }),
      heartbeatMemoryAnswerTask: vi.fn(async () => {
        throw new Error("stale lease");
      }),
      failMemoryAnswerTask: vi.fn(),
      completeMemoryAnswerTask: vi.fn()
    });
    const execute = vi.fn(
      async (_input, _caller, _taskId, signal?: AbortSignal) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        })
    );
    const scheduler = new MemoryAnswerTaskScheduler(
      api,
      { executeMemoryAnswerTask: execute },
      { heartbeatMs: 10, leaseMs: 20, reconcileMs: 1_000 }
    );

    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(api.heartbeatMemoryAnswerTask).toHaveBeenCalledOnce()
      );
      await vi.waitFor(() => expect(scheduler.diagnostics.active).toBe(0));
      expect(api.failMemoryAnswerTask).not.toHaveBeenCalled();
      expect(api.completeMemoryAnswerTask).not.toHaveBeenCalled();
    } finally {
      await scheduler.close();
    }
  });

  it("publishes terminal states created during claim reconciliation", async () => {
    const running = view({
      status: "running",
      attemptCount: 3,
      maxAttempts: 3,
      fenceGeneration: 3,
      version: 3
    });
    const failed = view({
      ...running,
      status: "failed",
      failedAt: new Date().toISOString(),
      lastErrorCode: "attempts_exhausted",
      version: 4
    });
    let releaseClaim!: () => void;
    const claimReady = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const api = taskApi(running, {
      deleteExpiredMemoryAnswerTasks: vi.fn(async () => ({ deleted: 0 })),
      getMemoryAnswerTask: vi.fn(async () => ({ task: running })),
      claimMemoryAnswerTask: vi.fn(async () => {
        await claimReady;
        return { task: null, reconciled: [failed] };
      })
    });
    const scheduler = new MemoryAnswerTaskScheduler(api, {
      executeMemoryAnswerTask: vi.fn()
    });

    try {
      const terminal = scheduler.waitForTerminal(running.id);
      await vi.waitFor(() =>
        expect(api.getMemoryAnswerTask).toHaveBeenCalledTimes(2)
      );
      releaseClaim();
      await expect(terminal).resolves.toMatchObject({
        status: "failed",
        lastErrorCode: "attempts_exhausted"
      });
    } finally {
      await scheduler.close();
    }
  });

  it("keeps productive provider work alive past the no-progress window", async () => {
    const accepted = view();
    const running = {
      ...accepted,
      status: "running" as const,
      attemptCount: 1,
      fenceGeneration: 1,
      version: 2,
      leaseOwner: "runtime-lease",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      request: { input: { query: "decision" }, caller: { cwd: "/work" } }
    };
    const completed = view({
      ...running,
      status: "completed",
      questionId: randomUUID(),
      result: { markdown: "answer" },
      completedAt: new Date().toISOString(),
      version: 3
    });
    let claimAvailable = true;
    let current: MemoryAnswerTaskView = accepted;
    const api = taskApi(accepted, {
      deleteExpiredMemoryAnswerTasks: vi.fn(async () => ({ deleted: 0 })),
      acceptMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
      getMemoryAnswerTask: vi.fn(async () => ({ task: current })),
      claimMemoryAnswerTask: vi.fn(async () => {
        if (!claimAvailable) return { task: null, reconciled: [] };
        claimAvailable = false;
        return { task: running, reconciled: [] };
      }),
      heartbeatMemoryAnswerTask: vi.fn(async () => ({ task: running })),
      completeMemoryAnswerTask: vi.fn(async () => {
        current = completed;
        return { task: completed };
      }),
      failMemoryAnswerTask: vi.fn()
    });
    const scheduler = new MemoryAnswerTaskScheduler(
      api,
      {
        executeMemoryAnswerTask: async (
          _input,
          _caller,
          _taskId,
          _signal,
          onProgress
        ) => {
          const progress = setInterval(
            () => onProgress?.("provider activity"),
            10
          );
          await new Promise((resolve) => setTimeout(resolve, 80));
          clearInterval(progress);
          return {
            questionId: completed.questionId!,
            result: completed.result!
          };
        }
      },
      {
        heartbeatMs: 10,
        leaseMs: 100,
        noProgressTimeoutMs: 25,
        hardTimeoutMs: 500
      }
    );

    try {
      const task = await scheduler.start({
        origin: "mcp",
        toolInput: { query: "decision" },
        caller: { cwd: "/work" }
      });
      await expect(scheduler.waitForTerminal(task.id)).resolves.toMatchObject({
        status: "completed"
      });
      expect(api.failMemoryAnswerTask).not.toHaveBeenCalled();
      expect(api.heartbeatMemoryAnswerTask).toHaveBeenCalled();
    } finally {
      await scheduler.close();
    }
  });

  it("shares active execution capacity with blocking answer work", async () => {
    const running = {
      ...view(),
      status: "running" as const,
      attemptCount: 1,
      fenceGeneration: 1,
      version: 2,
      leaseOwner: "runtime-lease",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      request: { input: { query: "decision" }, caller: { cwd: "/work" } }
    };
    let claimAvailable = true;
    const api = taskApi(running, {
      deleteExpiredMemoryAnswerTasks: vi.fn(async () => ({ deleted: 0 })),
      claimMemoryAnswerTask: vi.fn(async () => {
        if (!claimAvailable) return { task: null, reconciled: [] };
        claimAvailable = false;
        return { task: running, reconciled: [] };
      }),
      completeMemoryAnswerTask: vi.fn(async () => ({
        task: view({
          ...running,
          status: "completed",
          questionId: randomUUID(),
          result: { markdown: "answer" },
          completedAt: new Date().toISOString(),
          version: 3
        })
      })),
      failMemoryAnswerTask: vi.fn(),
      heartbeatMemoryAnswerTask: vi.fn(async () => ({ task: running }))
    });
    const capacity = new AnswerExecutionCapacity(1);
    const blocking = new BlockingAnswerAdmission(capacity, 1);
    const releaseBlocking = await blocking.acquire();
    const execute = vi.fn(async () => ({
      questionId: randomUUID(),
      result: { markdown: "answer" }
    }));
    const scheduler = new MemoryAnswerTaskScheduler(
      api,
      { executeMemoryAnswerTask: execute },
      { executionCapacity: capacity }
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(api.claimMemoryAnswerTask).not.toHaveBeenCalled();
      releaseBlocking();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    } finally {
      await scheduler.close();
      blocking.close();
    }
  });
});
