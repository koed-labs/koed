import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository
} from "@koed/db";
import {
  crossIdentitySyncDeterministicUuid,
  repositoryScopeId,
  type RepositoryIdentity
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { registerGraphRoutes } from "./graph-routes.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("owner repository assignment API", () => {
  const admin = createDbPool({
    connectionString: databaseUrl ?? "postgresql://localhost/postgres"
  });
  const databaseName = `project_assignment_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(databaseUrl ?? "postgresql://localhost/postgres");
  url.pathname = `/${databaseName}`;
  const pool = createDbPool({ connectionString: url.toString() });
  const repo = createMemorySourceRepository(pool);
  const app = Fastify();
  let ownerId: string;
  let otherId: string;
  beforeAll(async () => {
    await admin.query(`create database "${databaseName}"`);
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
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.end();
  });
  it("preserves a legacy logical Memory binding through capture and sharing", async () => {
    const deployment =
      (await repo.getLocalSyncDeployment()) ??
      (await repo.ensureLocalSyncDeployment({
        profile: "local_personal",
        protocolDeploymentId: randomUUID()
      }));
    const externalId = randomUUID();
    // Reproduce a Session and its persisted v1 identity before this upgrade.
    const session = (
      await pool.query<{ id: string }>(
        `insert into sessions (owner_user_id, visibility, source_runtime,
        capture_method, external_session_id, idempotency_key, metadata)
       values ($1,'personal','codex','mcp',$2,$2,'{"threadName":"Legacy capture decision"}') returning id`,
        [ownerId, externalId]
      )
    ).rows[0]!;
    const identityInput = {
      sourceDeploymentId: deployment.protocolDeploymentId,
      sourceUserId: ownerId,
      originSessionId: session.id,
      identity: "logical-memory"
    };
    const legacyId = crossIdentitySyncDeterministicUuid({
      ...identityInput,
      protocol: "koed.captured-session-sync/v1"
    });
    const setup = await pool.connect();
    try {
      await setup.query("begin");
      await setup.query(
        `insert into logical_memories
      (id,protocol_logical_id,owner_user_id,owner_principal_id,
       origin_deployment_identity_id,source_kind,logical_key)
      values ($1,$1,$2,$2,$3,'captured_session',$4)`,
        [legacyId, ownerId, deployment.id, `captured-session:${session.id}`]
      );
      await setup.query(
        `insert into captured_session_logical_memories
      (logical_memory_id,source_session_id,owner_principal_id) values ($1,$2,$3)`,
        [legacyId, session.id, ownerId]
      );
      await setup.query(
        `insert into local_captured_session_logical_memories
      (logical_memory_id,local_session_id,owner_user_id) values ($1,$2,$3)`,
        [legacyId, session.id, ownerId]
      );
      await setup.query("commit");
    } catch (error) {
      await setup.query("rollback");
      throw error;
    } finally {
      setup.release();
    }
    for (const replay of [
      { externalSessionId: externalId },
      { idempotencyKey: externalId }
    ]) {
      await expect(
        repo.createCapturedSession(
          { userId: ownerId },
          {
            sourceRuntime: "codex",
            ...replay
          }
        )
      ).resolves.toMatchObject({ id: session.id });
    }
    const graph = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads"
    });
    expect(graph.statusCode, graph.body).toBe(200);
    const projects = graph.json<{
      projects: Array<{
        threads: Array<{ sessionId: string; logicalMemoryId: string | null }>;
      }>;
    }>().projects;
    expect(
      projects
        .flatMap((project) => project.threads)
        .find((thread) => thread.sessionId === session.id)?.logicalMemoryId
    ).toBe(legacyId);
    const other = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads",
      headers: { "x-fixture-owner": "other" }
    });
    expect(other.body).not.toContain(legacyId);
    const fresh = await repo.createCapturedSession(
      { userId: ownerId },
      { externalSessionId: randomUUID() }
    );
    const bindings = (
      await pool.query<{ local_session_id: string; logical_memory_id: string }>(
        `select local_session_id,logical_memory_id from local_captured_session_logical_memories
       where local_session_id=any($1::uuid[])`,
        [[session.id, fresh.id]]
      )
    ).rows;
    expect(bindings).toHaveLength(2);
    expect(
      bindings.find((binding) => binding.local_session_id === session.id)
        ?.logical_memory_id
    ).toBe(legacyId);
    expect(
      bindings.find((binding) => binding.local_session_id === fresh.id)
        ?.logical_memory_id
    ).toBe(
      crossIdentitySyncDeterministicUuid({
        ...identityInput,
        protocol: "koed.captured-session-sync/v2",
        originSessionId: fresh.id
      })
    );
  });
  it("rejects retired bulk assignment for every owner without routing future capture", async () => {
    const actor = { userId: ownerId };
    const source: RepositoryIdentity = {
      kind: "non_git_project",
      key: `ng_${randomUUID()}`,
      root: "/fixture/fallback",
      branch: null,
      checkoutId: "fallback",
      originatingDeviceId: "device",
      selectedRemote: null,
      anchorDisplay: null,
      reason: "non_git"
    };
    const destination: RepositoryIdentity = {
      kind: "local_project",
      key: `project_${randomUUID()}`,
      root: null,
      branch: null,
      checkoutId: null,
      originatingDeviceId: "device",
      selectedRemote: null,
      anchorDisplay: null,
      reason: "manual"
    };
    const first = await repo.createCapturedSession(actor, {
      repositoryIdentity: source
    });
    await repo.createCapturedSession(actor, { repositoryIdentity: source });
    const payload = {
      sourceProjectId: repositoryScopeId(source),
      project: {
        id: repositoryScopeId(destination),
        name: "Planning",
        path: null,
        repositoryIdentity: destination
      }
    };
    const denied = await app.inject({
      method: "POST",
      url: "/v1/memory/graph/projects/move",
      payload,
      headers: { "x-fixture-owner": "other" }
    });
    expect(denied.statusCode).toBe(410);
    expect(
      (await repo.getCapturedSession(actor, first.id))?.repositoryAssignment
        ?.version
    ).toBe(1);
    const moved = await app.inject({
      method: "POST",
      url: "/v1/memory/graph/projects/move",
      payload
    });
    expect(moved.statusCode, moved.body).toBe(410);
    expect(moved.json()).toMatchObject({
      code: "personal_legacy_write_retired"
    });
    const url = `/v1/memory/graph/projects/resolve?${new URLSearchParams({ projectId: payload.sourceProjectId })}`;
    expect(
      (await app.inject({ method: "GET", url })).json().project
    ).toBeNull();
    expect(
      (
        await app.inject({
          method: "GET",
          url,
          headers: { "x-fixture-owner": "other" }
        })
      ).json()
    ).toEqual({ project: null });
    const later = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      repositoryIdentity: source
    });
    expect(later.repositoryAssignment).toMatchObject({
      automatic: source,
      effective: source
    });
  });
  it("keeps source groups readable while rejecting retired move and reset requests", async () => {
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
    expect(forbidden.statusCode).toBe(410);
    const moved = await app.inject({ method: "PATCH", url, payload: move });
    expect(moved.statusCode, moved.body).toBe(410);
    expect(moved.json()).toMatchObject({
      code: "personal_legacy_write_retired"
    });
    expect(
      (await app.inject({ method: "PATCH", url, payload: move })).statusCode
    ).toBe(410);
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
    const original = projects.find(
      (project) => project.id === repositoryScopeId(a)
    );
    expect(original?.threads[0]?.repositoryAssignment).toMatchObject({
      version: 1,
      effective: a,
      automatic: a
    });
    const reset = await app.inject({
      method: "PATCH",
      url,
      payload: { action: "reset", expectedVersion: 2 }
    });
    expect(reset.statusCode, reset.body).toBe(410);
    expect(
      (await repo.getCapturedSession(actor, session.id))?.repositoryAssignment
    ).toMatchObject({ version: 1, effective: a, override: null });
  });
  it("exposes owner-scoped read-only reviews and rejects every retired application", async () => {
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
    expect(expanded.statusCode).toBe(410);
    const stale = await app.inject({
      method: "POST",
      url,
      payload: { ...action, expectedRevision: event.revision + 1 }
    });
    expect(stale.statusCode).toBe(410);
    const apply = await app.inject({ method: "POST", url, payload: action });
    expect(apply.statusCode, apply.body).toBe(410);
    expect(
      (await repo.getCapturedSession(actor, captured.id))?.repositoryAssignment
        ?.version
    ).toBe(1);
    expect(
      (await repo.getCapturedSession(actor, late.id))?.repositoryAssignment
        ?.version
    ).toBe(1);
    expect(
      (await app.inject({ method: "POST", url, payload: action })).statusCode
    ).toBe(410);
    expect(
      (await repo.getCapturedSession(actor, captured.id))?.repositoryAssignment
        ?.version
    ).toBe(1);
    const other = await app.inject({
      method: "GET",
      url,
      headers: { "x-fixture-owner": "other" }
    });
    expect(other.statusCode).toBe(404);
  });
});
