import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/connection.js";
import { createCuratedMemoryRepository } from "../src/curated-memory-repository.js";
import { runDbMigrations } from "../src/migrate.js";
import { activeCuratedMemoryEvidencePredicate } from "../src/curated-memory-policy.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Curated assertion panel and Undo", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let ownerId: string;
  let otherId: string;
  let projectId: string;
  let sourceId: string;
  let oldId: string;
  let currentId: string;
  let unscopedId: string;
  const actor = () => ({ userId: ownerId });

  beforeAll(async () => {
    databaseName = `hq303_assertions_${randomUUID().replaceAll("-", "")}`;
    admin = createDbPool({ connectionString: databaseUrl! });
    await admin.query(`create database "${databaseName}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = createDbPool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    ownerId = randomUUID();
    otherId = randomUUID();
    projectId = randomUUID();
    sourceId = randomUUID();
    oldId = randomUUID();
    currentId = randomUUID();
    unscopedId = randomUUID();
    await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
      ownerId,
      `${ownerId}@example.test`,
      otherId,
      `${otherId}@example.test`
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
      [sourceId, ownerId, projectId, "a".repeat(64)]
    );
    await pool.query(
      `insert into curated_memory_assertions (
         id,owner_user_id,visibility,assertion_text,normalized_assertion,
         status,scope,project_id,kind,author_kind,author_ref,
         supersedes_assertion_id,created_at
       ) values
         ($1,$4,'personal','Old decision','old decision','superseded',
          'project',$5,'decision','user',$6,null,now()-interval '2 days'),
         ($2,$4,'personal','New decision','new decision','current',
          'project',$5,'decision','user',$6,$1,now()),
         ($3,$4,'personal','Legacy fact','legacy fact','current',
          'unscoped',null,'fact',null,null,null,now())`,
      [oldId, currentId, unscopedId, ownerId, projectId, ownerId]
    );
    await pool.query(
      `insert into curated_memory_sources (
         assertion_id,source_type,source_role,project_work_item_id,metadata
       ) select id,'project_work_item','primary_evidence',$2,'{}'
           from curated_memory_assertions where id=any($1::uuid[])`,
      [[oldId, currentId, unscopedId], sourceId]
    );
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseName) {
      await admin.query(
        `drop database if exists "${databaseName}" with (force)`
      );
      await admin.end();
    }
  });

  it("filters exact classification without assigning legacy rows to a Project", async () => {
    const repo = createCuratedMemoryRepository(pool);
    expect(
      (
        await repo.listCuratedMemoryAssertions(actor(), {
          scope: "project",
          projectId,
          kind: "decision",
          status: "current",
          since: new Date(Date.now() - 86_400_000).toISOString()
        })
      ).map((item) => item.id)
    ).toEqual([currentId]);
    expect(
      (
        await repo.listCuratedMemoryAssertions(actor(), {
          scope: "unscoped",
          status: "current"
        })
      ).map((item) => item.id)
    ).toEqual([unscopedId]);
    expect(
      await repo.listCuratedMemoryAssertions(
        { userId: otherId },
        {
          scope: "project",
          projectId
        }
      )
    ).toEqual([]);
  });

  it("returns only owner-readable predecessors from the supersede chain", async () => {
    const repo = createCuratedMemoryRepository(pool);
    expect(
      (await repo.getCuratedMemoryReplacementChain(actor(), currentId)).map(
        (item) => item.assertionText
      )
    ).toEqual(["Old decision"]);
    await pool.query(
      "update curated_memory_assertions set suppressed_at=now() where id=$1",
      [oldId]
    );
    expect(
      await repo.getCuratedMemoryReplacementChain(actor(), currentId)
    ).toEqual([]);
    await pool.query(
      "update curated_memory_assertions set suppressed_at=null where id=$1",
      [oldId]
    );
    const foreignId = randomUUID();
    await pool.query(
      `insert into curated_memory_assertions (
         id,owner_user_id,visibility,assertion_text,normalized_assertion,
         status,scope
       ) values ($1,$2,'personal','Private foreign claim',
         'private foreign claim','superseded','unscoped')`,
      [foreignId, otherId]
    );
    await pool.query(
      "update curated_memory_assertions set supersedes_assertion_id=$2 where id=$1",
      [currentId, foreignId]
    );
    expect(
      await repo.getCuratedMemoryReplacementChain(actor(), currentId)
    ).toEqual([]);
    await pool.query(
      "update curated_memory_assertions set supersedes_assertion_id=$2 where id=$1",
      [currentId, oldId]
    );
    expect(
      await repo.getCuratedMemoryReplacementChain(
        { userId: otherId },
        currentId
      )
    ).toEqual([]);
  });

  it("requires the exact owner, suppression token and seven-day window", async () => {
    const repo = createCuratedMemoryRepository(pool);
    const suppressed = await repo.suppressCuratedMemoryAssertion(
      actor(),
      currentId,
      {
        status: "suppressed",
        reason: "Panel Forget"
      }
    );
    const token = suppressed!.suppressionToken!;
    expect(token).toMatch(/^\d+$/);
    expect(
      await repo.unsuppressCuratedMemoryAssertion(
        { userId: otherId },
        currentId,
        {
          suppressionToken: token
        }
      )
    ).toBeNull();
    await expect(
      repo.unsuppressCuratedMemoryAssertion(actor(), currentId, {
        suppressionToken: "0"
      })
    ).rejects.toThrow("Undo is unavailable");
    await pool.query(
      "update curated_memory_assertions set suppressed_at=now()-interval '8 days' where id=$1",
      [currentId]
    );
    const expiredToken = (await repo.getCuratedMemoryAssertion(
      actor(),
      currentId
    ))!.suppressionToken!;
    await expect(
      repo.unsuppressCuratedMemoryAssertion(actor(), currentId, {
        suppressionToken: expiredToken
      })
    ).rejects.toThrow("Undo is unavailable");
    await pool.query(
      "update curated_memory_assertions set suppressed_at=$2::timestamptz where id=$1",
      [currentId, suppressed!.suppressedAt]
    );
    const restoredToken = (await repo.getCuratedMemoryAssertion(
      actor(),
      currentId
    ))!.suppressionToken!;
    expect(
      (
        await repo.unsuppressCuratedMemoryAssertion(actor(), currentId, {
          suppressionToken: restoredToken
        })
      )?.status
    ).toBe("current");
    await repo.suppressCuratedMemoryAssertion(actor(), currentId, {
      status: "suppressed"
    });
    await pool.query(
      `update curated_memory_assertions
          set suppressed_at=date_trunc('milliseconds',now()-interval '1 second')
            + interval '0.000123 second' where id=$1`,
      [currentId]
    );
    const precise = (await repo.getCuratedMemoryAssertion(actor(), currentId))!;
    expect(precise.suppressionToken).toMatch(/123$/);
    const zoneClient = await pool.connect();
    try {
      await zoneClient.query("set timezone to 'Pacific/Honolulu'");
      const crossZone = await zoneClient.query<{ token: string }>(
        `select ((extract(epoch from suppressed_at) * 1000000)::bigint)::text
           as token from curated_memory_assertions where id=$1`,
        [currentId]
      );
      expect(crossZone.rows[0]?.token).toBe(precise.suppressionToken);
    } finally {
      zoneClient.release();
    }
    await expect(
      repo.unsuppressCuratedMemoryAssertion(actor(), currentId, {
        suppressionToken: token
      })
    ).rejects.toThrow("Undo is unavailable");
    await expect(
      repo.unsuppressCuratedMemoryAssertion(actor(), currentId, {
        suppressionToken: precise.suppressedAt!
      })
    ).rejects.toThrow("Undo is unavailable");
    expect(
      (
        await repo.unsuppressCuratedMemoryAssertion(actor(), currentId, {
          suppressionToken: precise.suppressionToken!
        })
      )?.status
    ).toBe("current");
  });

  it("does not restore a superseded or evidence-less assertion", async () => {
    const repo = createCuratedMemoryRepository(pool);
    const suppressed = await repo.suppressCuratedMemoryAssertion(
      actor(),
      unscopedId,
      {
        status: "suppressed"
      }
    );
    await pool.query(
      "delete from curated_memory_sources where assertion_id=$1",
      [unscopedId]
    );
    expect(
      (
        await repo.listCuratedMemoryAssertions(actor(), { status: "current" })
      ).some((item) => item.id === unscopedId)
    ).toBe(false);
    await expect(
      repo.unsuppressCuratedMemoryAssertion(actor(), unscopedId, {
        suppressionToken: suppressed!.suppressionToken!
      })
    ).rejects.toThrow("Undo is unavailable");
    const old = await repo.suppressCuratedMemoryAssertion(actor(), oldId, {
      status: "suppressed"
    });
    await pool.query(
      "update curated_memory_assertions set superseded_by_assertion_id=$2 where id=$1",
      [oldId, currentId]
    );
    await expect(
      repo.unsuppressCuratedMemoryAssertion(actor(), oldId, {
        suppressionToken: old!.suppressionToken!
      })
    ).rejects.toThrow("Undo is unavailable");
  });

  it("cannot override an active chat Forget suppression snapshot", async () => {
    const repo = createCuratedMemoryRepository(pool);
    const suppressed = await repo.suppressCuratedMemoryAssertion(
      actor(),
      currentId,
      {
        status: "suppressed"
      }
    );
    const sessionId = randomUUID();
    const batchId = randomUUID();
    const snapshot = await pool.query<{ suppressed_at: string }>(
      "select suppressed_at::text as suppressed_at from curated_memory_assertions where id=$1",
      [currentId]
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,visibility,source_runtime,capture_method)
       values ($1,$2,'personal','codex','transcript')`,
      [sessionId, ownerId]
    );
    await pool.query(
      `insert into chat_forget_operations (
         batch_id,session_id,owner_user_id,state,assertion_snapshots
       ) values ($1,$2,$3,'complete',$4::jsonb)`,
      [
        batchId,
        sessionId,
        ownerId,
        JSON.stringify([
          {
            id: currentId,
            suppressedAt: snapshot.rows[0]!.suppressed_at
          }
        ])
      ]
    );
    await expect(
      repo.unsuppressCuratedMemoryAssertion(actor(), currentId, {
        suppressionToken: suppressed!.suppressionToken!
      })
    ).rejects.toThrow("Undo is unavailable");
    await pool.query(
      "update chat_forget_operations set state='undone' where batch_id=$1",
      [batchId]
    );
    const state = await pool.query<{
      status: string;
      suppressed_at: Date;
      suppressed_by_user_id: string;
      superseded_by_assertion_id: string | null;
    }>(
      `select status,suppressed_at,suppressed_by_user_id,superseded_by_assertion_id
          from curated_memory_assertions where id=$1`,
      [currentId]
    );
    expect(state.rows[0]).toMatchObject({
      status: "suppressed",
      suppressed_by_user_id: ownerId,
      superseded_by_assertion_id: null
    });
    expect(state.rows[0]?.suppressed_at.toISOString()).toBe(
      suppressed!.suppressedAt
    );
    const eligible = await pool.query<{
      within_window: boolean;
      before_now: boolean;
      active: boolean;
      blocking: boolean;
    }>(
      `select
       cma.suppressed_at > now()-interval '7 days' as within_window,
       cma.suppressed_at <= now() as before_now,
       ${activeCuratedMemoryEvidencePredicate("cma")} as active,
       exists (select 1 from chat_forget_operations forget
         where forget.owner_user_id=$2 and forget.state='complete') as blocking
       from curated_memory_assertions cma where cma.id=$1`,
      [currentId, ownerId]
    );
    expect(eligible.rows[0]).toEqual({
      within_window: true,
      before_now: true,
      active: true,
      blocking: false
    });
    expect(
      (
        await repo.unsuppressCuratedMemoryAssertion(actor(), currentId, {
          suppressionToken: suppressed!.suppressionToken!
        })
      )?.status
    ).toBe("current");
  });

  it("never promotes a suppressed conflict into the canonical current assertion", async () => {
    const conflictId = randomUUID();
    await pool.query(
      `insert into curated_memory_assertions (
         id,owner_user_id,visibility,assertion_text,normalized_assertion,
         status,scope,conflict_with_assertion_id
       ) values ($1,$2,'personal','Conflicting claim','conflicting claim',
         'conflicting','unscoped',$3)`,
      [conflictId, ownerId, currentId]
    );
    await pool.query(
      `insert into curated_memory_sources (
         assertion_id,source_type,source_role,project_work_item_id,metadata
       ) values ($1,'project_work_item','conflicting_evidence',$2,'{}')`,
      [conflictId, sourceId]
    );
    const repo = createCuratedMemoryRepository(pool);
    const suppressed = await repo.suppressCuratedMemoryAssertion(
      actor(),
      conflictId,
      {
        status: "suppressed"
      }
    );
    await expect(
      repo.unsuppressCuratedMemoryAssertion(actor(), conflictId, {
        suppressionToken: suppressed!.suppressionToken!
      })
    ).rejects.toThrow("Undo is unavailable");
    expect(
      (await repo.getCuratedMemoryAssertion(actor(), conflictId))?.status
    ).toBe("suppressed");
  });
});
