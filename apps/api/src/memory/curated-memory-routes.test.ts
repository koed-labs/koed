import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteDesktopLocalCredential,
  storeDesktopLocalCredential
} from "@koed/shared";
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
    return reply
      .status(
        error instanceof Error &&
          "statusCode" in error &&
          typeof error.statusCode === "number"
          ? error.statusCode
          : 500
      )
      .send({
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

  it("binds Desktop assertion reads and writes to the on-disk local owner credential", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-curated-desktop-"));
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: ownerId,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const { app, repo, context } = setup();
    Object.assign(context, {
      config: { deploymentProfile: "local_personal", koedHome: home }
    });
    apps.push(app);
    try {
      const auth = { authorization: credential.authorization };
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/memory/curated/assertions?scope=unscoped",
            headers: auth
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/memory/curated/assertions",
            headers: auth,
            remoteAddress: "192.0.2.1"
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/memory/curated/assertions",
            headers: { authorization: "Koed-Desktop wrong-secret" }
          })
        ).statusCode
      ).toBe(401);
      expect(repo.listCuratedMemoryAssertions).toHaveBeenCalledWith(
        { userId: ownerId },
        expect.objectContaining({ scope: "unscoped" })
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/memory/curated/assertions/${assertionId}/unsuppress`,
            headers: auth,
            payload: { suppression_token: "1792490400123456" }
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/v1/memory/curated/assertions/${assertionId}`,
            headers: auth,
            payload: { scope: "me", expected_version: 1 }
          })
        ).statusCode
      ).toBe(200);
      const old = credential.authorization;
      deleteDesktopLocalCredential(home);
      storeDesktopLocalCredential(home, {
        ownerUserId: ownerId,
        operationFamilies: ["personal_collaboration_read"]
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/memory/curated/assertions",
            headers: { authorization: old }
          })
        ).statusCode
      ).toBe(401);
      deleteDesktopLocalCredential(home);
      const readOnly = storeDesktopLocalCredential(home, {
        ownerUserId: ownerId,
        operationFamilies: ["personal_collaboration_read"]
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/memory/curated/assertions/${assertionId}/unsuppress`,
            headers: { authorization: readOnly.authorization },
            payload: { suppression_token: "1792490400123456" }
          })
        ).statusCode
      ).toBe(401);
      Object.assign(context, {
        config: { deploymentProfile: "team_self_hosted", koedHome: home }
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/memory/curated/assertions",
            headers: { authorization: readOnly.authorization }
          })
        ).statusCode
      ).toBe(403);
      vi.mocked(context.auth.authenticateSession).mockRejectedValueOnce(
        Object.assign(new Error("Session cookie required"), { statusCode: 401 })
      );
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/v1/memory/curated/assertions/${assertionId}`,
            headers: { authorization: "Bearer personal-token" },
            payload: { scope: "me", expected_version: 1 }
          })
        ).statusCode
      ).toBe(401);
      vi.mocked(context.auth.authenticateSession).mockRejectedValueOnce(
        Object.assign(new Error("Session cookie required"), { statusCode: 401 })
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/memory/curated/assertions/${assertionId}/unsuppress`,
            headers: { authorization: "Bearer personal-token" },
            payload: { suppression_token: "1792490400123456" }
          })
        ).statusCode
      ).toBe(401);
      expect(context.auth.authenticateSession).toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
  it("returns an owner-scoped keyset cursor only when another row exists", async () => {
    const first = {
      ...baseAssertion,
      id: randomUUID(),
      updatedAt: "2026-10-20T10:00:00.000Z"
    };
    const second = {
      ...baseAssertion,
      id: randomUUID(),
      updatedAt: "2026-10-20T09:00:00.000Z"
    };
    const third = {
      ...baseAssertion,
      id: randomUUID(),
      updatedAt: "2026-10-20T08:00:00.000Z"
    };
    const { app, repo } = setup({
      listCuratedMemoryAssertions: vi.fn(async () => [first, second, third])
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/v1/memory/curated/assertions?scope=unscoped&limit=2"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().assertions).toHaveLength(2);
    expect(response.json().next_cursor).toEqual({
      updated_at: second.updatedAt,
      id: second.id
    });
    expect(repo.listCuratedMemoryAssertions).toHaveBeenCalledWith(
      { userId: ownerId },
      expect.objectContaining({ scope: "unscoped", limit: 3 })
    );
    const next = await app.inject({
      method: "GET",
      url: `/v1/memory/curated/assertions?scope=unscoped&limit=2&before_updated_at=${encodeURIComponent(second.updatedAt)}&before_id=${second.id}`
    });
    expect(next.statusCode).toBe(200);
    expect(repo.listCuratedMemoryAssertions).toHaveBeenCalledWith(
      { userId: ownerId },
      expect.objectContaining({
        beforeUpdatedAt: second.updatedAt,
        beforeId: second.id
      })
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/memory/curated/assertions?before_id=" + second.id
        })
      ).statusCode
    ).toBe(400);
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
