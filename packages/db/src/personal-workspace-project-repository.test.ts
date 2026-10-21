import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createPersonalWorkspaceProjectRepository } from "./personal-workspace-project-repository.js";

const testUrl = process.env.KOED_HQ712_TEST_DATABASE_URL;

describe.skipIf(!testUrl)(
  "Personal Workspace Project first-share preflight",
  () => {
    let pool: pg.Pool;
    const owner = randomUUID();
    const projectId = randomUUID();
    const linkedProjectId = randomUUID();
    const workspaceProjectId = randomUUID();

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: testUrl });
      await runDbMigrations(pool);
      await pool.query("insert into users(id,email) values($1,$2)", [
        owner,
        `${owner}@example.test`
      ]);
      await pool.query(
        `insert into projects(id,owner_user_id,name,key)
      values($1,$2,'Oversize copy','OVERSIZE')`,
        [projectId, owner]
      );
      await pool.query(
        `insert into projects(id,owner_user_id,name,key,
      team_backend_id,team_workspace_id,workspace_project_id)
      values($1,$2,'Linked copy','LINKED','team-vps',$3,$4)`,
        [linkedProjectId, owner, randomUUID(), workspaceProjectId]
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query("delete from project_work_items where project_id=$1", [
        projectId
      ]);
      await pool.query(
        "delete from personal_workspace_project_share_attempts where personal_project_id=$1",
        [projectId]
      );
      await pool.query(
        "delete from personal_workspace_project_reconciliations where personal_project_id=$1",
        [linkedProjectId]
      );
      await pool.query("delete from projects where id=$1", [projectId]);
      await pool.query("delete from projects where id=$1", [linkedProjectId]);
      await pool.query("delete from users where id=$1", [owner]);
      await pool.end();
    });

    it("rejects a schema-valid oversized copy before the Personal edit fence", async () => {
      await pool.query(
        `insert into project_work_items
      (owner_user_id,project_id,kind,title,goal,origin,
       creation_payload_hash,created_by)
      select $1,$2,'todo','Large to-do '||n,repeat('x',20000),
             'manual',repeat('a',64),$1
        from generate_series(1,400) as n`,
        [owner, projectId]
      );
      const repo = createPersonalWorkspaceProjectRepository(pool);
      await expect(
        repo.beginShare(owner, projectId, {
          teamBackendId: "team-vps",
          shareAttemptKey: "oversize-share-attempt",
          targetTeamId: randomUUID(),
          targetWorkspaceId: randomUUID()
        })
      ).rejects.toThrow("supported first-share copy limits");
      const attempt = await pool.query(
        `select 1 from personal_workspace_project_share_attempts
      where personal_project_id=$1`,
        [projectId]
      );
      expect(attempt.rowCount).toBe(0);
      await expect(
        pool.query(
          `update project_work_items set title='Still editable'
      where project_id=$1 and owner_user_id=$2`,
          [projectId, owner]
        )
      ).resolves.toBeDefined();
    });
    it("retains an owner-local lifecycle receipt after clearing the Team link", async () => {
      const repo = createPersonalWorkspaceProjectRepository(pool);
      expect(
        await repo.reconcileInvalidation(
          owner,
          linkedProjectId,
          workspaceProjectId
        )
      ).toMatchObject({ cleared: true });
      const receipt = await pool.query<{
        reason: string;
        team_backend_id: string;
      }>(
        `
      select reason,team_backend_id from personal_workspace_project_reconciliations
      where owner_user_id=$1 and personal_project_id=$2 and workspace_project_id=$3`,
        [owner, linkedProjectId, workspaceProjectId]
      );
      expect(receipt.rows).toEqual([
        { reason: "invalidation", team_backend_id: "team-vps" }
      ]);
      expect(
        await repo.reconcileInvalidation(
          owner,
          linkedProjectId,
          workspaceProjectId
        )
      ).toMatchObject({ cleared: false });
      expect(
        (
          await pool.query(
            `select 1 from personal_workspace_project_reconciliations
      where personal_project_id=$1`,
            [linkedProjectId]
          )
        ).rowCount
      ).toBe(1);
    });
  }
);
