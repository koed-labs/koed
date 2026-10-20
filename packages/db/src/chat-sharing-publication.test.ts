import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { chatAllowsTeamPublication } from "./chat-sharing-publication.js";

const url =
  process.env.KOED_HQ106_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!url)("Conversation Team publication lifecycle fence", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    database = `hq106_publication_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const local = new URL(url!);
    local.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: local.toString() });
    await runDbMigrations(pool);
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database ${quote(database)}`);
    await admin?.end();
  });

  it("blocks pending and trashed Team work through direct and logical identities without touching retained content", async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const sessionId = randomUUID();
    const logicalMemoryId = randomUUID();
    await pool.query(`insert into users(id,email) values($1,$2),($3,$4)`, [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
    const deployment = await pool.query<{ id: string }>(
      `insert into deployment_identities(protocol_deployment_id,locality,profile)
       values($1,'local','developer') returning id`,
      [randomUUID()]
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method)
      values($1,$2,'codex','api')`,
      [sessionId, owner]
    );
    const setup = await pool.connect();
    try {
      await setup.query("begin");
      await setup.query(
        `insert into logical_memories(id,owner_user_id,owner_principal_id,
      origin_deployment_identity_id,source_kind,logical_key)
      values($1,$2,$2,$3,'captured_session',$4)`,
        [
          logicalMemoryId,
          owner,
          deployment.rows[0]!.id,
          `captured-session:${sessionId}`
        ]
      );
      await setup.query(
        `insert into captured_session_logical_memories
      (logical_memory_id,source_session_id,owner_principal_id) values($1,$2,$3)`,
        [logicalMemoryId, sessionId, owner]
      );
      await setup.query(
        `insert into local_captured_session_logical_memories
      (logical_memory_id,local_session_id,owner_user_id) values($1,$2,$3)`,
        [logicalMemoryId, sessionId, owner]
      );
      await setup.query("commit");
    } catch (error) {
      await setup.query("rollback");
      throw error;
    } finally {
      setup.release();
    }
    const client = await pool.connect();
    try {
      expect(
        await chatAllowsTeamPublication(
          client,
          owner,
          logicalMemoryId,
          sessionId
        )
      ).toBe(true);
      await client.query(`update sessions set delete_batch_id=$2 where id=$1`, [
        sessionId,
        randomUUID()
      ]);
      expect(
        await chatAllowsTeamPublication(
          client,
          owner,
          logicalMemoryId,
          sessionId
        )
      ).toBe(false);
      // A target-side alias need not use the source's Session ID.
      expect(
        await chatAllowsTeamPublication(
          client,
          owner,
          logicalMemoryId,
          randomUUID()
        )
      ).toBe(false);
      // This predicate is a local lifecycle fence, not an authorization grant.
      // Another owner's unrelated state cannot block this namespace.
      expect(
        await chatAllowsTeamPublication(client, other, randomUUID(), sessionId)
      ).toBe(true);
      await client.query(
        `update sessions set delete_batch_id=null,trashed_at=now() where id=$1`,
        [sessionId]
      );
      expect(
        await chatAllowsTeamPublication(client, owner, logicalMemoryId)
      ).toBe(false);
      expect(
        (
          await client.query<{ personal_deleted_at: Date | null }>(
            `select personal_deleted_at from sessions where id=$1`,
            [sessionId]
          )
        ).rows[0]?.personal_deleted_at
      ).toBeNull();
      await client.query(`update sessions set trashed_at=null where id=$1`, [
        sessionId
      ]);
      expect(
        await chatAllowsTeamPublication(client, owner, logicalMemoryId)
      ).toBe(true);
    } finally {
      client.release();
    }
  });
});
