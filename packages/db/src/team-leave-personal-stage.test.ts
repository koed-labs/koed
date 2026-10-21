import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import {
  createPersonalWorkspaceProjectRepository,
  PersonalWorkspaceProjectConflictError
} from "./personal-workspace-project-repository.js";

const testUrl = process.env.KOED_HQ704_TEST_DATABASE_URL;

describe.skipIf(!testUrl)("HQ704 owned Project Personal copy stages", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  const database = `hq704_personal_${randomUUID().replaceAll("-", "")}`;
  const owner = randomUUID();
  const project = randomUUID();
  const team = randomUUID();
  const workspace = randomUUID();
  const sharedProject = randomUUID();
  const member = randomUUID();
  const firstOperation = randomUUID();
  const secondOperation = randomUUID();
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    await admin.query(`create database "${database}"`);
    const child = new URL(testUrl!);
    child.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: child.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values($1,$2)", [
      owner,
      `${owner}@example.test`
    ]);
    await pool.query(
      `insert into projects(id,owner_user_id,name,key,team_backend_id,team_workspace_id,workspace_project_id)
       values($1,$2,'Owned Project','OWN','team-backend',$3,$4)`,
      [project, owner, workspace, sharedProject]
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database "${database}" with (force)`);
      await admin.end();
    }
  });
  const input = (operation: string) => ({
    personalProjectId: project,
    teamBackendId: "team-backend",
    teamId: team,
    workspaceProjectId: sharedProject,
    ownerTeamMemberId: member,
    reviewedTeamVersion: 3,
    reviewedMemberVersion: 4,
    reviewedProjectVersion: 5,
    ownedSetHash: "a".repeat(64),
    leaveOperationId: operation,
    workItems: [],
    decks: []
  });
  it("reuses only the same durable ready operation and lets a fresh approval stage after cancellation", async () => {
    const repo = createPersonalWorkspaceProjectRepository(pool);
    const first = await repo.stageOwnedCopyBack(owner, input(firstOperation));
    expect((await repo.getStagedCopyBack(owner, first.stageId))?.state).toBe(
      "ready"
    );
    expect(await repo.stageOwnedCopyBack(owner, input(firstOperation))).toEqual(
      first
    );
    await expect(
      repo.stageOwnedCopyBack(owner, {
        ...input(firstOperation),
        reviewedMemberVersion: 7
      })
    ).rejects.toBeInstanceOf(PersonalWorkspaceProjectConflictError);
    await pool.query(
      `update personal_workspace_project_copyback_stages set state='abandoned'
       where id=$1`,
      [first.stageId]
    );
    const second = await repo.stageOwnedCopyBack(owner, input(secondOperation));
    expect(second.stageId).not.toBe(first.stageId);
    expect((await repo.getStagedCopyBack(owner, second.stageId))?.state).toBe(
      "ready"
    );
    expect((await repo.getStagedCopyBack(owner, first.stageId))?.state).toBe(
      "abandoned"
    );
    expect(
      await repo.listTeamLeaveStageOperations(owner, "team-backend", team, null)
    ).toEqual([secondOperation]);
    expect(
      await repo.listTeamLeaveStageIds(
        owner,
        "team-backend",
        team,
        secondOperation
      )
    ).toEqual([second.stageId]);
    expect(
      await repo.listTeamLeaveStageOperations(
        randomUUID(),
        "team-backend",
        team,
        null
      )
    ).toEqual([]);
  });
});
