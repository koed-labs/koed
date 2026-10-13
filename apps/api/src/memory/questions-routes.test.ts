import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import {
  SharedMemoryAuthorizationError,
  type MemoryQuestionActorContext,
  type MemorySourceRepository
} from "@koed/db";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthHelpers } from "../auth/session.js";
import type { RemoteMcpDelegatedPrincipal } from "../auth/remote-mcp-oauth.js";
import type { ApiRouteContext } from "../server/context.js";
import { registerQuestionRoutes } from "./questions-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const fixture = async (
  credential: "token" | "oauth" | "browser",
  scopes: string[] = [],
  teamCollaborationEnabled = true
) => {
  const user = {
    id: randomUUID(),
    email: "owner@example.test",
    displayName: null
  };
  const personal = { id: randomUUID(), query: "Personal history" };
  const legacyTeam = {
    id: randomUUID(),
    query: "Retained legacy Team history"
  };
  const protectedTeam = {
    id: randomUUID(),
    query: "protected-query",
    answerMarkdown: "protected-answer",
    evidence: ["protected-evidence"],
    errorMessage: "protected-error"
  };
  const expandTeam = vi.fn(() => protectedTeam);
  let membershipActive = true;
  const mayExpand = (actor: MemoryQuestionActorContext) =>
    actor.allowTeam && membershipActive;
  const listMemoryQuestions = vi.fn(
    async (actor: MemoryQuestionActorContext) => [
      personal,
      legacyTeam,
      ...(mayExpand(actor) ? [expandTeam()] : [])
    ]
  );
  const getMemoryQuestion = vi.fn(
    async (actor: MemoryQuestionActorContext, id: string) => {
      if (id === personal.id) return personal;
      if (id === legacyTeam.id) return legacyTeam;
      if (id !== protectedTeam.id) return null;
      if (!mayExpand(actor)) throw new SharedMemoryAuthorizationError();
      return expandTeam();
    }
  );
  const principal: RemoteMcpDelegatedPrincipal = {
    userId: user.id,
    grantId: randomUUID(),
    clientId: "history-client",
    resource: "https://memory.example.test/mcp",
    scopes,
    expiresAt: Date.now() + 60_000
  };
  const resolveDelegatedPrincipal = vi.fn(async () => {
    if (credential !== "oauth") throw new Error("Invalid delegated token");
    return principal;
  });
  const getDeviceCredentialUser = vi.fn();
  const repository = {
    getUser: vi.fn(async () => user),
    getApiTokenUser: vi.fn(async () => (credential === "token" ? user : null)),
    getSessionUser: vi.fn(async () => user),
    getDeviceCredentialUser,
    listMemoryQuestions,
    getMemoryQuestion
  } as unknown as MemorySourceRepository;
  const auth = createAuthHelpers(() => repository, {
    hashSecret: (secret) => secret,
    cookieSecure: false,
    resolveDelegatedPrincipal
  });
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  registerQuestionRoutes(app, {
    requireRepository: () => repository,
    auth,
    config: { teamCollaborationEnabled },
    rateLimit: { memoryRead: async () => {}, memoryWrite: async () => {} }
  } as unknown as ApiRouteContext);
  const headers =
    credential === "browser"
      ? { cookie: "cm_session=browser-session" }
      : {
          authorization:
            credential === "oauth"
              ? "Bearer koed_mcp_access_history"
              : "Bearer personal-api-token"
        };
  return {
    app,
    headers,
    user,
    personal,
    legacyTeam,
    protectedTeam,
    expandTeam,
    listMemoryQuestions,
    getMemoryQuestion,
    resolveDelegatedPrincipal,
    getDeviceCredentialUser,
    revokeMembership: () => {
      membershipActive = false;
    }
  };
};

const expectProtectedAbsent = (body: string) => {
  for (const text of [
    "protected-query",
    "protected-answer",
    "protected-evidence",
    "protected-error"
  ]) {
    expect(body).not.toContain(text);
  }
};

describe("Memory Question history credential boundaries", () => {
  it.each(["Basic unrelated", "Bearer stale-personal-token"])(
    "uses a successful browser session despite an unrelated %s header",
    async (authorization) => {
      const test = await fixture("browser");
      const headers = { ...test.headers, authorization };
      const listed = await test.app.inject({
        method: "GET",
        url: "/v1/memory/questions",
        headers
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().questions).toContainEqual(test.protectedTeam);
      const detail = await test.app.inject({
        method: "GET",
        url: `/v1/memory/questions/${test.protectedTeam.id}`,
        headers
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().question).toEqual(test.protectedTeam);
    }
  );

  it.each(["oauth", "browser"] as const)(
    "does not expand protected Team history for %s when Team collaboration is disabled",
    async (credential) => {
      const test = await fixture(
        credential,
        ["koed:memory:read", "koed:team:read"],
        false
      );
      const listed = await test.app.inject({
        method: "GET",
        url: "/v1/memory/questions",
        headers: test.headers
      });
      expect(listed.statusCode).toBe(200);
      expectProtectedAbsent(listed.body);
      const detail = await test.app.inject({
        method: "GET",
        url: `/v1/memory/questions/${test.protectedTeam.id}`,
        headers: test.headers
      });
      expect(detail.statusCode).toBe(403);
      expectProtectedAbsent(detail.body);
      expect(test.expandTeam).not.toHaveBeenCalled();
    }
  );
  it("keeps Personal API Tokens on Personal and legacy history despite query-supplied Team permission", async () => {
    const test = await fixture("token");
    const listed = await test.app.inject({
      method: "GET",
      url: "/v1/memory/questions?allowTeam=true",
      headers: { ...test.headers, cookie: "cm_session=browser-session" }
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json().questions.map((question: { id: string }) => question.id)
    ).toEqual([test.personal.id, test.legacyTeam.id]);
    expect(test.listMemoryQuestions.mock.calls[0]![0]).toEqual({
      userId: test.user.id,
      allowTeam: false
    });
    expectProtectedAbsent(listed.body);
    const detail = await test.app.inject({
      method: "GET",
      url: `/v1/memory/questions/${test.protectedTeam.id}`,
      headers: test.headers
    });
    expect(detail.statusCode).toBe(403);
    expectProtectedAbsent(detail.body);
    expect(test.expandTeam).not.toHaveBeenCalled();
  });

  it("requires separate delegated Team scope for Team task history", async () => {
    const test = await fixture("oauth", ["koed:memory:read"]);
    const listed = await test.app.inject({
      method: "GET",
      url: "/v1/memory/questions?query=protected",
      headers: test.headers
    });
    expect(listed.statusCode).toBe(200);
    expectProtectedAbsent(listed.body);
    const detail = await test.app.inject({
      method: "GET",
      url: `/v1/memory/questions/${test.protectedTeam.id}`,
      headers: test.headers
    });
    expect(detail.statusCode).toBe(403);
    expectProtectedAbsent(detail.body);
    expect(test.expandTeam).not.toHaveBeenCalled();
  });

  it.each(["oauth", "browser"] as const)(
    "allows %s authorized Team history while leaving current membership checks to the repository",
    async (credential) => {
      const test = await fixture(credential, [
        "koed:memory:read",
        "koed:team:read"
      ]);
      const detail = await test.app.inject({
        method: "GET",
        url: `/v1/memory/questions/${test.protectedTeam.id}`,
        headers: test.headers
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().question).toEqual(test.protectedTeam);
      expect(test.getMemoryQuestion.mock.calls[0]![0]).toEqual({
        userId: test.user.id,
        allowTeam: true
      });
      test.revokeMembership();
      const denied = await test.app.inject({
        method: "GET",
        url: `/v1/memory/questions/${test.protectedTeam.id}`,
        headers: test.headers
      });
      expect(denied.statusCode).toBe(403);
      expectProtectedAbsent(denied.body);
      expect(test.expandTeam).toHaveBeenCalledTimes(1);
    }
  );

  it("refreshes delegated consent before history access and does not fall back to a browser session after revocation", async () => {
    const test = await fixture("oauth", ["koed:memory:read", "koed:team:read"]);
    // Authentication succeeds once, but the history-specific fresh lookup fails.
    test.resolveDelegatedPrincipal.mockResolvedValueOnce({
      userId: test.user.id,
      grantId: randomUUID(),
      clientId: "history-client",
      resource: "https://memory.example.test/mcp",
      scopes: ["koed:memory:read", "koed:team:read"],
      expiresAt: Date.now() + 60_000
    });
    test.resolveDelegatedPrincipal.mockRejectedValueOnce(new Error("revoked"));
    const denied = await test.app.inject({
      method: "GET",
      url: `/v1/memory/questions/${test.protectedTeam.id}`,
      headers: { ...test.headers, cookie: "cm_session=browser-session" }
    });
    expect(denied.statusCode).toBe(401);
    expectProtectedAbsent(denied.body);
    expect(test.resolveDelegatedPrincipal).toHaveBeenCalledTimes(2);
    expect(test.getMemoryQuestion).not.toHaveBeenCalled();
  });

  it("uses the refreshed delegated scopes when Team consent is removed", async () => {
    const test = await fixture("oauth", ["koed:memory:read", "koed:team:read"]);
    const principal = {
      userId: test.user.id,
      grantId: randomUUID(),
      clientId: "history-client",
      resource: "https://memory.example.test/mcp",
      scopes: ["koed:memory:read", "koed:team:read"],
      expiresAt: Date.now() + 60_000
    };
    test.resolveDelegatedPrincipal
      .mockResolvedValueOnce(principal)
      .mockResolvedValueOnce({ ...principal, scopes: ["koed:memory:read"] });
    const listed = await test.app.inject({
      method: "GET",
      url: "/v1/memory/questions",
      headers: test.headers
    });
    expect(listed.statusCode).toBe(200);
    expect(test.listMemoryQuestions.mock.calls[0]![0]).toEqual({
      userId: test.user.id,
      allowTeam: false
    });
    expectProtectedAbsent(listed.body);
    expect(test.expandTeam).not.toHaveBeenCalled();
  });

  it("does not admit device credentials on generic history routes", async () => {
    const test = await fixture("oauth", ["koed:memory:read", "koed:team:read"]);
    const denied = await test.app.inject({
      method: "GET",
      url: `/v1/memory/questions/${test.protectedTeam.id}`,
      headers: { authorization: "Koed-Device credential:secret" }
    });
    expect(denied.statusCode).toBe(401);
    expectProtectedAbsent(denied.body);
    expect(test.getDeviceCredentialUser).not.toHaveBeenCalled();
    expect(test.getMemoryQuestion).not.toHaveBeenCalled();
  });
});
