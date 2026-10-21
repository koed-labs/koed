import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createPersonalWorkspaceProjectRepository } from "./personal-workspace-project-repository.js";
import { createWorkspaceProjectRepository } from "./workspace-project-repository.js";
import { createTeamAccessRepository } from "./team-access-repository.js";

const testUrl = process.env.KOED_HQ701_TEST_DATABASE_URL;

describe.skipIf(!testUrl)("HQ701 durable target and invitation handoff", () => {
  let pool: pg.Pool;
  let admin: pg.Pool;
  let database: string;
  const owner = randomUUID();
  const personalProject = randomUUID();
  const targetTeam = randomUUID();
  const targetWorkspace = randomUUID();
  const otherWorkspace = randomUUID();
  const seedUser = async (displayName: string) => {
    const id = randomUUID();
    await pool.query(
      "insert into users(id,email,display_name) values($1,$2,$3)",
      [id, `${id}@example.test`, displayName]
    );
    return { id };
  };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq701_share_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${database}"`);
    const childUrl = new URL(testUrl!);
    childUrl.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: childUrl.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values($1,$2)", [
      owner,
      `${owner}@example.test`
    ]);
    await pool.query(
      "insert into projects(id,owner_user_id,name,key) values($1,$2,'Private plan','PLAN')",
      [personalProject, owner]
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database "${database}" with (force)`);
    await admin?.end();
  });

  it("resumes one immutable owner-private target after repository restart and refuses changed target/key", async () => {
    const first = createPersonalWorkspaceProjectRepository(pool);
    const input = {
      teamBackendId: "cloud-one",
      shareAttemptKey: "same-share-attempt",
      targetTeamId: targetTeam,
      targetWorkspaceId: targetWorkspace
    };
    const prepared = await first.beginShare(owner, personalProject, input);
    const restarted = createPersonalWorkspaceProjectRepository(pool);
    expect(await restarted.pendingShare(owner, personalProject)).toEqual({
      ...input,
      state: "pending"
    });
    expect(
      await restarted.pendingShare(randomUUID(), personalProject)
    ).toBeNull();
    expect(await restarted.beginShare(owner, personalProject, input)).toEqual(
      prepared
    );
    await expect(
      restarted.beginShare(owner, personalProject, {
        ...input,
        targetWorkspaceId: otherWorkspace
      })
    ).rejects.toThrow("different first-share attempt");
    await expect(
      restarted.beginShare(owner, personalProject, {
        ...input,
        shareAttemptKey: "different-key"
      })
    ).rejects.toThrow("different first-share attempt");
  });

  it("releases a Personal edit fence only for the exact canceled attempt and requires a new key", async () => {
    const projectId = randomUUID();
    await pool.query(
      "insert into projects(id,owner_user_id,name,key) values($1,$2,'Cancel plan','CANCEL')",
      [projectId, owner]
    );
    const repo = createPersonalWorkspaceProjectRepository(pool);
    const input = {
      teamBackendId: "cloud-one",
      shareAttemptKey: "cancel-share-attempt",
      targetTeamId: targetTeam,
      targetWorkspaceId: targetWorkspace
    };
    await repo.beginShare(owner, projectId, input);
    await expect(
      repo.cancelShare(owner, projectId, {
        ...input,
        targetWorkspaceId: otherWorkspace
      })
    ).rejects.toThrow("changed");
    expect(await repo.pendingShare(owner, projectId)).toMatchObject(input);
    expect(await repo.cancelShare(owner, projectId, input)).toEqual({
      canceled: true,
      shareAttemptKey: input.shareAttemptKey
    });
    expect(await repo.cancelShare(owner, projectId, input)).toMatchObject({
      canceled: true
    });
    expect(await repo.pendingShare(owner, projectId)).toBeNull();
    await expect(repo.beginShare(owner, projectId, input)).rejects.toThrow(
      "cannot be resumed"
    );
    const next = {
      ...input,
      shareAttemptKey: "new-share-attempt",
      targetWorkspaceId: otherWorkspace
    };
    await repo.beginShare(owner, projectId, next);
    expect(await repo.pendingShare(owner, projectId)).toMatchObject(next);
  });

  it("serializes Team cancellation against first-share create and rejects late replay of a canceled key", async () => {
    const access = createTeamAccessRepository(pool);
    const teamOwner = await seedUser("Cancel owner");
    const team = await access.createTeam(
      { userId: teamOwner.id },
      { name: "Cancel race Team" }
    );
    if (!team) throw new Error("Team fixture unavailable");
    const workspace = (
      await access.listTeamWorkspaces(
        { userId: teamOwner.id },
        { teamId: team.id, limit: 10 }
      )
    )?.find((item) => item.name === "General");
    if (!workspace) throw new Error("Workspace fixture unavailable");
    const repo = createWorkspaceProjectRepository(pool);
    const input = {
      teamId: team.id,
      workspaceId: workspace.id,
      name: "Racing Project",
      key: "RACE",
      shareAttemptKey: "race-share-attempt"
    };
    const cancel = {
      teamId: team.id,
      workspaceId: workspace.id,
      shareAttemptKey: input.shareAttemptKey
    };
    const outcomes = await Promise.allSettled([
      repo.create(teamOwner.id, input),
      repo.cancelShareAttempt(teamOwner.id, cancel)
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled")
    ).toHaveLength(1);
    if (outcomes[0]?.status === "fulfilled") {
      await expect(
        repo.cancelShareAttempt(teamOwner.id, cancel)
      ).rejects.toThrow();
      expect(
        (
          await repo.shareTarget(
            teamOwner.id,
            team.id,
            workspace.id,
            input.shareAttemptKey
          )
        ).canStart
      ).toBe(true);
    } else {
      const receipt = await repo.cancelShareAttempt(teamOwner.id, cancel);
      expect(receipt).toMatchObject({
        canceled: true,
        shareAttemptKey: input.shareAttemptKey
      });
      await expect(repo.create(teamOwner.id, input)).rejects.toThrow(
        "canceled"
      );
      await expect(
        repo.create(teamOwner.id, {
          ...input,
          shareAttemptKey: input.shareAttemptKey,
          name: "Late"
        })
      ).rejects.toThrow("canceled");
      expect(
        (
          await repo.shareTarget(
            teamOwner.id,
            team.id,
            workspace.id,
            input.shareAttemptKey
          )
        ).canStart
      ).toBe(false);
    }
  });

  it("keeps a canceled Team member key unusable without canceling another member's same key", async () => {
    const access = createTeamAccessRepository(pool);
    const ownerUser = await seedUser("Cancel key owner");
    const otherUser = await seedUser("Other member");
    const team = await access.createTeam(
      { userId: ownerUser.id },
      { name: "Cancel key Team" }
    );
    if (!team) throw new Error("Team fixture unavailable");
    const workspace = (
      await access.listTeamWorkspaces(
        { userId: ownerUser.id },
        { teamId: team.id, limit: 10 }
      )
    )?.find((item) => item.name === "General");
    if (!workspace) throw new Error("Workspace fixture unavailable");
    await pool.query(
      "insert into team_memberships(team_id,user_id,role) values($1,$2,'member')",
      [team.id, otherUser.id]
    );
    await pool.query(
      "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,can_share_owned_memory) values($1,$2,$3,'write',false)",
      [workspace.id, team.id, otherUser.id]
    );
    const repo = createWorkspaceProjectRepository(pool);
    const input = {
      teamId: team.id,
      workspaceId: workspace.id,
      shareAttemptKey: "cancel-only-this-member"
    };
    const receipt = await repo.cancelShareAttempt(ownerUser.id, input);
    expect(await repo.cancelShareAttempt(ownerUser.id, input)).toEqual(receipt);
    await expect(
      pool.query(
        "update workspace_project_share_cancellations set share_attempt_key='changed' where id=$1",
        [receipt.receiptId]
      )
    ).rejects.toThrow("immutable");
    await expect(
      pool.query(
        "delete from workspace_project_share_cancellations where id=$1",
        [receipt.receiptId]
      )
    ).rejects.toThrow("immutable");
    await expect(
      repo.create(ownerUser.id, {
        ...input,
        name: "Late owner copy",
        key: "LATE"
      })
    ).rejects.toThrow("canceled");
    expect(
      (
        await repo.shareTarget(
          ownerUser.id,
          team.id,
          workspace.id,
          input.shareAttemptKey
        )
      ).canStart
    ).toBe(false);
    expect(
      (
        await repo.shareTarget(
          otherUser.id,
          team.id,
          workspace.id,
          input.shareAttemptKey
        )
      ).canStart
    ).toBe(true);
    const otherProject = await repo.create(otherUser.id, {
      ...input,
      name: "Other member copy",
      key: "OTHER"
    });
    expect(otherProject.name).toBe("Other member copy");
    await expect(
      repo.create(ownerUser.id, {
        ...input,
        name: "Late owner copy",
        key: "LATE"
      })
    ).rejects.toThrow("canceled");
  });

  it("records a reviewed invitation handoff only for the exact current Team Project owner/version", async () => {
    const access = createTeamAccessRepository(pool);
    const teamOwner = await seedUser("Project owner");
    const admin = await seedUser("Team admin");
    const team = await access.createTeam(
      { userId: teamOwner.id },
      { name: "Share review Team" }
    );
    if (!team) throw new Error("Team fixture unavailable");
    const workspace = (
      await access.listTeamWorkspaces(
        { userId: teamOwner.id },
        { teamId: team.id, limit: 10 }
      )
    )?.find((item) => item.name === "General");
    if (!workspace) throw new Error("Workspace fixture unavailable");
    const project = await createWorkspaceProjectRepository(pool).create(
      teamOwner.id,
      {
        teamId: team.id,
        workspaceId: workspace.id,
        name: "Shared plan",
        key: "SHARE",
        shareAttemptKey: "team-first-share"
      }
    );
    await pool.query(
      "insert into team_memberships(team_id,user_id,role) values($1,$2,'admin')",
      [team.id, admin.id]
    );
    await pool.query(
      "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,can_share_owned_memory) values($1,$2,$3,'write',false)",
      [workspace.id, team.id, admin.id]
    );
    const input = {
      teamId: team.id,
      defaultTeamWorkspaceId: workspace.id,
      workspaceProjectId: project.id,
      expectedWorkspaceProjectVersion: project.version,
      defaultWorkspaceAccess: "write" as const,
      email: `${randomUUID()}@example.test`,
      role: "member" as const,
      backendOriginHash: "a".repeat(64),
      tokenHash: `invite-${randomUUID()}-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000)
    };
    expect(
      (
        await access.getTeamInviteCreationReview(
          { userId: teamOwner.id },
          {
            teamId: team.id,
            defaultTeamWorkspaceId: workspace.id,
            workspaceProjectId: project.id,
            role: "member"
          }
        )
      )?.project
    ).toMatchObject({ id: project.id, version: project.version });
    expect(
      await access.getTeamInviteCreationReview(
        { userId: admin.id },
        {
          teamId: team.id,
          defaultTeamWorkspaceId: workspace.id,
          workspaceProjectId: project.id,
          role: "member"
        }
      )
    ).toBeNull();
    expect(
      await access.createTeamInvite({ userId: admin.id }, input)
    ).toBeNull();
    expect(
      await access.createTeamInvite(
        { userId: teamOwner.id },
        { ...input, expectedWorkspaceProjectVersion: project.version + 1 }
      )
    ).toBeNull();
    const invitation = await access.createTeamInvite(
      { userId: teamOwner.id },
      input
    );
    expect(invitation).toMatchObject({
      workspaceProjectId: project.id,
      createdByUserId: teamOwner.id,
      lifecycle: "pending"
    });
    expect(
      (
        await pool.query<{ workspace_project_id: string }>(
          "select workspace_project_id from team_invites where id=$1",
          [invitation!.id]
        )
      ).rows[0]?.workspace_project_id
    ).toBe(project.id);
  });
});
