import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MemoryApiClient } from "../src/index.js";
import {
  MemoryAnswerTaskScheduler,
  type MemoryAnswerTaskView
} from "../src/memory-answer-task-scheduler.js";

const view = (
  overrides: Partial<MemoryAnswerTaskView> = {}
): MemoryAnswerTaskView => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    origin: "mcp",
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
    const api = {
      acceptMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
      getMemoryAnswerTask: vi.fn(async () => ({ task: current })),
      claimMemoryAnswerTask: vi.fn(async () => {
        if (!claimAvailable) return { task: null };
        claimAvailable = false;
        return { task: running };
      }),
      heartbeatMemoryAnswerTask: vi.fn(async () => ({ task: running })),
      completeMemoryAnswerTask: vi.fn(async () => {
        current = completed;
        return { task: completed };
      }),
      failMemoryAnswerTask: vi.fn(),
      cancelMemoryAnswerTask: vi.fn()
    } as unknown as MemoryApiClient;
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
    const api = {
      deleteExpiredMemoryAnswerTasks: vi.fn(async () => ({ deleted: 0 })),
      claimMemoryAnswerTask: vi.fn(async () => {
        if (!claimAvailable) return { task: null };
        claimAvailable = false;
        return { task: running };
      }),
      heartbeatMemoryAnswerTask: vi.fn(async () => ({ task: running })),
      cancelMemoryAnswerTask: vi.fn(async () => ({ task: cancelling })),
      failMemoryAnswerTask: vi.fn(async () => ({ task: cancelled }))
    } as unknown as MemoryApiClient;
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
    const api = {
      acceptMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
      getMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
      claimMemoryAnswerTask: vi.fn(async () => ({ task: null })),
      cancelMemoryAnswerTask: vi.fn()
    } as unknown as MemoryApiClient;
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
    const api = {
      claimMemoryAnswerTask: vi.fn(async () => {
        if (!claimAvailable) return { task: null };
        claimAvailable = false;
        return { task: running };
      }),
      heartbeatMemoryAnswerTask: vi.fn(async () => {
        throw new Error("stale lease");
      }),
      failMemoryAnswerTask: vi.fn(),
      completeMemoryAnswerTask: vi.fn()
    } as unknown as MemoryApiClient;
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
});
