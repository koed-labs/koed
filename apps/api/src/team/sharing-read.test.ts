import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { readTeamSharing } from "./sharing-read.js";

const actor = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const project = "33333333-3333-4333-8333-333333333333";
const team = "44444444-4444-4444-8444-444444444444";
const workspace = "55555555-5555-4555-8555-555555555555";
const member = "66666666-6666-4666-8666-666666666666";
const invitation = "77777777-7777-4777-8777-777777777777";
const now = new Date("2026-10-23T10:00:00.000Z");

const fixture = (
  role: "owner" | "admin" | "member",
  ownedByMe: boolean,
  targetRole: "owner" | "member" = "member",
  actorLinked = true
) => {
  const query = vi.fn(async (sql: string) => {
    if (
      sql.startsWith("begin") ||
      sql === "commit" ||
      sql === "rollback" ||
      sql.includes("for share of link,project,access,workspace")
    )
      return { rows: [] };
    if (sql.includes("from team_memberships m join teams"))
      return { rows: [{ team_id: team, role, owner_count: 2 }] };
    if (sql.includes("from workspace_project_sources s"))
      return {
        rows: [
          {
            id: project,
            sources: 1,
            to_dos: 2,
            chat_summaries: 1,
            shared_memory_items: 2
          }
        ]
      };
    if (sql.includes("from workspace_projects p"))
      return {
        rows: [
          {
            id: project,
            team_id: team,
            workspace_id: workspace,
            name: "Project",
            owner_team_member_id: owner,
            owner_user_id: ownedByMe ? actor : owner,
            owner_name: "Project owner",
            team_name: "Team",
            actor_role: role,
            actor_member_id: actor,
            actor_workspace_access: "write",
            actor_project_access: actorLinked ? "write" : null,
            owned_by_me: ownedByMe,
            owner_count: 2
          }
        ]
      };
    if (sql.includes("from workspace_project_members link"))
      return {
        rows: [
          {
            workspace_project_id: project,
            team_id: team,
            workspace_id: workspace,
            user_id: member,
            role: targetRole,
            display_name: "Member",
            access: "write",
            created_at: now,
            version: 1,
            actor_kind: "agent_on_behalf",
            access_mode: "full_access",
            inviter_agent_display_name: "Chief",
            granted_by_user_id: owner,
            owner_team_member_id: owner,
            member_id: member,
            personal_project_id: "must-never-escape",
            transcript: "must-never-escape"
          }
        ]
      };
    if (sql.includes("from team_invites i"))
      return {
        rows: [
          {
            id: invitation,
            team_id: team,
            workspace_project_id: project,
            default_workspace_access: "read",
            email: "Invitee",
            recipient_user_id: null,
            role: targetRole,
            created_at: now,
            actor_kind: "agent_on_behalf",
            access_mode: "ask_first",
            inviter_agent_display_name: "Chief",
            created_by_user_id: owner,
            actor_role: role,
            project_owner_user_id: ownedByMe ? actor : owner
          }
        ]
      };
    if (sql.includes("from team_workspace_access_grants grant_row"))
      return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  return {
    connect: async () => ({ query, release: vi.fn() })
  } as unknown as pg.Pool;
};

describe("Team sharing read model", () => {
  it("projects only metadata and current Project owner authority", async () => {
    const result = await readTeamSharing(fixture("member", true), actor);
    expect(result.projects[0]?.members[0]?.canRemove).toBe(true);
    expect(result.projects[0]?.members[0]?.how).toBe("direct");
    expect(result.projects[0]?.invitations[0]?.canCancel).toBe(false);
    expect(JSON.stringify(result)).not.toContain("must-never-escape");
    expect(result.projects[0]?.members[0]?.origin.agentDisplayName).toBe(
      "Chief"
    );
    expect(result.projects[0]?.contentCounts).toEqual({
      sources: 1,
      toDos: 2,
      chatSummaries: 1,
      sharedMemoryItems: 2
    });
    expect(result.projects[0]?.joinedByMe).toBe(true);
  });
  it("limits cancellation to current Team managers and owner invitations to owners", async () => {
    const admin = await readTeamSharing(
      fixture("admin", false, "owner"),
      actor
    );
    const teamOwner = await readTeamSharing(
      fixture("owner", false, "owner"),
      actor
    );
    expect(admin.invitations[0]?.canCancel).toBe(false);
    expect(teamOwner.invitations[0]?.canCancel).toBe(true);
    expect(admin.projects[0]?.members[0]?.canRemove).toBe(false);
    expect(admin.invitations[0]?.origin).toEqual({
      actorKind: null,
      accessMode: null,
      agentDisplayName: null
    });
    expect(admin.projects[0]?.members[0]?.origin).toEqual({
      actorKind: null,
      accessMode: null,
      agentDisplayName: null
    });
    const managerWithoutLink = await readTeamSharing(
      fixture("admin", false, "member", false),
      actor
    );
    expect(managerWithoutLink.projects[0]?.joinedByMe).toBe(false);
  });
});
