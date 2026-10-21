import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorkspaceProjectRepository,
  WorkspaceProjectUnavailableError
} from "./workspace-project-repository.js";
import { runDbMigrations } from "./migrate.js";
import { createTeamAccessRepository } from "./team-access-repository.js";

const testUrl = process.env.KOED_HQ712_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("Workspace Project Team state", () => {
  let pool: pg.Pool;
  let repo: ReturnType<typeof createWorkspaceProjectRepository>;
  const teamId = randomUUID(),
    workspaceId = randomUUID();
  const alice = randomUUID(),
    bob = randomUUID();
  const aliceMember = randomUUID(),
    bobMember = randomUUID();
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await runDbMigrations(pool);
    repo = createWorkspaceProjectRepository(pool);
    await pool.query("insert into users(id,email) values ($1,$2),($3,$4)", [
      alice,
      alice + "@example.test",
      bob,
      bob + "@example.test"
    ]);
    await pool.query("insert into teams(id,name) values ($1,'Project Team')", [
      teamId
    ]);
    await pool.query(
      "insert into team_memberships(id,team_id,user_id,role) values ($1,$3,$4,'member'),($2,$3,$5,'member')",
      [aliceMember, bobMember, teamId, alice, bob]
    );
    await pool.query(
      "insert into team_workspaces(id,team_id,name) values ($1,$2,'Shared Project')",
      [workspaceId, teamId]
    );
    await pool.query(
      "insert into team_workspace_access_grants (team_workspace_id,team_id,user_id,access,can_share_owned_memory) values ($1,$2,$3,'write',true),($1,$2,$4,'write',true)",
      [workspaceId, teamId, alice, bob]
    );
  }, 120_000);
  afterAll(async () => {
    if (!pool) return;
    await pool.query("delete from collaboration_outbox where team_id=$1", [
      teamId
    ]);
    for (const table of [
      "workspace_project_activity",
      "workspace_project_work_items",
      "workspace_project_sources",
      "workspace_project_members"
    ]) {
      await pool.query(
        "delete from " +
          table +
          " where workspace_project_id in (select id from workspace_projects where team_id=$1)",
        [teamId]
      );
    }
    await pool.query("delete from workspace_projects where team_id=$1", [
      teamId
    ]);
    await pool.query("delete from collaboration_threads where team_id=$1", [
      teamId
    ]);
    await pool.query(
      "delete from team_workspace_access_grants where team_id=$1",
      [teamId]
    );
    await pool.query("delete from team_workspaces where team_id=$1", [teamId]);
    await pool.query("delete from team_memberships where team_id=$1", [teamId]);
    await pool.query("delete from teams where id=$1", [teamId]);
    await pool.query("delete from users where id in ($1,$2)", [alice, bob]);
    await pool.end();
  });
  it("shares state between two members without promoting the Project owner", async () => {
    const attempt = {
      teamId,
      workspaceId,
      name: "Atlas",
      key: "ATL",
      shareAttemptKey: "first-share-atlas"
    };
    expect(
      (
        await repo.shareTarget(
          alice,
          teamId,
          workspaceId,
          attempt.shareAttemptKey
        )
      ).canStart
    ).toBe(true);
    const project = await repo.create(alice, attempt);
    expect(
      (
        await repo.shareTarget(
          alice,
          teamId,
          workspaceId,
          attempt.shareAttemptKey
        )
      ).canStart
    ).toBe(true);
    expect(
      (
        await repo.shareTarget(
          alice,
          teamId,
          workspaceId,
          "different-share-key"
        )
      ).canStart
    ).toBe(false);
    expect(project.ownerTeamMemberId).toBe(aliceMember);
    expect(await repo.create(alice, attempt)).toEqual(project);
    await repo.join(bob, project.id);
    const roster = await repo.members(alice, project.id);
    expect(roster.people.map((person) => person.teamMemberId).sort()).toEqual(
      [aliceMember, bobMember].sort()
    );
    expect(roster.people).toHaveLength(2);
    await repo.copyFirstShare(alice, project.id, {
      personalProjectVersion: 1,
      expectedVersion: 1,
      workItems: [
        {
          id: randomUUID(),
          kind: "todo",
          title: "Ship",
          goal: "Ship feature",
          status: "todo"
        }
      ],
      sources: []
    });
    const [item] = (await repo.listWorkItems(bob, project.id, { offset: 0 }))
      .items;
    expect(item).toBeDefined();
    const updated = await repo.patchWorkItem(
      bob,
      project.id,
      String(item!.id),
      {
        expectedVersion: 1,
        title: "Ship safely"
      }
    );
    expect(updated?.title).toBe("Ship safely");
    expect(
      (await repo.listWorkItems(alice, project.id, { offset: 0 })).items[0]
        ?.title
    ).toBe("Ship safely");
    const lifecycle = await repo.lifecycle(bob, project.id);
    expect(
      await repo.assertDispatch(
        bob,
        project.id,
        lifecycle.version,
        lifecycle.memberVersion
      )
    ).toMatchObject({ allowed: true });
    const proof = await repo.dispatchProof(bob, project.id, item!.id, {
      expectedProjectVersion: lifecycle.version,
      expectedMemberVersion: lifecycle.memberVersion,
      expectedWorkItemVersion: updated.version
    });
    expect(proof).toMatchObject({
      itemId: item!.id,
      title: "Ship safely",
      projectVersion: lifecycle.version
    });
    await expect(
      repo.assertDispatch(
        bob,
        project.id,
        lifecycle.version,
        lifecycle.memberVersion + 1
      )
    ).rejects.toHaveProperty("current");
    await expect(
      repo.patchWorkItem(alice, project.id, String(item!.id), {
        expectedVersion: 1,
        title: "Overwrite"
      })
    ).rejects.toMatchObject({ current: { title: "Ship safely", version: 2 } });
    const role = await pool.query<{ role: string }>(
      "select role from team_memberships where id=$1",
      [aliceMember]
    );
    expect(role.rows[0]?.role).toBe("member");
    const events = await pool.query<{
      family: string;
      scope: string;
      team_workspace_id: string;
    }>(
      "select family,scope,team_workspace_id from collaboration_outbox where team_id=$1 and resource_type like 'workspace_project%'",
      [teamId]
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(4);
    expect(
      events.rows.every(
        (event) =>
          event.family === "workspace_lifecycle_access" &&
          event.scope === "team" &&
          event.team_workspace_id === workspaceId
      )
    ).toBe(true);
  });
  it("denies an unrelated User who knows the Project ID", async () => {
    const project = (await repo.list(alice, teamId))[0]!;
    const stranger = randomUUID();
    await pool.query("insert into users(id,email) values ($1,$2)", [
      stranger,
      stranger + "@example.test"
    ]);
    await expect(repo.get(stranger, project.id)).rejects.toBeInstanceOf(
      WorkspaceProjectUnavailableError
    );
    await pool.query("delete from users where id=$1", [stranger]);
  });
  it("keeps Source metadata shared while only uploader or Project owner may edit", async () => {
    const project = (await repo.list(alice, teamId))[0]!;
    await expect(
      repo.createSource(bob, project.id, {
        sourceProjectSourceId: randomUUID(),
        name: "Broken",
        kind: "doc",
        status: "ready",
        personalNoteId: null,
        personalNoteRevisionId: randomUUID()
      })
    ).rejects.toBeInstanceOf(WorkspaceProjectUnavailableError);
    const source = await repo.createSource(bob, project.id, {
      sourceProjectSourceId: randomUUID(),
      name: "Plan",
      kind: "doc",
      status: "ready",
      personalNoteId: randomUUID(),
      personalNoteRevisionId: randomUUID()
    });
    expect(
      (await repo.listSources(alice, project.id, { offset: 0 })).items.some(
        (row) => row.id === source.id
      )
    ).toBe(true);
    await expect(
      repo.patchSource(bob, project.id, source.id, {
        expectedVersion: source.version + 1,
        name: "Old"
      })
    ).rejects.toHaveProperty("current");
    const renamed = await repo.patchSource(bob, project.id, source.id, {
      expectedVersion: source.version,
      name: "Plan v2"
    });
    expect(renamed.name).toBe("Plan v2");
    const replacement = await repo.patchSource(bob, project.id, source.id, {
      expectedVersion: renamed.version,
      personalNoteId: randomUUID(),
      personalNoteRevisionId: randomUUID()
    });
    expect(replacement.personalNoteId).not.toBe(source.personalNoteId);
    await expect(
      repo.patchSource(alice, project.id, source.id, {
        expectedVersion: replacement.version,
        deleted: true
      })
    ).rejects.toBeInstanceOf(WorkspaceProjectUnavailableError);
    expect(
      (await repo.listSources(bob, project.id, { offset: 0 })).items.some(
        (row) => row.id === source.id
      )
    ).toBe(true);
  });
  it("aggregates Team Work Item and reviewed PR outcomes without Personal activity", async () => {
    const project = (await repo.list(alice, teamId))[0]!;
    const [item] = (await repo.listWorkItems(alice, project.id, { offset: 0 }))
      .items;
    const done = await repo.patchWorkItem(alice, project.id, item!.id, {
      expectedVersion: item!.version,
      status: "done"
    });
    expect(done.doneAt).toBeTruthy();
    const reviewItem = await repo.createWorkItem(alice, project.id, {
      idempotencyKey: "review-outcome-test",
      kind: "todo",
      title: "Review PR",
      goal: "Review PR",
      status: "todo"
    });
    const dispatchKey = `shared-work-item:${project.id}:${reviewItem.id}:${reviewItem.version}`;
    const receipt = await repo.dispatchReceipt(
      alice,
      project.id,
      reviewItem.id,
      {
        expectedVersion: reviewItem.version,
        dispatchKey
      }
    );
    expect(
      await repo.dispatchStatus(alice, project.id, reviewItem.id, dispatchKey)
    ).toMatchObject({
      id: reviewItem.id,
      version: receipt.version,
      status: "doing",
      dispatchKey
    });
    await expect(
      repo.dispatchStatus(bob, project.id, reviewItem.id, dispatchKey)
    ).rejects.toBeInstanceOf(WorkspaceProjectUnavailableError);
    const opened = await repo.dispatchProgress(
      alice,
      project.id,
      reviewItem.id,
      {
        expectedVersion: receipt.version,
        dispatchKey,
        status: "review",
        stepLabel: "Pull request open",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open"
      }
    );
    const merged = await repo.dispatchProgress(
      alice,
      project.id,
      reviewItem.id,
      {
        expectedVersion: opened.version,
        dispatchKey,
        status: "done",
        stepLabel: "Pull request merged",
        prState: "merged"
      }
    );
    expect(
      await repo.dispatchStatus(alice, project.id, reviewItem.id, dispatchKey)
    ).toMatchObject({
      version: merged.version,
      status: "done",
      prState: "merged"
    });
    const summary = await repo.activitySummary(bob, project.id);
    expect(summary.days).toHaveLength(7);
    expect(summary.done).toBe(2);
    expect(summary.merged).toBe(1);
    expect(summary.days.reduce((total, day) => total + day.count, 0)).toBe(3);
  });
  it("serializes a shared write behind Team membership revocation", async () => {
    const project = (await repo.list(alice, teamId))[0]!;
    const [item] = (await repo.listWorkItems(bob, project.id, { offset: 0 }))
      .items;
    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from teams where id=$1 for update", [
        teamId
      ]);
      const write = repo.patchWorkItem(bob, project.id, String(item!.id), {
        expectedVersion: Number(item!.version),
        title: "Revoked write"
      });
      await blocker.query(
        `update team_memberships
        set status='disabled',disabled_at=now(),version=version+1 where id=$1`,
        [bobMember]
      );
      await blocker.query("commit");
      await expect(write).rejects.toBeInstanceOf(
        WorkspaceProjectUnavailableError
      );
      const unchanged = await repo.listWorkItems(alice, project.id, {
        offset: 0
      });
      expect(unchanged.items[0]?.title).toBe(item!.title);
      await pool.query(
        `update team_memberships
        set status='enabled',disabled_at=null,version=version+1 where id=$1`,
        [bobMember]
      );
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
  });
  it("allows only a non-owner to self-leave and preserves Team membership", async () => {
    const project = (await repo.list(alice, teamId))[0]!;
    await pool.query(
      "update workspace_project_members set access='read',version=version+1 where workspace_project_id=$1 and team_member_id=$2",
      [project.id, bobMember]
    );
    await pool.query(
      "update team_workspace_access_grants set access='read',can_share_owned_memory=false,version=version+1 where team_workspace_id=$1 and user_id=$2",
      [workspaceId, bob]
    );
    const [readItem] = (
      await repo.listWorkItems(bob, project.id, { offset: 0 })
    ).items;
    const readLifecycle = await repo.lifecycle(bob, project.id);
    await expect(
      repo.dispatchProof(bob, project.id, readItem!.id, {
        expectedProjectVersion: readLifecycle.version,
        expectedMemberVersion: readLifecycle.memberVersion,
        expectedWorkItemVersion: readItem!.version
      })
    ).rejects.toBeInstanceOf(WorkspaceProjectUnavailableError);
    const ownerState = await repo.lifecycle(alice, project.id);
    await expect(
      repo.leave(alice, project.id, {
        expectedProjectVersion: ownerState.version,
        expectedMemberVersion: ownerState.memberVersion
      })
    ).rejects.toBeInstanceOf(WorkspaceProjectUnavailableError);
    const state = await repo.lifecycle(bob, project.id);
    await repo.leave(bob, project.id, {
      expectedProjectVersion: state.version,
      expectedMemberVersion: state.memberVersion
    });
    expect((await repo.lifecycle(bob, project.id)).active).toBe(false);
    expect((await repo.lifecycle(alice, project.id)).active).toBe(true);
    const member = await pool.query<{ status: string }>(
      "select status from team_memberships where id=$1",
      [bobMember]
    );
    expect(member.rows[0]?.status).toBe("enabled");
    const access = await pool.query<{ access: string }>(
      "select access from team_workspace_access_grants where team_workspace_id=$1 and user_id=$2",
      [workspaceId, bob]
    );
    expect(access.rows[0]?.access).toBe("disabled");
    await expect(repo.join(bob, project.id)).rejects.toBeInstanceOf(
      WorkspaceProjectUnavailableError
    );
  });
  it("Team leave tombstones an owned Project for every member while retaining their Workspace Access", async () => {
    const project = (await repo.list(alice, teamId))[0]!;
    await pool.query("update team_memberships set role='owner' where id=$1", [
      bobMember
    ]);
    await pool.query(
      "update workspace_project_members set access='write',disabled_at=null,version=version+1 where workspace_project_id=$1 and team_member_id=$2",
      [project.id, bobMember]
    );
    await pool.query(
      "update team_workspace_access_grants set access='write',disabled_at=null,can_share_owned_memory=true where team_workspace_id=$1 and user_id=$2",
      [workspaceId, bob]
    );
    const threadId = randomUUID();
    await pool.query(
      "insert into collaboration_threads (id,scope,kind,team_id,team_workspace_id,system_key) values ($1,'team','workspace_channel',$2,$3,'workspace.general')",
      [threadId, teamId, workspaceId]
    );
    const accessRepo = createTeamAccessRepository(pool);
    const review = await accessRepo.getTeamLeaveReview(
      { userId: alice },
      teamId
    );
    expect(review?.ownedWorkspaceProjects).toEqual([
      { id: project.id, version: project.version }
    ]);
    await expect(
      accessRepo.leaveTeam(
        { userId: alice },
        {
          teamId,
          expectedVersion: review!.membership.version,
          expectedTeamVersion: review!.team.version,
          expectedOwnedWorkspaceProjects: [
            { id: project.id, version: project.version + 1 }
          ]
        }
      )
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(
      (
        await pool.query<{ lifecycle: string }>(
          "select lifecycle from workspace_projects where id=$1",
          [project.id]
        )
      ).rows[0]?.lifecycle
    ).toBe("active");
    const left = await accessRepo.leaveTeam(
      { userId: alice },
      {
        teamId,
        expectedVersion: review!.membership.version,
        expectedTeamVersion: review!.team.version,
        expectedOwnedWorkspaceProjects: review!.ownedWorkspaceProjects
      }
    );
    expect(left?.status).toBe("disabled");
    const tombstone = await pool.query<{ lifecycle: string }>(
      "select lifecycle from workspace_projects where id=$1",
      [project.id]
    );
    expect(tombstone.rows[0]?.lifecycle).toBe("deleted");
    const links = await pool.query<{ access: string }>(
      "select access from workspace_project_members where workspace_project_id=$1",
      [project.id]
    );
    expect(links.rows.every((link) => link.access === "disabled")).toBe(true);
    const bobAccess = await pool.query<{ access: string }>(
      "select access from team_workspace_access_grants where team_workspace_id=$1 and user_id=$2",
      [workspaceId, bob]
    );
    expect(bobAccess.rows[0]?.access).toBe("write");
    const thread = await pool.query<{ lifecycle: string }>(
      "select lifecycle from collaboration_threads where id=$1",
      [threadId]
    );
    expect(thread.rows[0]?.lifecycle).toBe("archived");
    await pool.query("delete from collaboration_threads where id=$1", [
      threadId
    ]);
  });
  it("preflights the last Team owner before access or membership mutation", async () => {
    const accessRepo = createTeamAccessRepository(pool);
    const review = await accessRepo.getTeamLeaveReview({ userId: bob }, teamId);
    expect(review?.activeOwnerCount).toBe(1);
    const result = await accessRepo.leaveTeam(
      { userId: bob },
      {
        teamId,
        expectedVersion: review!.membership.version,
        expectedOwnedWorkspaceProjects: []
      }
    );
    expect(result).toBeNull();
    const member = await pool.query<{ status: string }>(
      "select status from team_memberships where id=$1",
      [bobMember]
    );
    expect(member.rows[0]?.status).toBe("enabled");
    const access = await pool.query<{ access: string }>(
      "select access from team_workspace_access_grants where team_workspace_id=$1 and user_id=$2",
      [workspaceId, bob]
    );
    expect(access.rows[0]?.access).toBe("write");
  });
});
