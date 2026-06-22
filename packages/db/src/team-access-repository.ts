import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  auditEventValues,
  auditLimit,
  mapAuditEventRecord
} from "./audit-repository.js";
import type { KoedDb } from "./connection.js";
import {
  auditEvents,
  teamInvites,
  teamMemberships,
  teams,
  teamWorkspaceAccessGrants,
  teamWorkspaces,
  users
} from "./schema.js";
import type {
  AcceptedTeamInviteRecord,
  ActorContext,
  AuditEventRecord,
  ListTeamAuditEventsInput,
  TeamInviteRecord,
  TeamMembershipRecord,
  TeamMembershipStatus,
  TeamRecord,
  TeamRole,
  TeamWorkspaceAccessLevel,
  TeamWorkspaceAccessRecord,
  TeamWorkspaceRecord,
  UserRecord
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

const mapUserRecord = (row: {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string | null;
}): UserRecord => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  passwordHash: row.passwordHash
});

const mapInviteRecord = (row: {
  id: string;
  teamId: string;
  email: string;
  role: TeamRole;
  createdByUserId: string | null;
  acceptedByUserId: string | null;
  createdAt: Date | string;
  expiresAt: Date | string;
  acceptedAt: Date | string | null;
  revokedAt: Date | string | null;
}): TeamInviteRecord => ({
  id: row.id,
  teamId: row.teamId,
  email: row.email,
  role: row.role,
  createdByUserId: row.createdByUserId,
  acceptedByUserId: row.acceptedByUserId,
  createdAt: timestampIso(row.createdAt),
  expiresAt: timestampIso(row.expiresAt),
  acceptedAt: row.acceptedAt ? timestampIso(row.acceptedAt) : null,
  revokedAt: row.revokedAt ? timestampIso(row.revokedAt) : null
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
  accessDisabledAt: Date | string | null;
}): TeamWorkspaceAccessRecord => {
  const workspaceActive = !row.teamArchivedAt && !row.workspaceArchivedAt;
  const membershipEnabled =
    workspaceActive &&
    row.membershipStatus === "enabled" &&
    row.membershipDisabledAt === null;
  const access =
    membershipEnabled && row.accessDisabledAt === null
      ? (row.access ?? "disabled")
      : "disabled";
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
        access: teamWorkspaceAccessGrants.access,
        accessDisabledAt: teamWorkspaceAccessGrants.disabledAt
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

  const insertTeamAudit = (
    tx: KoedDb,
    input: {
      actorUserId?: string | null;
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    }
  ) =>
    tx.insert(auditEvents).values(
      auditEventValues({
        actorUserId: input.actorUserId ?? null,
        ownerUserId: input.actorUserId ?? null,
        visibility: null,
        action: input.action,
        targetTable: input.targetTable,
        targetId: input.targetId,
        metadata: input.metadata
      })
    );

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

        const record = mapTeamRecord(team);
        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.created",
          targetTable: "teams",
          targetId: record.id,
          metadata: {
            teamId: record.id
          }
        });

        return record;
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
      return db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(teamMemberships)
          .where(
            and(
              eq(teamMemberships.teamId, input.teamId),
              eq(teamMemberships.userId, input.userId)
            )
          )
          .limit(1);
        const previous = existing[0];
        if (previous?.role === "owner" && manager!.role !== "owner") {
          return null;
        }

        const rows = await tx
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

        const membership = mapMembershipRecord(rows[0]!);
        const action =
          status === "disabled"
            ? "team.member.disabled"
            : previous?.status !== "enabled" && status === "enabled"
              ? "team.member.enabled"
              : previous && previous.role !== input.role
                ? "team.member.role_changed"
                : "team.member.upserted";

        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action,
          targetTable: "team_memberships",
          targetId: membership.id,
          metadata: {
            teamId: input.teamId,
            userId: input.userId,
            role: input.role,
            status
          }
        });

        return membership;
      });
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
        const workspaceRow = rows[0]!;

        await tx.insert(teamWorkspaceAccessGrants).values({
          teamWorkspaceId: workspaceRow.id,
          teamId: workspaceRow.teamId,
          userId: actor.userId,
          access: "write",
          grantedByUserId: actor.userId
        });

        const workspace = mapWorkspaceRecord(workspaceRow);
        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.workspace.created",
          targetTable: "team_workspaces",
          targetId: workspace.id,
          metadata: {
            teamId: workspace.teamId,
            teamWorkspaceId: workspace.id
          }
        });

        return workspace;
      });
    },

    async createTeamInvite(
      actor: ActorContext,
      input: {
        teamId: string;
        email: string;
        role: TeamRole;
        tokenHash: string;
        expiresAt: Date;
      }
    ): Promise<TeamInviteRecord | null> {
      const manager = await getManagingMembership(actor, input.teamId);
      if (!membershipManages(manager)) {
        return null;
      }
      if (input.role === "owner" && manager!.role !== "owner") {
        return null;
      }

      return db.transaction(async (tx) => {
        const email = input.email.toLowerCase();
        const existingUsers = await tx
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        const existingUser = existingUsers[0];
        if (existingUser) {
          const existingMembershipRows = await tx
            .select()
            .from(teamMemberships)
            .where(
              and(
                eq(teamMemberships.teamId, input.teamId),
                eq(teamMemberships.userId, existingUser.id)
              )
            )
            .limit(1)
            .for("update");
          const existingMembership = existingMembershipRows[0];
          if (
            existingMembership?.role === "owner" &&
            manager!.role !== "owner"
          ) {
            return null;
          }
        }

        const inviteRows = await tx
          .insert(teamInvites)
          .values({
            teamId: input.teamId,
            email,
            role: input.role,
            tokenHash: input.tokenHash,
            createdByUserId: actor.userId,
            expiresAt: input.expiresAt
          })
          .returning();
        const invite = mapInviteRecord(inviteRows[0]!);

        if (existingUser) {
          await tx
            .insert(teamMemberships)
            .values({
              teamId: input.teamId,
              userId: existingUser.id,
              role: input.role,
              status: "invited"
            })
            .onConflictDoUpdate({
              target: [teamMemberships.teamId, teamMemberships.userId],
              set: {
                role: sql`case when ${teamMemberships.status} = 'enabled' then ${teamMemberships.role} else ${input.role}::team_role end`,
                status: sql`case when ${teamMemberships.status} = 'enabled' then ${teamMemberships.status} else 'invited'::team_membership_status end`,
                updatedAt: sql`now()`,
                disabledAt: sql`case when ${teamMemberships.status} = 'enabled' then ${teamMemberships.disabledAt} else null end`
              }
            });
        }

        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.invite.created",
          targetTable: "team_invites",
          targetId: invite.id,
          metadata: {
            teamId: input.teamId,
            email,
            role: input.role,
            existingUser: Boolean(existingUser)
          }
        });

        return invite;
      });
    },

    async getPendingTeamInviteByTokenHash(
      tokenHash: string
    ): Promise<TeamInviteRecord | null> {
      const rows = await db
        .select()
        .from(teamInvites)
        .where(
          and(
            eq(teamInvites.tokenHash, tokenHash),
            isNull(teamInvites.acceptedAt),
            isNull(teamInvites.revokedAt),
            gt(teamInvites.expiresAt, sql`now()`)
          )
        )
        .limit(1);

      return rows[0] ? mapInviteRecord(rows[0]) : null;
    },

    async acceptTeamInvite(input: {
      tokenHash: string;
      userId?: string;
      email?: string;
      displayName?: string;
      passwordHash?: string;
    }): Promise<AcceptedTeamInviteRecord | null> {
      return db.transaction(async (tx) => {
        const inviteRows = await tx
          .select()
          .from(teamInvites)
          .where(
            and(
              eq(teamInvites.tokenHash, input.tokenHash),
              isNull(teamInvites.acceptedAt),
              isNull(teamInvites.revokedAt),
              gt(teamInvites.expiresAt, sql`now()`)
            )
          )
          .limit(1)
          .for("update");
        const inviteRow = inviteRows[0];
        if (!inviteRow) {
          return null;
        }

        const inviteEmail = inviteRow.email.toLowerCase();
        let createdUser = false;
        let userRows = input.userId
          ? await tx
              .select()
              .from(users)
              .where(eq(users.id, input.userId))
              .limit(1)
          : await tx
              .select()
              .from(users)
              .where(eq(users.email, inviteEmail))
              .limit(1);
        let user = userRows[0];

        if (!user) {
          const requestedEmail = input.email?.toLowerCase() ?? inviteEmail;
          if (requestedEmail !== inviteEmail) {
            return null;
          }
          userRows = await tx
            .insert(users)
            .values({
              email: inviteEmail,
              displayName: input.displayName ?? null,
              passwordHash: input.passwordHash ?? null
            })
            .onConflictDoNothing({ target: users.email })
            .returning();
          user = userRows[0];
          createdUser = Boolean(user);
          if (!user) {
            userRows = await tx
              .select()
              .from(users)
              .where(eq(users.email, inviteEmail))
              .limit(1);
            user = userRows[0];
          }
          if (!user) {
            return null;
          }
        }

        if (user.email.toLowerCase() !== inviteEmail) {
          return null;
        }

        const existingMembershipRows = await tx
          .select()
          .from(teamMemberships)
          .where(
            and(
              eq(teamMemberships.teamId, inviteRow.teamId),
              eq(teamMemberships.userId, user.id)
            )
          )
          .limit(1)
          .for("update");
        const existingMembership = existingMembershipRows[0];
        if (existingMembership?.status === "disabled") {
          return null;
        }
        const acceptedRole =
          existingMembership?.status === "enabled"
            ? existingMembership.role
            : inviteRow.role;

        const membershipRows = await tx
          .insert(teamMemberships)
          .values({
            teamId: inviteRow.teamId,
            userId: user.id,
            role: acceptedRole,
            status: "enabled",
            acceptedAt: sql`now()`,
            disabledAt: null
          })
          .onConflictDoUpdate({
            target: [teamMemberships.teamId, teamMemberships.userId],
            set: {
              role: acceptedRole,
              status: "enabled",
              acceptedAt: sql`coalesce(${teamMemberships.acceptedAt}, now())`,
              disabledAt: null,
              updatedAt: sql`now()`
            }
          })
          .returning();

        const acceptedRows = await tx
          .update(teamInvites)
          .set({ acceptedAt: sql`now()`, acceptedByUserId: user.id })
          .where(eq(teamInvites.id, inviteRow.id))
          .returning();
        const invite = mapInviteRecord(acceptedRows[0]!);
        const membership = mapMembershipRecord(membershipRows[0]!);

        await insertTeamAudit(tx, {
          actorUserId: user.id,
          action: "team.invite.accepted",
          targetTable: "team_invites",
          targetId: invite.id,
          metadata: {
            teamId: invite.teamId,
            email: invite.email,
            role: invite.role,
            userId: user.id,
            createdUser
          }
        });
        await insertTeamAudit(tx, {
          actorUserId: user.id,
          action: "team.member.enabled",
          targetTable: "team_memberships",
          targetId: membership.id,
          metadata: {
            teamId: invite.teamId,
            userId: user.id,
            role: membership.role,
            status: membership.status,
            source: "invite_acceptance"
          }
        });

        return {
          invite,
          membership,
          user: mapUserRecord(user),
          createdUser
        };
      });
    },

    async disableTeamMember(
      actor: ActorContext,
      input: { teamId: string; userId: string }
    ): Promise<TeamMembershipRecord | null> {
      const manager = await getManagingMembership(actor, input.teamId);
      if (!membershipManages(manager)) {
        return null;
      }
      if (input.userId === actor.userId) {
        return null;
      }

      return db.transaction(async (tx) => {
        const targetMembershipRows = await tx
          .select()
          .from(teamMemberships)
          .where(
            and(
              eq(teamMemberships.teamId, input.teamId),
              eq(teamMemberships.userId, input.userId)
            )
          )
          .limit(1);
        const targetMembership = targetMembershipRows[0];
        if (!targetMembership) {
          return null;
        }
        if (targetMembership.role === "owner" && manager!.role !== "owner") {
          return null;
        }

        const rows = await tx
          .update(teamMemberships)
          .set({
            status: "disabled",
            disabledAt: sql`now()`,
            updatedAt: sql`now()`
          })
          .where(
            and(
              eq(teamMemberships.teamId, input.teamId),
              eq(teamMemberships.userId, input.userId)
            )
          )
          .returning();
        if (!rows[0]) {
          return null;
        }

        const membership = mapMembershipRecord(rows[0]);
        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.member.disabled",
          targetTable: "team_memberships",
          targetId: membership.id,
          metadata: {
            teamId: input.teamId,
            userId: input.userId,
            role: membership.role,
            status: membership.status
          }
        });

        return membership;
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

      await db.transaction(async (tx) => {
        const existingGrants = await tx
          .select()
          .from(teamWorkspaceAccessGrants)
          .where(
            and(
              eq(
                teamWorkspaceAccessGrants.teamWorkspaceId,
                input.teamWorkspaceId
              ),
              eq(teamWorkspaceAccessGrants.teamId, accessContext.teamId),
              eq(teamWorkspaceAccessGrants.userId, input.userId)
            )
          )
          .limit(1);
        const previousAccess = existingGrants[0]?.access ?? "disabled";

        await tx
          .insert(teamWorkspaceAccessGrants)
          .values({
            teamWorkspaceId: input.teamWorkspaceId,
            userId: input.userId,
            teamId: accessContext.teamId,
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

        const action =
          input.access === "disabled"
            ? "team.workspace_access.removed"
            : previousAccess === "disabled"
              ? "team.workspace_access.created"
              : "team.workspace_access.updated";

        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action,
          targetTable: "team_workspace_access_grants",
          targetId: input.teamWorkspaceId,
          metadata: {
            teamId: accessContext.teamId,
            teamWorkspaceId: input.teamWorkspaceId,
            userId: input.userId,
            access: input.access,
            previousAccess
          }
        });
      });

      return getTeamWorkspaceAccess(
        { userId: input.userId },
        input.teamWorkspaceId
      );
    },

    async listTeamAuditEvents(
      actor: ActorContext,
      input: ListTeamAuditEventsInput
    ): Promise<AuditEventRecord[] | null> {
      const manager = await getManagingMembership(actor, input.teamId);
      if (!membershipManages(manager)) {
        return null;
      }

      const conditions = [
        sql`${auditEvents.metadata} ->> 'teamId' = ${input.teamId}`,
        sql`${auditEvents.action} like 'team.%'`
      ];
      if (input.action) {
        conditions.push(eq(auditEvents.action, input.action));
      }

      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(...conditions))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.auditSequence))
        .limit(auditLimit(input.limit));

      return rows.map(mapAuditEventRecord);
    },

    getTeamWorkspaceAccess
  };
};
