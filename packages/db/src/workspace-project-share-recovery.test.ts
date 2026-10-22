import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createPersonalWorkspaceProjectRepository } from "./personal-workspace-project-repository.js";
import {
  createWorkspaceProjectRepository,
  workspaceProjectCopyManifestHash
} from "./workspace-project-repository.js";
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
    const prepared = await repo.beginShare(owner, projectId, input);
    const snapshotVersion = (
      prepared.snapshot as {
        personalProjectVersion: number;
      }
    ).personalProjectVersion;
    expect(snapshotVersion).toBeGreaterThan(0);
    await expect(
      repo.cancelShare(owner, projectId, {
        ...input,
        expectedManifestHash: "f".repeat(64),
        expectedPersonalProjectVersion: snapshotVersion
      })
    ).rejects.toThrow("snapshot changed");
    await expect(
      repo.cancelShare(owner, projectId, {
        ...input,
        targetWorkspaceId: otherWorkspace
      })
    ).rejects.toThrow("changed");
    expect(await repo.pendingShare(owner, projectId)).toMatchObject(input);
    expect(
      await repo.cancelShare(owner, projectId, {
        ...input,
        expectedManifestHash: prepared.manifestHash,
        expectedPersonalProjectVersion: snapshotVersion
      })
    ).toEqual({
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

  it("terminalizes an exact deleted first-share copy while metadata restore stays available", async () => {
    const access = createTeamAccessRepository(pool);
    const user = await seedUser("Deleted first-share owner");
    const team = await access.createTeam(
      { userId: user.id },
      { name: "Deleted first-share Team" }
    );
    if (!team) throw new Error("Team fixture unavailable");
    const workspace = (
      await access.listTeamWorkspaces(
        { userId: user.id },
        { teamId: team.id, limit: 10 }
      )
    )?.find((item) => item.name === "General");
    if (!workspace) throw new Error("Workspace fixture unavailable");
    const repo = createWorkspaceProjectRepository(pool);
    const input = {
      teamId: team.id,
      workspaceId: workspace.id,
      name: "Deleted copy",
      key: "DELCOPY",
      shareAttemptKey: randomUUID()
    };
    const project = await repo.create(user.id, input);
    const copy = {
      expectedVersion: project.version,
      personalProjectVersion: 1,
      workItems: [],
      sources: [],
      decks: []
    };
    const manifestHash = workspaceProjectCopyManifestHash(copy);
    const copied = await repo.copyFirstShare(user.id, project.id, copy);
    const deleted = await repo.deleteProject(
      user.id,
      project.id,
      copied.version
    );
    expect(deleted).toMatchObject({ lifecycle: "deleted" });
    const scope = {
      teamId: team.id,
      workspaceId: workspace.id,
      shareAttemptKey: input.shareAttemptKey
    };
    const receipt = await repo.cancelShareAttempt(user.id, scope);
    expect(receipt).toMatchObject({
      canceled: true,
      terminalProject: {
        projectId: project.id,
        copyManifestHash: manifestHash
      }
    });
    expect(await repo.cancelShareAttempt(user.id, scope)).toEqual(receipt);
    await expect(repo.create(user.id, input)).rejects.toThrow("canceled");
    const tombstone = await repo.getOwnerTombstoneProof(user.id, project.id);
    expect(tombstone).toMatchObject({
      shareAttemptKey: input.shareAttemptKey,
      copyManifestHash: manifestHash,
      allMemberLinksDisabled: true,
      grantsFrozen: true,
      threadArchived: true
    });
    const restored = await repo.restoreProject(
      user.id,
      project.id,
      tombstone.version
    );
    expect(restored.lifecycle).toBe("active");
    expect(await repo.cancelShareAttempt(user.id, scope)).toEqual(receipt);
    await expect(repo.create(user.id, input)).rejects.toThrow("canceled");
    await expect(repo.getOwnerLinkProof(user.id, project.id)).rejects.toThrow();

    const raceTeam = await access.createTeam(
      { userId: user.id },
      { name: "Racing deleted share Team" }
    );
    if (!raceTeam) throw new Error("Race Team fixture unavailable");
    const raceWorkspace = (
      await access.listTeamWorkspaces(
        { userId: user.id },
        { teamId: raceTeam.id, limit: 10 }
      )
    )?.find((item) => item.name === "General");
    if (!raceWorkspace) throw new Error("Race Workspace fixture unavailable");
    const raceInput = {
      ...input,
      teamId: raceTeam.id,
      workspaceId: raceWorkspace.id,
      name: "Racing deleted copy",
      key: "RACEDEL",
      shareAttemptKey: randomUUID()
    };
    const racing = await repo.create(user.id, raceInput);
    const racingCopy = await repo.copyFirstShare(user.id, racing.id, {
      ...copy,
      expectedVersion: racing.version
    });
    await repo.deleteProject(user.id, racing.id, racingCopy.version);
    const racingTombstone = await repo.getOwnerTombstoneProof(
      user.id,
      racing.id
    );
    const outcomes = await Promise.allSettled([
      repo.restoreProject(user.id, racing.id, racingTombstone.version),
      repo.cancelShareAttempt(user.id, {
        teamId: raceTeam.id,
        workspaceId: raceWorkspace.id,
        shareAttemptKey: raceInput.shareAttemptKey
      })
    ]);
    expect(outcomes[0]?.status).toBe("fulfilled");
    if (outcomes[1]?.status === "fulfilled") {
      expect(outcomes[1].value.terminalProject?.projectId).toBe(racing.id);
      await expect(repo.create(user.id, raceInput)).rejects.toThrow("canceled");
    } else {
      expect(outcomes[1]?.reason).toBeInstanceOf(Error);
      expect(
        (
          await pool.query<{ count: string }>(
            `select count(*) from workspace_project_share_cancellations
            where team_id=$1 and share_attempt_key=$2`,
            [raceTeam.id, raceInput.shareAttemptKey]
          )
        ).rows[0]?.count
      ).toBe("0");
    }
  });

  it("fences a deleted Team Project before any first-share copy or delayed copy replay", async () => {
    const access = createTeamAccessRepository(pool);
    const user = await seedUser("Uncopied share owner");
    const team = await access.createTeam(
      { userId: user.id },
      { name: "Uncopied share Team" }
    );
    if (!team) throw new Error("Team fixture unavailable");
    const workspace = (
      await access.listTeamWorkspaces(
        { userId: user.id },
        { teamId: team.id, limit: 10 }
      )
    )?.find((item) => item.name === "General");
    if (!workspace) throw new Error("Workspace fixture unavailable");
    const repo = createWorkspaceProjectRepository(pool);
    const input = {
      teamId: team.id,
      workspaceId: workspace.id,
      name: "No copy before delete",
      key: "NOCOPY",
      shareAttemptKey: randomUUID()
    };
    const created = await repo.create(user.id, input);
    await repo.deleteProject(user.id, created.id, created.version);
    const receipt = await repo.cancelShareAttempt(user.id, input);
    expect(receipt.terminalProject).toEqual({
      projectId: created.id,
      copyManifestHash: null,
      copiedAt: null
    });
    const tombstone = await repo.getOwnerTombstoneProof(user.id, created.id);
    expect(tombstone).toMatchObject({
      shareAttemptKey: input.shareAttemptKey,
      copyManifestHash: null,
      copiedAt: null
    });
    const restored = await repo.restoreProject(
      user.id,
      created.id,
      tombstone.version
    );
    expect(restored.lifecycle).toBe("active");
    await expect(repo.create(user.id, input)).rejects.toThrow("canceled");
    await expect(
      repo.copyFirstShare(user.id, created.id, {
        expectedVersion: tombstone.version + 1,
        personalProjectVersion: 1,
        workItems: [],
        sources: [],
        decks: []
      })
    ).rejects.toThrow();
    expect(await repo.cancelShareAttempt(user.id, input)).toEqual(receipt);
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

  const projectBoundInvite = async (name: string) => {
    const access = createTeamAccessRepository(pool);
    const projects = createWorkspaceProjectRepository(pool);
    const teamOwner = await seedUser(`${name} owner`);
    const recipient = await seedUser(`${name} recipient`);
    const team = await access.createTeam(
      { userId: teamOwner.id },
      { name: `${name} Team` }
    );
    if (!team) throw new Error("Team fixture unavailable");
    const workspace = (
      await access.listTeamWorkspaces(
        { userId: teamOwner.id },
        { teamId: team.id, limit: 10 }
      )
    )?.find((item) => item.name === "General");
    if (!workspace) throw new Error("Workspace fixture unavailable");
    const project = await projects.create(teamOwner.id, {
      teamId: team.id,
      workspaceId: workspace.id,
      name: `${name} Project`,
      key: `INV${randomUUID().slice(0, 6).toUpperCase()}`,
      shareAttemptKey: randomUUID()
    });
    const origin = "b".repeat(64);
    const invite = await access.createTeamInvite(
      { userId: teamOwner.id },
      {
        teamId: team.id,
        defaultTeamWorkspaceId: workspace.id,
        workspaceProjectId: project.id,
        expectedWorkspaceProjectVersion: project.version,
        defaultWorkspaceAccess: "read",
        email: `${recipient.id}@example.test`,
        role: "member",
        backendOriginHash: origin,
        tokenHash: randomUUID().replaceAll("-", "").repeat(2),
        expiresAt: new Date(Date.now() + 3_600_000)
      }
    );
    if (!invite) throw new Error("Project-bound invite unavailable");
    const review = await access.getTeamInviteDecisionReview(
      { userId: recipient.id },
      {
        inviteId: invite.id,
        expectedVersion: invite.version,
        backendOriginHash: origin
      }
    );
    if (!review) throw new Error("Project-bound invite review unavailable");
    const accept = () =>
      access.acceptTeamInvite({
        inviteId: invite.id,
        userId: recipient.id,
        expectedVersion: invite.version,
        expectedBackendOriginHash: origin,
        expectedMembershipVersion: review.membershipVersion,
        expectedMembershipStatus: review.membershipStatus,
        expectedMembershipDisabledReason: review.membershipDisabledReason,
        expectedLeaveGeneration: review.leaveGeneration
      });
    return {
      access,
      projects,
      teamOwner,
      recipient,
      team,
      workspace,
      project,
      invite,
      origin,
      accept
    };
  };

  it("keeps a Project-bound invite bound and denies its reviewed acceptance after deletion", async () => {
    const binding = await projectBoundInvite("Deleted invitation");
    expect(
      await binding.projects.deleteProject(
        binding.teamOwner.id,
        binding.project.id,
        binding.project.version
      )
    ).toMatchObject({ projectId: binding.project.id, lifecycle: "deleted" });
    const persisted = await pool.query<{
      workspace_project_id: string | null;
      lifecycle: string;
    }>("select workspace_project_id,lifecycle from team_invites where id=$1", [
      binding.invite.id
    ]);
    expect(persisted.rows[0]).toMatchObject({
      workspace_project_id: binding.project.id,
      lifecycle: "pending"
    });
    expect(
      await binding.access.getTeamInviteDecisionReview(
        { userId: binding.recipient.id },
        {
          inviteId: binding.invite.id,
          expectedVersion: binding.invite.version,
          backendOriginHash: binding.origin
        }
      )
    ).toBeNull();
    expect(await binding.accept()).toBeNull();
    expect(
      await binding.access.listMyTeamInvites(
        { userId: binding.recipient.id },
        binding.origin
      )
    ).not.toContainEqual(expect.objectContaining({ id: binding.invite.id }));
    const membership = await pool.query(
      "select id from team_memberships where team_id=$1 and user_id=$2",
      [binding.team.id, binding.recipient.id]
    );
    const workspaceAccess = await pool.query(
      "select user_id from team_workspace_access_grants where team_workspace_id=$1 and user_id=$2",
      [binding.workspace.id, binding.recipient.id]
    );
    expect(membership.rows).toHaveLength(0);
    expect(workspaceAccess.rows).toHaveLength(0);
  });

  it("serializes Project deletion with invitation acceptance without downgrading the target", async () => {
    const binding = await projectBoundInvite("Racing invitation");
    const [accepted, deleted] = await Promise.all([
      binding.accept(),
      binding.projects.deleteProject(
        binding.teamOwner.id,
        binding.project.id,
        binding.project.version
      )
    ]);
    expect(deleted).toMatchObject({
      projectId: binding.project.id,
      lifecycle: "deleted"
    });
    const persisted = await pool.query<{
      workspace_project_id: string | null;
      lifecycle: string;
    }>("select workspace_project_id,lifecycle from team_invites where id=$1", [
      binding.invite.id
    ]);
    expect(persisted.rows[0]?.workspace_project_id).toBe(binding.project.id);
    expect(persisted.rows[0]?.lifecycle).toBe(
      accepted ? "accepted" : "pending"
    );
    const membership = await pool.query(
      "select id from team_memberships where team_id=$1 and user_id=$2",
      [binding.team.id, binding.recipient.id]
    );
    const workspaceAccess = await pool.query(
      "select user_id from team_workspace_access_grants where team_workspace_id=$1 and user_id=$2",
      [binding.workspace.id, binding.recipient.id]
    );
    expect(membership.rows).toHaveLength(accepted ? 1 : 0);
    expect(workspaceAccess.rows).toHaveLength(accepted ? 1 : 0);
    expect(
      await binding.access.getTeamInviteDecisionReview(
        { userId: binding.recipient.id },
        {
          inviteId: binding.invite.id,
          expectedVersion: binding.invite.version,
          backendOriginHash: binding.origin
        }
      )
    ).toBeNull();
    expect(await binding.accept()).toBeNull();
    const activeProjectMembership = await pool.query(
      `select association.team_member_id
         from workspace_project_members association
         join team_memberships membership on membership.id=association.team_member_id
        where association.workspace_project_id=$1
          and membership.user_id=$2 and association.disabled_at is null`,
      [binding.project.id, binding.recipient.id]
    );
    expect(activeProjectMembership.rows).toHaveLength(0);
  });
});
