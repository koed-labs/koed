import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createTeamAccessRepository } from "./team-access-repository.js";
import { createPersonalShareOriginRepository } from "./personal-share-origin-repository.js";

const testUrl = process.env.KOED_HQ721_TEST_DATABASE_URL;

describe.skipIf(!testUrl)("HQ-721 invitation Share Origin", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  const owner = randomUUID();
  const recipient = randomUUID();
  const team = randomUUID();
  const workspace = randomUUID();
  const conversation = randomUUID();
  const backendA = "team-backend-a";
  const backendB = "team-backend-b";
  const originHash = "a".repeat(64);

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq721_origin_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${database}"`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
      owner,
      `${owner}@example.test`,
      recipient,
      `${recipient}@example.test`
    ]);
    await pool.query("insert into teams(id,name) values($1,'Origin Team')", [
      team
    ]);
    await pool.query(
      "insert into team_memberships(team_id,user_id,role,status,leave_generation) values($1,$2,'owner','enabled',0)",
      [team, owner]
    );
    await pool.query(
      "insert into team_workspaces(id,team_id,name) values($1,$2,'Origin Workspace')",
      [workspace, team]
    );
    await pool.query(
      "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,can_share_owned_memory,granted_by_user_id) values($1,$2,$3,'write',true,$3)",
      [workspace, team, owner]
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database if exists "${database}" with (force)`);
    await admin?.end();
  });

  it("keeps the chat local through invitation acceptance, later re-grant, and backend collision", async () => {
    const teamRepo = createTeamAccessRepository(pool);
    const personal = createPersonalShareOriginRepository(pool);
    const invite = await teamRepo.createTeamInvite(
      { userId: owner },
      {
        teamId: team,
        defaultTeamWorkspaceId: workspace,
        defaultWorkspaceAccess: "write",
        email: `${recipient}@example.test`,
        role: "member",
        backendOriginHash: originHash,
        tokenHash: randomUUID().replaceAll("-", "").repeat(2),
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterAgentDisplayName: "Cooper",
        actorKind: "agent_on_behalf",
        accessMode: "full_access"
      }
    );
    expect(invite).not.toBeNull();
    await personal.recordInvitation({
      ownerUserId: owner,
      teamBackendId: backendA,
      inviteId: invite!.id,
      source: { originKind: "conversation", conversationId: conversation }
    });
    const accepted = await teamRepo.acceptTeamInvite({
      inviteId: invite!.id,
      userId: recipient,
      expectedVersion: invite!.version,
      expectedBackendOriginHash: originHash
    });
    expect(accepted?.invite.resultingAccessGrantVersion).toBe(1);
    const access = await pool.query<{
      actor_kind: string;
      access_mode: string;
      version: number;
    }>(
      "select actor_kind,access_mode,version from team_workspace_access_grants where team_workspace_id=$1 and user_id=$2",
      [workspace, recipient]
    );
    expect(access.rows[0]).toMatchObject({
      actor_kind: "agent_on_behalf",
      access_mode: "full_access",
      version: 1
    });
    expect(
      await personal.linkAcceptedInvitation({
        ownerUserId: owner,
        teamBackendId: backendA,
        inviteId: invite!.id,
        teamWorkspaceId: workspace,
        teamUserId: recipient,
        accessGrantVersion: accepted!.invite.resultingAccessGrantVersion!
      })
    ).toBe(true);
    const later = await teamRepo.setTeamWorkspaceAccess(
      { userId: owner },
      {
        teamWorkspaceId: workspace,
        userId: recipient,
        access: "read",
        expectedVersion: access.rows[0]!.version,
        actorKind: "person"
      }
    );
    expect(later?.version).toBe(2);
    await personal.recordWorkspaceAccess({
      ownerUserId: owner,
      teamBackendId: backendA,
      teamWorkspaceId: workspace,
      teamUserId: recipient,
      accessGrantVersion: 2,
      source: { originKind: "share_window" }
    });
    await personal.recordInvitation({
      ownerUserId: owner,
      teamBackendId: backendB,
      inviteId: invite!.id,
      source: { originKind: "share_window" }
    });
    const origins = await pool.query<{
      team_backend_id: string;
      target_kind: string;
      origin_kind: string;
      access_grant_version: number | null;
      conversation_id: string | null;
      source_invite_id: string | null;
    }>(
      "select team_backend_id,target_kind,origin_kind,access_grant_version,conversation_id,source_invite_id from share_origins where owner_user_id=$1 order by team_backend_id,target_kind,access_grant_version",
      [owner]
    );
    expect(origins.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          team_backend_id: backendA,
          target_kind: "invitation",
          conversation_id: conversation
        }),
        expect.objectContaining({
          team_backend_id: backendA,
          target_kind: "workspace_access",
          access_grant_version: 1,
          conversation_id: conversation,
          source_invite_id: invite!.id
        }),
        expect.objectContaining({
          team_backend_id: backendA,
          target_kind: "workspace_access",
          access_grant_version: 2,
          origin_kind: "share_window",
          conversation_id: null
        }),
        expect.objectContaining({
          team_backend_id: backendB,
          target_kind: "invitation",
          origin_kind: "share_window",
          conversation_id: null
        })
      ])
    );
    const teamColumns = await pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name in ('team_invites','team_workspace_access_grants') and column_name='conversation_id'"
    );
    expect(teamColumns.rows).toEqual([]);
  }, 30_000);

  it("rejects malformed typed targets and preserves unknown historical actor values", async () => {
    const oldGrant = await pool.query<{
      actor_kind: string | null;
      access_mode: string | null;
    }>(
      "select actor_kind,access_mode from team_workspace_access_grants where team_workspace_id=$1 and user_id=$2",
      [workspace, owner]
    );
    expect(oldGrant.rows[0]).toEqual({ actor_kind: null, access_mode: null });
    await expect(
      pool.query(
        "insert into share_origins(owner_user_id,team_backend_id,target_kind,invite_id,team_workspace_id,origin_kind) values($1,'team-vps','invitation',$2,$3,'share_window')",
        [owner, randomUUID(), workspace]
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "insert into share_origins(owner_user_id,team_backend_id,target_kind,team_workspace_id,team_user_id,origin_kind) values($1,'team-vps','workspace_access',$2,$3,'share_window')",
        [owner, workspace, recipient]
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "update team_workspace_access_grants set actor_kind='agent_on_behalf',access_mode=null where team_workspace_id=$1 and user_id=$2",
        [workspace, owner]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });
});
