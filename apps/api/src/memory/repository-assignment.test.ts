import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { ZodError } from "zod";
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
    app.setErrorHandler((error, _request, reply) => {
      const statusCode =
        error instanceof ZodError
          ? 400
          : ((error as { statusCode?: number }).statusCode ?? 500);
      return reply
        .status(statusCode)
        .send({
          error: error instanceof Error ? error.message : "Request failed"
        });
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
  it("pages source inventory by stable identity past 500 Conversations without changing organization", async () => {
    const actor = { userId: ownerId };
    const identity: RepositoryIdentity = {
      kind: "portable_repository",
      key: "gr_inventory_paging",
      root: "/recorded",
      branch: "main",
      checkoutId: "checkout_inventory",
      originatingDeviceId: "inventory_device",
      selectedRemote: "origin",
      anchorDisplay: "example.test/inventory",
      reason: "origin"
    };
    const late = { ...identity, key: "gr_inventory_z" };
    await pool.query(
      `insert into sessions(owner_user_id,source_runtime,capture_method,external_session_id,metadata,repository_assignment_state,repository_automatic_identity)
      select $1,'codex','transcript','shared-provider-id',jsonb_build_object('threadName','Inventory ' || n::text),'recorded',case when n=601 then $3::jsonb else $2::jsonb end
      from generate_series(1,601) n`,
      [ownerId, JSON.stringify(identity), JSON.stringify(late)]
    );
    const before = await repo.listNamedPersonalProjects(actor);
    const seen = new Set<string>();
    let after:
      | { projectId: string; threadId: string; sessionId: string }
      | undefined;
    for (;;) {
      const groups = await repo.listLcmGraphThreads(actor, {
        inventoryOrder: true,
        inventoryAfter: after,
        groupBySession: true,
        limit: 100
      });
      const rows = groups.flatMap((group) => group.threads);
      if (!rows.length) break;
      for (const thread of rows) {
        expect(seen.has(thread.sessionId!)).toBe(false);
        seen.add(thread.sessionId!);
      }
      // Activity changes do not move an already enumerated row across the cursor.
      await pool.query(
        "update sessions set created_at=now()+interval '1 day' where id=$1",
        [rows[0]!.sessionId]
      );
      // The repository groups output by source, preserving each ordered page.
      const last = rows.at(-1)!;
      after = {
        projectId: last.projectId,
        threadId: last.id,
        sessionId: last.sessionId ?? ""
      };
    }
    expect(seen.size).toBe(601);
    expect(after?.projectId).toBe(repositoryScopeId(late));
    expect(await repo.listNamedPersonalProjects(actor)).toEqual(before);
    expect(
      (
        await repo.listLcmGraphThreads(
          { userId: otherId },
          { inventoryOrder: true, groupBySession: true, limit: 100 }
        )
      ).flatMap((group) => group.threads)
    ).toEqual([]);
    await pool.query(
      "delete from sessions where owner_user_id=$1 and repository_automatic_identity->>'key'=any($2::text[])",
      [ownerId, [identity.key, late.key]]
    );
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
  it("does not expose retired source move or routing endpoints", async () => {
    for (const request of [
      { method: "POST" as const, url: "/v1/memory/graph/projects/move" },
      {
        method: "GET" as const,
        url: "/v1/memory/graph/projects/resolve?projectId=unassigned"
      },
      {
        method: "PATCH" as const,
        url: `/v1/memory/graph/sessions/${randomUUID()}/project`
      }
    ])
      expect((await app.inject(request)).statusCode).toBe(404);
  });
  it("exposes owner-scoped read-only reviews with fenced dismissal", async () => {
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
    const url = `/v1/memory/repository-reviews/${review.id}`;
    const rejected = await app.inject({
      method: "POST",
      url,
      payload: {
        action: "apply",
        expectedRevision: event.revision,
        sessionIds: [captured.id]
      }
    });
    expect(rejected.statusCode).toBe(400);
    const stale = await app.inject({
      method: "POST",
      url,
      payload: { action: "dismiss", expectedRevision: event.revision + 1 }
    });
    expect(stale.statusCode).toBe(409);
    const dismissed = await app.inject({
      method: "POST",
      url,
      payload: { action: "dismiss", expectedRevision: event.revision }
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(dismissed.json().review.status).toBe("dismissed");
    for (const session of [captured, late])
      expect(
        (await repo.getCapturedSession(actor, session.id))?.repositoryAssignment
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
