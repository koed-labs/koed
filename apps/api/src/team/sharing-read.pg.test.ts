import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "@koed/db";
import { readTeamSharing } from "./sharing-read.js";

const testUrl = process.env.KOED_HQ722_TEST_DATABASE_URL;

describe.skipIf(!testUrl)("HQ-722 Team sharing read in Postgres", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  const team = randomUUID();
  const workspace = randomUUID();
  const project = randomUUID();
  const teamOwner = randomUUID();
  const teamAdmin = randomUUID();
  const projectOwner = randomUUID();
  const member = randomUUID();
  const ownerInvite = randomUUID();
  const memberInvite = randomUUID();

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq722_read_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${database}"`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    for (const user of [teamOwner, teamAdmin, projectOwner, member])
      await pool.query(
        "insert into users(id,email,display_name) values($1,$2,$3)",
        [
          user,
          `${user}@example.test`,
          user === projectOwner ? "Project owner" : "Member"
        ]
      );
    await pool.query("insert into teams(id,name) values($1,'Sharing Team')", [
      team
    ]);
    const memberIds = new Map<string, string>();
    for (const [user, role] of [
      [teamOwner, "owner"],
      [teamAdmin, "admin"],
      [projectOwner, "member"],
      [member, "member"]
    ] as const) {
      const id = randomUUID();
      memberIds.set(user, id);
      await pool.query(
        "insert into team_memberships(id,team_id,user_id,role,status,leave_generation) values($1,$2,$3,$4,'enabled',0)",
        [id, team, user, role]
      );
    }
    await pool.query(
      "insert into team_workspaces(id,team_id,name) values($1,$2,'Project Workspace')",
      [workspace, team]
    );
    for (const user of [teamOwner, teamAdmin, projectOwner, member])
      await pool.query(
        "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,can_share_owned_memory,granted_by_user_id) values($1,$2,$3,'write',true,$3)",
        [workspace, team, user]
      );
    await pool.query(
      "insert into workspace_projects(id,team_id,workspace_id,owner_team_member_id,name,key,share_attempt_key) values($1,$2,$3,$4,'Project','project','attempt')",
      [project, team, workspace, memberIds.get(projectOwner)]
    );
    for (const user of [projectOwner, member])
      await pool.query(
        "insert into workspace_project_members(workspace_project_id,team_member_id,access) values($1,$2,'write')",
        [project, memberIds.get(user)]
      );
    for (const [id, role] of [
      [ownerInvite, "owner"],
      [memberInvite, "member"]
    ] as const)
      await pool.query(
        "insert into team_invites(id,team_id,default_team_workspace_id,workspace_project_id,default_workspace_access,email,normalized_email,role,backend_origin_hash,token_hash,created_by_user_id,expires_at,actor_kind,access_mode,inviter_agent_display_name) values($1,$2,$3,$4,'read',$5,$5,$6,$7,$8,$9,now()+interval '1 day','agent_on_behalf','ask_first','Chief')",
        [
          id,
          team,
          workspace,
          project,
          `${id}@example.test`,
          role,
          "a".repeat(64),
          randomUUID(),
          teamOwner
        ]
      );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database if exists "${database}" with (force)`);
    await admin?.end();
  });

  it("uses Team membership authority, Project owner visibility and metadata-only output", async () => {
    const byProjectOwner = await readTeamSharing(pool, projectOwner);
    const byAdmin = await readTeamSharing(pool, teamAdmin);
    const byTeamOwner = await readTeamSharing(pool, teamOwner);
    expect(byProjectOwner.projects[0]?.ownedByMe).toBe(true);
    expect(
      byProjectOwner.projects[0]?.members.find(
        (item) => item.person.id === member
      )?.how
    ).toBe("direct");
    expect(
      byTeamOwner.projects[0]?.members.some(
        (item) => item.person.id === teamOwner || item.person.id === teamAdmin
      )
    ).toBe(false);
    expect(
      byProjectOwner.projects[0]?.members.find(
        (item) => item.person.id === member
      )?.canRemove
    ).toBe(true);
    expect(
      byProjectOwner.invitations.every((item) => item.canCancel === false)
    ).toBe(true);
    expect(
      byAdmin.invitations.find((item) => item.id === ownerInvite)?.canCancel
    ).toBe(false);
    expect(
      byAdmin.invitations.find((item) => item.id === memberInvite)?.canCancel
    ).toBe(true);
    expect(
      byTeamOwner.invitations.find((item) => item.id === ownerInvite)?.canCancel
    ).toBe(true);
    expect(
      byAdmin.invitations.find((item) => item.id === memberInvite)?.origin
        .agentDisplayName
    ).toBeNull();
    expect(
      byProjectOwner.invitations.find((item) => item.id === memberInvite)
        ?.origin.agentDisplayName
    ).toBe("Chief");
    expect(JSON.stringify(byProjectOwner)).not.toMatch(
      /conversationId|transcript|personalProjectId|tokenHash/
    );
  });
});
