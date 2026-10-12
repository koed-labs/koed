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
import { searchMemorySchema } from "../memory/recall-schemas.js";

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
  app.get("/v1/capabilities", async (request, reply) => {
    apiCalls();
    if (!(await auth.resolveDelegatedPrincipal(request)))
      return reply.code(401).send({ error: "Unauthorized" });
    return {
      capabilitySchemaVersion: 4,
      capabilities: { "memory.curatedIntake": { availability: "available" } }
    };
  });
  app.post("/v1/memory/answer-tasks", async (request, reply) => {
    apiCalls();
    if (!(await auth.resolveDelegatedPrincipal(request)))
      return reply.code(401).send({ error: "Unauthorized" });
    return reply.code(503).send({ error: "No local executor" });
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
    resolvePrincipal,
    revoke: () => {
      revoked = true;
    }
  };
};

describe("API remote MCP bridge", () => {
  it("uses the existing Team API selection contract and returns its evidence", async () => {
    const f = fixture(true);
    const workspaceId = "7c07a3cc-5679-4df2-bb67-c86571df93c2";
    const answer = vi.fn();
    f.app.post("/v1/memory/answer", (request) => {
      const input = searchMemorySchema.parse(request.body);
      answer(input);
      return { evidence: [{ text: "Authorized Team fact" }], citations: [] };
    });
    const response = await f.request(
      body("tools/call", {
        query: "fact",
        search_domain: "global",
        team_workspace_id: workspaceId,
        team_backend_id: "remote"
      })
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({
        retrieval_scope: "personal",
        team_workspace_id: workspaceId
      })
    );
    const payload = response.json<{
      result: { structuredContent: Record<string, unknown> };
    }>();
    expect(payload.result.structuredContent.synthesis).toBe("ai_client");
    expect(payload.result.structuredContent.evidence).toEqual([
      { text: "Authorized Team fact" }
    ]);
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
