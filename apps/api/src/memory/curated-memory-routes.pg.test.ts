import { randomUUID } from "node:crypto";
import type pg from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCuratedMemoryRepository,
  createDbPool,
  runDbMigrations
} from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { registerCuratedMemoryRoutes } from "./curated-memory-routes.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Curated assertion HTTP with PostgreSQL", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  const app = Fastify();
  const ownerId = randomUUID();
  const assertionId = randomUUID();
  const projectId = randomUUID();
  const workItemId = randomUUID();

  beforeAll(async () => {
    databaseName = `hq303_http_${randomUUID().replaceAll("-", "")}`;
    admin = createDbPool({ connectionString: databaseUrl! });
    await admin.query(`create database "${databaseName}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = createDbPool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values($1,$2)", [
      ownerId,
      `${ownerId}@example.test`
    ]);
    await pool.query(
      "insert into projects(id,owner_user_id,name,key) values($1,$2,'Panel project',$3)",
      [projectId, ownerId, `P-${randomUUID()}`]
    );
    await pool.query(
      `insert into project_work_items (
         id,owner_user_id,project_id,kind,title,goal,origin,
         creation_payload_hash,created_by
       ) values ($1,$2,$3,'todo','Evidence','Direct source','manual',$4,$2)`,
      [workItemId, ownerId, projectId, "a".repeat(64)]
    );
    await pool.query(
      `insert into curated_memory_assertions (
         id,owner_user_id,visibility,assertion_text,normalized_assertion,
         status,scope,kind
       ) values ($1,$2,'personal','Remember the decision',
         'remember the decision','current','unscoped','decision')`,
      [assertionId, ownerId]
    );
    await pool.query(
      `insert into curated_memory_sources (
         assertion_id,source_type,source_role,project_work_item_id,metadata
       ) values ($1,'project_work_item','primary_evidence',$2,'{}')`,
      [assertionId, workItemId]
    );
    const repo = createCuratedMemoryRepository(pool);
    const user = { id: ownerId };
    const session = async (request: { headers: Record<string, unknown> }) => {
      if (request.headers.cookie !== "hq303_session=owner")
        throw Object.assign(new Error("Session cookie required"), {
          statusCode: 401
        });
      return user;
    };
    const context = {
      requireRepository: () => repo,
      auth: {
        authenticate: async () => user,
        authenticateApiToken: async () => user,
        authenticateSession: session
      },
      rateLimit: {
        memoryRead: async () => {},
        memoryWrite: async () => {},
        memoryRecall: async () => {}
      }
    } as unknown as ApiRouteContext;
    registerCuratedMemoryRoutes(app, context, null);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await pool?.end();
    if (admin && databaseName) {
      await admin.query(
        `drop database if exists "${databaseName}" with (force)`
      );
      await admin.end();
    }
  });

  it("round-trips the exact Undo token and commits a classified assertion", async () => {
    const listUrl = "/v1/memory/curated/assertions";
    const itemUrl = `${listUrl}/${assertionId}`;
    const initial = await app.inject({
      method: "GET",
      url: `${listUrl}?scope=unscoped&status=current`
    });
    expect(initial.statusCode).toBe(200);
    expect(
      initial.json().assertions.map((item: { id: string }) => item.id)
    ).toEqual([assertionId]);

    const suppressed = await app.inject({
      method: "POST",
      url: `${itemUrl}/suppress`,
      payload: { reason: "Panel Forget" }
    });
    expect(suppressed.statusCode).toBe(200);
    const token = suppressed.json().assertion.suppressionToken as string;
    expect(token).toMatch(/^\d+$/);
    const suppressedDetail = await app.inject({ method: "GET", url: itemUrl });
    expect(suppressedDetail.json().assertion.suppressionToken).toBe(token);
    const tokenAttempt = await app.inject({
      method: "POST",
      url: `${itemUrl}/unsuppress`,
      headers: { authorization: "Bearer personal-token" },
      payload: { suppression_token: token }
    });
    expect(tokenAttempt.statusCode).toBe(401);
    const restored = await app.inject({
      method: "POST",
      url: `${itemUrl}/unsuppress`,
      headers: { cookie: "hq303_session=owner" },
      payload: { suppression_token: token }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().assertion.status).toBe("current");

    const classified = await app.inject({
      method: "PATCH",
      url: itemUrl,
      headers: { cookie: "hq303_session=owner" },
      payload: {
        scope: "project",
        project_id: projectId,
        expected_version: 1
      }
    });
    expect(classified.statusCode).toBe(200);
    expect(classified.json().operation.state).toBe("complete");
    expect(classified.json().assertion).toMatchObject({
      scope: "project",
      projectId,
      classificationVersion: 2
    });
    const projectList = await app.inject({
      method: "GET",
      url: `${listUrl}?scope=project&project_id=${projectId}&status=current`
    });
    expect(
      projectList.json().assertions.map((item: { id: string }) => item.id)
    ).toEqual([assertionId]);
    const detail = await app.inject({ method: "GET", url: itemUrl });
    expect(detail.json().assertion).toMatchObject({
      id: assertionId,
      scope: "project",
      projectId
    });
    const stale = await app.inject({
      method: "PATCH",
      url: itemUrl,
      headers: { cookie: "hq303_session=owner" },
      payload: { scope: "me", expected_version: 1 }
    });
    expect(stale.statusCode).toBe(409);
    const moved = await app.inject({
      method: "PATCH",
      url: itemUrl,
      headers: { cookie: "hq303_session=owner" },
      payload: { scope: "me", expected_version: 2 }
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().assertion).toMatchObject({
      scope: "me",
      projectId: null,
      classificationVersion: 3
    });
    const oldProject = await app.inject({
      method: "GET",
      url: `${listUrl}?scope=project&project_id=${projectId}&status=current`
    });
    expect(oldProject.json().assertions).toEqual([]);
  });
});
