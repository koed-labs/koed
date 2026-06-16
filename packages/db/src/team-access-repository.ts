import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { KoedDb } from "./connection.js";
import {
  teamMemberships,
  teams,
  teamWorkspaceAccessGrants,
  teamWorkspaces
} from "./schema.js";
import type {
  ActorContext,
  TeamMembershipRecord,
  TeamMembershipStatus,
  TeamRecord,
  TeamRole,
  TeamWorkspaceAccessLevel,
  TeamWorkspaceAccessRecord,
  TeamWorkspaceRecord
} from "./types.js";

const timestampIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const mapTeamRecord = (row: {
  id: string;
  name: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  archivedAt: Date | string | null;
}): TeamRecord => ({
  id: row.id,
  name: row.name,
  createdAt: timestampIso(row.createdAt),
  updatedAt: timestampIso(row.updatedAt),
  archivedAt: row.archivedAt ? timestampIso(row.archivedAt) : null
});

const mapMembershipRecord = (row: {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  status: TeamMembershipStatus;
  createdAt: Date | string;
  updatedAt: Date | string;
  acceptedAt: Date | string | null;
  disabledAt: Date | string | null;
}): TeamMembershipRecord => ({
  id: row.id,
  teamId: row.teamId,
  userId: row.userId,
  role: row.role,
  status: row.status,
  createdAt: timestampIso(row.createdAt),
  updatedAt: timestampIso(row.updatedAt),
  acceptedAt: row.acceptedAt ? timestampIso(row.acceptedAt) : null,
  disabledAt: row.disabledAt ? timestampIso(row.disabledAt) : null
});

const mapWorkspaceRecord = (row: {
  id: string;
  teamId: string;
  name: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  archivedAt: Date | string | null;
}): TeamWorkspaceRecord => ({
  id: row.id,
  teamId: row.teamId,
  name: row.name,
  createdAt: timestampIso(row.createdAt),
  updatedAt: timestampIso(row.updatedAt),
  archivedAt: row.archivedAt ? timestampIso(row.archivedAt) : null
});

const membershipManages = (
  membership:
    | { role: TeamRole; status: TeamMembershipStatus; disabledAt: unknown }
    | null
    | undefined
) =>
  Boolean(
    membership &&
    membership.status === "enabled" &&
    membership.disabledAt === null &&
    (membership.role === "owner" || membership.role === "admin")
  );

const accessRank = (access: TeamWorkspaceAccessLevel): number => {
  if (access === "write") return 2;
  if (access === "read") return 1;
  return 0;
};

const buildAccessRecord = (row: {
  teamWorkspaceId: string;
  teamId: string;
  userId: string;
  role: TeamRole | null;
  membershipStatus: TeamMembershipStatus | null;
  membershipDisabledAt: Date | string | null;
  teamArchivedAt: Date | string | null;
  workspaceArchivedAt: Date | string | null;
  access: TeamWorkspaceAccessLevel | null;
}): TeamWorkspaceAccessRecord => {
  const workspaceActive = !row.teamArchivedAt && !row.workspaceArchivedAt;
  const membershipEnabled =
    workspaceActive &&
    row.membershipStatus === "enabled" &&
    row.membershipDisabledAt === null;
  const access = membershipEnabled ? (row.access ?? "disabled") : "disabled";
  const canManageTeam =
    membershipEnabled && (row.role === "owner" || row.role === "admin");
  const canRecall = accessRank(access) >= accessRank("read");
  const canCreateShare = access === "write";
  const canManageWorkspace = canManageTeam && access === "write";

  return {
    teamWorkspaceId: row.teamWorkspaceId,
    teamId: row.teamId,
    userId: row.userId,
    role: row.role,
    membershipStatus: row.membershipStatus,
    access,
    canManageTeam,
    canManageWorkspace,
    canRecall,
    canCreateShare
  };
};

export const createTeamAccessRepository = (db: KoedDb) => {
  const getManagingMembership = async (actor: ActorContext, teamId: string) => {
    const rows = await db
      .select()
      .from(teamMemberships)
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .where(
        and(
          eq(teamMemberships.teamId, teamId),
          eq(teamMemberships.userId, actor.userId),
          inArray(teamMemberships.role, ["owner", "admin"]),
          eq(teamMemberships.status, "enabled"),
          isNull(teams.archivedAt)
        )
      )
      .limit(1);

    return rows[0]?.team_memberships ?? null;
  };

  const getTeamWorkspaceAccess = async (
    actor: ActorContext,
    teamWorkspaceId: string
  ): Promise<TeamWorkspaceAccessRecord | null> => {
    const rows = await db
      .select({
        teamWorkspaceId: teamWorkspaces.id,
        teamId: teamWorkspaces.teamId,
        userId: sql<string>`${actor.userId}`,
        role: teamMemberships.role,
        membershipStatus: teamMemberships.status,
        membershipDisabledAt: teamMemberships.disabledAt,
        teamArchivedAt: teams.archivedAt,
        workspaceArchivedAt: teamWorkspaces.archivedAt,
        access: teamWorkspaceAccessGrants.access
      })
      .from(teamWorkspaces)
      .innerJoin(teams, eq(teams.id, teamWorkspaces.teamId))
      .leftJoin(
        teamMemberships,
        and(
          eq(teamMemberships.teamId, teamWorkspaces.teamId),
          eq(teamMemberships.userId, actor.userId)
        )
      )
      .leftJoin(
        teamWorkspaceAccessGrants,
        and(
          eq(teamWorkspaceAccessGrants.teamWorkspaceId, teamWorkspaces.id),
          eq(teamWorkspaceAccessGrants.teamId, teamWorkspaces.teamId),
          eq(teamWorkspaceAccessGrants.userId, actor.userId)
        )
      )
      .where(eq(teamWorkspaces.id, teamWorkspaceId))
      .limit(1);

    const row = rows[0];
    if (!row || !row.role || !row.membershipStatus) {
      return null;
    }

    return buildAccessRecord(row);
  };

  return {
    async createTeam(
      actor: ActorContext,
      input: { name: string }
    ): Promise<TeamRecord> {
      return db.transaction(async (tx) => {
        const teamRows = await tx
          .insert(teams)
          .values({ name: input.name })
          .returning();
        const team = teamRows[0]!;

        await tx.insert(teamMemberships).values({
          teamId: team.id,
          userId: actor.userId,
          role: "owner",
          status: "enabled",
          acceptedAt: sql`now()`
        });

        return mapTeamRecord(team);
      });
    },

    async getTeamMembership(
      actor: ActorContext,
      teamId: string
    ): Promise<TeamMembershipRecord | null> {
      const rows = await db
        .select()
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, teamId),
            eq(teamMemberships.userId, actor.userId)
          )
        )
        .limit(1);

      return rows[0] ? mapMembershipRecord(rows[0]) : null;
    },

    async upsertTeamMember(
      actor: ActorContext,
      input: {
        teamId: string;
        userId: string;
        role: TeamRole;
        status?: TeamMembershipStatus;
      }
    ): Promise<TeamMembershipRecord | null> {
      const manager = await getManagingMembership(actor, input.teamId);
      if (!membershipManages(manager)) {
        return null;
      }
      if (input.role === "owner" && manager!.role !== "owner") {
        return null;
      }

      const status = input.status ?? "enabled";
      const existing = await db
        .select()
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, input.teamId),
            eq(teamMemberships.userId, input.userId)
          )
        )
        .limit(1);
      if (existing[0]?.role === "owner" && manager!.role !== "owner") {
        return null;
      }

      const rows = await db
        .insert(teamMemberships)
        .values({
          teamId: input.teamId,
          userId: input.userId,
          role: input.role,
          status,
          acceptedAt: status === "enabled" ? sql`now()` : null,
          disabledAt: status === "disabled" ? sql`now()` : null
        })
        .onConflictDoUpdate({
          target: [teamMemberships.teamId, teamMemberships.userId],
          set: {
            role: input.role,
            status,
            updatedAt: sql`now()`,
            acceptedAt:
              status === "enabled"
                ? sql`coalesce(${teamMemberships.acceptedAt}, now())`
                : sql`${teamMemberships.acceptedAt}`,
            disabledAt: status === "disabled" ? sql`now()` : null
          }
        })
        .returning();

      return mapMembershipRecord(rows[0]!);
    },

    async createTeamWorkspace(
      actor: ActorContext,
      input: { teamId: string; name: string }
    ): Promise<TeamWorkspaceRecord | null> {
      const manager = await getManagingMembership(actor, input.teamId);
      if (!membershipManages(manager)) {
        return null;
      }

      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(teamWorkspaces)
          .values({ teamId: input.teamId, name: input.name })
          .returning();
        const workspace = rows[0]!;

        await tx.insert(teamWorkspaceAccessGrants).values({
          teamWorkspaceId: workspace.id,
          teamId: workspace.teamId,
          userId: actor.userId,
          access: "write",
          grantedByUserId: actor.userId
        });

        return mapWorkspaceRecord(workspace);
      });
    },

    async setTeamWorkspaceAccess(
      actor: ActorContext,
      input: {
        teamWorkspaceId: string;
        userId: string;
        access: TeamWorkspaceAccessLevel;
      }
    ): Promise<TeamWorkspaceAccessRecord | null> {
      const accessContext = await getTeamWorkspaceAccess(
        actor,
        input.teamWorkspaceId
      );
      if (!accessContext?.canManageWorkspace) {
        return null;
      }

      const targetMembership = await db
        .select()
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, accessContext.teamId),
            eq(teamMemberships.userId, input.userId)
          )
        )
        .limit(1);
      if (!targetMembership[0]) {
        return null;
      }

      await db
        .insert(teamWorkspaceAccessGrants)
        .values({
          teamWorkspaceId: input.teamWorkspaceId,
          teamId: accessContext.teamId,
          userId: input.userId,
          access: input.access,
          grantedByUserId: actor.userId
        })
        .onConflictDoUpdate({
          target: [
            teamWorkspaceAccessGrants.teamWorkspaceId,
            teamWorkspaceAccessGrants.userId
          ],
          set: {
            access: input.access,
            grantedByUserId: actor.userId,
            updatedAt: sql`now()`
          }
        });

      return getTeamWorkspaceAccess(
        { userId: input.userId },
        input.teamWorkspaceId
      );
    },

    getTeamWorkspaceAccess
  };
};
