import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import type { MemorySourceRepository } from "@koed-labs/db";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthHelpers } from "../auth/session.js";
import type { RemoteMcpDelegatedPrincipal } from "../auth/remote-mcp-oauth.js";
import type { ApiRouteContext } from "../server/context.js";
import { registerRecallActivityRoutes } from "./recall-activity-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const asOf = "2026-11-10T10:00:00.000Z";
const usage = {
  coverage: "unavailable",
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  totalTokens: null,
  recordedAttempts: 0,
  includesEstimates: false
};
const range = "from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z";

const fixture = async (credential: "token" | "oauth" | "browser") => {
  const user = {
    id: randomUUID(),
    email: "owner@example.test",
    displayName: null
  };
  const question = {
    id: randomUUID(),
    recordedAt: asOf,
    updatedAt: asOf,
    query: "recorded-question",
    usage,
    metadata: null,
    searchDomain: "global",
    status: "answered",
    projectId: null,
    projectName: null,
    sessionId: null
  };
  const getRecallActivityOverview = vi.fn(async () => ({
    asOf,
    timezone: "UTC",
    bucket: "day",
    tokens: usage,
    linkedQuestions: 0,
    tokenTimeline: [],
    recordedQuestions: 1,
    recordedErrors: 0,
    memoryResults: {
      found: 1,
      not_found: 0,
      insufficient: 0,
      pending_summary: 0,
      unknown: 0,
      foundPercentage: 100
    },
    knownDurations: 0,
    medianDurationMs: null,
    questions: []
  }));
  const listRecallActivity = vi.fn(async () => ({
    questions: [question],
    nextCursor: null,
    asOf
  }));
  const getRecallActivity = vi.fn(async (_actor: unknown, id: string) =>
    id === question.id
      ? {
          question,
          answer: "recorded-answer",
          memoryStatus: "found",
          worker: null,
          model: null,
          searchCount: null,
          expandCount: null,
          candidateCount: null,
          failure: null,
          evidence: [],
          citations: [],
          contentTruncated: false,
          usage: {
            ...usage,
            provenance: "unavailable",
            truncated: false,
            ambiguous: false,
            attempts: []
          }
        }
      : null
  );
  const principal: RemoteMcpDelegatedPrincipal = {
    userId: user.id,
    grantId: randomUUID(),
    clientId: "recall-client",
    resource: "https://memory.example.test/mcp",
    scopes: ["koed:memory:read", "koed:team:read", "koed:local-execution"],
    expiresAt: Date.now() + 60_000
  };
  const repository = {
    getUser: vi.fn(async () => user),
    getApiTokenUser: vi.fn(async () => (credential === "token" ? user : null)),
    getSessionUser: vi.fn(async () => user),
    getRecallActivityOverview,
    listRecallActivity,
    getRecallActivity
  } as unknown as MemorySourceRepository;
  const auth = createAuthHelpers(() => repository, {
    hashSecret: (secret) => secret,
    cookieSecure: false,
    resolveDelegatedPrincipal: async () => {
      if (credential !== "oauth") throw new Error("Invalid delegated token");
      return principal;
    }
  });
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  registerRecallActivityRoutes(app, {
    requireRepository: () => repository,
    auth,
    rateLimit: { memoryRead: async () => {} }
  } as unknown as ApiRouteContext);
  const headers =
    credential === "browser"
      ? { cookie: "cm_session=browser-session" }
      : {
          authorization:
            credential === "oauth"
              ? "Bearer koed_mcp_access_recall"
              : "Bearer personal-api-token"
        };
  const get = (url: string) => app.inject({ method: "GET", url, headers });
  return {
    get,
    user,
    question,
    getRecallActivityOverview,
    listRecallActivity,
    getRecallActivity
  };
};

const paths = (questionId: string) => [
  `/v1/memory/recall-activity/overview?${range}&timezone=UTC`,
  `/v1/memory/recall-activity/questions?${range}`,
  `/v1/memory/recall-activity/questions/${questionId}`
];

describe("Recall activity credential boundaries", () => {
  it("serves an owner's Personal API Token without caching", async () => {
    const test = await fixture("token");
    for (const path of paths(test.question.id)) {
      const response = await test.get(path);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const actor = { userId: test.user.id };
    expect(test.getRecallActivityOverview).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ timezone: "UTC" })
    );
    expect(test.listRecallActivity).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ limit: 50 })
    );
    expect(test.getRecallActivity).toHaveBeenCalledWith(
      actor,
      test.question.id
    );
  });

  it.each([
    ["oauth", 403],
    ["browser", 401]
  ] as const)(
    "refuses %s credentials before reading history",
    async (credential, status) => {
      const test = await fixture(credential);
      for (const path of paths(test.question.id)) {
        const response = await test.get(path);
        expect(response.statusCode, response.body).toBe(status);
        expect(response.body).not.toContain("recorded-");
      }
      expect(test.getRecallActivityOverview).not.toHaveBeenCalled();
      expect(test.listRecallActivity).not.toHaveBeenCalled();
      expect(test.getRecallActivity).not.toHaveBeenCalled();
    }
  );

  it("reports a question outside the owner's history as not found", async () => {
    const test = await fixture("token");
    const response = await test.get(
      `/v1/memory/recall-activity/questions/${randomUUID()}`
    );
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("recorded-");
  });
});

describe("Recall activity list parameters", () => {
  it("decodes the cursor and typed query values", async () => {
    const test = await fixture("token");
    const cursor = {
      recordedAt: "2026-11-10T10:00:00.123456Z",
      id: randomUUID()
    };
    const contentIds = [randomUUID(), randomUUID()];
    const response = await test.get(
      `/v1/memory/recall-activity/questions?${range}&limit=10&hydrate=false` +
        `&minDurationMs=5&callerName=&contentIds=${contentIds.join(",")}` +
        `&cursor=${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(test.listRecallActivity).toHaveBeenCalledWith(
      { userId: test.user.id },
      expect.objectContaining({
        cursor,
        contentIds,
        limit: 10,
        hydrate: false,
        minDurationMs: 5,
        callerName: ""
      })
    );
  });

  it.each([
    "not-base64url-json",
    Buffer.from(JSON.stringify({ recordedAt: "yesterday", id: "1" })).toString(
      "base64url"
    ),
    "a".repeat(513)
  ])("rejects an invalid cursor without reading history", async (cursor) => {
    const test = await fixture("token");
    const response = await test.get(
      `/v1/memory/recall-activity/questions?${range}&cursor=${cursor}`
    );
    expect(response.statusCode).toBe(400);
    expect(test.listRecallActivity).not.toHaveBeenCalled();
  });
});
