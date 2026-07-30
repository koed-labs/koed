import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  COLLABORATION_CONTRACT_VERSION,
  TEAM_ACTIVITY_WRITE_THROTTLE_MS,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import {
  auditEventValues,
  auditLimit,
  mapAuditEventRecord
} from "./audit-repository.js";
import { createDb, type KoedDb } from "./connection.js";
import {
  decryptTeamEncryptedFieldAfterAuthorizationWithClient,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import {
  auditEvents,
  collaborationOutbox,
  collaborationThreads,
  deviceCredentials,
  externalAuthIdentities,
  externalAuthOrganizations,
  teamInvites,
  teamBillingSeatStates,
  teamMemberships,
  teamRepresentationPolicies,
  retentionPolicies,
  teamSessionShareGrants,
  teams,
  teamWorkspaceAccessGrants,
  teamWorkspaces,
  workspaceRepresentationPolicies,
  users
} from "./schema.js";
import {
  DEFAULT_TEAM_BACKUP_RETENTION_SECONDS,
  DEFAULT_TEAM_DELETION_GRACE_SECONDS,
  DEFAULT_TEAM_RETENTION_SECONDS,
  retentionPolicySnapshotHash
} from "./retention-lifecycle-repository.js";
import {
  defaultSharedMemoryRepresentations,
  sharedMemoryPolicyHash
} from "./shared-memory-policy.js";
import type {
  AcceptedTeamInviteRecord,
  ActorContext,
  AuditEventRecord,
  ListTeamAuditEventsInput,
  TeamBillingSeatStateRecord,
  TeamBillingSeatSyncStatus,
  TeamInviteRecord,
  TeamInviteLifecycle,
  TeamEntitlementGateRecord,
  TeamEntitlementStatus,
  TeamMembershipRecord,
  TeamMembershipStatus,
  TeamManagementMemberRecord,
  TeamRecord,
  TeamRole,
  TeamLifecycle,
  TeamRosterMemberRecord,
  TeamSupportOverviewRecord,
  TeamWorkspaceAccessLevel,
  TeamWorkspaceAccessRecord,
  TeamWorkspaceContextRecord,
  TeamWorkspaceLifecycle,
  TeamWorkspaceRecord,
  UserRecord
} from "./types.js";

const timestampIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const nullableTimestampIso = (value: Date | string | null): string | null =>
  value ? timestampIso(value) : null;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const normalizeBoundedName = (value: string): string => {
  const normalized = value.trim().normalize("NFC");
  if (!normalized || [...normalized].length > 80) {
    throw Object.assign(
      new Error("Name must contain between 1 and 80 Unicode code points"),
      { statusCode: 400 }
    );
  }
  return normalized;
};

const hashTeamCreationValue = (domain: string, value: string): string =>
  createHash("sha256")
    .update(`koed:team-creation:${domain}:v1\n${value}`, "utf8")
    .digest("hex");

const normalizeTeamCreationIdempotencyKey = (value: string): string => {
  const normalized = value.trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized
    )
  ) {
    throw Object.assign(new Error("Team creation idempotency key is invalid"), {
      statusCode: 400
    });
  }
  return normalized.toLowerCase();
};

const defaultWorkspaceName = "General";
const defaultChannelSystemKey = "workspace.general";
const workspaceDescriptionMarker =
  "[koed encrypted team workspace description]";

const teamRosterMemberSelection = {
  userId: teamMemberships.userId,
  displayName: users.displayName,
  avatarReference: users.avatarReference,
  presenceMode: teamMemberships.presenceMode,
  manualPresenceStatus: teamMemberships.manualPresenceStatus,
  presenceVersion: teamMemberships.presenceVersion,
  lastHumanActivityAt: teamMemberships.lastHumanActivityAt
};

const mapTeamRosterMember = (row: {
  userId: string;
  displayName: string | null;
  avatarReference: string | null;
  presenceMode: string;
  manualPresenceStatus: string;
  presenceVersion: number;
  lastHumanActivityAt: Date | string | null;
}): TeamRosterMemberRecord => ({
  userId: row.userId,
  displayName: row.displayName,
  avatarReference: row.avatarReference,
  status: "enabled",
  presenceMode: row.presenceMode as "auto" | "manual",
  manualPresenceStatus: row.manualPresenceStatus as
    | "available"
    | "do_not_disturb"
    | "out_of_office",
  presenceVersion: row.presenceVersion,
  lastHumanActivityAt: nullableTimestampIso(row.lastHumanActivityAt)
});

const staleVersion = (): never => {
  throw Object.assign(new Error("Stale version"), { code: "STALE_VERSION" });
};

const inviteAcceptanceConflict = Symbol("inviteAcceptanceConflict");

const mapTeamRecord = (row: {
  id: string;
  name: string;
  version: number;
  lifecycle: TeamLifecycle;
  entitlementStatus: TeamEntitlementStatus;
  entitlementReason: string | null;
  entitlementUpdatedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  suspendedAt: Date | string | null;
  deletionRequestedAt: Date | string | null;
  tombstonedAt: Date | string | null;
  retainUntil: Date | string | null;
  purgeCompletedAt: Date | string | null;
}): TeamRecord => ({
  id: row.id,
  name: row.name,
  version: row.version,
  lifecycle: row.lifecycle,
  entitlementStatus: row.entitlementStatus,
  entitlementReason: row.entitlementReason,
  entitlementUpdatedAt: row.entitlementUpdatedAt
    ? timestampIso(row.entitlementUpdatedAt)
    : null,
  createdAt: timestampIso(row.createdAt),
  updatedAt: timestampIso(row.updatedAt),
  suspendedAt: nullableTimestampIso(row.suspendedAt),
  deletionRequestedAt: nullableTimestampIso(row.deletionRequestedAt),
  tombstonedAt: nullableTimestampIso(row.tombstonedAt),
  retainUntil: nullableTimestampIso(row.retainUntil),
  purgeCompletedAt: nullableTimestampIso(row.purgeCompletedAt)
});

const mapMembershipRecord = (row: {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  status: TeamMembershipStatus;
  version: number;
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
  version: row.version,
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
  defaultTeamWorkspaceId: string | null;
  defaultWorkspaceAccess: TeamWorkspaceAccessLevel;
  email: string;
  normalizedEmail: string | null;
  backendOriginHash: string | null;
  role: TeamRole;
  version: number;
  lifecycle: TeamInviteLifecycle;
  createdByUserId: string | null;
  acceptedByUserId: string | null;
  createdAt: Date | string;
  expiresAt: Date | string;
  acceptedAt: Date | string | null;
  revokedAt: Date | string | null;
}): TeamInviteRecord => {
  if (row.defaultWorkspaceAccess === "disabled") {
    throw new Error("Persisted Team invite has disabled Workspace access");
  }
  return {
    id: row.id,
    teamId: row.teamId,
    defaultTeamWorkspaceId: row.defaultTeamWorkspaceId!,
    defaultWorkspaceAccess: row.defaultWorkspaceAccess,
    email: row.email,
    normalizedEmail: row.normalizedEmail!,
    backendOriginHash: row.backendOriginHash!,
    role: row.role,
    version: row.version,
    lifecycle: row.lifecycle,
    createdByUserId: row.createdByUserId,
    acceptedByUserId: row.acceptedByUserId,
    createdAt: timestampIso(row.createdAt),
    expiresAt: timestampIso(row.expiresAt),
    acceptedAt: row.acceptedAt ? timestampIso(row.acceptedAt) : null,
    revokedAt: row.revokedAt ? timestampIso(row.revokedAt) : null
  };
};

type StructuralWorkspaceRecord = Omit<TeamWorkspaceRecord, "description"> & {
  descriptionMarker: string | null;
};

const mapStructuralWorkspaceRecord = (row: {
  id: string;
  teamId: string;
  name: string;
  descriptionMarker: string | null;
  version: number;
  lifecycle: TeamWorkspaceLifecycle;
  createdAt: Date | string;
  updatedAt: Date | string;
  archivedAt: Date | string | null;
  retentionPolicyId: string | null;
  retentionPolicyVersion: number | null;
  retainUntil: Date | string | null;
  purgeCompletedAt: Date | string | null;
}): StructuralWorkspaceRecord => ({
  id: row.id,
  teamId: row.teamId,
  name: row.name,
  descriptionMarker: row.descriptionMarker,
  version: row.version,
  lifecycle: row.lifecycle,
  createdAt: timestampIso(row.createdAt),
  updatedAt: timestampIso(row.updatedAt),
  archivedAt: nullableTimestampIso(row.archivedAt),
  retentionPolicyId: row.retentionPolicyId,
  retentionPolicyVersion: row.retentionPolicyVersion,
  retainUntil: nullableTimestampIso(row.retainUntil),
  purgeCompletedAt: nullableTimestampIso(row.purgeCompletedAt)
});

const normalizeWorkspaceDescription = (
  value: string | null | undefined
): string | null => {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().normalize("NFC");
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 1024) {
    throw Object.assign(
      new Error(
        "Description must contain between 1 and 1024 UTF-8 bytes when supplied"
      ),
      { statusCode: 400 }
    );
  }
  return normalized;
};

const encryptedWorkspaceDescriptionUnavailable = (): never => {
  throw new Error("Encrypted Team Workspace description is unavailable");
};

const hydrateAuthorizedWorkspaceRecord = async (
  client: pg.Pool | pg.PoolClient,
  provider: EnvelopeEncryptionProvider | undefined,
  row: Parameters<typeof mapStructuralWorkspaceRecord>[0]
): Promise<TeamWorkspaceRecord> => {
  const structural = mapStructuralWorkspaceRecord(row);
  const { descriptionMarker, ...workspace } = structural;
  if (descriptionMarker === null) {
    return { ...workspace, description: null };
  }
  if (descriptionMarker !== workspaceDescriptionMarker || !provider) {
    return encryptedWorkspaceDescriptionUnavailable();
  }
  const plaintext = await decryptTeamEncryptedFieldAfterAuthorizationWithClient(
    client,
    provider,
    {
      sourceTable: "team_workspaces",
      sourceId: workspace.id,
      sourceColumn: "description",
      teamId: workspace.teamId,
      teamWorkspaceId: workspace.id
    }
  );
  if (typeof plaintext !== "string") {
    return encryptedWorkspaceDescriptionUnavailable();
  }
  const normalized = plaintext.trim().normalize("NFC");
  if (
    normalized !== plaintext ||
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > 1024
  ) {
    return encryptedWorkspaceDescriptionUnavailable();
  }
  return { ...workspace, description: plaintext };
};

const mapTeamBillingSeatState = (row: {
  teamId: string;
  version: number;
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
  version: row.version,
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
  version: number;
  entitlementStatus: TeamEntitlementStatus;
  entitlementReason: string | null;
  entitlementUpdatedAt: Date | string | null;
}): TeamEntitlementGateRecord => ({
  teamId: row.id,
  version: row.version,
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
  teamLifecycle: TeamLifecycle;
  teamEntitlementStatus: TeamEntitlementStatus;
  workspaceLifecycle: TeamWorkspaceLifecycle;
  access: TeamWorkspaceAccessLevel | null;
  canShareOwnedMemory: boolean | null;
  accessVersion: number | null;
  accessDisabledAt: Date | string | null;
}): TeamWorkspaceAccessRecord => {
  const workspaceActive =
    row.teamLifecycle === "active" && row.workspaceLifecycle === "active";
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
  const canShareOwnedMemory =
    access === "write" && row.canShareOwnedMemory === true;
  const canManageWorkspace = canManageTeam && access === "write";

  return {
    teamWorkspaceId: row.teamWorkspaceId,
    teamId: row.teamId,
    userId: row.userId,
    role: row.role,
    membershipStatus: row.membershipStatus,
    access,
    canShareOwnedMemory,
    version: row.accessVersion,
    teamEntitlementStatus: row.teamEntitlementStatus,
    teamEntitlementAllowsAccess: entitlementAllowsAccess,
    canManageTeam,
    canManageWorkspace,
    canRecall,
    canCreateShare: canShareOwnedMemory
  };
};

export interface TeamAccessRepositoryOptions {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
}

export const createTeamAccessRepository = (
  pool: pg.Pool,
  options: TeamAccessRepositoryOptions = {}
) => {
  const db = createDb(pool);
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
          isNull(teamMemberships.disabledAt),
          eq(teams.lifecycle, "active")
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
        version: teams.version,
        entitlementStatus: teams.entitlementStatus,
        entitlementReason: teams.entitlementReason,
        entitlementUpdatedAt: teams.entitlementUpdatedAt
      })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.lifecycle, "active")))
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

  const createInitialRepresentationPolicies = async (
    tx: TeamAccessTransaction,
    input: {
      teamId: string;
      workspaceId: string;
      actorUserId: string;
      includeTeam: boolean;
    }
  ): Promise<void> => {
    const allowedRepresentations = [...defaultSharedMemoryRepresentations];
    if (input.includeTeam) {
      const policyId = randomUUID();
      await tx.insert(teamRepresentationPolicies).values({
        policyId,
        teamId: input.teamId,
        version: 1,
        allowedRepresentations,
        policyHash: sharedMemoryPolicyHash({
          scope: "team",
          scopeId: input.teamId,
          policyId,
          version: 1,
          allowedRepresentations
        }),
        createdByUserId: input.actorUserId,
        effectiveAt: sql`now()`
      });
    }
    const workspacePolicyId = randomUUID();
    await tx.insert(workspaceRepresentationPolicies).values({
      policyId: workspacePolicyId,
      teamId: input.teamId,
      teamWorkspaceId: input.workspaceId,
      version: 1,
      allowedRepresentations,
      policyHash: sharedMemoryPolicyHash({
        scope: "workspace",
        scopeId: `${input.teamId}:${input.workspaceId}`,
        policyId: workspacePolicyId,
        version: 1,
        allowedRepresentations
      }),
      createdByUserId: input.actorUserId,
      effectiveAt: sql`now()`
    });
  };

  const withTeamAccessTransaction = async <T>(
    work: (tx: TeamAccessTransaction, client: pg.PoolClient) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      return await createDb(client).transaction((tx) => work(tx, client));
    } finally {
      client.release();
    }
  };

  const withTeamAccessReadSnapshot = async <T>(
    work: (tx: TeamAccessTransaction, client: pg.PoolClient) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      return await createDb(client).transaction((tx) => work(tx, client), {
        isolationLevel: "repeatable read",
        accessMode: "read only"
      });
    } finally {
      client.release();
    }
  };

  const appendCollaborationOutboxEvent = async (
    tx: TeamAccessTransaction,
    input: {
      family:
        | "team_lifecycle"
        | "team_membership_access"
        | "team_presence_changed"
        | "workspace_lifecycle_access"
        | "thread_lifecycle"
        | "access_revoked";
      teamId: string;
      teamWorkspaceId?: string | null;
      threadId?: string | null;
      resourceType: string;
      resourceId: string;
      actorUserId: string;
    }
  ): Promise<void> => {
    const [event] = await tx
      .insert(collaborationOutbox)
      .values({
        protocolVersion: COLLABORATION_CONTRACT_VERSION,
        family: input.family,
        scope: "team",
        personalOwnerUserId: null,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId ?? null,
        threadId: input.threadId ?? null,
        messageId: null,
        shareGrantId: null,
        logicalMemoryId: null,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        actorPrincipalId: input.actorUserId,
        mutationId: randomUUID(),
        replayUntil: sql`now() + interval '30 days'`
      })
      .returning({
        cursor: collaborationOutbox.cursor,
        family: collaborationOutbox.family,
        scope: collaborationOutbox.scope,
        teamId: collaborationOutbox.teamId
      });
    if (!event) throw new Error("Collaboration outbox event was not created");
    await tx.execute(sql`
      select pg_notify(
        'koed_collaboration_realtime',
        ${JSON.stringify({
          scope: event.scope,
          personalOwnerUserId: null,
          teamId: event.teamId,
          cursor: event.cursor,
          family: event.family
        })}
      )
    `);
  };

  const getManagingMembershipForUpdate = async (
    tx: TeamAccessTransaction,
    actor: ActorContext,
    teamId: string
  ) => {
    const rows = await tx
      .select({ membership: teamMemberships })
      .from(teamMemberships)
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .where(
        and(
          eq(teamMemberships.teamId, teamId),
          eq(teamMemberships.userId, actor.userId),
          inArray(teamMemberships.role, ["owner", "admin"]),
          eq(teamMemberships.status, "enabled"),
          isNull(teamMemberships.disabledAt),
          eq(teams.lifecycle, "active"),
          inArray(teams.entitlementStatus, ["active", "grace"])
        )
      )
      .limit(1)
      .for("update");

    return rows[0]?.membership ?? null;
  };

  const getOwnerMembershipForUpdate = async (
    tx: TeamAccessTransaction,
    actor: ActorContext,
    teamId: string
  ) => {
    const rows = await tx
      .select({ membership: teamMemberships })
      .from(teamMemberships)
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .where(
        and(
          eq(teamMemberships.teamId, teamId),
          eq(teamMemberships.userId, actor.userId),
          eq(teamMemberships.role, "owner"),
          eq(teamMemberships.status, "enabled"),
          isNull(teamMemberships.disabledAt),
          eq(teams.lifecycle, "active")
        )
      )
      .limit(1)
      .for("update");

    return rows[0]?.membership ?? null;
  };

  const lockTeamOwnerLifecycle = async (
    tx: TeamAccessTransaction,
    teamId: string
  ): Promise<void> => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`team-owners:${teamId}`}, 0))`
    );
  };

  const getDefaultTeamWorkspaceForUpdate = async (
    tx: TeamAccessTransaction,
    teamId: string
  ) => {
    const rows = await tx
      .select({
        id: teamWorkspaces.id,
        lifecycle: teamWorkspaces.lifecycle
      })
      .from(teamWorkspaces)
      .where(eq(teamWorkspaces.teamId, teamId))
      .orderBy(teamWorkspaces.createdAt, teamWorkspaces.id)
      .limit(1)
      .for("update");

    return rows[0] ?? null;
  };

  const reconcileTeamBillingSeats = async (
    tx: TeamAccessTransaction,
    input: {
      teamId: string;
      actorUserId: string | null;
      reason: string;
      initialSync?: boolean;
      seatLimit?: number | null;
      expectedVersion?: number;
    }
  ): Promise<TeamBillingSeatStateRecord | null> => {
    const existingRows = await tx
      .select()
      .from(teamBillingSeatStates)
      .where(eq(teamBillingSeatStates.teamId, input.teamId))
      .limit(1)
      .for("update");
    const existing = existingRows[0] ?? null;
    if (
      input.expectedVersion !== undefined &&
      existing?.version !== input.expectedVersion
    ) {
      staleVersion();
    }

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
    const seatLimit =
      input.seatLimit !== undefined
        ? input.seatLimit
        : (existing?.seatLimit ?? null);
    const overLimit = seatLimit !== null && billableSeatCount > seatLimit;
    const syncStatus: TeamBillingSeatSyncStatus = overLimit
      ? "over_limit"
      : input.initialSync && !existing
        ? "synced"
        : "pending_provider_update";

    const changed =
      !existing ||
      existing.billableSeatCount !== billableSeatCount ||
      existing.pendingBillingSeatCount !== billableSeatCount ||
      existing.syncStatus !== syncStatus ||
      existing.seatLimit !== seatLimit;
    if (!changed) {
      return mapTeamBillingSeatState(existing);
    }

    const rows = existing
      ? await tx
          .update(teamBillingSeatStates)
          .set({
            seatLimit,
            billableSeatCount,
            pendingBillingSeatCount: billableSeatCount,
            syncStatus,
            overLimitAt: overLimit
              ? sql`coalesce(${teamBillingSeatStates.overLimitAt}, now())`
              : null,
            lastErrorMessage: null,
            updatedByUserId: input.actorUserId,
            version: sql`${teamBillingSeatStates.version} + 1`,
            updatedAt: sql`now()`
          })
          .where(
            and(
              eq(teamBillingSeatStates.teamId, input.teamId),
              eq(teamBillingSeatStates.version, existing.version)
            )
          )
          .returning()
      : await tx
          .insert(teamBillingSeatStates)
          .values({
            teamId: input.teamId,
            version: 1,
            seatLimit,
            billableSeatCount,
            pendingBillingSeatCount: billableSeatCount,
            syncStatus,
            overLimitAt: overLimit ? sql`now()` : null,
            updatedByUserId: input.actorUserId
          })
          .returning();
    if (!rows[0]) {
      staleVersion();
    }
    const state = mapTeamBillingSeatState(rows[0]!);

    const teamRows = await tx
      .select({
        entitlementStatus: teams.entitlementStatus,
        entitlementReason: teams.entitlementReason
      })
      .from(teams)
      .where(and(eq(teams.id, input.teamId), eq(teams.lifecycle, "active")))
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
            version: sql`${teams.version} + 1`,
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
            version: sql`${teams.version} + 1`,
            updatedAt: sql`now()`
          })
          .where(eq(teams.id, input.teamId));
      }
    }

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
        teamLifecycle: teams.lifecycle,
        teamEntitlementStatus: teams.entitlementStatus,
        workspaceLifecycle: teamWorkspaces.lifecycle,
        access: teamWorkspaceAccessGrants.access,
        canShareOwnedMemory: teamWorkspaceAccessGrants.canShareOwnedMemory,
        accessVersion: teamWorkspaceAccessGrants.version,
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

  const disableWorkspaceAccessGrantsForMembership = async (
    tx: TeamAccessTransaction,
    input: {
      teamId: string;
      userId: string;
      actorUserId: string;
      reason: "member_left" | "membership_disabled";
    }
  ): Promise<void> => {
    const grants = await tx
      .select()
      .from(teamWorkspaceAccessGrants)
      .where(
        and(
          eq(teamWorkspaceAccessGrants.teamId, input.teamId),
          eq(teamWorkspaceAccessGrants.userId, input.userId),
          isNull(teamWorkspaceAccessGrants.disabledAt)
        )
      )
      .for("update");

    for (const grant of grants) {
      const updatedRows = await tx
        .update(teamWorkspaceAccessGrants)
        .set({
          disabledAt: sql`now()`,
          disabledReason: input.reason,
          version: sql`${teamWorkspaceAccessGrants.version} + 1`,
          updatedAt: sql`now()`
        })
        .where(
          and(
            eq(
              teamWorkspaceAccessGrants.teamWorkspaceId,
              grant.teamWorkspaceId
            ),
            eq(teamWorkspaceAccessGrants.userId, grant.userId),
            eq(teamWorkspaceAccessGrants.version, grant.version)
          )
        )
        .returning({ version: teamWorkspaceAccessGrants.version });
      const updated = updatedRows[0];
      if (!updated) {
        throw new Error("Locked Workspace access grant changed unexpectedly");
      }

      await insertTeamAudit(tx, {
        actorUserId: input.actorUserId,
        action: "team.workspace_access.removed",
        targetTable: "team_workspace_access_grants",
        targetId: grant.teamWorkspaceId,
        metadata: {
          teamId: input.teamId,
          teamWorkspaceId: grant.teamWorkspaceId,
          userId: input.userId,
          previousAccess: grant.access,
          access: "disabled",
          previousVersion: grant.version,
          version: updated.version,
          source: input.reason
        }
      });
      await appendCollaborationOutboxEvent(tx, {
        family: "access_revoked",
        teamId: input.teamId,
        teamWorkspaceId: grant.teamWorkspaceId,
        resourceType: "team_workspace_access",
        resourceId: grant.teamWorkspaceId,
        actorUserId: input.actorUserId
      });
    }
  };

  return {
    async createTeam(
      actor: ActorContext,
      input: { name: string; idempotencyKey?: string }
    ): Promise<TeamRecord> {
      const name = normalizeBoundedName(input.name);
      const idempotencyKey = input.idempotencyKey
        ? normalizeTeamCreationIdempotencyKey(input.idempotencyKey)
        : null;
      const creationIdempotencyKeyHash = idempotencyKey
        ? hashTeamCreationValue("idempotency-key", idempotencyKey)
        : null;
      const creationRequestHash = idempotencyKey
        ? hashTeamCreationValue("request", JSON.stringify({ name }))
        : null;
      return db.transaction(async (tx) => {
        const teamInsert = tx.insert(teams).values({
          name,
          createdByUserId: idempotencyKey ? actor.userId : null,
          creationIdempotencyKeyHash,
          creationRequestHash
        });
        const teamRows = idempotencyKey
          ? await teamInsert
              .onConflictDoNothing({
                target: [
                  teams.createdByUserId,
                  teams.creationIdempotencyKeyHash
                ],
                where: sql`${teams.creationIdempotencyKeyHash} is not null`
              })
              .returning()
          : await teamInsert.returning();
        const team = teamRows[0];
        if (!team) {
          const existingRows = await tx
            .select()
            .from(teams)
            .where(
              and(
                eq(teams.createdByUserId, actor.userId),
                eq(
                  teams.creationIdempotencyKeyHash,
                  creationIdempotencyKeyHash!
                )
              )
            )
            .limit(1);
          const existing = existingRows[0];
          if (!existing) {
            throw new Error("Team creation idempotency state is unavailable");
          }
          if (existing.creationRequestHash !== creationRequestHash) {
            throw Object.assign(
              new Error("Team creation idempotency key was reused"),
              { code: "IDEMPOTENCY_CONFLICT", statusCode: 409 }
            );
          }
          return mapTeamRecord(existing);
        }

        await tx.insert(teamMemberships).values({
          teamId: team.id,
          userId: actor.userId,
          role: "owner",
          status: "enabled",
          version: 1,
          acceptedAt: sql`now()`
        });

        const workspaceRows = await tx
          .insert(teamWorkspaces)
          .values({
            teamId: team.id,
            name: defaultWorkspaceName,
            lifecycle: "active"
          })
          .returning();
        const workspace = workspaceRows[0]!;

        const retentionPolicyId = randomUUID();
        const retentionClock = await tx.execute<{ now: Date | string }>(
          sql`select transaction_timestamp() as now`
        );
        const retentionEffectiveAt = new Date(retentionClock.rows[0]!.now);
        if (!Number.isFinite(retentionEffectiveAt.getTime())) {
          throw new Error("Team retention policy timestamp is invalid");
        }
        const retentionTarget = {
          scope: "team" as const,
          teamId: team.id
        };
        await tx.insert(retentionPolicies).values({
          policyId: retentionPolicyId,
          version: 1,
          scope: "team",
          teamId: team.id,
          retentionSeconds: DEFAULT_TEAM_RETENTION_SECONDS,
          deletionGraceSeconds: DEFAULT_TEAM_DELETION_GRACE_SECONDS,
          backupRetentionSeconds: DEFAULT_TEAM_BACKUP_RETENTION_SECONDS,
          policyHash: retentionPolicySnapshotHash({
            policyId: retentionPolicyId,
            version: 1,
            target: retentionTarget,
            retentionSeconds: DEFAULT_TEAM_RETENTION_SECONDS,
            deletionGraceSeconds: DEFAULT_TEAM_DELETION_GRACE_SECONDS,
            backupRetentionSeconds: DEFAULT_TEAM_BACKUP_RETENTION_SECONDS,
            effectiveAt: retentionEffectiveAt
          }),
          createdByUserId: actor.userId,
          effectiveAt: retentionEffectiveAt
        });

        await createInitialRepresentationPolicies(tx, {
          teamId: team.id,
          workspaceId: workspace.id,
          actorUserId: actor.userId,
          includeTeam: true
        });

        await tx.insert(teamWorkspaceAccessGrants).values({
          teamWorkspaceId: workspace.id,
          teamId: team.id,
          userId: actor.userId,
          access: "write",
          canShareOwnedMemory: true,
          version: 1,
          grantedByUserId: actor.userId
        });

        const threadRows = await tx
          .insert(collaborationThreads)
          .values({
            scope: "team",
            kind: "workspace_channel",
            teamId: team.id,
            teamWorkspaceId: workspace.id,
            systemKey: defaultChannelSystemKey,
            createdByUserId: actor.userId
          })
          .returning({ id: collaborationThreads.id });
        const thread = threadRows[0]!;

        const record = mapTeamRecord(team);
        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.created",
          targetTable: "teams",
          targetId: record.id,
          metadata: {
            teamId: record.id,
            version: record.version,
            defaultTeamWorkspaceId: workspace.id,
            defaultThreadId: thread.id,
            retentionPolicyId,
            retentionPolicyVersion: 1
          }
        });
        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.workspace.created",
          targetTable: "team_workspaces",
          targetId: workspace.id,
          metadata: {
            teamId: team.id,
            teamWorkspaceId: workspace.id,
            version: workspace.version,
            defaultWorkspace: true
          }
        });
        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.thread.created",
          targetTable: "collaboration_threads",
          targetId: thread.id,
          metadata: {
            teamId: team.id,
            teamWorkspaceId: workspace.id,
            structuralDefault: true
          }
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "team_lifecycle",
          teamId: team.id,
          resourceType: "team",
          resourceId: team.id,
          actorUserId: actor.userId
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "workspace_lifecycle_access",
          teamId: team.id,
          teamWorkspaceId: workspace.id,
          resourceType: "team_workspace",
          resourceId: workspace.id,
          actorUserId: actor.userId
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "thread_lifecycle",
          teamId: team.id,
          teamWorkspaceId: workspace.id,
          threadId: thread.id,
          resourceType: "collaboration_thread",
          resourceId: thread.id,
          actorUserId: actor.userId
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

    async listTeams(actor: ActorContext): Promise<TeamRecord[]> {
      const rows = await db
        .select({ team: teams })
        .from(teams)
        .innerJoin(teamMemberships, eq(teamMemberships.teamId, teams.id))
        .where(
          and(
            eq(teamMemberships.userId, actor.userId),
            eq(teamMemberships.status, "enabled"),
            isNull(teamMemberships.disabledAt),
            eq(teams.lifecycle, "active")
          )
        )
        .orderBy(desc(teams.createdAt));

      return rows.map((row) => mapTeamRecord(row.team));
    },

    async getTeamDefaultWorkspace(
      actor: ActorContext,
      teamId: string
    ): Promise<TeamWorkspaceRecord | null> {
      const rows = await db
        .select({ workspace: teamWorkspaces })
        .from(teamWorkspaces)
        .innerJoin(teams, eq(teams.id, teamWorkspaces.teamId))
        .innerJoin(
          teamMemberships,
          and(
            eq(teamMemberships.teamId, teamWorkspaces.teamId),
            eq(teamMemberships.userId, actor.userId)
          )
        )
        .innerJoin(
          teamWorkspaceAccessGrants,
          and(
            eq(teamWorkspaceAccessGrants.teamWorkspaceId, teamWorkspaces.id),
            eq(teamWorkspaceAccessGrants.teamId, teamWorkspaces.teamId),
            eq(teamWorkspaceAccessGrants.userId, actor.userId)
          )
        )
        .innerJoin(
          collaborationThreads,
          and(
            eq(collaborationThreads.teamId, teamWorkspaces.teamId),
            eq(collaborationThreads.teamWorkspaceId, teamWorkspaces.id),
            eq(collaborationThreads.kind, "workspace_channel"),
            eq(collaborationThreads.systemKey, defaultChannelSystemKey)
          )
        )
        .where(
          and(
            eq(teamWorkspaces.teamId, teamId),
            eq(teamWorkspaces.lifecycle, "active"),
            eq(teams.lifecycle, "active"),
            inArray(teams.entitlementStatus, ["active", "grace"]),
            eq(teamMemberships.status, "enabled"),
            isNull(teamMemberships.disabledAt),
            isNull(teamWorkspaceAccessGrants.disabledAt),
            inArray(teamWorkspaceAccessGrants.access, ["read", "write"])
          )
        )
        .limit(1);
      return rows[0]
        ? hydrateAuthorizedWorkspaceRecord(
            pool,
            options.envelopeEncryptionProvider,
            rows[0].workspace
          )
        : null;
    },

    async getTeamMembership(
      actor: ActorContext,
      teamId: string
    ): Promise<TeamMembershipRecord | null> {
      const rows = await db
        .select({ membership: teamMemberships })
        .from(teamMemberships)
        .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
        .where(
          and(
            eq(teamMemberships.teamId, teamId),
            eq(teamMemberships.userId, actor.userId),
            eq(teamMemberships.status, "enabled"),
            isNull(teamMemberships.disabledAt),
            eq(teams.lifecycle, "active")
          )
        )
        .limit(1);

      return rows[0] ? mapMembershipRecord(rows[0].membership) : null;
    },

    async listTeamRoster(
      actor: ActorContext,
      teamId: string
    ): Promise<TeamRosterMemberRecord[] | null> {
      if (!(await this.getTeamMembership(actor, teamId))) {
        return null;
      }
      const rows = await db
        .select(teamRosterMemberSelection)
        .from(teamMemberships)
        .innerJoin(users, eq(users.id, teamMemberships.userId))
        .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
        .where(
          and(
            eq(teamMemberships.teamId, teamId),
            eq(teamMemberships.status, "enabled"),
            isNull(teamMemberships.disabledAt),
            eq(teams.lifecycle, "active")
          )
        )
        .orderBy(users.displayName, users.id);

      return rows.map(mapTeamRosterMember);
    },

    async getTeamRosterMember(
      actor: ActorContext,
      teamId: string,
      userId: string
    ): Promise<TeamRosterMemberRecord | null> {
      if (!(await this.getTeamMembership(actor, teamId))) {
        return null;
      }
      const [row] = await db
        .select(teamRosterMemberSelection)
        .from(teamMemberships)
        .innerJoin(users, eq(users.id, teamMemberships.userId))
        .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
        .where(
          and(
            eq(teamMemberships.teamId, teamId),
            eq(teamMemberships.userId, userId),
            eq(teamMemberships.status, "enabled"),
            isNull(teamMemberships.disabledAt),
            eq(teams.lifecycle, "active")
          )
        )
        .limit(1);

      return row ? mapTeamRosterMember(row) : null;
    },

    async setTeamPresence(
      actor: ActorContext,
      input: {
        teamId: string;
        mode: "auto" | "manual";
        manualPresenceStatus: "available" | "do_not_disturb" | "out_of_office";
        expectedVersion: number;
      }
    ): Promise<TeamRosterMemberRecord | null> {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(teamMemberships)
          .set({
            presenceMode: input.mode,
            manualPresenceStatus: input.manualPresenceStatus,
            presenceVersion: sql`${teamMemberships.presenceVersion} + 1`,
            updatedAt: sql`now()`
          })
          .where(
            and(
              eq(teamMemberships.teamId, input.teamId),
              eq(teamMemberships.userId, actor.userId),
              eq(teamMemberships.status, "enabled"),
              isNull(teamMemberships.disabledAt),
              eq(teamMemberships.presenceVersion, input.expectedVersion)
            )
          )
          .returning({
            userId: teamMemberships.userId,
            presenceMode: teamMemberships.presenceMode,
            manualPresenceStatus: teamMemberships.manualPresenceStatus,
            presenceVersion: teamMemberships.presenceVersion,
            lastHumanActivityAt: teamMemberships.lastHumanActivityAt
          });
        if (!updated) return null;
        const [user] = await tx
          .select({
            displayName: users.displayName,
            avatarReference: users.avatarReference
          })
          .from(users)
          .where(eq(users.id, actor.userId))
          .limit(1);
        if (!user) throw new Error("Team member user was not found");
        await appendCollaborationOutboxEvent(tx, {
          family: "team_presence_changed",
          teamId: input.teamId,
          resourceType: "team_member_presence",
          resourceId: actor.userId,
          actorUserId: actor.userId
        });
        return {
          userId: updated.userId,
          displayName: user.displayName,
          avatarReference: user.avatarReference,
          status: "enabled",
          presenceMode: updated.presenceMode as "auto" | "manual",
          manualPresenceStatus: updated.manualPresenceStatus as
            | "available"
            | "do_not_disturb"
            | "out_of_office",
          presenceVersion: updated.presenceVersion,
          lastHumanActivityAt: nullableTimestampIso(updated.lastHumanActivityAt)
        };
      });
    },

    async recordTeamHumanActivity(
      actor: ActorContext,
      teamIds: string[]
    ): Promise<string[]> {
      const accepted: string[] = [];
      const cutoff = new Date(Date.now() - TEAM_ACTIVITY_WRITE_THROTTLE_MS);
      for (const teamId of [...new Set(teamIds)]) {
        const changed = await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(teamMemberships)
            .set({
              lastHumanActivityAt: sql`now()`
            })
            .where(
              and(
                eq(teamMemberships.teamId, teamId),
                eq(teamMemberships.userId, actor.userId),
                eq(teamMemberships.status, "enabled"),
                isNull(teamMemberships.disabledAt),
                or(
                  isNull(teamMemberships.lastHumanActivityAt),
                  lt(teamMemberships.lastHumanActivityAt, cutoff)
                )
              )
            )
            .returning({
              userId: teamMemberships.userId,
              presenceMode: teamMemberships.presenceMode
            });
          if (!updated) return false;
          if (updated.presenceMode === "auto") {
            await appendCollaborationOutboxEvent(tx, {
              family: "team_presence_changed",
              teamId,
              resourceType: "team_member_presence",
              resourceId: actor.userId,
              actorUserId: actor.userId
            });
          }
          return true;
        });
        if (changed) accepted.push(teamId);
      }
      return accepted;
    },

    async listTeamManagementMembers(
      actor: ActorContext,
      teamId: string
    ): Promise<TeamManagementMemberRecord[] | null> {
      const manager = await getManagingMembership(actor, teamId);
      if (!membershipManages(manager)) {
        return null;
      }
      const rows = await db
        .select({
          membership: teamMemberships,
          email: users.email,
          displayName: users.displayName,
          avatarReference: users.avatarReference
        })
        .from(teamMemberships)
        .innerJoin(users, eq(users.id, teamMemberships.userId))
        .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
        .where(
          and(eq(teamMemberships.teamId, teamId), eq(teams.lifecycle, "active"))
        )
        .orderBy(teamMemberships.createdAt, teamMemberships.id);

      const accessRows = await db
        .select({
          teamWorkspaceId: teamWorkspaceAccessGrants.teamWorkspaceId,
          userId: teamWorkspaceAccessGrants.userId,
          access: teamWorkspaceAccessGrants.access,
          version: teamWorkspaceAccessGrants.version,
          disabledAt: teamWorkspaceAccessGrants.disabledAt
        })
        .from(teamWorkspaceAccessGrants)
        .innerJoin(
          teamWorkspaces,
          eq(teamWorkspaces.id, teamWorkspaceAccessGrants.teamWorkspaceId)
        )
        .where(eq(teamWorkspaces.teamId, teamId))
        .orderBy(
          teamWorkspaceAccessGrants.userId,
          teamWorkspaceAccessGrants.teamWorkspaceId
        );
      const accessByUser = new Map<
        string,
        TeamManagementMemberRecord["workspaceAccess"]
      >();
      for (const access of accessRows) {
        const entries = accessByUser.get(access.userId) ?? [];
        entries.push({
          teamWorkspaceId: access.teamWorkspaceId,
          userId: access.userId,
          access: access.disabledAt === null ? access.access : "disabled",
          version: access.version
        });
        accessByUser.set(access.userId, entries);
      }

      return rows.map((row) => ({
        ...mapMembershipRecord(row.membership),
        email: row.email,
        displayName: row.displayName,
        avatarReference: row.avatarReference,
        presenceMode: row.membership.presenceMode as "auto" | "manual",
        manualPresenceStatus: row.membership.manualPresenceStatus as
          | "available"
          | "do_not_disturb"
          | "out_of_office",
        presenceVersion: row.membership.presenceVersion,
        lastHumanActivityAt: nullableTimestampIso(
          row.membership.lastHumanActivityAt
        ),
        workspaceAccess: accessByUser.get(row.membership.userId) ?? []
      }));
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
        expectedVersion: number;
        status: TeamEntitlementStatus;
        reason?: string | null;
      }
    ): Promise<TeamEntitlementGateRecord | null> {
      return db.transaction(async (tx) => {
        const owner = await getOwnerMembershipForUpdate(
          tx,
          actor,
          input.teamId
        );
        if (!owner) {
          return null;
        }
        const existingRows = await tx
          .select({
            id: teams.id,
            version: teams.version,
            entitlementStatus: teams.entitlementStatus,
            entitlementReason: teams.entitlementReason,
            entitlementUpdatedAt: teams.entitlementUpdatedAt
          })
          .from(teams)
          .where(and(eq(teams.id, input.teamId), eq(teams.lifecycle, "active")))
          .limit(1)
          .for("update");
        const existing = existingRows[0];
        if (!existing) {
          return null;
        }
        if (existing.version !== input.expectedVersion) {
          staleVersion();
        }

        const rows = await tx
          .update(teams)
          .set({
            entitlementStatus: input.status,
            entitlementReason: input.reason?.trim() || null,
            entitlementUpdatedAt: sql`now()`,
            version: sql`${teams.version} + 1`,
            updatedAt: sql`now()`
          })
          .where(
            and(
              eq(teams.id, input.teamId),
              eq(teams.lifecycle, "active"),
              eq(teams.version, input.expectedVersion)
            )
          )
          .returning({
            id: teams.id,
            version: teams.version,
            entitlementStatus: teams.entitlementStatus,
            entitlementReason: teams.entitlementReason,
            entitlementUpdatedAt: teams.entitlementUpdatedAt
          });
        if (!rows[0]) {
          return null;
        }
        const gate = mapTeamEntitlementGate(rows[0]);

        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.entitlement.changed",
          targetTable: "teams",
          targetId: input.teamId,
          metadata: {
            teamId: input.teamId,
            previousStatus: existing.entitlementStatus,
            previousVersion: existing.version,
            version: gate.version,
            status: gate.status,
            reason: gate.reason,
            deniedOperationFamilies: gate.deniedOperationFamilies
          }
        });
        await appendCollaborationOutboxEvent(tx, {
          family: gate.allowsTeamAccess ? "team_lifecycle" : "access_revoked",
          teamId: input.teamId,
          resourceType: "team_entitlement",
          resourceId: input.teamId,
          actorUserId: actor.userId
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
      input: {
        teamId: string;
        expectedVersion: number;
        seatLimit: number | null;
      }
    ): Promise<TeamBillingSeatStateRecord | null> {
      if (
        input.seatLimit !== null &&
        (!Number.isInteger(input.seatLimit) || input.seatLimit < 0)
      ) {
        throw new Error("seatLimit must be a non-negative integer or null");
      }

      return db.transaction(async (tx) => {
        const owner = await getOwnerMembershipForUpdate(
          tx,
          actor,
          input.teamId
        );
        if (!owner) {
          return null;
        }

        return reconcileTeamBillingSeats(tx, {
          teamId: input.teamId,
          actorUserId: actor.userId,
          reason: "seat_policy_changed",
          seatLimit: input.seatLimit,
          expectedVersion: input.expectedVersion
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
          .where(and(eq(teams.id, teamId), eq(teams.lifecycle, "active")))
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
            active: sql<number>`count(*) filter (where ${teamWorkspaces.lifecycle} = 'active')::int`,
            archived: sql<number>`count(*) filter (where ${teamWorkspaces.lifecycle} = 'archived')::int`
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
            pending: sql<number>`count(*) filter (where ${teamInvites.lifecycle} = 'pending' and ${teamInvites.expiresAt} > now())::int`,
            accepted: sql<number>`count(*) filter (where ${teamInvites.lifecycle} = 'accepted')::int`,
            revoked: sql<number>`count(*) filter (where ${teamInvites.lifecycle} = 'revoked')::int`,
            expired: sql<number>`count(*) filter (where ${teamInvites.lifecycle} = 'expired' or (${teamInvites.lifecycle} = 'pending' and ${teamInvites.expiresAt} <= now()))::int`
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
        version: team.version,
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
            active: sql<number>`count(*) filter (where ${teamWorkspaces.lifecycle} = 'active')::int`,
            archived: sql<number>`count(*) filter (where ${teamWorkspaces.lifecycle} = 'archived')::int`
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
            pending: sql<number>`count(*) filter (where ${teamInvites.lifecycle} = 'pending' and ${teamInvites.expiresAt} > now())::int`,
            accepted: sql<number>`count(*) filter (where ${teamInvites.lifecycle} = 'accepted')::int`,
            revoked: sql<number>`count(*) filter (where ${teamInvites.lifecycle} = 'revoked')::int`,
            expired: sql<number>`count(*) filter (where ${teamInvites.lifecycle} = 'expired' or (${teamInvites.lifecycle} = 'pending' and ${teamInvites.expiresAt} <= now()))::int`
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
        version: team.version,
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

    async updateTeamMemberRole(
      actor: ActorContext,
      input: {
        teamId: string;
        userId: string;
        role: TeamRole;
        expectedVersion: number;
      }
    ): Promise<TeamMembershipRecord | null> {
      const manager = await getManagingMembership(actor, input.teamId);
      if (
        !membershipManages(manager) ||
        !(await teamGateAllowsAccess(input.teamId))
      ) {
        return null;
      }

      return db.transaction(async (tx) => {
        await lockTeamOwnerLifecycle(tx, input.teamId);
        const lockedManager = await getManagingMembershipForUpdate(
          tx,
          actor,
          input.teamId
        );
        if (!membershipManages(lockedManager)) {
          return null;
        }
        const targetRows = await tx
          .select()
          .from(teamMemberships)
          .where(
            and(
              eq(teamMemberships.teamId, input.teamId),
              eq(teamMemberships.userId, input.userId),
              eq(teamMemberships.status, "enabled"),
              isNull(teamMemberships.disabledAt)
            )
          )
          .limit(1)
          .for("update");
        const target = targetRows[0];
        if (!target) {
          return null;
        }
        if (target.version !== input.expectedVersion) {
          staleVersion();
        }
        if (
          lockedManager!.role !== "owner" &&
          (target.role === "owner" || input.role === "owner")
        ) {
          return null;
        }

        if (target.role === "owner" && input.role !== "owner") {
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
          .update(teamMemberships)
          .set({
            role: input.role,
            version: sql`${teamMemberships.version} + 1`,
            updatedAt: sql`now()`
          })
          .where(
            and(
              eq(teamMemberships.id, target.id),
              eq(teamMemberships.version, input.expectedVersion)
            )
          )
          .returning();
        if (!rows[0]) {
          return null;
        }
        const membership = mapMembershipRecord(rows[0]);

        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.member.role_changed",
          targetTable: "team_memberships",
          targetId: membership.id,
          metadata: {
            teamId: input.teamId,
            userId: input.userId,
            previousRole: target.role,
            role: membership.role,
            previousVersion: target.version,
            version: membership.version
          }
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "team_membership_access",
          teamId: input.teamId,
          resourceType: "team_membership",
          resourceId: membership.id,
          actorUserId: actor.userId
        });

        return membership;
      });
    },

    async leaveTeam(
      actor: ActorContext,
      input: { teamId: string; expectedVersion: number }
    ): Promise<TeamMembershipRecord | null> {
      return db.transaction(async (tx) => {
        await lockTeamOwnerLifecycle(tx, input.teamId);
        const membershipRows = await tx
          .select()
          .from(teamMemberships)
          .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
          .where(
            and(
              eq(teamMemberships.teamId, input.teamId),
              eq(teamMemberships.userId, actor.userId),
              eq(teamMemberships.status, "enabled"),
              isNull(teamMemberships.disabledAt),
              eq(teams.lifecycle, "active")
            )
          )
          .limit(1)
          .for("update");
        const membership = membershipRows[0]?.team_memberships;
        if (!membership) {
          return null;
        }
        if (membership.version !== input.expectedVersion) {
          staleVersion();
        }

        if (membership.role === "owner") {
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

        const disabledRows = await tx
          .update(teamMemberships)
          .set({
            status: "disabled",
            disabledAt: sql`now()`,
            disabledReason: "member_left",
            version: sql`${teamMemberships.version} + 1`,
            updatedAt: sql`now()`
          })
          .where(
            and(
              eq(teamMemberships.id, membership.id),
              eq(teamMemberships.version, input.expectedVersion)
            )
          )
          .returning();
        if (!disabledRows[0]) {
          return null;
        }
        const disabledMembership = mapMembershipRecord(disabledRows[0]);

        await disableWorkspaceAccessGrantsForMembership(tx, {
          teamId: input.teamId,
          userId: actor.userId,
          actorUserId: actor.userId,
          reason: "member_left"
        });

        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.member.left",
          targetTable: "team_memberships",
          targetId: membership.id,
          metadata: {
            teamId: input.teamId,
            userId: actor.userId,
            role: membership.role,
            previousVersion: membership.version,
            version: disabledMembership.version
          }
        });
        await reconcileTeamBillingSeats(tx, {
          teamId: input.teamId,
          actorUserId: actor.userId,
          reason: "team.member.left"
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "access_revoked",
          teamId: input.teamId,
          resourceType: "team_membership",
          resourceId: disabledMembership.id,
          actorUserId: actor.userId
        });

        return disabledMembership;
      });
    },

    async createTeamWorkspace(
      actor: ActorContext,
      input: { teamId: string; name: string; description?: string | null }
    ): Promise<TeamWorkspaceRecord | null> {
      const description = normalizeWorkspaceDescription(input.description);
      if (description !== null && !options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required for Team Workspace descriptions"
        );
      }
      const manager = await getManagingMembership(actor, input.teamId);
      if (!membershipManages(manager)) {
        return null;
      }
      if (!(await teamGateAllowsAccess(input.teamId))) {
        return null;
      }

      return withTeamAccessTransaction(async (tx, client) => {
        const lockedManager = await getManagingMembershipForUpdate(
          tx,
          actor,
          input.teamId
        );
        if (!membershipManages(lockedManager)) {
          return null;
        }
        const rows = await tx
          .insert(teamWorkspaces)
          .values({
            teamId: input.teamId,
            name: normalizeBoundedName(input.name),
            descriptionMarker:
              description === null ? null : workspaceDescriptionMarker
          })
          .returning();
        const workspaceRow = rows[0]!;

        await createInitialRepresentationPolicies(tx, {
          teamId: workspaceRow.teamId,
          workspaceId: workspaceRow.id,
          actorUserId: actor.userId,
          includeTeam: false
        });

        await tx.insert(teamWorkspaceAccessGrants).values({
          teamWorkspaceId: workspaceRow.id,
          teamId: workspaceRow.teamId,
          userId: actor.userId,
          access: "write",
          canShareOwnedMemory: true,
          version: 1,
          grantedByUserId: actor.userId
        });

        const threadRows = await tx
          .insert(collaborationThreads)
          .values({
            scope: "team",
            kind: "workspace_channel",
            teamId: workspaceRow.teamId,
            teamWorkspaceId: workspaceRow.id,
            systemKey: defaultChannelSystemKey,
            createdByUserId: actor.userId
          })
          .returning({ id: collaborationThreads.id });
        const thread = threadRows[0]!;

        if (description !== null) {
          await upsertEncryptedFieldPayloadWithClient(
            client,
            actor,
            options.envelopeEncryptionProvider!,
            {
              sourceTable: "team_workspaces",
              sourceId: workspaceRow.id,
              sourceColumn: "description",
              plaintext: description,
              visibility: "team",
              teamId: workspaceRow.teamId,
              teamWorkspaceId: workspaceRow.id,
              scope: {
                teamId: workspaceRow.teamId,
                workspaceId: workspaceRow.id,
                objectClass: "team_workspace"
              },
              rowFamily: "team_workspace",
              aad: { teamWorkspaceId: workspaceRow.id }
            }
          );
        }
        const workspace = await hydrateAuthorizedWorkspaceRecord(
          client,
          options.envelopeEncryptionProvider,
          workspaceRow
        );
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
        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.thread.created",
          targetTable: "collaboration_threads",
          targetId: thread.id,
          metadata: {
            teamId: workspace.teamId,
            teamWorkspaceId: workspace.id,
            structuralDefault: true
          }
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "workspace_lifecycle_access",
          teamId: workspace.teamId,
          teamWorkspaceId: workspace.id,
          resourceType: "team_workspace",
          resourceId: workspace.id,
          actorUserId: actor.userId
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "thread_lifecycle",
          teamId: workspace.teamId,
          teamWorkspaceId: workspace.id,
          threadId: thread.id,
          resourceType: "collaboration_thread",
          resourceId: thread.id,
          actorUserId: actor.userId
        });

        return workspace;
      });
    },

    async listTeamWorkspaces(
      actor: ActorContext,
      input: { teamId: string; includeArchived?: boolean; limit?: number }
    ): Promise<TeamWorkspaceRecord[] | null> {
      return withTeamAccessReadSnapshot(async (tx, client) => {
        const membershipRows = await tx
          .select({ id: teamMemberships.id })
          .from(teamMemberships)
          .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
          .where(
            and(
              eq(teamMemberships.teamId, input.teamId),
              eq(teamMemberships.userId, actor.userId),
              eq(teamMemberships.status, "enabled"),
              isNull(teamMemberships.disabledAt),
              eq(teams.lifecycle, "active")
            )
          )
          .limit(1);
        if (!membershipRows[0]) {
          return null;
        }

        const conditions = [
          eq(teamWorkspaces.teamId, input.teamId),
          eq(teams.lifecycle, "active"),
          inArray(teams.entitlementStatus, ["active", "grace"]),
          eq(teamMemberships.userId, actor.userId),
          eq(teamMemberships.status, "enabled"),
          isNull(teamMemberships.disabledAt),
          isNull(teamWorkspaceAccessGrants.disabledAt),
          inArray(teamWorkspaceAccessGrants.access, ["read", "write"])
        ];
        if (!input.includeArchived) {
          conditions.push(eq(teamWorkspaces.lifecycle, "active"));
        }
        const rows = await tx
          .select({ workspace: teamWorkspaces })
          .from(teamWorkspaces)
          .innerJoin(teams, eq(teams.id, teamWorkspaces.teamId))
          .innerJoin(
            teamMemberships,
            and(
              eq(teamMemberships.teamId, teamWorkspaces.teamId),
              eq(teamMemberships.userId, actor.userId)
            )
          )
          .innerJoin(
            teamWorkspaceAccessGrants,
            and(
              eq(teamWorkspaceAccessGrants.teamWorkspaceId, teamWorkspaces.id),
              eq(teamWorkspaceAccessGrants.teamId, teamWorkspaces.teamId),
              eq(teamWorkspaceAccessGrants.userId, actor.userId)
            )
          )
          .where(and(...conditions))
          .orderBy(desc(teamWorkspaces.createdAt), desc(teamWorkspaces.id))
          .limit(Math.min(Math.max(input.limit ?? 100, 1), 200));

        return Promise.all(
          rows.map((row) =>
            hydrateAuthorizedWorkspaceRecord(
              client,
              options.envelopeEncryptionProvider,
              row.workspace
            )
          )
        );
      });
    },

    async getTeamWorkspaceContext(
      actor: ActorContext,
      teamWorkspaceId: string
    ): Promise<{
      team: TeamRecord;
      teamWorkspace: TeamWorkspaceRecord;
      access: TeamWorkspaceAccessRecord;
    } | null> {
      return withTeamAccessReadSnapshot(async (tx, client) => {
        const rows = await tx
          .select({
            team: teams,
            workspace: teamWorkspaces,
            role: teamMemberships.role,
            membershipStatus: teamMemberships.status,
            membershipDisabledAt: teamMemberships.disabledAt,
            access: teamWorkspaceAccessGrants.access,
            canShareOwnedMemory: teamWorkspaceAccessGrants.canShareOwnedMemory,
            accessVersion: teamWorkspaceAccessGrants.version,
            accessDisabledAt: teamWorkspaceAccessGrants.disabledAt
          })
          .from(teamWorkspaces)
          .innerJoin(teams, eq(teams.id, teamWorkspaces.teamId))
          .innerJoin(
            teamMemberships,
            and(
              eq(teamMemberships.teamId, teamWorkspaces.teamId),
              eq(teamMemberships.userId, actor.userId)
            )
          )
          .innerJoin(
            teamWorkspaceAccessGrants,
            and(
              eq(teamWorkspaceAccessGrants.teamWorkspaceId, teamWorkspaces.id),
              eq(teamWorkspaceAccessGrants.teamId, teamWorkspaces.teamId),
              eq(teamWorkspaceAccessGrants.userId, actor.userId)
            )
          )
          .where(
            and(
              eq(teamWorkspaces.id, teamWorkspaceId),
              eq(teamWorkspaces.lifecycle, "active"),
              eq(teams.lifecycle, "active"),
              inArray(teams.entitlementStatus, ["active", "grace"]),
              eq(teamMemberships.status, "enabled"),
              isNull(teamMemberships.disabledAt),
              inArray(teamWorkspaceAccessGrants.access, ["read", "write"]),
              isNull(teamWorkspaceAccessGrants.disabledAt)
            )
          )
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        const access = buildAccessRecord({
          teamWorkspaceId: row.workspace.id,
          teamId: row.workspace.teamId,
          userId: actor.userId,
          role: row.role,
          membershipStatus: row.membershipStatus,
          membershipDisabledAt: row.membershipDisabledAt,
          teamLifecycle: row.team.lifecycle,
          teamEntitlementStatus: row.team.entitlementStatus,
          workspaceLifecycle: row.workspace.lifecycle,
          access: row.access,
          canShareOwnedMemory: row.canShareOwnedMemory,
          accessVersion: row.accessVersion,
          accessDisabledAt: row.accessDisabledAt
        });
        if (!access.canRecall) return null;
        return {
          team: mapTeamRecord(row.team),
          teamWorkspace: await hydrateAuthorizedWorkspaceRecord(
            client,
            options.envelopeEncryptionProvider,
            row.workspace
          ),
          access
        };
      });
    },

    async archiveTeamWorkspace(
      actor: ActorContext,
      input: { teamWorkspaceId: string; expectedVersion: number }
    ): Promise<TeamWorkspaceRecord | null> {
      return withTeamAccessTransaction(async (tx, client) => {
        const workspaceRows = await tx
          .select({ workspace: teamWorkspaces })
          .from(teamWorkspaces)
          .innerJoin(teams, eq(teams.id, teamWorkspaces.teamId))
          .innerJoin(
            teamMemberships,
            and(
              eq(teamMemberships.teamId, teamWorkspaces.teamId),
              eq(teamMemberships.userId, actor.userId)
            )
          )
          .innerJoin(
            teamWorkspaceAccessGrants,
            and(
              eq(teamWorkspaceAccessGrants.teamWorkspaceId, teamWorkspaces.id),
              eq(teamWorkspaceAccessGrants.teamId, teamWorkspaces.teamId),
              eq(teamWorkspaceAccessGrants.userId, actor.userId)
            )
          )
          .where(
            and(
              eq(teamWorkspaces.id, input.teamWorkspaceId),
              eq(teamWorkspaces.lifecycle, "active"),
              eq(teams.lifecycle, "active"),
              inArray(teams.entitlementStatus, ["active", "grace"]),
              inArray(teamMemberships.role, ["owner", "admin"]),
              eq(teamMemberships.status, "enabled"),
              isNull(teamMemberships.disabledAt),
              eq(teamWorkspaceAccessGrants.access, "write"),
              isNull(teamWorkspaceAccessGrants.disabledAt)
            )
          )
          .limit(1)
          .for("update");
        const existing = workspaceRows[0]?.workspace;
        if (!existing) {
          return null;
        }
        if (existing.version !== input.expectedVersion) {
          staleVersion();
        }

        const archivedRows = await tx
          .update(teamWorkspaces)
          .set({
            lifecycle: "archived",
            archivedAt: sql`now()`,
            version: sql`${teamWorkspaces.version} + 1`,
            updatedAt: sql`now()`
          })
          .where(
            and(
              eq(teamWorkspaces.id, existing.id),
              eq(teamWorkspaces.version, input.expectedVersion),
              eq(teamWorkspaces.lifecycle, "active")
            )
          )
          .returning();
        if (!archivedRows[0]) {
          return null;
        }
        const workspace = await hydrateAuthorizedWorkspaceRecord(
          client,
          options.envelopeEncryptionProvider,
          archivedRows[0]
        );
        const archivedThreads = await tx
          .update(collaborationThreads)
          .set({
            lifecycle: "archived",
            archivedAt: sql`now()`,
            version: sql`${collaborationThreads.version} + 1`,
            updatedAt: sql`now()`
          })
          .where(
            and(
              eq(collaborationThreads.teamWorkspaceId, workspace.id),
              eq(collaborationThreads.systemKey, defaultChannelSystemKey),
              eq(collaborationThreads.lifecycle, "active")
            )
          )
          .returning({ id: collaborationThreads.id });
        const structuralThread = archivedThreads[0];

        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.workspace.archived",
          targetTable: "team_workspaces",
          targetId: workspace.id,
          metadata: {
            teamId: workspace.teamId,
            teamWorkspaceId: workspace.id,
            previousVersion: existing.version,
            version: workspace.version
          }
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "workspace_lifecycle_access",
          teamId: workspace.teamId,
          teamWorkspaceId: workspace.id,
          resourceType: "team_workspace",
          resourceId: workspace.id,
          actorUserId: actor.userId
        });
        if (structuralThread) {
          await appendCollaborationOutboxEvent(tx, {
            family: "thread_lifecycle",
            teamId: workspace.teamId,
            teamWorkspaceId: workspace.id,
            threadId: structuralThread.id,
            resourceType: "collaboration_thread",
            resourceId: structuralThread.id,
            actorUserId: actor.userId
          });
        }

        return workspace;
      });
    },

    async restoreTeamWorkspace(
      actor: ActorContext,
      input: { teamWorkspaceId: string; expectedVersion: number }
    ): Promise<TeamWorkspaceRecord | null> {
      return withTeamAccessTransaction(async (tx, client) => {
        const workspaceRows = await tx
          .select({ workspace: teamWorkspaces })
          .from(teamWorkspaces)
          .innerJoin(teams, eq(teams.id, teamWorkspaces.teamId))
          .innerJoin(
            teamMemberships,
            and(
              eq(teamMemberships.teamId, teamWorkspaces.teamId),
              eq(teamMemberships.userId, actor.userId)
            )
          )
          .innerJoin(
            teamWorkspaceAccessGrants,
            and(
              eq(teamWorkspaceAccessGrants.teamWorkspaceId, teamWorkspaces.id),
              eq(teamWorkspaceAccessGrants.teamId, teamWorkspaces.teamId),
              eq(teamWorkspaceAccessGrants.userId, actor.userId)
            )
          )
          .where(
            and(
              eq(teamWorkspaces.id, input.teamWorkspaceId),
              eq(teamWorkspaces.lifecycle, "archived"),
              eq(teams.lifecycle, "active"),
              inArray(teams.entitlementStatus, ["active", "grace"]),
              inArray(teamMemberships.role, ["owner", "admin"]),
              eq(teamMemberships.status, "enabled"),
              isNull(teamMemberships.disabledAt),
              eq(teamWorkspaceAccessGrants.access, "write"),
              isNull(teamWorkspaceAccessGrants.disabledAt)
            )
          )
          .limit(1)
          .for("update");
        const existing = workspaceRows[0]?.workspace;
        if (!existing) {
          return null;
        }
        if (existing.version !== input.expectedVersion) {
          staleVersion();
        }

        const restoredRows = await tx
          .update(teamWorkspaces)
          .set({
            lifecycle: "active",
            archivedAt: null,
            version: sql`${teamWorkspaces.version} + 1`,
            updatedAt: sql`now()`
          })
          .where(
            and(
              eq(teamWorkspaces.id, existing.id),
              eq(teamWorkspaces.version, input.expectedVersion),
              eq(teamWorkspaces.lifecycle, "archived")
            )
          )
          .returning();
        if (!restoredRows[0]) {
          return null;
        }
        const workspace = await hydrateAuthorizedWorkspaceRecord(
          client,
          options.envelopeEncryptionProvider,
          restoredRows[0]
        );
        const restoredThreads = await tx
          .update(collaborationThreads)
          .set({
            lifecycle: "active",
            archivedAt: null,
            version: sql`${collaborationThreads.version} + 1`,
            updatedAt: sql`now()`
          })
          .where(
            and(
              eq(collaborationThreads.teamWorkspaceId, workspace.id),
              eq(collaborationThreads.systemKey, defaultChannelSystemKey),
              eq(collaborationThreads.lifecycle, "archived")
            )
          )
          .returning({ id: collaborationThreads.id });
        let structuralThread = restoredThreads[0];
        if (!structuralThread) {
          const existingStructural = await tx
            .select({ id: collaborationThreads.id })
            .from(collaborationThreads)
            .where(
              and(
                eq(collaborationThreads.teamWorkspaceId, workspace.id),
                eq(collaborationThreads.systemKey, defaultChannelSystemKey),
                eq(collaborationThreads.lifecycle, "active")
              )
            )
            .limit(1)
            .for("update");
          structuralThread = existingStructural[0];
        }
        if (!structuralThread) {
          const inserted = await tx
            .insert(collaborationThreads)
            .values({
              scope: "team",
              kind: "workspace_channel",
              teamId: workspace.teamId,
              teamWorkspaceId: workspace.id,
              systemKey: defaultChannelSystemKey,
              createdByUserId: actor.userId
            })
            .returning({ id: collaborationThreads.id });
          structuralThread = inserted[0]!;
        }

        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.workspace.restored",
          targetTable: "team_workspaces",
          targetId: workspace.id,
          metadata: {
            teamId: workspace.teamId,
            teamWorkspaceId: workspace.id,
            previousVersion: existing.version,
            version: workspace.version
          }
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "workspace_lifecycle_access",
          teamId: workspace.teamId,
          teamWorkspaceId: workspace.id,
          resourceType: "team_workspace",
          resourceId: workspace.id,
          actorUserId: actor.userId
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "thread_lifecycle",
          teamId: workspace.teamId,
          teamWorkspaceId: workspace.id,
          threadId: structuralThread.id,
          resourceType: "collaboration_thread",
          resourceId: structuralThread.id,
          actorUserId: actor.userId
        });

        return workspace;
      });
    },

    async createTeamInvite(
      actor: ActorContext,
      input: {
        teamId: string;
        defaultTeamWorkspaceId: string;
        defaultWorkspaceAccess: "read" | "write";
        email: string;
        role: TeamRole;
        backendOriginHash: string;
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
      if (!/^[a-f0-9]{64}$/i.test(input.backendOriginHash)) {
        throw new Error("backendOriginHash must be a 64-character hex digest");
      }

      const email = normalizeEmail(input.email);
      if (!email) {
        throw new Error("email must not be empty");
      }

      return db.transaction(async (tx) => {
        const lockedManager = await getManagingMembershipForUpdate(
          tx,
          actor,
          input.teamId
        );
        if (
          !membershipManages(lockedManager) ||
          (input.role === "owner" && lockedManager!.role !== "owner")
        ) {
          return null;
        }
        const defaultWorkspace = await getDefaultTeamWorkspaceForUpdate(
          tx,
          input.teamId
        );
        if (
          !defaultWorkspace ||
          defaultWorkspace.id !== input.defaultTeamWorkspaceId ||
          defaultWorkspace.lifecycle !== "active"
        ) {
          return null;
        }

        const inviteRows = await tx
          .insert(teamInvites)
          .values({
            teamId: input.teamId,
            defaultTeamWorkspaceId: input.defaultTeamWorkspaceId,
            defaultWorkspaceAccess: input.defaultWorkspaceAccess,
            email,
            normalizedEmail: email,
            backendOriginHash: input.backendOriginHash,
            role: input.role,
            lifecycle: "pending",
            tokenHash: input.tokenHash,
            createdByUserId: actor.userId,
            expiresAt: input.expiresAt
          })
          .returning();
        const invite = mapInviteRecord(inviteRows[0]!);

        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.invite.created",
          targetTable: "team_invites",
          targetId: invite.id,
          metadata: {
            teamId: input.teamId,
            teamWorkspaceId: input.defaultTeamWorkspaceId,
            workspaceAccess: input.defaultWorkspaceAccess,
            role: input.role,
            version: invite.version,
            backendOriginHash: invite.backendOriginHash
          }
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "team_membership_access",
          teamId: input.teamId,
          teamWorkspaceId: input.defaultTeamWorkspaceId,
          resourceType: "team_invite",
          resourceId: invite.id,
          actorUserId: actor.userId
        });

        return invite;
      });
    },

    async listTeamInvites(
      actor: ActorContext,
      input: {
        teamId: string;
        includeRevoked?: boolean;
        limit?: number;
        cursor?: { createdAt: string; id: string };
      }
    ): Promise<{
      invites: TeamInviteRecord[];
      nextCursor: { createdAt: string; id: string } | null;
    } | null> {
      const manager = await getManagingMembership(actor, input.teamId);
      if (!membershipManages(manager)) {
        return null;
      }
      const conditions = [eq(teamInvites.teamId, input.teamId)];
      if (!input.includeRevoked) {
        conditions.push(
          inArray(teamInvites.lifecycle, ["pending", "accepted", "expired"])
        );
      }
      if (input.cursor) {
        const cursorCreatedAt = new Date(input.cursor.createdAt);
        conditions.push(
          or(
            lt(teamInvites.createdAt, cursorCreatedAt),
            and(
              eq(teamInvites.createdAt, cursorCreatedAt),
              lt(teamInvites.id, input.cursor.id)
            )
          )!
        );
      }
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
      const rows = await db
        .select()
        .from(teamInvites)
        .where(and(...conditions))
        .orderBy(desc(teamInvites.createdAt), desc(teamInvites.id))
        .limit(limit + 1);

      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      return {
        invites: pageRows.map(mapInviteRecord),
        nextCursor:
          rows.length > limit && last
            ? { createdAt: timestampIso(last.createdAt), id: last.id }
            : null
      };
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
            eq(teamInvites.lifecycle, "pending"),
            gt(teamInvites.expiresAt, sql`now()`)
          )
        )
        .limit(1);

      return rows[0] ? mapInviteRecord(rows[0]) : null;
    },

    async acceptTeamInvite(input: {
      tokenHash: string;
      userId: string;
      expectedVersion: number;
      expectedBackendOriginHash: string;
    }): Promise<AcceptedTeamInviteRecord | null> {
      try {
        return await db.transaction(async (tx) => {
          const inviteRows = await tx
            .select()
            .from(teamInvites)
            .where(
              and(
                eq(teamInvites.tokenHash, input.tokenHash),
                eq(teamInvites.lifecycle, "pending"),
                eq(teamInvites.version, input.expectedVersion),
                eq(
                  teamInvites.backendOriginHash,
                  input.expectedBackendOriginHash
                ),
                gt(teamInvites.expiresAt, sql`now()`)
              )
            )
            .limit(1)
            .for("update");
          const inviteRow = inviteRows[0];
          if (!inviteRow) {
            return null;
          }
          await lockTeamOwnerLifecycle(tx, inviteRow.teamId);
          const teamRows = await tx
            .select({ entitlementStatus: teams.entitlementStatus })
            .from(teams)
            .where(
              and(eq(teams.id, inviteRow.teamId), eq(teams.lifecycle, "active"))
            )
            .limit(1)
            .for("update");
          const team = teamRows[0];
          if (
            !team ||
            !teamEntitlementAllowsAccess(team.entitlementStatus) ||
            !inviteRow.defaultTeamWorkspaceId ||
            !inviteRow.normalizedEmail ||
            !inviteRow.backendOriginHash
          ) {
            return null;
          }

          const defaultWorkspace = await getDefaultTeamWorkspaceForUpdate(
            tx,
            inviteRow.teamId
          );
          if (
            !defaultWorkspace ||
            defaultWorkspace.id !== inviteRow.defaultTeamWorkspaceId ||
            defaultWorkspace.lifecycle !== "active"
          ) {
            return null;
          }

          const userRows = await tx
            .select()
            .from(users)
            .where(eq(users.id, input.userId))
            .limit(1);
          const user = userRows[0];
          if (
            !user ||
            user.disabledAt !== null ||
            user.deletedAt !== null ||
            normalizeEmail(user.email) !== inviteRow.normalizedEmail
          ) {
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

          const membershipRows = existingMembership
            ? await tx
                .update(teamMemberships)
                .set({
                  role: acceptedRole,
                  status: "enabled",
                  acceptedAt: sql`coalesce(${teamMemberships.acceptedAt}, now())`,
                  disabledAt: null,
                  disabledReason: null,
                  version: sql`${teamMemberships.version} + 1`,
                  updatedAt: sql`now()`
                })
                .where(
                  and(
                    eq(teamMemberships.id, existingMembership.id),
                    eq(teamMemberships.version, existingMembership.version)
                  )
                )
                .returning()
            : await tx
                .insert(teamMemberships)
                .values({
                  teamId: inviteRow.teamId,
                  userId: user.id,
                  role: acceptedRole,
                  status: "enabled",
                  version: 1,
                  acceptedAt: sql`now()`,
                  disabledAt: null
                })
                .onConflictDoNothing()
                .returning();
          if (!membershipRows[0]) {
            return null;
          }

          const existingAccessRows = await tx
            .select()
            .from(teamWorkspaceAccessGrants)
            .where(
              and(
                eq(
                  teamWorkspaceAccessGrants.teamWorkspaceId,
                  inviteRow.defaultTeamWorkspaceId
                ),
                eq(teamWorkspaceAccessGrants.teamId, inviteRow.teamId),
                eq(teamWorkspaceAccessGrants.userId, user.id)
              )
            )
            .limit(1)
            .for("update");
          const existingAccess = existingAccessRows[0];
          const accessRows = existingAccess
            ? await tx
                .update(teamWorkspaceAccessGrants)
                .set({
                  access: inviteRow.defaultWorkspaceAccess,
                  canShareOwnedMemory:
                    inviteRow.defaultWorkspaceAccess === "write",
                  grantedByUserId: inviteRow.createdByUserId,
                  disabledAt: null,
                  disabledReason: null,
                  version: sql`${teamWorkspaceAccessGrants.version} + 1`,
                  updatedAt: sql`now()`
                })
                .where(
                  and(
                    eq(
                      teamWorkspaceAccessGrants.teamWorkspaceId,
                      existingAccess.teamWorkspaceId
                    ),
                    eq(teamWorkspaceAccessGrants.userId, existingAccess.userId),
                    eq(
                      teamWorkspaceAccessGrants.version,
                      existingAccess.version
                    )
                  )
                )
                .returning()
            : await tx
                .insert(teamWorkspaceAccessGrants)
                .values({
                  teamWorkspaceId: inviteRow.defaultTeamWorkspaceId,
                  teamId: inviteRow.teamId,
                  userId: user.id,
                  access: inviteRow.defaultWorkspaceAccess,
                  canShareOwnedMemory:
                    inviteRow.defaultWorkspaceAccess === "write",
                  version: 1,
                  grantedByUserId: inviteRow.createdByUserId
                })
                .onConflictDoNothing()
                .returning();
          const accessGrant = accessRows[0];
          if (!accessGrant) {
            throw inviteAcceptanceConflict;
          }

          const acceptedRows = await tx
            .update(teamInvites)
            .set({
              lifecycle: "accepted",
              acceptedAt: sql`now()`,
              acceptedByUserId: user.id,
              version: sql`${teamInvites.version} + 1`
            })
            .where(
              and(
                eq(teamInvites.id, inviteRow.id),
                eq(teamInvites.lifecycle, "pending"),
                eq(teamInvites.version, input.expectedVersion),
                eq(
                  teamInvites.backendOriginHash,
                  input.expectedBackendOriginHash
                )
              )
            )
            .returning();
          const acceptedRow = acceptedRows[0];
          if (!acceptedRow) {
            throw inviteAcceptanceConflict;
          }
          const invite = mapInviteRecord(acceptedRow);
          const membership = mapMembershipRecord(membershipRows[0]!);

          await insertTeamAudit(tx, {
            actorUserId: user.id,
            action: "team.invite.accepted",
            targetTable: "team_invites",
            targetId: invite.id,
            metadata: {
              teamId: invite.teamId,
              teamWorkspaceId: invite.defaultTeamWorkspaceId,
              role: invite.role,
              userId: user.id,
              workspaceAccess: inviteRow.defaultWorkspaceAccess,
              previousVersion: inviteRow.version,
              version: invite.version,
              backendOriginHash: invite.backendOriginHash
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
              previousVersion: existingMembership?.version ?? null,
              version: membership.version,
              source: "invite_acceptance"
            }
          });
          await insertTeamAudit(tx, {
            actorUserId: user.id,
            action: existingAccess
              ? "team.workspace_access.updated"
              : "team.workspace_access.created",
            targetTable: "team_workspace_access_grants",
            targetId: accessGrant.teamWorkspaceId,
            metadata: {
              teamId: invite.teamId,
              teamWorkspaceId: accessGrant.teamWorkspaceId,
              userId: user.id,
              previousAccess: existingAccess?.access ?? "disabled",
              access: accessGrant.access,
              previousVersion: existingAccess?.version ?? null,
              version: accessGrant.version,
              source: "invite_acceptance"
            }
          });
          await appendCollaborationOutboxEvent(tx, {
            family: "team_membership_access",
            teamId: invite.teamId,
            teamWorkspaceId: invite.defaultTeamWorkspaceId,
            resourceType: "team_membership",
            resourceId: membership.id,
            actorUserId: user.id
          });
          await appendCollaborationOutboxEvent(tx, {
            family: "workspace_lifecycle_access",
            teamId: invite.teamId,
            teamWorkspaceId: invite.defaultTeamWorkspaceId,
            resourceType: "team_workspace_access",
            resourceId: accessGrant.teamWorkspaceId,
            actorUserId: user.id
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
            createdUser: false
          };
        });
      } catch (error) {
        if (error === inviteAcceptanceConflict) {
          return null;
        }
        throw error;
      }
    },

    async revokeTeamInvite(
      actor: ActorContext,
      input: { teamId: string; inviteId: string; expectedVersion: number }
    ): Promise<TeamInviteRecord | null> {
      return db.transaction(async (tx) => {
        const inviteRows = await tx
          .select()
          .from(teamInvites)
          .where(
            and(
              eq(teamInvites.id, input.inviteId),
              eq(teamInvites.teamId, input.teamId),
              eq(teamInvites.lifecycle, "pending")
            )
          )
          .limit(1)
          .for("update");
        const existing = inviteRows[0];
        if (!existing) {
          return null;
        }

        const managerRows = await tx
          .select({ role: teamMemberships.role })
          .from(teamMemberships)
          .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
          .where(
            and(
              eq(teamMemberships.teamId, existing.teamId),
              eq(teamMemberships.userId, actor.userId),
              inArray(teamMemberships.role, ["owner", "admin"]),
              eq(teamMemberships.status, "enabled"),
              isNull(teamMemberships.disabledAt),
              eq(teams.lifecycle, "active")
            )
          )
          .limit(1);
        const manager = managerRows[0];
        if (
          !manager ||
          (existing.role === "owner" && manager.role !== "owner")
        ) {
          return null;
        }
        if (existing.version !== input.expectedVersion) {
          staleVersion();
        }

        const revokedRows = await tx
          .update(teamInvites)
          .set({
            lifecycle: "revoked",
            revokedAt: sql`now()`,
            version: sql`${teamInvites.version} + 1`
          })
          .where(
            and(
              eq(teamInvites.id, existing.id),
              eq(teamInvites.lifecycle, "pending"),
              eq(teamInvites.version, input.expectedVersion)
            )
          )
          .returning();
        if (!revokedRows[0]) {
          return null;
        }
        const invite = mapInviteRecord(revokedRows[0]);

        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.invite.revoked",
          targetTable: "team_invites",
          targetId: invite.id,
          metadata: {
            teamId: invite.teamId,
            teamWorkspaceId: invite.defaultTeamWorkspaceId,
            previousVersion: existing.version,
            version: invite.version
          }
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "access_revoked",
          teamId: invite.teamId,
          teamWorkspaceId: invite.defaultTeamWorkspaceId,
          resourceType: "team_invite",
          resourceId: invite.id,
          actorUserId: actor.userId
        });

        return invite;
      });
    },

    async disableTeamMember(
      actor: ActorContext,
      input: { teamId: string; userId: string; expectedVersion: number }
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
        await lockTeamOwnerLifecycle(tx, input.teamId);
        const lockedManager = await getManagingMembershipForUpdate(
          tx,
          actor,
          input.teamId
        );
        if (!membershipManages(lockedManager)) {
          return null;
        }
        const targetMembershipRows = await tx
          .select()
          .from(teamMemberships)
          .where(
            and(
              eq(teamMemberships.teamId, input.teamId),
              eq(teamMemberships.userId, input.userId)
            )
          )
          .limit(1)
          .for("update");
        const targetMembership = targetMembershipRows[0];
        if (!targetMembership) {
          return null;
        }
        if (targetMembership.version !== input.expectedVersion) {
          staleVersion();
        }
        if (
          targetMembership.role === "owner" &&
          lockedManager!.role !== "owner"
        ) {
          return null;
        }
        if (
          targetMembership.role === "owner" &&
          targetMembership.status === "enabled" &&
          targetMembership.disabledAt === null
        ) {
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
          .update(teamMemberships)
          .set({
            status: "disabled",
            disabledAt: sql`now()`,
            disabledReason: "disabled_by_team_manager",
            version: sql`${teamMemberships.version} + 1`,
            updatedAt: sql`now()`
          })
          .where(
            and(
              eq(teamMemberships.teamId, input.teamId),
              eq(teamMemberships.userId, input.userId),
              eq(teamMemberships.version, input.expectedVersion)
            )
          )
          .returning();
        if (!rows[0]) {
          return null;
        }

        const membership = mapMembershipRecord(rows[0]);
        await disableWorkspaceAccessGrantsForMembership(tx, {
          teamId: input.teamId,
          userId: input.userId,
          actorUserId: actor.userId,
          reason: "membership_disabled"
        });
        await insertTeamAudit(tx, {
          actorUserId: actor.userId,
          action: "team.member.disabled",
          targetTable: "team_memberships",
          targetId: membership.id,
          metadata: {
            teamId: input.teamId,
            userId: input.userId,
            role: membership.role,
            status: membership.status,
            previousVersion: targetMembership.version,
            version: membership.version
          }
        });
        await reconcileTeamBillingSeats(tx, {
          teamId: input.teamId,
          actorUserId: actor.userId,
          reason: "team.member.disabled"
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "access_revoked",
          teamId: input.teamId,
          resourceType: "team_membership",
          resourceId: membership.id,
          actorUserId: actor.userId
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
        canShareOwnedMemory?: boolean;
        expectedVersion: number | null;
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

      const updated = await db.transaction(async (tx) => {
        const lockedManager = await getManagingMembershipForUpdate(
          tx,
          actor,
          accessContext.teamId
        );
        if (!membershipManages(lockedManager)) {
          return false;
        }
        const managerGrantRows = await tx
          .select({
            access: teamWorkspaceAccessGrants.access,
            disabledAt: teamWorkspaceAccessGrants.disabledAt,
            workspaceLifecycle: teamWorkspaces.lifecycle
          })
          .from(teamWorkspaceAccessGrants)
          .innerJoin(
            teamWorkspaces,
            and(
              eq(teamWorkspaces.id, teamWorkspaceAccessGrants.teamWorkspaceId),
              eq(teamWorkspaces.teamId, teamWorkspaceAccessGrants.teamId)
            )
          )
          .where(
            and(
              eq(
                teamWorkspaceAccessGrants.teamWorkspaceId,
                input.teamWorkspaceId
              ),
              eq(teamWorkspaceAccessGrants.teamId, accessContext.teamId),
              eq(teamWorkspaceAccessGrants.userId, actor.userId)
            )
          )
          .limit(1)
          .for("update");
        const managerGrant = managerGrantRows[0];
        if (
          !managerGrant ||
          managerGrant.access !== "write" ||
          managerGrant.disabledAt !== null ||
          managerGrant.workspaceLifecycle !== "active"
        ) {
          return false;
        }

        const targetMembershipRows = await tx
          .select({ id: teamMemberships.id })
          .from(teamMemberships)
          .where(
            and(
              eq(teamMemberships.teamId, accessContext.teamId),
              eq(teamMemberships.userId, input.userId),
              eq(teamMemberships.status, "enabled"),
              isNull(teamMemberships.disabledAt)
            )
          )
          .limit(1)
          .for("update");
        if (!targetMembershipRows[0]) {
          return false;
        }

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
          .limit(1)
          .for("update");
        const existingGrant = existingGrants[0];
        if (
          (existingGrant && input.expectedVersion === null) ||
          (!existingGrant && input.expectedVersion !== null)
        ) {
          staleVersion();
        }
        if (existingGrant && existingGrant.version !== input.expectedVersion) {
          staleVersion();
        }
        const previousAccess = existingGrant?.access ?? "disabled";
        const canShareOwnedMemory =
          input.access === "write"
            ? (input.canShareOwnedMemory ??
              (existingGrant?.access === "write"
                ? existingGrant.canShareOwnedMemory
                : undefined) ??
              true)
            : false;

        const grantRows = existingGrant
          ? await tx
              .update(teamWorkspaceAccessGrants)
              .set({
                access: input.access,
                canShareOwnedMemory,
                grantedByUserId: actor.userId,
                disabledAt: input.access === "disabled" ? sql`now()` : null,
                disabledReason:
                  input.access === "disabled"
                    ? "workspace_access_removed"
                    : null,
                version: sql`${teamWorkspaceAccessGrants.version} + 1`,
                updatedAt: sql`now()`
              })
              .where(
                and(
                  eq(
                    teamWorkspaceAccessGrants.teamWorkspaceId,
                    input.teamWorkspaceId
                  ),
                  eq(teamWorkspaceAccessGrants.userId, input.userId),
                  eq(teamWorkspaceAccessGrants.version, input.expectedVersion!)
                )
              )
              .returning()
          : await tx
              .insert(teamWorkspaceAccessGrants)
              .values({
                teamWorkspaceId: input.teamWorkspaceId,
                userId: input.userId,
                teamId: accessContext.teamId,
                access: input.access,
                canShareOwnedMemory,
                version: 1,
                grantedByUserId: actor.userId,
                disabledAt: input.access === "disabled" ? sql`now()` : null,
                disabledReason:
                  input.access === "disabled"
                    ? "workspace_access_removed"
                    : null
              })
              .onConflictDoNothing()
              .returning();
        const grant = grantRows[0];
        if (!grant) {
          return false;
        }

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
            canShareOwnedMemory,
            previousAccess,
            previousVersion: existingGrant?.version ?? null,
            version: grant.version
          }
        });
        await appendCollaborationOutboxEvent(tx, {
          family: "workspace_lifecycle_access",
          teamId: accessContext.teamId,
          teamWorkspaceId: input.teamWorkspaceId,
          resourceType: "team_workspace_access",
          resourceId: input.teamWorkspaceId,
          actorUserId: actor.userId
        });
        return true;
      });

      if (!updated) {
        return null;
      }

      return getTeamWorkspaceAccess(
        { userId: input.userId },
        input.teamWorkspaceId
      );
    },

    async listTeamWorkspaceContexts(
      actor: ActorContext
    ): Promise<TeamWorkspaceContextRecord[]> {
      const rows = await db
        .select({
          teamId: teams.id,
          teamName: teams.name,
          teamRole: teamMemberships.role,
          teamWorkspaceId: teamWorkspaces.id,
          teamWorkspaceName: teamWorkspaces.name,
          access: teamWorkspaceAccessGrants.access
        })
        .from(teamWorkspaceAccessGrants)
        .innerJoin(
          teamMemberships,
          and(
            eq(teamMemberships.teamId, teamWorkspaceAccessGrants.teamId),
            eq(teamMemberships.userId, teamWorkspaceAccessGrants.userId)
          )
        )
        .innerJoin(teams, eq(teams.id, teamWorkspaceAccessGrants.teamId))
        .innerJoin(
          teamWorkspaces,
          and(
            eq(teamWorkspaces.id, teamWorkspaceAccessGrants.teamWorkspaceId),
            eq(teamWorkspaces.teamId, teamWorkspaceAccessGrants.teamId)
          )
        )
        .where(
          and(
            eq(teamWorkspaceAccessGrants.userId, actor.userId),
            inArray(teamWorkspaceAccessGrants.access, ["read", "write"]),
            isNull(teamWorkspaceAccessGrants.disabledAt),
            eq(teamMemberships.status, "enabled"),
            isNull(teamMemberships.disabledAt),
            inArray(teams.entitlementStatus, ["active", "grace"]),
            eq(teams.lifecycle, "active"),
            eq(teamWorkspaces.lifecycle, "active")
          )
        )
        .orderBy(teams.name, teamWorkspaces.name, teamWorkspaces.id);

      return rows.map((row) => ({
        ...row,
        access: row.access as "read" | "write"
      }));
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

export type TeamAccessRepository = ReturnType<
  typeof createTeamAccessRepository
>;
