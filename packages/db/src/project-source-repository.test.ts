import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import {
  createProjectApiRepository,
  ProjectCapabilityError,
  ProjectConflictError,
  ProjectNotFoundError
} from "./project-api-repository.js";
import { createProjectSourceRepository } from "./project-source-repository.js";
import { createProjectActivityRepository } from "./project-activity-repository.js";

const testUrl = process.env.KOED_HQ205_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
describe.skipIf(!testUrl)("owner-scoped Project Sources", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  const owner = randomUUID();
  const other = randomUUID();
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq205_source_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query(`insert into users(id,email) values($1,$2),($3,$4)`, [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
    await pool.query(
      `insert into deployment_identities(protocol_deployment_id,locality,profile) values($1,'local','developer')`,
      [randomUUID()]
    );
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database ${quote(database)}`);
    await admin?.end();
  });

  it("lists references by owner, keeps documents unavailable, and counts trusted turn use once", async () => {
    const projects = createProjectApiRepository(pool);
    const sources = createProjectSourceRepository(pool);
    const project = await projects.create(owner, {
      name: "Atlas",
      idempotencyKey: "source-one"
    });
    const folder = await sources.create(owner, project.id, {
      kind: "folder",
      name: "Atlas",
      uri: "/atlas"
    });
    const skill = await sources.create(owner, project.id, {
      kind: "skill",
      name: "review"
    });
    const activity = createProjectActivityRepository(pool);
    const history = await activity.list(owner, project.id);
    expect(
      history.items
        .filter((item) => item.kind === "source_added")
        .map((item) => item.ref)
    ).toEqual([folder.id, skill.id]);
    const added = history.items.filter((item) => item.kind === "source_added");
    expect(new Set(added.map((item) => item.cursor)).size).toBe(2);
    expect(
      (await activity.acknowledge(owner, project.id, added[1]!.cursor)).cursor
    ).toBe(added[1]!.cursor);
    expect((await activity.seen(owner, project.id)).cursor).toBe(
      added[1]!.cursor
    );
    expect(
      (await sources.list(owner, project.id)).map((item) => item.id)
    ).toEqual([skill.id, folder.id]);
    await expect(sources.list(other, project.id)).rejects.toBeInstanceOf(
      ProjectNotFoundError
    );
    await expect(
      sources.create(owner, project.id, { kind: "doc", name: "Plan.md" })
    ).rejects.toBeInstanceOf(ProjectCapabilityError);
    expect((await sources.list(owner, project.id)).length).toBe(2);
    expect((await projects.hq(owner, project.id)).sections.sources).toEqual({
      availability: "available",
      count: 2
    });
    const sessionId = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,automatic_personal_project_id)
      values($1,$2,'codex-cli','api',$3)`,
      [sessionId, owner, project.id]
    );
    const use = {
      ownerUserId: owner,
      projectId: project.id,
      sourceId: folder.id,
      capturedSessionId: sessionId,
      turnId: "turn-1",
      provenance: "tool_read" as const
    };
    expect(await sources.recordTrustedUse(use)).toBe(true);
    expect(await sources.recordTrustedUse(use)).toBe(false);
    expect(
      (await sources.list(owner, project.id)).find(
        (item) => item.id === folder.id
      )?.uses
    ).toBe(1);
    await expect(
      sources.recordTrustedUse({ ...use, ownerUserId: other })
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await sources.remove(owner, project.id, skill.id);
    expect(
      (await sources.list(owner, project.id)).map((item) => item.id)
    ).toEqual([folder.id]);
  });

  it("deletes only active references in its exact batch and Undo preserves prior trash", async () => {
    const projects = createProjectApiRepository(pool);
    const sources = createProjectSourceRepository(pool);
    const project = await projects.create(owner, {
      name: "Cleanup",
      idempotencyKey: "source-delete"
    });
    const active = await sources.create(owner, project.id, {
      kind: "repo",
      name: "example.org/example/repo",
      uri: "example.org/example/repo"
    });
    const prior = await sources.create(owner, project.id, {
      kind: "skill",
      name: "prior"
    });
    await sources.remove(owner, project.id, prior.id);
    const preview = await projects.deletePreview(owner, project.id);
    const batchId = randomUUID();
    await projects.beginDelete(owner, project.id, {
      version: project.version,
      batchId,
      executionSetHash: preview.executionSetHash
    });
    await projects.markDeleteReady(owner, project.id, batchId);
    const deleted = await projects.completeDelete(owner, project.id, batchId);
    expect(deleted.lifecycle).toBe("deleted");
    const rows = await pool.query<{
      id: string;
      delete_batch_id: string | null;
      deleted_at: Date | null;
    }>(
      `select id,delete_batch_id,deleted_at from project_sources where owner_user_id=$1 and project_id=$2`,
      [owner, project.id]
    );
    expect(rows.rows.find((row) => row.id === active.id)?.delete_batch_id).toBe(
      batchId
    );
    expect(
      rows.rows.find((row) => row.id === prior.id)?.delete_batch_id
    ).toBeNull();
    await projects.restore(owner, project.id, {
      version: deleted.version,
      batchId
    });
    expect(
      (await sources.list(owner, project.id)).map((item) => item.id)
    ).toEqual([active.id]);
  });

  it("waits on the Project lock, then rejects a turn that races deletion", async () => {
    const projects = createProjectApiRepository(pool);
    const sources = createProjectSourceRepository(pool);
    const project = await projects.create(owner, {
      name: "Race",
      idempotencyKey: "source-race"
    });
    const source = await sources.create(owner, project.id, {
      kind: "folder",
      name: "Race",
      uri: "/race"
    });
    const sessionId = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,automatic_personal_project_id)
      values($1,$2,'codex-cli','api',$3)`,
      [sessionId, owner, project.id]
    );
    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      const pid = (
        await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      await blocker.query(
        "select id from projects where owner_user_id=$1 and id=$2 for update",
        [owner, project.id]
      );
      const usage = sources.recordTrustedUse({
        ownerUserId: owner,
        projectId: project.id,
        sourceId: source.id,
        capturedSessionId: sessionId,
        turnId: "racing-turn",
        provenance: "tool_read"
      });
      let blocked = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const waiting = await pool.query<{ count: number }>(
          `select count(*)::integer as count from pg_stat_activity where datname=current_database()
           and $1::integer=any(pg_blocking_pids(pid))`,
          [pid]
        );
        if (waiting.rows[0]!.count > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      await blocker.query(
        "update projects set deletion_phase='preparing',delete_batch_id=$3 where owner_user_id=$1 and id=$2",
        [owner, project.id, randomUUID()]
      );
      await blocker.query("commit");
      await expect(usage).rejects.toBeInstanceOf(ProjectConflictError);
      const count = await pool.query<{ uses: number }>(
        "select uses from project_sources where id=$1",
        [source.id]
      );
      expect(count.rows[0]?.uses).toBe(0);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
  });
});
