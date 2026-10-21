import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MemoryAnswerTask, ClaimedMemoryAnswerTask } from "@koed/shared";
import type { MemoryAnswerRetrievalClient } from "../src/answer-worker.js";
import { AnswerExecutionCapacity } from "../src/answer-admission.js";
import { MemoryAnswerTaskScheduler } from "../src/memory-answer-task-scheduler.js";
import {
  MemoryAnswerTaskCoordinator,
  createMemoryAnswerTaskCoordinator,
  supportsTeamMemoryAnswerTasks,
  type MemoryAnswerTaskBackend
} from "../src/memory-answer-task-coordinator.js";
import { MemoryApiClient } from "../src/index.js";

const task = (team = false): MemoryAnswerTask => ({
  id: randomUUID(),
  teamWorkspaceId: team ? randomUUID() : null,
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
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString()
});
const notFound = () => Object.assign(new Error("Not found"), { status: 404 });
const backend = (
  id: string,
  accepted: MemoryAnswerTask
): MemoryAnswerTaskBackend => ({
  id,
  scope: accepted.teamWorkspaceId ? "team" : "personal",
  retrieval: {
    search: vi.fn(async () => ({})),
    expand: vi.fn(async () => ({}))
  },
  api: {
    acceptMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
    getMemoryAnswerTask: vi.fn(async (id) => {
      if (id !== accepted.id) throw notFound();
      return { task: accepted };
    }),
    claimMemoryAnswerTask: vi.fn(async () => ({ task: null, reconciled: [] })),
    heartbeatMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
    cancelMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
    completeMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
    failMemoryAnswerTask: vi.fn(async () => ({ task: accepted })),
    deleteExpiredMemoryAnswerTasks: vi.fn(async () => ({ deleted: 0 }))
  }
});
const acceptInput = (teamWorkspaceId?: string) => ({
  origin: "mcp" as const,
  max_queued: 16,
  request: {
    input: {
      query: "Synthetic decision",
      ...(teamWorkspaceId ? { team_workspace_id: teamWorkspaceId } : {})
    },
    caller: { cwd: "/fixture" }
  }
});
const claim = (accepted: MemoryAnswerTask): ClaimedMemoryAnswerTask => ({
  ...accepted,
  status: "running",
  attemptCount: 1,
  fenceGeneration: 1,
  leaseOwner: "coordinator-lease",
  leaseUntil: new Date(Date.now() + 60000).toISOString(),
  request: acceptInput(accepted.teamWorkspaceId ?? undefined).request,
  executionAuthority: accepted.teamWorkspaceId
    ? {
        scope: "team",
        teamWorkspaceId: accepted.teamWorkspaceId,
        authorizationBoundary: "signed-boundary"
      }
    : { scope: "personal" }
});
const coordinator = (
  bindings: () => readonly MemoryAnswerTaskBackend[],
  maxRoutes?: number
) =>
  new MemoryAnswerTaskCoordinator({
    backends: async () => bindings(),
    maxRoutes,
    resolveStart: async (input) => ({
      backendId:
        input.request.input &&
        typeof input.request.input === "object" &&
        "team_workspace_id" in input.request.input
          ? "team"
          : "personal",
      input
    })
  });

describe("Memory Answer task coordinator", () => {
  for (const parentCount of [1, 2]) {
    it(`runs ${parentCount} combined parent task(s) and exact Team children with every capacity slot occupied`, async () => {
      const parents = Array.from({ length: parentCount }, () => task());
      const children = new Map<string, MemoryAnswerTask>();
      const personal = backend("personal", parents[0]!);
      const teamWorkspaceId = randomUUID();
      const team = backend("team", { ...task(true), teamWorkspaceId });
      const rows = new Map(parents.map((row) => [row.id, row]));
      vi.mocked(personal.api.getMemoryAnswerTask).mockImplementation(
        async (id) => {
          const row = rows.get(id);
          if (!row) throw notFound();
          return { task: row };
        }
      );
      vi.mocked(team.api.getMemoryAnswerTask).mockImplementation(async (id) => {
        const row = children.get(id);
        if (!row) throw notFound();
        return { task: row };
      });
      vi.mocked(personal.api.claimMemoryAnswerTask).mockImplementation(
        async () => {
          const row = [...rows.values()].find(
            (item) => item.status === "accepted"
          );
          if (!row) return { task: null, reconciled: [] };
          rows.set(row.id, { ...row, status: "running" });
          return { task: claim(row), reconciled: [] };
        }
      );
      vi.mocked(team.api.acceptMemoryAnswerTask).mockImplementation(
        async () => {
          const row = { ...task(true), teamWorkspaceId };
          children.set(row.id, row);
          return { task: row };
        }
      );
      vi.mocked(team.api.claimMemoryAnswerTask).mockImplementation(
        async (input) => {
          const row = input.task_id ? children.get(input.task_id) : undefined;
          if (!row || row.status !== "accepted")
            return { task: null, reconciled: [] };
          children.set(row.id, { ...row, status: "running" });
          return { task: claim(row), reconciled: [] };
        }
      );
      vi.mocked(team.api.completeMemoryAnswerTask).mockImplementation(
        async (id, input) => {
          const row = children.get(id)!;
          const completed = {
            ...row,
            status: "completed" as const,
            result: input.result
          };
          children.set(id, completed);
          return { task: completed };
        }
      );
      vi.mocked(personal.api.completeMemoryAnswerTask).mockImplementation(
        async (id, input) => {
          const row = rows.get(id)!;
          const completed = {
            ...row,
            status: "completed" as const,
            result: input.result
          };
          rows.set(id, completed);
          return { task: completed };
        }
      );
      const adapter = coordinator(() => [personal, team]);
      const scheduler = new MemoryAnswerTaskScheduler(
        adapter,
        {
          async executeMemoryAnswerTask(
            _input,
            caller,
            id,
            signal,
            progress,
            context
          ) {
            if (context?.getExecutionAuthority().scope === "team") {
              progress?.("Team child complete");
              return {
                finalQuestion: { query: "Team" },
                result: { markdown: "Team evidence" }
              };
            }
            const child = await context!.startCombinedTeamChild!(
              {
                query: "Team",
                team_workspace_id: teamWorkspaceId
              },
              caller,
              `child:${id}`
            );
            await context!.runCombinedTeamChild!(child.id, signal);
            const completed = await context!.getCombinedTeamChild!(child.id);
            expect(completed.status).toBe("completed");
            progress?.("Combined complete");
            return {
              finalQuestion: { query: "Combined" },
              result: { markdown: "Personal and Team evidence" }
            };
          }
        },
        {
          maxActive: parentCount,
          executionContextForTask: adapter.executionContextForTask,
          reconcileMs: 60_000
        }
      );
      try {
        await vi.waitFor(
          () => {
            expect(
              [...rows.values()].filter((row) => row.status === "completed")
            ).toHaveLength(parentCount);
            expect(
              [...children.values()].filter((row) => row.status === "completed")
            ).toHaveLength(parentCount);
          },
          { timeout: 5_000 }
        );
        expect(
          vi
            .mocked(team.api.claimMemoryAnswerTask)
            .mock.calls.every(
              ([input]) => !input.task_id || children.has(input.task_id)
            )
        ).toBe(true);
      } finally {
        await scheduler.close();
      }
    });
  }

  it("retries a nested Team child when the parent runtime shuts down", async () => {
    const parent = task();
    const child = task(true);
    const personal = backend("personal", parent);
    const team = backend("team", child);
    vi.mocked(personal.api.claimMemoryAnswerTask).mockResolvedValueOnce({
      task: claim(parent),
      reconciled: []
    });
    vi.mocked(team.api.acceptMemoryAnswerTask).mockResolvedValue({
      task: child
    });
    vi.mocked(team.api.claimMemoryAnswerTask).mockImplementation(
      async (input) =>
        input.task_id === child.id
          ? { task: claim(child), reconciled: [] }
          : { task: null, reconciled: [] }
    );
    const adapter = coordinator(() => [personal, team]);
    let childStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const scheduler = new MemoryAnswerTaskScheduler(
      adapter,
      {
        async executeMemoryAnswerTask(
          _input,
          caller,
          id,
          signal,
          _progress,
          context
        ) {
          if (id === child.id) {
            childStarted();
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true
              });
            });
          }
          const accepted = await context!.startCombinedTeamChild!(
            { query: "Team", team_workspace_id: child.teamWorkspaceId },
            caller,
            `child:${id}`
          );
          await context!.runCombinedTeamChild!(accepted.id, signal);
          return { finalQuestion: {}, result: {} };
        }
      },
      {
        maxActive: 1,
        executionContextForTask: adapter.executionContextForTask,
        reconcileMs: 60_000
      }
    );
    await entered;
    await scheduler.close();
    expect(team.api.failMemoryAnswerTask).toHaveBeenCalledWith(
      child.id,
      expect.objectContaining({
        error_code: "shutdown",
        retry: true
      })
    );
    expect(team.api.cancelMemoryAnswerTask).not.toHaveBeenCalled();
  });
  it("routes Personal and Team acceptance to their authorized backend", async () => {
    const personal = backend("personal", task());
    const teamTask = task(true);
    const team = backend("team", teamTask);
    const adapter = coordinator(() => [personal, team]);
    await adapter.acceptMemoryAnswerTask(acceptInput());
    await adapter.acceptMemoryAnswerTask(
      acceptInput(teamTask.teamWorkspaceId!)
    );
    expect(personal.api.acceptMemoryAnswerTask).toHaveBeenCalledOnce();
    expect(team.api.acceptMemoryAnswerTask).toHaveBeenCalledOnce();
    expect(await adapter.getMemoryAnswerTask(teamTask.id)).toHaveProperty(
      "task.teamWorkspaceId"
    );
  });

  it("round-robins scoped claims and supplies the exact retrieval binding", async () => {
    const personalTask = task();
    const teamTask = task(true);
    const personal = backend("personal", personalTask);
    const team = backend("team", teamTask);
    vi.mocked(personal.api.claimMemoryAnswerTask).mockResolvedValue({
      task: claim(personalTask),
      reconciled: []
    });
    vi.mocked(team.api.claimMemoryAnswerTask).mockResolvedValue({
      task: claim(teamTask),
      reconciled: []
    });
    const adapter = coordinator(() => [personal, team]);
    const input = { lease_owner: "coordinator-runtime", lease_ms: 60000 };
    expect((await adapter.claimMemoryAnswerTask(input)).task?.id).toBe(
      personalTask.id
    );
    expect((await adapter.claimMemoryAnswerTask(input)).task?.id).toBe(
      teamTask.id
    );
    expect(personal.api.claimMemoryAnswerTask).toHaveBeenCalledWith({
      ...input,
      scope_filter: "personal"
    });
    expect(team.api.claimMemoryAnswerTask).toHaveBeenCalledWith({
      ...input,
      scope_filter: "team"
    });
    const authority = claim(teamTask).executionAuthority!;
    const context = adapter.executionContextForTask(
      claim(teamTask),
      () => authority
    );
    expect(context.getExecutionAuthority()).toEqual(authority);
    expect(context.taskBackend).toBe(team.retrieval);
  });

  it("recovers task routing after restart and cache eviction using authorized reads", async () => {
    const personalTask = task();
    const teamTask = task(true);
    const personal = backend("personal", personalTask);
    const team = backend("team", teamTask);
    const adapter = coordinator(() => [personal, team], 1);
    await adapter.getMemoryAnswerTask(personalTask.id);
    await adapter.getMemoryAnswerTask(teamTask.id);
    await adapter.cancelMemoryAnswerTask(personalTask.id);
    expect(personal.api.cancelMemoryAnswerTask).toHaveBeenCalledWith(
      personalTask.id
    );
    const restarted = coordinator(() => [personal, team]);
    await restarted.cancelMemoryAnswerTask(teamTask.id);
    expect(team.api.cancelMemoryAnswerTask).toHaveBeenCalledWith(teamTask.id);
  });

  it("denies cached routes after authorization loss without switching authority", async () => {
    const personal = backend("personal", task());
    const teamTask = task(true);
    const team = backend("team", teamTask);
    let enabled = true;
    const adapter = coordinator(() =>
      enabled ? [personal, team] : [personal]
    );
    await adapter.getMemoryAnswerTask(teamTask.id);
    enabled = false;
    await expect(
      adapter.cancelMemoryAnswerTask(teamTask.id)
    ).rejects.toMatchObject({ status: 403 });
    expect(personal.api.cancelMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("recovers cold routes when an unrelated scope denies the task", async () => {
    const personalTask = task();
    const teamTask = task(true);
    const personal = backend("personal", personalTask);
    const team = backend("team", teamTask);
    vi.mocked(personal.api.getMemoryAnswerTask).mockImplementation(
      async (id) => {
        if (id !== personalTask.id)
          throw Object.assign(new Error("Scope denied"), { status: 403 });
        return { task: personalTask };
      }
    );
    vi.mocked(team.api.getMemoryAnswerTask).mockImplementation(async (id) => {
      if (id !== teamTask.id)
        throw Object.assign(new Error("Scope denied"), { status: 403 });
      return { task: teamTask };
    });
    await coordinator(() => [personal, team]).cancelMemoryAnswerTask(
      teamTask.id
    );
    await coordinator(() => [personal, team]).cancelMemoryAnswerTask(
      personalTask.id
    );
    expect(team.api.cancelMemoryAnswerTask).toHaveBeenCalledExactlyOnceWith(
      teamTask.id
    );
    expect(personal.api.cancelMemoryAnswerTask).toHaveBeenCalledExactlyOnceWith(
      personalTask.id
    );
  });

  it("rejects ambiguous task IDs and unavailable lookup backends", async () => {
    const accepted = task(true);
    const first = backend("first", accepted);
    const second = backend("second", accepted);
    await expect(
      coordinator(() => [first, second]).getMemoryAnswerTask(accepted.id)
    ).rejects.toMatchObject({ status: 409 });
    vi.mocked(second.api.getMemoryAnswerTask).mockRejectedValue(
      Object.assign(new Error("Unavailable"), { status: 503 })
    );
    await expect(
      coordinator(() => [first, second]).cancelMemoryAnswerTask(accepted.id)
    ).rejects.toMatchObject({ status: 503 });
    expect(first.api.cancelMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("executes Personal and Team tasks through one scheduler and shared capacity", async () => {
    const personalTask = task();
    const teamTask = task(true);
    const personal = backend("personal", personalTask);
    const team = backend("team", teamTask);
    vi.mocked(personal.api.claimMemoryAnswerTask).mockResolvedValueOnce({
      task: claim(personalTask),
      reconciled: []
    });
    vi.mocked(team.api.claimMemoryAnswerTask).mockResolvedValueOnce({
      task: claim(teamTask),
      reconciled: []
    });
    const adapter = coordinator(() => [personal, team]);
    const capacity = new AnswerExecutionCapacity(1);
    const release = capacity.tryAcquire()!;
    const executions: Array<{
      id: string;
      backend?: MemoryAnswerRetrievalClient;
    }> = [];
    let finish: (() => void) | undefined;
    let active = 0;
    let peak = 0;
    const scheduler = new MemoryAnswerTaskScheduler(
      adapter,
      {
        async executeMemoryAnswerTask(
          _input,
          _caller,
          id,
          _signal,
          _progress,
          context
        ) {
          active++;
          peak = Math.max(peak, active);
          executions.push({ id, backend: context?.taskBackend });
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          active--;
          return {
            finalQuestion: { query: "Synthetic decision" },
            result: { markdown: "Synthetic result" }
          };
        }
      },
      {
        executionCapacity: capacity,
        executionContextForTask: adapter.executionContextForTask,
        reconcileMs: 60000
      }
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(executions).toHaveLength(0);
      release();
      await vi.waitFor(() => expect(executions).toHaveLength(1));
      expect(executions[0]).toEqual({
        id: personalTask.id,
        backend: personal.retrieval
      });
      finish!();
      await vi.waitFor(() => expect(executions).toHaveLength(2));
      expect(executions[1]).toEqual({
        id: teamTask.id,
        backend: team.retrieval
      });
      finish!();
      await vi.waitFor(() =>
        expect(team.api.completeMemoryAnswerTask).toHaveBeenCalledOnce()
      );
      expect(peak).toBe(1);
    } finally {
      finish?.();
      await scheduler.close();
    }
  });

  it("requires the available version-two Team task capability", () => {
    const payload = {
      capabilities: {
        "memory.answerTasks": {
          availability: "available",
          version: 2,
          supportedScopes: ["personal", "team"]
        }
      }
    };
    expect(supportsTeamMemoryAnswerTasks(payload)).toBe(true);
    expect(
      supportsTeamMemoryAnswerTasks({
        capabilities: {
          "memory.answerTasks": {
            availability: "available",
            version: 1,
            supportedScopes: ["team"]
          }
        }
      })
    ).toBe(false);
    expect(
      supportsTeamMemoryAnswerTasks({
        capabilities: {
          "memory.answerTasks": {
            availability: "available",
            version: 2,
            supportedScopes: ["personal"]
          }
        }
      })
    ).toBe(false);
  });

  it("claims only Personal work without explicit headless Team consent", async () => {
    const client = new MemoryApiClient({ apiUrl: "https://koed.example" });
    const claim = vi
      .spyOn(client, "claimMemoryAnswerTask")
      .mockResolvedValue({ task: null, reconciled: [] });
    const accept = vi.spyOn(client, "acceptMemoryAnswerTask");
    const adapter = createMemoryAnswerTaskCoordinator(client, {
      KOED_HOME: "/fixture/no-enrollment"
    });
    const lease = { lease_owner: "coordinator-runtime", lease_ms: 60000 };
    await adapter.claimMemoryAnswerTask(lease);
    expect(claim).toHaveBeenCalledExactlyOnceWith({
      ...lease,
      scope_filter: "personal"
    });
    await expect(
      adapter.acceptMemoryAnswerTask(acceptInput(randomUUID()))
    ).rejects.toMatchObject({ status: 403 });
    expect(accept).not.toHaveBeenCalled();
  });

  it("uses separate Personal and Team claims on an explicitly approved headless backend", async () => {
    const client = new MemoryApiClient({ apiUrl: "https://koed.example" });
    vi.spyOn(client, "capabilities").mockResolvedValue({
      capabilities: {
        "memory.answerTasks": {
          availability: "available",
          version: 2,
          supportedScopes: ["personal", "team"]
        }
      }
    });
    const claimed = vi
      .spyOn(client, "claimMemoryAnswerTask")
      .mockResolvedValue({ task: null, reconciled: [] });
    const accepted = task(true);
    const accept = vi
      .spyOn(client, "acceptMemoryAnswerTask")
      .mockResolvedValue({ task: accepted });
    const adapter = createMemoryAnswerTaskCoordinator(
      client,
      { KOED_HOME: "/fixture/no-enrollment" },
      true
    );
    const lease = { lease_owner: "coordinator-runtime", lease_ms: 60000 };
    await adapter.claimMemoryAnswerTask(lease);
    expect(claimed.mock.calls.map(([input]) => input.scope_filter)).toEqual([
      "personal",
      "team"
    ]);
    const input = acceptInput(accepted.teamWorkspaceId!);
    await adapter.acceptMemoryAnswerTask({
      ...input,
      request: {
        ...input.request,
        input: { ...input.request.input, team_backend_id: "remote" }
      }
    });
    expect(accept).toHaveBeenCalledWith({
      ...input,
      request: {
        ...input.request,
        input: {
          ...input.request.input,
          search_domain: "project",
          response_detail: "answer_only",
          limit: 10,
          include_evidence: false,
          project_id: "/fixture"
        }
      }
    });
    await expect(
      adapter.acceptMemoryAnswerTask({
        ...input,
        request: {
          ...input.request,
          input: { ...input.request.input, team_backend_id: "unregistered" }
        }
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(accept).toHaveBeenCalledOnce();
  });

  it("drops the headless Team binding when the current capability no longer supports Team tasks", async () => {
    const client = new MemoryApiClient({ apiUrl: "https://koed.example" });
    vi.spyOn(client, "capabilities").mockResolvedValue({
      capabilities: {
        "memory.answerTasks": {
          availability: "available",
          version: 2,
          supportedScopes: ["personal"]
        }
      }
    });
    const claimed = vi
      .spyOn(client, "claimMemoryAnswerTask")
      .mockResolvedValue({ task: null, reconciled: [] });
    const accept = vi.spyOn(client, "acceptMemoryAnswerTask");
    const adapter = createMemoryAnswerTaskCoordinator(
      client,
      { KOED_HOME: "/fixture/no-enrollment" },
      true
    );
    await adapter.claimMemoryAnswerTask({
      lease_owner: "coordinator-runtime",
      lease_ms: 60000
    });
    expect(claimed.mock.calls.map(([input]) => input.scope_filter)).toEqual([
      "personal"
    ]);
    await expect(
      adapter.acceptMemoryAnswerTask(acceptInput(randomUUID()))
    ).rejects.toMatchObject({ status: 403 });
    expect(accept).not.toHaveBeenCalled();
  });
});
