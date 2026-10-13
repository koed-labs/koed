import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerLocalEdgeRoutes } from "./routes.js";

vi.mock("./collaboration-command.js", () => ({
  registerCollaborationCommandRoute: vi.fn()
}));
vi.mock("@koed/shared", async (original) => ({
  ...(await original<typeof import("@koed/shared")>()),
  verifyLocalEdgeClientCredentialAuthorization: (
    _home: string,
    authorization: string
  ) => ({
    backendId: "team",
    operationFamilies:
      authorization === "Koed-Device execution-only:secret"
        ? ["memory_answer_execution"]
        : ["memory_answer_execution", "team_workspace_read"]
  })
}));
vi.mock("./upstream-routing.js", async (original) => ({
  ...(await original<typeof import("./upstream-routing.js")>()),
  readLocalEdgeUpstreamRegistry: () => ({
    schemaVersion: 2,
    updatedAt: "2026-01-01",
    backends: [
      {
        id: "team",
        baseUrl: "https://team.example.test",
        profile: "private_vps",
        routePolicy: { memoryAnswerExecution: "enabled" },
        credential: { status: "configured" },
        capabilities: {
          state: "validated",
          expiresAt: "2099-01-01",
          payload: {
            capabilities: {
              "memory.answerTasks": {
                availability: "available",
                version: 2,
                supportedScopes: ["personal", "team"]
              }
            }
          }
        }
      }
    ]
  })
}));

const taskId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
const fixture = () => {
  const app = Fastify();
  apps.push(app);
  const fetch = vi.fn(
    async (_url: string | URL | Request, options?: RequestInit) => {
      const headers = new Headers(options?.headers);
      expect(headers.get("authorization")).toBe(
        "Bearer broader-upstream-credential"
      );
      expect(headers.get("x-koed-memory-answer-task-scope")).toBe("team");
      return new Response(
        JSON.stringify({ task: { id: taskId, teamWorkspaceId: workspaceId } }),
        { headers: { "content-type": "application/json" } }
      );
    }
  );
  registerLocalEdgeRoutes(app, {
    config: {
      deploymentProfile: "local_personal",
      koedHome: "/unused",
      corsOrigins: []
    },
    requireRepository: () => ({}),
    auth: {},
    capture: {},
    collaboration: {},
    rateLimit: {
      memoryWrite: async () => {},
      memoryRead: async () => {},
      memoryRecall: async () => {}
    },
    localEdge: {
      upstreamBackendsPath: "/unused",
      remoteOperationsAllowed: () => true,
      fetch,
      resolveUpstreamAuthorization: () => "Bearer broader-upstream-credential",
      resolveUpstreamEnrollmentBinding: () => ({
        backendId: "team",
        principalUserId: taskId
      })
    }
  } as unknown as ApiRouteContext);
  const request = (
    operation: string,
    input: Record<string, unknown>,
    authorization = "Koed-Device team-only:secret"
  ) =>
    app.inject({
      method: "POST",
      url: `/v1/local-edge/memory-answer-tasks/${operation}`,
      headers: { authorization },
      payload: { upstream_backend_id: "team", ...input }
    });
  return { app, fetch, request };
};

describe("Team-only native Memory Answer task proxy", () => {
  it("narrows all target operations and cleanup despite broader stored upstream authority", async () => {
    const f = fixture();
    for (const [operation, input] of [
      ["get", { task_id: taskId }],
      ["cancel", { task_id: taskId }],
      [
        "claim",
        {
          input: {
            lease_owner: "worker-lease-identifier",
            lease_ms: 30000,
            scope_filter: "team"
          }
        }
      ],
      [
        "heartbeat",
        {
          task_id: taskId,
          input: {
            lease_owner: "worker-lease-identifier",
            fence_generation: 1,
            lease_ms: 30000
          }
        }
      ],
      [
        "fail",
        {
          task_id: taskId,
          input: {
            lease_owner: "worker-lease-identifier",
            fence_generation: 1,
            error_code: "worker_failed",
            error_message: "Worker failed",
            retry: false
          }
        }
      ],
      [
        "complete",
        {
          task_id: taskId,
          input: {
            lease_owner: "worker-lease-identifier",
            fence_generation: 1,
            final_question: { team_workspace_id: workspaceId },
            result: { markdown: "Helper answer" }
          }
        }
      ],
      ["expired", {}]
    ] as const) {
      const response = await f.request(operation, input);
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });

  it("requires local Team read consent and explicit Team claims and acceptance", async () => {
    const f = fixture();
    expect(
      (
        await f.request(
          "get",
          { task_id: taskId },
          "Koed-Device execution-only:secret"
        )
      ).statusCode
    ).toBe(401);
    expect(
      (
        await f.request("claim", {
          input: { lease_owner: "worker-lease-identifier", lease_ms: 30000 }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await f.request("claim", {
          input: {
            lease_owner: "worker-lease-identifier",
            lease_ms: 30000,
            scope_filter: "personal"
          }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await f.request("accept", {
          input: {
            origin: "mcp",
            max_queued: 100,
            request: {
              input: { query: "fact", search_domain: "global" },
              caller: { cwd: "" }
            }
          }
        })
      ).statusCode
    ).toBe(403);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      (
        await f.request("complete", {
          task_id: taskId,
          input: {
            lease_owner: "worker-lease-identifier",
            fence_generation: 1,
            final_question: {},
            result: { markdown: "Helper answer" }
          }
        })
      ).statusCode
    ).toBe(403);
    const accepted = await f.request("accept", {
      input: {
        origin: "mcp",
        max_queued: 100,
        request: {
          input: {
            query: "fact",
            search_domain: "global",
            team_workspace_id: workspaceId
          },
          caller: { cwd: "" }
        }
      }
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it("does not allow task access through the generic upstream operation route", async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: "POST",
      url: "/v1/local-edge/upstream-operations",
      headers: { authorization: "Koed-Device team-only:secret" },
      payload: {
        upstream_backend_id: "team",
        operation_family: "memory_answer_execution",
        method: "GET",
        path: `/v1/memory/answer-tasks/${taskId}`
      }
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
