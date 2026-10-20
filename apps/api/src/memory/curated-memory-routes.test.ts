import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import type { CuratedClassificationCoordinator } from "./curated-classification-coordinator.js";
import { registerCuratedMemoryRoutes } from "./curated-memory-routes.js";

const ownerId = randomUUID();
const assertionId = randomUUID();
const projectId = randomUUID();
const baseAssertion = {
  id: assertionId,
  scope: "unscoped",
  classificationVersion: 1,
  assertionText: "Current claim"
};

const setup = (
  overrides: Record<string, unknown> = {},
  advance?: CuratedClassificationCoordinator["advance"]
) => {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.status(400).send({ error: "Invalid request" });
    return reply.status(500).send({
      error: error instanceof Error ? error.message : "Unexpected error"
    });
  });
  const repo = {
    listCuratedMemoryAssertions: vi.fn(async () => [baseAssertion]),
    getCuratedMemoryReplacementChain: vi.fn(async () => [
      {
        id: randomUUID(),
        assertionText: "Prior claim",
        authorKind: "user",
        authorRef: ownerId,
        createdAt: "2026-10-19T00:00:00.000Z"
      }
    ]),
    getCuratedMemoryAssertion: vi.fn(async () => baseAssertion),
    unsuppressCuratedMemoryAssertion: vi.fn(async () => baseAssertion),
    prepareCuratedClassification: vi.fn(async () => ({
      id: randomUUID(),
      assertionId,
      ownerUserId: ownerId,
      expectedVersion: 1,
      nextVersion: 2,
      scope: "project",
      projectId,
      manifest: [],
      backendAcks: [],
      state: "pending"
    })),
    commitCuratedClassification: vi.fn(async (actor: unknown, id: string) => ({
      id,
      assertionId,
      ownerUserId: ownerId,
      expectedVersion: 1,
      nextVersion: 2,
      scope: "project",
      projectId,
      manifest: [],
      backendAcks: [],
      state: "complete"
    })),
    ...overrides
  };
  const user = { id: ownerId };
  const context = {
    requireRepository: () => repo,
    auth: {
      authenticate: vi.fn(async () => user),
      authenticateApiToken: vi.fn(async () => user),
      authenticateSession: vi.fn(async () => user)
    },
    rateLimit: {
      memoryRead: async () => {},
      memoryWrite: async () => {},
      memoryRecall: async () => {}
    }
  } as unknown as ApiRouteContext;
  registerCuratedMemoryRoutes(
    app,
    context,
    advance ? { advance, runPending: async () => {} } : null
  );
  return { app, repo, context };
};

describe("Curated assertion routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("passes exact panel filters and returns owner-scoped replacement history", async () => {
    const { app, repo } = setup();
    apps.push(app);
    const since = "2026-10-20T00:00:00+02:00";
    const response = await app.inject({
      method: "GET",
      url: `/v1/memory/curated/assertions?scope=project&project_id=${projectId}&kind=decision&status=current&since=${encodeURIComponent(since)}`
    });
    expect(response.statusCode).toBe(200);
    expect(repo.listCuratedMemoryAssertions).toHaveBeenCalledWith(
      { userId: ownerId },
      expect.objectContaining({
        projectId,
        scope: "project",
        kind: "decision",
        status: "current",
        since
      })
    );
    expect(response.json().assertions[0].replaces).toMatchObject([
      {
        text: "Prior claim",
        author: { kind: "user", ref: ownerId }
      }
    ]);
    const detail = await app.inject({
      method: "GET",
      url: `/v1/memory/curated/assertions/${assertionId}`
    });
    expect(detail.json().assertion.replaces[0].text).toBe("Prior claim");
  });

  it("requires a suppression token and delegates Undo under session identity", async () => {
    const { app, repo, context } = setup();
    apps.push(app);
    const invalid = await app.inject({
      method: "POST",
      url: `/v1/memory/curated/assertions/${assertionId}/unsuppress`,
      payload: {}
    });
    expect(invalid.statusCode).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: `/v1/memory/curated/assertions/${assertionId}/unsuppress`,
      payload: { suppression_token: "1792490400123456" }
    });
    expect(response.statusCode).toBe(200);
    expect(context.auth.authenticateSession).toHaveBeenCalled();
    expect(repo.unsuppressCuratedMemoryAssertion).toHaveBeenCalledWith(
      { userId: ownerId },
      assertionId,
      { suppressionToken: "1792490400123456" }
    );
  });

  it("returns a retryable operation while Team withdrawal is unavailable", async () => {
    const { app, repo } = setup({}, async () => {
      throw new Error("backend offline");
    });
    apps.push(app);
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/memory/curated/assertions/${assertionId}`,
      payload: { scope: "project", project_id: projectId, expected_version: 1 }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().operation.state).toBe("pending");
    expect(repo.prepareCuratedClassification).toHaveBeenCalledWith(
      { userId: ownerId },
      {
        assertionId,
        expectedVersion: 1,
        scope: "project",
        projectId
      }
    );
    expect(repo.commitCuratedClassification).not.toHaveBeenCalled();
  });
});
