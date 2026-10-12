import Fastify from "fastify";
import type { MemorySourceRepository } from "@koed/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthHelpers } from "../auth/index.js";
import type { ApiRouteContext } from "../server/context.js";
import { registerMemoryAnswerTaskRoutes } from "./memory-answer-task-routes.js";
import { verifyMemoryAnswerAuthorizationBoundary } from "./memory-answer-authorization-boundary.js";

const userId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const workspaceId = "00000000-0000-4000-8000-000000000003";
const user = { id: userId, email: "user@example.test", displayName: "User" };
const boundary = {
  teamId: userId,
  teamVersion: 1,
  teamWorkspaceId: workspaceId,
  workspaceVersion: 1,
  membershipVersion: 1,
  workspaceAccessVersion: 1,
  userRowVersion: "1",
  shareGrantIds: [taskId]
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const fixture = ({
  scopes = ["koed:memory:read", "koed:local-execution", "koed:team:read"],
  families = ["memory_answer_execution", "team_workspace_read"]
}: { scopes?: string[]; families?: string[] } = {}) => {
  const app = Fastify();
  apps.push(app);
  const task = { id: taskId, teamWorkspaceId: workspaceId, status: "running" };
  const repo = {
    getUser: vi.fn(async () => user),
    getApiTokenUser: vi.fn(async (hash: string) =>
      hash === "personal" ? user : null
    ),
    getDeviceCredentialUser: vi.fn(async () => ({
      user,
      credential: { operationFamilies: families }
    })),
    acceptMemoryAnswerTask: vi.fn(async () => task),
    getMemoryAnswerTask: vi.fn(async () => task),
    claimMemoryAnswerTask: vi.fn(
      async (_actor: unknown, input: { scopeFilter: string }) =>
        input.scopeFilter === "team"
          ? {
              task: { ...task, request: {} },
              reconciled: [],
              teamAuthority: {
                version: 1,
                ownerUserId: userId,
                recallBoundary: boundary,
                grantFingerprints: {}
              }
            }
          : {
              task: { ...task, teamWorkspaceId: null, request: {} },
              reconciled: []
            }
    ),
    heartbeatMemoryAnswerTask: vi.fn(async () => task),
    getMemoryAnswerTaskTeamAuthority: vi.fn(async () => ({
      version: 1,
      ownerUserId: userId,
      recallBoundary: boundary,
      grantFingerprints: {}
    })),
    completeMemoryAnswerTask: vi.fn(async () => task),
    cancelMemoryAnswerTask: vi.fn(async () => task),
    failMemoryAnswerTask: vi.fn(async () => task),
    deleteExpiredMemoryAnswerTasks: vi.fn(async () => 0)
  };
  const auth = createAuthHelpers(
    () => repo as unknown as MemorySourceRepository,
    {
      hashSecret: (value) => value,
      cookieSecure: false,
      resolveDelegatedPrincipal: async (token) => {
        if (token !== "delegated") throw new Error("Denied");
        return {
          userId,
          grantId: taskId,
          clientId: "test",
          resource: "https://memory.test/mcp",
          scopes,
          expiresAt: Date.now() / 1000 + 60
        };
      }
    }
  );
  registerMemoryAnswerTaskRoutes(app, {
    requireRepository: () => repo,
    auth,
    config: { apiTokenPepper: "test-boundary-secret" },
    rateLimit: {
      aiClientControl: async () => {},
      memoryRead: async () => {},
      memoryWrite: async () => {}
    }
  } as unknown as ApiRouteContext);
  const request = (
    url: string,
    payload?: Record<string, unknown>,
    authorization = "Bearer delegated",
    method: "GET" | "POST" = "POST"
  ) => app.inject({ method, url, payload, headers: { authorization } });
  return { app, repo, request };
};

describe("Memory Answer task serving authority", () => {
  const accept = (team = true) => ({
    origin: "mcp",
    max_queued: 100,
    request: {
      input: {
        query: "fact",
        search_domain: "global",
        ...(team ? { team_workspace_id: workspaceId } : {})
      },
      caller: { cwd: "" }
    }
  });

  it("derives Team selection from validated tool input and rejects Personal credentials", async () => {
    const f = fixture();
    const accepted = await f.request("/v1/memory/answer-tasks", accept());
    expect(accepted.statusCode).toBe(200);
    expect(f.repo.acceptMemoryAnswerTask).toHaveBeenCalledWith(
      { userId, allowTeam: true, allowPersonal: true },
      expect.objectContaining({ teamWorkspaceId: workspaceId })
    );
    const denied = await f.request(
      "/v1/memory/answer-tasks",
      accept(),
      "Bearer personal"
    );
    expect(denied.statusCode).toBe(403);
    expect(f.repo.acceptMemoryAnswerTask).toHaveBeenCalledOnce();
  });

  it("requires execution consent in addition to Team read for Team claim", async () => {
    const f = fixture({ scopes: ["koed:memory:read", "koed:team:read"] });
    const response = await f.request("/v1/memory/answer-tasks/claim", {
      lease_owner: "worker-lease-identifier",
      lease_ms: 30000,
      scope_filter: "team"
    });
    expect(response.statusCode).toBe(403);
    expect(f.repo.claimMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("does not give execution authority to old Team-read or managed-execution devices", async () => {
    const f = fixture({
      families: ["team_workspace_read", "managed_execution"]
    });
    const response = await f.request(
      "/v1/memory/answer-tasks/claim",
      {
        lease_owner: "worker-lease-identifier",
        lease_ms: 30000,
        scope_filter: "team"
      },
      "Koed-Device device-key:secret"
    );
    expect(response.statusCode).toBe(403);
    expect(f.repo.claimMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("restricts a newly consented Team-only device to Team task scope", async () => {
    const f = fixture();
    const response = await f.request(
      "/v1/memory/answer-tasks/claim",
      {
        lease_owner: "worker-lease-identifier",
        lease_ms: 30000,
        scope_filter: "team"
      },
      "Koed-Device device-key:secret"
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(f.repo.claimMemoryAnswerTask).toHaveBeenCalledWith(
      { userId, allowTeam: true, allowPersonal: false },
      expect.objectContaining({ allowTeam: true, scopeFilter: "team" })
    );
    const payload = response.json<{
      task: { executionAuthority: { authorizationBoundary: string } };
    }>();
    expect(
      verifyMemoryAnswerAuthorizationBoundary({
        token: payload.task.executionAuthority.authorizationBoundary,
        secret: "test-boundary-secret",
        subjectUserId: userId,
        teamWorkspaceId: workspaceId
      })
    ).toEqual(boundary);
    const denied = await f.request(
      "/v1/memory/answer-tasks/claim",
      { lease_owner: "worker-lease-identifier", lease_ms: 30000 },
      "Koed-Device device-key:secret"
    );
    expect(denied.statusCode).toBe(403);
    expect(f.repo.claimMemoryAnswerTask).toHaveBeenCalledOnce();
  });

  it("keeps omitted claim scope Personal-only and never publishes raw Team authority", async () => {
    const f = fixture();
    const response = await f.request("/v1/memory/answer-tasks/claim", {
      lease_owner: "worker-lease-identifier",
      lease_ms: 30000
    });
    expect(response.statusCode).toBe(200);
    expect(f.repo.claimMemoryAnswerTask).toHaveBeenCalledWith(
      expect.objectContaining({ allowTeam: true }),
      expect.objectContaining({ allowTeam: false, scopeFilter: "personal" })
    );
    const payload = response.json<{
      task: {
        executionAuthority: { scope: string; authorizationBoundary: string };
      };
      teamAuthority?: unknown;
    }>();
    expect(payload.teamAuthority).toBeUndefined();
    expect(payload.task.executionAuthority).toEqual({ scope: "personal" });
  });

  it("refreshes execution authority from the same persisted Team boundary on heartbeat", async () => {
    const f = fixture();
    const response = await f.request(
      `/v1/memory/answer-tasks/${taskId}/heartbeat`,
      {
        lease_owner: "worker-lease-identifier",
        fence_generation: 1,
        lease_ms: 30000
      }
    );
    expect(response.statusCode).toBe(200);
    expect(f.repo.getMemoryAnswerTaskTeamAuthority).toHaveBeenCalledWith(
      { userId, allowTeam: true, allowPersonal: true },
      taskId
    );
    const payload = response.json<{
      executionAuthority: { scope: string; authorizationBoundary: string };
    }>();
    expect(
      verifyMemoryAnswerAuthorizationBoundary({
        token: payload.executionAuthority.authorizationBoundary,
        secret: "test-boundary-secret",
        subjectUserId: userId,
        teamWorkspaceId: workspaceId
      })
    ).toEqual(boundary);
  });

  it("validates final history and forwards it in the atomic task completion operation", async () => {
    const f = fixture();
    const response = await f.request(
      `/v1/memory/answer-tasks/${taskId}/complete`,
      {
        lease_owner: "worker-lease-identifier",
        fence_generation: 1,
        final_question: {
          idempotency_key: "memory-answer-task:test",
          status: "answered",
          query: "fact",
          origin: "mcp_memory_answer",
          search_domain: "global",
          retrieval_scope: "personal",
          team_workspace_id: workspaceId,
          answer_markdown: "Helper answer"
        },
        result: { markdown: "Helper answer" }
      }
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(f.repo.completeMemoryAnswerTask).toHaveBeenCalledWith(
      { userId, allowTeam: true, allowPersonal: true },
      expect.objectContaining({
        finalQuestion: expect.objectContaining({
          status: "answered",
          teamWorkspaceId: workspaceId,
          answerMarkdown: "Helper answer"
        })
      })
    );
  });

  it("narrows broader upstream authority before task access and rejects invalid selectors", async () => {
    const f = fixture();
    const get = (scope: string) =>
      f.app.inject({
        method: "GET",
        url: `/v1/memory/answer-tasks/${taskId}`,
        headers: {
          authorization: "Bearer delegated",
          "x-koed-memory-answer-task-scope": scope
        }
      });
    expect((await get("team")).statusCode).toBe(200);
    expect(f.repo.getMemoryAnswerTask).toHaveBeenCalledWith(
      { userId, allowTeam: true, allowPersonal: false },
      taskId
    );
    expect((await get("personal")).statusCode).toBe(200);
    expect(f.repo.getMemoryAnswerTask).toHaveBeenLastCalledWith(
      { userId, allowTeam: false, allowPersonal: true },
      taskId
    );
    expect((await get("all")).statusCode).toBe(400);
    expect(f.repo.getMemoryAnswerTask).toHaveBeenCalledTimes(2);
    const denied = fixture({ scopes: ["koed:memory:read"] });
    expect(
      (
        await denied.app.inject({
          method: "GET",
          url: `/v1/memory/answer-tasks/${taskId}`,
          headers: {
            authorization: "Bearer delegated",
            "x-koed-memory-answer-task-scope": "team"
          }
        })
      ).statusCode
    ).toBe(403);
    expect(denied.repo.getMemoryAnswerTask).not.toHaveBeenCalled();
  });
});
