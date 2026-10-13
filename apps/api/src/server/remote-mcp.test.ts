import Fastify from "fastify";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from "@modelcontextprotocol/server";
import type { MemorySourceRepository } from "@koed/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthHelpers } from "../auth/index.js";
import { registerRemoteMcpRoutes } from "./remote-mcp.js";
import { buildServer } from "./build-server.js";
import type { MemoryAnswerTask } from "@koed/shared";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
});
const body = (method = "tools/list", args?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params: {
    ...(args ? { name: "memory_answer", arguments: args } : {}),
    _meta: {
      [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
      [CLIENT_INFO_META_KEY]: { name: "test", version: "1" },
      [CLIENT_CAPABILITIES_META_KEY]: {}
    }
  }
});

const fixture = (teamEnabled = false) => {
  const app = Fastify();
  apps.push(app);
  let revoked = false;
  const resolvePrincipal = vi.fn(async (token: string) => {
    if (token !== "valid" || revoked) throw new Error("Denied");
    return {
      userId: "user-one",
      grantId: "grant-one",
      clientId: "client",
      resource: "https://memory.test/mcp",
      scopes: ["koed:memory:read", ...(teamEnabled ? ["koed:team:read"] : [])],
      expiresAt: Date.now() / 1000 + 60
    };
  });
  const auth = createAuthHelpers(() => ({}) as MemorySourceRepository, {
    hashSecret: (value) => value,
    cookieSecure: false,
    resolveDelegatedPrincipal: resolvePrincipal
  });
  const apiCalls = vi.fn();
  const taskRequests = vi.fn();
  let acceptedTask: MemoryAnswerTask | undefined;
  app.get("/v1/capabilities", async (request, reply) => {
    apiCalls();
    if (!(await auth.resolveDelegatedPrincipal(request)))
      return reply.code(401).send({ error: "Unauthorized" });
    return {
      capabilitySchemaVersion: 4,
      capabilities: {
        "memory.curatedIntake": { availability: "available" },
        "memory.answerTasks": {
          availability: "available",
          version: 2,
          supportedScopes: ["personal", "team"]
        }
      }
    };
  });
  app.post("/v1/memory/answer-tasks", async (request, reply) => {
    apiCalls();
    if (!(await auth.resolveDelegatedPrincipal(request)))
      return reply.code(401).send({ error: "Unauthorized" });
    if (teamEnabled) {
      const input = request.body as {
        invocation_key: string;
        request: { input: { team_workspace_id?: string } };
      };
      taskRequests(input);
      acceptedTask = {
        id: "7c07a3cc-5679-4df2-bb67-c86571df93c2",
        origin: "mcp",
        invocationKey: input.invocation_key,
        teamWorkspaceId: input.request.input.team_workspace_id ?? null,
        questionId: null,
        status: "accepted",
        statusMessage: null,
        attemptCount: 0,
        maxAttempts: 2,
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
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
      return { task: acceptedTask };
    }
    return reply.code(503).send({ error: "No local executor" });
  });
  app.get("/v1/memory/answer-tasks/:taskId", async (request, reply) => {
    if (!(await auth.resolveDelegatedPrincipal(request)))
      return reply.code(401).send({ error: "Unauthorized" });
    return {
      task: {
        ...acceptedTask,
        status: "completed",
        version: 2,
        result: { markdown: "Authorized Team helper answer." }
      }
    };
  });
  registerRemoteMcpRoutes(app, {
    resourceUrl: new URL("https://memory.test/mcp"),
    auth,
    allowedOrigins: ["https://memory.test"],
    teamCollaborationEnabled: teamEnabled
  });
  const request = (payload = body(), token = "valid", extraHeaders = {}) =>
    app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "memory.test",
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": payload.method,
        ...(payload.method === "tools/call"
          ? { "mcp-name": "memory_answer" }
          : {}),
        ...extraHeaders
      },
      payload
    });
  return {
    app,
    request,
    apiCalls,
    taskRequests,
    resolvePrincipal,
    revoke: () => {
      revoked = true;
    }
  };
};

describe("API remote MCP bridge", () => {
  it("submits Team Memory Answer tasks and returns the local helper answer", async () => {
    const f = fixture(true);
    const workspaceId = "7c07a3cc-5679-4df2-bb67-c86571df93c2";
    const response = await f.request(
      body("tools/call", {
        query: "fact",
        search_domain: "global",
        team_workspace_id: workspaceId,
        team_backend_id: "remote"
      })
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(f.taskRequests).toHaveBeenCalledOnce();
    const accepted = f.taskRequests.mock.calls[0]![0] as {
      request: { input: Record<string, unknown> };
    };
    expect(accepted.request.input.team_workspace_id).toBe(workspaceId);
    const payload = response.json<{
      result: { content: Array<{ type: string; text: string }> };
    }>();
    expect(payload.result.content[0]?.text).toContain(
      "Authorized Team helper answer."
    );
  });
  it("does not mount MCP or OAuth metadata when deployment is disabled", async () => {
    vi.stubEnv("KOED_REMOTE_MCP_ENABLED", "false");
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("WORK_QUEUE_BACKEND", "local");
    const app = await buildServer();
    apps.push(app);
    for (const url of [
      "/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp"
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });

  it("fails deployment startup when remote MCP has no database store", async () => {
    vi.stubEnv("KOED_REMOTE_MCP_ENABLED", "true");
    vi.stubEnv("KOED_REMOTE_MCP_PUBLIC_URL", "https://memory.test/mcp");
    vi.stubEnv("DATABASE_URL", undefined);
    await expect(buildServer()).rejects.toThrow("database-backed OAuth store");
  });
  it("serves gated SDK discovery through authenticated existing API methods", async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.statusCode, response.body).toBe(200);
    const payload = response.json<{
      result: { tools: Array<{ name: string }> };
    }>();
    expect(payload.result.tools.map((tool) => tool.name)).toEqual([
      "memory_answer"
    ]);
    expect(f.apiCalls).toHaveBeenCalledOnce();
    expect(f.resolvePrincipal).toHaveBeenCalledTimes(2);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("rejects denied credentials, Host and Origin without nested API dispatch", async () => {
    const f = fixture();
    expect((await f.request(body(), "invalid")).statusCode).toBe(401);
    expect(
      (await f.request(body(), "valid", { host: "untrusted.test" })).statusCode
    ).toBe(403);
    expect(
      (await f.request(body(), "valid", { origin: "https://untrusted.test" }))
        .statusCode
    ).toBe(403);
    expect(f.apiCalls).not.toHaveBeenCalled();
  });

  it("revalidates a revoked credential after discovery", async () => {
    const f = fixture();
    expect((await f.request()).statusCode).toBe(200);
    f.revoke();
    const response = await f.request(
      body("tools/call", { query: "fact", search_domain: "global" })
    );
    expect(response.statusCode).toBe(401);
    expect(f.apiCalls).toHaveBeenCalledOnce();
    expect(response.headers["www-authenticate"]).toContain(
      "/.well-known/oauth-protected-resource/mcp"
    );
  });

  it("enforces the transport body bound before invoking the executor", async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "memory.test",
        "content-type": "application/json",
        authorization: "Bearer valid"
      },
      payload: JSON.stringify({ value: "x".repeat(1_048_576) })
    });
    expect(response.statusCode).toBe(413);
    expect(f.apiCalls).not.toHaveBeenCalled();
  });
});
