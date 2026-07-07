import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  auditEventValues,
  auditLimit,
  mapAuditEventRecord
} from "./audit-repository.js";
import type { KoedDb } from "./connection.js";
import {
  auditEvents,
  deviceCredentials,
  externalAuthIdentities,
  externalAuthOrganizations,
  teamInvites,
  teamBillingSeatStates,
  teamMemberships,
  teamSessionShareGrants,
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
  TeamBillingSeatStateRecord,
  TeamBillingSeatSyncStatus,
  TeamInviteRecord,
  TeamEntitlementGateRecord,
  TeamEntitlementStatus,
  TeamMembershipRecord,
  TeamMembershipStatus,
  TeamRecord,
  TeamRole,
  TeamSupportOverviewRecord,
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
  entitlementStatus: TeamEntitlementStatus;
  entitlementReason: string | null;
  entitlementUpdatedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  archivedAt: Date | string | null;
}): TeamRecord => ({
  id: row.id,
  name: row.name,
  entitlementStatus: row.entitlementStatus,
  entitlementReason: row.entitlementReason,
  entitlementUpdatedAt: row.entitlementUpdatedAt
    ? timestampIso(row.entitlementUpdatedAt)
    : null,
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

const mapTeamBillingSeatState = (row: {
  teamId: string;
  seatLimit: number | null;
  billableSeatCount: number;
  pendingBillingSeatCount: number;
  syncStatus: TeamBillingSeatSyncStatus;
  overLimitAt: Date | string | null;
  lastSyncedAt: Date | string | null;
  lastErrorMessage: string | null;
  updatedByUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): TeamBillingSeatStateRecord => ({
  teamId: row.teamId,
  seatLimit: row.seatLimit,
  billableSeatCount: row.billableSeatCount,
  pendingBillingSeatCount: row.pendingBillingSeatCount,
  syncStatus: row.syncStatus,
  overLimitAt: row.overLimitAt ? timestampIso(row.overLimitAt) : null,
  lastSyncedAt: row.lastSyncedAt ? timestampIso(row.lastSyncedAt) : null,
  lastErrorMessage: row.lastErrorMessage,
  updatedByUserId: row.updatedByUserId,
  createdAt: timestampIso(row.createdAt),
  updatedAt: timestampIso(row.updatedAt)
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

const teamEntitlementAllowsAccess = (status: TeamEntitlementStatus): boolean =>
  status === "active" || status === "grace";

const deniedOperationFamiliesForStatus = (
  status: TeamEntitlementStatus
): string[] =>
  teamEntitlementAllowsAccess(status)
    ? []
    : ["ingestion", "recall", "share", "sync", "team_admin"];

const mapTeamEntitlementGate = (row: {
  id: string;
  entitlementStatus: TeamEntitlementStatus;
  entitlementReason: string | null;
  entitlementUpdatedAt: Date | string | null;
}): TeamEntitlementGateRecord => ({
  teamId: row.id,
  status: row.entitlementStatus,
  allowsTeamAccess: teamEntitlementAllowsAccess(row.entitlementStatus),
  deniedOperationFamilies: deniedOperationFamiliesForStatus(
    row.entitlementStatus
  ),
  reason: row.entitlementReason,
  updatedAt: row.entitlementUpdatedAt
    ? timestampIso(row.entitlementUpdatedAt)
    : null
});

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
  teamEntitlementStatus: TeamEntitlementStatus;
  workspaceArchivedAt: Date | string | null;
  access: TeamWorkspaceAccessLevel | null;
  accessDisabledAt: Date | string | null;
}): TeamWorkspaceAccessRecord => {
  const workspaceActive = !row.teamArchivedAt && !row.workspaceArchivedAt;
  const entitlementAllowsAccess = teamEntitlementAllowsAccess(
    row.teamEntitlementStatus
  );
  const membershipEnabled =
    workspaceActive &&
    entitlementAllowsAccess &&
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
    teamEntitlementStatus: row.teamEntitlementStatus,
    teamEntitlementAllowsAccess: entitlementAllowsAccess,
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

  const getTeamEntitlementGateById = async (
    teamId: string
  ): Promise<TeamEntitlementGateRecord | null> => {
    const rows = await db
      .select({
        id: teams.id,
        entitlementStatus: teams.entitlementStatus,
        entitlementReason: teams.entitlementReason,
        entitlementUpdatedAt: teams.entitlementUpdatedAt
      })
      .from(teams)
      .where(and(eq(teams.id, teamId), isNull(teams.archivedAt)))
      .limit(1);

    return rows[0] ? mapTeamEntitlementGate(rows[0]) : null;
  };

  const teamGateAllowsAccess = async (teamId: string): Promise<boolean> => {
    const gate = await getTeamEntitlementGateById(teamId);
    return gate?.allowsTeamAccess === true;
  };

  type TeamAccessTransaction = Parameters<
    Parameters<typeof db.transaction>[0]
  >[0];

  const reconcileTeamBillingSeats = async (
    tx: TeamAccessTransaction,
    input: {
      teamId: string;
      actorUserId: string | null;
      reason: string;
      initialSync?: boolean;
    }
  ): Promise<TeamBillingSeatStateRecord | null> => {
    const existingRows = await tx
      .select()
      .from(teamBillingSeatStates)
      .where(eq(teamBillingSeatStates.teamId, input.teamId))
      .limit(1)
      .for("update");
    const existing = existingRows[0] ?? null;

    const countRows = await tx
      .select({
        billableSeatCount: sql<number>`count(*)::int`
      })
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.teamId, input.teamId),
          eq(teamMemberships.status, "enabled")
        )
      );
    const billableSeatCount = Number(countRows[0]?.billableSeatCount ?? 0);
    const seatLimit = existing?.seatLimit ?? null;
    const overLimit = seatLimit !== null && billableSeatCount > seatLimit;
    const syncStatus: TeamBillingSeatSyncStatus = overLimit
      ? "over_limit"
      : input.initialSync && !existing
        ? "synced"
        : "pending_provider_update";

    const rows = await tx
      .insert(teamBillingSeatStates)
      .values({
        teamId: input.teamId,
        seatLimit,
        billableSeatCount,
        pendingBillingSeatCount: billableSeatCount,
        syncStatus,
        overLimitAt: overLimit ? sql`now()` : null,
        updatedByUserId: input.actorUserId
      })
      .onConflictDoUpdate({
        target: teamBillingSeatStates.teamId,
        set: {
          billableSeatCount,
          pendingBillingSeatCount: billableSeatCount,
          syncStatus,
          overLimitAt: overLimit
            ? sql`coalesce(${teamBillingSeatStates.overLimitAt}, now())`
            : null,
          lastErrorMessage: null,
          updatedByUserId: input.actorUserId,
          updatedAt: sql`now()`
        }
      })
      .returning();
    const state = mapTeamBillingSeatState(rows[0]!);

    const teamRows = await tx
      .select({
        entitlementStatus: teams.entitlementStatus,
        entitlementReason: teams.entitlementReason
      })
      .from(teams)
      .where(and(eq(teams.id, input.teamId), isNull(teams.archivedAt)))
      .limit(1)
      .for("update");
    const team = teamRows[0];
    if (team) {
      if (overLimit && team.entitlementStatus === "active") {
        await tx
          .update(teams)
          .set({
            entitlementStatus: "grace",
            entitlementReason: "seat_limit_exceeded",
            entitlementUpdatedAt: sql`now()`,
            updatedAt: sql`now()`
          })
          .where(eq(teams.id, input.teamId));
      } else if (
        !overLimit &&
        team.entitlementStatus === "grace" &&
        team.entitlementReason === "seat_limit_exceeded"
      ) {
        await tx
          .update(teams)
          .set({
            entitlementStatus: "active",
            entitlementReason: "seat_limit_restored",
            entitlementUpdatedAt: sql`now()`,
            updatedAt: sql`now()`
          })
          .where(eq(teams.id, input.teamId));
      }
    }

    if (
      !existing ||
      existing.billableSeatCount !== billableSeatCount ||
      existing.pendingBillingSeatCount !== billableSeatCount ||
      existing.syncStatus !== syncStatus ||
      existing.seatLimit !== seatLimit
    ) {
      await insertTeamAudit(tx, {
        actorUserId: input.actorUserId,
        action: "team.billing_seats.changed",
        targetTable: "team_billing_seat_states",
        targetId: input.teamId,
        metadata: {
          teamId: input.teamId,
          reason: input.reason,
          previousBillableSeatCount: existing?.billableSeatCount ?? null,
          billableSeatCount,
          pendingBillingSeatCount: billableSeatCount,
          seatLimit,
          syncStatus,
          overLimit
        }
      });
    }

    return state;
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
        teamEntitlementStatus: teams.entitlementStatus,
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
        await reconcileTeamBillingSeats(tx, {
          teamId: team.id,
          actorUserId: actor.userId,
          reason: "team_created",
          initialSync: true
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

    async getTeamEntitlementGate(
      actor: ActorContext,
      teamId: string
    ): Promise<TeamEntitlementGateRecord | null> {
      const membership = await getManagingMembership(actor, teamId);
      if (!membershipManages(membership)) {
        return null;
      }
      return getTeamEntitlementGateById(teamId);
    },

    async setTeamEntitlementState(
      actor: ActorContext,
      input: {
        teamId: string;
        status: TeamEntitlementStatus;
        reason?: string | null;
      }
    ): Promise<TeamEntitlementGateRecord | null> {
      const manager = await getManagingMembership(actor, input.teamId);
      if (!membershipManages(manager)) {
        return null;
      }
      if (manager!.role !== "owner") {
        return null;
      }

      return db.transaction(async (tx) => {
        const existingRows = await tx
          .select({
            id: teams.id,
            entitlementStatus: teams.entitlementStatus,
            entitlementReason: teams.entitlementReason,
            entitlementUpdatedAt: teams.entitlementUpdatedAt
          })
          .from(teams)
          .where(and(eq(teams.id, input.teamId), isNull(teams.archivedAt)))
          .limit(1)
          .for("update");
        const existing = existingRows[0];
        if (!existing) {
          return null;
        }

        const rows = await tx
          .update(teams)
          .set({
            entitlementStatus: input.status,
            entitlementReason: input.reason?.trim() || null,
            entitlementUpdatedAt: sql`now()`,
            updatedAt: sql`now()`
          })
          .where(eq(teams.id, input.teamId))
          .returning({
            id: teams.id,
            entitlementStatus: teams.entitlementStatus,
            entitlementReason: teams.entitlementReason,
            entitlementUpdatedAt: teams.entitlementUpdatedAt
          });
        const gate = mapTeamEntitlementGate(rows[0]!);

        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.entitlement.changed",
          targetTable: "teams",
          targetId: input.teamId,
          metadata: {
            teamId: input.teamId,
            previousStatus: existing.entitlementStatus,
            status: gate.status,
            reason: gate.reason,
            deniedOperationFamilies: gate.deniedOperationFamilies
          }
        });

        return gate;
      });
    },

    async getTeamBillingSeatState(
      actor: ActorContext,
      teamId: string
    ): Promise<TeamBillingSeatStateRecord | null> {
      const manager = await getManagingMembership(actor, teamId);
      if (!membershipManages(manager)) {
        return null;
      }
      const rows = await db
        .select()
        .from(teamBillingSeatStates)
        .where(eq(teamBillingSeatStates.teamId, teamId))
        .limit(1);
      return rows[0] ? mapTeamBillingSeatState(rows[0]) : null;
    },

    async setTeamBillingSeatPolicy(
      actor: ActorContext,
      input: { teamId: string; seatLimit: number | null }
    ): Promise<TeamBillingSeatStateRecord | null> {
      const manager = await getManagingMembership(actor, input.teamId);
      if (!membershipManages(manager) || manager!.role !== "owner") {
        return null;
      }
      if (
        input.seatLimit !== null &&
        (!Number.isInteger(input.seatLimit) || input.seatLimit < 0)
      ) {
        throw new Error("seatLimit must be a non-negative integer or null");
      }

      return db.transaction(async (tx) => {
        await tx
          .insert(teamBillingSeatStates)
          .values({
            teamId: input.teamId,
            seatLimit: input.seatLimit,
            syncStatus: "pending_provider_update",
            updatedByUserId: actor.userId
          })
          .onConflictDoUpdate({
            target: teamBillingSeatStates.teamId,
            set: {
              seatLimit: input.seatLimit,
              syncStatus: "pending_provider_update",
              updatedByUserId: actor.userId,
              updatedAt: sql`now()`
            }
          });

        return reconcileTeamBillingSeats(tx, {
          teamId: input.teamId,
          actorUserId: actor.userId,
          reason: "seat_policy_changed"
        });
      });
    },

    async getTeamSupportOverview(
      actor: ActorContext,
      teamId: string
    ): Promise<TeamSupportOverviewRecord | null> {
      const manager = await getManagingMembership(actor, teamId);
      if (!manager || !membershipManages(manager)) {
        return null;
      }

      const [
        teamRows,
        billingRows,
        membershipCountRows,
        workspaceCountRows,
        workspaceAccessCountRows,
        inviteCountRows,
        shareGrantCountRows,
        auditCountRows,
        externalAuthOrganizationRows,
        externalAuthIdentityRows,
        deviceCredentialRows
      ] = await Promise.all([
        db
          .select()
          .from(teams)
          .where(and(eq(teams.id, teamId), isNull(teams.archivedAt)))
          .limit(1),
        db
          .select()
          .from(teamBillingSeatStates)
          .where(eq(teamBillingSeatStates.teamId, teamId))
          .limit(1),
        db
          .select({
            enabled: sql<number>`count(*) filter (where ${teamMemberships.status} = 'enabled')::int`,
            invited: sql<number>`count(*) filter (where ${teamMemberships.status} = 'invited')::int`,
            disabled: sql<number>`count(*) filter (where ${teamMemberships.status} = 'disabled')::int`
          })
          .from(teamMemberships)
          .where(eq(teamMemberships.teamId, teamId)),
        db
          .select({
            active: sql<number>`count(*) filter (where ${teamWorkspaces.archivedAt} is null)::int`,
            archived: sql<number>`count(*) filter (where ${teamWorkspaces.archivedAt} is not null)::int`
          })
          .from(teamWorkspaces)
          .where(eq(teamWorkspaces.teamId, teamId)),
        db
          .select({
            read: sql<number>`count(*) filter (where ${teamWorkspaceAccessGrants.access} = 'read' and ${teamWorkspaceAccessGrants.disabledAt} is null)::int`,
            write: sql<number>`count(*) filter (where ${teamWorkspaceAccessGrants.access} = 'write' and ${teamWorkspaceAccessGrants.disabledAt} is null)::int`,
            disabled: sql<number>`count(*) filter (where ${teamWorkspaceAccessGrants.access} = 'disabled' or ${teamWorkspaceAccessGrants.disabledAt} is not null)::int`
          })
          .from(teamWorkspaceAccessGrants)
          .where(eq(teamWorkspaceAccessGrants.teamId, teamId)),
        db
          .select({
            pending: sql<number>`count(*) filter (where ${teamInvites.acceptedAt} is null and ${teamInvites.revokedAt} is null and ${teamInvites.expiresAt} > now())::int`,
            accepted: sql<number>`count(*) filter (where ${teamInvites.acceptedAt} is not null)::int`,
            revoked: sql<number>`count(*) filter (where ${teamInvites.revokedAt} is not null)::int`,
            expired: sql<number>`count(*) filter (where ${teamInvites.acceptedAt} is null and ${teamInvites.revokedAt} is null and ${teamInvites.expiresAt} <= now())::int`
          })
          .from(teamInvites)
          .where(eq(teamInvites.teamId, teamId)),
        db
          .select({
            active: sql<number>`count(*) filter (where ${teamSessionShareGrants.revokedAt} is null)::int`,
            revoked: sql<number>`count(*) filter (where ${teamSessionShareGrants.revokedAt} is not null)::int`,
            retainedAfterPersonalDeletion: sql<number>`count(*) filter (where ${teamSessionShareGrants.personalDeletedAt} is not null and ${teamSessionShareGrants.retainedByTeamAt} is not null)::int`
          })
          .from(teamSessionShareGrants)
          .where(eq(teamSessionShareGrants.teamId, teamId)),
        db
          .select({
            teamEventCount: sql<number>`count(*)::int`,
            lastTeamEventAt: sql<Date | null>`max(${auditEvents.createdAt})`
          })
          .from(auditEvents)
          .where(
            and(
              sql`${auditEvents.metadata} ->> 'teamId' = ${teamId}`,
              sql`${auditEvents.action} like 'team.%'`
            )
          ),
        db
          .select({
            linked: sql<number>`count(*) filter (where ${externalAuthOrganizations.status} = 'linked')::int`,
            disabled: sql<number>`count(*) filter (where ${externalAuthOrganizations.status} = 'disabled')::int`,
            lastSeenAt: sql<Date | null>`max(${externalAuthOrganizations.lastSeenAt})`
          })
          .from(externalAuthOrganizations)
          .where(eq(externalAuthOrganizations.teamId, teamId)),
        db
          .select({
            linked: sql<number>`count(*) filter (where ${externalAuthIdentities.status} = 'linked')::int`,
            disabled: sql<number>`count(*) filter (where ${externalAuthIdentities.status} = 'disabled')::int`,
            emailVerified: sql<number>`count(*) filter (where ${externalAuthIdentities.emailVerified} = true)::int`,
            lastSeenAt: sql<Date | null>`max(${externalAuthIdentities.lastSeenAt})`
          })
          .from(externalAuthIdentities)
          .innerJoin(
            teamMemberships,
            eq(teamMemberships.userId, externalAuthIdentities.userId)
          )
          .where(eq(teamMemberships.teamId, teamId)),
        db
          .select({
            active: sql<number>`count(*) filter (where ${deviceCredentials.revokedAt} is null and (${deviceCredentials.expiresAt} is null or ${deviceCredentials.expiresAt} > now()))::int`,
            revoked: sql<number>`count(*) filter (where ${deviceCredentials.revokedAt} is not null)::int`,
            expired: sql<number>`count(*) filter (where ${deviceCredentials.revokedAt} is null and ${deviceCredentials.expiresAt} is not null and ${deviceCredentials.expiresAt} <= now())::int`,
            lastValidatedAt: sql<Date | null>`max(${deviceCredentials.lastValidatedAt})`
          })
          .from(deviceCredentials)
          .innerJoin(
            teamMemberships,
            eq(teamMemberships.userId, deviceCredentials.ownerUserId)
          )
          .where(eq(teamMemberships.teamId, teamId))
      ]);

      const team = teamRows[0];
      if (!team) {
        return null;
      }
      const membershipCounts = membershipCountRows[0] ?? {
        enabled: 0,
        invited: 0,
        disabled: 0
      };
      const workspaceCounts = workspaceCountRows[0] ?? {
        active: 0,
        archived: 0
      };
      const workspaceAccessCounts = workspaceAccessCountRows[0] ?? {
        read: 0,
        write: 0,
        disabled: 0
      };
      const inviteCounts = inviteCountRows[0] ?? {
        pending: 0,
        accepted: 0,
        revoked: 0,
        expired: 0
      };
      const shareGrantCounts = shareGrantCountRows[0] ?? {
        active: 0,
        revoked: 0,
        retainedAfterPersonalDeletion: 0
      };
      const auditCounts = auditCountRows[0] ?? {
        teamEventCount: 0,
        lastTeamEventAt: null
      };
      const externalAuthOrganizationCounts =
        externalAuthOrganizationRows[0] ?? {
          linked: 0,
          disabled: 0,
          lastSeenAt: null
        };
      const externalAuthIdentityCounts = externalAuthIdentityRows[0] ?? {
        linked: 0,
        disabled: 0,
        emailVerified: 0,
        lastSeenAt: null
      };
      const deviceCredentialCounts = deviceCredentialRows[0] ?? {
        active: 0,
        revoked: 0,
        expired: 0,
        lastValidatedAt: null
      };
      const entitlement = mapTeamEntitlementGate({
        id: team.id,
        entitlementStatus: team.entitlementStatus,
        entitlementReason: team.entitlementReason,
        entitlementUpdatedAt: team.entitlementUpdatedAt
      });

      await insertTeamAudit(db, {
        actorUserId: actor.userId,
        action: "team.support_overview.viewed",
        targetTable: "teams",
        targetId: teamId,
        metadata: {
          teamId,
          policy: "team_manager_redacted",
          rawContentAccess: "not_permitted"
        }
      });

      return {
        generatedAt: new Date().toISOString(),
        supportAccess: {
          policy: "team_manager_redacted",
          actorUserId: actor.userId,
          actorRole: manager.role as Exclude<TeamRole, "member">,
          rawContentAccess: "not_permitted",
          breakGlassRequiredForRawContent: true
        },
        team: mapTeamRecord(team),
        entitlement,
        billingSeats: billingRows[0]
          ? mapTeamBillingSeatState(billingRows[0])
          : null,
        diagnosticSurfaces: {
          auth: "browser_session",
          rawContentAccess: "not_permitted",
          operationsStatusPath: "/ops/status",
          capabilitiesPath: `/v1/capabilities/authenticated?teamId=${team.id}`,
          auditEventsPath: `/v1/teams/${team.id}/audit-events`,
          entitlementPath: `/v1/teams/${team.id}/entitlement`,
          billingSeatsPath: `/v1/teams/${team.id}/billing-seats`,
          supportOverviewPath: `/v1/teams/${team.id}/support/overview`
        },
        counts: {
          memberships: {
            enabled: Number(membershipCounts.enabled ?? 0),
            invited: Number(membershipCounts.invited ?? 0),
            disabled: Number(membershipCounts.disabled ?? 0)
          },
          workspaces: {
            active: Number(workspaceCounts.active ?? 0),
            archived: Number(workspaceCounts.archived ?? 0)
          },
          workspaceAccess: {
            read: Number(workspaceAccessCounts.read ?? 0),
            write: Number(workspaceAccessCounts.write ?? 0),
            disabled: Number(workspaceAccessCounts.disabled ?? 0)
          },
          invites: {
            pending: Number(inviteCounts.pending ?? 0),
            accepted: Number(inviteCounts.accepted ?? 0),
            revoked: Number(inviteCounts.revoked ?? 0),
            expired: Number(inviteCounts.expired ?? 0)
          },
          sessionShareGrants: {
            active: Number(shareGrantCounts.active ?? 0),
            revoked: Number(shareGrantCounts.revoked ?? 0),
            retainedAfterPersonalDeletion: Number(
              shareGrantCounts.retainedAfterPersonalDeletion ?? 0
            )
          },
          auditEvents: {
            teamEventCount: Number(auditCounts.teamEventCount ?? 0),
            lastTeamEventAt: auditCounts.lastTeamEventAt
              ? timestampIso(auditCounts.lastTeamEventAt)
              : null
          },
          setupAndIntegrations: {
            externalAuthOrganizations: {
              linked: Number(externalAuthOrganizationCounts.linked ?? 0),
              disabled: Number(externalAuthOrganizationCounts.disabled ?? 0),
              lastSeenAt: externalAuthOrganizationCounts.lastSeenAt
                ? timestampIso(externalAuthOrganizationCounts.lastSeenAt)
                : null
            },
            externalAuthIdentities: {
              linked: Number(externalAuthIdentityCounts.linked ?? 0),
              disabled: Number(externalAuthIdentityCounts.disabled ?? 0),
              emailVerified: Number(
                externalAuthIdentityCounts.emailVerified ?? 0
              ),
              lastSeenAt: externalAuthIdentityCounts.lastSeenAt
                ? timestampIso(externalAuthIdentityCounts.lastSeenAt)
                : null
            },
            deviceCredentials: {
              active: Number(deviceCredentialCounts.active ?? 0),
              revoked: Number(deviceCredentialCounts.revoked ?? 0),
              expired: Number(deviceCredentialCounts.expired ?? 0),
              lastValidatedAt: deviceCredentialCounts.lastValidatedAt
                ? timestampIso(deviceCredentialCounts.lastValidatedAt)
                : null
            }
          }
        }
      };
    },

    async getHostedSupportOverview(
      actor: ActorContext,
      teamId: string
    ): Promise<TeamSupportOverviewRecord | null> {
      const [
        teamRows,
        billingRows,
        membershipCountRows,
        workspaceCountRows,
        workspaceAccessCountRows,
        inviteCountRows,
        shareGrantCountRows,
        auditCountRows,
        externalAuthOrganizationRows,
        externalAuthIdentityRows,
        deviceCredentialRows
      ] = await Promise.all([
        db
          .select()
          .from(teams)
          .where(and(eq(teams.id, teamId), isNull(teams.archivedAt)))
          .limit(1),
        db
          .select()
          .from(teamBillingSeatStates)
          .where(eq(teamBillingSeatStates.teamId, teamId))
          .limit(1),
        db
          .select({
            enabled: sql<number>`count(*) filter (where ${teamMemberships.status} = 'enabled')::int`,
            invited: sql<number>`count(*) filter (where ${teamMemberships.status} = 'invited')::int`,
            disabled: sql<number>`count(*) filter (where ${teamMemberships.status} = 'disabled')::int`
          })
          .from(teamMemberships)
          .where(eq(teamMemberships.teamId, teamId)),
        db
          .select({
            active: sql<number>`count(*) filter (where ${teamWorkspaces.archivedAt} is null)::int`,
            archived: sql<number>`count(*) filter (where ${teamWorkspaces.archivedAt} is not null)::int`
          })
          .from(teamWorkspaces)
          .where(eq(teamWorkspaces.teamId, teamId)),
        db
          .select({
            read: sql<number>`count(*) filter (where ${teamWorkspaceAccessGrants.access} = 'read' and ${teamWorkspaceAccessGrants.disabledAt} is null)::int`,
            write: sql<number>`count(*) filter (where ${teamWorkspaceAccessGrants.access} = 'write' and ${teamWorkspaceAccessGrants.disabledAt} is null)::int`,
            disabled: sql<number>`count(*) filter (where ${teamWorkspaceAccessGrants.access} = 'disabled' or ${teamWorkspaceAccessGrants.disabledAt} is not null)::int`
          })
          .from(teamWorkspaceAccessGrants)
          .where(eq(teamWorkspaceAccessGrants.teamId, teamId)),
        db
          .select({
            pending: sql<number>`count(*) filter (where ${teamInvites.acceptedAt} is null and ${teamInvites.revokedAt} is null and ${teamInvites.expiresAt} > now())::int`,
            accepted: sql<number>`count(*) filter (where ${teamInvites.acceptedAt} is not null)::int`,
            revoked: sql<number>`count(*) filter (where ${teamInvites.revokedAt} is not null)::int`,
            expired: sql<number>`count(*) filter (where ${teamInvites.acceptedAt} is null and ${teamInvites.revokedAt} is null and ${teamInvites.expiresAt} <= now())::int`
          })
          .from(teamInvites)
          .where(eq(teamInvites.teamId, teamId)),
        db
          .select({
            active: sql<number>`count(*) filter (where ${teamSessionShareGrants.revokedAt} is null)::int`,
            revoked: sql<number>`count(*) filter (where ${teamSessionShareGrants.revokedAt} is not null)::int`,
            retainedAfterPersonalDeletion: sql<number>`count(*) filter (where ${teamSessionShareGrants.personalDeletedAt} is not null and ${teamSessionShareGrants.retainedByTeamAt} is not null)::int`
          })
          .from(teamSessionShareGrants)
          .where(eq(teamSessionShareGrants.teamId, teamId)),
        db
          .select({
            teamEventCount: sql<number>`count(*)::int`,
            lastTeamEventAt: sql<Date | null>`max(${auditEvents.createdAt})`
          })
          .from(auditEvents)
          .where(
            and(
              sql`${auditEvents.metadata} ->> 'teamId' = ${teamId}`,
              sql`${auditEvents.action} like 'team.%'`
            )
          ),
        db
          .select({
            linked: sql<number>`count(*) filter (where ${externalAuthOrganizations.status} = 'linked')::int`,
            disabled: sql<number>`count(*) filter (where ${externalAuthOrganizations.status} = 'disabled')::int`,
            lastSeenAt: sql<Date | null>`max(${externalAuthOrganizations.lastSeenAt})`
          })
          .from(externalAuthOrganizations)
          .where(eq(externalAuthOrganizations.teamId, teamId)),
        db
          .select({
            linked: sql<number>`count(*) filter (where ${externalAuthIdentities.status} = 'linked')::int`,
            disabled: sql<number>`count(*) filter (where ${externalAuthIdentities.status} = 'disabled')::int`,
            emailVerified: sql<number>`count(*) filter (where ${externalAuthIdentities.emailVerified} = true)::int`,
            lastSeenAt: sql<Date | null>`max(${externalAuthIdentities.lastSeenAt})`
          })
          .from(externalAuthIdentities)
          .innerJoin(
            teamMemberships,
            eq(teamMemberships.userId, externalAuthIdentities.userId)
          )
          .where(eq(teamMemberships.teamId, teamId)),
        db
          .select({
            active: sql<number>`count(*) filter (where ${deviceCredentials.revokedAt} is null and (${deviceCredentials.expiresAt} is null or ${deviceCredentials.expiresAt} > now()))::int`,
            revoked: sql<number>`count(*) filter (where ${deviceCredentials.revokedAt} is not null)::int`,
            expired: sql<number>`count(*) filter (where ${deviceCredentials.revokedAt} is null and ${deviceCredentials.expiresAt} is not null and ${deviceCredentials.expiresAt} <= now())::int`,
            lastValidatedAt: sql<Date | null>`max(${deviceCredentials.lastValidatedAt})`
          })
          .from(deviceCredentials)
          .innerJoin(
            teamMemberships,
            eq(teamMemberships.userId, deviceCredentials.ownerUserId)
          )
          .where(eq(teamMemberships.teamId, teamId))
      ]);

      const team = teamRows[0];
      if (!team) {
        return null;
      }
      const membershipCounts = membershipCountRows[0] ?? {
        enabled: 0,
        invited: 0,
        disabled: 0
      };
      const workspaceCounts = workspaceCountRows[0] ?? {
        active: 0,
        archived: 0
      };
      const workspaceAccessCounts = workspaceAccessCountRows[0] ?? {
        read: 0,
        write: 0,
        disabled: 0
      };
      const inviteCounts = inviteCountRows[0] ?? {
        pending: 0,
        accepted: 0,
        revoked: 0,
        expired: 0
      };
      const shareGrantCounts = shareGrantCountRows[0] ?? {
        active: 0,
        revoked: 0,
        retainedAfterPersonalDeletion: 0
      };
      const auditCounts = auditCountRows[0] ?? {
        teamEventCount: 0,
        lastTeamEventAt: null
      };
      const externalAuthOrganizationCounts =
        externalAuthOrganizationRows[0] ?? {
          linked: 0,
          disabled: 0,
          lastSeenAt: null
        };
      const externalAuthIdentityCounts = externalAuthIdentityRows[0] ?? {
        linked: 0,
        disabled: 0,
        emailVerified: 0,
        lastSeenAt: null
      };
      const deviceCredentialCounts = deviceCredentialRows[0] ?? {
        active: 0,
        revoked: 0,
        expired: 0,
        lastValidatedAt: null
      };
      const entitlement = mapTeamEntitlementGate({
        id: team.id,
        entitlementStatus: team.entitlementStatus,
        entitlementReason: team.entitlementReason,
        entitlementUpdatedAt: team.entitlementUpdatedAt
      });

      await insertTeamAudit(db, {
        actorUserId: actor.userId,
        action: "team.hosted_support_overview.viewed",
        targetTable: "teams",
        targetId: teamId,
        metadata: {
          teamId,
          policy: "hosted_operator_redacted",
          rawContentAccess: "not_permitted"
        }
      });

      return {
        generatedAt: new Date().toISOString(),
        supportAccess: {
          policy: "hosted_operator_redacted",
          actorUserId: actor.userId,
          actorRole: "hosted_operator",
          rawContentAccess: "not_permitted",
          breakGlassRequiredForRawContent: true
        },
        team: mapTeamRecord(team),
        entitlement,
        billingSeats: billingRows[0]
          ? mapTeamBillingSeatState(billingRows[0])
          : null,
        diagnosticSurfaces: {
          auth: "browser_session",
          rawContentAccess: "not_permitted",
          operationsStatusPath: "/ops/status",
          capabilitiesPath: `/v1/capabilities/authenticated?teamId=${team.id}`,
          auditEventsPath: `/v1/teams/${team.id}/audit-events`,
          entitlementPath: `/v1/teams/${team.id}/entitlement`,
          billingSeatsPath: `/v1/teams/${team.id}/billing-seats`,
          supportOverviewPath: `/ops/support/teams/${team.id}/overview`
        },
        counts: {
          memberships: {
            enabled: Number(membershipCounts.enabled ?? 0),
            invited: Number(membershipCounts.invited ?? 0),
            disabled: Number(membershipCounts.disabled ?? 0)
          },
          workspaces: {
            active: Number(workspaceCounts.active ?? 0),
            archived: Number(workspaceCounts.archived ?? 0)
          },
          workspaceAccess: {
            read: Number(workspaceAccessCounts.read ?? 0),
            write: Number(workspaceAccessCounts.write ?? 0),
            disabled: Number(workspaceAccessCounts.disabled ?? 0)
          },
          invites: {
            pending: Number(inviteCounts.pending ?? 0),
            accepted: Number(inviteCounts.accepted ?? 0),
            revoked: Number(inviteCounts.revoked ?? 0),
            expired: Number(inviteCounts.expired ?? 0)
          },
          sessionShareGrants: {
            active: Number(shareGrantCounts.active ?? 0),
            revoked: Number(shareGrantCounts.revoked ?? 0),
            retainedAfterPersonalDeletion: Number(
              shareGrantCounts.retainedAfterPersonalDeletion ?? 0
            )
          },
          auditEvents: {
            teamEventCount: Number(auditCounts.teamEventCount ?? 0),
            lastTeamEventAt: auditCounts.lastTeamEventAt
              ? timestampIso(auditCounts.lastTeamEventAt)
              : null
          },
          setupAndIntegrations: {
            externalAuthOrganizations: {
              linked: Number(externalAuthOrganizationCounts.linked ?? 0),
              disabled: Number(externalAuthOrganizationCounts.disabled ?? 0),
              lastSeenAt: externalAuthOrganizationCounts.lastSeenAt
                ? timestampIso(externalAuthOrganizationCounts.lastSeenAt)
                : null
            },
            externalAuthIdentities: {
              linked: Number(externalAuthIdentityCounts.linked ?? 0),
              disabled: Number(externalAuthIdentityCounts.disabled ?? 0),
              emailVerified: Number(
                externalAuthIdentityCounts.emailVerified ?? 0
              ),
              lastSeenAt: externalAuthIdentityCounts.lastSeenAt
                ? timestampIso(externalAuthIdentityCounts.lastSeenAt)
                : null
            },
            deviceCredentials: {
              active: Number(deviceCredentialCounts.active ?? 0),
              revoked: Number(deviceCredentialCounts.revoked ?? 0),
              expired: Number(deviceCredentialCounts.expired ?? 0),
              lastValidatedAt: deviceCredentialCounts.lastValidatedAt
                ? timestampIso(deviceCredentialCounts.lastValidatedAt)
                : null
            }
          }
        }
      };
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
      if (!(await teamGateAllowsAccess(input.teamId))) {
        return null;
      }
      if (input.role === "owner" && manager!.role !== "owner") {
        return null;
      }
      if (input.userId === actor.userId) {
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
        const removesEnabledOwner =
          previous?.role === "owner" &&
          previous.status === "enabled" &&
          previous.disabledAt === null &&
          (input.role !== "owner" || status !== "enabled");
        if (removesEnabledOwner) {
          const ownerRows = await tx
            .select({ id: teamMemberships.id })
            .from(teamMemberships)
            .where(
              and(
                eq(teamMemberships.teamId, input.teamId),
                eq(teamMemberships.role, "owner"),
                eq(teamMemberships.status, "enabled"),
                isNull(teamMemberships.disabledAt)
              )
            )
            .for("update");
          if (ownerRows.length <= 1) {
            return null;
          }
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
        await reconcileTeamBillingSeats(tx, {
          teamId: input.teamId,
          actorUserId: actor.userId,
          reason: action
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
      if (!(await teamGateAllowsAccess(input.teamId))) {
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
      if (!(await teamGateAllowsAccess(input.teamId))) {
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
        const gate = await getTeamEntitlementGateById(inviteRow.teamId);
        if (!gate?.allowsTeamAccess) {
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
        await reconcileTeamBillingSeats(tx, {
          teamId: invite.teamId,
          actorUserId: user.id,
          reason: "team.invite.accepted"
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
      if (!(await teamGateAllowsAccess(input.teamId))) {
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
        await reconcileTeamBillingSeats(tx, {
          teamId: input.teamId,
          actorUserId: actor.userId,
          reason: "team.member.disabled"
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
      if (!accessContext.teamEntitlementAllowsAccess) {
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
