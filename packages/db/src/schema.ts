import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn
} from "drizzle-orm/pg-core";
import type { EncryptedPayloadEnvelope } from "@koed/shared";

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);

const now = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedNow = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const visibilityScope = pgEnum("visibility_scope", ["personal"]);
export const sourceRuntime = pgEnum("source_runtime", ["codex", "codex-cli"]);
export const captureMethod = pgEnum("capture_method", [
  "hook",
  "mcp",
  "web",
  "api"
]);
export const memoryEventType = pgEnum("memory_event_type", [
  "captured",
  "invalidated",
  "summarized",
  "embedded"
]);
export const capturePolicyTarget = pgEnum("capture_policy_target", [
  "global",
  "project",
  "thread"
]);
export const captureState = pgEnum("capture_state", [
  "enabled",
  "disabled",
  "ask"
]);
export const memoryQuestionStatus = pgEnum("memory_question_status", [
  "pending",
  "answered",
  "error"
]);
export const memorySearchDomain = pgEnum("memory_search_domain", [
  "global",
  "project",
  "session"
]);
export const teamRole = pgEnum("team_role", ["owner", "admin", "member"]);
export const teamMembershipStatus = pgEnum("team_membership_status", [
  "invited",
  "enabled",
  "disabled"
]);
export const teamWorkspaceAccess = pgEnum("team_workspace_access", [
  "disabled",
  "read",
  "write"
]);
export const teamEntitlementStatus = pgEnum("team_entitlement_status", [
  "active",
  "grace",
  "suspended",
  "revoked"
]);
export const teamBillingSeatSyncStatus = pgEnum(
  "team_billing_seat_sync_status",
  ["synced", "pending_provider_update", "over_limit", "error"]
);
export const deviceCredentialVerifierKind = pgEnum(
  "device_credential_verifier_kind",
  ["secret_hash", "public_key_jwk"]
);
export const externalAuthProvider = pgEnum("external_auth_provider", [
  "workos_authkit"
]);
export const externalAuthLinkStatus = pgEnum("external_auth_link_status", [
  "linked",
  "disabled"
]);
export const deploymentProfile = pgEnum("deployment_profile", [
  "developer",
  "local_personal",
  "private_vps",
  "team_self_hosted",
  "koed_managed_cloud"
]);
export const syncSourceBoundary = pgEnum("sync_source_boundary", [
  "captured_session"
]);
export const syncReplicaRole = pgEnum("sync_replica_role", [
  "source",
  "target"
]);
export const syncDeploymentLocality = pgEnum("sync_deployment_locality", [
  "local",
  "remote"
]);
export const syncRelationshipSide = pgEnum("sync_relationship_side", [
  "source",
  "target"
]);
export const syncMode = pgEnum("sync_mode", ["live", "offload"]);
export const syncRelationshipState = pgEnum("sync_relationship_state", [
  "created",
  "uploading",
  "uploaded",
  "verified",
  "processing",
  "partially_available",
  "ready",
  "stale",
  "paused",
  "failed",
  "revoked",
  "purge_pending"
]);
export const syncPackageState = pgEnum("sync_package_state", [
  "created",
  "uploading",
  "uploaded",
  "verified",
  "processing",
  "completed",
  "failed"
]);
export const syncQueueEntryState = pgEnum("sync_queue_entry_state", [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled"
]);
export const syncChangeOperation = pgEnum("sync_change_operation", [
  "upsert",
  "delete"
]);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  passwordHash: text("password_hash"),
  createdAt: now(),
  updatedAt: updatedNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  disabledReason: text("disabled_reason"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletionReason: text("deletion_reason")
});

export const externalAuthIdentities = pgTable(
  "external_auth_identities",
  {
    id: id(),
    provider: externalAuthProvider("provider").notNull(),
    providerEnvironment: text("provider_environment")
      .notNull()
      .default("default"),
    providerUserId: text("provider_user_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    displayName: text("display_name"),
    status: externalAuthLinkStatus("status").notNull().default("linked"),
    profile: jsonb("profile")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: now(),
    updatedAt: updatedNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
  },
  (table) => [
    unique("external_auth_identities_provider_user_unique").on(
      table.provider,
      table.providerEnvironment,
      table.providerUserId
    ),
    index("external_auth_identities_user_idx").on(table.userId, table.status),
    check(
      "external_auth_identities_provider_user_id_not_empty_check",
      sql`length(trim(${table.providerUserId})) > 0`
    )
  ]
);

export const teams = pgTable(
  "teams",
  {
    id: id(),
    name: text("name").notNull(),
    entitlementStatus: teamEntitlementStatus("entitlement_status")
      .notNull()
      .default("active"),
    entitlementReason: text("entitlement_reason"),
    entitlementUpdatedAt: timestamp("entitlement_updated_at", {
      withTimezone: true
    }),
    createdAt: now(),
    updatedAt: updatedNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
  },
  (table) => [
    index("teams_active_idx")
      .on(table.createdAt.desc())
      .where(sql`${table.archivedAt} is null`)
  ]
);

export const externalAuthOrganizations = pgTable(
  "external_auth_organizations",
  {
    id: id(),
    provider: externalAuthProvider("provider").notNull(),
    providerEnvironment: text("provider_environment")
      .notNull()
      .default("default"),
    providerOrganizationId: text("provider_organization_id").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name"),
    status: externalAuthLinkStatus("status").notNull().default("linked"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: now(),
    updatedAt: updatedNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
  },
  (table) => [
    unique("external_auth_organizations_provider_org_unique").on(
      table.provider,
      table.providerEnvironment,
      table.providerOrganizationId
    ),
    index("external_auth_organizations_team_idx").on(
      table.teamId,
      table.status
    ),
    check(
      "external_auth_organizations_provider_org_id_not_empty_check",
      sql`length(trim(${table.providerOrganizationId})) > 0`
    )
  ]
);

export const teamMemberships = pgTable(
  "team_memberships",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: teamRole("role").notNull(),
    status: teamMembershipStatus("status").notNull().default("enabled"),
    createdAt: now(),
    updatedAt: updatedNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason")
  },
  (table) => [
    unique("team_memberships_team_user_unique").on(table.teamId, table.userId),
    index("team_memberships_user_idx").on(table.userId, table.status),
    index("team_memberships_team_idx").on(table.teamId, table.role)
  ]
);

export const teamBillingSeatStates = pgTable(
  "team_billing_seat_states",
  {
    teamId: uuid("team_id")
      .primaryKey()
      .references(() => teams.id, { onDelete: "cascade" }),
    seatLimit: integer("seat_limit"),
    billableSeatCount: integer("billable_seat_count").notNull().default(0),
    pendingBillingSeatCount: integer("pending_billing_seat_count")
      .notNull()
      .default(0),
    syncStatus: teamBillingSeatSyncStatus("sync_status")
      .notNull()
      .default("synced"),
    overLimitAt: timestamp("over_limit_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastErrorMessage: text("last_error_message"),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    index("team_billing_seat_states_status_idx").on(
      table.syncStatus,
      table.updatedAt.desc()
    ),
    check(
      "team_billing_seat_states_counts_check",
      sql`${table.billableSeatCount} >= 0
        and ${table.pendingBillingSeatCount} >= 0
        and (${table.seatLimit} is null or ${table.seatLimit} >= 0)`
    )
  ]
);

export const teamWorkspaces = pgTable(
  "team_workspaces",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: now(),
    updatedAt: updatedNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
  },
  (table) => [
    unique("team_workspaces_id_team_unique").on(table.id, table.teamId),
    index("team_workspaces_team_idx")
      .on(table.teamId, table.createdAt.desc())
      .where(sql`${table.archivedAt} is null`)
  ]
);

export const teamWorkspaceAccessGrants = pgTable(
  "team_workspace_access_grants",
  {
    teamWorkspaceId: uuid("team_workspace_id")
      .notNull()
      .references(() => teamWorkspaces.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    access: teamWorkspaceAccess("access").notNull().default("disabled"),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    primaryKey({ columns: [table.teamWorkspaceId, table.userId] }),
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "team_workspace_access_grants_workspace_team_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId, table.userId],
      foreignColumns: [teamMemberships.teamId, teamMemberships.userId],
      name: "team_workspace_access_grants_membership_fk"
    }).onDelete("cascade"),
    index("team_workspace_access_grants_user_idx").on(
      table.userId,
      table.access
    )
  ]
);

export const teamInvites = pgTable(
  "team_invites",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: teamRole("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: now(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    index("team_invites_team_email_idx").on(table.teamId, table.email),
    index("team_invites_active_token_idx")
      .on(table.tokenHash)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    check(
      "team_invites_token_hash_length_check",
      sql`length(${table.tokenHash}) >= 32`
    )
  ]
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    visibility: visibilityScope("visibility").notNull(),
    name: text("name").notNull(),
    rootPath: text("root_path"),
    sourceRuntime: sourceRuntime("source_runtime"),
    createdAt: now(),
    updatedAt: updatedNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
  },
  (table) => [
    check(
      "workspaces_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    )
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null"
    }),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    externalSessionId: text("external_session_id"),
    sourceRuntime: sourceRuntime("source_runtime").notNull(),
    captureMethod: captureMethod("capture_method").notNull(),
    codexTranscriptPath: text("codex_transcript_path"),
    idempotencyKey: text("idempotency_key"),
    sourceHash: text("source_hash"),
    model: text("model"),
    cwd: text("cwd"),
    capturedProjectProvenance: jsonb("captured_project_provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    automaticProjectId: text("automatic_project_id"),
    automaticProjectName: text("automatic_project_name"),
    automaticProjectPath: text("automatic_project_path"),
    automaticProjectDetectedAt: timestamp("automatic_project_detected_at", {
      withTimezone: true
    }),
    projectOverrideId: text("project_override_id"),
    projectOverrideName: text("project_override_name"),
    projectOverridePath: text("project_override_path"),
    projectOverrideAt: timestamp("project_override_at", {
      withTimezone: true
    }),
    projectOverrideByUserId: uuid("project_override_by_user_id").references(
      () => users.id
    ),
    sourceKind: text("source_kind"),
    sourceAdapterVersion: text("source_adapter_version"),
    externalThreadId: text("external_thread_id"),
    forkedFromExternalThreadId: text("forked_from_external_thread_id"),
    parentSessionId: uuid("parent_session_id").references(
      (): AnyPgColumn => sessions.id,
      { onDelete: "set null" }
    ),
    parentExternalThreadId: text("parent_external_thread_id"),
    agentNickname: text("agent_nickname"),
    agentRole: text("agent_role"),
    agentPath: text("agent_path"),
    threadSource: text("thread_source"),
    sourceMetadata: jsonb("source_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: now(),
    updatedAt: updatedNow(),
    personalDeletedAt: timestamp("personal_deleted_at", {
      withTimezone: true
    }),
    personalDeletedByUserId: uuid("personal_deleted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    personalDeletionReason: text("personal_deletion_reason"),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason")
  },
  (table) => [
    uniqueIndex("sessions_idempotency_key_unique")
      .on(table.ownerUserId, table.visibility, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    uniqueIndex("sessions_source_hash_unique")
      .on(table.ownerUserId, table.visibility, table.sourceHash)
      .where(sql`${table.sourceHash} is not null`),
    check(
      "sessions_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    ),
    check(
      "sessions_automatic_project_shape_check",
      sql`(${table.automaticProjectId} is null and ${table.automaticProjectName} is null and ${table.automaticProjectPath} is null and ${table.automaticProjectDetectedAt} is null)
        or (${table.automaticProjectId} is not null and ${table.automaticProjectName} is not null and ${table.automaticProjectDetectedAt} is not null)`
    ),
    check(
      "sessions_project_override_shape_check",
      sql`(${table.projectOverrideId} is null and ${table.projectOverrideName} is null and ${table.projectOverridePath} is null and ${table.projectOverrideAt} is null and ${table.projectOverrideByUserId} is null)
        or (${table.projectOverrideId} is not null and ${table.projectOverrideName} is not null and ${table.projectOverrideAt} is not null and ${table.projectOverrideByUserId} is not null)`
    ),
    index("sessions_owner_effective_project_idx").on(
      table.ownerUserId,
      table.projectOverrideId,
      table.automaticProjectId
    )
  ]
);

export const turns = pgTable(
  "turns",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    externalTurnId: text("external_turn_id"),
    turnIndex: integer("turn_index"),
    sourceRuntime: sourceRuntime("source_runtime").notNull(),
    captureMethod: captureMethod("capture_method").notNull(),
    sourceKind: text("source_kind"),
    sourceAdapterVersion: text("source_adapter_version"),
    externalThreadId: text("external_thread_id"),
    sourceMetadata: jsonb("source_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    codexTranscriptPath: text("codex_transcript_path"),
    idempotencyKey: text("idempotency_key"),
    sourceHash: text("source_hash"),
    createdAt: now(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason")
  },
  (table) => [
    uniqueIndex("turns_session_external_turn_unique")
      .on(table.sessionId, table.externalTurnId)
      .where(sql`${table.externalTurnId} is not null`),
    uniqueIndex("turns_session_turn_index_unique")
      .on(table.sessionId, table.turnIndex)
      .where(sql`${table.turnIndex} is not null`),
    uniqueIndex("turns_idempotency_key_unique")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    uniqueIndex("turns_source_hash_unique")
      .on(table.sourceHash)
      .where(sql`${table.sourceHash} is not null`),
    check(
      "turns_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    )
  ]
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").references(() => turns.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    role: text("role").notNull(),
    content: text("content").notNull(),
    contentJson: jsonb("content_json").$type<unknown>(),
    sourceRuntime: sourceRuntime("source_runtime").notNull(),
    captureMethod: captureMethod("capture_method").notNull(),
    codexTranscriptPath: text("codex_transcript_path"),
    transcriptItemId: text("transcript_item_id"),
    idempotencyKey: text("idempotency_key"),
    sourceHash: text("source_hash"),
    tokenCount: integer("token_count"),
    recallEligible: boolean("recall_eligible").notNull().default(true),
    projectionPolicyKey: text("projection_policy_key"),
    projectionPolicyRevision: bigint("projection_policy_revision", {
      mode: "number"
    }),
    sourceEventTime: timestamp("source_event_time", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: now(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason")
  },
  (table) => [
    uniqueIndex("messages_session_transcript_item_unique")
      .on(table.sessionId, table.transcriptItemId)
      .where(sql`${table.transcriptItemId} is not null`),
    uniqueIndex("messages_idempotency_key_unique")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    uniqueIndex("messages_source_hash_unique")
      .on(table.sourceHash)
      .where(sql`${table.sourceHash} is not null`),
    check(
      "messages_role_check",
      sql`${table.role} in ('user', 'assistant', 'system', 'tool')`
    ),
    check(
      "messages_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    )
  ]
);

export const toolEvents = pgTable(
  "tool_events",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").references(() => turns.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null"
    }),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    toolName: text("tool_name").notNull(),
    toolInput: jsonb("tool_input").$type<unknown>(),
    toolResponse: jsonb("tool_response").$type<unknown>(),
    status: text("status"),
    sourceRuntime: sourceRuntime("source_runtime").notNull(),
    captureMethod: captureMethod("capture_method").notNull(),
    codexTranscriptPath: text("codex_transcript_path"),
    transcriptItemId: text("transcript_item_id"),
    idempotencyKey: text("idempotency_key"),
    sourceHash: text("source_hash"),
    sourceEventTime: timestamp("source_event_time", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: now(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason")
  },
  (table) => [
    uniqueIndex("tool_events_transcript_item_unique")
      .on(table.sessionId, table.transcriptItemId)
      .where(sql`${table.transcriptItemId} is not null`),
    uniqueIndex("tool_events_idempotency_key_unique")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    uniqueIndex("tool_events_source_hash_unique")
      .on(table.sourceHash)
      .where(sql`${table.sourceHash} is not null`),
    check(
      "tool_events_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    )
  ]
);

export const memoryEvents = pgTable(
  "memory_events",
  {
    id: id(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    visibility: visibilityScope("visibility").notNull(),
    eventType: memoryEventType("event_type").notNull(),
    sourceRuntime: sourceRuntime("source_runtime"),
    captureMethod: captureMethod("capture_method").notNull(),
    codexTranscriptPath: text("codex_transcript_path"),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    turnId: uuid("turn_id").references(() => turns.id, {
      onDelete: "set null"
    }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null"
    }),
    toolEventId: uuid("tool_event_id").references(() => toolEvents.id, {
      onDelete: "set null"
    }),
    idempotencyKey: text("idempotency_key"),
    sourceHash: text("source_hash"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    includeInEmbedding: boolean("include_in_embedding").notNull().default(true),
    includeInLcm: boolean("include_in_lcm").notNull().default(true),
    projectionPolicyKey: text("projection_policy_key"),
    projectionPolicyRevision: bigint("projection_policy_revision", {
      mode: "number"
    }),
    tokenCount: integer("token_count"),
    sealReason: text("seal_reason"),
    sourceEventTime: timestamp("source_event_time", { withTimezone: true }),
    sourceSequence: bigint("source_sequence", { mode: "number" }),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: now(),
    updatedAt: updatedNow(),
    personalDeletedAt: timestamp("personal_deleted_at", {
      withTimezone: true
    }),
    personalDeletedByUserId: uuid("personal_deleted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    personalDeletionReason: text("personal_deletion_reason"),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason")
  },
  (table) => [
    uniqueIndex("memory_events_idempotency_key_unique")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    uniqueIndex("memory_events_source_hash_unique")
      .on(table.sourceHash)
      .where(sql`${table.sourceHash} is not null`),
    index("memory_events_personal_graph_idx")
      .on(table.ownerUserId, table.createdAt.desc())
      .where(sql`${table.visibility} = 'personal'`),
    index("memory_events_personal_capture_idx")
      .on(table.ownerUserId, table.capturedAt.desc(), table.id.desc())
      .where(
        sql`${table.visibility} = 'personal' and ${table.invalidatedAt} is null`
      ),
    index("memory_events_personal_workspace_expr_idx")
      .on(
        table.ownerUserId,
        sql`${table.payload} ->> 'workspaceId'`,
        table.capturedAt.desc(),
        table.id.desc()
      )
      .where(
        sql`${table.visibility} = 'personal' and ${table.invalidatedAt} is null`
      ),
    index("memory_events_personal_external_thread_expr_idx")
      .on(
        table.ownerUserId,
        sql`${table.payload} #>> '{metadata,externalSessionId}'`,
        table.capturedAt.desc(),
        table.id.desc()
      )
      .where(
        sql`${table.visibility} = 'personal' and ${table.invalidatedAt} is null`
      ),
    index("memory_events_personal_source_order_idx")
      .on(
        table.ownerUserId,
        sql`coalesce(${table.sourceEventTime}, ${table.capturedAt}) desc`,
        sql`${table.sourceSequence} desc nulls last`,
        table.id.desc()
      )
      .where(sql`${table.visibility} = 'personal'`),
    index("memory_events_personal_lcm_dispatch_idx")
      .on(table.ownerUserId, table.id)
      .where(
        sql`${table.visibility} = 'personal' and ${table.includeInLcm} = true and ${table.invalidatedAt} is null and ${table.personalDeletedAt} is null`
      ),
    check(
      "memory_events_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    )
  ]
);

export const memoryNodes = pgTable(
  "memory_nodes",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    visibility: visibilityScope("visibility").notNull(),
    kind: text("kind").notNull(),
    depth: integer("depth").notNull().default(0),
    title: text("title"),
    summaryText: text("summary_text").notNull(),
    bodyText: text("body_text"),
    sourceRuntime: sourceRuntime("source_runtime"),
    captureMethod: captureMethod("capture_method").notNull(),
    codexTranscriptPath: text("codex_transcript_path"),
    idempotencyKey: text("idempotency_key"),
    sourceHash: text("source_hash"),
    summaryModel: text("summary_model"),
    summaryPromptVersion: text("summary_prompt_version"),
    lcmAlgorithmVersion: text("lcm_algorithm_version"),
    sourceItemsJson: jsonb("source_items_json")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sourceEventCount: integer("source_event_count").notNull().default(0),
    sourceTokenEstimate: integer("source_token_estimate"),
    summaryTokenEstimate: integer("summary_token_estimate"),
    sourceSpanStart: timestamp("source_span_start", { withTimezone: true }),
    sourceSpanEnd: timestamp("source_span_end", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    summaryCorrectedAt: timestamp("summary_corrected_at", {
      withTimezone: true
    }),
    summaryCorrectedByUserId: uuid("summary_corrected_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    summaryStructuredJson: jsonb("summary_structured_json").$type<
      Record<string, unknown>
    >(),
    summaryStructuredSchemaVersion: text("summary_structured_schema_version"),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: now(),
    updatedAt: updatedNow(),
    personalDeletedAt: timestamp("personal_deleted_at", {
      withTimezone: true
    }),
    personalDeletedByUserId: uuid("personal_deleted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    personalDeletionReason: text("personal_deletion_reason"),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason")
  },
  (table) => [
    uniqueIndex("memory_nodes_idempotency_key_unique")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    uniqueIndex("memory_nodes_source_hash_unique")
      .on(table.sourceHash)
      .where(sql`${table.sourceHash} is not null`),
    index("memory_nodes_personal_visible_idx")
      .on(table.ownerUserId, table.createdAt.desc())
      .where(
        sql`${table.visibility} = 'personal' and ${table.invalidatedAt} is null`
      ),
    index("memory_nodes_lcm_scope_depth_idx")
      .on(table.visibility, table.ownerUserId, table.depth, table.createdAt)
      .where(sql`${table.invalidatedAt} is null`),
    index("memory_nodes_personal_pinned_idx")
      .on(table.ownerUserId, table.pinnedAt.desc())
      .where(
        sql`${table.visibility} = 'personal' and ${table.invalidatedAt} is null and ${table.pinnedAt} is not null`
      ),
    index("memory_nodes_personal_updated_idx")
      .on(table.ownerUserId, table.updatedAt.desc(), table.id.desc())
      .where(
        sql`${table.visibility} = 'personal' and ${table.invalidatedAt} is null`
      ),
    check("memory_nodes_kind_check", sql`${table.kind} in ('leaf', 'rollup')`),
    check("memory_nodes_depth_check", sql`${table.depth} >= 0`),
    check(
      "memory_nodes_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    )
  ]
);

export const memoryNodeSources = pgTable(
  "memory_node_sources",
  {
    memoryNodeId: uuid("memory_node_id")
      .notNull()
      .references(() => memoryNodes.id, { onDelete: "cascade" }),
    memoryEventId: uuid("memory_event_id").references(() => memoryEvents.id, {
      onDelete: "set null"
    }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null"
    }),
    toolEventId: uuid("tool_event_id").references(() => toolEvents.id, {
      onDelete: "set null"
    }),
    sourceOrder: integer("source_order").notNull().default(0),
    sourceHash: text("source_hash"),
    createdAt: now()
  },
  (table) => [
    primaryKey({
      columns: [table.memoryNodeId, table.sourceOrder]
    }),
    index("memory_node_sources_event_order_idx")
      .on(table.memoryEventId, table.sourceOrder, table.memoryNodeId)
      .where(sql`${table.memoryEventId} is not null`),
    check(
      "memory_node_sources_one_source_check",
      sql`${table.memoryEventId} is not null or ${table.messageId} is not null or ${table.toolEventId} is not null`
    )
  ]
);

export const memoryNodeChildren = pgTable(
  "memory_node_children",
  {
    parentMemoryNodeId: uuid("parent_memory_node_id")
      .notNull()
      .references(() => memoryNodes.id, { onDelete: "cascade" }),
    childMemoryNodeId: uuid("child_memory_node_id")
      .notNull()
      .references(() => memoryNodes.id, { onDelete: "cascade" }),
    childOrder: integer("child_order").notNull().default(0),
    createdAt: now()
  },
  (table) => [
    primaryKey({
      columns: [table.parentMemoryNodeId, table.childOrder]
    }),
    unique("memory_node_children_parent_child_unique").on(
      table.parentMemoryNodeId,
      table.childMemoryNodeId
    ),
    index("memory_node_children_child_idx").on(
      table.childMemoryNodeId,
      table.parentMemoryNodeId
    )
  ]
);

export const memoryEmbeddings = pgTable(
  "memory_embeddings",
  {
    id: id(),
    memoryNodeId: uuid("memory_node_id").references(() => memoryNodes.id, {
      onDelete: "cascade"
    }),
    memoryEventId: uuid("memory_event_id").references(() => memoryEvents.id, {
      onDelete: "cascade"
    }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "cascade"
    }),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    visibility: visibilityScope("visibility").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimensions: integer("embedding_dimensions").notNull(),
    embeddingVersion: text("embedding_version").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceChunkIndex: integer("source_chunk_index").notNull().default(0),
    sourceChunkCount: integer("source_chunk_count").notNull().default(1),
    sourceText: text("source_text"),
    queryableVectorStrategy: text("queryable_vector_strategy")
      .notNull()
      .default("trusted_backend_pgvector_v1"),
    searchBoundary: text("search_boundary")
      .notNull()
      .default("owner_user_dynamic_grants"),
    canonicalEmbeddingState: text("canonical_embedding_state")
      .notNull()
      .default("not_stored"),
    createdAt: now(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason"),
    personalDeletedAt: timestamp("personal_deleted_at", {
      withTimezone: true
    }),
    personalDeletedByUserId: uuid("personal_deleted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    personalDeletionReason: text("personal_deletion_reason")
  },
  (table) => [
    uniqueIndex("memory_embeddings_unique_active_node_chunk")
      .on(
        table.memoryNodeId,
        table.embeddingModel,
        table.embeddingDimensions,
        table.embeddingVersion,
        table.sourceHash,
        table.sourceChunkIndex
      )
      .where(
        sql`${table.invalidatedAt} is null and ${table.memoryNodeId} is not null`
      ),
    uniqueIndex("memory_embeddings_unique_active_event_chunk")
      .on(
        table.memoryEventId,
        table.embeddingModel,
        table.embeddingDimensions,
        table.embeddingVersion,
        table.sourceHash,
        table.sourceChunkIndex
      )
      .where(
        sql`${table.invalidatedAt} is null and ${table.memoryEventId} is not null`
      ),
    uniqueIndex("memory_embeddings_unique_active_message_chunk")
      .on(
        table.messageId,
        table.embeddingModel,
        table.embeddingDimensions,
        table.embeddingVersion,
        table.sourceHash,
        table.sourceChunkIndex
      )
      .where(
        sql`${table.invalidatedAt} is null and ${table.messageId} is not null`
      ),
    index("memory_embeddings_personal_visible_idx")
      .on(table.ownerUserId, table.embeddingDimensions, table.createdAt.desc())
      .where(
        sql`${table.visibility} = 'personal' and ${table.invalidatedAt} is null`
      ),
    check(
      "memory_embeddings_embedding_dimensions_check",
      sql`${table.embeddingDimensions} in (384, 1024, 1536, 3072)`
    ),
    check(
      "memory_embeddings_one_source_check",
      sql`num_nonnulls(${table.memoryNodeId}, ${table.memoryEventId}, ${table.messageId}) = 1`
    ),
    check(
      "memory_embeddings_source_chunk_index_check",
      sql`${table.sourceChunkIndex} >= 0`
    ),
    check(
      "memory_embeddings_source_chunk_count_check",
      sql`${table.sourceChunkCount} >= 1 and ${table.sourceChunkIndex} < ${table.sourceChunkCount}`
    ),
    check(
      "memory_embeddings_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    ),
    check(
      "memory_embeddings_queryable_vector_strategy_check",
      sql`${table.queryableVectorStrategy} in ('trusted_backend_pgvector_v1')`
    ),
    check(
      "memory_embeddings_search_boundary_check",
      sql`${table.searchBoundary} in ('owner_user_dynamic_grants')`
    ),
    check(
      "memory_embeddings_canonical_embedding_state_check",
      sql`${table.canonicalEmbeddingState} in ('not_stored', 'encrypted_payload')`
    )
  ]
);

export const memoryEmbeddings384 = pgTable(
  "memory_embeddings_384",
  {
    memoryEmbeddingId: uuid("memory_embedding_id")
      .primaryKey()
      .references(() => memoryEmbeddings.id, { onDelete: "cascade" }),
    embedding: vector("embedding", { dimensions: 384 }).notNull()
  },
  (table) => [
    index("memory_embeddings_384_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops")
    )
  ]
);

export const memoryEmbeddings1024 = pgTable(
  "memory_embeddings_1024",
  {
    memoryEmbeddingId: uuid("memory_embedding_id")
      .primaryKey()
      .references(() => memoryEmbeddings.id, { onDelete: "cascade" }),
    embedding: vector("embedding", { dimensions: 1024 }).notNull()
  },
  (table) => [
    index("memory_embeddings_1024_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops")
    )
  ]
);

export const memoryEmbeddings1536 = pgTable(
  "memory_embeddings_1536",
  {
    memoryEmbeddingId: uuid("memory_embedding_id")
      .primaryKey()
      .references(() => memoryEmbeddings.id, { onDelete: "cascade" }),
    embedding: vector("embedding", { dimensions: 1536 }).notNull()
  },
  (table) => [
    index("memory_embeddings_1536_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops")
    )
  ]
);

export const memoryEmbeddings3072 = pgTable("memory_embeddings_3072", {
  memoryEmbeddingId: uuid("memory_embedding_id")
    .primaryKey()
    .references(() => memoryEmbeddings.id, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: 3072 }).notNull()
});

export const encryptedFieldPayloads = pgTable(
  "encrypted_field_payloads",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "cascade"
    }),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "cascade"
    }),
    teamWorkspaceId: uuid("team_workspace_id"),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    encryptionScope: text("encryption_scope").notNull().default("personal"),
    sourceTable: text("source_table").notNull(),
    sourceId: uuid("source_id").notNull(),
    sourceColumn: text("source_column").notNull(),
    plaintextContentType: text("plaintext_content_type")
      .notNull()
      .default("application/json"),
    plaintextEncoding: text("plaintext_encoding").notNull().default("utf8"),
    envelopeVersion: integer("envelope_version").notNull(),
    providerMode: text("provider_mode").notNull(),
    keyId: text("key_id").notNull(),
    keyVersion: integer("key_version").notNull(),
    scope: jsonb("scope")
      .$type<EncryptedPayloadEnvelope["scope"]>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    provenance: jsonb("provenance")
      .$type<EncryptedPayloadEnvelope["provenance"]>()
      .notNull(),
    algorithm: text("algorithm").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    tag: text("tag").notNull(),
    wrappedDek: jsonb("wrapped_dek")
      .$type<EncryptedPayloadEnvelope["wrappedDek"]>()
      .notNull(),
    ciphertextLocation: text("ciphertext_location").notNull(),
    aad: jsonb("aad")
      .$type<EncryptedPayloadEnvelope["aad"]>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    envelopeCreatedAt: timestamp("envelope_created_at", {
      withTimezone: true
    }).notNull(),
    envelopeReencryptedAt: timestamp("envelope_reencrypted_at", {
      withTimezone: true
    }),
    createdAt: now(),
    updatedAt: updatedNow(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason")
  },
  (table) => [
    uniqueIndex("encrypted_field_payloads_source_unique")
      .on(table.sourceTable, table.sourceId, table.sourceColumn)
      .where(sql`${table.invalidatedAt} is null`),
    index("encrypted_field_payloads_owner_idx")
      .on(table.ownerUserId, table.sourceTable, table.updatedAt.desc())
      .where(sql`${table.visibility} = 'personal'`),
    index("encrypted_field_payloads_team_idx")
      .on(table.teamId, table.teamWorkspaceId, table.sourceTable)
      .where(sql`${table.encryptionScope} = 'team'`),
    index("encrypted_field_payloads_key_idx").on(
      table.providerMode,
      table.keyId,
      table.keyVersion
    ),
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId]
    }),
    check(
      "encrypted_field_payloads_scope_owner_check",
      sql`(
        ${table.encryptionScope} = 'personal'
        and ${table.visibility} = 'personal'
        and ${table.ownerUserId} is not null
        and ${table.teamId} is null
        and ${table.teamWorkspaceId} is null
      ) or (
        ${table.encryptionScope} = 'team'
        and ${table.visibility} = 'personal'
        and ${table.teamId} is not null
      )`
    ),
    check(
      "encrypted_field_payloads_encryption_scope_check",
      sql`${table.encryptionScope} in ('personal', 'team')`
    ),
    check(
      "encrypted_field_payloads_source_table_check",
      sql`${table.sourceTable} in (
        'conversation_items',
        'conversation_item_observations',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'messages',
        'tool_events'
      )`
    ),
    check(
      "encrypted_field_payloads_provider_mode_check",
      sql`${table.providerMode} in (
        'local_test_key',
        'managed_kms',
        'operator_kms',
        'byok',
        'cmek'
      )`
    ),
    check(
      "encrypted_field_payloads_key_version_check",
      sql`${table.keyVersion} >= 0`
    ),
    check(
      "encrypted_field_payloads_envelope_version_check",
      sql`${table.envelopeVersion} >= 1`
    ),
    check(
      "encrypted_field_payloads_ciphertext_not_empty_check",
      sql`length(${table.ciphertext}) > 0 and length(${table.nonce}) > 0 and length(${table.tag}) > 0`
    )
  ]
);

export const encryptedFieldBackfillRuns = pgTable(
  "encrypted_field_backfill_runs",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    sourceTable: text("source_table").notNull(),
    sourceColumn: text("source_column").notNull(),
    providerMode: text("provider_mode").notNull(),
    status: text("status").notNull().default("pending"),
    cursorSourceId: uuid("cursor_source_id"),
    totalRows: integer("total_rows").notNull().default(0),
    processedRows: integer("processed_rows").notNull().default(0),
    encryptedRows: integer("encrypted_rows").notNull().default(0),
    failedRows: integer("failed_rows").notNull().default(0),
    lastErrorMessage: text("last_error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    index("encrypted_field_backfill_runs_status_idx").on(
      table.status,
      table.createdAt
    ),
    check(
      "encrypted_field_backfill_runs_source_table_check",
      sql`${table.sourceTable} in (
        'conversation_items',
        'conversation_item_observations',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'messages',
        'tool_events'
      )`
    ),
    check(
      "encrypted_field_backfill_runs_provider_mode_check",
      sql`${table.providerMode} in (
        'local_test_key',
        'managed_kms',
        'operator_kms',
        'byok',
        'cmek'
      )`
    ),
    check(
      "encrypted_field_backfill_runs_status_check",
      sql`${table.status} in ('pending', 'processing', 'completed', 'error')`
    ),
    check(
      "encrypted_field_backfill_runs_counts_check",
      sql`${table.totalRows} >= 0
        and ${table.processedRows} >= 0
        and ${table.encryptedRows} >= 0
        and ${table.failedRows} >= 0`
    )
  ]
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`array[]::text[]`),
    createdAt: now(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    check(
      "api_tokens_token_hash_length_check",
      sql`length(${table.tokenHash}) >= 32`
    )
  ]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "cascade"
    }),
    visibility: visibilityScope("visibility"),
    action: text("action").notNull(),
    targetTable: text("target_table"),
    targetId: uuid("target_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    auditSequence: bigserial("audit_sequence", { mode: "number" }).notNull(),
    createdAt: now()
  },
  (table) => [
    index("audit_events_actor_idx").on(
      table.actorUserId,
      table.createdAt.desc()
    ),
    index("audit_events_owner_idx").on(
      table.ownerUserId,
      table.createdAt.desc()
    ),
    index("audit_events_team_metadata_idx")
      .on(
        sql`(${table.metadata} ->> 'teamId')`,
        table.createdAt.desc(),
        table.auditSequence.desc()
      )
      .where(
        sql`${table.action} like 'team.%' and ${table.metadata} ? 'teamId'`
      ),
    index("audit_events_activation_team_idx")
      .on(
        sql`(${table.metadata} ->> 'teamId')`,
        table.createdAt.desc(),
        table.auditSequence.desc()
      )
      .where(
        sql`${table.action} like 'analytics.activation.%' and ${table.metadata} ? 'teamId'`
      )
  ]
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionHash: text("session_hash").notNull().unique(),
    createdAt: now(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    index("user_sessions_active_user_idx")
      .on(table.userId, table.expiresAt.desc())
      .where(sql`${table.revokedAt} is null`),
    check(
      "user_sessions_session_hash_length_check",
      sql`length(${table.sessionHash}) >= 32`
    )
  ]
);

export const deviceEnrollmentChallenges = pgTable(
  "device_enrollment_challenges",
  {
    id: id(),
    challengeHash: text("challenge_hash").notNull().unique(),
    upstreamBackendId: text("upstream_backend_id").notNull(),
    deviceInstanceId: text("device_instance_id"),
    rotationLineageId: uuid("rotation_lineage_id"),
    rotationOwnerUserId: uuid("rotation_owner_user_id").references(
      () => users.id,
      { onDelete: "cascade" }
    ),
    rotationCredentialId: uuid("rotation_credential_id").references(
      (): AnyPgColumn => deviceCredentials.id,
      { onDelete: "cascade" }
    ),
    deviceLabel: text("device_label"),
    requestedOperationFamilies: text("requested_operation_families")
      .array()
      .notNull()
      .default(sql`array[]::text[]`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: now(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    boundByUserId: uuid("bound_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    boundAt: timestamp("bound_at", { withTimezone: true }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true })
  },
  (table) => [
    index("device_enrollment_challenges_active_idx")
      .on(table.challengeHash)
      .where(sql`${table.redeemedAt} is null`),
    check(
      "device_enrollment_challenges_challenge_hash_length_check",
      sql`length(${table.challengeHash}) >= 32`
    )
  ]
);

export const deviceCredentials = pgTable(
  "device_credentials",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    enrollmentChallengeId: uuid("enrollment_challenge_id").references(
      () => deviceEnrollmentChallenges.id,
      { onDelete: "set null" }
    ),
    credentialKeyId: text("credential_key_id").notNull().unique(),
    upstreamBackendId: text("upstream_backend_id").notNull(),
    deviceInstanceId: text("device_instance_id").notNull(),
    lineageId: uuid("lineage_id").notNull().defaultRandom(),
    deviceLabel: text("device_label"),
    credentialVersion: integer("credential_version").notNull().default(1),
    verifierKind: deviceCredentialVerifierKind("verifier_kind").notNull(),
    verifierHash: text("verifier_hash"),
    publicKeyJwk: jsonb("public_key_jwk").$type<Record<string, unknown>>(),
    operationFamilies: text("operation_families")
      .array()
      .notNull()
      .default(sql`array[]::text[]`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: now(),
    updatedAt: updatedNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    revocationReason: text("revocation_reason")
  },
  (table) => [
    index("device_credentials_active_lookup_idx")
      .on(table.credentialKeyId)
      .where(sql`${table.revokedAt} is null`),
    index("device_credentials_owner_upstream_idx")
      .on(table.ownerUserId, table.upstreamBackendId, table.createdAt.desc())
      .where(sql`${table.revokedAt} is null`),
    index("device_credentials_active_lineage_idx")
      .on(table.ownerUserId, table.upstreamBackendId, table.lineageId)
      .where(sql`${table.revokedAt} is null`),
    uniqueIndex("device_credentials_active_device_unique")
      .on(table.ownerUserId, table.upstreamBackendId, table.deviceInstanceId)
      .where(sql`${table.revokedAt} is null`),
    check(
      "device_credentials_credential_version_check",
      sql`${table.credentialVersion} > 0`
    ),
    check(
      "device_credentials_credential_key_id_length_check",
      sql`length(${table.credentialKeyId}) >= 16`
    ),
    check(
      "device_credentials_verifier_hash_length_check",
      sql`${table.verifierHash} is null or length(${table.verifierHash}) >= 32`
    ),
    check(
      "device_credentials_verifier_shape_check",
      sql`(
        ${table.verifierKind} = 'secret_hash'
        and ${table.verifierHash} is not null
        and ${table.publicKeyJwk} is null
      ) or (
        ${table.verifierKind} = 'public_key_jwk'
        and ${table.publicKeyJwk} is not null
        and ${table.verifierHash} is null
      )`
    )
  ]
);

export const capturePolicies = pgTable(
  "capture_policies",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: capturePolicyTarget("target_type").notNull(),
    projectId: text("project_id"),
    projectName: text("project_name"),
    projectPath: text("project_path"),
    threadId: text("thread_id"),
    threadName: text("thread_name"),
    captureState: captureState("capture_state"),
    visibility: visibilityScope("visibility"),
    pauseUntil: timestamp("pause_until", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    uniqueIndex("capture_policies_unique_target").on(
      table.ownerUserId,
      table.targetType,
      sql`coalesce(${table.projectId}, '')`,
      sql`coalesce(${table.threadId}, '')`
    ),
    index("capture_policies_owner_updated_idx").on(
      table.ownerUserId,
      table.updatedAt.desc()
    ),
    check(
      "capture_policies_target_check",
      sql`(${table.targetType} = 'global' and ${table.projectId} is null and ${table.threadId} is null)
        or (${table.targetType} = 'project' and ${table.projectId} is not null and ${table.threadId} is null)
        or (${table.targetType} = 'thread' and ${table.threadId} is not null)`
    )
  ]
);

export const conversationItems = pgTable(
  "conversation_items",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    turnId: uuid("turn_id").references(() => turns.id, {
      onDelete: "set null"
    }),
    sourceKind: text("source_kind").notNull(),
    sourceAdapterVersion: text("source_adapter_version").notNull(),
    sourceTransport: text("source_transport").notNull(),
    externalSessionId: text("external_session_id"),
    externalThreadId: text("external_thread_id"),
    externalTurnId: text("external_turn_id"),
    externalItemId: text("external_item_id"),
    canonicalStableItemId: text("canonical_stable_item_id"),
    parentExternalItemId: text("parent_external_item_id"),
    sourceRecordType: text("source_record_type").notNull(),
    sourceEventType: text("source_event_type"),
    sourcePath: text("source_path"),
    sourceLineNumber: integer("source_line_number"),
    sourceSequence: integer("source_sequence"),
    eventTime: timestamp("event_time", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rawJson: jsonb("raw_json").$type<unknown>().notNull(),
    rawText: text("raw_text"),
    sourceHash: text("source_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    canonicalItemKey: text("canonical_item_key").notNull(),
    canonicalSourcePriority: integer("canonical_source_priority")
      .notNull()
      .default(0),
    projectionStatus: text("projection_status").notNull().default("pending"),
    projectionVersion: text("projection_version"),
    projectionPolicyRevision: bigint("projection_policy_revision", {
      mode: "number"
    }),
    projectedAt: timestamp("projected_at", { withTimezone: true }),
    projectionError: text("projection_error"),
    memoryExcludedAt: timestamp("memory_excluded_at", { withTimezone: true }),
    memoryExclusionReason: text("memory_exclusion_reason"),
    memoryExcludedByUserId: uuid("memory_excluded_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    personalDeletedAt: timestamp("personal_deleted_at", {
      withTimezone: true
    }),
    personalDeletedByUserId: uuid("personal_deleted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    personalDeletionReason: text("personal_deletion_reason"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    logicalSourceId: text("logical_source_id"),
    transportChunkIndex: integer("transport_chunk_index").notNull().default(0),
    transportChunkCount: integer("transport_chunk_count").notNull().default(1),
    transportChunkText: text("transport_chunk_text"),
    transportChunkEncoding: text("transport_chunk_encoding"),
    createdAt: now()
  },
  (table) => [
    unique("conversation_items_id_owner_visibility_unique").on(
      table.id,
      table.ownerUserId,
      table.visibility
    ),
    uniqueIndex("conversation_items_personal_idempotency_key_unique")
      .on(table.ownerUserId, table.idempotencyKey)
      .where(sql`${table.visibility} = 'personal'`),
    uniqueIndex("conversation_items_personal_canonical_item_key_unique")
      .on(table.ownerUserId, table.canonicalItemKey)
      .where(sql`${table.visibility} = 'personal'`),
    index("conversation_items_session_observed_idx").on(
      table.sessionId,
      table.observedAt,
      table.id
    ),
    index("conversation_items_session_turn_observed_idx").on(
      table.sessionId,
      table.turnId,
      table.observedAt,
      table.id
    ),
    index("conversation_items_source_thread_idx").on(
      table.sourceKind,
      table.externalSessionId,
      table.externalTurnId
    ),
    index("conversation_items_source_item_idx")
      .on(table.sourceKind, table.externalItemId)
      .where(sql`${table.externalItemId} is not null`),
    index("conversation_items_canonical_provider_identity_idx")
      .on(
        table.ownerUserId,
        table.sourceKind,
        table.externalThreadId,
        table.externalTurnId,
        table.canonicalStableItemId
      )
      .where(sql`${table.canonicalStableItemId} is not null`),
    index("conversation_items_projection_idx").on(
      table.projectionStatus,
      table.projectedAt,
      table.observedAt,
      table.id
    ),
    index("conversation_items_memory_excluded_idx")
      .on(table.ownerUserId, table.memoryExcludedAt)
      .where(sql`${table.memoryExcludedAt} is not null`),
    index("conversation_items_personal_logical_source_idx")
      .on(table.ownerUserId, table.logicalSourceId, table.transportChunkIndex)
      .where(
        sql`${table.visibility} = 'personal' and ${table.logicalSourceId} is not null`
      ),
    check(
      "conversation_items_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    ),
    check(
      "conversation_items_source_line_number_check",
      sql`${table.sourceLineNumber} is null or ${table.sourceLineNumber} >= 0`
    ),
    check(
      "conversation_items_source_sequence_check",
      sql`${table.sourceSequence} is null or ${table.sourceSequence} >= 0`
    ),
    check(
      "conversation_items_transport_chunk_index_check",
      sql`${table.transportChunkIndex} >= 0`
    ),
    check(
      "conversation_items_transport_chunk_count_check",
      sql`${table.transportChunkCount} >= 1 and ${table.transportChunkIndex} < ${table.transportChunkCount}`
    ),
    check(
      "conversation_items_transport_chunk_limits_check",
      sql`${table.transportChunkText} is null or (
        ${table.transportChunkCount} <= 64
        and octet_length(${table.transportChunkText}) <= 262144
      )`
    ),
    check(
      "conversation_items_transport_chunk_payload_check",
      sql`${table.transportChunkText} is null or (
        ${table.logicalSourceId} is not null
        and ${table.metadata} ? 'transportChunkGroupId'
      )`
    ),
    check(
      "conversation_items_canonical_source_priority_check",
      sql`${table.canonicalSourcePriority} >= 0`
    ),
    check(
      "conversation_items_projection_status_check",
      sql`${table.projectionStatus} in ('pending', 'held', 'projected', 'error', 'raw_only')`
    )
  ]
);

export const conversationItemObservations = pgTable(
  "conversation_item_observations",
  {
    id: id(),
    conversationItemId: uuid("conversation_item_id").references(
      () => conversationItems.id,
      { onDelete: "cascade" }
    ),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "cascade"
    }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    canonicalItemKey: text("canonical_item_key"),
    observationKey: text("observation_key").notNull(),
    observationKind: text("observation_kind").notNull().default("snapshot"),
    ingestionStatus: text("ingestion_status").notNull().default("persisted"),
    observationComponent: text("observation_component"),
    sourceKind: text("source_kind").notNull(),
    sourceAdapterVersion: text("source_adapter_version").notNull(),
    sourceTransport: text("source_transport").notNull(),
    externalSessionId: text("external_session_id"),
    externalThreadId: text("external_thread_id"),
    externalTurnId: text("external_turn_id"),
    externalItemId: text("external_item_id"),
    canonicalStableItemId: text("canonical_stable_item_id"),
    sourceRecordType: text("source_record_type").notNull(),
    sourceEventType: text("source_event_type"),
    sourcePath: text("source_path"),
    sourceLineNumber: integer("source_line_number"),
    sourceSequence: integer("source_sequence"),
    eventTime: timestamp("event_time", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rawJson: jsonb("raw_json").$type<unknown>().notNull(),
    rawText: text("raw_text"),
    transportChunkIndex: integer("transport_chunk_index"),
    transportChunkCount: integer("transport_chunk_count"),
    transportChunkText: text("transport_chunk_text"),
    transportChunkEncoding: text("transport_chunk_encoding"),
    sourceHash: text("source_hash").notNull(),
    payloadHash: text("payload_hash").notNull(),
    sourceIdempotencyKey: text("source_idempotency_key").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    foreignKey({
      name: "conversation_item_observations_parent_identity_fk",
      columns: [table.conversationItemId, table.ownerUserId, table.visibility],
      foreignColumns: [
        conversationItems.id,
        conversationItems.ownerUserId,
        conversationItems.visibility
      ]
    }).onDelete("cascade"),
    uniqueIndex("conversation_item_observations_personal_key_unique")
      .on(table.ownerUserId, table.observationKey)
      .where(sql`${table.visibility} = 'personal'`),
    index("conversation_item_observations_item_idx").on(
      table.conversationItemId,
      table.observedAt,
      table.id
    ),
    index("conversation_item_observations_session_idx").on(
      table.sessionId,
      table.observedAt,
      table.id
    ),
    index("conversation_item_observations_source_idx").on(
      table.ownerUserId,
      table.sourceTransport,
      table.externalThreadId,
      table.externalTurnId,
      table.externalItemId
    ),
    index("conversation_item_observations_canonical_identity_idx")
      .on(
        table.ownerUserId,
        table.externalThreadId,
        table.externalTurnId,
        table.canonicalStableItemId
      )
      .where(sql`${table.canonicalStableItemId} is not null`),
    check(
      "conversation_item_observations_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    ),
    check(
      "conversation_item_observations_kind_check",
      sql`${table.observationKind} in (
        'snapshot',
        'lifecycle_started',
        'lifecycle_completed',
        'control',
        'reconciliation'
      )`
    ),
    check(
      "conversation_item_observations_ingestion_status_check",
      sql`${table.ingestionStatus} in ('persisted', 'identity_unresolved')`
    ),
    check(
      "conversation_item_observations_parent_link_check",
      sql`(
        ${table.conversationItemId} is not null
        and ${table.canonicalItemKey} is not null
        and ${table.ingestionStatus} = 'persisted'
      ) or (
        ${table.conversationItemId} is null
        and ${table.canonicalItemKey} is null
        and ${table.ingestionStatus} = 'identity_unresolved'
        and ${table.sessionId} is not null
      )`
    ),
    check(
      "conversation_item_observations_source_line_number_check",
      sql`${table.sourceLineNumber} is null or ${table.sourceLineNumber} >= 0`
    ),
    check(
      "conversation_item_observations_source_sequence_check",
      sql`${table.sourceSequence} is null or ${table.sourceSequence} >= 0`
    ),
    check(
      "conversation_item_observations_transport_chunk_check",
      sql`(
        ${table.transportChunkIndex} is null
        and ${table.transportChunkCount} is null
        and ${table.transportChunkText} is null
        and ${table.transportChunkEncoding} is null
      ) or (
        ${table.transportChunkIndex} is not null
        and ${table.transportChunkCount} is not null
        and ${table.transportChunkIndex} >= 0
        and ${table.transportChunkCount} >= 1
        and ${table.transportChunkCount} <= 64
        and ${table.transportChunkIndex} < ${table.transportChunkCount}
        and ${table.transportChunkText} is not null
        and ${table.metadata} ? 'transportChunkGroupId'
        and octet_length(${table.transportChunkText}) <= 262144
      )`
    )
  ]
);

export const teamSessionShareGrants = pgTable(
  "team_session_share_grants",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: now(),
    updatedAt: updatedNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    revocationReason: text("revocation_reason"),
    personalDeletedAt: timestamp("personal_deleted_at", {
      withTimezone: true
    }),
    personalDeletedByUserId: uuid("personal_deleted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    personalDeletionReason: text("personal_deletion_reason"),
    retainedByTeamAt: timestamp("retained_by_team_at", {
      withTimezone: true
    }).defaultNow(),
    retentionReason: text("retention_reason")
      .notNull()
      .default("active_team_share")
  },
  (table) => [
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "team_session_share_grants_workspace_team_fk"
    }),
    uniqueIndex("team_session_share_grants_active_unique")
      .on(table.sessionId, table.teamWorkspaceId)
      .where(
        sql`${table.sessionId} is not null and ${table.revokedAt} is null`
      ),
    index("team_session_share_grants_workspace_active_idx")
      .on(table.teamWorkspaceId, table.createdAt.desc())
      .where(sql`${table.revokedAt} is null`),
    index("team_session_share_grants_owner_idx").on(
      table.ownerUserId,
      table.createdAt.desc()
    )
  ]
);

export const deploymentIdentities = pgTable(
  "deployment_identities",
  {
    id: id(),
    protocolDeploymentId: uuid("protocol_deployment_id").notNull(),
    locality: syncDeploymentLocality("locality").notNull(),
    profile: deploymentProfile("profile").notNull(),
    displayName: text("display_name"),
    baseUrl: text("base_url"),
    upstreamBackendId: text("upstream_backend_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: now(),
    updatedAt: updatedNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason")
  },
  (table) => [
    unique("deployment_identities_protocol_id_unique").on(
      table.protocolDeploymentId
    ),
    uniqueIndex("deployment_identities_one_local_unique")
      .on(table.locality)
      .where(sql`${table.locality} = 'local'`),
    index("deployment_identities_profile_idx").on(
      table.profile,
      table.createdAt.desc()
    )
  ]
);

export const syncExternalUserIdentities = pgTable(
  "sync_external_user_identities",
  {
    id: id(),
    deploymentIdentityId: uuid("deployment_identity_id")
      .notNull()
      .references(() => deploymentIdentities.id, { onDelete: "cascade" }),
    externalSubjectId: text("external_subject_id").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: now(),
    updatedAt: updatedNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    unique("sync_external_user_identity_subject_unique").on(
      table.deploymentIdentityId,
      table.externalSubjectId
    ),
    unique("sync_external_user_identity_id_deployment_unique").on(
      table.id,
      table.deploymentIdentityId
    ),
    check(
      "sync_external_user_identity_subject_not_empty_check",
      sql`length(trim(${table.externalSubjectId})) > 0`
    ),
    check(
      "sync_external_user_identity_status_check",
      sql`${table.status} in ('active', 'revoked')`
    )
  ]
);

export const syncPrincipalLinks = pgTable(
  "sync_principal_links",
  {
    id: id(),
    localUserId: uuid("local_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    externalUserIdentityId: uuid("external_user_identity_id")
      .notNull()
      .references(() => syncExternalUserIdentities.id, {
        onDelete: "cascade"
      }),
    proofKind: text("proof_kind").notNull(),
    proofReference: text("proof_reference").notNull(),
    createdAt: now(),
    verifiedAt: timestamp("verified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    unique("sync_principal_links_external_unique").on(
      table.externalUserIdentityId
    ),
    unique("sync_principal_links_local_external_unique").on(
      table.localUserId,
      table.externalUserIdentityId
    ),
    unique("sync_principal_links_proof_unique").on(
      table.proofKind,
      table.proofReference
    ),
    check(
      "sync_principal_links_proof_not_empty_check",
      sql`length(trim(${table.proofKind})) > 0 and length(trim(${table.proofReference})) > 0`
    )
  ]
);

export const logicalMemories = pgTable(
  "logical_memories",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    originDeploymentIdentityId: uuid("origin_deployment_identity_id")
      .notNull()
      .references(() => deploymentIdentities.id, { onDelete: "restrict" }),
    sourceBoundary: syncSourceBoundary("source_boundary").notNull(),
    originSourceId: text("origin_source_id").notNull(),
    localSessionId: uuid("local_session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    logicalKey: text("logical_key").notNull(),
    lineage: jsonb("lineage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: now(),
    updatedAt: updatedNow(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason")
  },
  (table) => [
    unique("logical_memories_owner_key_unique").on(
      table.ownerUserId,
      table.logicalKey
    ),
    unique("logical_memories_origin_unique").on(
      table.originDeploymentIdentityId,
      table.sourceBoundary,
      table.originSourceId
    ),
    uniqueIndex("logical_memories_owner_session_unique")
      .on(table.ownerUserId, table.localSessionId)
      .where(sql`${table.localSessionId} is not null`),
    index("logical_memories_owner_boundary_idx").on(
      table.ownerUserId,
      table.sourceBoundary,
      table.createdAt.desc()
    ),
    check(
      "logical_memories_captured_session_source_check",
      sql`${table.sourceBoundary} <> 'captured_session' or length(trim(${table.originSourceId})) > 0`
    ),
    check(
      "logical_memories_logical_key_not_empty_check",
      sql`length(trim(${table.logicalKey})) > 0`
    )
  ]
);

export const memoryReplicas = pgTable(
  "memory_replicas",
  {
    id: id(),
    logicalMemoryId: uuid("logical_memory_id")
      .notNull()
      .references(() => logicalMemories.id, { onDelete: "cascade" }),
    deploymentIdentityId: uuid("deployment_identity_id")
      .notNull()
      .references(() => deploymentIdentities.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    replicaRole: syncReplicaRole("replica_role").notNull(),
    sourceBoundary: syncSourceBoundary("source_boundary").notNull(),
    localSessionId: uuid("local_session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    externalReplicaId: text("external_replica_id"),
    freshnessStatus: text("freshness_status").notNull().default("unknown"),
    policyManifest: jsonb("policy_manifest")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: now(),
    updatedAt: updatedNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    staleAfter: timestamp("stale_after", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason")
  },
  (table) => [
    unique("memory_replicas_logical_deployment_role_unique").on(
      table.logicalMemoryId,
      table.deploymentIdentityId,
      table.replicaRole
    ),
    unique("memory_replicas_identity_consistency_unique").on(
      table.id,
      table.logicalMemoryId,
      table.ownerUserId
    ),
    uniqueIndex("memory_replicas_external_replica_unique")
      .on(table.deploymentIdentityId, table.externalReplicaId)
      .where(sql`${table.externalReplicaId} is not null`),
    index("memory_replicas_owner_status_idx").on(
      table.ownerUserId,
      table.freshnessStatus,
      table.updatedAt.desc()
    ),
    check(
      "memory_replicas_captured_session_source_check",
      sql`${table.sourceBoundary} <> 'captured_session' or ${table.localSessionId} is not null`
    ),
    check(
      "memory_replicas_freshness_status_check",
      sql`${table.freshnessStatus} in ('unknown', 'fresh', 'stale', 'revoked', 'failed')`
    )
  ]
);

export const crossIdentitySyncRelationships = pgTable(
  "cross_identity_sync_relationships",
  {
    id: id(),
    logicalMemoryId: uuid("logical_memory_id")
      .notNull()
      .references(() => logicalMemories.id, { onDelete: "cascade" }),
    side: syncRelationshipSide("side").notNull(),
    localReplicaId: uuid("local_replica_id").notNull(),
    localUserId: uuid("local_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    deviceCredentialId: uuid("device_credential_id").references(
      () => deviceCredentials.id,
      { onDelete: "restrict" }
    ),
    remoteDeploymentIdentityId: uuid("remote_deployment_identity_id")
      .notNull()
      .references(() => deploymentIdentities.id, { onDelete: "restrict" }),
    remoteUserIdentityId: uuid("remote_user_identity_id").notNull(),
    remoteReplicaId: uuid("remote_replica_id"),
    sourceBoundary: syncSourceBoundary("source_boundary").notNull(),
    syncMode: syncMode("sync_mode").notNull().default("live"),
    state: syncRelationshipState("state").notNull().default("created"),
    idempotencyKey: text("idempotency_key").notNull(),
    creationRequestHash: text("creation_request_hash").notNull(),
    policyManifest: jsonb("policy_manifest")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    consentManifest: jsonb("consent_manifest")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    sourceCursor: bigint("source_cursor", { mode: "number" })
      .notNull()
      .default(0),
    targetProcessingCursor: bigint("target_processing_cursor", {
      mode: "number"
    })
      .notNull()
      .default(0),
    packageSequence: bigint("package_sequence", { mode: "number" })
      .notNull()
      .default(0),
    staleAfter: timestamp("stale_after", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedNow(),
    lastPackageId: uuid("last_package_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastErrorClass: text("last_error_class"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    revocationReason: text("revocation_reason"),
    revocationId: uuid("revocation_id"),
    revocationSequence: bigint("revocation_sequence", { mode: "number" }),
    revocationOrigin: syncRelationshipSide("revocation_origin")
  },
  (table) => [
    unique("cross_identity_sync_relationships_local_idempotency_unique").on(
      table.localUserId,
      table.remoteDeploymentIdentityId,
      table.idempotencyKey
    ),
    uniqueIndex("cross_identity_sync_relationships_active_replica_unique")
      .on(
        table.localReplicaId,
        table.remoteDeploymentIdentityId,
        table.syncMode
      )
      .where(sql`${table.revokedAt} is null`),
    index("cross_identity_sync_relationships_local_user_idx").on(
      table.localUserId,
      table.updatedAt.desc()
    ),
    index("cross_identity_sync_relationships_state_idx").on(
      table.state,
      table.updatedAt.desc()
    ),
    index("cross_identity_sync_relationships_device_credential_idx")
      .on(table.deviceCredentialId, table.updatedAt.desc())
      .where(sql`${table.deviceCredentialId} is not null`),
    check(
      "cross_identity_sync_relationships_captured_session_source_check",
      sql`${table.sourceBoundary} = 'captured_session'`
    ),
    check(
      "cross_identity_sync_relationships_idempotency_key_not_empty_check",
      sql`length(trim(${table.idempotencyKey})) > 0`
    ),
    check(
      "cross_identity_sync_relationships_request_hash_check",
      sql`length(${table.creationRequestHash}) = 64`
    ),
    check(
      "cross_identity_sync_relationships_cursor_check",
      sql`${table.sourceCursor} >= 0 and ${table.targetProcessingCursor} >= 0 and ${table.packageSequence} >= 0`
    ),
    check(
      "cross_identity_sync_relationships_credential_side_check",
      sql`(${table.side} = 'source' and ${table.deviceCredentialId} is null) or (${table.side} = 'target' and ${table.deviceCredentialId} is not null)`
    ),
    foreignKey({
      columns: [table.localReplicaId, table.logicalMemoryId, table.localUserId],
      foreignColumns: [
        memoryReplicas.id,
        memoryReplicas.logicalMemoryId,
        memoryReplicas.ownerUserId
      ],
      name: "cross_identity_sync_relationships_local_replica_fk"
    }),
    foreignKey({
      columns: [table.remoteUserIdentityId, table.remoteDeploymentIdentityId],
      foreignColumns: [
        syncExternalUserIdentities.id,
        syncExternalUserIdentities.deploymentIdentityId
      ],
      name: "cross_identity_sync_relationships_remote_user_fk"
    })
  ]
);

export const syncServiceHeartbeats = pgTable("sync_service_heartbeats", {
  serviceName: text("service_name").primaryKey(),
  instanceId: uuid("instance_id").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: updatedNow()
});

export const syncRecipientKeys = pgTable(
  "sync_recipient_keys",
  {
    id: id(),
    deploymentIdentityId: uuid("deployment_identity_id")
      .notNull()
      .references(() => deploymentIdentities.id, { onDelete: "cascade" }),
    keyId: text("key_id").notNull(),
    keyVersion: integer("key_version").notNull(),
    algorithm: text("algorithm").notNull(),
    publicJwk: jsonb("public_jwk").$type<Record<string, unknown>>().notNull(),
    encryptedPrivateKey: jsonb("encrypted_private_key")
      .$type<EncryptedPayloadEnvelope>()
      .notNull(),
    createdAt: now(),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true })
  },
  (table) => [
    unique("sync_recipient_keys_key_version_unique").on(
      table.deploymentIdentityId,
      table.keyId,
      table.keyVersion
    ),
    uniqueIndex("sync_recipient_keys_active_unique")
      .on(table.deploymentIdentityId)
      .where(sql`${table.retiredAt} is null`),
    check("sync_recipient_keys_version_check", sql`${table.keyVersion} > 0`)
  ]
);

export const syncPackageUploadSessions = pgTable(
  "sync_package_upload_sessions",
  {
    id: id(),
    syncRelationshipId: uuid("sync_relationship_id")
      .notNull()
      .references(() => crossIdentitySyncRelationships.id, {
        onDelete: "cascade"
      }),
    protocolPackageId: uuid("protocol_package_id").notNull(),
    state: syncPackageState("state").notNull().default("created"),
    packageFormatVersion: integer("package_format_version")
      .notNull()
      .default(1),
    requestHash: text("request_hash").notNull(),
    packageManifest: jsonb("package_manifest")
      .$type<Record<string, unknown>>()
      .notNull(),
    packageChecksum: text("package_checksum").notNull(),
    sourceSequence: bigint("source_sequence", { mode: "number" }).notNull(),
    fromCursor: bigint("from_cursor", { mode: "number" }).notNull(),
    toCursor: bigint("to_cursor", { mode: "number" }).notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
    uploadedBytes: bigint("uploaded_bytes", { mode: "number" })
      .notNull()
      .default(0),
    expectedChunkCount: integer("expected_chunk_count").notNull(),
    chunkCount: integer("chunk_count").notNull().default(0),
    verifiedChunkCount: integer("verified_chunk_count").notNull().default(0),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: now(),
    updatedAt: updatedNow(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastErrorMessage: text("last_error_message")
  },
  (table) => [
    unique("sync_package_upload_sessions_idempotency_unique").on(
      table.syncRelationshipId,
      table.idempotencyKey
    ),
    unique("sync_package_upload_sessions_protocol_package_unique").on(
      table.protocolPackageId
    ),
    unique("sync_package_upload_sessions_relationship_sequence_unique").on(
      table.syncRelationshipId,
      table.sourceSequence
    ),
    unique("sync_package_upload_sessions_id_relationship_unique").on(
      table.id,
      table.syncRelationshipId
    ),
    index("sync_package_upload_sessions_state_idx").on(
      table.state,
      table.updatedAt.desc()
    ),
    check(
      "sync_package_upload_sessions_checksum_not_empty_check",
      sql`length(trim(${table.packageChecksum})) > 0`
    ),
    check(
      "sync_package_upload_sessions_idempotency_key_not_empty_check",
      sql`length(trim(${table.idempotencyKey})) > 0`
    ),
    check(
      "sync_package_upload_sessions_counts_check",
      sql`${table.packageFormatVersion} > 0
        and ${table.totalBytes} >= 0
        and ${table.uploadedBytes} >= 0
        and ${table.uploadedBytes} <= ${table.totalBytes}
        and ${table.sourceSequence} > 0
        and ${table.fromCursor} >= 0
        and ${table.toCursor} >= ${table.fromCursor}
        and ${table.expectedChunkCount} > 0
        and ${table.chunkCount} >= 0
        and ${table.chunkCount} <= ${table.expectedChunkCount}
        and ${table.verifiedChunkCount} >= 0
        and ${table.verifiedChunkCount} <= ${table.chunkCount}`
    )
  ]
);

export const syncPackageChunks = pgTable(
  "sync_package_chunks",
  {
    id: id(),
    uploadSessionId: uuid("upload_session_id")
      .notNull()
      .references(() => syncPackageUploadSessions.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    chunkChecksum: text("chunk_checksum").notNull(),
    byteCount: integer("byte_count").notNull(),
    encryptedPayload: jsonb("encrypted_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    unique("sync_package_chunks_session_index_unique").on(
      table.uploadSessionId,
      table.chunkIndex
    ),
    check("sync_package_chunks_index_check", sql`${table.chunkIndex} >= 0`),
    check("sync_package_chunks_byte_count_check", sql`${table.byteCount} >= 0`),
    check(
      "sync_package_chunks_checksum_not_empty_check",
      sql`length(trim(${table.chunkChecksum})) > 0`
    )
  ]
);

export const syncOutboxEntries = pgTable(
  "sync_outbox_entries",
  {
    id: id(),
    syncRelationshipId: uuid("sync_relationship_id")
      .notNull()
      .references(() => crossIdentitySyncRelationships.id, {
        onDelete: "cascade"
      }),
    uploadSessionId: uuid("upload_session_id").references(
      () => syncPackageUploadSessions.id,
      { onDelete: "set null" }
    ),
    state: syncQueueEntryState("state").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    payloadManifest: jsonb("payload_manifest")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    lastErrorMessage: text("last_error_message"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("sync_outbox_entries_idempotency_unique").on(
      table.syncRelationshipId,
      table.idempotencyKey
    ),
    index("sync_outbox_entries_state_idx").on(table.state, table.availableAt),
    check(
      "sync_outbox_entries_attempts_check",
      sql`${table.attemptCount} >= 0 and ${table.maxAttempts} > 0 and ${table.attemptCount} <= ${table.maxAttempts}`
    ),
    check(
      "sync_outbox_entries_idempotency_key_not_empty_check",
      sql`length(trim(${table.idempotencyKey})) > 0`
    ),
    foreignKey({
      columns: [table.uploadSessionId, table.syncRelationshipId],
      foreignColumns: [
        syncPackageUploadSessions.id,
        syncPackageUploadSessions.syncRelationshipId
      ],
      name: "sync_outbox_upload_relationship_fk"
    })
  ]
);

export const syncInboxEntries = pgTable(
  "sync_inbox_entries",
  {
    id: id(),
    syncRelationshipId: uuid("sync_relationship_id")
      .notNull()
      .references(() => crossIdentitySyncRelationships.id, {
        onDelete: "cascade"
      }),
    uploadSessionId: uuid("upload_session_id").references(
      () => syncPackageUploadSessions.id,
      { onDelete: "set null" }
    ),
    state: syncQueueEntryState("state").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    payloadManifest: jsonb("payload_manifest")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    lastErrorMessage: text("last_error_message"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("sync_inbox_entries_idempotency_unique").on(
      table.syncRelationshipId,
      table.idempotencyKey
    ),
    index("sync_inbox_entries_state_idx").on(table.state, table.availableAt),
    check(
      "sync_inbox_entries_attempts_check",
      sql`${table.attemptCount} >= 0 and ${table.maxAttempts} > 0 and ${table.attemptCount} <= ${table.maxAttempts}`
    ),
    check(
      "sync_inbox_entries_idempotency_key_not_empty_check",
      sql`length(trim(${table.idempotencyKey})) > 0`
    ),
    foreignKey({
      columns: [table.uploadSessionId, table.syncRelationshipId],
      foreignColumns: [
        syncPackageUploadSessions.id,
        syncPackageUploadSessions.syncRelationshipId
      ],
      name: "sync_inbox_upload_relationship_fk"
    })
  ]
);

export const syncSemanticChanges = pgTable(
  "sync_semantic_changes",
  {
    cursor: bigserial("cursor", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    memoryEventId: uuid("memory_event_id").references(() => memoryEvents.id, {
      onDelete: "set null"
    }),
    originEventId: uuid("origin_event_id").notNull(),
    operation: syncChangeOperation("operation").notNull(),
    revisionHash: text("revision_hash").notNull(),
    createdAt: now()
  },
  (table) => [
    index("sync_semantic_changes_session_cursor_idx").on(
      table.sessionId,
      table.cursor
    ),
    check(
      "sync_semantic_changes_revision_hash_check",
      sql`length(${table.revisionHash}) = 64`
    )
  ]
);

export const syncEventMappings = pgTable(
  "sync_event_mappings",
  {
    id: id(),
    syncRelationshipId: uuid("sync_relationship_id")
      .notNull()
      .references(() => crossIdentitySyncRelationships.id, {
        onDelete: "cascade"
      }),
    originEventId: uuid("origin_event_id").notNull(),
    revisionHash: text("revision_hash").notNull(),
    localMemoryEventId: uuid("local_memory_event_id").references(
      () => memoryEvents.id,
      { onDelete: "set null" }
    ),
    sourceCursor: bigint("source_cursor", { mode: "number" }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: now(),
    updatedAt: updatedNow(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true })
  },
  (table) => [
    unique("sync_event_mappings_revision_unique").on(
      table.syncRelationshipId,
      table.originEventId,
      table.revisionHash
    ),
    uniqueIndex("sync_event_mappings_active_origin_unique")
      .on(table.syncRelationshipId, table.originEventId)
      .where(sql`${table.active} = true`),
    index("sync_event_mappings_cursor_idx").on(
      table.syncRelationshipId,
      table.sourceCursor
    )
  ]
);

export const memoryEventSources = pgTable(
  "memory_event_sources",
  {
    memoryEventId: uuid("memory_event_id")
      .notNull()
      .references(() => memoryEvents.id, { onDelete: "cascade" }),
    conversationItemId: uuid("conversation_item_id")
      .notNull()
      .references(() => conversationItems.id, { onDelete: "cascade" }),
    sourceOrder: integer("source_order").notNull().default(0),
    sourceRole: text("source_role"),
    createdAt: now()
  },
  (table) => [
    primaryKey({
      columns: [
        table.memoryEventId,
        table.conversationItemId,
        table.sourceOrder
      ]
    }),
    index("memory_event_sources_conversation_item_idx").on(
      table.conversationItemId
    ),
    index("memory_event_sources_memory_event_order_idx").on(
      table.memoryEventId,
      table.sourceOrder
    )
  ]
);

export const semanticMemoryRebuildJobs = pgTable(
  "semantic_memory_rebuild_jobs",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    memoryEventId: uuid("memory_event_id")
      .notNull()
      .references(() => memoryEvents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    scheduledAfter: timestamp("scheduled_after", {
      withTimezone: true
    }).notNull(),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true
    }),
    processingLeaseUntil: timestamp("processing_lease_until", {
      withTimezone: true
    }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorMessage: text("last_error_message"),
    replacementMemoryEventIds: uuid("replacement_memory_event_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    uniqueIndex("semantic_memory_rebuild_jobs_active_unique")
      .on(table.memoryEventId)
      .where(sql`${table.status} in ('pending', 'processing')`),
    index("semantic_memory_rebuild_jobs_due_idx")
      .on(table.status, table.scheduledAfter, table.id)
      .where(sql`${table.status} in ('pending', 'error')`),
    index("semantic_memory_rebuild_jobs_actor_due_idx")
      .on(table.ownerUserId, table.status, table.scheduledAfter, table.id)
      .where(
        sql`${table.visibility} = 'personal' and ${table.status} in ('pending', 'error')`
      ),
    check(
      "semantic_memory_rebuild_jobs_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    ),
    check(
      "semantic_memory_rebuild_jobs_attempt_count_check",
      sql`${table.attemptCount} >= 0`
    ),
    check(
      "semantic_memory_rebuild_jobs_status_check",
      sql`${table.status} in ('pending', 'processing', 'completed', 'error')`
    )
  ]
);

export const memoryQuestions = pgTable(
  "memory_questions",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    origin: text("origin").notNull().default("explorer"),
    retrievalScope: text("retrieval_scope").notNull().default("personal"),
    searchDomain: memorySearchDomain("search_domain").notNull(),
    workspaceId: text("workspace_id"),
    projectName: text("project_name"),
    projectPath: text("project_path"),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "cascade"
    }),
    threadId: text("thread_id"),
    threadName: text("thread_name"),
    query: text("query").notNull(),
    answerMarkdown: text("answer_markdown"),
    errorMessage: text("error_message"),
    evidence: jsonb("evidence").$type<unknown>(),
    citations: jsonb("citations").$type<unknown>(),
    retrieval: jsonb("retrieval").$type<unknown>(),
    localMemoryWorker: jsonb("local_memory_worker").$type<unknown>(),
    localMemoryWorkerConfig: jsonb(
      "local_memory_worker_config"
    ).$type<unknown>(),
    response: jsonb("response").$type<unknown>(),
    status: memoryQuestionStatus("status").notNull().default("pending"),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true
    }),
    processingLeaseUntil: timestamp("processing_lease_until", {
      withTimezone: true
    }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorMessage: text("last_error_message"),
    createdAt: now(),
    updatedAt: updatedNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true })
  },
  (table) => [
    index("memory_questions_personal_created_idx")
      .on(table.ownerUserId, table.createdAt.desc(), table.id.desc())
      .where(sql`${table.visibility} = 'personal'`),
    index("memory_questions_personal_scope_idx")
      .on(
        table.ownerUserId,
        table.searchDomain,
        table.workspaceId,
        table.sessionId,
        table.createdAt.desc(),
        table.id.desc()
      )
      .where(sql`${table.visibility} = 'personal'`),
    index("memory_questions_personal_pending_claim_idx")
      .on(
        table.ownerUserId,
        table.processingLeaseUntil,
        table.createdAt,
        table.id
      )
      .where(
        sql`${table.visibility} = 'personal' and ${table.status} = 'pending'`
      ),
    check(
      "memory_questions_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    ),
    check(
      "memory_questions_origin_check",
      sql`${table.origin} in ('explorer', 'mcp_memory_answer')`
    ),
    check(
      "memory_questions_retrieval_scope_check",
      sql`${table.retrievalScope} in ('personal')`
    ),
    check(
      "memory_questions_search_domain_check",
      sql`(${table.searchDomain} = 'global')
        or (${table.searchDomain} = 'project' and ${table.workspaceId} is not null)
        or (${table.searchDomain} = 'session' and ${table.sessionId} is not null)`
    ),
    check(
      "memory_questions_status_check",
      sql`(${table.status} = 'answered' and ${table.answerMarkdown} is not null and ${table.errorMessage} is null)
        or (${table.status} = 'error' and ${table.errorMessage} is not null)
        or ${table.status} = 'pending'`
    )
  ]
);

export const workflowTokenUsage = pgTable(
  "workflow_token_usage",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "cascade"
    }),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    workflowType: text("workflow_type").notNull(),
    workflowId: text("workflow_id"),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    turnId: uuid("turn_id").references(() => turns.id, {
      onDelete: "set null"
    }),
    conversationItemId: uuid("conversation_item_id").references(
      () => conversationItems.id,
      { onDelete: "set null" }
    ),
    sourceRuntime: sourceRuntime("source_runtime"),
    sourceKind: text("source_kind"),
    sourceAdapterVersion: text("source_adapter_version"),
    model: text("model"),
    modelContextWindow: integer("model_context_window"),
    inputTokens: integer("input_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningOutputTokens: integer("reasoning_output_tokens"),
    totalTokens: integer("total_tokens"),
    usageScope: text("usage_scope").notNull().default("last"),
    usageSource: text("usage_source").notNull().default("app_server"),
    usageAccuracy: text("usage_accuracy")
      .notNull()
      .default("provider_reported"),
    usageKind: text("usage_kind").notNull().default("turn_delta"),
    connectorClient: text("connector_client"),
    tokenizerPackage: text("tokenizer_package"),
    tokenizerEncoding: text("tokenizer_encoding"),
    tokenizerModel: text("tokenizer_model"),
    tokenizerExactModelMatch: boolean("tokenizer_exact_model_match"),
    tokenizerHeuristicFallback: boolean("tokenizer_heuristic_fallback"),
    tokenizerVersion: text("tokenizer_version"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    idempotencyKey: text("idempotency_key"),
    sourceHash: text("source_hash"),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: now()
  },
  (table) => [
    uniqueIndex("workflow_token_usage_personal_idempotency_key_unique")
      .on(table.ownerUserId, table.idempotencyKey)
      .where(
        sql`${table.visibility} = 'personal' and ${table.idempotencyKey} is not null`
      ),
    index("workflow_token_usage_workflow_idx").on(
      table.workflowType,
      table.workflowId,
      table.observedAt
    ),
    index("workflow_token_usage_conversation_item_idx")
      .on(table.conversationItemId)
      .where(sql`${table.conversationItemId} is not null`),
    index("workflow_token_usage_session_turn_idx").on(
      table.sessionId,
      table.turnId,
      table.observedAt
    ),
    index("workflow_token_usage_attribution_idx").on(
      table.usageSource,
      table.usageAccuracy,
      table.usageKind,
      table.observedAt
    ),
    index("workflow_token_usage_connector_idx")
      .on(table.connectorClient, table.observedAt)
      .where(sql`${table.connectorClient} is not null`),
    check(
      "workflow_token_usage_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    )
  ]
);

export const workflowTokenUsageSourceReferences = pgTable(
  "workflow_token_usage_source_references",
  {
    workflowTokenUsageId: uuid("workflow_token_usage_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    createdAt: now()
  },
  (table) => [
    primaryKey({
      columns: [table.workflowTokenUsageId, table.sourceType, table.sourceId]
    }),
    foreignKey({
      columns: [table.workflowTokenUsageId],
      foreignColumns: [workflowTokenUsage.id],
      name: "workflow_token_usage_source_refs_usage_fk"
    }).onDelete("cascade"),
    index("workflow_token_usage_source_references_lookup_idx").on(
      table.sourceType,
      table.sourceId
    ),
    check(
      "workflow_token_usage_source_references_type_check",
      sql`${table.sourceType} in ('question', 'answer_job', 'lcm_node', 'message', 'tool_event', 'memory_event')`
    )
  ]
);

export const localWorkQueue = pgTable(
  "local_work_queue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    queueName: text("queue_name").notNull(),
    jobName: text("job_name").notNull(),
    jobKey: text("job_key"),
    data: jsonb("data")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(1),
    backoffMs: integer("backoff_ms"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lockToken: text("lock_token"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    uniqueIndex("local_work_queue_job_key_unique")
      .on(table.queueName, table.jobKey)
      .where(sql`${table.jobKey} is not null`),
    index("local_work_queue_claim_idx")
      .on(table.queueName, table.availableAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    index("local_work_queue_active_lease_idx")
      .on(table.lockedUntil)
      .where(sql`${table.status} = 'active'`),
    check(
      "local_work_queue_status_check",
      sql`${table.status} in ('pending', 'active', 'completed', 'failed')`
    ),
    check(
      "local_work_queue_max_attempts_check",
      sql`${table.maxAttempts} >= 1`
    ),
    check(
      "local_work_queue_attempt_count_check",
      sql`${table.attemptCount} >= 0`
    )
  ]
);

export const localMemoryAgentSettings = pgTable(
  "local_memory_agent_settings",
  {
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    flowKey: text("flow_key").notNull(),
    provider: text("provider").notNull().default("codex"),
    model: text("model").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserId, table.flowKey] }),
    index("local_memory_agent_settings_owner_idx").on(
      table.ownerUserId,
      table.updatedAt.desc()
    ),
    check(
      "local_memory_agent_settings_flow_key_check",
      sql`${table.flowKey} in ('mcp_memory_answer', 'lcm_summary')`
    ),
    check(
      "local_memory_agent_settings_provider_check",
      sql`${table.provider} = 'codex'`
    ),
    check("local_memory_agent_settings_model_check", sql`${table.model} <> ''`),
    check(
      "local_memory_agent_settings_reasoning_effort_check",
      sql`${table.reasoningEffort} <> ''`
    ),
    check(
      "local_memory_agent_settings_timeout_ms_check",
      sql`${table.timeoutMs} between 1000 and 600000`
    ),
    check(
      "local_memory_agent_settings_max_attempts_check",
      sql`${table.maxAttempts} between 1 and 25`
    )
  ]
);

export const projectionPolicyRules = pgTable(
  "projection_policy_rules",
  {
    sourceKind: text("source_kind").notNull().default("codex"),
    sourceAdapterVersion: text("source_adapter_version")
      .notNull()
      .default("codex-transcript-v1"),
    transcriptType: text("transcript_type").notNull(),
    description: text("description"),
    projectToUi: boolean("project_to_ui").notNull().default(false),
    createMessage: boolean("create_message").notNull().default(false),
    createToolEvent: boolean("create_tool_event").notNull().default(false),
    createMemoryEvent: boolean("create_memory_event").notNull().default(false),
    includeInEmbedding: boolean("include_in_embedding")
      .notNull()
      .default(false),
    includeInLcm: boolean("include_in_lcm").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    primaryKey({
      columns: [
        table.sourceKind,
        table.sourceAdapterVersion,
        table.transcriptType
      ]
    }),
    index("projection_policy_rules_lookup_idx").on(
      table.sourceKind,
      table.sourceAdapterVersion,
      table.transcriptType,
      table.enabled
    ),
    check(
      "projection_policy_rules_message_ui_check",
      sql`${table.createMessage} = false or ${table.projectToUi} = true`
    ),
    check(
      "projection_policy_rules_tool_ui_check",
      sql`${table.createToolEvent} = false or ${table.projectToUi} = true`
    ),
    check(
      "projection_policy_rules_embedding_memory_check",
      sql`${table.includeInEmbedding} = false or ${table.createMemoryEvent} = true`
    ),
    check(
      "projection_policy_rules_lcm_memory_check",
      sql`${table.includeInLcm} = false or ${table.createMemoryEvent} = true`
    )
  ]
);

export const projectionPolicyState = pgTable(
  "projection_policy_state",
  {
    id: integer("id").primaryKey().default(1),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    updatedAt: updatedNow()
  },
  (table) => [
    check("projection_policy_state_singleton_check", sql`${table.id} = 1`),
    check("projection_policy_state_revision_check", sql`${table.revision} >= 1`)
  ]
);
