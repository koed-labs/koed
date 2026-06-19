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

export const teams = pgTable(
  "teams",
  {
    id: id(),
    name: text("name").notNull(),
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
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    uniqueIndex("sessions_source_hash_unique")
      .on(table.sourceHash)
      .where(sql`${table.sourceHash} is not null`),
    check(
      "sessions_personal_owner_check",
      sql`${table.visibility} = 'personal' and ${table.ownerUserId} is not null`
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
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: now(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason")
  },
  (table) => [
    uniqueIndex("messages_transcript_item_unique")
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
    projectionStatus: text("projection_status").notNull().default("pending"),
    projectionVersion: text("projection_version"),
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
    uniqueIndex("conversation_items_personal_idempotency_key_unique")
      .on(table.ownerUserId, table.idempotencyKey)
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
