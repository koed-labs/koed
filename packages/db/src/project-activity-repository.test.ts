import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import {
  createProjectActivityRepository,
  appendProjectActivityWithClient,
  ProjectActivityCursorError,
  ProjectActivityUnavailableError
} from "./project-activity-repository.js";
import { createWorkItemRepository } from "./work-item-repository.js";

const testUrl =
  process.env.KOED_HQ206_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const waitForBlockedClients = async (
  pool: pg.Pool,
  blockerPid: number,
  expected: number
) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await pool.query<{ count: number }>(
      `select count(*)::integer as count from pg_stat_activity
       where datname=current_database() and $1::integer=any(pg_blocking_pids(pid))`,
      [blockerPid]
    );
    if (result.rows[0]!.count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Expected ${expected} Project-lock waiter(s)`);
};
describe.skipIf(!testUrl)("Personal Project activity", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  let project: string;
  let otherProject: string;
  const owner = randomUUID();
  const other = randomUUID();
  const ref = randomUUID();
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq206_worker_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values ($1,$2),($3,$4)", [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
    const result = await pool.query<{ id: string }>(
      `insert into projects(owner_user_id,name,key) values ($1,'A','A'),($2,'B','B') returning id`,
      [owner, other]
    );
    project = result.rows[0]!.id;
    otherProject = result.rows[1]!.id;
  }, 120_000);
  afterAll(async () => {
    try {
      await pool?.end();
      if (admin && database) {
        let active = 0;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const sessions = await admin.query<{ count: number }>(
            `select count(*)::integer as count from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`,
            [database]
          );
          active = sessions.rows[0]!.count;
          if (active === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (active !== 0)
          throw new Error(`Activity fixture has ${active} active client(s)`);
        await admin.query(`drop database ${quote(database)}`);
      }
    } finally {
      await admin?.end();
    }
  });

  it("writes Work Item activity atomically, with no duplicate on idempotent retry or rejected transition", async () => {
    const work = createWorkItemRepository(pool);
    const activity = createProjectActivityRepository(pool);
    const input = {
      kind: "todo" as const,
      title: "Call Alex",
      goal: "Confirm schedule",
      origin: "manual",
      idempotencyKey: "call"
    };
    const item = await work.create(owner, project, input);
    await work.create(owner, project, input);
    const done = await work.patch(owner, item.id, {
      version: item.version,
      action: "mark_done"
    });
    await expect(
      work.patch(owner, item.id, { version: item.version, action: "untick" })
    ).rejects.toThrow();
    const rows = await activity.list(owner, project);
    expect(rows.items.map((entry) => entry.kind)).toEqual([
      "work_item_created",
      "work_item_done"
    ]);
    expect(rows.items[1]?.ref).toBe(`${done.id}:${done.version}`);
    await expect(activity.list(owner, otherProject)).rejects.toBeInstanceOf(
      ProjectActivityUnavailableError
    );
    await expect(activity.list(other, project)).rejects.toBeInstanceOf(
      ProjectActivityUnavailableError
    );
  });

  it("orders concurrent commits and pages without gaps or duplicates", async () => {
    const activity = createProjectActivityRepository(pool);
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      const firstPid = (
        await first.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      await first.query("begin");
      await appendProjectActivityWithClient(first, {
        ownerUserId: owner,
        projectId: project,
        actorUserId: owner,
        kind: "work_item_status",
        ref: `${ref}:a`
      });
      await second.query("begin");
      const secondAppend = appendProjectActivityWithClient(second, {
        ownerUserId: owner,
        projectId: project,
        actorUserId: owner,
        kind: "work_item_status",
        ref: `${ref}:b`
      });
      await waitForBlockedClients(pool, firstPid, 1);
      await first.query("commit");
      await secondAppend;
      await second.query("commit");
    } finally {
      first.release();
      second.release();
    }
    const all = await activity.list(owner, project);
    expect(all.items.slice(-2).map((entry) => entry.ref)).toEqual([
      `${ref}:a`,
      `${ref}:b`
    ]);
    const after = (await activity.list(owner, project, { limit: 2 }))
      .nextCursor!;
    const tail = await activity.list(owner, project, { after });
    expect(
      [...all.items.slice(0, 2), ...tail.items].map((entry) => entry.cursor)
    ).toEqual(all.items.map((entry) => entry.cursor));
    expect(new Set(all.items.map((entry) => entry.cursor)).size).toBe(
      all.items.length
    );
    const client = await pool.connect();
    try {
      await client.query("begin");
      await appendProjectActivityWithClient(client, {
        ownerUserId: owner,
        projectId: project,
        actorUserId: owner,
        kind: "work_item_status",
        ref: `${ref}:rolled-back`
      });
      await client.query("rollback");
    } finally {
      client.release();
    }
    expect((await activity.list(owner, project)).items).toHaveLength(
      all.items.length
    );
  });

  it("counts exactly seven UTC dates including today and excludes older/future rows", async () => {
    const activity = createProjectActivityRepository(pool);
    const before = (await activity.summary(owner, project)).total;
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const suffix of ["six", "seven", "future"]) {
        await appendProjectActivityWithClient(client, {
          ownerUserId: owner,
          projectId: project,
          actorUserId: owner,
          kind: "work_item_status",
          ref: `${ref}:${suffix}`
        });
      }
      await client.query("commit");
    } finally {
      client.release();
    }
    await pool.query(
      `update project_activity set at=(date_trunc('day',now() at time zone 'UTC') - interval '6 days') at time zone 'UTC' where ref=$1`,
      [`${ref}:six`]
    );
    await pool.query(
      `update project_activity set at=(date_trunc('day',now() at time zone 'UTC') - interval '7 days') at time zone 'UTC' where ref=$1`,
      [`${ref}:seven`]
    );
    await pool.query(
      `update project_activity set at=now()+interval '1 day' where ref=$1`,
      [`${ref}:future`]
    );
    const summary = await activity.summary(owner, project);
    expect(summary.days).toHaveLength(7);
    expect(summary.total).toBe(before + 1);
    expect(summary.days[0]?.count).toBe(1);
    expect(summary.days.reduce((sum, day) => sum + day.count, 0)).toBe(
      summary.total
    );
  });

  it("acknowledges only committed owner Project cursors and never rewinds", async () => {
    const activity = createProjectActivityRepository(pool);
    const page = await activity.list(owner, project);
    const first = page.items[0]!.cursor;
    const latest = page.items.at(-1)!.cursor;
    expect((await activity.seen(owner, project)).cursor).not.toBe(latest);
    expect((await activity.acknowledge(owner, project, latest)).cursor).toBe(
      latest
    );
    expect((await activity.acknowledge(owner, project, first)).cursor).toBe(
      latest
    );
    await expect(
      activity.acknowledge(other, project, latest)
    ).rejects.toBeInstanceOf(ProjectActivityCursorError);
    await expect(
      activity.acknowledge(owner, otherProject, latest)
    ).rejects.toBeInstanceOf(ProjectActivityCursorError);
    const forged = JSON.parse(
      Buffer.from(latest, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    forged.sequence = "9223372036854775807";
    await expect(
      activity.acknowledge(
        owner,
        project,
        Buffer.from(JSON.stringify(forged)).toString("base64url")
      )
    ).rejects.toBeInstanceOf(ProjectActivityCursorError);
    expect((await activity.seen(owner, project)).cursor).toBe(latest);
    await pool.query(
      `update projects set lifecycle='deleted',deleted_at=now(),deletion_phase='complete',delete_batch_id=$2 where id=$1`,
      [project, randomUUID()]
    );
    await expect(activity.list(owner, project)).rejects.toBeInstanceOf(
      ProjectActivityUnavailableError
    );
    await pool.query(
      `update projects set lifecycle='active',deleted_at=null,deletion_phase=null,delete_batch_id=null where id=$1`,
      [project]
    );
    expect((await activity.seen(owner, project)).cursor).toBe(latest);
  });

  it("does not mark a concurrent newly committed event seen with an older acknowledgement", async () => {
    const activity = createProjectActivityRepository(pool);
    const oldCursor = (await activity.list(owner, project)).items.at(
      -1
    )!.cursor;
    const writer = await pool.connect();
    try {
      await writer.query("begin");
      const input = {
        ownerUserId: owner,
        projectId: project,
        actorUserId: owner,
        kind: "work_item_status" as const,
        ref: `${ref}:concurrent`
      };
      await appendProjectActivityWithClient(writer, input);
      const acknowledgement = activity.acknowledge(owner, project, oldCursor);
      await writer.query("commit");
      expect((await acknowledgement).cursor).toBe(oldCursor);
      const latest = (await activity.list(owner, project)).items.at(-1)!.cursor;
      expect(latest).not.toBe(oldCursor);
      expect((await activity.seen(owner, project)).cursor).toBe(oldCursor);
      const client = await pool.connect();
      try {
        await client.query("begin");
        expect(await appendProjectActivityWithClient(client, input)).toBeNull();
        await client.query("commit");
      } finally {
        client.release();
      }
      expect((await activity.list(owner, project)).items.at(-1)!.cursor).toBe(
        latest
      );
    } finally {
      writer.release();
    }
  });

  it("rejects unimplemented and Team kinds at the Personal append boundary", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const kind of [
        "source_added",
        "assertion_created",
        "member_joined"
      ] as const)
        await expect(
          appendProjectActivityWithClient(client, {
            ownerUserId: owner,
            projectId: project,
            actorUserId: owner,
            kind: kind as never,
            ref: randomUUID()
          })
        ).rejects.toThrow("Personal Project activity kind is unavailable");
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("rejects an actor outside the owning Personal identity", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await expect(
        appendProjectActivityWithClient(client, {
          ownerUserId: owner,
          projectId: project,
          actorUserId: other,
          kind: "work_item_status",
          ref: randomUUID()
        })
      ).rejects.toThrow("Personal Project activity actor is not the owner");
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("denies activity reads when a concurrent Project delete wins the row lock", async () => {
    const activity = createProjectActivityRepository(pool);
    const created = await pool.query<{ id: string }>(
      `insert into projects(owner_user_id,name,key) values ($1,'Deleting','DELETING') returning id`,
      [owner]
    );
    const id = created.rows[0]!.id;
    const deletion = await pool.connect();
    try {
      const deletionPid = (
        await deletion.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      await deletion.query("begin");
      await deletion.query(
        `update projects set lifecycle='deleted',deleted_at=now(),
        deletion_phase='complete',delete_batch_id=$2 where id=$1`,
        [id, randomUUID()]
      );
      const reads = [
        activity.list(owner, id),
        activity.summary(owner, id),
        activity.seen(owner, id)
      ].map((read) =>
        expect(read).rejects.toBeInstanceOf(ProjectActivityUnavailableError)
      );
      await waitForBlockedClients(pool, deletionPid, 3);
      await deletion.query("commit");
      await Promise.all(reads);
    } finally {
      deletion.release();
    }
  });
});
