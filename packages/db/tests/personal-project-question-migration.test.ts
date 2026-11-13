import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("Project union question scope migration", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  it("upgrades the legacy constraint without changing retained history and keeps structural scope guards", async () => {
    const owner = await createMemorySourceRepository(pool).createUser({
      email: `question-migration-${randomUUID()}@example.test`
    });
    const migration = await readFile(
      new URL(
        "../drizzle/0003_personal_project_union_question_scope.sql",
        import.meta.url
      ),
      "utf8"
    );
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`alter table memory_questions drop constraint memory_questions_search_domain_check;
        alter table memory_questions add constraint memory_questions_search_domain_check check (
          search_domain='global' or (search_domain='project' and project_id is not null) or (search_domain='session' and session_id is not null)) not valid`);
      const insert = async (
        projectId: string | null,
        retrieval: unknown,
        teamWorkspaceId: string | null = null
      ) =>
        client.query<{ id: string }>(
          `insert into memory_questions(owner_user_id,visibility,origin,retrieval_scope,search_domain,project_id,retrieval,team_workspace_id,idempotency_key,query,status,error_message,answered_at)
         values($1,'personal','mcp_memory_answer','personal','project',$2,$3::jsonb,$4,$5,'retained question','error','retained error',now()) returning id`,
          [
            owner.id,
            projectId,
            retrieval ? JSON.stringify(retrieval) : null,
            teamWorkspaceId,
            randomUUID()
          ]
        );
      const old = (await insert("existing_project", null)).rows[0]!;
      await client.query(migration);
      expect(
        (
          await client.query(
            "select project_id,query,error_message from memory_questions where id=$1",
            [old.id]
          )
        ).rows
      ).toEqual([
        {
          project_id: "existing_project",
          query: "retained question",
          error_message: "retained error"
        }
      ]);
      const marker = {
        contentEncrypted: true,
        encryptedSourceTable: "memory_questions"
      };
      expect((await insert(null, marker)).rows).toHaveLength(1);
      for (const [retrieval, teamWorkspaceId] of [
        [null, null],
        [{ arbitrary: "metadata" }, null],
        [marker, randomUUID()]
      ] as const) {
        await client.query("savepoint invalid_scope");
        await expect(
          insert(null, retrieval, teamWorkspaceId)
        ).rejects.toMatchObject({
          constraint: "memory_questions_search_domain_check"
        });
        await client.query("rollback to savepoint invalid_scope");
      }
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
