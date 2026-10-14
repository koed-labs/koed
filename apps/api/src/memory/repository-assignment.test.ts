import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository
} from "@koed/db";
import { repositoryScopeId, type RepositoryIdentity } from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { registerGraphRoutes } from "./graph-routes.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("owner repository assignment API", () => {
  const pool = createDbPool({
    connectionString: databaseUrl ?? "postgresql://localhost/postgres"
  });
  const repo = createMemorySourceRepository(pool);
  const app = Fastify();
  let ownerId: string;
  let otherId: string;
  beforeAll(async () => {
    await runDbMigrations(pool);
    ownerId = (
      await repo.createUser({
        email: `assignment-owner-${randomUUID()}@example.test`
      })
    ).id;
    otherId = (
      await repo.createUser({
        email: `assignment-other-${randomUUID()}@example.test`
      })
    ).id;
    const authenticate = async (request: {
      headers: Record<string, unknown>;
    }) => ({
      id: request.headers["x-fixture-owner"] === "other" ? otherId : ownerId
    });
    registerGraphRoutes(app, {
      requireRepository: () => repo,
      config: { deploymentProfile: "local_personal" },
      auth: {
        authenticate,
        authenticateApiToken: authenticate,
        authenticateSessionOrDeviceCredential: authenticate
      },
      graph: {
        graphCacheTtlSeconds: 60,
        hashCacheKey: (value: string) => value,
        cacheProvider: {
          getJson: async () => null,
          setJson: async () => undefined,
          deleteByPrefix: async () => undefined
        }
      },
      encryption: {},
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      }
    } as unknown as ApiRouteContext);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  it("returns the same effective groups as recall and rejects stale or other-owner moves", async () => {
    const identity = (name: string): RepositoryIdentity => ({
      kind: "portable_repository",
      key: `gr_${name}`,
      root: `/fixture/${name}`,
      branch: "main",
      reason: "origin",
      checkoutId: `checkout_${name}`,
      originatingDeviceId: "fixture_device",
      selectedRemote: "origin",
      anchorDisplay: `example.test/team/${name}`
    });
    const a = identity("a"),
      b = identity("b");
    const actor = { userId: ownerId };
    const session = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      repositoryIdentity: a,
      metadata: { threadName: "Cobalt decision" }
    });
    const url = `/v1/memory/graph/sessions/${session.id}/project`;
    const move = {
      action: "move",
      expectedVersion: 1,
      project: {
        id: repositoryScopeId(b),
        name: "Project B",
        path: b.root,
        repositoryIdentity: b
      }
    };
    const forbidden = await app.inject({
      method: "PATCH",
      url,
      headers: { "x-fixture-owner": "other" },
      payload: move
    });
    expect(forbidden.statusCode).toBe(404);
    const moved = await app.inject({ method: "PATCH", url, payload: move });
    expect(moved.statusCode, moved.body).toBe(200);
    const assignment = (
      moved.json().session as {
        repositoryAssignment: { effective: unknown; version: number };
      }
    ).repositoryAssignment;
    expect(assignment).toMatchObject({ effective: b, version: 2 });
    expect(
      (await app.inject({ method: "PATCH", url, payload: move })).statusCode
    ).toBe(409);
    const graph = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads"
    });
    expect(graph.statusCode, graph.body).toBe(200);
    const projects = (
      graph.json() as {
        projects: Array<{
          id: string;
          threads: Array<{ repositoryAssignment: unknown }>;
        }>;
      }
    ).projects;
    expect(projects[0]?.id).toBe(repositoryScopeId(b));
    expect(projects[0]?.threads[0]?.repositoryAssignment).toMatchObject({
      version: 2,
      effective: b,
      automatic: a
    });
    const reset = await app.inject({
      method: "PATCH",
      url,
      payload: { action: "reset", expectedVersion: 2 }
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(
      (reset.json().session as { repositoryAssignment: unknown })
        .repositoryAssignment
    ).toMatchObject({ version: 3, effective: a, override: null });
  });
  it("exposes owner-scoped fixed reviews, applies once, and rejects later or stale selections", async () => {
    const a: RepositoryIdentity = {
      kind: "portable_repository",
      key: "gr_review_a",
      root: "/fixture/review",
      branch: "main",
      reason: "origin",
      checkoutId: `checkout_${randomUUID()}`,
      originatingDeviceId: "review_device",
      selectedRemote: "origin",
      anchorDisplay: "example/review-a"
    };
    const b = { ...a, key: "gr_review_b", anchorDisplay: "example/review-b" };
    const actor = { userId: ownerId };
    const captured = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      repositoryIdentity: a
    });
    const record = await app.inject({
      method: "POST",
      url: "/v1/memory/repository-changes",
      payload: {
        id: randomUUID(),
        kind: "anchor_change",
        originatingDeviceId: a.originatingDeviceId,
        checkoutId: a.checkoutId,
        originatingRevision: 1,
        previousIdentity: a,
        targetIdentity: b
      }
    });
    expect(record.statusCode, record.body).toBe(200);
    const event = record.json().event as { id: string; revision: number };
    const denied = await app.inject({
      method: "POST",
      url: `/v1/memory/repository-changes/${event.id}/reviews`,
      headers: { "x-fixture-owner": "other" },
      payload: { includeOverrides: false, includeUnresolved: false }
    });
    expect(denied.statusCode).toBe(404);
    const preview = await app.inject({
      method: "POST",
      url: `/v1/memory/repository-changes/${event.id}/reviews`,
      payload: { includeOverrides: false, includeUnresolved: false }
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const review = preview.json().review as {
      id: string;
      count: number;
      sessions: Array<{ id: string; assignment: { version: number } }>;
    };
    expect(review.count).toBe(1);
    expect(review.sessions[0]?.assignment.version).toBe(1);
    const late = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      repositoryIdentity: a
    });
    const action = {
      action: "apply",
      expectedRevision: event.revision,
      sessionIds: [captured.id]
    };
    const url = `/v1/memory/repository-reviews/${review.id}`;
    const expanded = await app.inject({
      method: "POST",
      url,
      payload: { ...action, sessionIds: [captured.id, late.id] }
    });
    expect(expanded.statusCode).toBe(400);
    const stale = await app.inject({
      method: "POST",
      url,
      payload: { ...action, expectedRevision: event.revision + 1 }
    });
    expect(stale.statusCode).toBe(409);
    const apply = await app.inject({ method: "POST", url, payload: action });
    expect(apply.statusCode, apply.body).toBe(200);
    expect(
      (await repo.getCapturedSession(actor, captured.id))?.repositoryAssignment
        ?.version
    ).toBe(2);
    expect(
      (await repo.getCapturedSession(actor, late.id))?.repositoryAssignment
        ?.version
    ).toBe(1);
    expect(
      (await app.inject({ method: "POST", url, payload: action })).statusCode
    ).toBe(200);
    expect(
      (await repo.getCapturedSession(actor, captured.id))?.repositoryAssignment
        ?.version
    ).toBe(2);
    const other = await app.inject({
      method: "GET",
      url,
      headers: { "x-fixture-owner": "other" }
    });
    expect(other.statusCode).toBe(404);
  });
});
