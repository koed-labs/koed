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
import type {
  CollaborationApprovalReview,
  EncryptedPayloadEnvelope,
  ManagedConversationTargetReadinessEvidence
} from "@koed/shared";

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
  "transcript",
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
export const historicalImportState = pgEnum("historical_import_state", [
  "discovered",
  "eligible",
  "queued",
  "importing",
  "paused",
  "skipped",
  "completed",
  "failed"
]);
export const conversationSourceArtifactLifecycle = pgEnum(
  "conversation_source_artifact_lifecycle",
  [
    "active",
    "finalizing",
    "finalized",
    "failed",
    "conflicted",
    "deletion_pending",
    "deleted"
  ]
);
export const conversationSourceConsumerKind = pgEnum(
  "conversation_source_consumer_kind",
  [
    "canonical_live",
    "canonical_historical",
    "remote_upload",
    "remote_processing",
    "projection"
  ]
);
export const conversationSourceReplicaRole = pgEnum(
  "conversation_source_replica_role",
  ["origin_local", "hosted_personal", "peer_personal"]
);
export const conversationSourceOriginKeyStatus = pgEnum(
  "conversation_source_origin_key_status",
  ["active", "lost", "revoked"]
);
export const personalSourceReplicationMode = pgEnum(
  "personal_source_replication_mode",
  ["hosted_personal", "peer_personal"]
);
export const conversationSourceReplicationOutboxState = pgEnum(
  "conversation_source_replication_outbox_state",
  ["pending", "in_flight", "succeeded", "failed", "quarantined"]
);
export const memoryQuestionStatus = pgEnum("memory_question_status", [
  "answered",
  "error"
]);
export const curatedMemoryProposalStatus = pgEnum(
  "curated_memory_proposal_status",
  ["pending", "stored", "merged", "superseded", "conflicted", "skipped"]
);
export const curatedMemoryProposalOperation = pgEnum(
  "curated_memory_proposal_operation",
  ["store", "merge", "supersede", "conflict"]
);
export const curatedMemoryAssertionStatus = pgEnum(
  "curated_memory_assertion_status",
  ["current", "superseded", "conflicting", "suppressed"]
);
export const curatedMemorySensitivity = pgEnum("curated_memory_sensitivity", [
  "normal",
  "sensitive",
  "review_required"
]);
export const curatedMemorySourceType = pgEnum("curated_memory_source_type", [
  "conversation_item",
  "memory_event",
  "lcm_summary"
]);
export const curatedMemorySourceRole = pgEnum("curated_memory_source_role", [
  "primary_evidence",
  "supporting_evidence",
  "superseding_evidence",
  "conflicting_evidence",
  "derived_bundle",
  "derived_summary"
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
export const collaborationScope = pgEnum("collaboration_scope", [
  "personal",
  "team"
]);
export const collaborationThreadKind = pgEnum("collaboration_thread_kind", [
  "notes_to_self",
  "personal_channel",
  "workspace_channel",
  "dm",
  "group_dm",
  "shared_session_discussion"
]);
export const collaborationSenderKind = pgEnum("collaboration_sender_kind", [
  "user",
  "system",
  "imported"
]);
export const collaborationLifecycle = pgEnum("collaboration_lifecycle", [
  "active",
  "archived",
  "tombstoned",
  "purge_pending",
  "purged"
]);
export const collaborationEventFamily = pgEnum("collaboration_event_family", [
  "team_lifecycle",
  "team_membership_access",
  "team_presence_changed",
  "workspace_lifecycle_access",
  "thread_lifecycle",
  "message_created",
  "receipt_state_updated",
  "share_grant_lifecycle",
  "representation_changed",
  "memory_event_available",
  "lcm_leaf_available",
  "lcm_rollup_available",
  "shared_session_discussion_activity",
  "personal_memory_changed",
  "managed_conversation_changed",
  "access_revoked"
]);
export const collaborationStreamState = pgEnum("collaboration_stream_state", [
  "active",
  "requires_snapshot",
  "revoked",
  "expired"
]);
export const teamLifecycle = pgEnum("team_lifecycle", [
  "active",
  "suspended",
  "deletion_requested",
  "purge_pending",
  "purged"
]);
export const workspaceLifecycle = pgEnum("workspace_lifecycle", [
  "active",
  "archived",
  "purge_pending",
  "purged"
]);
export const inviteLifecycle = pgEnum("invite_lifecycle", [
  "pending",
  "accepted",
  "revoked",
  "expired"
]);
export const sharedMemoryRepresentation = pgEnum(
  "shared_memory_representation",
  ["memory_events", "lcm_leaves", "lcm_rollups"]
);
export const sharedMemoryConsentMode = pgEnum("shared_memory_consent_mode", [
  "snapshot",
  "continuous"
]);
export const sharedMemoryConsentState = pgEnum("shared_memory_consent_state", [
  "pending",
  "active",
  "paused",
  "revoked",
  "expired"
]);
export const memoryRepresentationPolicyScope = pgEnum(
  "memory_representation_policy_scope",
  ["source_owner", "team", "workspace"]
);
export const memoryRepresentationState = pgEnum("memory_representation_state", [
  "pending",
  "available",
  "stale",
  "invalidated",
  "purge_pending",
  "purged"
]);
export const memoryReplicaLifecycle = pgEnum("memory_replica_lifecycle", [
  "active",
  "stale",
  "revoked",
  "tombstoned",
  "purge_pending",
  "purged"
]);
export const shareGrantLifecycle = pgEnum("share_grant_lifecycle", [
  "active",
  "unavailable",
  "revoked",
  "tombstoned",
  "purge_pending",
  "purged"
]);
export const retentionPolicyScope = pgEnum("retention_policy_scope", [
  "team",
  "workspace",
  "share_grant",
  "thread",
  "owner_private_replica"
]);
export const retentionTrigger = pgEnum("retention_trigger", [
  "share_revoked",
  "team_deletion",
  "workspace_policy",
  "user_erasure",
  "source_purge",
  "policy_migration"
]);
export const retentionPolicyShorteningState = pgEnum(
  "retention_policy_shortening_state",
  ["pending", "confirmed", "invalidated"]
);
export const legalHoldScope = pgEnum("legal_hold_scope", [
  "team",
  "workspace",
  "thread",
  "grant_representation",
  "team_message_range",
  "owner_private_replica"
]);
export const purgeTargetKind = pgEnum("purge_target_kind", [
  "team",
  "workspace",
  "thread",
  "message",
  "share_grant",
  "grant_representation",
  "owner_private_replica"
]);
export const purgeJobState = pgEnum("purge_job_state", [
  "pending",
  "canceled",
  "blocked",
  "running",
  "retry_wait",
  "failed",
  "verified"
]);
export const legalHoldState = pgEnum("legal_hold_state", [
  "active",
  "release_pending",
  "released"
]);
export const purgeAttemptState = pgEnum("purge_attempt_state", [
  "running",
  "retryable_failure",
  "terminal_failure",
  "completed"
]);
export const purgeArtifactKind = pgEnum("purge_artifact_kind", [
  "database_row",
  "encrypted_payload",
  "wrapped_key",
  "search_index",
  "vector",
  "outbox_replay",
  "backup_copy"
]);
export const purgeEvidenceState = pgEnum("purge_evidence_state", [
  "pending",
  "cleaned",
  "scheduled_expiry",
  "verified",
  "not_applicable",
  "failed"
]);
export const highRiskConfirmationState = pgEnum(
  "high_risk_confirmation_state",
  ["pending", "approved", "denied", "expired", "revoked"]
);
export const actionApprovalTier = pgEnum("action_approval_tier", [
  "direct",
  "native_review",
  "step_up"
]);
export const highRiskActionGrantState = pgEnum("high_risk_action_grant_state", [
  "active",
  "consumed",
  "expired",
  "revoked"
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
export const personalDeviceGroupState = pgEnum("personal_device_group_state", [
  "active",
  "equivocation_freeze",
  "quarantine"
]);
export const personalDeviceMemberStatus = pgEnum(
  "personal_device_member_status",
  ["active", "revoked"]
);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  avatarReference: text("avatar_reference"),
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
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    creationIdempotencyKeyHash: text("creation_idempotency_key_hash"),
    creationRequestHash: text("creation_request_hash"),
    version: integer("version").notNull().default(1),
    lifecycle: teamLifecycle("lifecycle").notNull().default("active"),
    entitlementStatus: teamEntitlementStatus("entitlement_status")
      .notNull()
      .default("active"),
    entitlementReason: text("entitlement_reason"),
    entitlementUpdatedAt: timestamp("entitlement_updated_at", {
      withTimezone: true
    }),
    createdAt: now(),
    updatedAt: updatedNow(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    deletionRequestedAt: timestamp("deletion_requested_at", {
      withTimezone: true
    }),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    purgeCompletedAt: timestamp("purge_completed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true })
  },
  (table) => [
    unique("teams_id_lifecycle_unique").on(table.id, table.lifecycle),
    uniqueIndex("teams_creator_idempotency_unique")
      .on(table.createdByUserId, table.creationIdempotencyKeyHash)
      .where(sql`${table.creationIdempotencyKeyHash} is not null`),
    index("teams_active_idx")
      .on(table.createdAt.desc())
      .where(sql`${table.lifecycle} = 'active'`),
    index("teams_lifecycle_idx").on(table.lifecycle, table.updatedAt.desc()),
    check("teams_version_check", sql`${table.version} > 0`),
    check(
      "teams_creation_idempotency_shape_check",
      sql`(
        ${table.createdByUserId} is null
        and ${table.creationIdempotencyKeyHash} is null
        and ${table.creationRequestHash} is null
      ) or (
        ${table.createdByUserId} is not null
        and length(${table.creationIdempotencyKeyHash}) = 64
        and length(${table.creationRequestHash}) = 64
      )`
    ),
    check(
      "teams_name_check",
      sql`length(trim(${table.name})) > 0
        and char_length(${table.name}) <= 80
        and ${table.name} = normalize(${table.name}, NFC)`
    ),
    check("teams_no_archive_check", sql`${table.archivedAt} is null`),
    check(
      "teams_lifecycle_shape_check",
      sql`(
        ${table.lifecycle} = 'active'
        and ${table.suspendedAt} is null
        and ${table.deletionRequestedAt} is null
        and ${table.tombstonedAt} is null
        and ${table.purgeCompletedAt} is null
      ) or (
        ${table.lifecycle} = 'suspended'
        and ${table.suspendedAt} is not null
        and ${table.deletionRequestedAt} is null
        and ${table.tombstonedAt} is null
        and ${table.purgeCompletedAt} is null
      ) or (
        ${table.lifecycle} in ('deletion_requested', 'purge_pending')
        and ${table.deletionRequestedAt} is not null
        and ${table.tombstonedAt} is not null
        and ${table.purgeCompletedAt} is null
      ) or (
        ${table.lifecycle} = 'purged'
        and ${table.deletionRequestedAt} is not null
        and ${table.tombstonedAt} is not null
        and ${table.purgeCompletedAt} is not null
      )`
    )
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
    version: integer("version").notNull().default(1),
    presenceMode: text("presence_mode").notNull().default("auto"),
    manualPresenceStatus: text("manual_presence_status")
      .notNull()
      .default("available"),
    presenceVersion: integer("presence_version").notNull().default(1),
    lastHumanActivityAt: timestamp("last_human_activity_at", {
      withTimezone: true
    }),
    createdAt: now(),
    updatedAt: updatedNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason")
  },
  (table) => [
    unique("team_memberships_team_user_unique").on(table.teamId, table.userId),
    index("team_memberships_user_idx").on(table.userId, table.status),
    index("team_memberships_team_idx").on(table.teamId, table.role),
    check("team_memberships_version_check", sql`${table.version} > 0`),
    check(
      "team_memberships_presence_mode_check",
      sql`${table.presenceMode} in ('auto', 'manual')`
    ),
    check(
      "team_memberships_manual_presence_status_check",
      sql`${table.manualPresenceStatus} in ('available', 'do_not_disturb', 'out_of_office')`
    ),
    check(
      "team_memberships_presence_version_check",
      sql`${table.presenceVersion} > 0`
    )
  ]
);

export const teamBillingSeatStates = pgTable(
  "team_billing_seat_states",
  {
    teamId: uuid("team_id")
      .primaryKey()
      .references(() => teams.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
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
    ),
    check("team_billing_seat_states_version_check", sql`${table.version} > 0`)
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
    descriptionMarker: text("description_marker"),
    version: integer("version").notNull().default(1),
    lifecycle: workspaceLifecycle("lifecycle").notNull().default("active"),
    createdAt: now(),
    updatedAt: updatedNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    retentionPolicyId: uuid("retention_policy_id"),
    retentionPolicyVersion: integer("retention_policy_version"),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    purgeCompletedAt: timestamp("purge_completed_at", { withTimezone: true })
  },
  (table) => [
    unique("team_workspaces_id_team_unique").on(table.id, table.teamId),
    index("team_workspaces_team_idx")
      .on(table.teamId, table.createdAt.desc())
      .where(sql`${table.lifecycle} = 'active'`),
    index("team_workspaces_lifecycle_idx").on(
      table.teamId,
      table.lifecycle,
      table.updatedAt.desc()
    ),
    check("team_workspaces_version_check", sql`${table.version} > 0`),
    check(
      "team_workspaces_name_check",
      sql`length(trim(${table.name})) > 0
        and char_length(${table.name}) <= 80
        and ${table.name} = normalize(${table.name}, NFC)`
    ),
    check(
      "team_workspaces_description_marker_check",
      sql`${table.descriptionMarker} is null
        or ${table.descriptionMarker} = '[koed encrypted team workspace description]'`
    ),
    check(
      "team_workspaces_retention_policy_check",
      sql`(${table.retentionPolicyId} is null and ${table.retentionPolicyVersion} is null)
        or (${table.retentionPolicyId} is not null and ${table.retentionPolicyVersion} > 0)`
    ),
    check(
      "team_workspaces_lifecycle_shape_check",
      sql`(
        ${table.lifecycle} = 'active'
        and ${table.archivedAt} is null
        and ${table.purgeCompletedAt} is null
      ) or (
        ${table.lifecycle} = 'archived'
        and ${table.archivedAt} is not null
        and ${table.purgeCompletedAt} is null
      ) or (
        ${table.lifecycle} = 'purge_pending'
        and ${table.purgeCompletedAt} is null
      ) or (
        ${table.lifecycle} = 'purged'
        and ${table.purgeCompletedAt} is not null
      )`
    )
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
    canShareOwnedMemory: boolean("can_share_owned_memory")
      .notNull()
      .default(false),
    version: integer("version").notNull().default(1),
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
    ),
    check(
      "team_workspace_access_grants_version_check",
      sql`${table.version} > 0`
    ),
    check(
      "team_workspace_access_grants_share_owned_check",
      sql`not ${table.canShareOwnedMemory} or ${table.access} = 'write'`
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
    defaultTeamWorkspaceId: uuid("default_team_workspace_id"),
    defaultWorkspaceAccess: teamWorkspaceAccess("default_workspace_access")
      .notNull()
      .default("write"),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email"),
    backendOriginHash: text("backend_origin_hash"),
    role: teamRole("role").notNull(),
    version: integer("version").notNull().default(1),
    lifecycle: inviteLifecycle("lifecycle").notNull().default("pending"),
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
    foreignKey({
      columns: [table.defaultTeamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "team_invites_default_workspace_team_fk"
    }).onDelete("restrict"),
    index("team_invites_team_email_idx").on(table.teamId, table.email),
    index("team_invites_team_lifecycle_idx").on(
      table.teamId,
      table.lifecycle,
      table.expiresAt
    ),
    index("team_invites_active_token_idx")
      .on(table.tokenHash)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    check(
      "team_invites_token_hash_length_check",
      sql`length(${table.tokenHash}) >= 32`
    ),
    check("team_invites_version_check", sql`${table.version} > 0`),
    check(
      "team_invites_binding_check",
      sql`${table.defaultTeamWorkspaceId} is not null
        and ${table.normalizedEmail} is not null
        and length(trim(${table.normalizedEmail})) > 0
        and ${table.normalizedEmail} = lower(trim(${table.email}))
        and ${table.backendOriginHash} is not null
        and length(${table.backendOriginHash}) = 64
        and ${table.defaultWorkspaceAccess} in ('read', 'write')`
    ),
    check(
      "team_invites_lifecycle_shape_check",
      sql`(
        ${table.lifecycle} = 'pending'
        and ${table.acceptedAt} is null
        and ${table.revokedAt} is null
      ) or (
        ${table.lifecycle} = 'accepted'
        and ${table.acceptedAt} is not null
        and ${table.revokedAt} is null
      ) or (
        ${table.lifecycle} = 'revoked'
        and ${table.acceptedAt} is null
        and ${table.revokedAt} is not null
      ) or (
        ${table.lifecycle} = 'expired'
        and ${table.acceptedAt} is null
        and ${table.revokedAt} is null
      )`
    )
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    logicalSessionId: uuid("logical_session_id")
      .notNull()
      .default(sql`gen_random_uuid()`),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    externalSessionId: text("external_session_id"),
    sourceRuntime: sourceRuntime("source_runtime").notNull(),
    captureMethod: captureMethod("capture_method").notNull(),
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
    sourceFingerprint: text("source_fingerprint"),
    capturedProject: jsonb("captured_project")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    importObservedAt: timestamp("import_observed_at", { withTimezone: true }),
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
    unique("sessions_logical_identity_unique").on(
      table.ownerUserId,
      table.logicalSessionId
    ),
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

export const conversationSourceArtifacts = pgTable(
  "conversation_source_artifacts",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    logicalSourceId: uuid("logical_source_id").notNull(),
    sourceGenerationId: uuid("source_generation_id").notNull(),
    replicaRole: conversationSourceReplicaRole("replica_role").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceRuntime: sourceRuntime("source_runtime").notNull(),
    externalSessionId: text("external_session_id").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    artifactFormat: text("artifact_format").notNull(),
    artifactFormatVersion: integer("artifact_format_version").notNull(),
    sourceAdapterVersion: text("source_adapter_version").notNull(),
    lifecycle: conversationSourceArtifactLifecycle("lifecycle")
      .notNull()
      .default("active"),
    journalStartOffset: bigint("journal_start_offset", { mode: "number" })
      .notNull()
      .default(0),
    journalStartLine: integer("journal_start_line").notNull().default(0),
    liveStartOffset: bigint("live_start_offset", { mode: "number" })
      .notNull()
      .default(0),
    liveStartLine: integer("live_start_line").notNull().default(0),
    providerCursorOffset: bigint("provider_cursor_offset", { mode: "number" })
      .notNull()
      .default(0),
    providerCursorLine: integer("provider_cursor_line").notNull().default(0),
    currentSourceLength: bigint("current_source_length", { mode: "number" })
      .notNull()
      .default(0),
    currentJournalSequence: integer("current_journal_sequence")
      .notNull()
      .default(-1),
    sourceCreatedAt: timestamp("source_created_at", {
      withTimezone: true
    }).notNull(),
    sourceModifiedAt: timestamp("source_modified_at", { withTimezone: true }),
    storageProvider: text("storage_provider").notNull(),
    storagePrefix: text("storage_prefix").notNull(),
    closureHash: text("closure_hash"),
    closureManifest: jsonb("closure_manifest").$type<Record<string, unknown>>(),
    closureSignature: text("closure_signature"),
    originDeploymentId: text("origin_deployment_id").notNull(),
    originDeviceId: text("origin_device_id").notNull(),
    originKeyId: text("origin_key_id").notNull(),
    originPublicKey: text("origin_public_key").notNull(),
    originKeyStatus: conversationSourceOriginKeyStatus("origin_key_status")
      .notNull()
      .default("active"),
    priorGenerationClosure: jsonb("prior_generation_closure").$type<
      Record<string, unknown>
    >(),
    redactedSourceLabel: text("redacted_source_label").notNull(),
    createdAt: now(),
    updatedAt: updatedNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("conversation_source_artifacts_generation_unique").on(
      table.ownerUserId,
      table.logicalSourceId,
      table.sourceGenerationId
    ),
    uniqueIndex("conversation_source_artifacts_provider_identity_unique").on(
      table.ownerUserId,
      table.sourceKind,
      table.externalSessionId,
      table.sourceGenerationId
    ),
    unique("conversation_source_artifacts_id_owner_unique").on(
      table.id,
      table.ownerUserId
    ),
    index("conversation_source_artifacts_session_idx").on(
      table.ownerUserId,
      table.sessionId,
      table.updatedAt.desc()
    ),
    check(
      "conversation_source_artifacts_fingerprint_check",
      sql`${table.sourceFingerprint} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "conversation_source_artifacts_cursor_check",
      sql`${table.journalStartOffset} >= 0
        and ${table.journalStartLine} >= 0
        and ${table.liveStartOffset} >= ${table.journalStartOffset}
        and ${table.liveStartLine} >= ${table.journalStartLine}
        and ${table.providerCursorOffset} >= ${table.journalStartOffset}
        and ${table.providerCursorLine} >= ${table.journalStartLine}
        and ${table.liveStartOffset} <= ${table.currentSourceLength}
        and ${table.currentSourceLength} >= ${table.providerCursorOffset}
        and ${table.currentJournalSequence} >= -1`
    ),
    check(
      "conversation_source_artifacts_format_check",
      sql`${table.artifactFormatVersion} > 0
        and length(trim(${table.artifactFormat})) > 0
        and length(trim(${table.sourceAdapterVersion})) > 0
        and length(trim(${table.storageProvider})) > 0
        and length(trim(${table.storagePrefix})) > 0`
    ),
    check(
      "conversation_source_artifacts_closure_check",
      sql`(
          ${table.lifecycle} in ('active','finalizing','failed','conflicted','deletion_pending','deleted')
          and ${table.closureHash} is null
          and ${table.closureManifest} is null
          and ${table.closureSignature} is null
          and ${table.finalizedAt} is null
        ) or (
          ${table.lifecycle} = 'finalized'
          and ${table.closureHash} ~ '^[0-9a-f]{64}$'
          and jsonb_typeof(${table.closureManifest}) = 'object'
          and ${table.closureManifest} <> '{}'::jsonb
          and ${table.closureSignature} ~ '^[A-Za-z0-9_-]{86}$'
          and ${table.finalizedAt} is not null
        )`
    ),
    check(
      "conversation_source_artifacts_origin_identity_check",
      sql`length(trim(${table.originDeploymentId})) between 1 and 500
        and length(trim(${table.originDeviceId})) between 1 and 500
        and ${table.originKeyId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
        and ${table.originPublicKey} ~ '^[A-Za-z0-9_-]{43}$'`
    ),
    check(
      "conversation_source_artifacts_prior_closure_check",
      sql`${table.priorGenerationClosure} is null
        or jsonb_typeof(${table.priorGenerationClosure}) = 'object'`
    )
  ]
);

export const conversationSourceSegments = pgTable(
  "conversation_source_segments",
  {
    id: id(),
    artifactId: uuid("artifact_id").notNull(),
    segmentIndex: integer("segment_index").notNull(),
    sourceStartOffset: bigint("source_start_offset", {
      mode: "number"
    }).notNull(),
    sourceEndOffset: bigint("source_end_offset", { mode: "number" }).notNull(),
    sourceStartLine: integer("source_start_line").notNull(),
    sourceEndLine: integer("source_end_line").notNull(),
    plaintextDigest: text("plaintext_digest").notNull(),
    ciphertextDigest: text("ciphertext_digest"),
    plaintextSize: bigint("plaintext_size", { mode: "number" }).notNull(),
    storedSize: bigint("stored_size", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    storageProvider: text("storage_provider").notNull(),
    encryptionEnvelope: jsonb("encryption_envelope").$type<
      Record<string, unknown>
    >(),
    signedManifest: jsonb("signed_manifest")
      .$type<Record<string, unknown>>()
      .notNull(),
    originSignature: text("origin_signature").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    previousContentDigest: text("previous_content_digest"),
    contentDigest: text("content_digest").notNull(),
    createdAt: now(),
    sealedAt: timestamp("sealed_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex("conversation_source_segments_index_unique").on(
      table.artifactId,
      table.segmentIndex
    ),
    unique("conversation_source_segments_id_artifact_unique").on(
      table.id,
      table.artifactId
    ),
    uniqueIndex("conversation_source_segments_range_unique").on(
      table.artifactId,
      table.sourceStartOffset,
      table.sourceEndOffset
    ),
    index("conversation_source_segments_cursor_idx").on(
      table.artifactId,
      table.sourceStartOffset,
      table.sourceEndOffset
    ),
    check(
      "conversation_source_segments_range_check",
      sql`${table.segmentIndex} >= 0
        and ${table.sourceStartOffset} >= 0
        and ${table.sourceEndOffset} > ${table.sourceStartOffset}
        and ${table.sourceStartLine} >= 0
        and ${table.sourceEndLine} > ${table.sourceStartLine}
        and ${table.plaintextSize} =
          ${table.sourceEndOffset} - ${table.sourceStartOffset}
        and ${table.storedSize} > 0`
    ),
    check(
      "conversation_source_segments_digest_check",
      sql`${table.plaintextDigest} ~ '^[0-9a-f]{64}$'
        and (${table.ciphertextDigest} is null or ${table.ciphertextDigest} ~ '^[0-9a-f]{64}$')
        and ${table.manifestDigest} ~ '^[0-9a-f]{64}$'
        and (${table.previousContentDigest} is null or ${table.previousContentDigest} ~ '^[0-9a-f]{64}$')
        and ${table.contentDigest} ~ '^[0-9a-f]{64}$'
        and ${table.originSignature} ~ '^[A-Za-z0-9_-]{86}$'`
    ),
    check(
      "conversation_source_segments_manifest_check",
      sql`jsonb_typeof(${table.signedManifest}) = 'object'
        and ${table.signedManifest} <> '{}'::jsonb`
    )
  ]
);

export const personalSourceReplicationPolicies = pgTable(
  "personal_source_replication_policies",
  {
    ownerUserId: uuid("owner_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
    targetUpstreamId: text("target_upstream_id"),
    mode: personalSourceReplicationMode("mode")
      .notNull()
      .default("hosted_personal"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    index("personal_source_replication_policies_enabled_idx")
      .on(table.targetUpstreamId, table.ownerUserId)
      .where(sql`${table.enabled} = true`),
    check(
      "personal_source_replication_policies_shape_check",
      sql`(${table.enabled} = true
          and length(trim(${table.targetUpstreamId})) between 1 and 160
          and ${table.effectiveFrom} is not null)
        or (${table.enabled} = false
          and ${table.targetUpstreamId} is null
          and ${table.effectiveFrom} is null)`
    )
  ]
);

export const conversationSourceReplicationOutbox = pgTable(
  "conversation_source_replication_outbox",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").notNull(),
    operationKind: text("operation_kind").notNull().default("segment"),
    segmentId: uuid("segment_id"),
    targetUpstreamId: text("target_upstream_id").notNull(),
    mode: personalSourceReplicationMode("mode").notNull(),
    authorizationBasis: text("authorization_basis")
      .notNull()
      .default("personal_sync_policy"),
    state: conversationSourceReplicationOutboxState("state")
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true
    })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: now(),
    updatedAt: updatedNow(),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true })
  },
  (table) => [
    foreignKey({
      columns: [table.artifactId, table.ownerUserId],
      foreignColumns: [
        conversationSourceArtifacts.id,
        conversationSourceArtifacts.ownerUserId
      ],
      name: "conversation_source_replication_outbox_artifact_owner_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.segmentId, table.artifactId],
      foreignColumns: [
        conversationSourceSegments.id,
        conversationSourceSegments.artifactId
      ],
      name: "conversation_source_replication_outbox_segment_artifact_fk"
    }).onDelete("cascade"),
    uniqueIndex("conversation_source_replication_outbox_segment_target_unique")
      .on(table.ownerUserId, table.segmentId, table.targetUpstreamId)
      .where(sql`${table.operationKind} = 'segment'`),
    uniqueIndex(
      "conversation_source_replication_outbox_registration_target_unique"
    )
      .on(table.ownerUserId, table.artifactId, table.targetUpstreamId)
      .where(sql`${table.operationKind} = 'registration'`),
    uniqueIndex("conversation_source_replication_outbox_closure_target_unique")
      .on(table.ownerUserId, table.artifactId, table.targetUpstreamId)
      .where(sql`${table.operationKind} = 'closure'`),
    index("conversation_source_replication_outbox_claim_idx").on(
      table.ownerUserId,
      table.state,
      table.nextAttemptAt,
      table.createdAt
    ),
    check(
      "conversation_source_replication_outbox_operation_check",
      sql`(${table.operationKind} = 'segment' and ${table.segmentId} is not null)
        or (${table.operationKind} = 'registration' and ${table.segmentId} is null)
        or (${table.operationKind} = 'closure' and ${table.segmentId} is null)`
    ),
    check(
      "conversation_source_replication_outbox_authorization_basis_check",
      sql`${table.authorizationBasis} in ('personal_sync_policy', 'execution_transfer')`
    ),
    check(
      "conversation_source_replication_outbox_attempts_check",
      sql`${table.maxAttempts} between 1 and 100
        and ${table.attempts} between 0 and ${table.maxAttempts}`
    ),
    check(
      "conversation_source_replication_outbox_lease_check",
      sql`(${table.state} = 'in_flight'
          and ${table.leaseOwner} is not null
          and ${table.leaseToken} is not null
          and ${table.leaseExpiresAt} is not null)
        or (${table.state} <> 'in_flight'
          and ${table.leaseOwner} is null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null)`
    ),
    check(
      "conversation_source_replication_outbox_terminal_check",
      sql`(${table.state} = 'succeeded' and ${table.succeededAt} is not null)
        or (${table.state} = 'quarantined' and ${table.quarantinedAt} is not null)
        or (${table.state} not in ('succeeded', 'quarantined')
          and ${table.succeededAt} is null
          and ${table.quarantinedAt} is null)`
    ),
    check(
      "conversation_source_replication_outbox_identifier_check",
      sql`length(trim(${table.targetUpstreamId})) between 1 and 160
        and (${table.leaseOwner} is null
          or length(trim(${table.leaseOwner})) between 1 and 200)
        and (${table.lastErrorCode} is null
          or ${table.lastErrorCode} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')`
    )
  ]
);

export const conversationSourceConsumerCursors = pgTable(
  "conversation_source_consumer_cursors",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => conversationSourceArtifacts.id, {
        onDelete: "cascade"
      }),
    consumerKind: conversationSourceConsumerKind("consumer_kind").notNull(),
    segmentIndex: integer("segment_index").notNull().default(0),
    sourceOffset: bigint("source_offset", { mode: "number" })
      .notNull()
      .default(0),
    sourceLine: integer("source_line").notNull().default(0),
    lastVerifiedDigest: text("last_verified_digest"),
    parserState: jsonb("parser_state")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    failureCode: text("failure_code"),
    retryCount: integer("retry_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    updatedAt: updatedNow()
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.consumerKind] }),
    check(
      "conversation_source_consumer_cursors_position_check",
      sql`${table.segmentIndex} >= 0
        and ${table.sourceOffset} >= 0
        and ${table.sourceLine} >= 0
        and ${table.retryCount} between 0 and 1000`
    ),
    check(
      "conversation_source_consumer_cursors_digest_check",
      sql`${table.lastVerifiedDigest} is null
        or ${table.lastVerifiedDigest} ~ '^[0-9a-f]{64}$'`
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
    projectionAlgorithmVersion: text("projection_algorithm_version"),
    tokenCounter: text("token_counter"),
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
    index("memory_events_personal_project_expr_idx")
      .on(
        table.ownerUserId,
        sql`(${table.payload} ->> 'projectId')`,
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
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "cascade"
    }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    visibility: visibilityScope("visibility").notNull(),
    kind: text("kind").notNull(),
    depth: integer("depth").notNull().default(0),
    workClass: text("work_class").notNull().default("normal_embedding_lcm"),
    title: text("title"),
    summaryText: text("summary_text").notNull(),
    bodyText: text("body_text"),
    sourceRuntime: sourceRuntime("source_runtime"),
    captureMethod: captureMethod("capture_method").notNull(),
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
    index("memory_nodes_session_kind_idx")
      .on(table.ownerUserId, table.sessionId, table.kind, table.createdAt)
      .where(
        sql`${table.sessionId} is not null and ${table.invalidatedAt} is null`
      ),
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
      "memory_nodes_work_class_check",
      sql`${table.workClass} in ('live_capture_projection', 'normal_embedding_lcm', 'historical_import_backfill')`
    ),
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

export const curatedMemoryTopics = pgTable(
  "curated_memory_topics",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    uniqueIndex("curated_memory_topics_owner_normalized_unique").on(
      table.ownerUserId,
      table.normalizedTitle
    ),
    index("curated_memory_topics_owner_updated_idx")
      .on(table.ownerUserId, table.updatedAt.desc(), table.id.desc())
      .where(sql`${table.visibility} = 'personal'`),
    check(
      "curated_memory_topics_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    ),
    check(
      "curated_memory_topics_title_not_empty_check",
      sql`length(trim(${table.title})) > 0 and length(trim(${table.normalizedTitle})) > 0`
    )
  ]
);

export const curatedMemoryAssertions = pgTable(
  "curated_memory_assertions",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    topicId: uuid("topic_id").references(() => curatedMemoryTopics.id, {
      onDelete: "set null"
    }),
    assertionText: text("assertion_text").notNull(),
    normalizedAssertion: text("normalized_assertion").notNull(),
    status: curatedMemoryAssertionStatus("status").notNull().default("current"),
    sensitivity: curatedMemorySensitivity("sensitivity")
      .notNull()
      .default("normal"),
    confidence: integer("confidence").notNull().default(80),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    supersedesAssertionId: uuid("supersedes_assertion_id").references(
      (): AnyPgColumn => curatedMemoryAssertions.id,
      { onDelete: "set null" }
    ),
    supersededByAssertionId: uuid("superseded_by_assertion_id").references(
      (): AnyPgColumn => curatedMemoryAssertions.id,
      { onDelete: "set null" }
    ),
    conflictWithAssertionId: uuid("conflict_with_assertion_id").references(
      (): AnyPgColumn => curatedMemoryAssertions.id,
      { onDelete: "set null" }
    ),
    createdByModel: text("created_by_model"),
    createdByPromptVersion: text("created_by_prompt_version"),
    createdAt: now(),
    updatedAt: updatedNow(),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
    suppressedByUserId: uuid("suppressed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    suppressionReason: text("suppression_reason"),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    reconciliationStatus: text("reconciliation_status")
      .notNull()
      .default("pending")
  },
  (table) => [
    uniqueIndex("curated_memory_assertions_owner_current_unique")
      .on(table.ownerUserId, table.normalizedAssertion)
      .where(
        sql`${table.visibility} = 'personal'
          and ${table.status} = 'current'
          and ${table.suppressedAt} is null
          and ${table.expiresAt} is null`
      ),
    index("curated_memory_assertions_owner_topic_idx")
      .on(table.ownerUserId, table.topicId, table.updatedAt.desc())
      .where(sql`${table.visibility} = 'personal'`),
    index("curated_memory_assertions_owner_status_idx")
      .on(table.ownerUserId, table.status, table.updatedAt.desc())
      .where(sql`${table.visibility} = 'personal'`),
    index("curated_memory_assertions_reconcile_idx")
      .on(table.reconciliationStatus, table.lastReconciledAt, table.id)
      .where(
        sql`${table.status} = 'current' and ${table.suppressedAt} is null`
      ),
    check(
      "curated_memory_assertions_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    ),
    check(
      "curated_memory_assertions_text_not_empty_check",
      sql`length(trim(${table.assertionText})) > 0 and length(trim(${table.normalizedAssertion})) > 0`
    ),
    check(
      "curated_memory_assertions_confidence_check",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 100`
    )
  ]
);

export const curatedMemorySources = pgTable(
  "curated_memory_sources",
  {
    id: id(),
    assertionId: uuid("assertion_id")
      .notNull()
      .references(() => curatedMemoryAssertions.id, { onDelete: "cascade" }),
    sourceType: curatedMemorySourceType("source_type").notNull(),
    sourceRole: curatedMemorySourceRole("source_role").notNull(),
    conversationItemId: uuid("conversation_item_id").references(
      () => conversationItems.id,
      { onDelete: "cascade" }
    ),
    memoryEventId: uuid("memory_event_id").references(() => memoryEvents.id, {
      onDelete: "cascade"
    }),
    lcmNodeId: uuid("lcm_node_id").references(() => memoryNodes.id, {
      onDelete: "cascade"
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: now()
  },
  (table) => [
    uniqueIndex("curated_memory_sources_unique").on(
      table.assertionId,
      table.sourceType,
      table.sourceRole,
      sql`coalesce(${table.conversationItemId}::text, '')`,
      sql`coalesce(${table.memoryEventId}::text, '')`,
      sql`coalesce(${table.lcmNodeId}::text, '')`
    ),
    index("curated_memory_sources_conversation_item_idx").on(
      table.conversationItemId,
      table.assertionId
    ),
    index("curated_memory_sources_memory_event_idx").on(
      table.memoryEventId,
      table.assertionId
    ),
    index("curated_memory_sources_lcm_node_idx").on(
      table.lcmNodeId,
      table.assertionId
    ),
    check(
      "curated_memory_sources_one_source_check",
      sql`(${table.sourceType} = 'conversation_item' and ${table.conversationItemId} is not null and ${table.memoryEventId} is null and ${table.lcmNodeId} is null)
        or (${table.sourceType} = 'memory_event' and ${table.memoryEventId} is not null and ${table.conversationItemId} is null and ${table.lcmNodeId} is null)
        or (${table.sourceType} = 'lcm_summary' and ${table.lcmNodeId} is not null and ${table.conversationItemId} is null and ${table.memoryEventId} is null)`
    )
  ]
);

export const curatedMemoryProposals = pgTable(
  "curated_memory_proposals",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    visibility: visibilityScope("visibility").notNull().default("personal"),
    proposedClaim: text("proposed_claim").notNull(),
    proposedTopic: text("proposed_topic"),
    rationale: text("rationale"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    sensitivityHint: curatedMemorySensitivity("sensitivity_hint"),
    expiresAtHint: timestamp("expires_at_hint", { withTimezone: true }),
    evidenceConversationItemIds: uuid("evidence_conversation_item_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    evidenceMemoryEventIds: uuid("evidence_memory_event_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    operation: curatedMemoryProposalOperation("operation")
      .notNull()
      .default("store"),
    targetAssertionId: uuid("target_assertion_id").references(
      () => curatedMemoryAssertions.id,
      { onDelete: "set null" }
    ),
    status: curatedMemoryProposalStatus("status").notNull().default("pending"),
    decisionReason: text("decision_reason"),
    assertionId: uuid("assertion_id").references(
      () => curatedMemoryAssertions.id,
      { onDelete: "set null" }
    ),
    workerResult: jsonb("worker_result").$type<Record<string, unknown>>(),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true
    }),
    processingLeaseUntil: timestamp("processing_lease_until", {
      withTimezone: true
    }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorMessage: text("last_error_message"),
    createdByModel: text("created_by_model"),
    createdByPromptVersion: text("created_by_prompt_version"),
    createdAt: now(),
    updatedAt: updatedNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true })
  },
  (table) => [
    index("curated_memory_proposals_owner_status_idx").on(
      table.ownerUserId,
      table.status,
      table.createdAt.desc()
    ),
    index("curated_memory_proposals_pending_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    check(
      "curated_memory_proposals_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    ),
    check(
      "curated_memory_proposals_claim_not_empty_check",
      sql`length(trim(${table.proposedClaim})) > 0`
    ),
    check(
      "curated_memory_proposals_has_evidence_check",
      sql`cardinality(${table.evidenceConversationItemIds}) > 0 or cardinality(${table.evidenceMemoryEventIds}) > 0`
    ),
    check(
      "curated_memory_proposals_attempt_count_check",
      sql`${table.attemptCount} >= 0`
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
    modelArtifactHash: text("model_artifact_hash"),
    embeddingDimensions: integer("embedding_dimensions").notNull(),
    embeddingVersion: text("embedding_version").notNull(),
    tokenizer: text("tokenizer"),
    inputTransform: text("input_transform"),
    pooling: text("pooling"),
    normalization: text("normalization"),
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
      onDelete: "set null"
    }),
    ownerPrincipalId: uuid("owner_principal_id"),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict"
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
        and ${table.ownerPrincipalId} is null
        and ${table.teamId} is null
        and ${table.teamWorkspaceId} is null
      ) or (
        ${table.encryptionScope} = 'team'
        and ${table.visibility} = 'personal'
        and ${table.teamId} is not null
        and ${table.ownerPrincipalId} is null
      ) or (
        ${table.encryptionScope} = 'owner_private_replica'
        and ${table.visibility} = 'personal'
        and ${table.ownerPrincipalId} is not null
        and ${table.teamId} is null
        and ${table.teamWorkspaceId} is null
      )`
    ),
    check(
      "encrypted_field_payloads_encryption_scope_check",
      sql`${table.encryptionScope} in ('personal', 'team', 'owner_private_replica')`
    ),
    check(
      "encrypted_field_payloads_source_table_check",
      sql`${table.sourceTable} in (
        'conversation_items',
        'conversation_item_observations',
        'collaboration_messages',
        'collaboration_threads',
        'curated_memory_assertions',
        'curated_memory_proposals',
        'curated_memory_sources',
        'curated_memory_topics',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'memory_replica_revisions',
        'messages',
        'shared_source_artifacts',
        'shared_source_previews',
        'team_workspaces',
        'team_memory_representations',
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
        'collaboration_messages',
        'collaboration_threads',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'memory_replica_revisions',
        'messages',
        'shared_source_artifacts',
        'shared_source_previews',
        'team_memory_representations',
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
      .notNull(),
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
    ),
    check(
      "device_enrollment_challenges_operation_families_check",
      sql`array_position(${table.requestedOperationFamilies}, null) is null
        and cardinality(${table.requestedOperationFamilies}) > 0
        and array_to_string(${table.requestedOperationFamilies}, ',')
          ~ '^[A-Za-z0-9_.:-]+(,[A-Za-z0-9_.:-]+)*$'`
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
    operationFamilies: text("operation_families").array().notNull(),
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
    unique("device_credentials_id_owner_backend_unique").on(
      table.id,
      table.ownerUserId,
      table.upstreamBackendId
    ),
    unique("device_credentials_id_owner_unique").on(
      table.id,
      table.ownerUserId
    ),
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
    ),
    check(
      "device_credentials_operation_families_check",
      sql`array_position(${table.operationFamilies}, null) is null
        and cardinality(${table.operationFamilies}) > 0
        and array_to_string(${table.operationFamilies}, ',')
          ~ '^[A-Za-z0-9_.:-]+(,[A-Za-z0-9_.:-]+)*$'`
    )
  ]
);

export const conversationSourceDownloadAuthorizations = pgTable(
  "conversation_source_download_authorizations",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceCredentialId: uuid("device_credential_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    recipientKey: jsonb("recipient_key")
      .$type<Record<string, unknown>>()
      .notNull(),
    initiatingOperationKind: text("initiating_operation_kind"),
    initiatingOperationId: uuid("initiating_operation_id"),
    capabilityHash: text("capability_hash").notNull().unique(),
    firstSegmentIndex: integer("first_segment_index").notNull(),
    lastSegmentIndex: integer("last_segment_index").notNull(),
    createdAt: now(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason")
  },
  (table) => [
    foreignKey({
      columns: [table.artifactId, table.ownerUserId],
      foreignColumns: [
        conversationSourceArtifacts.id,
        conversationSourceArtifacts.ownerUserId
      ],
      name: "conversation_source_download_artifact_owner_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.deviceCredentialId, table.ownerUserId],
      foreignColumns: [deviceCredentials.id, deviceCredentials.ownerUserId],
      name: "conversation_source_download_device_owner_fk"
    }).onDelete("cascade"),
    index("conversation_source_download_active_idx")
      .on(table.ownerUserId, table.deviceCredentialId, table.expiresAt)
      .where(sql`${table.revokedAt} is null`),
    check(
      "conversation_source_download_capability_hash_check",
      sql`${table.capabilityHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "conversation_source_download_segment_range_check",
      sql`${table.firstSegmentIndex} >= 0
        and ${table.lastSegmentIndex} >= ${table.firstSegmentIndex} - 1`
    ),
    check(
      "conversation_source_download_initiating_operation_check",
      sql`((${table.initiatingOperationKind} is null and ${table.initiatingOperationId} is null)
        or (${table.initiatingOperationKind} in ('handoff', 'fork')
          and ${table.initiatingOperationId} is not null))`
    ),
    check(
      "conversation_source_download_lifecycle_check",
      sql`${table.expiresAt} > ${table.createdAt}
        and ((${table.revokedAt} is null and ${table.revocationReason} is null)
          or (${table.revokedAt} is not null and ${table.revocationReason} is not null))`
    )
  ]
);

export const managedConversationExecutions = pgTable(
  "managed_conversation_executions",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    provider: text("provider").notNull().default("codex"),
    state: text("state").notNull().default("starting"),
    stateVersion: integer("state_version").notNull().default(1),
    executionGeneration: integer("execution_generation").notNull().default(1),
    fencingTokenHash: text("fencing_token_hash").notNull(),
    runnerDeploymentId: uuid("runner_deployment_id").notNull(),
    runnerDeviceId: uuid("runner_device_id").notNull(),
    runnerId: text("runner_id"),
    runnerLeaseExpiresAt: timestamp("runner_lease_expires_at", {
      withTimezone: true
    }),
    logicalSessionId: uuid("logical_session_id"),
    providerThreadId: text("provider_thread_id"),
    providerCliVersion: text("provider_cli_version"),
    sourceGenerationId: uuid("source_generation_id"),
    lastErrorCode: text("last_error_code"),
    createdAt: now(),
    updatedAt: updatedNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    quiescedAt: timestamp("quiesced_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true })
  },
  (table) => [
    unique("managed_conversation_executions_session_owner_unique").on(
      table.logicalSessionId,
      table.ownerUserId
    ),
    index("managed_conversation_executions_owner_state_idx").on(
      table.ownerUserId,
      table.state,
      table.updatedAt.desc()
    ),
    index("managed_conversation_executions_runner_lease_idx").on(
      table.state,
      table.runnerLeaseExpiresAt
    ),
    check(
      "managed_conversation_executions_state_check",
      sql`${table.state} in (
        'starting',
        'running',
        'reconciling',
        'quiesce_requested',
        'quiesced',
        'stopping',
        'stopped',
        'failed',
        'fenced'
      )`
    ),
    check(
      "managed_conversation_executions_provider_check",
      sql`${table.provider} = 'codex'`
    ),
    check(
      "managed_conversation_executions_generation_check",
      sql`${table.stateVersion} > 0
        and ${table.executionGeneration} > 0
        and ${table.fencingTokenHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "managed_conversation_executions_identity_check",
      sql`(
        ${table.state} = 'starting'
        and ${table.logicalSessionId} is null
        and ${table.providerThreadId} is null
      ) or (
        ${table.state} <> 'starting'
        and (
          ${table.state} = 'failed'
          or (
            ${table.logicalSessionId} is not null
            and ${table.providerThreadId} is not null
          )
        )
      )`
    ),
    check(
      "managed_conversation_executions_runner_lease_check",
      sql`(${table.runnerId} is null and ${table.runnerLeaseExpiresAt} is null)
        or (${table.runnerId} is not null and ${table.runnerLeaseExpiresAt} is not null)`
    )
  ]
);

export const managedConversationRuntimeBindings = pgTable(
  "managed_conversation_runtime_bindings",
  {
    executionId: uuid("execution_id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    projectPath: text("project_path").notNull(),
    localSessionId: uuid("local_session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    providerThreadId: text("provider_thread_id"),
    transcriptPath: text("transcript_path"),
    managedHome: text("managed_home"),
    providerCliVersion: text("provider_cli_version"),
    sourceGenerationId: uuid("source_generation_id"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("managed_conversation_runtime_binding_owner_execution_unique").on(
      table.ownerUserId,
      table.executionId
    ),
    index("managed_conversation_runtime_binding_device_idx").on(
      table.ownerUserId,
      table.deviceId,
      table.executionGeneration
    ),
    check(
      "managed_conversation_runtime_binding_generation_check",
      sql`${table.executionGeneration} > 0`
    ),
    check(
      "managed_conversation_runtime_binding_identity_check",
      sql`(
          ${table.localSessionId} is null
          and ${table.providerThreadId} is null
          and ${table.transcriptPath} is null
          and ${table.managedHome} is null
        ) or (
          ${table.localSessionId} is not null
          and length(trim(${table.providerThreadId})) > 0
          and length(trim(${table.transcriptPath})) > 0
          and length(trim(${table.managedHome})) > 0
        )`
    )
  ]
);

export const managedConversationCommands = pgTable(
  "managed_conversation_commands",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => managedConversationExecutions.id, {
        onDelete: "cascade"
      }),
    idempotencyKey: text("idempotency_key").notNull(),
    sequence: integer("sequence").notNull(),
    commandKind: text("command_kind").notNull(),
    targetDeploymentId: uuid("target_deployment_id"),
    targetDeviceId: uuid("target_device_id"),
    requestDigest: text("request_digest").notNull(),
    clientUserMessageId: uuid("client_user_message_id"),
    executionGeneration: integer("execution_generation").notNull(),
    encryptedPayload:
      jsonb("encrypted_payload").$type<Record<string, unknown>>(),
    state: text("state").notNull().default("queued"),
    blockedOnKind: text("blocked_on_kind"),
    blockedOnId: uuid("blocked_on_id"),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    lastErrorCode: text("last_error_code"),
    createdAt: now(),
    updatedAt: updatedNow(),
    dispatchingAt: timestamp("dispatching_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    unique("managed_conversation_commands_idempotency_unique").on(
      table.ownerUserId,
      table.idempotencyKey
    ),
    unique("managed_conversation_commands_sequence_unique").on(
      table.executionId,
      table.sequence
    ),
    index("managed_conversation_commands_claim_idx").on(
      table.state,
      table.leaseExpiresAt,
      table.createdAt
    ),
    check(
      "managed_conversation_commands_kind_check",
      sql`${table.commandKind} in (
        'start',
        'prompt',
        'quiesce',
        'stop',
        'verify_target',
        'restore',
        'fork_prepare',
        'fork_create'
      )`
    ),
    check(
      "managed_conversation_commands_state_check",
      sql`${table.state} in (
        'queued',
        'blocked',
        'dispatching',
        'completed',
        'indeterminate',
        'failed',
        'canceled'
      )`
    ),
    check(
      "managed_conversation_commands_shape_check",
      sql`${table.sequence} >= 0
        and ${table.executionGeneration} > 0
        and ${table.attempts} >= 0
        and ${table.requestDigest} ~ '^[0-9a-f]{64}$'
        and (
          (${table.state} = 'blocked'
            and ${table.blockedOnKind} in (
              'source_replica',
              'source_registration',
              'runtime_binding'
            )
            and ${table.blockedOnId} is not null
            and (
              ${table.blockedOnKind} <> 'runtime_binding'
              or (
                ${table.commandKind} = 'start'
                and ${table.blockedOnId} = ${table.executionId}
              )
            ))
          or (${table.state} <> 'blocked'
            and ${table.blockedOnKind} is null
            and ${table.blockedOnId} is null)
        )
        and (
          (${table.commandKind} = 'prompt'
            and ${table.clientUserMessageId} is not null
            and ${table.encryptedPayload} is not null)
          or (${table.commandKind} <> 'prompt'
            and ${table.clientUserMessageId} is null)
        )
        and (
          (${table.commandKind} in ('verify_target','restore','fork_create')
            and ${table.targetDeploymentId} is not null
            and ${table.targetDeviceId} is not null)
          or (${table.commandKind} not in ('verify_target','restore','fork_create')
            and ${table.targetDeploymentId} is null
            and ${table.targetDeviceId} is null)
        )`
    ),
    check(
      "managed_conversation_commands_lease_check",
      sql`(${table.leaseToken} is null and ${table.leaseExpiresAt} is null)
        or (${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null)`
    )
  ]
);

export const managedConversationAuthorityLogs = pgTable(
  "managed_conversation_authority_logs",
  {
    executionId: uuid("execution_id")
      .primaryKey()
      .references(() => managedConversationExecutions.id, {
        onDelete: "cascade"
      }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authorityKeyId: uuid("authority_key_id").notNull(),
    authorityPublicKey: text("authority_public_key").notNull(),
    encryptedAuthorityPrivateKey: jsonb("encrypted_authority_private_key")
      .$type<Record<string, unknown>>()
      .notNull(),
    headSequence: integer("head_sequence").notNull().default(0),
    headHash: text("head_hash"),
    highestExecutionGeneration: integer("highest_execution_generation")
      .notNull()
      .default(1),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    quarantineReason: text("quarantine_reason"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("managed_conversation_authority_owner_execution_unique").on(
      table.ownerUserId,
      table.executionId
    ),
    check(
      "managed_conversation_authority_key_check",
      sql`${table.authorityPublicKey} ~ '^[A-Za-z0-9_-]{43}$'`
    ),
    check(
      "managed_conversation_authority_head_check",
      sql`${table.headSequence} >= 0
        and ${table.highestExecutionGeneration} > 0
        and (
          (${table.headSequence} = 0 and ${table.headHash} is null)
          or (${table.headSequence} > 0 and ${table.headHash} ~ '^[0-9a-f]{64}$')
        )`
    ),
    check(
      "managed_conversation_authority_quarantine_check",
      sql`(${table.quarantinedAt} is null and ${table.quarantineReason} is null)
        or (${table.quarantinedAt} is not null
          and length(trim(${table.quarantineReason})) between 1 and 120)`
    )
  ]
);

export const developmentWorkspaceSnapshots = pgTable(
  "development_workspace_snapshots",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => managedConversationExecutions.id, {
        onDelete: "cascade"
      }),
    operationKind: text("operation_kind").notNull(),
    operationId: uuid("operation_id").notNull(),
    sourceGenerationId: uuid("source_generation_id").notNull(),
    sourceDeploymentId: uuid("source_deployment_id").notNull(),
    sourceDeviceId: uuid("source_device_id").notNull(),
    protocol: text("protocol").notNull(),
    state: text("state").notNull().default("capturing"),
    manifestDigest: text("manifest_digest"),
    sourceStateDigest: text("source_state_digest"),
    storageProvider: text("storage_provider"),
    packageDigest: text("package_digest"),
    packageByteCount: bigint("package_byte_count", { mode: "number" }),
    chunkCount: integer("chunk_count"),
    readinessEvidence:
      jsonb("readiness_evidence").$type<Record<string, unknown>>(),
    failureCode: text("failure_code"),
    createdAt: now(),
    updatedAt: updatedNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    unique("development_workspace_snapshot_owner_id_unique").on(
      table.ownerUserId,
      table.id
    ),
    index("development_workspace_snapshot_execution_idx").on(
      table.ownerUserId,
      table.executionId,
      table.createdAt.desc()
    ),
    check(
      "development_workspace_snapshot_state_check",
      sql`${table.state} in (
        'capturing',
        'ready',
        'materialized',
        'environment_incomplete',
        'incompatible',
        'conflicted',
        'revoked',
        'deleted'
      )`
    ),
    check(
      "development_workspace_snapshot_protocol_check",
      sql`${table.protocol} = 'koed-development-workspace-snapshot-v1'`
    ),
    check(
      "development_workspace_snapshot_operation_check",
      sql`${table.operationKind} in ('handoff', 'fork')`
    ),
    check(
      "development_workspace_snapshot_storage_check",
      sql`(
          ${table.state} = 'capturing'
          and ${table.manifestDigest} is null
          and ${table.sourceStateDigest} is null
          and ${table.storageProvider} is null
          and ${table.packageDigest} is null
          and ${table.packageByteCount} is null
          and ${table.chunkCount} is null
          and ${table.finalizedAt} is null
        ) or (
          ${table.state} <> 'capturing'
          and ${table.manifestDigest} ~ '^[0-9a-f]{64}$'
          and ${table.sourceStateDigest} ~ '^[0-9a-f]{64}$'
          and length(trim(${table.storageProvider})) > 0
          and ${table.packageDigest} ~ '^[0-9a-f]{64}$'
          and ${table.packageByteCount} > 0
          and ${table.chunkCount} > 0
          and ${table.finalizedAt} is not null
        )`
    ),
    check(
      "development_workspace_snapshot_failure_check",
      sql`${table.failureCode} is null
        or ${table.failureCode} ~ '^[A-Za-z][A-Za-z0-9_.-]{0,119}$'`
    )
  ]
);

export const developmentWorkspaceSnapshotChunks = pgTable(
  "development_workspace_snapshot_chunks",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => developmentWorkspaceSnapshots.id, {
        onDelete: "cascade"
      }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    plaintextDigest: text("plaintext_digest").notNull(),
    plaintextByteCount: integer("plaintext_byte_count").notNull(),
    ciphertextDigest: text("ciphertext_digest").notNull(),
    encryptedByteCount: integer("encrypted_byte_count").notNull(),
    encryptionEnvelope: jsonb("encryption_envelope")
      .$type<EncryptedPayloadEnvelope>()
      .notNull(),
    createdAt: now()
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.chunkIndex] }),
    index("development_workspace_snapshot_chunk_owner_digest_idx").on(
      table.ownerUserId,
      table.plaintextDigest
    ),
    check(
      "development_workspace_snapshot_chunk_shape_check",
      sql`${table.chunkIndex} >= 0
        and ${table.chunkCount} > 0
        and ${table.chunkIndex} < ${table.chunkCount}
        and ${table.plaintextDigest} ~ '^[0-9a-f]{64}$'
        and ${table.plaintextByteCount} > 0
        and ${table.plaintextByteCount} <= 1048576
        and ${table.ciphertextDigest} ~ '^[0-9a-f]{64}$'
        and ${table.encryptedByteCount} > 0
        and jsonb_typeof(${table.encryptionEnvelope}) = 'object'`
    )
  ]
);

export const managedConversationHandoffs = pgTable(
  "managed_conversation_handoffs",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => managedConversationExecutions.id, {
        onDelete: "cascade"
      }),
    operationId: uuid("operation_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    state: text("state").notNull().default("quiesce_requested"),
    stateVersion: integer("state_version").notNull().default(1),
    sourceExecutionGeneration: integer("source_execution_generation").notNull(),
    nextExecutionGeneration: integer("next_execution_generation").notNull(),
    sourceDeploymentId: uuid("source_deployment_id").notNull(),
    sourceDeviceId: uuid("source_device_id").notNull(),
    targetDeploymentId: uuid("target_deployment_id").notNull(),
    targetDeviceId: uuid("target_device_id").notNull(),
    logicalSourceId: uuid("logical_source_id"),
    sourceGenerationId: uuid("source_generation_id"),
    sourceClosureHash: text("source_closure_hash"),
    sourceEndByteCursor: bigint("source_end_byte_cursor", { mode: "number" }),
    sourceEndItemCursor: bigint("source_end_item_cursor", { mode: "number" }),
    workspaceSnapshotId: uuid("workspace_snapshot_id").references(
      () => developmentWorkspaceSnapshots.id,
      { onDelete: "restrict" }
    ),
    workspaceManifestDigest: text("workspace_manifest_digest"),
    authoritySequence: integer("authority_sequence"),
    priorAuthorityLogHead: text("prior_authority_log_head"),
    transferManifest:
      jsonb("transfer_manifest").$type<Record<string, unknown>>(),
    sourceAttestation:
      jsonb("source_attestation").$type<Record<string, unknown>>(),
    targetReadinessEvidence: jsonb(
      "target_readiness_evidence"
    ).$type<ManagedConversationTargetReadinessEvidence>(),
    targetReadinessDigest: text("target_readiness_digest"),
    certificate: jsonb("certificate").$type<Record<string, unknown>>(),
    certificateDigest: text("certificate_digest"),
    resultingAuthorityLogHead: text("resulting_authority_log_head"),
    restorationLeaseOwner: text("restoration_lease_owner"),
    restorationLeaseToken: uuid("restoration_lease_token"),
    restorationLeaseExpiresAt: timestamp("restoration_lease_expires_at", {
      withTimezone: true
    }),
    recoveryOwnerDeviceId: uuid("recovery_owner_device_id"),
    failureCode: text("failure_code"),
    createdAt: now(),
    updatedAt: updatedNow(),
    transferredAt: timestamp("transferred_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    unique("managed_conversation_handoff_owner_operation_unique").on(
      table.ownerUserId,
      table.operationId
    ),
    uniqueIndex("managed_conversation_handoff_active_execution_unique")
      .on(table.executionId)
      .where(sql`${table.state} not in ('running','failed','quarantined')`),
    index("managed_conversation_handoff_target_idx").on(
      table.ownerUserId,
      table.targetDeviceId,
      table.state,
      table.updatedAt
    ),
    check(
      "managed_conversation_handoff_state_check",
      sql`${table.state} in (
        'quiesce_requested',
        'provider_stopped',
        'source_sealed',
        'workspace_prepared',
        'target_verified',
        'lease_transferred',
        'restoring',
        'identity_verified',
        'running',
        'failed',
        'quarantined'
      )`
    ),
    check(
      "managed_conversation_handoff_generation_check",
      sql`${table.sourceExecutionGeneration} > 0
        and ${table.nextExecutionGeneration} = ${table.sourceExecutionGeneration} + 1
        and ${table.stateVersion} > 0`
    ),
    check(
      "managed_conversation_handoff_target_check",
      sql`${table.sourceDeviceId} <> ${table.targetDeviceId}`
    ),
    check(
      "managed_conversation_handoff_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'
        and (${table.sourceClosureHash} is null
          or ${table.sourceClosureHash} ~ '^[0-9a-f]{64}$')
        and (${table.workspaceManifestDigest} is null
          or ${table.workspaceManifestDigest} ~ '^[0-9a-f]{64}$')
        and (${table.targetReadinessDigest} is null
          or ${table.targetReadinessDigest} ~ '^[0-9a-f]{64}$')
        and (${table.priorAuthorityLogHead} is null
          or ${table.priorAuthorityLogHead} ~ '^[0-9a-f]{64}$')
        and (${table.certificateDigest} is null
          or ${table.certificateDigest} ~ '^[0-9a-f]{64}$')
        and (${table.resultingAuthorityLogHead} is null
          or ${table.resultingAuthorityLogHead} ~ '^[0-9a-f]{64}$')`
    ),
    check(
      "managed_conversation_handoff_lease_check",
      sql`(
          ${table.restorationLeaseOwner} is null
          and ${table.restorationLeaseToken} is null
          and ${table.restorationLeaseExpiresAt} is null
        ) or (
          ${table.restorationLeaseOwner} is not null
          and ${table.restorationLeaseToken} is not null
          and ${table.restorationLeaseExpiresAt} is not null
        )`
    ),
    check(
      "managed_conversation_handoff_certificate_check",
      sql`(
          ${table.state} in (
            'quiesce_requested',
            'provider_stopped',
            'source_sealed',
            'workspace_prepared',
            'target_verified',
            'failed'
          )
          and ${table.certificate} is null
          and ${table.certificateDigest} is null
          and ${table.resultingAuthorityLogHead} is null
          and ${table.transferredAt} is null
        ) or (
          ${table.state} in (
            'lease_transferred',
            'restoring',
            'identity_verified',
            'running',
            'quarantined'
          )
          and jsonb_typeof(${table.certificate}) = 'object'
          and ${table.certificateDigest} ~ '^[0-9a-f]{64}$'
          and ${table.resultingAuthorityLogHead} ~ '^[0-9a-f]{64}$'
          and ${table.transferredAt} is not null
        )`
    ),
    check(
      "managed_conversation_handoff_source_attestation_check",
      sql`(
          ${table.state} in ('quiesce_requested','provider_stopped','source_sealed')
          and ${table.sourceAttestation} is null
        ) or (
          ${table.state} in (
            'workspace_prepared',
            'target_verified',
            'lease_transferred',
            'restoring',
            'identity_verified',
            'running',
            'quarantined'
          )
          and jsonb_typeof(${table.sourceAttestation}) = 'object'
        ) or ${table.state} = 'failed'`
    ),
    check(
      "managed_conversation_handoff_target_readiness_check",
      sql`(
          ${table.state} in (
            'quiesce_requested',
            'provider_stopped',
            'source_sealed',
            'workspace_prepared',
            'failed'
          )
          and ${table.targetReadinessEvidence} is null
          and ${table.targetReadinessDigest} is null
        ) or (
          ${table.state} in (
            'target_verified',
            'lease_transferred',
            'restoring',
            'identity_verified',
            'running',
            'quarantined'
          )
          and jsonb_typeof(${table.targetReadinessEvidence}) = 'object'
          and ${table.targetReadinessDigest} ~ '^[0-9a-f]{64}$'
        )`
    ),
    check(
      "managed_conversation_handoff_manifest_check",
      sql`(
          ${table.state} in ('quiesce_requested','provider_stopped')
          and ${table.transferManifest} is null
        ) or (
          ${table.state} in (
            'source_sealed',
            'workspace_prepared',
            'target_verified',
            'lease_transferred',
            'restoring',
            'identity_verified',
            'running',
            'quarantined'
          )
          and jsonb_typeof(${table.transferManifest}) = 'object'
        ) or ${table.state} = 'failed'`
    )
  ]
);

export const managedConversationHandoffTransitions = pgTable(
  "managed_conversation_handoff_transitions",
  {
    id: id(),
    handoffId: uuid("handoff_id")
      .notNull()
      .references(() => managedConversationHandoffs.id, {
        onDelete: "cascade"
      }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stateVersion: integer("state_version").notNull(),
    state: text("state").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: now()
  },
  (table) => [
    unique("managed_conversation_handoff_transition_version_unique").on(
      table.handoffId,
      table.stateVersion
    ),
    check(
      "managed_conversation_handoff_transition_state_check",
      sql`${table.state} in (
        'quiesce_requested',
        'provider_stopped',
        'source_sealed',
        'workspace_prepared',
        'target_verified',
        'lease_transferred',
        'restoring',
        'identity_verified',
        'running',
        'failed',
        'quarantined'
      )`
    ),
    check(
      "managed_conversation_handoff_transition_shape_check",
      sql`${table.stateVersion} > 0
        and ${table.evidenceDigest} ~ '^[0-9a-f]{64}$'
        and ${table.actorKind} in ('user','source_runner','target_runner','authority','recovery')
        and length(trim(${table.actorId})) between 1 and 160`
    )
  ]
);

export const managedConversationForks = pgTable(
  "managed_conversation_forks",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    state: text("state").notNull().default("requested"),
    stateVersion: integer("state_version").notNull().default(1),
    parentExecutionId: uuid("parent_execution_id")
      .notNull()
      .references(() => managedConversationExecutions.id, {
        onDelete: "restrict"
      }),
    parentExecutionGeneration: integer("parent_execution_generation").notNull(),
    parentNextSourceGenerationId: uuid(
      "parent_next_source_generation_id"
    ).notNull(),
    parentNextOriginKeyId: uuid("parent_next_origin_key_id").notNull(),
    parentLogicalSessionId: uuid("parent_logical_session_id"),
    parentSourceGenerationId: uuid("parent_source_generation_id"),
    parentClosureHash: text("parent_closure_hash"),
    parentEndByteCursor: bigint("parent_end_byte_cursor", {
      mode: "number"
    }),
    parentEndItemCursor: bigint("parent_end_item_cursor", {
      mode: "number"
    }),
    sourceDeploymentId: uuid("source_deployment_id").notNull(),
    sourceDeviceId: uuid("source_device_id").notNull(),
    targetDeploymentId: uuid("target_deployment_id").notNull(),
    targetDeviceId: uuid("target_device_id").notNull(),
    workspaceSnapshotId: uuid("workspace_snapshot_id").references(
      () => developmentWorkspaceSnapshots.id,
      { onDelete: "restrict" }
    ),
    childExecutionId: uuid("child_execution_id").references(
      () => managedConversationExecutions.id,
      { onDelete: "restrict" }
    ),
    childLogicalSessionId: uuid("child_logical_session_id"),
    childLogicalSourceId: uuid("child_logical_source_id"),
    providerCreationCorrelation: uuid(
      "provider_creation_correlation"
    ).notNull(),
    forkManifest: jsonb("fork_manifest").$type<Record<string, unknown>>(),
    sourceAttestation:
      jsonb("source_attestation").$type<Record<string, unknown>>(),
    manifestDigest: text("manifest_digest"),
    reason: text("reason").notNull(),
    failureCode: text("failure_code"),
    createdAt: now(),
    updatedAt: updatedNow(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    unique("managed_conversation_fork_owner_operation_unique").on(
      table.ownerUserId,
      table.operationId
    ),
    check(
      "managed_conversation_fork_state_check",
      sql`${table.state} in (
        'requested',
        'source_prepared',
        'source_attested',
        'provider_created',
        'child_bound',
        'running',
        'indeterminate',
        'failed'
      )`
    ),
    check(
      "managed_conversation_fork_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'
        and ${table.parentExecutionGeneration} > 0
        and ${table.stateVersion} > 0
        and (
          (
            ${table.state} in ('requested', 'indeterminate', 'failed')
            and ${table.parentLogicalSessionId} is null
            and ${table.parentSourceGenerationId} is null
            and ${table.parentClosureHash} is null
            and ${table.parentEndByteCursor} is null
            and ${table.parentEndItemCursor} is null
            and ${table.workspaceSnapshotId} is null
            and ${table.forkManifest} is null
            and ${table.sourceAttestation} is null
            and ${table.manifestDigest} is null
          ) or (
            ${table.state} in ('source_prepared', 'indeterminate', 'failed')
            and ${table.parentLogicalSessionId} is not null
            and ${table.parentSourceGenerationId} is not null
            and ${table.parentClosureHash} ~ '^[0-9a-f]{64}$'
            and ${table.parentEndByteCursor} >= 0
            and ${table.parentEndItemCursor} >= 0
            and ${table.workspaceSnapshotId} is not null
            and jsonb_typeof(${table.forkManifest}) = 'object'
            and ${table.sourceAttestation} is null
            and ${table.manifestDigest} is null
          ) or (
            ${table.state} in (
              'source_attested',
              'provider_created',
              'child_bound',
              'running',
              'indeterminate',
              'failed'
            )
            and ${table.parentLogicalSessionId} is not null
            and ${table.parentSourceGenerationId} is not null
            and ${table.parentClosureHash} ~ '^[0-9a-f]{64}$'
            and ${table.parentEndByteCursor} >= 0
            and ${table.parentEndItemCursor} >= 0
            and ${table.workspaceSnapshotId} is not null
            and jsonb_typeof(${table.forkManifest}) = 'object'
            and jsonb_typeof(${table.sourceAttestation}) = 'object'
            and ${table.manifestDigest} ~ '^[0-9a-f]{64}$'
          )
        )`
    ),
    check(
      "managed_conversation_fork_reason_check",
      sql`length(trim(${table.reason})) between 1 and 280`
    )
  ]
);

export const managedConversationForkTransitions = pgTable(
  "managed_conversation_fork_transitions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    forkId: uuid("fork_id")
      .notNull()
      .references(() => managedConversationForks.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stateVersion: integer("state_version").notNull(),
    state: text("state").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: now()
  },
  (table) => [
    unique("managed_conversation_fork_transition_version_unique").on(
      table.forkId,
      table.stateVersion
    ),
    check(
      "managed_conversation_fork_transition_state_check",
      sql`${table.state} in (
        'requested',
        'source_prepared',
        'source_attested',
        'provider_created',
        'child_bound',
        'running',
        'indeterminate',
        'failed'
      )`
    ),
    check(
      "managed_conversation_fork_transition_shape_check",
      sql`${table.stateVersion} > 0
        and ${table.evidenceDigest} ~ '^[0-9a-f]{64}$'
        and ${table.actorKind} in ('user','source_runner','target_runner','recovery')
        and length(trim(${table.actorId})) between 1 and 160`
    )
  ]
);

export const conversationSourceRestoreJobs = pgTable(
  "conversation_source_restore_jobs",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    upstreamBackendId: text("upstream_backend_id").notNull(),
    sourceGenerationId: uuid("source_generation_id").notNull(),
    targetDeploymentId: uuid("target_deployment_id").notNull(),
    recipientKeyId: text("recipient_key_id").notNull(),
    recipientKeyVersion: integer("recipient_key_version").notNull(),
    actionGrantId: uuid("action_grant_id").notNull(),
    state: text("state").notNull().default("awaiting_approval"),
    remoteAuthorizationId: uuid("remote_authorization_id"),
    encryptedCapability: jsonb("encrypted_capability").$type<
      Record<string, unknown>
    >(),
    registration: jsonb("registration").$type<Record<string, unknown>>(),
    sourceDescriptor:
      jsonb("source_descriptor").$type<Record<string, unknown>>(),
    sourceClosure: jsonb("source_closure").$type<Record<string, unknown>>(),
    nextSegmentIndex: integer("next_segment_index").notNull().default(0),
    lastSegmentIndex: integer("last_segment_index"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true
    })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: now(),
    updatedAt: updatedNow(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    unique("conversation_source_restore_action_grant_unique").on(
      table.ownerUserId,
      table.actionGrantId
    ),
    unique("conversation_source_restore_target_unique").on(
      table.ownerUserId,
      table.upstreamBackendId,
      table.sourceGenerationId,
      table.targetDeploymentId
    ),
    index("conversation_source_restore_claim_idx").on(
      table.state,
      table.leaseExpiresAt,
      table.updatedAt
    ),
    check(
      "conversation_source_restore_state_check",
      sql`${table.state} in (
        'awaiting_approval',
        'ready',
        'downloading',
        'materializing',
        'completed',
        'failed',
        'revoked'
      )`
    ),
    check(
      "conversation_source_restore_shape_check",
      sql`${table.recipientKeyVersion} > 0
        and ${table.nextSegmentIndex} >= 0
        and ${table.maxAttempts} between 1 and 100
        and ${table.attempts} between 0 and ${table.maxAttempts}
        and (
          ${table.lastSegmentIndex} is null
          or ${table.lastSegmentIndex} >= ${table.nextSegmentIndex} - 1
        )
        and (
          (${table.remoteAuthorizationId} is null
            and ${table.encryptedCapability} is null)
          or (${table.remoteAuthorizationId} is not null
            and ${table.encryptedCapability} is not null
            and ${table.registration} is not null
            and ${table.sourceDescriptor} is not null
            and ${table.lastSegmentIndex} is not null)
        )`
    ),
    check(
      "conversation_source_restore_lease_check",
      sql`(
        ${table.leaseOwner} is null
        and ${table.leaseToken} is null
        and ${table.leaseExpiresAt} is null
      ) or (
        ${table.leaseOwner} is not null
        and ${table.leaseToken} is not null
        and ${table.leaseExpiresAt} is not null
      )`
    )
  ]
);

export const highRiskBrowserConfirmations = pgTable(
  "high_risk_browser_confirmations",
  {
    id: id(),
    selector: uuid("selector").notNull().unique(),
    clientRequestId: uuid("client_request_id").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decisionUserSessionId: uuid("decision_user_session_id").references(
      () => userSessions.id,
      { onDelete: "restrict" }
    ),
    deviceCredentialId: uuid("device_credential_id").notNull(),
    upstreamBackendId: text("upstream_backend_id").notNull(),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict"
    }),
    operationFamily: text("operation_family").notNull(),
    action: text("action").notNull(),
    targetId: uuid("target_id"),
    scopeHash: text("scope_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    secretCommitment: text("secret_commitment").notNull().unique(),
    approvalTier: actionApprovalTier("approval_tier")
      .notNull()
      .default("step_up"),
    reviewSummary: jsonb("review_summary").$type<CollaborationApprovalReview>(),
    state: highRiskConfirmationState("state").notNull().default("pending"),
    createdAt: now(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decisionFreshlyAuthenticatedAt: timestamp(
      "decision_freshly_authenticated_at",
      {
        withTimezone: true
      }
    ),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReasonCode: text("revocation_reason_code")
  },
  (table) => [
    foreignKey({
      columns: [
        table.deviceCredentialId,
        table.ownerUserId,
        table.upstreamBackendId
      ],
      foreignColumns: [
        deviceCredentials.id,
        deviceCredentials.ownerUserId,
        deviceCredentials.upstreamBackendId
      ],
      name: "high_risk_confirmations_device_binding_fk"
    }).onDelete("restrict"),
    unique("high_risk_confirmations_device_request_unique").on(
      table.deviceCredentialId,
      table.clientRequestId
    ),
    index("high_risk_confirmations_active_idx")
      .on(table.ownerUserId, table.expiresAt)
      .where(sql`${table.state} in ('pending', 'approved')`),
    check(
      "high_risk_confirmations_operation_check",
      sql`${table.operationFamily} ~ '^[A-Za-z0-9_.:-]+$'
        and ${table.action} ~ '^[A-Za-z0-9_.:-]+$'`
    ),
    check(
      "high_risk_confirmations_hash_check",
      sql`length(${table.scopeHash}) = 64
        and length(${table.requestHash}) = 64
        and ${table.secretCommitment} ~ '^v1:[0-9A-Fa-f]{64}$'`
    ),
    check(
      "high_risk_confirmations_approval_review_check",
      sql`((${table.approvalTier} = 'direct' and ${table.reviewSummary} is null)
        or (${table.approvalTier} in ('native_review', 'step_up') and ${table.reviewSummary} is not null))`
    ),
    check(
      "high_risk_confirmations_time_check",
      sql`${table.expiresAt} > ${table.createdAt}
        and (${table.decisionFreshlyAuthenticatedAt} is null
          or ${table.decisionFreshlyAuthenticatedAt} <= ${table.decidedAt})`
    ),
    check(
      "high_risk_confirmations_lifecycle_check",
      sql`(
        ${table.state} = 'pending'
        and ${table.decisionUserSessionId} is null
        and ${table.decisionFreshlyAuthenticatedAt} is null
        and ${table.decidedAt} is null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'approved'
        and (
          (${table.approvalTier} = 'step_up'
            and ${table.decisionUserSessionId} is not null
            and ${table.decisionFreshlyAuthenticatedAt} is not null)
          or (${table.approvalTier} in ('direct', 'native_review')
            and ${table.decisionUserSessionId} is null
            and ${table.decisionFreshlyAuthenticatedAt} is null)
        )
        and ${table.decidedAt} is not null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'denied'
        and (
          (${table.approvalTier} = 'step_up'
            and ${table.decisionUserSessionId} is not null
            and ${table.decisionFreshlyAuthenticatedAt} is not null)
          or (${table.approvalTier} = 'native_review'
            and ${table.decisionUserSessionId} is null
            and ${table.decisionFreshlyAuthenticatedAt} is null)
        )
        and ${table.decidedAt} is not null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'expired'
        and ${table.decisionUserSessionId} is null
        and ${table.decisionFreshlyAuthenticatedAt} is null
        and ${table.decidedAt} is null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'revoked'
        and ${table.revokedAt} is not null
      )`
    )
  ]
);

export const highRiskDeviceActionGrants = pgTable(
  "high_risk_device_action_grants",
  {
    id: id(),
    confirmationId: uuid("confirmation_id")
      .notNull()
      .references(() => highRiskBrowserConfirmations.id, {
        onDelete: "restrict"
      }),
    deviceCredentialId: uuid("device_credential_id").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    upstreamBackendId: text("upstream_backend_id").notNull(),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict"
    }),
    operationFamily: text("operation_family").notNull(),
    action: text("action").notNull(),
    targetId: uuid("target_id"),
    scopeHash: text("scope_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    secretCommitment: text("secret_commitment").notNull().unique(),
    state: highRiskActionGrantState("state").notNull().default("active"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    createdAt: now(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReasonCode: text("revocation_reason_code")
  },
  (table) => [
    foreignKey({
      columns: [
        table.deviceCredentialId,
        table.ownerUserId,
        table.upstreamBackendId
      ],
      foreignColumns: [
        deviceCredentials.id,
        deviceCredentials.ownerUserId,
        deviceCredentials.upstreamBackendId
      ],
      name: "high_risk_action_grants_device_binding_fk"
    }).onDelete("restrict"),
    unique("high_risk_action_grants_confirmation_unique").on(
      table.confirmationId
    ),
    index("high_risk_action_grants_active_idx")
      .on(table.deviceCredentialId, table.expiresAt)
      .where(sql`${table.state} = 'active'`),
    check(
      "high_risk_action_grants_operation_check",
      sql`${table.operationFamily} ~ '^[A-Za-z0-9_.:-]+$'
        and ${table.action} ~ '^[A-Za-z0-9_.:-]+$'`
    ),
    check(
      "high_risk_action_grants_hash_check",
      sql`length(${table.scopeHash}) = 64
        and length(${table.requestHash}) = 64
        and ${table.secretCommitment} ~ '^v1:[0-9A-Fa-f]{64}$'`
    ),
    check(
      "high_risk_action_grants_use_check",
      sql`${table.maxUses} = 1
        and ${table.useCount} between 0 and ${table.maxUses}
        and ${table.expiresAt} > ${table.createdAt}`
    ),
    check(
      "high_risk_action_grants_lifecycle_check",
      sql`(
        ${table.state} = 'active'
        and ${table.useCount} = 0
        and ${table.consumedAt} is null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'consumed'
        and ${table.useCount} = 1
        and ${table.consumedAt} is not null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'expired'
        and ${table.useCount} = 0
        and ${table.consumedAt} is null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'revoked'
        and ${table.useCount} = 0
        and ${table.consumedAt} is null
        and ${table.revokedAt} is not null
      )`
    )
  ]
);

export const highRiskActionGrantExecutionReceipts = pgTable(
  "high_risk_action_grant_execution_receipts",
  {
    id: id(),
    actionGrantId: uuid("action_grant_id")
      .notNull()
      .references(() => highRiskDeviceActionGrants.id, {
        onDelete: "restrict"
      }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    statusCode: integer("status_code").notNull(),
    receiptBody: jsonb("receipt_body").$type<unknown>().notNull(),
    receiptHash: text("receipt_hash").notNull(),
    createdAt: now()
  },
  (table) => [
    unique("high_risk_action_grant_execution_receipts_action_grant_unique").on(
      table.actionGrantId
    ),
    index("high_risk_action_grant_execution_receipts_owner_idx").on(
      table.ownerUserId,
      table.createdAt
    ),
    check(
      "high_risk_action_grant_execution_receipts_status_code_check",
      sql`${table.statusCode} between 100 and 599`
    ),
    check(
      "high_risk_action_grant_execution_receipts_hash_check",
      sql`length(${table.receiptHash}) = 64`
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

export const historicalImportRuns = pgTable(
  "historical_import_runs",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    state: historicalImportState("state").notNull().default("discovered"),
    sourceCount: integer("source_count").notNull().default(0),
    completedSourceCount: integer("completed_source_count")
      .notNull()
      .default(0),
    failedSourceCount: integer("failed_source_count").notNull().default(0),
    skippedSourceCount: integer("skipped_source_count").notNull().default(0),
    discoveredRecordCount: integer("discovered_record_count")
      .notNull()
      .default(0),
    importedRecordCount: integer("imported_record_count").notNull().default(0),
    skippedRecordCount: integer("skipped_record_count").notNull().default(0),
    scannedByteCount: bigint("scanned_byte_count", { mode: "number" })
      .notNull()
      .default(0),
    retryCount: integer("retry_count").notNull().default(0),
    failureReason: text("failure_reason"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    importStartedAt: timestamp("import_started_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    index("historical_import_runs_owner_updated_idx").on(
      table.ownerUserId,
      table.updatedAt.desc()
    ),
    unique("historical_import_runs_id_owner_unique").on(
      table.id,
      table.ownerUserId
    ),
    check(
      "historical_import_runs_counters_check",
      sql`${table.sourceCount} >= 0 and ${table.completedSourceCount} >= 0 and ${table.failedSourceCount} >= 0 and ${table.skippedSourceCount} >= 0 and ${table.discoveredRecordCount} >= 0 and ${table.importedRecordCount} >= 0 and ${table.skippedRecordCount} >= 0 and ${table.scannedByteCount} >= 0 and ${table.retryCount} between 0 and 1000`
    )
  ]
);

export const historicalImportSources = pgTable(
  "historical_import_sources",
  {
    id: id(),
    runId: uuid("run_id").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    state: historicalImportState("state").notNull().default("discovered"),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => conversationSourceArtifacts.id, {
        onDelete: "cascade"
      }),
    aiClient: text("ai_client").notNull(),
    sourceEventFrom: timestamp("source_event_from", { withTimezone: true }),
    sourceEventTo: timestamp("source_event_to", { withTimezone: true }),
    discoveredRecordCount: integer("discovered_record_count")
      .notNull()
      .default(0),
    importedRecordCount: integer("imported_record_count").notNull().default(0),
    skippedRecordCount: integer("skipped_record_count").notNull().default(0),
    malformedRecordCount: integer("malformed_record_count")
      .notNull()
      .default(0),
    rawIngestedRecordCount: integer("raw_ingested_record_count")
      .notNull()
      .default(0),
    projectedRecordCount: integer("projected_record_count")
      .notNull()
      .default(0),
    embeddingEligibleEventCount: integer("embedding_eligible_event_count")
      .notNull()
      .default(0),
    embeddedEventCount: integer("embedded_event_count").notNull().default(0),
    lcmEligibleEventCount: integer("lcm_eligible_event_count")
      .notNull()
      .default(0),
    lcmCompletedEventCount: integer("lcm_completed_event_count")
      .notNull()
      .default(0),
    retryCount: integer("retry_count").notNull().default(0),
    failureReason: text("failure_reason"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    detectedProject: jsonb("detected_project")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    importStartedAt: timestamp("import_started_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    foreignKey({
      columns: [table.runId, table.ownerUserId],
      foreignColumns: [
        historicalImportRuns.id,
        historicalImportRuns.ownerUserId
      ],
      name: "historical_import_sources_run_owner_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.artifactId, table.ownerUserId],
      foreignColumns: [
        conversationSourceArtifacts.id,
        conversationSourceArtifacts.ownerUserId
      ],
      name: "historical_import_sources_artifact_owner_fk"
    }).onDelete("cascade"),
    uniqueIndex("historical_import_sources_identity_unique").on(
      table.ownerUserId,
      table.artifactId
    ),
    index("historical_import_sources_run_state_idx").on(
      table.runId,
      table.state,
      table.updatedAt
    ),
    check(
      "historical_import_sources_counters_check",
      sql`${table.discoveredRecordCount} >= 0 and ${table.importedRecordCount} >= 0 and ${table.skippedRecordCount} >= 0 and ${table.malformedRecordCount} >= 0 and ${table.rawIngestedRecordCount} >= 0 and ${table.projectedRecordCount} >= 0 and ${table.embeddingEligibleEventCount} >= 0 and ${table.embeddedEventCount} between 0 and ${table.embeddingEligibleEventCount} and ${table.lcmEligibleEventCount} >= 0 and ${table.lcmCompletedEventCount} between 0 and ${table.lcmEligibleEventCount} and ${table.retryCount} between 0 and 1000`
    ),
    check(
      "historical_import_sources_event_range_check",
      sql`${table.sourceEventFrom} is null or ${table.sourceEventTo} is null or ${table.sourceEventFrom} <= ${table.sourceEventTo}`
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
    sourceLineNumber: integer("source_line_number"),
    sourceSequence: integer("source_sequence"),
    eventTime: timestamp("event_time", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    importObservedAt: timestamp("import_observed_at", { withTimezone: true }),
    sourceFingerprint: text("source_fingerprint"),
    capturedProject: jsonb("captured_project")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    rawJson: jsonb("raw_json").$type<unknown>().notNull(),
    rawText: text("raw_text"),
    sourceHash: text("source_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    canonicalItemKey: text("canonical_item_key").notNull(),
    canonicalSourcePriority: integer("canonical_source_priority")
      .notNull()
      .default(0),
    projectionStatus: text("projection_status").notNull().default("pending"),
    projectionWorkClass: text("projection_work_class")
      .notNull()
      .default("live_capture_projection"),
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
      table.projectionWorkClass,
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
      "conversation_items_projection_work_class_check",
      sql`${table.projectionWorkClass} in ('live_capture_projection', 'historical_import_backfill')`
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

export const sourceOwnerRepresentationPolicies = pgTable(
  "source_owner_representation_policies",
  {
    id: id(),
    policyId: uuid("policy_id").notNull().defaultRandom(),
    logicalMemoryId: uuid("logical_memory_id")
      .notNull()
      .references((): AnyPgColumn => logicalMemories.id, {
        onDelete: "restrict"
      }),
    sourceOwnerPrincipalId: uuid("source_owner_principal_id").notNull(),
    version: integer("version").notNull(),
    allowedRepresentations: sharedMemoryRepresentation(
      "allowed_representations"
    )
      .array()
      .notNull(),
    policyHash: text("policy_hash").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: now()
  },
  (table) => [
    unique("source_owner_representation_policies_version_unique").on(
      table.policyId,
      table.version
    ),
    unique("source_owner_representation_policies_scope_unique").on(
      table.policyId,
      table.version,
      table.logicalMemoryId,
      table.sourceOwnerPrincipalId
    ),
    uniqueIndex("source_owner_representation_policies_active_unique")
      .on(table.logicalMemoryId, table.sourceOwnerPrincipalId)
      .where(sql`${table.supersededAt} is null`),
    index("source_owner_representation_policies_history_idx").on(
      table.logicalMemoryId,
      table.sourceOwnerPrincipalId,
      table.version.desc()
    ),
    check(
      "source_owner_representation_policies_version_check",
      sql`${table.version} > 0`
    ),
    check(
      "source_owner_representation_policies_allowed_set_check",
      sql`cardinality(${table.allowedRepresentations}) between 1 and 3
        and array_position(${table.allowedRepresentations}, null) is null
        and cardinality(${table.allowedRepresentations}) =
          (case when 'memory_events' = any(${table.allowedRepresentations}) then 1 else 0 end)
          + (case when 'lcm_leaves' = any(${table.allowedRepresentations}) then 1 else 0 end)
          + (case when 'lcm_rollups' = any(${table.allowedRepresentations}) then 1 else 0 end)`
    ),
    check(
      "source_owner_representation_policies_hash_check",
      sql`length(${table.policyHash}) = 64`
    ),
    check(
      "source_owner_representation_policies_lifecycle_check",
      sql`${table.supersededAt} is null or ${table.supersededAt} > ${table.effectiveAt}`
    )
  ]
);

export const teamRepresentationPolicies = pgTable(
  "team_representation_policies",
  {
    id: id(),
    policyId: uuid("policy_id").notNull().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    allowedRepresentations: sharedMemoryRepresentation(
      "allowed_representations"
    )
      .array()
      .notNull(),
    policyHash: text("policy_hash").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: now()
  },
  (table) => [
    unique("team_representation_policies_version_unique").on(
      table.policyId,
      table.version
    ),
    unique("team_representation_policies_scope_unique").on(
      table.policyId,
      table.version,
      table.teamId
    ),
    uniqueIndex("team_representation_policies_active_unique")
      .on(table.teamId)
      .where(sql`${table.supersededAt} is null`),
    index("team_representation_policies_history_idx").on(
      table.teamId,
      table.version.desc()
    ),
    check(
      "team_representation_policies_version_check",
      sql`${table.version} > 0`
    ),
    check(
      "team_representation_policies_allowed_set_check",
      sql`cardinality(${table.allowedRepresentations}) between 1 and 3
        and array_position(${table.allowedRepresentations}, null) is null
        and cardinality(${table.allowedRepresentations}) =
          (case when 'memory_events' = any(${table.allowedRepresentations}) then 1 else 0 end)
          + (case when 'lcm_leaves' = any(${table.allowedRepresentations}) then 1 else 0 end)
          + (case when 'lcm_rollups' = any(${table.allowedRepresentations}) then 1 else 0 end)`
    ),
    check(
      "team_representation_policies_hash_check",
      sql`length(${table.policyHash}) = 64`
    ),
    check(
      "team_representation_policies_lifecycle_check",
      sql`${table.supersededAt} is null or ${table.supersededAt} > ${table.effectiveAt}`
    )
  ]
);

export const workspaceRepresentationPolicies = pgTable(
  "workspace_representation_policies",
  {
    id: id(),
    policyId: uuid("policy_id").notNull().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    version: integer("version").notNull(),
    allowedRepresentations: sharedMemoryRepresentation(
      "allowed_representations"
    )
      .array()
      .notNull(),
    policyHash: text("policy_hash").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: now()
  },
  (table) => [
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "workspace_representation_policies_workspace_team_fk"
    }).onDelete("restrict"),
    unique("workspace_representation_policies_version_unique").on(
      table.policyId,
      table.version
    ),
    unique("workspace_representation_policies_scope_unique").on(
      table.policyId,
      table.version,
      table.teamId,
      table.teamWorkspaceId
    ),
    uniqueIndex("workspace_representation_policies_active_unique")
      .on(table.teamWorkspaceId)
      .where(sql`${table.supersededAt} is null`),
    index("workspace_representation_policies_history_idx").on(
      table.teamWorkspaceId,
      table.version.desc()
    ),
    check(
      "workspace_representation_policies_version_check",
      sql`${table.version} > 0`
    ),
    check(
      "workspace_representation_policies_allowed_set_check",
      sql`cardinality(${table.allowedRepresentations}) between 1 and 3
        and array_position(${table.allowedRepresentations}, null) is null
        and cardinality(${table.allowedRepresentations}) =
          (case when 'memory_events' = any(${table.allowedRepresentations}) then 1 else 0 end)
          + (case when 'lcm_leaves' = any(${table.allowedRepresentations}) then 1 else 0 end)
          + (case when 'lcm_rollups' = any(${table.allowedRepresentations}) then 1 else 0 end)`
    ),
    check(
      "workspace_representation_policies_hash_check",
      sql`length(${table.policyHash}) = 64`
    ),
    check(
      "workspace_representation_policies_lifecycle_check",
      sql`${table.supersededAt} is null or ${table.supersededAt} > ${table.effectiveAt}`
    )
  ]
);

export const sharedSourceArtifacts = pgTable(
  "shared_source_artifacts",
  {
    id: id(),
    logicalMemoryId: uuid("logical_memory_id")
      .notNull()
      .references((): AnyPgColumn => logicalMemories.id, {
        onDelete: "restrict"
      }),
    remoteReplicaId: uuid("remote_replica_id")
      .notNull()
      .references((): AnyPgColumn => memoryReplicas.id, {
        onDelete: "restrict"
      }),
    syncRelationshipId: uuid("sync_relationship_id")
      .notNull()
      .references(() => crossIdentitySyncRelationships.id, {
        onDelete: "restrict"
      }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    ownerPrincipalId: uuid("owner_principal_id").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    representation: sharedMemoryRepresentation("representation").notNull(),
    artifactSchemaVersion: integer("artifact_schema_version")
      .notNull()
      .default(1),
    sourceRevision: bigint("source_revision", { mode: "number" }).notNull(),
    sourceCursor: bigint("source_cursor", { mode: "number" }).notNull(),
    packageSequence: bigint("package_sequence", { mode: "number" }).notNull(),
    sourceHash: text("source_hash").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    artifactHash: text("artifact_hash").notNull(),
    redactedContentHash: text("redacted_content_hash").notNull(),
    sourceOwnerPolicyId: uuid("source_owner_policy_id").notNull(),
    sourceOwnerPolicyVersion: integer("source_owner_policy_version").notNull(),
    teamPolicyId: uuid("team_policy_id").notNull(),
    teamPolicyVersion: integer("team_policy_version").notNull(),
    workspacePolicyId: uuid("workspace_policy_id").notNull(),
    workspacePolicyVersion: integer("workspace_policy_version").notNull(),
    representationPolicyRevision: integer(
      "representation_policy_revision"
    ).notNull(),
    representationPolicyHash: text("representation_policy_hash").notNull(),
    contentPolicyVersion: integer("content_policy_version").notNull(),
    contentPolicyHash: text("content_policy_hash").notNull(),
    classifierVersion: integer("classifier_version").notNull(),
    classifierHash: text("classifier_hash").notNull(),
    sourceDeploymentIdentityId: uuid("source_deployment_identity_id")
      .notNull()
      .references(() => deploymentIdentities.id, {
        onDelete: "restrict"
      }),
    remoteUserIdentityId: uuid("remote_user_identity_id")
      .notNull()
      .references(() => syncExternalUserIdentities.id, {
        onDelete: "restrict"
      }),
    deviceCredentialId: uuid("device_credential_id")
      .notNull()
      .references(() => deviceCredentials.id, { onDelete: "restrict" }),
    deviceProvenanceHash: text("device_provenance_hash").notNull(),
    createdAt: now(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason")
  },
  (table) => [
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "shared_source_artifacts_workspace_team_fk"
    }).onDelete("restrict"),
    // The owner-policy binding can be an inactive proposal until the final
    // reviewed bundle activates it. Repository validation binds the proposal
    // through the artifact and representation-policy hashes.
    foreignKey({
      columns: [table.teamPolicyId, table.teamPolicyVersion, table.teamId],
      foreignColumns: [
        teamRepresentationPolicies.policyId,
        teamRepresentationPolicies.version,
        teamRepresentationPolicies.teamId
      ],
      name: "shared_source_artifacts_team_policy_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.workspacePolicyId,
        table.workspacePolicyVersion,
        table.teamId,
        table.teamWorkspaceId
      ],
      foreignColumns: [
        workspaceRepresentationPolicies.policyId,
        workspaceRepresentationPolicies.version,
        workspaceRepresentationPolicies.teamId,
        workspaceRepresentationPolicies.teamWorkspaceId
      ],
      name: "shared_source_artifacts_workspace_policy_fk"
    }).onDelete("restrict"),
    unique("shared_source_artifacts_hash_unique").on(table.artifactHash),
    unique("shared_source_artifacts_scope_unique").on(
      table.id,
      table.logicalMemoryId,
      table.remoteReplicaId,
      table.teamId,
      table.teamWorkspaceId
    ),
    uniqueIndex("shared_source_artifacts_current_unique").on(
      table.logicalMemoryId,
      table.remoteReplicaId,
      table.teamId,
      table.teamWorkspaceId,
      table.representation,
      table.sourceRevision,
      table.artifactHash
    ),
    index("shared_source_artifacts_owner_idx").on(
      table.ownerPrincipalId,
      table.representation,
      table.createdAt.desc()
    ),
    check(
      "shared_source_artifacts_version_check",
      sql`${table.artifactSchemaVersion} = 1
        and ${table.sourceRevision} >= 0
        and ${table.sourceCursor} >= 0
        and ${table.packageSequence} >= 0
        and ${table.sourceOwnerPolicyVersion} > 0
        and ${table.teamPolicyVersion} > 0
        and ${table.workspacePolicyVersion} > 0
        and ${table.representationPolicyRevision} > 0
        and ${table.contentPolicyVersion} > 0
        and ${table.classifierVersion} > 0`
    ),
    check(
      "shared_source_artifacts_hash_check",
      sql`length(${table.sourceHash}) = 64
        and length(${table.manifestHash}) = 64
        and length(${table.artifactHash}) = 64
        and length(${table.redactedContentHash}) = 64
        and length(${table.representationPolicyHash}) = 64
        and length(${table.contentPolicyHash}) = 64
        and length(${table.classifierHash}) = 64
        and length(${table.deviceProvenanceHash}) = 64`
    ),
    check(
      "shared_source_artifacts_revision_binding_check",
      sql`${table.sourceRevision} = ${table.sourceCursor}`
    )
  ]
);

export const sharedSourcePreviews = pgTable(
  "shared_source_previews",
  {
    id: id(),
    sourceArtifactId: uuid("source_artifact_id")
      .notNull()
      .references(() => sharedSourceArtifacts.id, { onDelete: "restrict" }),
    logicalMemoryId: uuid("logical_memory_id")
      .notNull()
      .references((): AnyPgColumn => logicalMemories.id, {
        onDelete: "restrict"
      }),
    remoteReplicaId: uuid("remote_replica_id")
      .notNull()
      .references((): AnyPgColumn => memoryReplicas.id, {
        onDelete: "restrict"
      }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    ownerPrincipalId: uuid("owner_principal_id").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    representation: sharedMemoryRepresentation("representation").notNull(),
    previewSchemaVersion: integer("preview_schema_version")
      .notNull()
      .default(1),
    previewRevision: integer("preview_revision").notNull().default(1),
    previewHash: text("preview_hash").notNull(),
    sourceRevision: bigint("source_revision", { mode: "number" }).notNull(),
    sourceHash: text("source_hash").notNull(),
    redactedContentHash: text("redacted_content_hash").notNull(),
    createdAt: now(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason")
  },
  (table) => [
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "shared_source_previews_workspace_team_fk"
    }).onDelete("restrict"),
    unique("shared_source_previews_hash_unique").on(table.previewHash),
    unique("shared_source_previews_scope_unique").on(
      table.id,
      table.sourceArtifactId,
      table.logicalMemoryId,
      table.remoteReplicaId,
      table.teamId,
      table.teamWorkspaceId
    ),
    uniqueIndex("shared_source_previews_artifact_unique").on(
      table.sourceArtifactId,
      table.previewHash
    ),
    index("shared_source_previews_owner_idx").on(
      table.ownerPrincipalId,
      table.representation,
      table.createdAt.desc()
    ),
    check(
      "shared_source_previews_version_check",
      sql`${table.previewSchemaVersion} = 1
        and ${table.previewRevision} > 0
        and ${table.sourceRevision} >= 0`
    ),
    check(
      "shared_source_previews_hash_check",
      sql`length(${table.previewHash}) = 64
        and length(${table.sourceHash}) = 64
        and length(${table.redactedContentHash}) = 64`
    )
  ]
);

export const sourceOwnerRepresentationConsents = pgTable(
  "source_owner_representation_consents",
  {
    id: id(),
    logicalMemoryId: uuid("logical_memory_id")
      .notNull()
      .references((): AnyPgColumn => logicalMemories.id, {
        onDelete: "restrict"
      }),
    remoteReplicaId: uuid("remote_replica_id")
      .notNull()
      .references((): AnyPgColumn => memoryReplicas.id, {
        onDelete: "restrict"
      }),
    sourceOwnerPrincipalId: uuid("source_owner_principal_id").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    sourceOwnerPolicyId: uuid("source_owner_policy_id").notNull(),
    sourceOwnerPolicyVersion: integer("source_owner_policy_version").notNull(),
    teamPolicyId: uuid("team_policy_id").notNull(),
    teamPolicyVersion: integer("team_policy_version").notNull(),
    workspacePolicyId: uuid("workspace_policy_id").notNull(),
    workspacePolicyVersion: integer("workspace_policy_version").notNull(),
    mode: sharedMemoryConsentMode("mode").notNull(),
    state: sharedMemoryConsentState("state").notNull().default("pending"),
    consentVersion: integer("consent_version").notNull().default(1),
    allowedRepresentations: sharedMemoryRepresentation(
      "allowed_representations"
    )
      .array()
      .notNull(),
    selectedRepresentation: sharedMemoryRepresentation(
      "selected_representation"
    ).notNull(),
    previewId: uuid("preview_id")
      .notNull()
      .references(() => sharedSourcePreviews.id, {
        onDelete: "restrict"
      }),
    previewRevision: integer("preview_revision").notNull(),
    previewHash: text("preview_hash").notNull(),
    sourceRevision: bigint("source_revision", { mode: "number" }).notNull(),
    maximumAuthorizedSourceRevision: bigint(
      "maximum_authorized_source_revision",
      {
        mode: "number"
      }
    ),
    sourceHash: text("source_hash").notNull(),
    representationPolicyRevision: integer(
      "representation_policy_revision"
    ).notNull(),
    representationPolicyHash: text("representation_policy_hash").notNull(),
    contentPolicyVersion: integer("content_policy_version").notNull(),
    contentPolicyHash: text("content_policy_hash").notNull(),
    classifierVersion: integer("classifier_version").notNull(),
    classifierHash: text("classifier_hash").notNull(),
    redactedContentHash: text("redacted_content_hash").notNull(),
    createdAt: now(),
    updatedAt: updatedNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    stateReasonCode: text("state_reason_code")
  },
  (table) => [
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "source_owner_consents_workspace_team_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.sourceOwnerPolicyId,
        table.sourceOwnerPolicyVersion,
        table.logicalMemoryId,
        table.sourceOwnerPrincipalId
      ],
      foreignColumns: [
        sourceOwnerRepresentationPolicies.policyId,
        sourceOwnerRepresentationPolicies.version,
        sourceOwnerRepresentationPolicies.logicalMemoryId,
        sourceOwnerRepresentationPolicies.sourceOwnerPrincipalId
      ],
      name: "source_owner_consents_owner_policy_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.teamPolicyId, table.teamPolicyVersion, table.teamId],
      foreignColumns: [
        teamRepresentationPolicies.policyId,
        teamRepresentationPolicies.version,
        teamRepresentationPolicies.teamId
      ],
      name: "source_owner_consents_team_policy_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.workspacePolicyId,
        table.workspacePolicyVersion,
        table.teamId,
        table.teamWorkspaceId
      ],
      foreignColumns: [
        workspaceRepresentationPolicies.policyId,
        workspaceRepresentationPolicies.version,
        workspaceRepresentationPolicies.teamId,
        workspaceRepresentationPolicies.teamWorkspaceId
      ],
      name: "source_owner_consents_workspace_policy_fk"
    }).onDelete("restrict"),
    unique("source_owner_consents_grant_binding_unique").on(
      table.id,
      table.logicalMemoryId,
      table.remoteReplicaId,
      table.sourceOwnerPrincipalId,
      table.teamId,
      table.teamWorkspaceId
    ),
    unique("source_owner_consents_representation_binding_unique").on(
      table.id,
      table.logicalMemoryId,
      table.teamId,
      table.teamWorkspaceId
    ),
    index("source_owner_consents_owner_state_idx").on(
      table.sourceOwnerPrincipalId,
      table.state,
      table.updatedAt.desc()
    ),
    check(
      "source_owner_consents_version_check",
      sql`${table.consentVersion} > 0`
    ),
    check(
      "source_owner_consents_revision_check",
      sql`${table.previewRevision} > 0
        and ${table.sourceRevision} >= 0
        and ${table.representationPolicyRevision} > 0
        and ${table.contentPolicyVersion} > 0
        and ${table.classifierVersion} > 0
        and ${table.sourceOwnerPolicyVersion} > 0
        and ${table.teamPolicyVersion} > 0
        and ${table.workspacePolicyVersion} > 0`
    ),
    check(
      "source_owner_consents_hash_check",
      sql`length(${table.previewHash}) = 64
        and length(${table.sourceHash}) = 64
        and length(${table.representationPolicyHash}) = 64
        and length(${table.contentPolicyHash}) = 64
        and length(${table.classifierHash}) = 64
        and length(${table.redactedContentHash}) = 64`
    ),
    check(
      "source_owner_consents_allowed_set_check",
      sql`cardinality(${table.allowedRepresentations}) between 1 and 3
        and array_position(${table.allowedRepresentations}, null) is null
        and ${table.selectedRepresentation} = any(${table.allowedRepresentations})
        and cardinality(${table.allowedRepresentations}) =
          (case when 'memory_events' = any(${table.allowedRepresentations}) then 1 else 0 end)
          + (case when 'lcm_leaves' = any(${table.allowedRepresentations}) then 1 else 0 end)
          + (case when 'lcm_rollups' = any(${table.allowedRepresentations}) then 1 else 0 end)`
    ),
    check(
      "source_owner_consents_mode_check",
      sql`(${table.mode} = 'snapshot' and ${table.maximumAuthorizedSourceRevision} = ${table.sourceRevision})
        or (${table.mode} = 'continuous' and ${table.maximumAuthorizedSourceRevision} is null)`
    ),
    check(
      "source_owner_consents_lifecycle_check",
      sql`(
        ${table.state} = 'pending'
        and ${table.activatedAt} is null
        and ${table.pausedAt} is null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'active'
        and ${table.activatedAt} is not null
        and ${table.pausedAt} is null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'paused'
        and ${table.activatedAt} is not null
        and ${table.pausedAt} is not null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'revoked'
        and ${table.activatedAt} is not null
        and ${table.revokedAt} is not null
      ) or (
        ${table.state} = 'expired'
        and ${table.revokedAt} is null
        and ${table.expiresAt} is not null
      )`
    )
  ]
);

export const teamSessionShareGrants = pgTable(
  "team_session_share_grants",
  {
    id: id(),
    logicalGrantId: uuid("logical_grant_id").notNull().defaultRandom(),
    logicalMemoryId: uuid("logical_memory_id").references(
      (): AnyPgColumn => logicalMemories.id,
      { onDelete: "restrict" }
    ),
    remoteReplicaId: uuid("remote_replica_id").references(
      (): AnyPgColumn => memoryReplicas.id,
      { onDelete: "restrict" }
    ),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    ownerPrincipalId: uuid("owner_principal_id"),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    consentId: uuid("consent_id"),
    sourceOwnerPolicyId: uuid("source_owner_policy_id"),
    sourceOwnerPolicyVersion: integer("source_owner_policy_version"),
    teamPolicyId: uuid("team_policy_id"),
    teamPolicyVersion: integer("team_policy_version"),
    workspacePolicyId: uuid("workspace_policy_id"),
    workspacePolicyVersion: integer("workspace_policy_version"),
    ownerAllowedRepresentations: sharedMemoryRepresentation(
      "owner_allowed_representations"
    ).array(),
    activeRepresentation: sharedMemoryRepresentation("active_representation"),
    representationPolicyRevision: integer("representation_policy_revision"),
    contentPolicyVersion: integer("content_policy_version"),
    classifierVersion: integer("classifier_version"),
    sourceRevision: bigint("source_revision", { mode: "number" }),
    grantVersion: integer("grant_version").notNull().default(1),
    revocationEpoch: bigint("revocation_epoch", { mode: "number" })
      .notNull()
      .default(0),
    lifecycle: shareGrantLifecycle("lifecycle").notNull().default("active"),
    creatorAuthority: text("creator_authority"),
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
      .default("active_team_share"),
    retentionPolicyId: uuid("retention_policy_id"),
    retentionPolicyVersion: integer("retention_policy_version"),
    retentionTriggeredAt: timestamp("retention_triggered_at", {
      withTimezone: true
    }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    activeRetentionDecisionId: uuid("active_retention_decision_id").references(
      (): AnyPgColumn => retentionDecisions.id,
      { onDelete: "restrict" }
    ),
    activePurgeJobId: uuid("active_purge_job_id").references(
      (): AnyPgColumn => purgeJobs.id,
      { onDelete: "restrict" }
    ),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    purgeCompletedAt: timestamp("purge_completed_at", { withTimezone: true })
  },
  (table) => [
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "team_session_share_grants_workspace_team_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.consentId,
        table.logicalMemoryId,
        table.remoteReplicaId,
        table.ownerPrincipalId,
        table.teamId,
        table.teamWorkspaceId
      ],
      foreignColumns: [
        sourceOwnerRepresentationConsents.id,
        sourceOwnerRepresentationConsents.logicalMemoryId,
        sourceOwnerRepresentationConsents.remoteReplicaId,
        sourceOwnerRepresentationConsents.sourceOwnerPrincipalId,
        sourceOwnerRepresentationConsents.teamId,
        sourceOwnerRepresentationConsents.teamWorkspaceId
      ],
      name: "team_session_share_grants_consent_scope_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.sourceOwnerPolicyId,
        table.sourceOwnerPolicyVersion,
        table.logicalMemoryId,
        table.ownerPrincipalId
      ],
      foreignColumns: [
        sourceOwnerRepresentationPolicies.policyId,
        sourceOwnerRepresentationPolicies.version,
        sourceOwnerRepresentationPolicies.logicalMemoryId,
        sourceOwnerRepresentationPolicies.sourceOwnerPrincipalId
      ],
      name: "team_session_share_grants_owner_policy_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.teamPolicyId, table.teamPolicyVersion, table.teamId],
      foreignColumns: [
        teamRepresentationPolicies.policyId,
        teamRepresentationPolicies.version,
        teamRepresentationPolicies.teamId
      ],
      name: "team_session_share_grants_team_policy_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.workspacePolicyId,
        table.workspacePolicyVersion,
        table.teamId,
        table.teamWorkspaceId
      ],
      foreignColumns: [
        workspaceRepresentationPolicies.policyId,
        workspaceRepresentationPolicies.version,
        workspaceRepresentationPolicies.teamId,
        workspaceRepresentationPolicies.teamWorkspaceId
      ],
      name: "team_session_share_grants_workspace_policy_fk"
    }).onDelete("restrict"),
    unique("team_session_share_grants_logical_id_unique").on(
      table.logicalGrantId
    ),
    unique("team_session_share_grants_scope_unique").on(
      table.id,
      table.teamId,
      table.teamWorkspaceId,
      table.logicalMemoryId
    ),
    uniqueIndex("team_session_share_grants_destination_unique")
      .on(table.logicalMemoryId, table.teamWorkspaceId)
      .where(sql`${table.logicalMemoryId} is not null`),
    index("team_session_share_grants_workspace_active_idx")
      .on(table.teamWorkspaceId, table.createdAt.desc())
      .where(sql`${table.revokedAt} is null`),
    index("team_session_share_grants_owner_idx").on(
      table.ownerPrincipalId,
      table.createdAt.desc()
    ),
    check(
      "team_session_share_grants_identity_check",
      sql`${table.logicalMemoryId} is not null
        and ${table.remoteReplicaId} is not null
        and ${table.ownerPrincipalId} is not null
        and ${table.consentId} is not null
        and ${table.sourceOwnerPolicyId} is not null
        and ${table.sourceOwnerPolicyVersion} > 0
        and ${table.teamPolicyId} is not null
        and ${table.teamPolicyVersion} > 0
        and ${table.workspacePolicyId} is not null
        and ${table.workspacePolicyVersion} > 0
        and ${table.creatorAuthority} is not null
        and length(trim(${table.creatorAuthority})) > 0`
    ),
    check(
      "team_session_share_grants_representation_check",
      sql`${table.ownerAllowedRepresentations} is not null
        and cardinality(${table.ownerAllowedRepresentations}) > 0
        and ${table.representationPolicyRevision} > 0
        and ${table.contentPolicyVersion} > 0
        and ${table.classifierVersion} > 0
        and ${table.sourceRevision} >= 0
        and (
          (${table.lifecycle} = 'active'
            and ${table.activeRepresentation} is not null
            and ${table.activeRepresentation} = any(${table.ownerAllowedRepresentations}))
          or ${table.lifecycle} <> 'active'
        )`
    ),
    check(
      "team_session_share_grants_version_check",
      sql`${table.grantVersion} > 0 and ${table.revocationEpoch} >= 0`
    ),
    check(
      "team_session_share_grants_retention_check",
      sql`(${table.retentionPolicyId} is null and ${table.retentionPolicyVersion} is null)
        or (${table.retentionPolicyId} is not null and ${table.retentionPolicyVersion} > 0)`
    ),
    check(
      "team_session_share_grants_active_retention_check",
      sql`(
        ${table.activeRetentionDecisionId} is null
        and ${table.activePurgeJobId} is null
      ) or (
        ${table.activeRetentionDecisionId} is not null
        and ${table.activePurgeJobId} is not null
        and ${table.retentionPolicyId} is not null
        and ${table.retentionPolicyVersion} > 0
        and ${table.retentionTriggeredAt} is not null
        and ${table.retainUntil} is not null
      )`
    )
  ]
);

export const teamMemoryRepresentations = pgTable(
  "team_memory_representations",
  {
    id: id(),
    shareGrantId: uuid("share_grant_id").notNull(),
    consentId: uuid("consent_id").notNull(),
    sourcePreviewId: uuid("source_preview_id")
      .notNull()
      .references(() => sharedSourcePreviews.id, {
        onDelete: "restrict"
      }),
    sourceArtifactId: uuid("source_artifact_id")
      .notNull()
      .references(() => sharedSourceArtifacts.id, {
        onDelete: "restrict"
      }),
    teamId: uuid("team_id").notNull(),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    logicalMemoryId: uuid("logical_memory_id").notNull(),
    representation: sharedMemoryRepresentation("representation").notNull(),
    sourceRevision: bigint("source_revision", { mode: "number" }).notNull(),
    sourceRevisionHash: text("source_revision_hash").notNull(),
    provenanceHash: text("provenance_hash").notNull(),
    sourceOwnerPolicyId: uuid("source_owner_policy_id").notNull(),
    sourceOwnerPolicyVersion: integer("source_owner_policy_version").notNull(),
    teamPolicyId: uuid("team_policy_id").notNull(),
    teamPolicyVersion: integer("team_policy_version").notNull(),
    workspacePolicyId: uuid("workspace_policy_id").notNull(),
    workspacePolicyVersion: integer("workspace_policy_version").notNull(),
    representationPolicyRevision: integer(
      "representation_policy_revision"
    ).notNull(),
    contentPolicyVersion: integer("content_policy_version").notNull(),
    classifierVersion: integer("classifier_version").notNull(),
    recordVersion: integer("record_version").notNull().default(1),
    state: memoryRepresentationState("state").notNull().default("pending"),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdAt: now(),
    updatedAt: updatedNow(),
    freshnessEvaluatedAt: timestamp("freshness_evaluated_at", {
      withTimezone: true
    }),
    availableAt: timestamp("available_at", { withTimezone: true }),
    staleAt: timestamp("stale_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReasonCode: text("invalidation_reason_code"),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    purgeCompletedAt: timestamp("purge_completed_at", { withTimezone: true })
  },
  (table) => [
    foreignKey({
      columns: [
        table.shareGrantId,
        table.teamId,
        table.teamWorkspaceId,
        table.logicalMemoryId
      ],
      foreignColumns: [
        teamSessionShareGrants.id,
        teamSessionShareGrants.teamId,
        teamSessionShareGrants.teamWorkspaceId,
        teamSessionShareGrants.logicalMemoryId
      ],
      name: "team_memory_representations_grant_scope_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.consentId,
        table.logicalMemoryId,
        table.teamId,
        table.teamWorkspaceId
      ],
      foreignColumns: [
        sourceOwnerRepresentationConsents.id,
        sourceOwnerRepresentationConsents.logicalMemoryId,
        sourceOwnerRepresentationConsents.teamId,
        sourceOwnerRepresentationConsents.teamWorkspaceId
      ],
      name: "team_memory_representations_consent_scope_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sourceOwnerPolicyId, table.sourceOwnerPolicyVersion],
      foreignColumns: [
        sourceOwnerRepresentationPolicies.policyId,
        sourceOwnerRepresentationPolicies.version
      ],
      name: "team_memory_representations_owner_policy_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.teamPolicyId, table.teamPolicyVersion, table.teamId],
      foreignColumns: [
        teamRepresentationPolicies.policyId,
        teamRepresentationPolicies.version,
        teamRepresentationPolicies.teamId
      ],
      name: "team_memory_representations_team_policy_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.workspacePolicyId,
        table.workspacePolicyVersion,
        table.teamId,
        table.teamWorkspaceId
      ],
      foreignColumns: [
        workspaceRepresentationPolicies.policyId,
        workspaceRepresentationPolicies.version,
        workspaceRepresentationPolicies.teamId,
        workspaceRepresentationPolicies.teamWorkspaceId
      ],
      name: "team_memory_representations_workspace_policy_fk"
    }).onDelete("restrict"),
    unique("team_memory_representations_revision_unique").on(
      table.shareGrantId,
      table.representation,
      table.sourceRevision,
      table.representationPolicyRevision,
      table.contentPolicyVersion,
      table.classifierVersion
    ),
    unique("team_memory_representations_scope_unique").on(
      table.id,
      table.shareGrantId,
      table.teamId,
      table.teamWorkspaceId,
      table.logicalMemoryId
    ),
    unique("team_memory_representations_exact_scope_unique").on(
      table.id,
      table.shareGrantId,
      table.teamId,
      table.teamWorkspaceId,
      table.logicalMemoryId,
      table.representation,
      table.sourceRevision
    ),
    index("team_memory_representations_grant_state_idx").on(
      table.shareGrantId,
      table.state,
      table.sourceRevision.desc()
    ),
    check(
      "team_memory_representations_version_check",
      sql`${table.recordVersion} > 0
        and ${table.sourceRevision} >= 0
        and ${table.sourceOwnerPolicyVersion} > 0
        and ${table.teamPolicyVersion} > 0
        and ${table.workspacePolicyVersion} > 0
        and ${table.representationPolicyRevision} > 0
        and ${table.contentPolicyVersion} > 0
        and ${table.classifierVersion} > 0
        and ${table.chunkCount} >= 0`
    ),
    check(
      "team_memory_representations_hash_check",
      sql`length(${table.sourceRevisionHash}) = 64
        and length(${table.provenanceHash}) = 64`
    ),
    check(
      "team_memory_representations_lifecycle_check",
      sql`(
        ${table.state} = 'pending'
        and ${table.availableAt} is null
        and ${table.staleAt} is null
        and ${table.invalidatedAt} is null
        and ${table.tombstonedAt} is null
        and ${table.purgeCompletedAt} is null
      ) or (
        ${table.state} = 'available'
        and ${table.availableAt} is not null
        and ${table.staleAt} is null
        and ${table.invalidatedAt} is null
        and ${table.tombstonedAt} is null
        and ${table.purgeCompletedAt} is null
      ) or (
        ${table.state} = 'stale'
        and ${table.availableAt} is not null
        and ${table.staleAt} is not null
        and ${table.invalidatedAt} is null
        and ${table.tombstonedAt} is null
        and ${table.purgeCompletedAt} is null
      ) or (
        ${table.state} = 'invalidated'
        and ${table.invalidatedAt} is not null
        and ${table.tombstonedAt} is null
        and ${table.purgeCompletedAt} is null
      ) or (
        ${table.state} = 'purge_pending'
        and ${table.tombstonedAt} is not null
        and ${table.purgeCompletedAt} is null
      ) or (
        ${table.state} = 'purged'
        and ${table.tombstonedAt} is not null
        and ${table.purgeCompletedAt} is not null
      )`
    )
  ]
);

export const teamMemoryRepresentationChunks = pgTable(
  "team_memory_representation_chunks",
  {
    id: id(),
    representationId: uuid("representation_id").notNull(),
    shareGrantId: uuid("share_grant_id").notNull(),
    teamId: uuid("team_id").notNull(),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    logicalMemoryId: uuid("logical_memory_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    envelopeVersion: integer("envelope_version").notNull(),
    providerMode: text("provider_mode").notNull(),
    algorithm: text("algorithm").notNull(),
    keyId: text("key_id").notNull(),
    keyVersion: integer("key_version").notNull(),
    ciphertext: text("ciphertext").notNull(),
    ciphertextHash: text("ciphertext_hash").notNull(),
    nonce: text("nonce").notNull(),
    tag: text("tag").notNull(),
    wrappedDek: jsonb("wrapped_dek")
      .$type<EncryptedPayloadEnvelope["wrappedDek"]>()
      .notNull(),
    aad: jsonb("aad").$type<EncryptedPayloadEnvelope["aad"]>().notNull(),
    envelopeCreatedAt: timestamp("envelope_created_at", {
      withTimezone: true
    }).notNull(),
    envelopeReencryptedAt: timestamp("envelope_reencrypted_at", {
      withTimezone: true
    }),
    createdAt: now(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true })
  },
  (table) => [
    foreignKey({
      columns: [
        table.representationId,
        table.shareGrantId,
        table.teamId,
        table.teamWorkspaceId,
        table.logicalMemoryId
      ],
      foreignColumns: [
        teamMemoryRepresentations.id,
        teamMemoryRepresentations.shareGrantId,
        teamMemoryRepresentations.teamId,
        teamMemoryRepresentations.teamWorkspaceId,
        teamMemoryRepresentations.logicalMemoryId
      ],
      name: "team_memory_representation_chunks_scope_fk"
    }).onDelete("restrict"),
    unique("team_memory_representation_chunks_index_unique").on(
      table.representationId,
      table.chunkIndex
    ),
    index("team_memory_representation_chunks_grant_idx").on(
      table.shareGrantId,
      table.representationId,
      table.chunkIndex
    ),
    check(
      "team_memory_representation_chunks_version_check",
      sql`${table.chunkIndex} >= 0
        and ${table.envelopeVersion} > 0
        and ${table.keyVersion} >= 0`
    ),
    check(
      "team_memory_representation_chunks_ciphertext_check",
      sql`length(${table.algorithm}) > 0
        and length(${table.keyId}) > 0
        and length(${table.ciphertext}) > 0
        and length(${table.ciphertextHash}) = 64
        and length(${table.nonce}) > 0
        and length(${table.tag}) > 0`
    )
  ]
);

export const collaborationThreads = pgTable(
  "collaboration_threads",
  {
    id: id(),
    logicalId: uuid("logical_id").notNull().defaultRandom(),
    scope: collaborationScope("scope").notNull(),
    kind: collaborationThreadKind("kind").notNull(),
    personalOwnerUserId: uuid("personal_owner_user_id").references(
      () => users.id,
      { onDelete: "restrict" }
    ),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict"
    }),
    teamWorkspaceId: uuid("team_workspace_id"),
    sharedLogicalMemoryId: uuid("shared_logical_memory_id").references(
      (): AnyPgColumn => logicalMemories.id,
      { onDelete: "restrict" }
    ),
    shareGrantId: uuid("share_grant_id").references(
      () => teamSessionShareGrants.id,
      { onDelete: "restrict" }
    ),
    systemKey: text("system_key"),
    nameMarker: text("name_marker"),
    topicMarker: text("topic_marker"),
    normalizedNameHash: text("normalized_name_hash"),
    participantKey: text("participant_key"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    version: integer("version").notNull().default(1),
    audienceVersion: integer("audience_version").notNull().default(1),
    nextSequence: bigint("next_sequence", { mode: "number" })
      .notNull()
      .default(1),
    lifecycle: collaborationLifecycle("lifecycle").notNull().default("active"),
    createdAt: now(),
    updatedAt: updatedNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    retentionPolicyId: uuid("retention_policy_id"),
    retentionPolicyVersion: integer("retention_policy_version"),
    retentionTriggeredAt: timestamp("retention_triggered_at", {
      withTimezone: true
    }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    purgeCompletedAt: timestamp("purge_completed_at", { withTimezone: true })
  },
  (table) => [
    unique("collaboration_threads_logical_id_unique").on(table.logicalId),
    unique("collaboration_threads_id_scope_kind_unique").on(
      table.id,
      table.scope,
      table.kind
    ),
    unique("collaboration_threads_id_scope_unique").on(table.id, table.scope),
    unique("collaboration_threads_id_personal_owner_unique").on(
      table.id,
      table.personalOwnerUserId
    ),
    unique("collaboration_threads_id_team_unique").on(table.id, table.teamId),
    unique("collaboration_threads_id_workspace_unique").on(
      table.id,
      table.teamWorkspaceId
    ),
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "collaboration_threads_workspace_team_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.shareGrantId,
        table.teamId,
        table.teamWorkspaceId,
        table.sharedLogicalMemoryId
      ],
      foreignColumns: [
        teamSessionShareGrants.id,
        teamSessionShareGrants.teamId,
        teamSessionShareGrants.teamWorkspaceId,
        teamSessionShareGrants.logicalMemoryId
      ],
      name: "collaboration_threads_share_scope_fk"
    }).onDelete("restrict"),
    uniqueIndex("collaboration_threads_notes_owner_unique")
      .on(table.personalOwnerUserId)
      .where(sql`${table.kind} = 'notes_to_self'`),
    uniqueIndex("collaboration_threads_participant_key_unique")
      .on(table.teamId, table.participantKey)
      .where(sql`${table.kind} in ('dm', 'group_dm')`),
    uniqueIndex("collaboration_threads_personal_channel_active_unique")
      .on(table.personalOwnerUserId, table.normalizedNameHash)
      .where(
        sql`${table.kind} = 'personal_channel' and ${table.lifecycle} = 'active'`
      ),
    uniqueIndex("collaboration_threads_workspace_channel_active_unique")
      .on(table.teamWorkspaceId, table.normalizedNameHash)
      .where(
        sql`${table.kind} = 'workspace_channel' and ${table.lifecycle} = 'active'`
      ),
    uniqueIndex("collaboration_threads_workspace_system_key_unique")
      .on(table.teamWorkspaceId, table.systemKey)
      .where(sql`${table.systemKey} is not null`),
    uniqueIndex("collaboration_threads_companion_unique")
      .on(table.teamWorkspaceId, table.sharedLogicalMemoryId)
      .where(sql`${table.kind} = 'shared_session_discussion'`),
    index("collaboration_threads_team_activity_idx").on(
      table.teamId,
      table.lastActivityAt.desc()
    ),
    index("collaboration_threads_personal_activity_idx").on(
      table.personalOwnerUserId,
      table.lastActivityAt.desc()
    ),
    check(
      "collaboration_threads_shape_check",
      sql`(
        ${table.scope} = 'personal'
        and ${table.kind} = 'notes_to_self'
        and ${table.personalOwnerUserId} is not null
        and ${table.teamId} is null
        and ${table.teamWorkspaceId} is null
        and ${table.systemKey} is null
        and ${table.nameMarker} is null
        and ${table.topicMarker} is null
        and ${table.normalizedNameHash} is null
        and ${table.participantKey} is null
        and ${table.sharedLogicalMemoryId} is null
        and ${table.shareGrantId} is null
      ) or (
        ${table.scope} = 'personal'
        and ${table.kind} = 'personal_channel'
        and ${table.personalOwnerUserId} is not null
        and ${table.teamId} is null
        and ${table.teamWorkspaceId} is null
        and ${table.systemKey} is null
        and ${table.nameMarker} = '[koed encrypted collaboration name]'
        and length(${table.normalizedNameHash}) = 64
        and ${table.participantKey} is null
        and ${table.sharedLogicalMemoryId} is null
        and ${table.shareGrantId} is null
      ) or (
        ${table.scope} = 'team'
        and ${table.kind} = 'workspace_channel'
        and ${table.personalOwnerUserId} is null
        and ${table.teamId} is not null
        and ${table.teamWorkspaceId} is not null
        and (
          (
            ${table.systemKey} is null
            and ${table.nameMarker} = '[koed encrypted collaboration name]'
            and length(${table.normalizedNameHash}) = 64
          )
          or (
            ${table.systemKey} = 'workspace.general'
            and (
              (${table.nameMarker} is null and ${table.normalizedNameHash} is null)
              or (${table.nameMarker} = '[koed encrypted collaboration name]' and length(${table.normalizedNameHash}) = 64)
            )
          )
        )
        and ${table.participantKey} is null
        and ${table.sharedLogicalMemoryId} is null
        and ${table.shareGrantId} is null
      ) or (
        ${table.scope} = 'team'
        and ${table.kind} in ('dm', 'group_dm')
        and ${table.personalOwnerUserId} is null
        and ${table.teamId} is not null
        and ${table.teamWorkspaceId} is null
        and ${table.systemKey} is null
        and ${table.nameMarker} is null
        and ${table.topicMarker} is null
        and ${table.normalizedNameHash} is null
        and length(${table.participantKey}) = 64
        and ${table.sharedLogicalMemoryId} is null
        and ${table.shareGrantId} is null
      ) or (
        ${table.scope} = 'team'
        and ${table.kind} = 'shared_session_discussion'
        and ${table.personalOwnerUserId} is null
        and ${table.teamId} is not null
        and ${table.teamWorkspaceId} is not null
        and ${table.systemKey} is null
        and ${table.nameMarker} is null
        and ${table.topicMarker} is null
        and ${table.normalizedNameHash} is null
        and ${table.participantKey} is null
        and ${table.sharedLogicalMemoryId} is not null
        and ${table.shareGrantId} is not null
      )`
    ),
    check(
      "collaboration_threads_system_key_check",
      sql`${table.systemKey} is null or ${table.systemKey} = 'workspace.general'`
    ),
    check("collaboration_threads_version_check", sql`${table.version} > 0`),
    check(
      "collaboration_threads_audience_version_check",
      sql`${table.audienceVersion} > 0`
    ),
    check(
      "collaboration_threads_sequence_check",
      sql`${table.nextSequence} > 0`
    ),
    check(
      "collaboration_threads_topic_marker_check",
      sql`${table.topicMarker} is null or ${table.topicMarker} = '[koed encrypted collaboration topic]'`
    ),
    check(
      "collaboration_threads_lifecycle_check",
      sql`(${table.lifecycle} = 'active' and ${table.archivedAt} is null and ${table.tombstonedAt} is null and ${table.purgeCompletedAt} is null)
        or (${table.lifecycle} = 'archived' and ${table.archivedAt} is not null and ${table.tombstonedAt} is null and ${table.purgeCompletedAt} is null)
        or (${table.lifecycle} in ('tombstoned', 'purge_pending') and ${table.tombstonedAt} is not null and ${table.purgeCompletedAt} is null)
        or (${table.lifecycle} = 'purged' and ${table.tombstonedAt} is not null and ${table.purgeCompletedAt} is not null)`
    ),
    check(
      "collaboration_threads_retention_check",
      sql`(${table.retentionPolicyId} is null and ${table.retentionPolicyVersion} is null)
        or (${table.retentionPolicyId} is not null and ${table.retentionPolicyVersion} > 0)`
    )
  ]
);

export const collaborationParticipants = pgTable(
  "collaboration_participants",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => collaborationThreads.id, { onDelete: "restrict" }),
    scope: collaborationScope("scope").notNull(),
    threadKind: collaborationThreadKind("thread_kind").notNull(),
    personalOwnerUserId: uuid("personal_owner_user_id"),
    teamId: uuid("team_id"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.userId] }),
    unique("collaboration_participants_thread_ordinal_unique").on(
      table.threadId,
      table.ordinal
    ),
    foreignKey({
      columns: [table.threadId, table.scope, table.threadKind],
      foreignColumns: [
        collaborationThreads.id,
        collaborationThreads.scope,
        collaborationThreads.kind
      ],
      name: "collaboration_participants_thread_scope_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.personalOwnerUserId],
      foreignColumns: [
        collaborationThreads.id,
        collaborationThreads.personalOwnerUserId
      ],
      name: "collaboration_participants_personal_owner_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.teamId],
      foreignColumns: [collaborationThreads.id, collaborationThreads.teamId],
      name: "collaboration_participants_thread_team_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.teamId, table.userId],
      foreignColumns: [teamMemberships.teamId, teamMemberships.userId],
      name: "collaboration_participants_membership_fk"
    }).onDelete("restrict"),
    index("collaboration_participants_user_idx").on(
      table.userId,
      table.joinedAt.desc()
    ),
    check(
      "collaboration_participants_shape_check",
      sql`(
        ${table.scope} = 'personal'
        and ${table.threadKind} = 'notes_to_self'
        and ${table.personalOwnerUserId} = ${table.userId}
        and ${table.teamId} is null
        and ${table.ordinal} = 0
      ) or (
        ${table.scope} = 'team'
        and ${table.threadKind} in ('dm', 'group_dm')
        and ${table.personalOwnerUserId} is null
        and ${table.teamId} is not null
        and ${table.ordinal} >= 0
      )`
    )
  ]
);

export const collaborationThreadAudiences = pgTable(
  "collaboration_thread_audiences",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => collaborationThreads.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    memberSetHash: text("member_set_hash").notNull(),
    createdAt: now()
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.version] }),
    index("collaboration_thread_audiences_created_idx").on(
      table.threadId,
      table.createdAt.desc()
    ),
    check(
      "collaboration_thread_audiences_values_check",
      sql`${table.version} > 0 and length(${table.memberSetHash}) = 64`
    )
  ]
);

export const collaborationThreadAudienceMembers = pgTable(
  "collaboration_thread_audience_members",
  {
    threadId: uuid("thread_id").notNull(),
    audienceVersion: integer("audience_version").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: now()
  },
  (table) => [
    primaryKey({
      columns: [table.threadId, table.audienceVersion, table.userId]
    }),
    foreignKey({
      columns: [table.threadId, table.audienceVersion],
      foreignColumns: [
        collaborationThreadAudiences.threadId,
        collaborationThreadAudiences.version
      ],
      name: "collaboration_thread_audience_members_audience_fk"
    }).onDelete("restrict"),
    index("collaboration_thread_audience_members_user_idx").on(
      table.userId,
      table.threadId,
      table.audienceVersion
    ),
    check(
      "collaboration_thread_audience_members_version_check",
      sql`${table.audienceVersion} > 0`
    )
  ]
);

export const collaborationMessages = pgTable(
  "collaboration_messages",
  {
    id: id(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => collaborationThreads.id, { onDelete: "restrict" }),
    threadSequence: bigint("thread_sequence", { mode: "number" }).notNull(),
    audienceVersion: integer("audience_version").notNull(),
    scope: collaborationScope("scope").notNull(),
    personalOwnerUserId: uuid("personal_owner_user_id"),
    teamId: uuid("team_id"),
    teamWorkspaceId: uuid("team_workspace_id"),
    senderKind: collaborationSenderKind("sender_kind").notNull(),
    senderPrincipalId: uuid("sender_principal_id"),
    senderUserId: uuid("sender_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    idempotencyKeyHash: text("idempotency_key_hash"),
    requestHash: text("request_hash"),
    bodyMarker: text("body_marker").notNull(),
    metadataMarker: text("metadata_marker").notNull(),
    provenanceKind: text("provenance_kind").notNull(),
    provenanceId: text("provenance_id").notNull(),
    provenanceMarker: text("provenance_marker").notNull(),
    createdAt: now(),
    updatedAt: updatedNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    editedBodyMarker: text("edited_body_marker"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBodyMarker: text("deleted_body_marker"),
    retentionPolicyId: uuid("retention_policy_id"),
    retentionPolicyVersion: integer("retention_policy_version"),
    retainUntil: timestamp("retain_until", { withTimezone: true })
  },
  (table) => [
    foreignKey({
      columns: [table.threadId, table.audienceVersion],
      foreignColumns: [
        collaborationThreadAudiences.threadId,
        collaborationThreadAudiences.version
      ],
      name: "collaboration_messages_audience_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.scope],
      foreignColumns: [collaborationThreads.id, collaborationThreads.scope],
      name: "collaboration_messages_thread_scope_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.personalOwnerUserId],
      foreignColumns: [
        collaborationThreads.id,
        collaborationThreads.personalOwnerUserId
      ],
      name: "collaboration_messages_personal_owner_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.teamId],
      foreignColumns: [collaborationThreads.id, collaborationThreads.teamId],
      name: "collaboration_messages_thread_team_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.teamWorkspaceId],
      foreignColumns: [
        collaborationThreads.id,
        collaborationThreads.teamWorkspaceId
      ],
      name: "collaboration_messages_thread_workspace_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "collaboration_messages_workspace_team_fk"
    }).onDelete("restrict"),
    unique("collaboration_messages_thread_sequence_unique").on(
      table.threadId,
      table.threadSequence
    ),
    unique("collaboration_messages_thread_id_sequence_unique").on(
      table.threadId,
      table.id,
      table.threadSequence
    ),
    unique("collaboration_messages_thread_id_unique").on(
      table.threadId,
      table.id
    ),
    uniqueIndex("collaboration_messages_idempotency_unique")
      .on(table.threadId, table.senderPrincipalId, table.idempotencyKeyHash)
      .where(sql`${table.idempotencyKeyHash} is not null`),
    index("collaboration_messages_thread_sequence_idx").on(
      table.threadId,
      table.threadSequence.desc()
    ),
    check(
      "collaboration_messages_sequence_check",
      sql`${table.threadSequence} > 0 and ${table.audienceVersion} > 0`
    ),
    check(
      "collaboration_messages_marker_check",
      sql`${table.bodyMarker} = '[koed encrypted collaboration message]'
        and ${table.metadataMarker} = '[koed encrypted collaboration metadata]'
        and ${table.provenanceMarker} = '[koed encrypted collaboration provenance]'`
    ),
    check(
      "collaboration_messages_idempotency_check",
      sql`(
        ${table.senderKind} = 'user'
        and ${table.senderPrincipalId} is not null
        and length(${table.idempotencyKeyHash}) = 64
        and length(${table.requestHash}) = 64
      ) or (
        ${table.senderKind} in ('system', 'imported')
        and ${table.idempotencyKeyHash} is null
        and ${table.requestHash} is null
      )`
    ),
    check(
      "collaboration_messages_provenance_check",
      sql`length(trim(${table.provenanceKind})) > 0
        and length(trim(${table.provenanceId})) > 0`
    ),
    check(
      "collaboration_messages_reserved_lifecycle_check",
      sql`${table.editedAt} is null
        and ${table.editedBodyMarker} is null
        and ${table.deletedAt} is null
        and ${table.deletedBodyMarker} is null`
    ),
    check(
      "collaboration_messages_retention_check",
      sql`(${table.retentionPolicyId} is null and ${table.retentionPolicyVersion} is null)
        or (${table.retentionPolicyId} is not null and ${table.retentionPolicyVersion} > 0)`
    )
  ]
);

export const collaborationReceiptStates = pgTable(
  "collaboration_receipt_states",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => collaborationThreads.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    lastDeliveredMessageId: uuid("last_delivered_message_id"),
    lastDeliveredSequence: bigint("last_delivered_sequence", {
      mode: "number"
    })
      .notNull()
      .default(0),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    lastReadMessageId: uuid("last_read_message_id"),
    lastReadSequence: bigint("last_read_sequence", { mode: "number" })
      .notNull()
      .default(0),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    updatedAt: updatedNow()
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.userId] }),
    foreignKey({
      columns: [
        table.threadId,
        table.lastDeliveredMessageId,
        table.lastDeliveredSequence
      ],
      foreignColumns: [
        collaborationMessages.threadId,
        collaborationMessages.id,
        collaborationMessages.threadSequence
      ],
      name: "collaboration_receipt_states_delivered_message_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.threadId,
        table.lastReadMessageId,
        table.lastReadSequence
      ],
      foreignColumns: [
        collaborationMessages.threadId,
        collaborationMessages.id,
        collaborationMessages.threadSequence
      ],
      name: "collaboration_receipt_states_read_message_fk"
    }).onDelete("restrict"),
    index("collaboration_receipt_states_user_idx").on(
      table.userId,
      table.updatedAt.desc()
    ),
    check(
      "collaboration_receipt_states_cursor_check",
      sql`${table.lastDeliveredSequence} >= 0
        and ${table.lastReadSequence} >= 0
        and ${table.lastDeliveredSequence} >= ${table.lastReadSequence}
        and ${table.version} > 0
        and ((${table.lastDeliveredMessageId} is null and ${table.lastDeliveredSequence} = 0 and ${table.lastDeliveredAt} is null)
          or (${table.lastDeliveredMessageId} is not null and ${table.lastDeliveredSequence} > 0 and ${table.lastDeliveredAt} is not null))
        and ((${table.lastReadMessageId} is null and ${table.lastReadSequence} = 0)
          or (${table.lastReadMessageId} is not null and ${table.lastReadSequence} > 0 and ${table.lastReadAt} is not null))`
    )
  ]
);

export const collaborationOutbox = pgTable(
  "collaboration_outbox",
  {
    id: id(),
    cursor: bigserial("cursor", { mode: "number" }).notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    family: collaborationEventFamily("family").notNull(),
    scope: collaborationScope("scope").notNull(),
    personalOwnerUserId: uuid("personal_owner_user_id"),
    teamId: uuid("team_id"),
    teamWorkspaceId: uuid("team_workspace_id"),
    threadId: uuid("thread_id"),
    messageId: uuid("message_id"),
    shareGrantId: uuid("share_grant_id"),
    logicalMemoryId: uuid("logical_memory_id"),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    actorPrincipalId: uuid("actor_principal_id"),
    mutationId: uuid("mutation_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    replayUntil: timestamp("replay_until", { withTimezone: true }).notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true })
  },
  (table) => [
    unique("collaboration_outbox_cursor_unique").on(table.cursor),
    unique("collaboration_outbox_mutation_family_unique").on(
      table.mutationId,
      table.family
    ),
    unique("collaboration_outbox_id_cursor_unique").on(table.id, table.cursor),
    foreignKey({
      columns: [table.threadId, table.messageId],
      foreignColumns: [
        collaborationMessages.threadId,
        collaborationMessages.id
      ],
      name: "collaboration_outbox_thread_message_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "collaboration_outbox_workspace_team_fk"
    }).onDelete("restrict"),
    index("collaboration_outbox_replay_idx").on(
      table.cursor,
      table.replayUntil
    ),
    index("collaboration_outbox_team_idx").on(table.teamId, table.cursor),
    index("collaboration_outbox_thread_idx").on(table.threadId, table.cursor),
    check(
      "collaboration_outbox_scope_check",
      sql`(
        ${table.scope} = 'personal'
        and ${table.personalOwnerUserId} is not null
        and ${table.teamId} is null
        and ${table.teamWorkspaceId} is null
      ) or (
        ${table.scope} = 'team'
        and ${table.personalOwnerUserId} is null
        and ${table.teamId} is not null
      )`
    ),
    check(
      "collaboration_outbox_protocol_check",
      sql`${table.protocolVersion} > 0
        and length(trim(${table.resourceType})) > 0
        and ${table.replayUntil} > ${table.occurredAt}`
    )
  ]
);

export const collaborationReplayWatermarks = pgTable(
  "collaboration_replay_watermarks",
  {
    id: id(),
    scope: collaborationScope("scope").notNull(),
    personalOwnerUserId: uuid("personal_owner_user_id").references(
      () => users.id,
      { onDelete: "restrict" }
    ),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict"
    }),
    replayLowWaterCursor: bigint("replay_low_water_cursor", {
      mode: "number"
    }).notNull(),
    highWaterCursor: bigint("high_water_cursor", { mode: "number" }).notNull(),
    updatedAt: updatedNow()
  },
  (table) => [
    uniqueIndex("collaboration_replay_watermarks_personal_unique")
      .on(table.personalOwnerUserId)
      .where(sql`${table.scope} = 'personal'`),
    uniqueIndex("collaboration_replay_watermarks_team_unique")
      .on(table.teamId)
      .where(sql`${table.scope} = 'team'`),
    check(
      "collaboration_replay_watermarks_scope_check",
      sql`(${table.scope} = 'personal' and ${table.personalOwnerUserId} is not null and ${table.teamId} is null)
        or (${table.scope} = 'team' and ${table.personalOwnerUserId} is null and ${table.teamId} is not null)`
    ),
    check(
      "collaboration_replay_watermarks_cursor_check",
      sql`${table.replayLowWaterCursor} > 0
        and ${table.highWaterCursor} >= ${table.replayLowWaterCursor}`
    )
  ]
);

export const collaborationStreamSubscriptions = pgTable(
  "collaboration_stream_subscriptions",
  {
    id: id(),
    backendIdentityHash: text("backend_identity_hash").notNull(),
    principalIdHash: text("principal_id_hash").notNull(),
    deviceCredentialId: uuid("device_credential_id").references(
      () => deviceCredentials.id,
      { onDelete: "restrict" }
    ),
    clientInstanceHash: text("client_instance_hash").notNull(),
    subscriptionKeyHash: text("subscription_key_hash").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    scope: collaborationScope("scope").notNull(),
    personalOwnerUserId: uuid("personal_owner_user_id").references(
      () => users.id,
      { onDelete: "restrict" }
    ),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict"
    }),
    state: collaborationStreamState("state").notNull().default("active"),
    snapshotHighWaterCursor: bigint("snapshot_high_water_cursor", {
      mode: "number"
    }),
    acknowledgedEventId: uuid("acknowledged_event_id"),
    acknowledgedCursor: bigint("acknowledged_cursor", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: now(),
    updatedAt: updatedNow(),
    lastAcknowledgedAt: timestamp("last_acknowledged_at", {
      withTimezone: true
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    unique("collaboration_stream_subscriptions_binding_unique").on(
      table.backendIdentityHash,
      table.principalIdHash,
      table.clientInstanceHash,
      table.subscriptionKeyHash,
      table.protocolVersion
    ),
    foreignKey({
      columns: [table.acknowledgedEventId, table.acknowledgedCursor],
      foreignColumns: [collaborationOutbox.id, collaborationOutbox.cursor],
      name: "collaboration_stream_subscriptions_ack_fk"
    }).onDelete("restrict"),
    index("collaboration_stream_subscriptions_principal_idx").on(
      table.backendIdentityHash,
      table.principalIdHash,
      table.state,
      table.updatedAt.desc()
    ),
    index("collaboration_stream_subscriptions_device_idx").on(
      table.deviceCredentialId,
      table.state
    ),
    check(
      "collaboration_stream_subscriptions_hash_check",
      sql`length(${table.backendIdentityHash}) = 64
        and length(${table.principalIdHash}) = 64
        and length(${table.clientInstanceHash}) = 64
        and length(${table.subscriptionKeyHash}) = 64`
    ),
    check(
      "collaboration_stream_subscriptions_scope_check",
      sql`(${table.scope} = 'personal' and ${table.personalOwnerUserId} is not null and ${table.teamId} is null)
        or (${table.scope} = 'team' and ${table.personalOwnerUserId} is null and ${table.teamId} is not null)`
    ),
    check(
      "collaboration_stream_subscriptions_cursor_check",
      sql`${table.protocolVersion} > 0
        and ${table.acknowledgedCursor} >= 0
        and (${table.snapshotHighWaterCursor} is null or ${table.snapshotHighWaterCursor} >= ${table.acknowledgedCursor})
        and ((${table.acknowledgedEventId} is null and ${table.acknowledgedCursor} = 0)
          or (${table.acknowledgedEventId} is not null and ${table.acknowledgedCursor} > 0))`
    )
  ]
);

export const localEdgeCollaborationSubscriptions = pgTable(
  "local_edge_collaboration_subscriptions",
  {
    id: id(),
    scope: collaborationScope("scope").notNull(),
    upstreamBackendId: text("upstream_backend_id").notNull(),
    credentialBindingHash: text("credential_binding_hash").notNull(),
    teamId: uuid("team_id"),
    protocolVersion: integer("protocol_version").notNull(),
    remoteSubscriptionId: uuid("remote_subscription_id").notNull(),
    remoteCursor: text("remote_cursor").notNull(),
    lastAcknowledgedEventId: uuid("last_acknowledged_event_id"),
    state: collaborationStreamState("state").notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdAt: now(),
    updatedAt: updatedNow(),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    lastAcknowledgedAt: timestamp("last_acknowledged_at", {
      withTimezone: true
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex(
      "local_edge_collaboration_subscriptions_personal_binding_unique"
    )
      .on(
        table.upstreamBackendId,
        table.credentialBindingHash,
        table.protocolVersion
      )
      .where(sql`${table.scope} = 'personal' and ${table.teamId} is null`),
    uniqueIndex("local_edge_collaboration_subscriptions_team_binding_unique")
      .on(
        table.upstreamBackendId,
        table.credentialBindingHash,
        table.teamId,
        table.protocolVersion
      )
      .where(sql`${table.scope} = 'team' and ${table.teamId} is not null`),
    index("local_edge_collaboration_subscriptions_active_idx").on(
      table.upstreamBackendId,
      table.state,
      table.updatedAt.desc()
    ),
    check(
      "local_edge_collaboration_subscriptions_values_check",
      sql`length(trim(${table.upstreamBackendId})) > 0
        and ((${table.scope} = 'personal' and ${table.teamId} is null)
          or (${table.scope} = 'team' and ${table.teamId} is not null))
        and length(${table.credentialBindingHash}) = 64
        and ${table.protocolVersion} > 0
        and length(${table.remoteCursor}) between 16 and 4096
        and ${table.version} > 0
        and ${table.expiresAt} > ${table.createdAt}`
    )
  ]
);

export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: id(),
    policyId: uuid("policy_id").notNull().defaultRandom(),
    version: integer("version").notNull(),
    scope: retentionPolicyScope("scope").notNull(),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict"
    }),
    teamWorkspaceId: uuid("team_workspace_id"),
    shareGrantId: uuid("share_grant_id"),
    threadId: uuid("thread_id"),
    ownerPrivateReplicaId: uuid("owner_private_replica_id").references(
      (): AnyPgColumn => memoryReplicas.id,
      { onDelete: "restrict" }
    ),
    logicalMemoryId: uuid("logical_memory_id").references(
      (): AnyPgColumn => logicalMemories.id,
      { onDelete: "restrict" }
    ),
    retentionSeconds: bigint("retention_seconds", { mode: "number" }).notNull(),
    deletionGraceSeconds: bigint("deletion_grace_seconds", {
      mode: "number"
    })
      .notNull()
      .default(0),
    backupRetentionSeconds: bigint("backup_retention_seconds", {
      mode: "number"
    })
      .notNull()
      .default(0),
    policyHash: text("policy_hash").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: now()
  },
  (table) => [
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "retention_policies_workspace_team_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.shareGrantId,
        table.teamId,
        table.teamWorkspaceId,
        table.logicalMemoryId
      ],
      foreignColumns: [
        teamSessionShareGrants.id,
        teamSessionShareGrants.teamId,
        teamSessionShareGrants.teamWorkspaceId,
        teamSessionShareGrants.logicalMemoryId
      ],
      name: "retention_policies_grant_scope_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.teamId],
      foreignColumns: [collaborationThreads.id, collaborationThreads.teamId],
      name: "retention_policies_thread_team_fk"
    }).onDelete("restrict"),
    unique("retention_policies_version_unique").on(
      table.policyId,
      table.version
    ),
    unique("retention_policies_shortening_identity_unique").on(
      table.id,
      table.policyId,
      table.version,
      table.teamId,
      table.policyHash
    ),
    uniqueIndex("retention_policies_active_scope_unique")
      .on(
        table.scope,
        sql`coalesce(${table.teamId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${table.teamWorkspaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${table.shareGrantId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${table.threadId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${table.ownerPrivateReplicaId}, '00000000-0000-0000-0000-000000000000'::uuid)`
      )
      .where(sql`${table.supersededAt} is null`),
    check(
      "retention_policies_values_check",
      sql`${table.version} > 0
        and ${table.retentionSeconds} >= 0
        and ${table.deletionGraceSeconds} >= 0
        and ${table.backupRetentionSeconds} >= 0
        and length(${table.policyHash}) = 64
        and (${table.supersededAt} is null or ${table.supersededAt} > ${table.effectiveAt})`
    ),
    check(
      "retention_policies_scope_check",
      sql`(
        ${table.scope} = 'team'
        and ${table.teamId} is not null
        and ${table.teamWorkspaceId} is null
        and ${table.shareGrantId} is null
        and ${table.threadId} is null
        and ${table.ownerPrivateReplicaId} is null
        and ${table.logicalMemoryId} is null
      ) or (
        ${table.scope} = 'workspace'
        and ${table.teamId} is not null
        and ${table.teamWorkspaceId} is not null
        and ${table.shareGrantId} is null
        and ${table.threadId} is null
        and ${table.ownerPrivateReplicaId} is null
        and ${table.logicalMemoryId} is null
      ) or (
        ${table.scope} = 'share_grant'
        and ${table.teamId} is not null
        and ${table.teamWorkspaceId} is not null
        and ${table.shareGrantId} is not null
        and ${table.threadId} is null
        and ${table.ownerPrivateReplicaId} is null
        and ${table.logicalMemoryId} is not null
      ) or (
        ${table.scope} = 'thread'
        and ${table.teamId} is not null
        and ${table.shareGrantId} is null
        and ${table.threadId} is not null
        and ${table.ownerPrivateReplicaId} is null
        and ${table.logicalMemoryId} is null
      ) or (
        ${table.scope} = 'owner_private_replica'
        and ${table.teamId} is null
        and ${table.teamWorkspaceId} is null
        and ${table.shareGrantId} is null
        and ${table.threadId} is null
        and ${table.ownerPrivateReplicaId} is not null
        and ${table.logicalMemoryId} is not null
      )`
    )
  ]
);

export const legalHolds = pgTable(
  "legal_holds",
  {
    id: id(),
    scope: legalHoldScope("scope").notNull(),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict"
    }),
    teamWorkspaceId: uuid("team_workspace_id"),
    threadId: uuid("thread_id"),
    shareGrantId: uuid("share_grant_id"),
    representationId: uuid("representation_id"),
    representation: sharedMemoryRepresentation("representation"),
    sourceRevision: bigint("source_revision", { mode: "number" }),
    ownerPrivateReplicaId: uuid("owner_private_replica_id").references(
      (): AnyPgColumn => memoryReplicas.id,
      { onDelete: "restrict" }
    ),
    logicalMemoryId: uuid("logical_memory_id").references(
      (): AnyPgColumn => logicalMemories.id,
      { onDelete: "restrict" }
    ),
    messageRangeStart: bigint("message_range_start", { mode: "number" }),
    messageRangeEnd: bigint("message_range_end", { mode: "number" }),
    messageTimeStart: timestamp("message_time_start", { withTimezone: true }),
    messageTimeEnd: timestamp("message_time_end", { withTimezone: true }),
    authority: text("authority").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonHash: text("reason_hash").notNull(),
    state: legalHoldState("state").notNull().default("active"),
    placedByUserId: uuid("placed_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    freshlyAuthenticatedAt: timestamp("freshly_authenticated_at", {
      withTimezone: true
    }).notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    releaseRequestedByUserId: uuid("release_requested_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    releaseRequestedAt: timestamp("release_requested_at", {
      withTimezone: true
    }),
    releaseConfirmedByUserId: uuid("release_confirmed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    releaseConfirmedAt: timestamp("release_confirmed_at", {
      withTimezone: true
    }),
    singleHolderReleaseException: boolean("single_holder_release_exception")
      .notNull()
      .default(false),
    releasedAt: timestamp("released_at", { withTimezone: true })
  },
  (table) => [
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "legal_holds_workspace_team_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.teamId],
      foreignColumns: [collaborationThreads.id, collaborationThreads.teamId],
      name: "legal_holds_thread_team_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.representationId,
        table.shareGrantId,
        table.teamId,
        table.teamWorkspaceId,
        table.logicalMemoryId,
        table.representation,
        table.sourceRevision
      ],
      foreignColumns: [
        teamMemoryRepresentations.id,
        teamMemoryRepresentations.shareGrantId,
        teamMemoryRepresentations.teamId,
        teamMemoryRepresentations.teamWorkspaceId,
        teamMemoryRepresentations.logicalMemoryId,
        teamMemoryRepresentations.representation,
        teamMemoryRepresentations.sourceRevision
      ],
      name: "legal_holds_representation_scope_fk"
    }).onDelete("restrict"),
    index("legal_holds_active_team_idx")
      .on(table.teamId, table.scope, table.placedAt.desc())
      .where(sql`${table.state} <> 'released'`),
    check(
      "legal_holds_reason_check",
      sql`length(trim(${table.authority})) > 0
        and length(trim(${table.reasonCode})) > 0
        and length(${table.reasonHash}) = 64`
    ),
    check(
      "legal_holds_target_check",
      sql`(
        ${table.scope} = 'team' and ${table.teamId} is not null
        and ${table.teamWorkspaceId} is null and ${table.threadId} is null
        and ${table.shareGrantId} is null and ${table.representationId} is null
        and ${table.ownerPrivateReplicaId} is null and ${table.logicalMemoryId} is null
      ) or (
        ${table.scope} = 'workspace' and ${table.teamId} is not null
        and ${table.teamWorkspaceId} is not null and ${table.threadId} is null
        and ${table.shareGrantId} is null and ${table.representationId} is null
        and ${table.ownerPrivateReplicaId} is null and ${table.logicalMemoryId} is null
      ) or (
        ${table.scope} = 'thread' and ${table.teamId} is not null
        and ${table.threadId} is not null and ${table.shareGrantId} is null
        and ${table.representationId} is null and ${table.ownerPrivateReplicaId} is null
        and ${table.logicalMemoryId} is null
      ) or (
        ${table.scope} = 'grant_representation' and ${table.teamId} is not null
        and ${table.teamWorkspaceId} is not null and ${table.shareGrantId} is not null
        and ${table.representationId} is not null and ${table.representation} is not null
        and ${table.sourceRevision} >= 0 and ${table.ownerPrivateReplicaId} is null
        and ${table.logicalMemoryId} is not null
      ) or (
        ${table.scope} = 'team_message_range' and ${table.teamId} is not null
        and ${table.threadId} is not null and ${table.shareGrantId} is null
        and ${table.representationId} is null and ${table.ownerPrivateReplicaId} is null
        and ${table.logicalMemoryId} is null
        and ((${table.messageRangeStart} > 0 and ${table.messageRangeEnd} >= ${table.messageRangeStart})
          or (${table.messageTimeStart} is not null and ${table.messageTimeEnd} >= ${table.messageTimeStart}))
      ) or (
        ${table.scope} = 'owner_private_replica' and ${table.teamId} is null
        and ${table.teamWorkspaceId} is null and ${table.threadId} is null
        and ${table.shareGrantId} is null and ${table.representationId} is null
        and ${table.ownerPrivateReplicaId} is not null and ${table.logicalMemoryId} is not null
      )`
    ),
    check(
      "legal_holds_release_lifecycle_check",
      sql`(
        ${table.state} = 'active'
        and ${table.releaseRequestedAt} is null
        and ${table.releaseConfirmedAt} is null
        and ${table.releasedAt} is null
      ) or (
        ${table.state} = 'release_pending'
        and ${table.releaseRequestedAt} is not null
        and ${table.releaseConfirmedAt} is null
        and ${table.releasedAt} is null
      ) or (
        ${table.state} = 'released'
        and ${table.releaseRequestedAt} is not null
        and ${table.releaseConfirmedAt} is not null
        and ${table.releasedAt} is not null
        and (${table.singleHolderReleaseException}
          or ${table.releaseConfirmedByUserId} is distinct from ${table.releaseRequestedByUserId})
      )`
    )
  ]
);

export const retentionDecisions = pgTable(
  "retention_decisions",
  {
    id: id(),
    decisionVersion: integer("decision_version").notNull().default(1),
    policyId: uuid("policy_id").notNull(),
    policyVersion: integer("policy_version").notNull(),
    targetKind: purgeTargetKind("target_kind").notNull(),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict"
    }),
    teamWorkspaceId: uuid("team_workspace_id"),
    shareGrantId: uuid("share_grant_id"),
    representationId: uuid("representation_id"),
    threadId: uuid("thread_id"),
    messageId: uuid("message_id"),
    ownerPrivateReplicaId: uuid("owner_private_replica_id").references(
      (): AnyPgColumn => memoryReplicas.id,
      { onDelete: "restrict" }
    ),
    logicalMemoryId: uuid("logical_memory_id").references(
      (): AnyPgColumn => logicalMemories.id,
      { onDelete: "restrict" }
    ),
    trigger: retentionTrigger("trigger").notNull(),
    triggerEpoch: bigint("trigger_epoch", { mode: "number" })
      .notNull()
      .default(0),
    policyEffectiveAt: timestamp("policy_effective_at", {
      withTimezone: true
    }).notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
    applicableLegalHoldIds: uuid("applicable_legal_hold_ids")
      .array()
      .notNull()
      .default(sql`array[]::uuid[]`),
    eligible: boolean("eligible").notNull(),
    eligibilityReasonCode: text("eligibility_reason_code").notNull(),
    decisionSnapshotHash: text("decision_snapshot_hash").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    foreignKey({
      columns: [table.policyId, table.policyVersion],
      foreignColumns: [retentionPolicies.policyId, retentionPolicies.version],
      name: "retention_decisions_policy_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "retention_decisions_workspace_team_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.representationId,
        table.shareGrantId,
        table.teamId,
        table.teamWorkspaceId,
        table.logicalMemoryId
      ],
      foreignColumns: [
        teamMemoryRepresentations.id,
        teamMemoryRepresentations.shareGrantId,
        teamMemoryRepresentations.teamId,
        teamMemoryRepresentations.teamWorkspaceId,
        teamMemoryRepresentations.logicalMemoryId
      ],
      name: "retention_decisions_representation_scope_fk"
    }).onDelete("restrict"),
    index("retention_decisions_target_idx").on(
      table.targetKind,
      table.teamId,
      table.retainUntil
    ),
    uniqueIndex("retention_decisions_share_revocation_epoch_unique")
      .on(table.shareGrantId, table.triggerEpoch)
      .where(
        sql`${table.targetKind} = 'share_grant' and ${table.trigger} = 'share_revoked'`
      ),
    check(
      "retention_decisions_values_check",
      sql`${table.decisionVersion} > 0
        and ${table.triggerEpoch} >= 0
        and ${table.policyVersion} > 0
        and ${table.policyEffectiveAt} <= ${table.triggeredAt}
        and ${table.retainUntil} >= ${table.triggeredAt}
        and array_position(${table.applicableLegalHoldIds}, null) is null
        and length(trim(${table.eligibilityReasonCode})) > 0
        and length(${table.decisionSnapshotHash}) = 64`
    )
  ]
);

export const retentionPolicyShorteningPreviews = pgTable(
  "retention_policy_shortening_previews",
  {
    id: id(),
    retentionPolicyRowId: uuid("retention_policy_row_id").notNull(),
    teamId: uuid("team_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    policyVersion: integer("policy_version").notNull(),
    policyHash: text("policy_hash").notNull(),
    state: retentionPolicyShorteningState("state").notNull().default("pending"),
    affectedScopeCount: integer("affected_scope_count").notNull(),
    previewHash: text("preview_hash").notNull(),
    previewedByUserId: uuid("previewed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    previewedAt: timestamp("previewed_at", { withTimezone: true }).notNull(),
    graceUntil: timestamp("grace_until", { withTimezone: true }).notNull(),
    confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReasonCode: text("invalidation_reason_code"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    foreignKey({
      columns: [
        table.retentionPolicyRowId,
        table.policyId,
        table.policyVersion,
        table.teamId,
        table.policyHash
      ],
      foreignColumns: [
        retentionPolicies.id,
        retentionPolicies.policyId,
        retentionPolicies.version,
        retentionPolicies.teamId,
        retentionPolicies.policyHash
      ],
      name: "retention_policy_shortening_previews_policy_fk"
    }).onDelete("restrict"),
    index("retention_policy_shortening_previews_pending_idx").on(
      table.state,
      table.graceUntil,
      table.teamId
    ),
    check(
      "retention_policy_shortening_previews_values_check",
      sql`${table.policyVersion} > 0
        and ${table.affectedScopeCount} >= 0
        and length(${table.policyHash}) = 64
        and length(${table.previewHash}) = 64
        and ${table.graceUntil} > ${table.previewedAt}`
    ),
    check(
      "retention_policy_shortening_previews_lifecycle_check",
      sql`(
        ${table.state} = 'pending'
        and ${table.confirmedByUserId} is null
        and ${table.confirmedAt} is null
        and ${table.invalidatedAt} is null
        and ${table.invalidationReasonCode} is null
      ) or (
        ${table.state} = 'confirmed'
        and ${table.confirmedByUserId} is not null
        and ${table.confirmedAt} >= ${table.graceUntil}
        and ${table.invalidatedAt} is null
        and ${table.invalidationReasonCode} is null
      ) or (
        ${table.state} = 'invalidated'
        and ${table.confirmedByUserId} is null
        and ${table.confirmedAt} is null
        and ${table.invalidatedAt} is not null
        and length(trim(${table.invalidationReasonCode})) > 0
      )`
    )
  ]
);

export const retentionPolicyShorteningAffectedScopes = pgTable(
  "retention_policy_shortening_affected_scopes",
  {
    id: id(),
    previewId: uuid("preview_id")
      .notNull()
      .references(() => retentionPolicyShorteningPreviews.id, {
        onDelete: "restrict"
      }),
    ordinal: integer("ordinal").notNull(),
    retentionDecisionId: uuid("retention_decision_id")
      .notNull()
      .references(() => retentionDecisions.id, { onDelete: "restrict" }),
    targetKind: purgeTargetKind("target_kind").notNull(),
    targetId: uuid("target_id").notNull(),
    previousRetainUntil: timestamp("previous_retain_until", {
      withTimezone: true
    }).notNull(),
    shortenedRetainUntil: timestamp("shortened_retain_until", {
      withTimezone: true
    }).notNull(),
    applicableLegalHoldIds: uuid("applicable_legal_hold_ids")
      .array()
      .notNull()
      .default(sql`array[]::uuid[]`),
    scopeSnapshotHash: text("scope_snapshot_hash").notNull(),
    createdAt: now()
  },
  (table) => [
    unique("retention_policy_shortening_scopes_ordinal_unique").on(
      table.previewId,
      table.ordinal
    ),
    unique("retention_policy_shortening_scopes_decision_unique").on(
      table.previewId,
      table.retentionDecisionId
    ),
    unique("retention_policy_shortening_scopes_identity_unique").on(
      table.id,
      table.previewId
    ),
    check(
      "retention_policy_shortening_scopes_values_check",
      sql`${table.ordinal} >= 0
        and ${table.shortenedRetainUntil} < ${table.previousRetainUntil}
        and array_position(${table.applicableLegalHoldIds}, null) is null
        and length(${table.scopeSnapshotHash}) = 64`
    )
  ]
);

export const retentionPolicyShorteningMigrations = pgTable(
  "retention_policy_shortening_migrations",
  {
    id: id(),
    previewId: uuid("preview_id")
      .notNull()
      .references(() => retentionPolicyShorteningPreviews.id, {
        onDelete: "restrict"
      }),
    affectedScopeId: uuid("affected_scope_id").notNull(),
    previousRetentionDecisionId: uuid(
      "previous_retention_decision_id"
    ).notNull(),
    migratedRetentionDecisionId: uuid("migrated_retention_decision_id")
      .notNull()
      .references(() => retentionDecisions.id, { onDelete: "restrict" }),
    migratedAt: timestamp("migrated_at", { withTimezone: true }).notNull(),
    createdAt: now()
  },
  (table) => [
    foreignKey({
      columns: [table.affectedScopeId, table.previewId],
      foreignColumns: [
        retentionPolicyShorteningAffectedScopes.id,
        retentionPolicyShorteningAffectedScopes.previewId
      ],
      name: "retention_policy_shortening_migrations_scope_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.previewId, table.previousRetentionDecisionId],
      foreignColumns: [
        retentionPolicyShorteningAffectedScopes.previewId,
        retentionPolicyShorteningAffectedScopes.retentionDecisionId
      ],
      name: "retention_policy_shortening_migrations_previous_decision_fk"
    }).onDelete("restrict"),
    unique("retention_policy_shortening_migrations_preview_scope_unique").on(
      table.previewId,
      table.affectedScopeId
    ),
    unique("retention_policy_shortening_migrations_previous_unique").on(
      table.previousRetentionDecisionId
    ),
    unique("retention_policy_shortening_migrations_migrated_unique").on(
      table.migratedRetentionDecisionId
    ),
    check(
      "retention_policy_shortening_migrations_decision_check",
      sql`${table.previousRetentionDecisionId} <> ${table.migratedRetentionDecisionId}`
    )
  ]
);

export const purgeJobs = pgTable(
  "purge_jobs",
  {
    id: id(),
    retentionDecisionId: uuid("retention_decision_id")
      .notNull()
      .references(() => retentionDecisions.id, { onDelete: "restrict" }),
    targetKind: purgeTargetKind("target_kind").notNull(),
    targetId: uuid("target_id").notNull(),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict"
    }),
    teamWorkspaceId: uuid("team_workspace_id"),
    shareGrantId: uuid("share_grant_id"),
    representationId: uuid("representation_id"),
    logicalMemoryId: uuid("logical_memory_id").references(
      (): AnyPgColumn => logicalMemories.id,
      { onDelete: "restrict" }
    ),
    state: purgeJobState("state").notNull().default("pending"),
    targetEpoch: bigint("target_epoch", { mode: "number" })
      .notNull()
      .default(0),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    resumeArtifactKind: purgeArtifactKind("resume_artifact_kind"),
    resumeCursor: text("resume_cursor"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: now(),
    updatedAt: updatedNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    terminalErrorCode: text("terminal_error_code"),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    cancellationReasonCode: text("cancellation_reason_code"),
    canceledByUserId: uuid("canceled_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    canceledByMutationId: uuid("canceled_by_mutation_id")
  },
  (table) => [
    foreignKey({
      columns: [table.teamWorkspaceId, table.teamId],
      foreignColumns: [teamWorkspaces.id, teamWorkspaces.teamId],
      name: "purge_jobs_workspace_team_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.representationId,
        table.shareGrantId,
        table.teamId,
        table.teamWorkspaceId,
        table.logicalMemoryId
      ],
      foreignColumns: [
        teamMemoryRepresentations.id,
        teamMemoryRepresentations.shareGrantId,
        teamMemoryRepresentations.teamId,
        teamMemoryRepresentations.teamWorkspaceId,
        teamMemoryRepresentations.logicalMemoryId
      ],
      name: "purge_jobs_representation_scope_fk"
    }).onDelete("restrict"),
    index("purge_jobs_resume_idx").on(table.state, table.nextAttemptAt),
    check(
      "purge_jobs_resume_check",
      sql`${table.attemptCount} >= 0 and ${table.targetEpoch} >= 0
        and length(trim(${table.idempotencyKey})) > 0
        and ((${table.resumeArtifactKind} is null and ${table.resumeCursor} is null)
          or (${table.resumeArtifactKind} is not null and ${table.resumeCursor} is not null))`
    ),
    check(
      "purge_jobs_lifecycle_check",
      sql`(${table.state} = 'pending' and ${table.startedAt} is null
          and ${table.verifiedAt} is null and ${table.canceledAt} is null
          and ${table.attemptCount} = 0
          and ${table.resumeArtifactKind} is null and ${table.resumeCursor} is null
          and ${table.cancellationReasonCode} is null
          and ${table.canceledByUserId} is null
          and ${table.canceledByMutationId} is null)
        or (${table.state} = 'canceled' and ${table.startedAt} is null
          and ${table.verifiedAt} is null and ${table.canceledAt} is not null
          and ${table.attemptCount} = 0
          and ${table.resumeArtifactKind} is null and ${table.resumeCursor} is null
          and ${table.terminalErrorCode} is null
          and length(trim(${table.cancellationReasonCode})) > 0
          and ${table.canceledByMutationId} is not null)
        or (${table.state} in ('blocked', 'running', 'retry_wait', 'failed')
          and ${table.startedAt} is not null and ${table.verifiedAt} is null
          and ${table.canceledAt} is null)
        or (${table.state} = 'verified' and ${table.startedAt} is not null
          and ${table.verifiedAt} is not null and ${table.canceledAt} is null)`
    )
  ]
);

export const purgeJobAttempts = pgTable(
  "purge_job_attempts",
  {
    id: id(),
    purgeJobId: uuid("purge_job_id")
      .notNull()
      .references(() => purgeJobs.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    state: purgeAttemptState("state").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    resumeArtifactKind: purgeArtifactKind("resume_artifact_kind"),
    resumeCursor: text("resume_cursor"),
    errorCode: text("error_code"),
    errorHash: text("error_hash")
  },
  (table) => [
    unique("purge_job_attempts_number_unique").on(
      table.purgeJobId,
      table.attemptNumber
    ),
    check("purge_job_attempts_number_check", sql`${table.attemptNumber} > 0`),
    check(
      "purge_job_attempts_lifecycle_check",
      sql`(${table.state} = 'running' and ${table.completedAt} is null)
        or (${table.state} <> 'running' and ${table.completedAt} is not null)`
    ),
    check(
      "purge_job_attempts_error_check",
      sql`(${table.errorCode} is null and ${table.errorHash} is null)
        or (${table.errorCode} is not null and length(${table.errorHash}) = 64)`
    )
  ]
);

export const purgeJobEvidence = pgTable(
  "purge_job_evidence",
  {
    id: id(),
    purgeJobId: uuid("purge_job_id")
      .notNull()
      .references(() => purgeJobs.id, { onDelete: "restrict" }),
    purgeAttemptId: uuid("purge_attempt_id").references(
      () => purgeJobAttempts.id,
      { onDelete: "restrict" }
    ),
    artifactKind: purgeArtifactKind("artifact_kind").notNull(),
    artifactLocatorHash: text("artifact_locator_hash").notNull(),
    state: purgeEvidenceState("state").notNull().default("pending"),
    removedRecordCount: bigint("removed_record_count", {
      mode: "number"
    }).notNull(),
    removedByteCount: bigint("removed_byte_count", {
      mode: "number"
    }).notNull(),
    evidenceHash: text("evidence_hash"),
    backupExpiresAt: timestamp("backup_expires_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true })
  },
  (table) => [
    unique("purge_job_evidence_artifact_unique").on(
      table.purgeJobId,
      table.artifactKind,
      table.artifactLocatorHash
    ),
    index("purge_job_evidence_state_idx").on(
      table.purgeJobId,
      table.state,
      table.artifactKind
    ),
    check(
      "purge_job_evidence_counts_check",
      sql`${table.removedRecordCount} >= 0
        and ${table.removedByteCount} >= 0
        and length(${table.artifactLocatorHash}) = 64`
    ),
    check(
      "purge_job_evidence_proof_check",
      sql`(${table.state} in ('pending', 'failed') and ${table.verifiedAt} is null)
        or (${table.state} in ('cleaned', 'verified', 'not_applicable')
          and length(${table.evidenceHash}) = 64)
        or (${table.state} = 'scheduled_expiry'
          and length(${table.evidenceHash}) = 64
          and ${table.backupExpiresAt} is not null)`
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
    protocolLogicalId: uuid("protocol_logical_id").notNull().defaultRandom(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    ownerPrincipalId: uuid("owner_principal_id"),
    originDeploymentIdentityId: uuid("origin_deployment_identity_id")
      .notNull()
      .references(() => deploymentIdentities.id, { onDelete: "restrict" }),
    sourceBoundary: syncSourceBoundary("source_boundary").notNull(),
    originSourceId: text("origin_source_id").notNull(),
    localSessionId: uuid("local_session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    logicalKey: text("logical_key").notNull(),
    version: integer("version").notNull().default(1),
    latestSourceRevision: bigint("latest_source_revision", { mode: "number" })
      .notNull()
      .default(0),
    lifecycle: memoryReplicaLifecycle("lifecycle").notNull().default("active"),
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
    invalidationReason: text("invalidation_reason"),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    purgeCompletedAt: timestamp("purge_completed_at", { withTimezone: true })
  },
  (table) => [
    unique("logical_memories_protocol_id_unique").on(table.protocolLogicalId),
    unique("logical_memories_owner_key_unique").on(
      table.ownerPrincipalId,
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
      table.ownerPrincipalId,
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
    ),
    check(
      "logical_memories_owner_version_check",
      sql`${table.ownerPrincipalId} is not null
        and ${table.version} > 0
        and ${table.latestSourceRevision} >= 0`
    ),
    check(
      "logical_memories_lifecycle_check",
      sql`(${table.lifecycle} in ('active', 'stale', 'revoked') and ${table.purgeCompletedAt} is null)
        or (${table.lifecycle} in ('tombstoned', 'purge_pending') and ${table.tombstonedAt} is not null and ${table.purgeCompletedAt} is null)
        or (${table.lifecycle} = 'purged' and ${table.tombstonedAt} is not null and ${table.purgeCompletedAt} is not null)`
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
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    ownerPrincipalId: uuid("owner_principal_id"),
    replicaRole: syncReplicaRole("replica_role").notNull(),
    sourceBoundary: syncSourceBoundary("source_boundary").notNull(),
    localSessionId: uuid("local_session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    externalReplicaId: text("external_replica_id"),
    version: integer("version").notNull().default(1),
    latestRevision: bigint("latest_revision", { mode: "number" })
      .notNull()
      .default(0),
    lifecycle: memoryReplicaLifecycle("lifecycle").notNull().default("active"),
    encryptionScope: text("encryption_scope").notNull(),
    freshnessStatus: text("freshness_status").notNull().default("unknown"),
    representationPolicyRevision: integer("representation_policy_revision"),
    contentPolicyVersion: integer("content_policy_version"),
    createdAt: now(),
    updatedAt: updatedNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    staleAfter: timestamp("stale_after", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    purgeCompletedAt: timestamp("purge_completed_at", { withTimezone: true })
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
    unique("memory_replicas_logical_owner_principal_unique").on(
      table.id,
      table.logicalMemoryId,
      table.ownerPrincipalId
    ),
    uniqueIndex("memory_replicas_external_replica_unique")
      .on(table.deploymentIdentityId, table.externalReplicaId)
      .where(sql`${table.externalReplicaId} is not null`),
    index("memory_replicas_owner_status_idx").on(
      table.ownerPrincipalId,
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
    ),
    check(
      "memory_replicas_owner_version_check",
      sql`${table.ownerPrincipalId} is not null
        and ${table.version} > 0
        and ${table.latestRevision} >= 0`
    ),
    check(
      "memory_replicas_encryption_scope_check",
      sql`(${table.replicaRole} = 'source' and ${table.encryptionScope} = 'personal')
        or (${table.replicaRole} = 'target' and ${table.encryptionScope} = 'owner_private_replica')`
    ),
    check(
      "memory_replicas_policy_revision_check",
      sql`(${table.representationPolicyRevision} is null and ${table.contentPolicyVersion} is null)
        or (${table.representationPolicyRevision} > 0 and ${table.contentPolicyVersion} > 0)`
    ),
    check(
      "memory_replicas_lifecycle_check",
      sql`(${table.lifecycle} in ('active', 'stale', 'revoked') and ${table.purgeCompletedAt} is null)
        or (${table.lifecycle} in ('tombstoned', 'purge_pending') and ${table.tombstonedAt} is not null and ${table.purgeCompletedAt} is null)
        or (${table.lifecycle} = 'purged' and ${table.tombstonedAt} is not null and ${table.purgeCompletedAt} is not null)`
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
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    stateBeforePause: syncRelationshipState("state_before_pause"),
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
    sourceSummaryRevisionHash: text("source_summary_revision_hash"),
    targetSummaryRevisionHash: text("target_summary_revision_hash"),
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
      "cross_identity_sync_relationships_summary_hashes_check",
      sql`(${table.sourceSummaryRevisionHash} is null or length(${table.sourceSummaryRevisionHash}) = 64)
        and (${table.targetSummaryRevisionHash} is null or length(${table.targetSummaryRevisionHash}) = 64)`
    ),
    check(
      "cross_identity_sync_relationships_credential_side_check",
      sql`(${table.side} = 'source' and ${table.deviceCredentialId} is null) or (${table.side} = 'target' and ${table.deviceCredentialId} is not null)`
    ),
    check(
      "cross_identity_sync_relationships_pause_state_check",
      sql`(${table.state} = 'paused'
        and ${table.side} = 'source'
        and ${table.pausedAt} is not null
        and ${table.stateBeforePause} in ('created', 'uploading', 'uploaded', 'verified', 'processing', 'partially_available', 'ready', 'stale')
        and ${table.revokedAt} is null)
        or (${table.state} <> 'paused'
          and ${table.pausedAt} is null
          and ${table.stateBeforePause} is null)`
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

export const syncSummaryNodeMappings = pgTable(
  "sync_summary_node_mappings",
  {
    id: id(),
    syncRelationshipId: uuid("sync_relationship_id")
      .notNull()
      .references(() => crossIdentitySyncRelationships.id, {
        onDelete: "cascade"
      }),
    originNodeId: uuid("origin_node_id").notNull(),
    revisionHash: text("revision_hash").notNull(),
    localMemoryNodeId: uuid("local_memory_node_id").references(
      () => memoryNodes.id,
      { onDelete: "set null" }
    ),
    active: boolean("active").notNull().default(true),
    createdAt: now(),
    updatedAt: updatedNow(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true })
  },
  (table) => [
    unique("sync_summary_node_mappings_revision_unique").on(
      table.syncRelationshipId,
      table.originNodeId,
      table.revisionHash
    ),
    uniqueIndex("sync_summary_node_mappings_active_origin_unique")
      .on(table.syncRelationshipId, table.originNodeId)
      .where(sql`${table.active} = true`),
    index("sync_summary_node_mappings_local_node_idx").on(
      table.localMemoryNodeId
    ),
    check(
      "sync_summary_node_mappings_revision_hash_check",
      sql`length(${table.revisionHash}) = 64`
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
    origin: text("origin").notNull().default("mcp_memory_answer"),
    retrievalScope: text("retrieval_scope").notNull().default("personal"),
    searchDomain: memorySearchDomain("search_domain").notNull(),
    projectId: text("project_id"),
    projectName: text("project_name"),
    projectPath: text("project_path"),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "cascade"
    }),
    threadId: text("thread_id"),
    threadName: text("thread_name"),
    idempotencyKey: text("idempotency_key").notNull(),
    query: text("query").notNull(),
    answerMarkdown: text("answer_markdown"),
    errorMessage: text("error_message"),
    evidence: jsonb("evidence").$type<unknown>(),
    citations: jsonb("citations").$type<unknown>(),
    retrieval: jsonb("retrieval").$type<unknown>(),
    localMemoryWorker: jsonb("local_memory_worker").$type<unknown>(),
    response: jsonb("response").$type<unknown>(),
    status: memoryQuestionStatus("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
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
        table.projectId,
        table.sessionId,
        table.createdAt.desc(),
        table.id.desc()
      )
      .where(sql`${table.visibility} = 'personal'`),
    uniqueIndex("memory_questions_owner_idempotency_key_idx").on(
      table.ownerUserId,
      table.idempotencyKey
    ),
    check(
      "memory_questions_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    ),
    check(
      "memory_questions_origin_check",
      sql`${table.origin} = 'mcp_memory_answer'`
    ),
    check(
      "memory_questions_retrieval_scope_check",
      sql`${table.retrievalScope} in ('personal')`
    ),
    check(
      "memory_questions_search_domain_check",
      sql`(${table.searchDomain} = 'global')
        or (${table.searchDomain} = 'project' and ${table.projectId} is not null)
        or (${table.searchDomain} = 'session' and ${table.sessionId} is not null)`
    ),
    check(
      "memory_questions_status_check",
      sql`(${table.status} = 'answered' and ${table.answerMarkdown} is not null and ${table.errorMessage} is null)
        or (${table.status} = 'error' and ${table.errorMessage} is not null)`
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

export const conversationProjectionProcessingOutbox = pgTable(
  "conversation_projection_processing_outbox",
  {
    eventId: uuid("event_id")
      .primaryKey()
      .references(() => memoryEvents.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    visibility: visibilityScope("visibility").notNull(),
    workClass: text("work_class").notNull(),
    includeInEmbedding: boolean("include_in_embedding").notNull(),
    includeInLcm: boolean("include_in_lcm").notNull(),
    sourceEventTime: timestamp("source_event_time", { withTimezone: true }),
    createdAt: now(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true })
  },
  (table) => [
    index("conversation_projection_processing_outbox_pending_idx")
      .on(table.workClass, table.createdAt, table.eventId)
      .where(sql`${table.dispatchedAt} is null`),
    check(
      "conversation_projection_processing_outbox_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
    ),
    check(
      "conversation_projection_processing_outbox_work_class_check",
      sql`${table.workClass} in ('live_capture_projection', 'normal_embedding_lcm', 'historical_import_backfill')`
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
    priority: integer("priority").notNull().default(10),
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
      .on(table.queueName, table.priority, table.availableAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    index("local_work_queue_active_lease_idx")
      .on(table.lockedUntil)
      .where(sql`${table.status} = 'active'`),
    check(
      "local_work_queue_status_check",
      sql`${table.status} in ('pending', 'active', 'completed', 'failed')`
    ),
    check("local_work_queue_priority_check", sql`${table.priority} >= 0`),
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
      sql`${table.flowKey} in ('mcp_memory_answer', 'lcm_summary', 'curated_memory_review')`
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

export const collaborationSharedMemoryEnrollments = pgTable(
  "collaboration_shared_memory_enrollments",
  {
    id: id(),
    backendId: text("backend_id").notNull(),
    localOwnerUserId: uuid("local_owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    upstreamUserId: uuid("upstream_user_id").notNull(),
    remoteDeviceId: uuid("remote_device_id").notNull(),
    bindingVersion: integer("binding_version").notNull().default(1),
    createdAt: now(),
    updatedAt: updatedNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason")
  },
  (table) => [
    uniqueIndex("csm_enrollments_active_owner_backend_unique")
      .on(table.localOwnerUserId, table.backendId)
      .where(sql`${table.revokedAt} is null`),
    uniqueIndex("csm_enrollments_active_remote_identity_unique")
      .on(table.backendId, table.upstreamUserId, table.remoteDeviceId)
      .where(sql`${table.revokedAt} is null`),
    unique("csm_enrollments_identity_unique").on(
      table.id,
      table.backendId,
      table.localOwnerUserId,
      table.upstreamUserId
    ),
    check(
      "csm_enrollments_backend_id_check",
      sql`${table.backendId} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$'`
    ),
    check(
      "csm_enrollments_binding_version_check",
      sql`${table.bindingVersion} > 0`
    )
  ]
);

export const collaborationSharedMemoryPreviews = pgTable(
  "collaboration_shared_memory_previews",
  {
    id: id(),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => collaborationSharedMemoryEnrollments.id, {
        onDelete: "cascade"
      }),
    syncRelationshipId: uuid("sync_relationship_id")
      .notNull()
      .references(() => crossIdentitySyncRelationships.id, {
        onDelete: "restrict"
      }),
    previewId: uuid("preview_id").notNull(),
    previewHash: text("preview_hash").notNull(),
    previewRevision: integer("preview_revision").notNull(),
    logicalMemoryId: uuid("logical_memory_id").notNull(),
    teamId: uuid("team_id").notNull(),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    representation: sharedMemoryRepresentation("representation").notNull(),
    sourceRevision: bigint("source_revision", { mode: "number" }).notNull(),
    sourceHash: text("source_hash").notNull(),
    redactedContentHash: text("redacted_content_hash").notNull(),
    itemCount: integer("item_count").notNull(),
    protectedDtoHash: text("protected_dto_hash").notNull(),
    protectedDto: jsonb("protected_dto")
      .$type<EncryptedPayloadEnvelope>()
      .notNull(),
    createdAt: now()
  },
  (table) => [
    unique("csm_previews_identity_unique").on(
      table.enrollmentId,
      table.previewId
    ),
    unique("csm_previews_hash_unique").on(
      table.enrollmentId,
      table.previewHash
    ),
    unique("csm_previews_consent_binding_unique").on(
      table.enrollmentId,
      table.previewId,
      table.previewHash,
      table.previewRevision,
      table.logicalMemoryId,
      table.teamId,
      table.teamWorkspaceId,
      table.sourceRevision
    ),
    index("csm_previews_owner_hash_idx").on(
      table.enrollmentId,
      table.previewHash
    ),
    check(
      "csm_previews_revision_count_check",
      sql`${table.previewRevision} > 0 and ${table.sourceRevision} >= 0 and ${table.itemCount} > 0`
    ),
    check(
      "csm_previews_hashes_check",
      sql`length(${table.previewHash}) = 64
        and length(${table.sourceHash}) = 64
        and length(${table.redactedContentHash}) = 64
        and length(${table.protectedDtoHash}) = 64`
    )
  ]
);

export const collaborationSharedMemoryConsents = pgTable(
  "collaboration_shared_memory_consents",
  {
    id: id(),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => collaborationSharedMemoryEnrollments.id, {
        onDelete: "cascade"
      }),
    consentId: uuid("consent_id").notNull(),
    consentVersion: integer("consent_version").notNull(),
    previewId: uuid("preview_id").notNull(),
    previewHash: text("preview_hash").notNull(),
    previewRevision: integer("preview_revision").notNull(),
    logicalMemoryId: uuid("logical_memory_id").notNull(),
    teamId: uuid("team_id").notNull(),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    sourceRevision: bigint("source_revision", { mode: "number" }).notNull(),
    protectedDtoHash: text("protected_dto_hash").notNull(),
    protectedDto: jsonb("protected_dto")
      .$type<EncryptedPayloadEnvelope>()
      .notNull(),
    createdAt: now()
  },
  (table) => [
    unique("csm_consents_version_unique").on(
      table.enrollmentId,
      table.consentId,
      table.consentVersion
    ),
    index("csm_consents_current_idx").on(
      table.enrollmentId,
      table.consentId,
      table.consentVersion.desc()
    ),
    index("csm_consents_preview_idx").on(
      table.enrollmentId,
      table.previewId,
      table.previewHash
    ),
    foreignKey({
      columns: [
        table.enrollmentId,
        table.previewId,
        table.previewHash,
        table.previewRevision,
        table.logicalMemoryId,
        table.teamId,
        table.teamWorkspaceId,
        table.sourceRevision
      ],
      foreignColumns: [
        collaborationSharedMemoryPreviews.enrollmentId,
        collaborationSharedMemoryPreviews.previewId,
        collaborationSharedMemoryPreviews.previewHash,
        collaborationSharedMemoryPreviews.previewRevision,
        collaborationSharedMemoryPreviews.logicalMemoryId,
        collaborationSharedMemoryPreviews.teamId,
        collaborationSharedMemoryPreviews.teamWorkspaceId,
        collaborationSharedMemoryPreviews.sourceRevision
      ],
      name: "csm_consents_preview_binding_fk"
    }).onDelete("restrict"),
    check(
      "csm_consents_version_revision_check",
      sql`${table.consentVersion} > 0 and ${table.previewRevision} > 0 and ${table.sourceRevision} >= 0`
    ),
    check(
      "csm_consents_hashes_check",
      sql`length(${table.previewHash}) = 64 and length(${table.protectedDtoHash}) = 64`
    )
  ]
);

export const collaborationSharedMemoryCompanionBindings = pgTable(
  "collaboration_shared_memory_companion_bindings",
  {
    id: id(),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => collaborationSharedMemoryEnrollments.id, {
        onDelete: "cascade"
      }),
    shareGrantId: uuid("share_grant_id").notNull(),
    logicalMemoryId: uuid("logical_memory_id").notNull(),
    teamId: uuid("team_id").notNull(),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    companionThreadId: uuid("companion_thread_id").notNull(),
    sharedSessionId: uuid("shared_session_id").notNull(),
    createdAt: now(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("csm_companion_bindings_active_grant_unique")
      .on(table.enrollmentId, table.shareGrantId)
      .where(sql`${table.revokedAt} is null`),
    uniqueIndex("csm_companion_bindings_active_session_unique")
      .on(table.enrollmentId, table.sharedSessionId)
      .where(sql`${table.revokedAt} is null`),
    uniqueIndex("csm_companion_bindings_active_thread_unique")
      .on(table.enrollmentId, table.companionThreadId)
      .where(sql`${table.revokedAt} is null`),
    unique("csm_companion_bindings_scope_unique").on(
      table.id,
      table.enrollmentId,
      table.shareGrantId,
      table.logicalMemoryId,
      table.teamId,
      table.teamWorkspaceId
    )
  ]
);

export const collaborationSharedMemoryGrants = pgTable(
  "collaboration_shared_memory_grants",
  {
    id: id(),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => collaborationSharedMemoryEnrollments.id, {
        onDelete: "cascade"
      }),
    companionBindingId: uuid("companion_binding_id").notNull(),
    shareGrantId: uuid("share_grant_id").notNull(),
    logicalGrantId: uuid("logical_grant_id").notNull(),
    logicalMemoryId: uuid("logical_memory_id").notNull(),
    consentId: uuid("consent_id").notNull(),
    teamId: uuid("team_id").notNull(),
    teamWorkspaceId: uuid("team_workspace_id").notNull(),
    activeRepresentation: sharedMemoryRepresentation("active_representation"),
    sourceRevision: bigint("source_revision", { mode: "number" }).notNull(),
    grantVersion: integer("grant_version").notNull(),
    lifecycle: shareGrantLifecycle("lifecycle").notNull(),
    protectedDtoHash: text("protected_dto_hash").notNull(),
    protectedDto: jsonb("protected_dto")
      .$type<EncryptedPayloadEnvelope>()
      .notNull(),
    createdAt: now()
  },
  (table) => [
    unique("csm_grants_version_unique").on(
      table.enrollmentId,
      table.shareGrantId,
      table.grantVersion
    ),
    index("csm_grants_current_idx").on(
      table.enrollmentId,
      table.shareGrantId,
      table.grantVersion.desc()
    ),
    index("csm_grants_session_read_idx").on(
      table.companionBindingId,
      table.grantVersion.desc()
    ),
    foreignKey({
      columns: [
        table.companionBindingId,
        table.enrollmentId,
        table.shareGrantId,
        table.logicalMemoryId,
        table.teamId,
        table.teamWorkspaceId
      ],
      foreignColumns: [
        collaborationSharedMemoryCompanionBindings.id,
        collaborationSharedMemoryCompanionBindings.enrollmentId,
        collaborationSharedMemoryCompanionBindings.shareGrantId,
        collaborationSharedMemoryCompanionBindings.logicalMemoryId,
        collaborationSharedMemoryCompanionBindings.teamId,
        collaborationSharedMemoryCompanionBindings.teamWorkspaceId
      ],
      name: "csm_grants_companion_binding_fk"
    }).onDelete("restrict"),
    check(
      "csm_grants_version_revision_check",
      sql`${table.grantVersion} > 0 and ${table.sourceRevision} >= 0`
    ),
    check(
      "csm_grants_protected_dto_hash_check",
      sql`length(${table.protectedDtoHash}) = 64`
    )
  ]
);

/** PDS control-plane tables deliberately do not reference Team/workspace/sync tables. */
export const localPersonalIdentities = pgTable(
  "local_personal_identities",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    opaqueIdentityId: text("opaque_identity_id").notNull().unique(),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("local_personal_identities_owner_unique").on(table.ownerUserId),
    check(
      "local_personal_identities_opaque_id_check",
      sql`length(trim(${table.opaqueIdentityId})) > 0`
    )
  ]
);

export const personalDeviceGroups = pgTable(
  "personal_device_groups",
  {
    id: id(),
    localPersonalIdentityId: uuid("local_personal_identity_id")
      .notNull()
      .references(() => localPersonalIdentities.id, { onDelete: "cascade" }),
    groupId: text("group_id").notNull().unique(),
    authorityKeyId: text("authority_key_id").notNull(),
    authorityPublicKey: text("authority_public_key").notNull(),
    recoverySigningKeyId: text("recovery_signing_key_id").notNull(),
    recoverySigningPublicKey: text("recovery_signing_public_key").notNull(),
    recoveryKemKeyId: text("recovery_kem_key_id").notNull(),
    recoveryKemPublicKey: text("recovery_kem_public_key").notNull(),
    recoveryKitHash: text("recovery_kit_hash").notNull(),
    currentEpoch: text("current_epoch").notNull(),
    pendingEpoch: text("pending_epoch"),
    pendingStatementSequence: text("pending_statement_sequence"),
    pendingStatementHash: text("pending_statement_hash"),
    pendingBundleHash: text("pending_bundle_hash"),
    headSequence: text("head_sequence").notNull(),
    headHash: text("head_hash").notNull(),
    state: personalDeviceGroupState("state").notNull().default("active"),
    stateReason: text("state_reason"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("personal_device_groups_identity_unique").on(
      table.localPersonalIdentityId
    ),
    check(
      "personal_device_groups_epoch_check",
      sql`${table.currentEpoch} ~ '^(0|[1-9][0-9]*)$'`
    ),
    check(
      "personal_device_groups_sequence_check",
      sql`${table.headSequence} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const personalDeviceGroupUserSubjects = pgTable(
  "personal_device_group_user_subjects",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subjectId: text("subject_id").notNull(),
    deploymentId: text("deployment_id").notNull(),
    createdAt: now(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    unique("personal_device_group_subject_unique").on(
      table.groupId,
      table.userId
    ),
    check(
      "personal_device_group_subject_not_empty_check",
      sql`length(trim(${table.subjectId})) > 0 and length(trim(${table.deploymentId})) > 0`
    )
  ]
);

export const personalDeviceGroupMembers = pgTable(
  "personal_device_group_members",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    userSubjectId: uuid("user_subject_id")
      .notNull()
      .references(() => personalDeviceGroupUserSubjects.id, {
        onDelete: "restrict"
      }),
    deviceId: text("device_id").notNull(),
    signingKeyId: text("signing_key_id").notNull(),
    signingPublicKey: text("signing_public_key").notNull(),
    kemKeyId: text("kem_key_id").notNull(),
    kemPublicKey: text("kem_public_key").notNull(),
    operationFamilies: text("operation_families").array().notNull(),
    status: personalDeviceMemberStatus("status").notNull().default("active"),
    admittedSequence: text("admitted_sequence").notNull(),
    revokedSequence: text("revoked_sequence"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("personal_device_group_member_device_unique").on(
      table.groupId,
      table.deviceId
    ),
    unique("personal_device_group_member_signing_key_unique").on(
      table.groupId,
      table.signingKeyId
    ),
    unique("personal_device_group_member_kem_key_unique").on(
      table.groupId,
      table.kemKeyId
    ),
    unique("personal_device_group_member_signing_public_unique").on(
      table.groupId,
      table.signingPublicKey
    ),
    unique("personal_device_group_member_kem_public_unique").on(
      table.groupId,
      table.kemPublicKey
    ),
    index("personal_device_group_members_active_idx").on(
      table.groupId,
      table.status
    ),
    check(
      "personal_device_group_member_operation_check",
      sql`${table.operationFamilies} = ARRAY['pds_relay']::text[]`
    )
  ]
);

export const personalDeviceGroupStatements = pgTable(
  "personal_device_group_statements",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    sequence: text("sequence").notNull(),
    previousHash: text("previous_hash"),
    statementHash: text("statement_hash").notNull(),
    kind: text("kind").notNull(),
    canonicalStatement: text("canonical_statement").notNull(),
    redactedMetadata: jsonb("redacted_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: now()
  },
  (table) => [
    unique("personal_device_group_statement_sequence_unique").on(
      table.groupId,
      table.sequence
    ),
    unique("personal_device_group_statement_hash_unique").on(
      table.groupId,
      table.statementHash
    ),
    check(
      "personal_device_group_statement_sequence_check",
      sql`${table.sequence} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const personalDeviceGroupKeyBundles = pgTable(
  "personal_device_group_key_bundles",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    bundleHash: text("bundle_hash").notNull(),
    epoch: text("epoch").notNull(),
    transitionKind: text("transition_kind").notNull(),
    recipientSnapshot: text("recipient_snapshot").array().notNull(),
    canonicalBundle: text("canonical_bundle").notNull(),
    createdAt: now()
  },
  (table) => [
    unique("personal_device_group_key_bundle_hash_unique").on(
      table.groupId,
      table.bundleHash
    ),
    unique("personal_device_group_key_bundle_epoch_unique").on(
      table.groupId,
      table.epoch
    ),
    check(
      "personal_device_group_key_bundle_epoch_check",
      sql`${table.epoch} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const personalDeviceEpochAcks = pgTable(
  "personal_device_epoch_acks",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => personalDeviceGroupMembers.id, { onDelete: "cascade" }),
    epoch: text("epoch").notNull(),
    canonicalAck: text("canonical_ack").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", {
      withTimezone: true
    }).notNull(),
    createdAt: now()
  },
  (table) => [
    unique("personal_device_epoch_ack_unique").on(
      table.groupId,
      table.memberId,
      table.epoch
    ),
    check(
      "personal_device_epoch_ack_epoch_check",
      sql`${table.epoch} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const personalDeviceEnrollmentChallenges = pgTable(
  "personal_device_enrollment_challenges",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id"),
    browserSubjectId: text("browser_subject_id").notNull(),
    browserDeploymentId: text("browser_deployment_id").notNull(),
    challengeHash: text("challenge_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: now()
  },
  (table) => [
    index("personal_device_enrollment_challenge_active_idx")
      .on(table.userId, table.expiresAt)
      .where(sql`${table.usedAt} is null`),
    check(
      "personal_device_enrollment_challenge_hash_check",
      sql`length(${table.challengeHash}) = 43`
    )
  ]
);

export const personalDeviceMembershipCertificates = pgTable(
  "personal_device_membership_certificates",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => personalDeviceGroupMembers.id, { onDelete: "cascade" }),
    epoch: text("epoch").notNull(),
    statementSequence: text("statement_sequence").notNull(),
    statementHash: text("statement_hash").notNull(),
    authorityKeyId: text("authority_key_id").notNull(),
    canonicalCertificate: text("canonical_certificate").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    unique("personal_device_membership_certificate_epoch_unique").on(
      table.groupId,
      table.memberId,
      table.epoch
    ),
    index("personal_device_membership_certificate_active_idx")
      .on(table.groupId, table.expiresAt)
      .where(sql`${table.revokedAt} is null`),
    check(
      "personal_device_membership_certificate_epoch_check",
      sql`${table.epoch} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const personalSyncPolicies = pgTable(
  "personal_sync_policies",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    /** Effective time is set by local data-plane trigger on policy activation. */
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    /** Durable kill switch. Close, claim, and network action all read this row. */
    publicationPaused: boolean("publication_paused").notNull().default(false),
    futureClosedSessionsOnly: boolean("future_closed_sessions_only")
      .notNull()
      .default(true),
    historicalBackfillEnabled: boolean("historical_backfill_enabled")
      .notNull()
      .default(false),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("personal_sync_policies_group_unique").on(table.groupId),
    check(
      "personal_sync_policies_closed_only_check",
      sql`${table.futureClosedSessionsOnly} and not ${table.historicalBackfillEnabled}`
    )
  ]
);

export const personalDeviceRemoteLinkNonces = pgTable(
  "personal_device_remote_link_nonces",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    issuerDeploymentId: text("issuer_deployment_id").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: now()
  },
  (table) => [
    unique("personal_device_remote_link_nonce_unique").on(
      table.issuerDeploymentId,
      table.nonceHash
    )
  ]
);

export const remoteAccountLinks = pgTable(
  "remote_account_links",
  {
    id: id(),
    localPersonalIdentityId: uuid("local_personal_identity_id")
      .notNull()
      .references(() => localPersonalIdentities.id, { onDelete: "cascade" }),
    remoteIssuer: text("remote_issuer").notNull(),
    remoteDeploymentId: text("remote_deployment_id").notNull(),
    remoteSubjectId: text("remote_subject_id").notNull(),
    proofNonceHash: text("proof_nonce_hash").notNull(),
    proofExpiresAt: timestamp("proof_expires_at", {
      withTimezone: true
    }).notNull(),
    syncEnabled: boolean("sync_enabled").notNull().default(false),
    createdAt: now(),
    updatedAt: updatedNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    unique("remote_account_links_identity_remote_unique").on(
      table.localPersonalIdentityId,
      table.remoteDeploymentId,
      table.remoteSubjectId
    ),
    check(
      "remote_account_links_issuer_check",
      sql`length(trim(${table.remoteIssuer})) > 0`
    ),
    check(
      "remote_account_links_no_implicit_sync_check",
      sql`not ${table.syncEnabled}`
    )
  ]
);

export const pdsSessionClosures = pgTable(
  "pds_session_closures",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceSessionId: uuid("source_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    sourceSequence: text("source_sequence").notNull(),
    terminalCursor: text("terminal_cursor").notNull(),
    terminalItemCount: text("terminal_item_count").notNull(),
    sourceClosureHash: text("source_closure_hash").notNull(),
    packageId: text("package_id").notNull(),
    sourceManifestHash: text("source_manifest_hash").notNull(),
    state: text("state").notNull().default("ready"),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    createdAt: now()
  },
  (table) => [
    unique("pds_session_closure_session_unique").on(
      table.groupId,
      table.sourceSessionId
    ),
    unique("pds_session_closure_sequence_unique").on(
      table.groupId,
      table.sourceSequence
    ),
    unique("pds_session_closure_package_unique").on(
      table.groupId,
      table.packageId
    ),
    check(
      "pds_session_closure_sequence_check",
      sql`${table.sourceSequence} ~ '^(0|[1-9][0-9]*)$' and ${table.terminalCursor} ~ '^(0|[1-9][0-9]*)$' and ${table.terminalItemCount} ~ '^(0|[1-9][0-9]*)$'`
    ),
    check(
      "pds_session_closure_state_check",
      sql`${table.state} in ('ready','quarantined','revoked')`
    )
  ]
);

export const pdsOriginSequences = pgTable(
  "pds_origin_sequences",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    originDeploymentId: text("origin_deployment_id").notNull(),
    originDeviceId: text("origin_device_id").notNull(),
    nextSequence: text("next_sequence").notNull().default("0"),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_origin_sequence_unique").on(
      table.groupId,
      table.originDeploymentId,
      table.originDeviceId
    ),
    check(
      "pds_origin_sequence_decimal_check",
      sql`${table.nextSequence} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const pdsRetainedPackages = pgTable(
  "pds_retained_packages",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    packageId: text("package_id").notNull(),
    sourceManifestHash: text("source_manifest_hash").notNull(),
    sourceFingerprint: text("source_fingerprint"),
    sourceClosureHash: text("source_closure_hash"),
    originDeploymentId: text("origin_deployment_id").notNull(),
    originDeviceId: text("origin_device_id").notNull(),
    sourceSequence: text("source_sequence").notNull(),
    logicalMemoryId: text("logical_memory_id"),
    deletionFloorToken: text("deletion_floor_token"),
    encryptedEnvelope: jsonb("encrypted_envelope")
      .$type<Record<string, unknown>>()
      .notNull(),
    state: text("state").notNull().default("ready"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_retained_package_unique").on(table.groupId, table.packageId),
    index("pds_retained_packages_floor_idx").on(
      table.groupId,
      table.deletionFloorToken
    ),
    unique("pds_retained_origin_sequence_unique").on(
      table.groupId,
      table.originDeploymentId,
      table.originDeviceId,
      table.sourceSequence
    ),
    check(
      "pds_retained_package_sequence_check",
      sql`${table.sourceSequence} ~ '^(0|[1-9][0-9]*)$'`
    ),
    check(
      "pds_retained_package_state_check",
      sql`${table.state} in ('ready','stale','quarantined','revoked')`
    )
  ]
);

export const pdsLogicalReplicas = pgTable(
  "pds_logical_replicas",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceFingerprint: text("source_fingerprint"),
    closureHash: text("closure_hash").notNull(),
    localSessionId: uuid("local_session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    materializationState: text("materialization_state")
      .notNull()
      .default("pending"),
    conflictId: uuid("conflict_id"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_logical_replica_fingerprint_closure_unique").on(
      table.groupId,
      table.sourceFingerprint,
      table.closureHash
    ),
    unique("pds_logical_replica_local_session_unique").on(table.localSessionId),
    index("pds_logical_replica_recall_idx").on(
      table.ownerUserId,
      table.materializationState
    ),
    check(
      "pds_logical_replica_state_check",
      sql`${table.materializationState} in ('pending','downloading','verifying','processing','ready','stale','failed','quarantined','revoked')`
    )
  ]
);

export const pdsReplicaObservations = pgTable(
  "pds_replica_observations",
  {
    id: id(),
    replicaId: uuid("replica_id")
      .notNull()
      .references(() => pdsLogicalReplicas.id, { onDelete: "cascade" }),
    retainedPackageId: uuid("retained_package_id")
      .notNull()
      .references(() => pdsRetainedPackages.id, { onDelete: "cascade" }),
    originDeploymentId: text("origin_deployment_id").notNull(),
    originDeviceId: text("origin_device_id").notNull(),
    sourceSequence: text("source_sequence").notNull(),
    sourceClosedAt: timestamp("source_closed_at", {
      withTimezone: true
    }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: now()
  },
  (table) => [
    unique("pds_replica_observation_origin_sequence_unique").on(
      table.replicaId,
      table.originDeploymentId,
      table.originDeviceId,
      table.sourceSequence
    ),
    unique("pds_replica_observation_package_unique").on(
      table.retainedPackageId
    ),
    check(
      "pds_replica_observation_sequence_check",
      sql`${table.sourceSequence} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const pdsOutboxEntries = pgTable(
  "pds_outbox_entries",
  {
    id: id(),
    closureId: uuid("closure_id")
      .notNull()
      .references(() => pdsSessionClosures.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    retryAt: timestamp("retry_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastErrorClass: text("last_error_class"),
    transportId: text("transport_id"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_outbox_closure_unique").on(table.closureId),
    unique("pds_outbox_idempotency_unique").on(table.idempotencyKey),
    index("pds_outbox_claim_idx").on(table.state, table.retryAt),
    check(
      "pds_outbox_state_check",
      sql`${table.state} in ('pending','uploading','committed','acked','paused','failed','quarantined')`
    ),
    check("pds_outbox_attempt_count_check", sql`${table.attemptCount} >= 0`)
  ]
);

export const pdsInboxEntries = pgTable(
  "pds_inbox_entries",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    packageId: text("package_id").notNull(),
    sourceManifestHash: text("source_manifest_hash").notNull(),
    state: text("state").notNull().default("pending"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    retryAt: timestamp("retry_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastErrorClass: text("last_error_class"),
    retainedPackageId: uuid("retained_package_id").references(
      () => pdsRetainedPackages.id,
      { onDelete: "set null" }
    ),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_inbox_replay_unique").on(table.groupId, table.packageId),
    index("pds_inbox_claim_idx").on(table.state, table.retryAt),
    check(
      "pds_inbox_state_check",
      sql`${table.state} in ('pending','downloading','verifying','processing','ready','stale','failed','quarantined','revoked')`
    ),
    check("pds_inbox_attempt_count_check", sql`${table.attemptCount} >= 0`)
  ]
);

export const pdsPortableArtifacts = pgTable(
  "pds_portable_artifacts",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    localSessionId: uuid("local_session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    artifactId: text("artifact_id").notNull(),
    workIdentity: text("work_identity").notNull(),
    artifactClass: text("artifact_class").notNull(),
    sourcePackageId: text("source_package_id").notNull(),
    sourceManifestHash: text("source_manifest_hash").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    sourceClosureHash: text("source_closure_hash").notNull(),
    producerDeviceId: text("producer_device_id").notNull(),
    claimGeneration: text("claim_generation").notNull(),
    compatibilityContractHash: text("compatibility_contract_hash").notNull(),
    payloadHash: text("payload_hash").notNull(),
    transportManifestHash: text("transport_manifest_hash").notNull(),
    semanticClaimCompletedAt: timestamp("semantic_claim_completed_at", {
      withTimezone: true
    }),
    encryptedEnvelope: jsonb("encrypted_envelope")
      .$type<Record<string, unknown>>()
      .notNull(),
    state: text("state").notNull().default("ready"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_portable_artifact_group_identity_unique").on(
      table.groupId,
      table.artifactId
    ),
    unique("pds_portable_artifact_work_generation_unique").on(
      table.groupId,
      table.workIdentity,
      table.claimGeneration
    ),
    index("pds_portable_artifact_source_idx").on(
      table.groupId,
      table.sourceFingerprint,
      table.sourceClosureHash,
      table.artifactClass
    ),
    check(
      "pds_portable_artifact_class_check",
      sql`${table.artifactClass} in ('memory_event/v1','memory_embedding/v1','lcm_node/v1')`
    ),
    check(
      "pds_portable_artifact_state_check",
      sql`${table.state} in ('ready','published','imported','incompatible','quarantined','revoked')`
    ),
    check(
      "pds_portable_artifact_generation_check",
      sql`${table.claimGeneration} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const pdsArtifactOutboxEntries = pgTable(
  "pds_artifact_outbox_entries",
  {
    id: id(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => pdsPortableArtifacts.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    retryAt: timestamp("retry_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastErrorClass: text("last_error_class"),
    transportId: text("transport_id"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_artifact_outbox_artifact_unique").on(table.artifactId),
    unique("pds_artifact_outbox_idempotency_unique").on(table.idempotencyKey),
    index("pds_artifact_outbox_claim_idx").on(table.state, table.retryAt),
    check(
      "pds_artifact_outbox_state_check",
      sql`${table.state} in ('pending','uploading','committed','acked','paused','failed','quarantined')`
    ),
    check(
      "pds_artifact_outbox_attempt_count_check",
      sql`${table.attemptCount} >= 0`
    )
  ]
);

export const pdsArtifactInboxEntries = pgTable(
  "pds_artifact_inbox_entries",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    packageId: text("package_id").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    state: text("state").notNull().default("pending"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    retryAt: timestamp("retry_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastErrorClass: text("last_error_class"),
    retainedArtifactId: uuid("retained_artifact_id").references(
      () => pdsPortableArtifacts.id,
      { onDelete: "set null" }
    ),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_artifact_inbox_replay_unique").on(
      table.groupId,
      table.packageId
    ),
    index("pds_artifact_inbox_claim_idx").on(table.state, table.retryAt),
    check(
      "pds_artifact_inbox_state_check",
      sql`${table.state} in ('pending','downloading','verifying','processing','ready','incompatible','failed','quarantined','revoked')`
    ),
    check(
      "pds_artifact_inbox_attempt_count_check",
      sql`${table.attemptCount} >= 0`
    )
  ]
);

export const pdsMemoryEventMappings = pgTable(
  "pds_memory_event_mappings",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    memoryEventId: uuid("memory_event_id")
      .notNull()
      .references(() => memoryEvents.id, { onDelete: "cascade" }),
    logicalEventId: text("logical_event_id").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    sourceClosureHash: text("source_closure_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceOrdinals: text("source_ordinals").array().notNull(),
    createdAt: now()
  },
  (table) => [
    unique("pds_memory_event_mapping_event_unique").on(table.memoryEventId),
    unique("pds_memory_event_mapping_logical_unique").on(
      table.groupId,
      table.logicalEventId
    )
  ]
);

export const pdsMemoryEmbeddingMappings = pgTable(
  "pds_memory_embedding_mappings",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    memoryEmbeddingId: uuid("memory_embedding_id")
      .notNull()
      .references(() => memoryEmbeddings.id, { onDelete: "cascade" }),
    logicalEmbeddingId: text("logical_embedding_id").notNull(),
    logicalSourceType: text("logical_source_type").notNull(),
    logicalSourceId: text("logical_source_id").notNull(),
    sourceContentHash: text("source_content_hash").notNull(),
    compatibilityContractHash: text("compatibility_contract_hash").notNull(),
    vectorHash: text("vector_hash").notNull(),
    createdAt: now()
  },
  (table) => [
    unique("pds_memory_embedding_mapping_embedding_unique").on(
      table.memoryEmbeddingId
    ),
    unique("pds_memory_embedding_mapping_logical_unique").on(
      table.groupId,
      table.logicalEmbeddingId
    ),
    check(
      "pds_memory_embedding_mapping_source_type_check",
      sql`${table.logicalSourceType} in ('memory_event','lcm_node')`
    )
  ]
);

export const pdsLcmNodeMappings = pgTable(
  "pds_lcm_node_mappings",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    memoryNodeId: uuid("memory_node_id")
      .notNull()
      .references(() => memoryNodes.id, { onDelete: "cascade" }),
    logicalNodeId: text("logical_node_id").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    sourceClosureHash: text("source_closure_hash").notNull(),
    compatibilityContractHash: text("compatibility_contract_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: now()
  },
  (table) => [
    unique("pds_lcm_node_mapping_node_unique").on(table.memoryNodeId),
    unique("pds_lcm_node_mapping_logical_unique").on(
      table.groupId,
      table.logicalNodeId
    )
  ]
);

export const pdsSemanticWorkClaims = pgTable(
  "pds_semantic_work_claims",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    workIdentity: text("work_identity").notNull(),
    workClass: text("work_class").notNull(),
    compatibilityContractHash: text("compatibility_contract_hash").notNull(),
    claimantDeviceId: text("claimant_device_id").notNull(),
    localSourceType: text("local_source_type"),
    localSourceId: uuid("local_source_id"),
    sourceContentHash: text("source_content_hash"),
    claimGeneration: text("claim_generation").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    state: text("state").notNull().default("active"),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_semantic_work_claim_identity_unique").on(
      table.groupId,
      table.workIdentity
    ),
    index("pds_semantic_work_claim_expiry_idx").on(
      table.groupId,
      table.state,
      table.expiresAt
    ),
    check(
      "pds_semantic_work_claim_class_check",
      sql`${table.workClass} in ('projection','memory_embedding','lcm_leaf','lcm_rollup')`
    ),
    check(
      "pds_semantic_work_claim_local_source_check",
      sql`(${table.localSourceType} is null and ${table.localSourceId} is null and ${table.sourceContentHash} is null)
        or (${table.localSourceType} in ('memory_event','lcm_node') and ${table.localSourceId} is not null and ${table.sourceContentHash} is not null)`
    ),
    check(
      "pds_semantic_work_claim_state_check",
      sql`${table.state} in ('active','completed','released','superseded')`
    ),
    check(
      "pds_semantic_work_claim_generation_check",
      sql`${table.claimGeneration} ~ '^(0|[1-9][0-9]*)$' and ${table.expiresAt} > ${table.claimedAt}`
    )
  ]
);

export const pdsDeviceCapabilities = pgTable(
  "pds_device_capabilities",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    capability: text("capability").notNull(),
    compatibilityContractHash: text("compatibility_contract_hash").notNull(),
    readiness: text("readiness").notNull(),
    canonicalRecord: text("canonical_record").notNull(),
    recordHash: text("record_hash").notNull(),
    advertisedAt: timestamp("advertised_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: now(),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_device_capability_identity_unique").on(
      table.groupId,
      table.deviceId,
      table.capability,
      table.compatibilityContractHash
    ),
    index("pds_device_capability_ready_idx").on(
      table.groupId,
      table.capability,
      table.readiness,
      table.expiresAt
    ),
    check(
      "pds_device_capability_kind_check",
      sql`${table.capability} in ('projection','memory_embedding','lcm')`
    ),
    check(
      "pds_device_capability_readiness_check",
      sql`${table.readiness} in ('ready','busy','unavailable') and ${table.expiresAt} > ${table.advertisedAt}`
    )
  ]
);

export const pdsTransportMappings = pgTable(
  "pds_transport_mappings",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    packageId: text("package_id").notNull(),
    transportId: text("transport_id").notNull(),
    direction: text("direction").notNull(),
    createdAt: now()
  },
  (table) => [
    unique("pds_transport_mapping_transport_unique").on(
      table.groupId,
      table.transportId
    ),
    unique("pds_transport_mapping_package_direction_unique").on(
      table.groupId,
      table.packageId,
      table.direction
    ),
    check(
      "pds_transport_mapping_direction_check",
      sql`${table.direction} in ('outbound','inbound')`
    )
  ]
);

export const pdsOriginHighWaterMarks = pgTable(
  "pds_origin_high_water_marks",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    originDeploymentId: text("origin_deployment_id").notNull(),
    originDeviceId: text("origin_device_id").notNull(),
    acceptedSequence: text("accepted_sequence").notNull().default("0"),
    servedSequence: text("served_sequence").notNull().default("0"),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_origin_high_water_unique").on(
      table.groupId,
      table.originDeploymentId,
      table.originDeviceId
    ),
    check(
      "pds_origin_high_water_decimal_check",
      sql`${table.acceptedSequence} ~ '^(0|[1-9][0-9]*)$' and ${table.servedSequence} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const pdsConflicts = pgTable(
  "pds_conflicts",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    sourceFingerprint: text("source_fingerprint").notNull(),
    state: text("state").notNull().default("quarantined"),
    resolutionStatementHash: text("resolution_statement_hash"),
    createdAt: now(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
  },
  (table) => [
    unique("pds_conflict_fingerprint_unique").on(
      table.groupId,
      table.sourceFingerprint
    ),
    check(
      "pds_conflict_state_check",
      sql`${table.state} in ('quarantined','resolved')`
    )
  ]
);

export const pdsTombstoneLedger = pgTable(
  "pds_tombstone_ledger",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    logicalMemoryId: text("logical_memory_id").notNull(),
    deletionFloorToken: text("deletion_floor_token").notNull(),
    tombstoneHash: text("tombstone_hash").notNull(),
    tombstoneSequence: text("tombstone_sequence").notNull(),
    statementHash: text("statement_hash").notNull(),
    encryptedRecord: jsonb("encrypted_record")
      .$type<Record<string, unknown>>()
      .notNull(),
    /** Signed opaque control bytes. Never Memory plaintext. */
    canonicalRecord: text("canonical_record").notNull(),
    statementSequence: text("statement_sequence").notNull(),
    activeDeviceSnapshot: text("active_device_snapshot").array().notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    quorumCompletedAt: timestamp("quorum_completed_at", { withTimezone: true }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    createdAt: now()
  },
  (table) => [
    unique("pds_tombstone_ledger_group_floor_unique").on(
      table.groupId,
      table.deletionFloorToken
    ),
    unique("pds_tombstone_ledger_hash_unique").on(
      table.groupId,
      table.tombstoneHash
    ),
    index("pds_tombstone_ledger_retention_idx").on(table.retainUntil),
    index("pds_tombstone_ledger_control_idx").on(
      table.groupId,
      table.statementSequence
    ),
    check(
      "pds_tombstone_ledger_sequence_check",
      sql`${table.tombstoneSequence} ~ '^(0|[1-9][0-9]*)$' and ${table.statementSequence} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const pdsDeletionFloors = pgTable(
  "pds_deletion_floors",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "restrict" }),
    logicalMemoryId: text("logical_memory_id").notNull(),
    deletionFloorToken: text("deletion_floor_token").notNull(),
    tombstoneHash: text("tombstone_hash").notNull(),
    createdAt: now()
  },
  (table) => [
    unique("pds_deletion_floor_group_token_unique").on(
      table.groupId,
      table.deletionFloorToken
    ),
    unique("pds_deletion_floor_group_logical_unique").on(
      table.groupId,
      table.logicalMemoryId
    )
  ]
);

export const pdsTombstoneAcks = pgTable(
  "pds_tombstone_acks",
  {
    id: id(),
    tombstoneId: uuid("tombstone_id")
      .notNull()
      .references(() => pdsTombstoneLedger.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    canonicalAck: text("canonical_ack").notNull(),
    ackHash: text("ack_hash").notNull(),
    ackedAt: timestamp("acked_at", { withTimezone: true }).notNull(),
    waivedAt: timestamp("waived_at", { withTimezone: true }),
    waiverStatementHash: text("waiver_statement_hash"),
    createdAt: now()
  },
  (table) => [
    unique("pds_tombstone_ack_snapshot_unique").on(
      table.tombstoneId,
      table.deviceId
    ),
    unique("pds_tombstone_ack_hash_unique").on(
      table.tombstoneId,
      table.ackHash
    ),
    check(
      "pds_tombstone_ack_waiver_check",
      sql`(${table.waivedAt} is null) = (${table.waiverStatementHash} is null)`
    )
  ]
);

export const pdsReplicaLifecycleState = pgTable(
  "pds_replica_lifecycle_state",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    authorityHead: text("authority_head").notNull(),
    authoritySequence: text("authority_sequence").notNull(),
    lifecycleHighWater: text("lifecycle_high_water").notNull().default("0"),
    restoreHighWater: text("restore_high_water").notNull().default("0"),
    updatedAt: updatedNow()
  },
  (table) => [
    unique("pds_replica_lifecycle_group_device_unique").on(
      table.groupId,
      table.deviceId
    ),
    check(
      "pds_replica_lifecycle_water_check",
      sql`${table.authoritySequence} ~ '^(0|[1-9][0-9]*)$' and ${table.lifecycleHighWater} ~ '^(0|[1-9][0-9]*)$' and ${table.restoreHighWater} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const pdsRestoreReconciliations = pgTable(
  "pds_restore_reconciliations",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    authorityHead: text("authority_head").notNull(),
    authoritySequence: text("authority_sequence").notNull(),
    lifecycleHighWater: text("lifecycle_high_water").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: now()
  },
  (table) => [
    index("pds_restore_reconciliation_group_created_idx").on(
      table.groupId,
      table.createdAt
    ),
    check(
      "pds_restore_reconciliation_outcome_check",
      sql`${table.outcome} in ('accepted','rollback_rejected','authority_unavailable')`
    ),
    check(
      "pds_restore_reconciliation_sequence_check",
      sql`${table.authoritySequence} ~ '^(0|[1-9][0-9]*)$' and ${table.lifecycleHighWater} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const pdsConflictResolutionRecords = pgTable(
  "pds_conflict_resolution_records",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    sourceFingerprint: text("source_fingerprint").notNull(),
    resolutionHash: text("resolution_hash").notNull(),
    statementHash: text("statement_hash").notNull(),
    resolution: text("resolution").notNull(),
    selectedClosureHash: text("selected_closure_hash"),
    candidateClosureHashes: text("candidate_closure_hashes").array().notNull(),
    canonicalRecord: text("canonical_record").notNull(),
    statementSequence: text("statement_sequence").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    createdAt: now()
  },
  (table) => [
    unique("pds_conflict_resolution_fingerprint_unique").on(
      table.groupId,
      table.sourceFingerprint
    ),
    unique("pds_conflict_resolution_hash_unique").on(
      table.groupId,
      table.resolutionHash
    ),
    index("pds_conflict_resolution_control_idx").on(
      table.groupId,
      table.statementSequence
    ),
    check(
      "pds_conflict_resolution_kind_check",
      sql`(${table.resolution} = 'select' and ${table.selectedClosureHash} is not null) or (${table.resolution} = 'distinct' and ${table.selectedClosureHash} is null)`
    )
  ]
);

export const pdsSourceItemMappings = pgTable(
  "pds_source_item_mappings",
  {
    id: id(),
    closureId: uuid("closure_id").references(() => pdsSessionClosures.id, {
      onDelete: "cascade"
    }),
    replicaId: uuid("replica_id").references(() => pdsLogicalReplicas.id, {
      onDelete: "cascade"
    }),
    conversationItemId: uuid("conversation_item_id")
      .notNull()
      .references(() => conversationItems.id, { onDelete: "cascade" }),
    sourceOrdinal: text("source_ordinal").notNull(),
    createdAt: now()
  },
  (table) => [
    unique("pds_source_item_mapping_item_unique").on(table.conversationItemId),
    unique("pds_source_item_mapping_closure_ordinal_unique").on(
      table.closureId,
      table.sourceOrdinal
    ),
    unique("pds_source_item_mapping_replica_ordinal_unique").on(
      table.replicaId,
      table.sourceOrdinal
    ),
    check(
      "pds_source_item_mapping_owner_check",
      sql`(${table.closureId} is null) <> (${table.replicaId} is null)`
    ),
    check(
      "pds_source_item_mapping_ordinal_check",
      sql`${table.sourceOrdinal} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);

export const pdsWorkerHeartbeats = pgTable(
  "pds_worker_heartbeats",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    workerId: text("worker_id").notNull(),
    capability: text("capability").notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: now()
  },
  (table) => [
    unique("pds_worker_heartbeat_unique").on(
      table.groupId,
      table.workerId,
      table.capability
    ),
    check(
      "pds_worker_heartbeat_capability_check",
      sql`${table.capability} in ('source_publication','receiver_materialization')`
    )
  ]
);

export const personalDeviceGroupAuditEvents = pgTable(
  "personal_device_group_audit_events",
  {
    id: id(),
    groupId: uuid("group_id").references(() => personalDeviceGroups.id, {
      onDelete: "set null"
    }),
    transitionKind: text("transition_kind").notNull(),
    actorKeyId: text("actor_key_id"),
    outcome: text("outcome").notNull(),
    headSequence: text("head_sequence"),
    headHash: text("head_hash"),
    createdAt: now()
  },
  (table) => [
    check(
      "personal_device_group_audit_outcome_check",
      sql`${table.outcome} in ('accepted', 'rejected', 'conflict', 'frozen')`
    )
  ]
);

export * from "./personal-device-sync-relay-schema.js";
