import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  COLLABORATION_CONTRACT_VERSION,
  type EnvelopeEncryptionProvider
} from "@koed/shared";

import {
  decryptAuthorizedEncryptedFieldPayloadWithClient,
  decryptTeamEncryptedFieldAfterAuthorizationWithClient,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import {
  getCapturedSessionSummaryWithClient,
  type CapturedSessionSummaryRecord
} from "./captured-session-repository.js";
import type { ActorContext } from "./types.js";

const THREAD_NAME_MARKER = "[koed encrypted collaboration name]";
const THREAD_TOPIC_MARKER = "[koed encrypted collaboration topic]";
const MESSAGE_BODY_MARKER = "[koed encrypted collaboration message]";
const MESSAGE_METADATA_MARKER = "[koed encrypted collaboration metadata]";
const MESSAGE_PROVENANCE_MARKER = "[koed encrypted collaboration provenance]";
const OUTBOX_REPLAY_DAYS = 30;
const MAX_THREAD_NAME_CODE_POINTS = 80;
const MAX_THREAD_TOPIC_BYTES = 1_024;
const MAX_MESSAGE_BODY_BYTES = 32_768;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_DM_PARTICIPANTS = 40;
const MAX_PAGE_SIZE = 200;
const MAX_REPLAY_SIZE = 500;
const MAX_SNAPSHOT_THREADS = 5_000;
const MAX_REALTIME_RECEIPT_UPDATES = 250;

export type CollaborationScope = "personal" | "team";

export type PersonalCollaborationThreadKind =
  | "notes_to_self"
  | "personal_channel";

export type TeamCollaborationThreadKind =
  | "workspace_channel"
  | "dm"
  | "group_dm"
  | "shared_session_discussion";

export type CollaborationThreadKind =
  | PersonalCollaborationThreadKind
  | TeamCollaborationThreadKind;

export type CollaborationLifecycle =
  | "active"
  | "archived"
  | "tombstoned"
  | "purge_pending"
  | "purged";

export type CollaborationEventFamily =
  | "team_lifecycle"
  | "team_membership_access"
  | "team_presence_changed"
  | "workspace_lifecycle_access"
  | "thread_lifecycle"
  | "message_created"
  | "receipt_state_updated"
  | "share_grant_lifecycle"
  | "representation_changed"
  | "memory_event_available"
  | "lcm_leaf_available"
  | "lcm_rollup_available"
  | "shared_session_discussion_activity"
  | "personal_memory_changed"
  | "pending_share_lifecycle"
  | "managed_conversation_changed"
  | "access_revoked";

export interface CollaborationParticipantRecord {
  userId: string;
  displayName: string | null;
}

export interface CollaborationThreadRecord {
  id: string;
  logicalId: string;
  scope: CollaborationScope;
  kind: CollaborationThreadKind;
  personalOwnerUserId: string | null;
  teamId: string | null;
  teamWorkspaceId: string | null;
  sharedLogicalMemoryId: string | null;
  shareGrantId: string | null;
  systemKey: "workspace.general" | null;
  name: string | null;
  topic: string | null;
  createdByUserId: string | null;
  version: number;
  lifecycle: CollaborationLifecycle;
  latestSequence: number;
  lastReadMessageId: string | null;
  lastReadSequence: number;
  unreadCount: number;
  participants: CollaborationParticipantRecord[];
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  archivedAt: string | null;
}

export interface CollaborationMessageProvenance {
  kind: string;
  id: string;
  details?: Record<string, unknown>;
}

export interface CollaborationMessageRecord {
  id: string;
  threadId: string;
  threadSequence: number;
  audienceVersion: number;
  scope: CollaborationScope;
  personalOwnerUserId: string | null;
  teamId: string | null;
  teamWorkspaceId: string | null;
  senderKind: "user" | "system" | "imported";
  senderPrincipalId: string | null;
  senderUserId: string | null;
  senderDisplayName: string | null;
  recipientStatus: "sent" | "delivered" | "read" | null;
  bodyText: string;
  metadata: Record<string, unknown>;
  provenance: CollaborationMessageProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationMessagePageRecord {
  messages: CollaborationMessageRecord[];
  hasMore: boolean;
  nextBeforeSequence: number | null;
  nextAfterSequence: number | null;
}

export interface CollaborationMessageReceiptRecord {
  messageId: string;
  recipientStatus: "sent" | "delivered" | "read";
}

export interface CollaborationReadStateRecord {
  threadId: string;
  userId: string;
  lastDeliveredMessageId: string | null;
  lastDeliveredSequence: number;
  lastDeliveredAt: string | null;
  lastReadMessageId: string | null;
  lastReadSequence: number;
  lastReadAt: string | null;
  unreadCount: number;
  version: number;
  updatedAt: string;
}

export interface CollaborationOutboxEventRecord {
  id: string;
  cursor: number;
  protocolVersion: number;
  family: CollaborationEventFamily;
  scope: CollaborationScope;
  personalOwnerUserId: string | null;
  teamId: string | null;
  teamWorkspaceId: string | null;
  threadId: string | null;
  messageId: string | null;
  shareGrantId: string | null;
  logicalMemoryId: string | null;
  resourceType: string;
  resourceId: string;
  actorPrincipalId: string | null;
  mutationId: string;
  occurredAt: string;
}

export interface AuthorizedCollaborationSnapshotRecord {
  scope: CollaborationScope;
  personalOwnerUserId: string | null;
  teamId: string | null;
  highWaterCursor: number;
  threads: CollaborationThreadRecord[];
}

export interface CollaborationReplayRecord {
  afterCursor: number;
  events: CollaborationOutboxEventRecord[];
  hasMore: boolean;
}

export interface CollaborationReplayPruneResult {
  deletedEventCount: number;
  deletedSubscriptionCount: number;
}

export type CollaborationStreamState =
  | "active"
  | "requires_snapshot"
  | "revoked"
  | "expired";

export interface CollaborationSubscriptionRecord {
  id: string;
  protocolVersion: number;
  scope: CollaborationScope;
  personalOwnerUserId: string | null;
  teamId: string | null;
  state: CollaborationStreamState;
  snapshotHighWaterCursor: number | null;
  acknowledgedEventId: string | null;
  acknowledgedCursor: number;
  createdAt: string;
  updatedAt: string;
  lastAcknowledgedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface CollaborationSubscriptionBinding {
  backendIdentityHash: string;
  principalIdHash: string;
  deviceCredentialId: string | null;
  clientInstanceHash: string;
  subscriptionKeyHash: string;
  protocolVersion: number;
}

export type CreateCollaborationSubscriptionInput =
  | (CollaborationSubscriptionBinding & {
      scope: "personal";
      snapshotHighWaterCursor: number;
      expiresAt: Date;
    })
  | (CollaborationSubscriptionBinding & {
      scope: "team";
      teamId: string;
      snapshotHighWaterCursor: number;
      expiresAt: Date;
    });

export type RecoverCollaborationSubscriptionInput =
  | (CollaborationSubscriptionBinding & {
      scope: "personal";
      subscriptionId: string;
      afterCursor: number;
      expiresAt: Date;
    })
  | (CollaborationSubscriptionBinding & {
      scope: "team";
      teamId: string;
      subscriptionId: string;
      afterCursor: number;
      expiresAt: Date;
    });

export interface CollaborationSubscriptionRecoveryRecord {
  subscription: CollaborationSubscriptionRecord;
  requiresSnapshot: boolean;
}

export type RevokeCollaborationSubscriptionsInput =
  | {
      scope: "personal";
      backendIdentityHash: string;
      principalIdHash: string;
      reason: "access_revoked" | "requires_snapshot" | "client_replaced";
    }
  | {
      scope: "team";
      backendIdentityHash: string;
      teamId: string;
      principalIdHash?: string;
      reason: "access_revoked" | "requires_snapshot" | "client_replaced";
    };

export type CreateCollaborationThreadInput =
  | {
      kind: "notes_to_self";
      idempotencyKey: string;
    }
  | {
      kind: "personal_channel";
      idempotencyKey: string;
      name: string;
      topic?: string | null;
    }
  | {
      kind: "workspace_channel";
      idempotencyKey: string;
      teamId: string;
      teamWorkspaceId: string;
      name: string;
      topic?: string | null;
    }
  | {
      kind: "dm" | "group_dm";
      idempotencyKey: string;
      teamId: string;
      participantUserIds: string[];
    }
  | {
      kind: "shared_session_discussion";
      idempotencyKey: string;
      teamId: string;
      teamWorkspaceId: string;
      sharedLogicalMemoryId: string;
      shareGrantId: string;
      /** Internal worker authority; never accepted from public route schemas. */
      pendingShareActivation?: boolean;
    };

export interface CollaborationRepository {
  listTeamParticipants(
    actor: ActorContext,
    teamId: string
  ): Promise<CollaborationParticipantRecord[] | null>;
  createThread(
    actor: ActorContext,
    input: CreateCollaborationThreadInput
  ): Promise<CollaborationThreadRecord | null>;
  getThread(
    actor: ActorContext,
    input: { threadId: string; includeArchived?: boolean }
  ): Promise<CollaborationThreadRecord | null>;
  listThreads(
    actor: ActorContext,
    input:
      | { scope: "personal"; includeArchived?: boolean; limit?: number }
      | {
          scope: "team";
          teamId: string;
          teamWorkspaceId?: string;
          kinds?: TeamCollaborationThreadKind[];
          includeArchived?: boolean;
          limit?: number;
        }
  ): Promise<CollaborationThreadRecord[] | null>;
  renameThread(
    actor: ActorContext,
    input: { threadId: string; expectedVersion: number; name: string }
  ): Promise<CollaborationThreadRecord | null>;
  updateThreadTopic(
    actor: ActorContext,
    input: {
      threadId: string;
      expectedVersion: number;
      topic: string | null;
    }
  ): Promise<CollaborationThreadRecord | null>;
  archiveThread(
    actor: ActorContext,
    input: { threadId: string; expectedVersion: number }
  ): Promise<CollaborationThreadRecord | null>;
  restoreThread(
    actor: ActorContext,
    input: { threadId: string; expectedVersion: number }
  ): Promise<CollaborationThreadRecord | null>;
  sendMessage(
    actor: ActorContext,
    input: {
      threadId: string;
      idempotencyKey: string;
      bodyText: string;
      metadata?: Record<string, unknown>;
      provenance?: CollaborationMessageProvenance;
    }
  ): Promise<CollaborationMessageRecord | null>;
  listMessages(
    actor: ActorContext,
    input: {
      threadId: string;
      afterSequence?: number;
      beforeSequence?: number;
      limit?: number;
    }
  ): Promise<CollaborationMessagePageRecord | null>;
  advanceReadState(
    actor: ActorContext,
    input: { threadId: string; messageId: string }
  ): Promise<CollaborationReadStateRecord | null>;
  advanceDeliveryState(
    actor: ActorContext,
    input: { threadId: string; messageId: string }
  ): Promise<CollaborationReadStateRecord | null>;
  getAuthorizedSnapshot(
    actor: ActorContext,
    input:
      | { scope: "personal"; includeArchived?: boolean }
      | { scope: "team"; teamId: string; includeArchived?: boolean }
  ): Promise<AuthorizedCollaborationSnapshotRecord | null>;
  replayEvents(
    actor: ActorContext,
    input:
      | { scope: "personal"; afterCursor: number; limit?: number }
      | {
          scope: "team";
          teamId: string;
          afterCursor: number;
          limit?: number;
        }
  ): Promise<CollaborationReplayRecord | null>;
  pruneExpiredReplayHistory(input?: {
    limit?: number;
  }): Promise<CollaborationReplayPruneResult>;
  createSubscription(
    actor: ActorContext,
    input: CreateCollaborationSubscriptionInput
  ): Promise<CollaborationSubscriptionRecord | null>;
  recoverSubscription(
    actor: ActorContext,
    input: RecoverCollaborationSubscriptionInput
  ): Promise<CollaborationSubscriptionRecoveryRecord | null>;
  acknowledgeSubscription(
    actor: ActorContext,
    input: CollaborationSubscriptionBinding & {
      subscriptionId: string;
      eventId: string;
      cursor: number;
    }
  ): Promise<CollaborationSubscriptionRecord | null>;
  revokeSubscriptions(input: RevokeCollaborationSubscriptionsInput): Promise<{
    revokedCount: number;
  }>;
}

export interface CollaborationRealtimeMaterializationRepository {
  isEventAuthorized(
    actor: ActorContext,
    input: {
      eventId: string;
      cursor: number;
      scope: CollaborationScope;
      teamId: string | null;
    }
  ): Promise<boolean>;
  getMessageForRealtime(
    actor: ActorContext,
    input: { threadId: string; messageId: string }
  ): Promise<CollaborationMessageRecord | null>;
  getReceiptStateForRealtime(
    actor: ActorContext,
    input: { threadId: string }
  ): Promise<CollaborationReadStateRecord | null>;
  listMessageReceiptsForRealtime(
    actor: ActorContext,
    input: { threadId: string; throughMessageId: string }
  ): Promise<CollaborationMessageReceiptRecord[] | null>;
  getPersonalMemoryForRealtime(
    actor: ActorContext,
    input: { sessionId: string }
  ): Promise<CapturedSessionSummaryRecord | null>;
}

export class CollaborationIdempotencyConflictError extends Error {
  readonly statusCode = 409;

  constructor(message = "Collaboration idempotency key conflict") {
    super(message);
    this.name = "CollaborationIdempotencyConflictError";
  }
}

export class CollaborationVersionConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("Collaboration thread version conflict");
    this.name = "CollaborationVersionConflictError";
  }
}

export class CollaborationStateConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "CollaborationStateConflictError";
  }
}

type AuthorizedThreadRow = {
  id: string;
  logical_id: string;
  scope: CollaborationScope;
  kind: CollaborationThreadKind;
  personal_owner_user_id: string | null;
  team_id: string | null;
  team_workspace_id: string | null;
  shared_logical_memory_id: string | null;
  share_grant_id: string | null;
  system_key: "workspace.general" | null;
  name_marker: string | null;
  topic_marker: string | null;
  normalized_name_hash: string | null;
  participant_key: string | null;
  created_by_user_id: string | null;
  version: number;
  audience_version: number;
  next_sequence: string | number;
  lifecycle: CollaborationLifecycle;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
  archived_at: Date | null;
  last_read_message_id: string | null;
  last_read_sequence: string | number;
  unread_count: string | number;
};

type MessageRow = {
  id: string;
  thread_id: string;
  thread_sequence: string | number;
  audience_version: number;
  scope: CollaborationScope;
  personal_owner_user_id: string | null;
  team_id: string | null;
  team_workspace_id: string | null;
  sender_kind: "user" | "system" | "imported";
  sender_principal_id: string | null;
  sender_user_id: string | null;
  sender_display_name: string | null;
  recipient_status: "sent" | "delivered" | "read" | null;
  request_hash: string | null;
  created_at: Date;
  updated_at: Date;
};

type OutboxRow = {
  id: string;
  cursor: string | number;
  protocol_version: number;
  family: CollaborationEventFamily;
  scope: CollaborationScope;
  personal_owner_user_id: string | null;
  team_id: string | null;
  team_workspace_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  share_grant_id: string | null;
  logical_memory_id: string | null;
  resource_type: string;
  resource_id: string;
  actor_principal_id: string | null;
  mutation_id: string;
  occurred_at: Date;
};

type SubscriptionRow = {
  id: string;
  backend_identity_hash: string;
  principal_id_hash: string;
  device_credential_id: string | null;
  client_instance_hash: string;
  subscription_key_hash: string;
  protocol_version: number;
  scope: CollaborationScope;
  personal_owner_user_id: string | null;
  team_id: string | null;
  state: CollaborationStreamState;
  snapshot_high_water_cursor: string | number | null;
  acknowledged_event_id: string | null;
  acknowledged_cursor: string | number;
  created_at: Date;
  updated_at: Date;
  last_acknowledged_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
};

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

const boundedLimit = (
  value: number | undefined,
  maximum: number,
  fallback: number
): number =>
  Math.min(
    Math.max(Number.isFinite(value) ? Math.trunc(value!) : fallback, 1),
    maximum
  );

const requireBoundedText = (
  value: string,
  field: string,
  maximum: number
): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum) {
    throw new TypeError(`${field} must contain 1 to ${maximum} characters`);
  }
  return trimmed;
};

const normalizeRequiredText = (value: string, field: string): string => {
  const normalized = value.trim().normalize("NFC");
  if (!normalized) throw new TypeError(`${field} must not be empty`);
  return normalized;
};

const requireBoundedCodePoints = (
  value: string,
  field: string,
  maximum: number
): string => {
  const normalized = normalizeRequiredText(value, field);
  if ([...normalized].length > maximum) {
    throw new TypeError(
      `${field} must contain at most ${maximum} Unicode code points`
    );
  }
  return normalized;
};

const requireBoundedUtf8 = (
  value: string,
  field: string,
  maximum: number
): string => {
  const normalized = normalizeRequiredText(value, field);
  if (Buffer.byteLength(normalized, "utf8") > maximum) {
    throw new TypeError(`${field} must contain at most ${maximum} UTF-8 bytes`);
  }
  return normalized;
};

const requireNonNegativeInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
};

const requirePositiveInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
};

const normalizeName = (value: string): string =>
  value.trim().normalize("NFC").replace(/\s+/g, " ").toLocaleLowerCase("en-US");

const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const hashDomain = (domain: string, value: string): string =>
  hash(`koed:collaboration:${domain}:v1\n${value}`);

const requireSha256Hex = (value: string, field: string): string => {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 hex digest`);
  }
  return value;
};

const uuidFromHash = (value: string): string => {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
    13,
    16
  )}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(
    17,
    20
  )}-${hex.slice(20, 32)}`;
};

const canonicalize = (value: unknown, seen = new Set<object>()): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("JSON numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("JSON values cannot be cyclic");
    seen.add(value);
    const result = value.map((entry) => canonicalize(entry, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("JSON values cannot be cyclic");
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain objects");
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      if (typeof entry === "function" || typeof entry === "symbol") {
        throw new TypeError("JSON values cannot contain functions or symbols");
      }
      result[key] = canonicalize(entry, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError("Value is not JSON-compatible");
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const requestHash = (value: unknown): string =>
  hashDomain("request", canonicalJson(value));

const participantSet = (actorUserId: string, values: string[]): string[] =>
  [...new Set([actorUserId, ...values])].sort();

const participantKey = (teamId: string, userIds: string[]): string =>
  hashDomain("participants", canonicalJson({ teamId, userIds }));

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: string }).code === "23505";

const mapOutboxRow = (row: OutboxRow): CollaborationOutboxEventRecord => ({
  id: row.id,
  cursor: Number(row.cursor),
  protocolVersion: row.protocol_version,
  family: row.family,
  scope: row.scope,
  personalOwnerUserId: row.personal_owner_user_id,
  teamId: row.team_id,
  teamWorkspaceId: row.team_workspace_id,
  threadId: row.thread_id,
  messageId: row.message_id,
  shareGrantId: row.share_grant_id,
  logicalMemoryId: row.logical_memory_id,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  actorPrincipalId: row.actor_principal_id,
  mutationId: row.mutation_id,
  occurredAt: row.occurred_at.toISOString()
});

const mapSubscriptionRow = (
  row: SubscriptionRow
): CollaborationSubscriptionRecord => ({
  id: row.id,
  protocolVersion: row.protocol_version,
  scope: row.scope,
  personalOwnerUserId: row.personal_owner_user_id,
  teamId: row.team_id,
  state: row.state,
  snapshotHighWaterCursor:
    row.snapshot_high_water_cursor === null
      ? null
      : Number(row.snapshot_high_water_cursor),
  acknowledgedEventId: row.acknowledged_event_id,
  acknowledgedCursor: Number(row.acknowledged_cursor),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  lastAcknowledgedAt: iso(row.last_acknowledged_at),
  expiresAt: row.expires_at.toISOString(),
  revokedAt: iso(row.revoked_at)
});

const activeUser = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext
): Promise<boolean> => {
  const result = await client.query<{ allowed: boolean }>(
    `
      select exists (
        select 1
        from users u
        where u.id = $1
          and u.disabled_at is null
          and u.deleted_at is null
      ) as allowed
    `,
    [actor.userId]
  );
  return result.rows[0]?.allowed === true;
};

const activeTeamMember = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  teamId: string
): Promise<boolean> => {
  const result = await client.query<{ allowed: boolean }>(
    `
      select exists (
        select 1
        from teams t
        join team_memberships tm
          on tm.team_id = t.id
         and tm.user_id = $2
         and tm.status = 'enabled'
         and tm.disabled_at is null
        join users u
          on u.id = tm.user_id
         and u.disabled_at is null
         and u.deleted_at is null
        where t.id = $1
          and t.lifecycle = 'active'
          and t.entitlement_status in ('active', 'grace')
      ) as allowed
    `,
    [teamId, actor.userId]
  );
  return result.rows[0]?.allowed === true;
};

const workspaceAccess = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  teamId: string,
  teamWorkspaceId: string,
  required: "read" | "write"
): Promise<boolean> => {
  const result = await client.query<{ allowed: boolean }>(
    `
      select exists (
        select 1
        from teams t
        join team_memberships tm
          on tm.team_id = t.id
         and tm.user_id = $3
         and tm.status = 'enabled'
         and tm.disabled_at is null
        join users u
          on u.id = tm.user_id
         and u.disabled_at is null
         and u.deleted_at is null
        join team_workspaces tw
          on tw.id = $1
         and tw.team_id = t.id
         and tw.lifecycle = 'active'
         and tw.archived_at is null
        join team_workspace_access_grants twag
          on twag.team_workspace_id = tw.id
         and twag.team_id = tw.team_id
         and twag.user_id = $3
         and twag.disabled_at is null
        where t.id = $2
          and t.lifecycle = 'active'
          and t.entitlement_status in ('active', 'grace')
          and twag.access ${required === "write" ? "= 'write'" : "in ('read', 'write')"}
      ) as allowed
    `,
    [teamWorkspaceId, teamId, actor.userId]
  );
  return result.rows[0]?.allowed === true;
};

const activeShareGrant = async (
  client: pg.Pool | pg.PoolClient,
  input: {
    teamId: string;
    teamWorkspaceId: string;
    shareGrantId: string;
    sharedLogicalMemoryId: string;
  }
): Promise<boolean> => {
  const result = await client.query<{ allowed: boolean }>(
    `
      select exists (
        select 1
        from team_session_share_grants sg
        join source_owner_representation_consents consent
          on consent.id = sg.consent_id
         and consent.state = 'active'
         and (consent.expires_at is null or consent.expires_at > now())
        join source_owner_representation_policies owner_policy
          on owner_policy.logical_memory_id = sg.logical_memory_id
         and owner_policy.source_owner_principal_id = sg.owner_principal_id
         and owner_policy.superseded_at is null
         and sg.active_representation = any(owner_policy.allowed_representations)
        join team_representation_policies team_policy
          on team_policy.team_id = sg.team_id
         and team_policy.superseded_at is null
         and sg.active_representation = any(team_policy.allowed_representations)
        join workspace_representation_policies workspace_policy
          on workspace_policy.team_workspace_id = sg.team_workspace_id
         and workspace_policy.team_id = sg.team_id
         and workspace_policy.superseded_at is null
         and sg.active_representation = any(workspace_policy.allowed_representations)
        where sg.id = $1
          and sg.team_id = $2
          and sg.team_workspace_id = $3
          and sg.logical_memory_id = $4
          and sg.lifecycle = 'active'
          and sg.revoked_at is null
          and sg.tombstoned_at is null
          and sg.purge_completed_at is null
          and sg.active_representation is not null
          and sg.active_representation = any(sg.owner_allowed_representations)
      ) as allowed
    `,
    [
      input.shareGrantId,
      input.teamId,
      input.teamWorkspaceId,
      input.sharedLogicalMemoryId
    ]
  );
  return result.rows[0]?.allowed === true;
};

const pendingShareGrant = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  input: {
    teamId: string;
    teamWorkspaceId: string;
    shareGrantId: string;
    sharedLogicalMemoryId: string;
  }
): Promise<boolean> => {
  const result = await client.query<{ allowed: boolean }>(
    `select exists (
       select 1
         from team_session_share_grants g
         join pending_share_operations p on p.grant_id=g.id
        where g.id=$1 and g.team_id=$2 and g.team_workspace_id=$3
          and g.logical_memory_id=$4 and g.owner_user_id=$5
          and g.lifecycle='unavailable' and g.revoked_at is null
          and p.owner_user_id=$5 and p.state in ('preparing','needs_attention')
          and p.stage='activating' and p.workspace_access_state='none'
          and p.revoked_at is null
     ) as allowed`,
    [
      input.shareGrantId,
      input.teamId,
      input.teamWorkspaceId,
      input.sharedLogicalMemoryId,
      actor.userId
    ]
  );
  return result.rows[0]?.allowed === true;
};

const authorizedThreadJoinsSql = `
  join users actor_user
    on actor_user.id = $1
   and actor_user.disabled_at is null
   and actor_user.deleted_at is null
  left join teams team on team.id = ct.team_id
  left join team_memberships actor_membership
    on actor_membership.team_id = ct.team_id
   and actor_membership.user_id = $1
   and actor_membership.status = 'enabled'
   and actor_membership.disabled_at is null
  left join collaboration_participants actor_participant
    on actor_participant.thread_id = ct.id
   and actor_participant.user_id = $1
  left join team_workspaces workspace
    on workspace.id = ct.team_workspace_id
   and workspace.team_id = ct.team_id
  left join team_workspace_access_grants workspace_access
    on workspace_access.team_workspace_id = ct.team_workspace_id
   and workspace_access.team_id = ct.team_id
   and workspace_access.user_id = $1
   and workspace_access.disabled_at is null
  left join team_session_share_grants share_grant
    on share_grant.id = ct.share_grant_id
   and share_grant.team_id = ct.team_id
   and share_grant.team_workspace_id = ct.team_workspace_id
   and share_grant.logical_memory_id = ct.shared_logical_memory_id
  left join source_owner_representation_consents share_consent
    on share_consent.id = share_grant.consent_id
  left join source_owner_representation_policies current_owner_policy
    on current_owner_policy.logical_memory_id = share_grant.logical_memory_id
   and current_owner_policy.source_owner_principal_id = share_grant.owner_principal_id
   and current_owner_policy.superseded_at is null
  left join team_representation_policies current_team_policy
    on current_team_policy.team_id = share_grant.team_id
   and current_team_policy.superseded_at is null
  left join workspace_representation_policies current_workspace_policy
    on current_workspace_policy.team_workspace_id = share_grant.team_workspace_id
   and current_workspace_policy.team_id = share_grant.team_id
   and current_workspace_policy.superseded_at is null
  left join collaboration_receipt_states read_state
    on read_state.thread_id = ct.id
   and read_state.user_id = $1
  left join lateral (
    select count(*)::bigint as unread_count
    from collaboration_messages unread_message
    where unread_message.thread_id = ct.id
      and unread_message.thread_sequence > coalesce(read_state.last_read_sequence, 0)
      and unread_message.sender_principal_id is distinct from $1
  ) unread_state on true
`;

const authorizedThreadPredicate = (required: "read" | "write"): string => `
  (
    (
      ct.scope = 'personal'
      and ct.personal_owner_user_id = $1
      and ct.kind in ('notes_to_self', 'personal_channel')
    )
    or (
      ct.scope = 'team'
      and team.lifecycle = 'active'
      and team.entitlement_status in ('active', 'grace')
      and actor_membership.user_id is not null
      and (
        (
          ct.kind in ('dm', 'group_dm')
          and actor_participant.user_id is not null
        )
        or (
          ct.kind = 'workspace_channel'
          and workspace.lifecycle = 'active'
          and workspace.archived_at is null
          and workspace_access.access ${
            required === "write" ? "= 'write'" : "in ('read', 'write')"
          }
        )
        or (
          ct.kind = 'shared_session_discussion'
          and workspace.lifecycle = 'active'
          and workspace.archived_at is null
          and workspace_access.access ${
            required === "write" ? "= 'write'" : "in ('read', 'write')"
          }
          and share_grant.lifecycle = 'active'
          and share_grant.revoked_at is null
          and share_grant.tombstoned_at is null
          and share_grant.purge_completed_at is null
          and share_grant.active_representation is not null
          and share_grant.active_representation = any(share_grant.owner_allowed_representations)
          and share_consent.state = 'active'
          and (share_consent.expires_at is null or share_consent.expires_at > now())
          and share_grant.active_representation = any(current_owner_policy.allowed_representations)
          and share_grant.active_representation = any(current_team_policy.allowed_representations)
          and share_grant.active_representation = any(current_workspace_policy.allowed_representations)
        )
      )
    )
  )
`;

const selectThreadColumnsSql = `
  ct.id,
  ct.logical_id,
  ct.scope,
  ct.kind,
  ct.personal_owner_user_id,
  ct.team_id,
  ct.team_workspace_id,
  ct.shared_logical_memory_id,
  ct.share_grant_id,
  ct.system_key,
  ct.name_marker,
  ct.topic_marker,
  ct.normalized_name_hash,
  ct.participant_key,
  ct.created_by_user_id,
  ct.version,
  ct.audience_version,
  ct.next_sequence,
  ct.lifecycle,
  ct.created_at,
  ct.updated_at,
  ct.last_activity_at,
  ct.archived_at,
  read_state.last_read_message_id,
  coalesce(read_state.last_read_sequence, 0) as last_read_sequence,
  coalesce(unread_state.unread_count, 0) as unread_count
`;

const getAuthorizedThreadRow = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  threadId: string,
  options: {
    required: "read" | "write";
    includeArchived: boolean;
    forUpdate?: boolean;
    pendingShareActivation?: boolean;
  }
): Promise<AuthorizedThreadRow | null> => {
  const result = await client.query<AuthorizedThreadRow>(
    `
      select ${selectThreadColumnsSql}
      from collaboration_threads ct
      ${authorizedThreadJoinsSql}
      where ct.id = $2
        and ct.lifecycle ${
          options.includeArchived ? "in ('active', 'archived')" : "= 'active'"
        }
        and (
          ${authorizedThreadPredicate(options.required)}
          ${
            options.pendingShareActivation
              ? `or (
                  ct.kind = 'shared_session_discussion'
                  and exists (
                    select 1
                      from team_session_share_grants pending_grant
                      join pending_share_operations pending_share
                        on pending_share.grant_id = pending_grant.id
                     where pending_grant.id = ct.share_grant_id
                       and pending_grant.team_id = ct.team_id
                       and pending_grant.team_workspace_id = ct.team_workspace_id
                       and pending_grant.logical_memory_id = ct.shared_logical_memory_id
                       and pending_grant.owner_user_id = $1
                       and pending_grant.lifecycle = 'unavailable'
                       and pending_grant.revoked_at is null
                       and pending_share.owner_user_id = $1
                       and pending_share.state in ('preparing', 'needs_attention')
                       and pending_share.stage = 'activating'
                       and pending_share.workspace_access_state = 'none'
                       and pending_share.revoked_at is null
                  )
                )`
              : ""
          }
        )
      limit 1
      ${options.forUpdate ? "for update of ct" : ""}
    `,
    [actor.userId, threadId]
  );
  return result.rows[0] ?? null;
};

const currentThreadAudienceMembers = async (
  client: pg.PoolClient,
  thread: AuthorizedThreadRow
): Promise<string[]> => {
  if (thread.scope === "personal") {
    return thread.personal_owner_user_id ? [thread.personal_owner_user_id] : [];
  }
  if (thread.kind === "dm" || thread.kind === "group_dm") {
    const result = await client.query<{ user_id: string }>(
      `
        select participant.user_id
        from collaboration_participants participant
        join team_memberships membership
          on membership.team_id = participant.team_id
         and membership.user_id = participant.user_id
         and membership.status = 'enabled'
         and membership.disabled_at is null
        join users participant_user
          on participant_user.id = participant.user_id
         and participant_user.disabled_at is null
         and participant_user.deleted_at is null
        where participant.thread_id = $1
        order by participant.user_id
      `,
      [thread.id]
    );
    return result.rows.map((row) => row.user_id);
  }
  const result = await client.query<{ user_id: string }>(
    `
      select access.user_id
      from team_workspace_access_grants access
      join team_memberships membership
        on membership.team_id = access.team_id
       and membership.user_id = access.user_id
       and membership.status = 'enabled'
       and membership.disabled_at is null
      join users workspace_user
        on workspace_user.id = access.user_id
       and workspace_user.disabled_at is null
       and workspace_user.deleted_at is null
      where access.team_workspace_id = $1
        and access.team_id = $2
        and access.access in ('read', 'write')
        and access.disabled_at is null
      order by access.user_id
    `,
    [thread.team_workspace_id, thread.team_id]
  );
  return result.rows.map((row) => row.user_id);
};

const ensureCurrentThreadAudience = async (
  client: pg.PoolClient,
  thread: AuthorizedThreadRow
): Promise<number> => {
  const members = await currentThreadAudienceMembers(client, thread);
  if (members.length === 0) {
    throw new CollaborationStateConflictError(
      "Collaboration thread has no authorized audience"
    );
  }
  const memberSetHash = hashDomain("audience-members", canonicalJson(members));
  const current = await client.query<{
    member_set_hash: string;
  }>(
    `
      select member_set_hash
      from collaboration_thread_audiences
      where thread_id = $1 and version = $2
      limit 1
    `,
    [thread.id, thread.audience_version]
  );
  if (current.rows[0]?.member_set_hash === memberSetHash) {
    return thread.audience_version;
  }
  const audienceVersion = current.rows[0]
    ? thread.audience_version + 1
    : thread.audience_version;
  await client.query(
    `
      insert into collaboration_thread_audiences (
        thread_id,
        version,
        member_set_hash
      )
      values ($1, $2, $3)
    `,
    [thread.id, audienceVersion, memberSetHash]
  );
  await client.query(
    `
      insert into collaboration_thread_audience_members (
        thread_id,
        audience_version,
        user_id
      )
      select $1, $2, member.user_id
      from unnest($3::uuid[]) as member(user_id)
    `,
    [thread.id, audienceVersion, members]
  );
  if (audienceVersion !== thread.audience_version) {
    await client.query(
      `
        update collaboration_threads
        set audience_version = $2,
            updated_at = now()
        where id = $1
      `,
      [thread.id, audienceVersion]
    );
    thread.audience_version = audienceVersion;
  }
  return audienceVersion;
};

const participantsForThreads = async (
  client: pg.Pool | pg.PoolClient,
  threadIds: string[]
): Promise<Map<string, CollaborationParticipantRecord[]>> => {
  if (threadIds.length === 0) return new Map();
  const result = await client.query<{
    thread_id: string;
    user_id: string;
    display_name: string | null;
  }>(
    `
      select cp.thread_id, cp.user_id, u.display_name
      from collaboration_participants cp
      join users u on u.id = cp.user_id
      where cp.thread_id = any($1::uuid[])
      order by cp.thread_id, cp.ordinal
    `,
    [threadIds]
  );
  const byThread = new Map<string, CollaborationParticipantRecord[]>();
  for (const row of result.rows) {
    const participants = byThread.get(row.thread_id) ?? [];
    participants.push({
      userId: row.user_id,
      displayName: row.display_name
    });
    byThread.set(row.thread_id, participants);
  }
  return byThread;
};

const decryptThreadField = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  row: AuthorizedThreadRow,
  sourceColumn: "name" | "topic"
): Promise<unknown | null> => {
  if (row.scope === "personal") {
    const result = await decryptAuthorizedEncryptedFieldPayloadWithClient(
      client,
      actor,
      provider,
      {
        sourceTable: "collaboration_threads",
        sourceId: row.id,
        sourceColumn
      }
    );
    return result?.plaintext ?? null;
  }
  return decryptTeamEncryptedFieldAfterAuthorizationWithClient(
    client,
    provider,
    {
      sourceTable: "collaboration_threads",
      sourceId: row.id,
      sourceColumn,
      teamId: row.team_id!,
      teamWorkspaceId: row.team_workspace_id
    }
  );
};

const mapThreadRows = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  rows: AuthorizedThreadRow[]
): Promise<CollaborationThreadRecord[]> => {
  const participants = await participantsForThreads(
    client,
    rows.map((row) => row.id)
  );
  const mapped: CollaborationThreadRecord[] = [];
  for (const row of rows) {
    const name =
      row.name_marker === THREAD_NAME_MARKER
        ? await decryptThreadField(client, actor, provider, row, "name")
        : null;
    const topic =
      row.topic_marker === THREAD_TOPIC_MARKER
        ? await decryptThreadField(client, actor, provider, row, "topic")
        : null;
    if (name !== null && typeof name !== "string") {
      throw new Error("Encrypted collaboration thread name is unavailable");
    }
    if (topic !== null && typeof topic !== "string") {
      throw new Error("Encrypted collaboration thread topic is unavailable");
    }
    const lastReadSequence = Number(row.last_read_sequence);
    mapped.push({
      id: row.id,
      logicalId: row.logical_id,
      scope: row.scope,
      kind: row.kind,
      personalOwnerUserId: row.personal_owner_user_id,
      teamId: row.team_id,
      teamWorkspaceId: row.team_workspace_id,
      sharedLogicalMemoryId: row.shared_logical_memory_id,
      shareGrantId: row.share_grant_id,
      systemKey: row.system_key,
      name,
      topic,
      createdByUserId: row.created_by_user_id,
      version: row.version,
      lifecycle: row.lifecycle,
      latestSequence: Number(row.next_sequence) - 1,
      lastReadMessageId: row.last_read_message_id,
      lastReadSequence,
      unreadCount: Number(row.unread_count),
      participants: participants.get(row.id) ?? [],
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      lastActivityAt: row.last_activity_at.toISOString(),
      archivedAt: iso(row.archived_at)
    } satisfies CollaborationThreadRecord);
  }
  return mapped;
};

const listAuthorizedThreadRows = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  input:
    | {
        scope: "personal";
        includeArchived?: boolean;
        limit?: number;
      }
    | {
        scope: "team";
        teamId: string;
        teamWorkspaceId?: string;
        kinds?: TeamCollaborationThreadKind[];
        includeArchived?: boolean;
        limit?: number;
      },
  maximum = MAX_PAGE_SIZE
): Promise<AuthorizedThreadRow[] | null> => {
  if (input.scope === "personal") {
    if (!(await activeUser(client, actor))) return null;
  } else if (!(await activeTeamMember(client, actor, input.teamId))) {
    return null;
  } else if (
    input.teamWorkspaceId &&
    !(await workspaceAccess(
      client,
      actor,
      input.teamId,
      input.teamWorkspaceId,
      "read"
    ))
  ) {
    return null;
  }
  const limit = boundedLimit(input.limit, maximum, Math.min(100, maximum));
  const result = await client.query<AuthorizedThreadRow>(
    `
      select ${selectThreadColumnsSql}
      from collaboration_threads ct
      ${authorizedThreadJoinsSql}
      where ct.scope = $2::collaboration_scope
        and ($2::collaboration_scope = 'personal' or ct.team_id = $3::uuid)
        and ($4::uuid is null or ct.team_workspace_id = $4::uuid)
        and ($5::text[] is null or ct.kind::text = any($5::text[]))
        and ct.lifecycle ${
          input.includeArchived ? "in ('active', 'archived')" : "= 'active'"
        }
        and ${authorizedThreadPredicate("read")}
      order by ct.last_activity_at desc, ct.id
      limit $6
    `,
    [
      actor.userId,
      input.scope,
      input.scope === "team" ? input.teamId : null,
      input.scope === "team" ? (input.teamWorkspaceId ?? null) : null,
      input.scope === "team" && input.kinds?.length ? input.kinds : null,
      limit
    ]
  );
  return result.rows;
};

const upsertThreadEncryptedField = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  row: AuthorizedThreadRow,
  sourceColumn: "name" | "topic",
  plaintext: string | null
): Promise<void> => {
  await upsertEncryptedFieldPayloadWithClient(client, actor, provider, {
    sourceTable: "collaboration_threads",
    sourceId: row.id,
    sourceColumn,
    plaintext,
    visibility: row.scope === "personal" ? "personal" : "team",
    teamId: row.team_id,
    teamWorkspaceId: row.team_workspace_id,
    scope: {
      teamId: row.team_id,
      workspaceId: row.team_workspace_id,
      objectClass: "collaboration_thread"
    },
    rowFamily: "collaboration_thread",
    aad: {
      threadId: row.id,
      threadKind: row.kind,
      collaborationScope: row.scope
    }
  });
};

export const appendCollaborationOutboxEventWithClient = async (
  client: pg.PoolClient,
  input: {
    family: CollaborationEventFamily;
    scope: CollaborationScope;
    personalOwnerUserId: string | null;
    teamId: string | null;
    teamWorkspaceId: string | null;
    threadId: string | null;
    messageId: string | null;
    shareGrantId: string | null;
    logicalMemoryId: string | null;
    resourceType: string;
    resourceId: string;
    actorPrincipalId: string | null;
    mutationId: string;
  }
): Promise<CollaborationOutboxEventRecord> => {
  const result = await client.query<OutboxRow>(
    `
      insert into collaboration_outbox (
        protocol_version,
        family,
        scope,
        personal_owner_user_id,
        team_id,
        team_workspace_id,
        thread_id,
        message_id,
        share_grant_id,
        logical_memory_id,
        resource_type,
        resource_id,
        actor_principal_id,
        mutation_id,
        replay_until
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14,
        now() + ($15::text || ' days')::interval
      )
      on conflict (mutation_id, family) do update
        set mutation_id = collaboration_outbox.mutation_id
      returning *
    `,
    [
      COLLABORATION_CONTRACT_VERSION,
      input.family,
      input.scope,
      input.personalOwnerUserId,
      input.teamId,
      input.teamWorkspaceId,
      input.threadId,
      input.messageId,
      input.shareGrantId,
      input.logicalMemoryId,
      input.resourceType,
      input.resourceId,
      input.actorPrincipalId,
      input.mutationId,
      OUTBOX_REPLAY_DAYS
    ]
  );
  const event = result.rows[0]!;
  await client.query(
    `
      select pg_notify(
        'koed_collaboration_realtime',
        json_build_object(
          'scope', $1::text,
          'personalOwnerUserId', $2::uuid,
          'teamId', $3::uuid,
          'cursor', $4::bigint,
          'family', $5::text
        )::text
      )
    `,
    [
      event.scope,
      event.personal_owner_user_id,
      event.team_id,
      event.cursor,
      event.family
    ]
  );
  return mapOutboxRow(event);
};

const decryptMessageField = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  row: MessageRow,
  sourceColumn: "body" | "metadata" | "provenance"
): Promise<unknown | null> => {
  if (row.scope === "personal") {
    const result = await decryptAuthorizedEncryptedFieldPayloadWithClient(
      client,
      actor,
      provider,
      {
        sourceTable: "collaboration_messages",
        sourceId: row.id,
        sourceColumn
      }
    );
    return result?.plaintext ?? null;
  }
  return decryptTeamEncryptedFieldAfterAuthorizationWithClient(
    client,
    provider,
    {
      sourceTable: "collaboration_messages",
      sourceId: row.id,
      sourceColumn,
      teamId: row.team_id!,
      teamWorkspaceId: row.team_workspace_id
    }
  );
};

const mapMessageRow = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  row: MessageRow
): Promise<CollaborationMessageRecord> => {
  // A PoolClient must execute these authorization/decrypt queries in order.
  const bodyText = await decryptMessageField(
    client,
    actor,
    provider,
    row,
    "body"
  );
  const metadata = await decryptMessageField(
    client,
    actor,
    provider,
    row,
    "metadata"
  );
  const provenance = await decryptMessageField(
    client,
    actor,
    provider,
    row,
    "provenance"
  );
  if (typeof bodyText !== "string") {
    throw new Error("Encrypted collaboration message body is unavailable");
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new Error("Encrypted collaboration message metadata is unavailable");
  }
  if (
    typeof provenance !== "object" ||
    provenance === null ||
    Array.isArray(provenance) ||
    typeof (provenance as { kind?: unknown }).kind !== "string" ||
    typeof (provenance as { id?: unknown }).id !== "string"
  ) {
    throw new Error(
      "Encrypted collaboration message provenance is unavailable"
    );
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    threadSequence: Number(row.thread_sequence),
    audienceVersion: row.audience_version,
    scope: row.scope,
    personalOwnerUserId: row.personal_owner_user_id,
    teamId: row.team_id,
    teamWorkspaceId: row.team_workspace_id,
    senderKind: row.sender_kind,
    senderPrincipalId: row.sender_principal_id,
    senderUserId: row.sender_user_id,
    senderDisplayName: row.sender_display_name,
    recipientStatus: row.recipient_status,
    bodyText,
    metadata: metadata as Record<string, unknown>,
    provenance: provenance as CollaborationMessageProvenance,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
};

const selectMessageColumnsSql = `
  cm.id,
  cm.thread_id,
  cm.thread_sequence,
  cm.audience_version,
  cm.scope,
  cm.personal_owner_user_id,
  cm.team_id,
  cm.team_workspace_id,
  cm.sender_kind,
  cm.sender_principal_id,
  cm.sender_user_id,
  sender.display_name as sender_display_name,
  null::text as recipient_status,
  cm.request_hash,
  cm.created_at,
  cm.updated_at
`;

const attachRecipientStatuses = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  rows: MessageRow[]
): Promise<void> => {
  const outgoingIds = rows
    .filter((row) => row.sender_principal_id === actor.userId)
    .map((row) => row.id);
  if (outgoingIds.length === 0) return;
  const result = await client.query<{
    message_id: string;
    recipient_count: string | number;
    delivered_to_all: boolean;
    read_by_all: boolean;
  }>(
    `
      select
        cm.id as message_id,
        count(member.user_id)::bigint as recipient_count,
        coalesce(
          bool_and(
            coalesce(receipt.last_delivered_sequence, 0) >= cm.thread_sequence
          ),
          false
        ) as delivered_to_all,
        coalesce(
          bool_and(
            coalesce(receipt.last_read_sequence, 0) >= cm.thread_sequence
          ),
          false
        ) as read_by_all
      from collaboration_messages cm
      join collaboration_thread_audience_members member
        on member.thread_id = cm.thread_id
       and member.audience_version = cm.audience_version
       and member.user_id <> cm.sender_principal_id
      left join collaboration_receipt_states receipt
        on receipt.thread_id = cm.thread_id
       and receipt.user_id = member.user_id
      where cm.id = any($1::uuid[])
        and cm.sender_principal_id = $2
      group by cm.id, cm.thread_sequence
    `,
    [outgoingIds, actor.userId]
  );
  const statuses = new Map(
    result.rows.map((row) => [
      row.message_id,
      Number(row.recipient_count) === 0
        ? null
        : row.read_by_all
          ? ("read" as const)
          : row.delivered_to_all
            ? ("delivered" as const)
            : ("sent" as const)
    ])
  );
  for (const row of rows) {
    if (row.sender_principal_id === actor.userId) {
      row.recipient_status = statuses.get(row.id) ?? null;
    }
  }
};

const authorizedEventExists = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  input: {
    eventId: string;
    cursor: number;
    scope: CollaborationScope;
    teamId: string | null;
  }
): Promise<boolean> => {
  const result = await client.query<{ allowed: boolean }>(
    `
      select exists (
        select 1
        from collaboration_outbox event
        where event.id = $2
          and event.cursor = $3
          and event.scope = $4::collaboration_scope
          and event.invalidated_at is null
          and event.available_at <= now()
          and event.replay_until > now()
          and (
            (
              event.scope = 'personal'
              and event.personal_owner_user_id = $1
              and exists (
                select 1 from users u
                where u.id = $1
                  and u.disabled_at is null
                  and u.deleted_at is null
              )
            )
            or (
              event.scope = 'team'
              and event.team_id = $5::uuid
              and exists (
                select 1
                from teams t
                join team_memberships tm
                  on tm.team_id = t.id
                 and tm.user_id = $1
                 and tm.status = 'enabled'
                 and tm.disabled_at is null
                join users u
                  on u.id = tm.user_id
                 and u.disabled_at is null
                 and u.deleted_at is null
                where t.id = event.team_id
                  and t.lifecycle = 'active'
                  and t.entitlement_status in ('active', 'grace')
              )
              and (
                event.family in (
                  'team_lifecycle',
                  'team_membership_access',
                  'workspace_lifecycle_access'
                )
                or
                (
                  event.thread_id is not null
                  and exists (
                    select 1
                    from collaboration_threads ct
                    ${authorizedThreadJoinsSql}
                    where ct.id = event.thread_id
                      and ct.lifecycle in ('active', 'archived')
                      and ${authorizedThreadPredicate("read")}
                  )
                )
                or (
                  event.thread_id is null
                  and (
                    event.team_workspace_id is null
                    or exists (
                      select 1
                      from team_workspaces tw
                      join team_workspace_access_grants twag
                        on twag.team_workspace_id = tw.id
                       and twag.team_id = tw.team_id
                       and twag.user_id = $1
                       and twag.disabled_at is null
                       and twag.access in ('read', 'write')
                      where tw.id = event.team_workspace_id
                        and tw.team_id = event.team_id
                        and tw.lifecycle = 'active'
                        and tw.archived_at is null
                    )
                  )
                )
              )
            )
          )
      ) as allowed
    `,
    [actor.userId, input.eventId, input.cursor, input.scope, input.teamId]
  );
  return result.rows[0]?.allowed === true;
};

const normalizeSubscriptionBinding = (
  actor: ActorContext,
  input: CollaborationSubscriptionBinding
): CollaborationSubscriptionBinding => {
  const protocolVersion = requirePositiveInteger(
    input.protocolVersion,
    "protocolVersion"
  );
  if (protocolVersion !== COLLABORATION_CONTRACT_VERSION) {
    throw new TypeError("protocolVersion is unsupported");
  }
  const principalIdHash = requireSha256Hex(
    input.principalIdHash,
    "principalIdHash"
  );
  const expectedPrincipalIdHash = hashDomain(
    "subscription-principal",
    actor.userId
  );
  if (principalIdHash !== expectedPrincipalIdHash) {
    throw new TypeError("principalIdHash does not match the actor");
  }
  return {
    backendIdentityHash: requireSha256Hex(
      input.backendIdentityHash,
      "backendIdentityHash"
    ),
    principalIdHash,
    deviceCredentialId: input.deviceCredentialId,
    clientInstanceHash: requireSha256Hex(
      input.clientInstanceHash,
      "clientInstanceHash"
    ),
    subscriptionKeyHash: requireSha256Hex(
      input.subscriptionKeyHash,
      "subscriptionKeyHash"
    ),
    protocolVersion
  };
};

const subscriptionScopeMatches = (
  row: SubscriptionRow,
  input:
    | { scope: "personal" }
    | {
        scope: "team";
        teamId: string;
      },
  actor: ActorContext
): boolean =>
  input.scope === "personal"
    ? row.scope === "personal" &&
      row.personal_owner_user_id === actor.userId &&
      row.team_id === null
    : row.scope === "team" && row.team_id === input.teamId;

const createOrUpdateCollaborationSubscriptionWithClient = async (
  client: pg.PoolClient,
  actor: ActorContext,
  input: CreateCollaborationSubscriptionInput
): Promise<CollaborationSubscriptionRecord | null> => {
  const binding = normalizeSubscriptionBinding(actor, input);
  const snapshotHighWaterCursor = requireNonNegativeInteger(
    input.snapshotHighWaterCursor,
    "snapshotHighWaterCursor"
  );
  if (input.scope === "personal") {
    if (!(await activeUser(client, actor))) return null;
  } else if (!(await activeTeamMember(client, actor, input.teamId))) {
    return null;
  }

  const selected = await client.query<SubscriptionRow>(
    `
      select *
      from collaboration_stream_subscriptions
      where backend_identity_hash = $1
        and principal_id_hash = $2
        and client_instance_hash = $3
        and subscription_key_hash = $4
        and protocol_version = $5
      for update
    `,
    [
      binding.backendIdentityHash,
      binding.principalIdHash,
      binding.clientInstanceHash,
      binding.subscriptionKeyHash,
      binding.protocolVersion
    ]
  );
  const current = selected.rows[0];
  if (current) {
    if (!subscriptionScopeMatches(current, input, actor)) return null;
    const updated = await client.query<SubscriptionRow>(
      `
        update collaboration_stream_subscriptions
        set device_credential_id = $2,
            state = 'active',
            snapshot_high_water_cursor = greatest(
              coalesce(snapshot_high_water_cursor, 0),
              $3
            ),
            expires_at = $4,
            revoked_at = null,
            updated_at = now()
        where id = $1
        returning *
      `,
      [
        current.id,
        binding.deviceCredentialId,
        snapshotHighWaterCursor,
        input.expiresAt
      ]
    );
    return mapSubscriptionRow(updated.rows[0]!);
  }

  const inserted = await client.query<SubscriptionRow>(
    `
      insert into collaboration_stream_subscriptions (
        backend_identity_hash,
        principal_id_hash,
        device_credential_id,
        client_instance_hash,
        subscription_key_hash,
        protocol_version,
        scope,
        personal_owner_user_id,
        team_id,
        state,
        snapshot_high_water_cursor,
        expires_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11)
      returning *
    `,
    [
      binding.backendIdentityHash,
      binding.principalIdHash,
      binding.deviceCredentialId,
      binding.clientInstanceHash,
      binding.subscriptionKeyHash,
      binding.protocolVersion,
      input.scope,
      input.scope === "personal" ? actor.userId : null,
      input.scope === "team" ? input.teamId : null,
      snapshotHighWaterCursor,
      input.expiresAt
    ]
  );
  return mapSubscriptionRow(inserted.rows[0]!);
};

const retainedReplayGapExists = async (
  client: pg.PoolClient,
  actor: ActorContext,
  input:
    | { scope: "personal"; afterCursor: number }
    | { scope: "team"; teamId: string; afterCursor: number }
): Promise<boolean> => {
  const result = await client.query<{ gap_exists: boolean }>(
    `
      select (
        exists (
          select 1
          from collaboration_outbox event
          where event.scope = $1::collaboration_scope
            and (
              ($1::collaboration_scope = 'personal' and event.personal_owner_user_id = $4)
              or ($1::collaboration_scope = 'team' and event.team_id = $2::uuid)
            )
            and event.cursor > $3
            and (
              event.replay_until <= now()
              or event.invalidated_at is not null
            )
        )
        or exists (
          select 1
          from collaboration_replay_watermarks watermark
          where watermark.scope = $1::collaboration_scope
            and (
              ($1::collaboration_scope = 'personal' and watermark.personal_owner_user_id = $4)
              or ($1::collaboration_scope = 'team' and watermark.team_id = $2::uuid)
            )
            and watermark.replay_low_water_cursor > $3
        )
      ) as gap_exists
    `,
    [
      input.scope,
      input.scope === "team" ? input.teamId : null,
      input.afterCursor,
      actor.userId
    ]
  );
  return result.rows[0]?.gap_exists === true;
};

const pruneExpiredReplayHistoryWithClient = async (
  client: pg.PoolClient,
  limitInput?: number
): Promise<CollaborationReplayPruneResult> => {
  const limit = boundedLimit(limitInput, 10_000, 1_000);
  const result = await client.query<{
    deleted_event_count: string | number;
    deleted_subscription_count: string | number;
  }>(
    `
      with expired_subscriptions as (
        delete from collaboration_stream_subscriptions
        where expires_at <= now()
        returning id
      ),
      candidates as materialized (
        select event.id,
               event.cursor,
               event.scope,
               event.personal_owner_user_id,
               event.team_id
        from collaboration_outbox event
        where (
            event.replay_until <= now()
            or event.invalidated_at is not null
          )
          and not exists (
            select 1
            from collaboration_stream_subscriptions subscription
            where subscription.acknowledged_event_id = event.id
          )
        order by event.cursor
        limit $1
        for update of event skip locked
      ),
      personal_watermark_values as (
        select candidate.personal_owner_user_id,
               max(candidate.cursor) as replay_low_water_cursor,
               (
                 select max(event.cursor)
                 from collaboration_outbox event
                 where event.scope = 'personal'
                   and event.personal_owner_user_id = candidate.personal_owner_user_id
               ) as high_water_cursor
        from candidates candidate
        where candidate.scope = 'personal'
        group by candidate.personal_owner_user_id
      ),
      personal_watermarks as (
        insert into collaboration_replay_watermarks (
          scope,
          personal_owner_user_id,
          replay_low_water_cursor,
          high_water_cursor
        )
        select 'personal'::collaboration_scope,
               personal_owner_user_id,
               replay_low_water_cursor,
               high_water_cursor
        from personal_watermark_values
        on conflict (personal_owner_user_id) where scope = 'personal'
        do update set
          replay_low_water_cursor = greatest(
            collaboration_replay_watermarks.replay_low_water_cursor,
            excluded.replay_low_water_cursor
          ),
          high_water_cursor = greatest(
            collaboration_replay_watermarks.high_water_cursor,
            excluded.high_water_cursor
          ),
          updated_at = now()
        returning id
      ),
      team_watermark_values as (
        select candidate.team_id,
               max(candidate.cursor) as replay_low_water_cursor,
               (
                 select max(event.cursor)
                 from collaboration_outbox event
                 where event.scope = 'team'
                   and event.team_id = candidate.team_id
               ) as high_water_cursor
        from candidates candidate
        where candidate.scope = 'team'
        group by candidate.team_id
      ),
      team_watermarks as (
        insert into collaboration_replay_watermarks (
          scope,
          team_id,
          replay_low_water_cursor,
          high_water_cursor
        )
        select 'team'::collaboration_scope,
               team_id,
               replay_low_water_cursor,
               high_water_cursor
        from team_watermark_values
        on conflict (team_id) where scope = 'team'
        do update set
          replay_low_water_cursor = greatest(
            collaboration_replay_watermarks.replay_low_water_cursor,
            excluded.replay_low_water_cursor
          ),
          high_water_cursor = greatest(
            collaboration_replay_watermarks.high_water_cursor,
            excluded.high_water_cursor
          ),
          updated_at = now()
        returning id
      ),
      deleted_events as (
        delete from collaboration_outbox event
        using candidates
        where event.id = candidates.id
          and (
            (select count(*) from personal_watermarks) >= 0
            and (select count(*) from team_watermarks) >= 0
          )
        returning event.id
      )
      select
        (select count(*) from deleted_events)::bigint as deleted_event_count,
        (select count(*) from expired_subscriptions)::bigint as deleted_subscription_count
    `,
    [limit]
  );
  return {
    deletedEventCount: Number(result.rows[0]?.deleted_event_count ?? 0),
    deletedSubscriptionCount: Number(
      result.rows[0]?.deleted_subscription_count ?? 0
    )
  };
};

const recoverCollaborationSubscriptionWithClient = async (
  client: pg.PoolClient,
  actor: ActorContext,
  input: RecoverCollaborationSubscriptionInput
): Promise<CollaborationSubscriptionRecoveryRecord | null> => {
  const afterCursor = requireNonNegativeInteger(
    input.afterCursor,
    "afterCursor"
  );
  const subscription = await createOrUpdateCollaborationSubscriptionWithClient(
    client,
    actor,
    {
      ...input,
      snapshotHighWaterCursor: afterCursor
    }
  );
  if (!subscription || subscription.id !== input.subscriptionId) return null;
  const requiresSnapshot = await retainedReplayGapExists(client, actor, input);
  if (!requiresSnapshot) return { subscription, requiresSnapshot: false };
  const updated = await client.query<SubscriptionRow>(
    `
      update collaboration_stream_subscriptions
      set state = 'requires_snapshot',
          updated_at = now()
      where id = $1
      returning *
    `,
    [subscription.id]
  );
  return {
    subscription: mapSubscriptionRow(updated.rows[0]!),
    requiresSnapshot: true
  };
};

const revokeCollaborationSubscriptionsWithClient = async (
  client: pg.PoolClient,
  input: RevokeCollaborationSubscriptionsInput
): Promise<{ revokedCount: number }> => {
  const backendIdentityHash = requireSha256Hex(
    input.backendIdentityHash,
    "backendIdentityHash"
  );
  const principalIdHash =
    "principalIdHash" in input && input.principalIdHash
      ? requireSha256Hex(input.principalIdHash, "principalIdHash")
      : null;
  const updated = await client.query<{ id: string }>(
    `
      update collaboration_stream_subscriptions
      set state = 'revoked',
          revoked_at = coalesce(revoked_at, now()),
          updated_at = now()
      where backend_identity_hash = $1
        and state in ('active', 'requires_snapshot')
        and revoked_at is null
        and scope = $2::collaboration_scope
        and ($3::uuid is null or team_id = $3::uuid)
        and ($4::text is null or principal_id_hash = $4)
      returning id
    `,
    [
      backendIdentityHash,
      input.scope,
      input.scope === "team" ? input.teamId : null,
      principalIdHash
    ]
  );
  if (updated.rowCount) {
    await client.query(
      `
        select pg_notify(
          'koed_collaboration_realtime',
          json_build_object(
            'control', $1::text,
            'scope', $2::text,
            'teamId', $3::uuid,
            'principalIdHash', $4::text
          )::text
        )
      `,
      [
        input.reason,
        input.scope,
        input.scope === "team" ? input.teamId : null,
        principalIdHash
      ]
    );
  }
  return { revokedCount: updated.rowCount ?? 0 };
};

export const acknowledgeCollaborationSubscriptionWithClient = async (
  client: pg.PoolClient,
  actor: ActorContext,
  input: CollaborationSubscriptionBinding & {
    subscriptionId: string;
    eventId: string;
    cursor: number;
  }
): Promise<CollaborationSubscriptionRecord | null> => {
  const cursor = requirePositiveInteger(input.cursor, "cursor");
  const binding = normalizeSubscriptionBinding(actor, input);
  const selected = await client.query<SubscriptionRow>(
    `
      select *
      from collaboration_stream_subscriptions
      where id = $1
        and backend_identity_hash = $2
        and principal_id_hash = $3
        and client_instance_hash = $4
        and subscription_key_hash = $5
        and protocol_version = $6
        and device_credential_id is not distinct from $7::uuid
        and state = 'active'
        and revoked_at is null
        and expires_at > now()
        and (
          (scope = 'personal' and personal_owner_user_id = $8)
          or (
            scope = 'team'
            and exists (
              select 1
              from teams t
              join team_memberships tm
                on tm.team_id = t.id
               and tm.user_id = $8
               and tm.status = 'enabled'
               and tm.disabled_at is null
              join users u
                on u.id = tm.user_id
               and u.disabled_at is null
               and u.deleted_at is null
              where t.id = collaboration_stream_subscriptions.team_id
                and t.lifecycle = 'active'
                and t.entitlement_status in ('active', 'grace')
            )
          )
        )
      for update
    `,
    [
      input.subscriptionId,
      binding.backendIdentityHash,
      binding.principalIdHash,
      binding.clientInstanceHash,
      binding.subscriptionKeyHash,
      binding.protocolVersion,
      binding.deviceCredentialId,
      actor.userId
    ]
  );
  const current = selected.rows[0];
  if (!current) return null;
  const acknowledgedCursor = Number(current.acknowledged_cursor);
  if (cursor < acknowledgedCursor) return mapSubscriptionRow(current);
  if (cursor === acknowledgedCursor) {
    if (current.acknowledged_event_id !== input.eventId) {
      throw new CollaborationStateConflictError(
        "Acknowledgement event does not match the stored cursor"
      );
    }
    return mapSubscriptionRow(current);
  }
  if (
    !(await authorizedEventExists(client, actor, {
      eventId: input.eventId,
      cursor,
      scope: current.scope,
      teamId: current.team_id
    }))
  ) {
    throw new CollaborationStateConflictError(
      "Acknowledgement event is unavailable or unauthorized"
    );
  }
  const updated = await client.query<SubscriptionRow>(
    `
      update collaboration_stream_subscriptions
      set acknowledged_event_id = $2,
          acknowledged_cursor = $3,
          snapshot_high_water_cursor = greatest(
            coalesce(snapshot_high_water_cursor, 0),
            $3
          ),
          last_acknowledged_at = now(),
          updated_at = now()
      where id = $1
        and acknowledged_cursor < $3
      returning *
    `,
    [input.subscriptionId, input.eventId, cursor]
  );
  return mapSubscriptionRow(updated.rows[0] ?? current);
};

const withTransaction = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

type PreparedThreadCreation = {
  id: string;
  logicalId: string;
  requestHash: string;
  mutationId: string;
  scope: CollaborationScope;
  kind: CollaborationThreadKind;
  personalOwnerUserId: string | null;
  teamId: string | null;
  teamWorkspaceId: string | null;
  sharedLogicalMemoryId: string | null;
  shareGrantId: string | null;
  name: string | null;
  topic: string | null;
  normalizedNameHash: string | null;
  participantKey: string | null;
  participantUserIds: string[];
  pendingShareActivation: boolean;
};

const prepareThreadCreation = async (
  client: pg.PoolClient,
  actor: ActorContext,
  input: CreateCollaborationThreadInput
): Promise<PreparedThreadCreation | null> => {
  const idempotencyKey = requireBoundedText(
    input.idempotencyKey,
    "idempotencyKey",
    MAX_IDEMPOTENCY_KEY_LENGTH
  );
  let scope: CollaborationScope;
  let personalOwnerUserId: string | null = null;
  let teamId: string | null = null;
  let teamWorkspaceId: string | null = null;
  let sharedLogicalMemoryId: string | null = null;
  let shareGrantId: string | null = null;
  let name: string | null = null;
  let topic: string | null = null;
  let normalizedNameHash: string | null = null;
  let participants: string[] = [];
  let participantSetKey: string | null = null;

  if (input.kind === "notes_to_self" || input.kind === "personal_channel") {
    if (!(await activeUser(client, actor))) return null;
    scope = "personal";
    personalOwnerUserId = actor.userId;
    if (input.kind === "notes_to_self") {
      participants = [actor.userId];
    } else {
      name = requireBoundedCodePoints(
        input.name,
        "name",
        MAX_THREAD_NAME_CODE_POINTS
      );
      normalizedNameHash = hashDomain("thread-name", normalizeName(name));
      topic =
        input.topic === undefined || input.topic === null
          ? null
          : requireBoundedUtf8(input.topic, "topic", MAX_THREAD_TOPIC_BYTES);
    }
  } else {
    scope = "team";
    teamId = input.teamId;
    if ("participantUserIds" in input) {
      if (!(await activeTeamMember(client, actor, input.teamId))) return null;
      participants = participantSet(actor.userId, input.participantUserIds);
      const expectedCount = input.kind === "dm" ? 2 : participants.length;
      if (
        participants.length !== expectedCount ||
        (input.kind === "group_dm" && participants.length < 3) ||
        participants.length > MAX_DM_PARTICIPANTS
      ) {
        throw new TypeError(
          input.kind === "dm"
            ? "A direct message requires exactly two distinct participants"
            : `A group direct message requires 3 to ${MAX_DM_PARTICIPANTS} distinct participants`
        );
      }
      const enabled = await client.query<{ count: string }>(
        `
          select count(*)::text as count
          from team_memberships tm
          join users u
            on u.id = tm.user_id
           and u.disabled_at is null
           and u.deleted_at is null
          where tm.team_id = $1
            and tm.user_id = any($2::uuid[])
            and tm.status = 'enabled'
            and tm.disabled_at is null
        `,
        [input.teamId, participants]
      );
      if (Number(enabled.rows[0]?.count ?? 0) !== participants.length) {
        return null;
      }
      participantSetKey = participantKey(input.teamId, participants);
    } else {
      teamWorkspaceId = input.teamWorkspaceId;
      if (
        !(await workspaceAccess(
          client,
          actor,
          input.teamId,
          input.teamWorkspaceId,
          input.kind === "shared_session_discussion" ? "read" : "write"
        ))
      ) {
        return null;
      }
      if (input.kind === "workspace_channel") {
        name = requireBoundedCodePoints(
          input.name,
          "name",
          MAX_THREAD_NAME_CODE_POINTS
        );
        normalizedNameHash = hashDomain("thread-name", normalizeName(name));
        topic =
          input.topic === undefined || input.topic === null
            ? null
            : requireBoundedUtf8(input.topic, "topic", MAX_THREAD_TOPIC_BYTES);
      } else {
        sharedLogicalMemoryId = input.sharedLogicalMemoryId;
        shareGrantId = input.shareGrantId;
        const shareScope = {
          teamId: input.teamId,
          teamWorkspaceId: input.teamWorkspaceId,
          shareGrantId: input.shareGrantId,
          sharedLogicalMemoryId: input.sharedLogicalMemoryId
        };
        const grantAuthorized =
          (await activeShareGrant(client, shareScope)) ||
          (input.pendingShareActivation === true &&
            (await pendingShareGrant(client, actor, shareScope)));
        if (!grantAuthorized) {
          return null;
        }
      }
    }
  }

  const semanticRequest = {
    scope,
    kind: input.kind,
    personalOwnerUserId,
    teamId,
    teamWorkspaceId,
    sharedLogicalMemoryId,
    shareGrantId,
    normalizedName: name === null ? null : normalizeName(name),
    topic,
    participants
  };
  const creationRequestHash = requestHash(semanticRequest);
  const idempotencyKeyHash = hashDomain("thread-idempotency", idempotencyKey);
  const authorityBoundary = canonicalJson({
    actorUserId: actor.userId,
    scope,
    personalOwnerUserId,
    teamId
  });
  const id = uuidFromHash(
    `koed:collaboration:thread-id:v1\n${authorityBoundary}\n${idempotencyKeyHash}`
  );
  const logicalId = uuidFromHash(
    `koed:collaboration:thread-request:v1\n${id}\n${creationRequestHash}`
  );
  return {
    id,
    logicalId,
    requestHash: creationRequestHash,
    mutationId: uuidFromHash(
      `koed:collaboration:thread-create:v1\n${id}\n${creationRequestHash}`
    ),
    scope,
    kind: input.kind,
    personalOwnerUserId,
    teamId,
    teamWorkspaceId,
    sharedLogicalMemoryId,
    shareGrantId,
    name,
    topic,
    normalizedNameHash,
    participantKey: participantSetKey,
    participantUserIds: participants,
    pendingShareActivation:
      input.kind === "shared_session_discussion" &&
      input.pendingShareActivation === true
  };
};

const findNaturalThreadId = async (
  client: pg.PoolClient,
  input: PreparedThreadCreation
): Promise<string | null> => {
  let result: pg.QueryResult<{ id: string }>;
  if (input.kind === "notes_to_self") {
    result = await client.query(
      `select id from collaboration_threads where kind = 'notes_to_self' and personal_owner_user_id = $1 limit 1`,
      [input.personalOwnerUserId]
    );
  } else if (input.kind === "personal_channel") {
    result = await client.query(
      `select id from collaboration_threads where kind = 'personal_channel' and personal_owner_user_id = $1 and normalized_name_hash = $2 and lifecycle = 'active' limit 1`,
      [input.personalOwnerUserId, input.normalizedNameHash]
    );
  } else if (input.kind === "workspace_channel") {
    result = await client.query(
      `select id from collaboration_threads where kind = 'workspace_channel' and team_workspace_id = $1 and normalized_name_hash = $2 and lifecycle = 'active' limit 1`,
      [input.teamWorkspaceId, input.normalizedNameHash]
    );
  } else if (input.kind === "dm" || input.kind === "group_dm") {
    result = await client.query(
      `select id from collaboration_threads where team_id = $1 and kind in ('dm', 'group_dm') and participant_key = $2 limit 1`,
      [input.teamId, input.participantKey]
    );
  } else {
    result = await client.query(
      `select id from collaboration_threads where kind = 'shared_session_discussion' and team_workspace_id = $1 and shared_logical_memory_id = $2 limit 1`,
      [input.teamWorkspaceId, input.sharedLogicalMemoryId]
    );
  }
  return result.rows[0]?.id ?? null;
};

const existingCreationMatches = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  row: AuthorizedThreadRow,
  input: PreparedThreadCreation
): Promise<boolean> => {
  if (
    row.scope !== input.scope ||
    row.kind !== input.kind ||
    row.personal_owner_user_id !== input.personalOwnerUserId ||
    row.team_id !== input.teamId ||
    row.team_workspace_id !== input.teamWorkspaceId ||
    row.shared_logical_memory_id !== input.sharedLogicalMemoryId ||
    row.share_grant_id !== input.shareGrantId ||
    row.normalized_name_hash !== input.normalizedNameHash ||
    row.participant_key !== input.participantKey
  ) {
    return false;
  }
  if (input.name !== null) {
    const storedName = await decryptThreadField(
      client,
      actor,
      provider,
      row,
      "name"
    );
    if (
      typeof storedName !== "string" ||
      normalizeName(storedName) !== normalizeName(input.name)
    ) {
      return false;
    }
  }
  if (input.topic !== null || row.topic_marker !== null) {
    const storedTopic =
      row.topic_marker === THREAD_TOPIC_MARKER
        ? await decryptThreadField(client, actor, provider, row, "topic")
        : null;
    if (storedTopic !== input.topic) return false;
  }
  return true;
};

const insertThread = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  prepared: PreparedThreadCreation
): Promise<CollaborationThreadRecord | null> => {
  const inserted = await client.query<{ id: string }>(
    `
      insert into collaboration_threads (
        id,
        logical_id,
        scope,
        kind,
        personal_owner_user_id,
        team_id,
        team_workspace_id,
        shared_logical_memory_id,
        share_grant_id,
        name_marker,
        topic_marker,
        normalized_name_hash,
        participant_key,
        created_by_user_id
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14
      )
      on conflict do nothing
      returning id
    `,
    [
      prepared.id,
      prepared.logicalId,
      prepared.scope,
      prepared.kind,
      prepared.personalOwnerUserId,
      prepared.teamId,
      prepared.teamWorkspaceId,
      prepared.sharedLogicalMemoryId,
      prepared.shareGrantId,
      prepared.name === null ? null : THREAD_NAME_MARKER,
      prepared.topic === null ? null : THREAD_TOPIC_MARKER,
      prepared.normalizedNameHash,
      prepared.participantKey,
      actor.userId
    ]
  );

  if (inserted.rowCount === 0) {
    const byId = await client.query<{ logical_id: string }>(
      `select logical_id from collaboration_threads where id = $1`,
      [prepared.id]
    );
    if (byId.rows[0] && byId.rows[0].logical_id !== prepared.logicalId) {
      throw new CollaborationIdempotencyConflictError();
    }
    const existingId = byId.rows[0]
      ? prepared.id
      : await findNaturalThreadId(client, prepared);
    if (!existingId) {
      throw new CollaborationStateConflictError(
        "Collaboration thread uniqueness conflict"
      );
    }
    const existing = await getAuthorizedThreadRow(client, actor, existingId, {
      required:
        prepared.kind === "shared_session_discussion" ? "read" : "write",
      includeArchived: true,
      forUpdate: true,
      pendingShareActivation: prepared.pendingShareActivation
    });
    if (!existing) return null;
    if (
      !(await existingCreationMatches(
        client,
        actor,
        provider,
        existing,
        prepared
      ))
    ) {
      throw new CollaborationIdempotencyConflictError(
        "Collaboration thread request conflicts with an existing thread"
      );
    }
    return (await mapThreadRows(client, actor, provider, [existing]))[0]!;
  }

  if (prepared.participantUserIds.length > 0) {
    await client.query(
      `
        insert into collaboration_participants (
          thread_id,
          scope,
          thread_kind,
          personal_owner_user_id,
          team_id,
          user_id,
          ordinal
        )
        select $1, $2, $3, $4, $5, participant.user_id, participant.ordinal - 1
        from unnest($6::uuid[]) with ordinality as participant(user_id, ordinal)
      `,
      [
        prepared.id,
        prepared.scope,
        prepared.kind,
        prepared.personalOwnerUserId,
        prepared.teamId,
        prepared.participantUserIds
      ]
    );
  }
  const row = await getAuthorizedThreadRow(client, actor, prepared.id, {
    required: prepared.kind === "shared_session_discussion" ? "read" : "write",
    includeArchived: false,
    forUpdate: true,
    pendingShareActivation: prepared.pendingShareActivation
  });
  if (!row) throw new Error("Inserted collaboration thread is unauthorized");
  if (prepared.name !== null) {
    await upsertThreadEncryptedField(
      client,
      actor,
      provider,
      row,
      "name",
      prepared.name
    );
  }
  if (prepared.topic !== null) {
    await upsertThreadEncryptedField(
      client,
      actor,
      provider,
      row,
      "topic",
      prepared.topic
    );
  }
  await appendCollaborationOutboxEventWithClient(client, {
    family: "thread_lifecycle",
    scope: row.scope,
    personalOwnerUserId: row.personal_owner_user_id,
    teamId: row.team_id,
    teamWorkspaceId: row.team_workspace_id,
    threadId: row.id,
    messageId: null,
    shareGrantId: row.share_grant_id,
    logicalMemoryId: row.shared_logical_memory_id,
    resourceType: "collaboration_thread",
    resourceId: row.id,
    actorPrincipalId: actor.userId,
    mutationId: prepared.mutationId
  });
  return (await mapThreadRows(client, actor, provider, [row]))[0]!;
};

const updateThreadName = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  input: { threadId: string; expectedVersion: number; name: string }
): Promise<CollaborationThreadRecord | null> => {
  const expectedVersion = requirePositiveInteger(
    input.expectedVersion,
    "expectedVersion"
  );
  const name = requireBoundedCodePoints(
    input.name,
    "name",
    MAX_THREAD_NAME_CODE_POINTS
  );
  const row = await getAuthorizedThreadRow(client, actor, input.threadId, {
    required: "write",
    includeArchived: false,
    forUpdate: true
  });
  if (!row) return null;
  if (row.kind !== "personal_channel" && row.kind !== "workspace_channel") {
    throw new CollaborationStateConflictError(
      "Only Personal and Workspace channels have mutable names"
    );
  }
  if (row.version !== expectedVersion) {
    throw new CollaborationVersionConflictError();
  }
  try {
    const updated = await client.query<{ version: number }>(
      `
        update collaboration_threads
        set normalized_name_hash = $3,
            name_marker = $4,
            version = version + 1,
            updated_at = now()
        where id = $1
          and version = $2
          and lifecycle = 'active'
        returning version
      `,
      [
        row.id,
        expectedVersion,
        hashDomain("thread-name", normalizeName(name)),
        THREAD_NAME_MARKER
      ]
    );
    if (!updated.rows[0]) throw new CollaborationVersionConflictError();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CollaborationStateConflictError(
        "An active channel already uses that normalized name"
      );
    }
    throw error;
  }
  await upsertThreadEncryptedField(client, actor, provider, row, "name", name);
  await appendCollaborationOutboxEventWithClient(client, {
    family: "thread_lifecycle",
    scope: row.scope,
    personalOwnerUserId: row.personal_owner_user_id,
    teamId: row.team_id,
    teamWorkspaceId: row.team_workspace_id,
    threadId: row.id,
    messageId: null,
    shareGrantId: row.share_grant_id,
    logicalMemoryId: row.shared_logical_memory_id,
    resourceType: "collaboration_thread",
    resourceId: row.id,
    actorPrincipalId: actor.userId,
    mutationId: randomUUID()
  });
  const refreshed = await getAuthorizedThreadRow(client, actor, row.id, {
    required: "read",
    includeArchived: false
  });
  return refreshed
    ? (await mapThreadRows(client, actor, provider, [refreshed]))[0]!
    : null;
};

const updateThreadTopicValue = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  input: {
    threadId: string;
    expectedVersion: number;
    topic: string | null;
  }
): Promise<CollaborationThreadRecord | null> => {
  const expectedVersion = requirePositiveInteger(
    input.expectedVersion,
    "expectedVersion"
  );
  const topic =
    input.topic === null
      ? null
      : requireBoundedUtf8(input.topic, "topic", MAX_THREAD_TOPIC_BYTES);
  const row = await getAuthorizedThreadRow(client, actor, input.threadId, {
    required: "write",
    includeArchived: false,
    forUpdate: true
  });
  if (!row) return null;
  if (row.kind !== "personal_channel" && row.kind !== "workspace_channel") {
    throw new CollaborationStateConflictError(
      "Only Personal and Workspace channels have mutable topics"
    );
  }
  if (row.version !== expectedVersion) {
    throw new CollaborationVersionConflictError();
  }
  const updated = await client.query<{ version: number }>(
    `
      update collaboration_threads
      set topic_marker = $3,
          version = version + 1,
          updated_at = now()
      where id = $1
        and version = $2
        and lifecycle = 'active'
      returning version
    `,
    [row.id, expectedVersion, topic === null ? null : THREAD_TOPIC_MARKER]
  );
  if (!updated.rows[0]) throw new CollaborationVersionConflictError();
  await upsertThreadEncryptedField(
    client,
    actor,
    provider,
    row,
    "topic",
    topic
  );
  await appendCollaborationOutboxEventWithClient(client, {
    family: "thread_lifecycle",
    scope: row.scope,
    personalOwnerUserId: row.personal_owner_user_id,
    teamId: row.team_id,
    teamWorkspaceId: row.team_workspace_id,
    threadId: row.id,
    messageId: null,
    shareGrantId: row.share_grant_id,
    logicalMemoryId: row.shared_logical_memory_id,
    resourceType: "collaboration_thread",
    resourceId: row.id,
    actorPrincipalId: actor.userId,
    mutationId: randomUUID()
  });
  const refreshed = await getAuthorizedThreadRow(client, actor, row.id, {
    required: "read",
    includeArchived: false
  });
  return refreshed
    ? (await mapThreadRows(client, actor, provider, [refreshed]))[0]!
    : null;
};

const transitionThreadLifecycle = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  input: { threadId: string; expectedVersion: number },
  transition: "archive" | "restore"
): Promise<CollaborationThreadRecord | null> => {
  const expectedVersion = requirePositiveInteger(
    input.expectedVersion,
    "expectedVersion"
  );
  const row = await getAuthorizedThreadRow(client, actor, input.threadId, {
    required: "write",
    includeArchived: true,
    forUpdate: true
  });
  if (!row) return null;
  if (row.version !== expectedVersion) {
    throw new CollaborationVersionConflictError();
  }
  const expectedLifecycle = transition === "archive" ? "active" : "archived";
  const nextLifecycle = transition === "archive" ? "archived" : "active";
  if (row.lifecycle !== expectedLifecycle) {
    throw new CollaborationStateConflictError(
      `Collaboration thread is not ${expectedLifecycle}`
    );
  }
  try {
    const updated = await client.query<{ version: number }>(
      `
        update collaboration_threads
        set lifecycle = $3::collaboration_lifecycle,
            archived_at = case
              when $3::collaboration_lifecycle = 'archived' then now()
              else null
            end,
            version = version + 1,
            updated_at = now()
        where id = $1
          and version = $2
          and lifecycle = $4::collaboration_lifecycle
        returning version
      `,
      [row.id, expectedVersion, nextLifecycle, expectedLifecycle]
    );
    if (!updated.rows[0]) throw new CollaborationVersionConflictError();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CollaborationStateConflictError(
        "Restoring this thread conflicts with an active thread"
      );
    }
    throw error;
  }
  await appendCollaborationOutboxEventWithClient(client, {
    family: "thread_lifecycle",
    scope: row.scope,
    personalOwnerUserId: row.personal_owner_user_id,
    teamId: row.team_id,
    teamWorkspaceId: row.team_workspace_id,
    threadId: row.id,
    messageId: null,
    shareGrantId: row.share_grant_id,
    logicalMemoryId: row.shared_logical_memory_id,
    resourceType: "collaboration_thread",
    resourceId: row.id,
    actorPrincipalId: actor.userId,
    mutationId: randomUUID()
  });
  const refreshed = await getAuthorizedThreadRow(client, actor, row.id, {
    required: "read",
    includeArchived: true
  });
  return refreshed
    ? (await mapThreadRows(client, actor, provider, [refreshed]))[0]!
    : null;
};

const sendCollaborationMessage = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  input: {
    threadId: string;
    idempotencyKey: string;
    bodyText: string;
    metadata?: Record<string, unknown>;
    provenance?: CollaborationMessageProvenance;
  }
): Promise<CollaborationMessageRecord | null> => {
  const idempotencyKey = requireBoundedText(
    input.idempotencyKey,
    "idempotencyKey",
    MAX_IDEMPOTENCY_KEY_LENGTH
  );
  const bodyText = requireBoundedUtf8(
    input.bodyText,
    "bodyText",
    MAX_MESSAGE_BODY_BYTES
  );
  const metadata = canonicalize(input.metadata ?? {}) as Record<
    string,
    unknown
  >;
  const provenance = canonicalize(
    input.provenance ?? {
      kind: "user_message",
      id: hashDomain("message-provenance", idempotencyKey)
    }
  ) as CollaborationMessageProvenance;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new TypeError("metadata must be a JSON object");
  }
  if (
    typeof provenance !== "object" ||
    provenance === null ||
    Array.isArray(provenance) ||
    typeof provenance.kind !== "string" ||
    typeof provenance.id !== "string"
  ) {
    throw new TypeError("provenance must contain string kind and id fields");
  }
  requireBoundedText(provenance.kind, "provenance.kind", 120);
  requireBoundedText(provenance.id, "provenance.id", 512);

  // The thread lock serializes sequence allocation and same-thread idempotency.
  const thread = await getAuthorizedThreadRow(client, actor, input.threadId, {
    required: "write",
    includeArchived: false,
    forUpdate: true
  });
  if (!thread) return null;
  const idempotencyKeyHash = hashDomain("message-idempotency", idempotencyKey);
  const messageRequestHash = requestHash({
    threadId: thread.id,
    senderPrincipalId: actor.userId,
    bodyText,
    metadata,
    provenance
  });
  const existing = await client.query<MessageRow>(
    `
      select ${selectMessageColumnsSql}
      from collaboration_messages cm
      left join users sender on sender.id = cm.sender_user_id
      where cm.thread_id = $1
        and cm.sender_principal_id = $2
        and cm.idempotency_key_hash = $3
      limit 1
    `,
    [thread.id, actor.userId, idempotencyKeyHash]
  );
  if (existing.rows[0]) {
    if (existing.rows[0].request_hash !== messageRequestHash) {
      throw new CollaborationIdempotencyConflictError(
        "Message idempotency key was reused for different content"
      );
    }
    await attachRecipientStatuses(client, actor, existing.rows);
    return mapMessageRow(client, actor, provider, existing.rows[0]);
  }

  const threadSequence = Number(thread.next_sequence);
  if (!Number.isSafeInteger(threadSequence) || threadSequence <= 0) {
    throw new Error("Collaboration thread sequence is exhausted");
  }
  const audienceVersion = await ensureCurrentThreadAudience(client, thread);
  const messageId = uuidFromHash(
    `koed:collaboration:message:v1\n${thread.id}\n${actor.userId}\n${idempotencyKeyHash}`
  );
  await client.query(
    `
      update collaboration_threads
      set next_sequence = next_sequence + 1,
          last_activity_at = now(),
          updated_at = now()
      where id = $1
    `,
    [thread.id]
  );
  const inserted = await client.query<MessageRow>(
    `
      insert into collaboration_messages (
        id,
        thread_id,
        thread_sequence,
        audience_version,
        scope,
        personal_owner_user_id,
        team_id,
        team_workspace_id,
        sender_kind,
        sender_principal_id,
        sender_user_id,
        idempotency_key_hash,
        request_hash,
        body_marker,
        metadata_marker,
        provenance_kind,
        provenance_id,
        provenance_marker
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        'user', $9, $9, $10, $11, $12, $13,
        'encrypted', $14, $15
      )
      returning
        id,
        thread_id,
        thread_sequence,
        audience_version,
        scope,
        personal_owner_user_id,
        team_id,
        team_workspace_id,
        sender_kind,
        sender_principal_id,
        sender_user_id,
        null::text as sender_display_name,
        null::text as recipient_status,
        request_hash,
        created_at,
        updated_at
    `,
    [
      messageId,
      thread.id,
      threadSequence,
      audienceVersion,
      thread.scope,
      thread.personal_owner_user_id,
      thread.team_id,
      thread.team_workspace_id,
      actor.userId,
      idempotencyKeyHash,
      messageRequestHash,
      MESSAGE_BODY_MARKER,
      MESSAGE_METADATA_MARKER,
      hashDomain("message-provenance-structural", canonicalJson(provenance)),
      MESSAGE_PROVENANCE_MARKER
    ]
  );
  const encryptionScope =
    thread.scope === "personal" ? ("personal" as const) : ("team" as const);
  for (const [sourceColumn, plaintext] of [
    ["body", bodyText],
    ["metadata", metadata],
    ["provenance", provenance]
  ] as const) {
    await upsertEncryptedFieldPayloadWithClient(client, actor, provider, {
      sourceTable: "collaboration_messages",
      sourceId: messageId,
      sourceColumn,
      plaintext,
      visibility: encryptionScope,
      teamId: thread.team_id,
      teamWorkspaceId: thread.team_workspace_id,
      scope: {
        teamId: thread.team_id,
        workspaceId: thread.team_workspace_id,
        objectClass: "collaboration_message"
      },
      rowFamily: "collaboration_message",
      aad: {
        threadId: thread.id,
        threadSequence,
        collaborationScope: thread.scope,
        threadKind: thread.kind
      }
    });
  }
  await appendCollaborationOutboxEventWithClient(client, {
    family:
      thread.kind === "shared_session_discussion"
        ? "shared_session_discussion_activity"
        : "message_created",
    scope: thread.scope,
    personalOwnerUserId: thread.personal_owner_user_id,
    teamId: thread.team_id,
    teamWorkspaceId: thread.team_workspace_id,
    threadId: thread.id,
    messageId,
    shareGrantId: thread.share_grant_id,
    logicalMemoryId: thread.shared_logical_memory_id,
    resourceType: "collaboration_message",
    resourceId: messageId,
    actorPrincipalId: actor.userId,
    mutationId: uuidFromHash(
      `koed:collaboration:message-event:v1\n${messageId}\n${messageRequestHash}`
    )
  });
  const sender = await client.query<{ display_name: string | null }>(
    `select display_name from users where id = $1`,
    [actor.userId]
  );
  inserted.rows[0]!.sender_display_name = sender.rows[0]?.display_name ?? null;
  await attachRecipientStatuses(client, actor, inserted.rows);
  return mapMessageRow(client, actor, provider, inserted.rows[0]!);
};

const listCollaborationMessages = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  input: {
    threadId: string;
    afterSequence?: number;
    beforeSequence?: number;
    limit?: number;
  }
): Promise<CollaborationMessagePageRecord | null> => {
  const thread = await getAuthorizedThreadRow(client, actor, input.threadId, {
    required: "read",
    includeArchived: true
  });
  if (!thread) return null;
  const afterSequence = requireNonNegativeInteger(
    input.afterSequence ?? 0,
    "afterSequence"
  );
  const beforeSequence =
    input.beforeSequence === undefined
      ? null
      : requirePositiveInteger(input.beforeSequence, "beforeSequence");
  if (beforeSequence !== null && beforeSequence <= afterSequence) {
    throw new TypeError("beforeSequence must be greater than afterSequence");
  }
  const limit = boundedLimit(input.limit, MAX_PAGE_SIZE, 50);
  const ascending = input.afterSequence !== undefined;
  const result = await client.query<MessageRow>(
    `
      select ${selectMessageColumnsSql}
      from collaboration_messages cm
      left join users sender on sender.id = cm.sender_user_id
      where cm.thread_id = $1
        and cm.thread_sequence > $2
        and ($3::bigint is null or cm.thread_sequence < $3)
      order by cm.thread_sequence ${ascending ? "asc" : "desc"}
      limit $4
    `,
    [thread.id, afterSequence, beforeSequence, limit + 1]
  );
  const hasMore = result.rows.length > limit;
  const pageRows = result.rows.slice(0, limit);
  if (!ascending) pageRows.reverse();
  await attachRecipientStatuses(client, actor, pageRows);
  const messages = await Promise.all(
    pageRows.map((row) => mapMessageRow(client, actor, provider, row))
  );
  return {
    messages,
    hasMore,
    nextBeforeSequence:
      messages.length > 0 ? messages[0]!.threadSequence : null,
    nextAfterSequence:
      messages.length > 0 ? messages[messages.length - 1]!.threadSequence : null
  };
};

const getCollaborationMessageForRealtime = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  input: { threadId: string; messageId: string }
): Promise<CollaborationMessageRecord | null> => {
  const thread = await getAuthorizedThreadRow(client, actor, input.threadId, {
    required: "read",
    includeArchived: true
  });
  if (!thread) return null;
  const result = await client.query<MessageRow>(
    `
      select ${selectMessageColumnsSql}
      from collaboration_messages cm
      left join users sender on sender.id = cm.sender_user_id
      where cm.id = $1
        and cm.thread_id = $2
      limit 1
    `,
    [input.messageId, thread.id]
  );
  if (!result.rows[0]) return null;
  await attachRecipientStatuses(client, actor, result.rows);
  return mapMessageRow(client, actor, provider, result.rows[0]);
};

const listCollaborationMessageReceiptsForRealtime = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  input: { threadId: string; throughMessageId: string }
): Promise<CollaborationMessageReceiptRecord[] | null> => {
  const thread = await getAuthorizedThreadRow(client, actor, input.threadId, {
    required: "read",
    includeArchived: true
  });
  if (!thread) return null;
  const through = await client.query<{ thread_sequence: string | number }>(
    `
      select thread_sequence
      from collaboration_messages
      where thread_id = $1 and id = $2
      limit 1
    `,
    [thread.id, input.throughMessageId]
  );
  const throughSequence = Number(through.rows[0]?.thread_sequence ?? 0);
  if (throughSequence <= 0) return [];
  const rows = await client.query<MessageRow>(
    `
      select ${selectMessageColumnsSql}
      from collaboration_messages cm
      left join users sender on sender.id = cm.sender_user_id
      where cm.thread_id = $1
        and cm.sender_principal_id = $2
        and cm.thread_sequence <= $3
      order by cm.thread_sequence desc
      limit $4
    `,
    [thread.id, actor.userId, throughSequence, MAX_REALTIME_RECEIPT_UPDATES]
  );
  await attachRecipientStatuses(client, actor, rows.rows);
  return rows.rows.flatMap((row) =>
    row.recipient_status
      ? [
          {
            messageId: row.id,
            recipientStatus: row.recipient_status
          }
        ]
      : []
  );
};

type ReceiptStateRow = {
  last_delivered_message_id: string | null;
  last_delivered_sequence: string | number;
  last_delivered_at: Date | null;
  last_read_message_id: string | null;
  last_read_sequence: string | number;
  last_read_at: Date | null;
  version: number;
  updated_at: Date;
};

const unreadCountAfter = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  threadId: string,
  sequence: number
): Promise<number> => {
  const result = await client.query<{ unread_count: string | number }>(
    `
      select count(*)::bigint as unread_count
      from collaboration_messages
      where thread_id = $1
        and thread_sequence > $2
        and sender_principal_id is distinct from $3
    `,
    [threadId, sequence, actor.userId]
  );
  return Number(result.rows[0]?.unread_count ?? 0);
};

const receiptStateRecord = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  threadId: string,
  row: ReceiptStateRow | undefined
): Promise<CollaborationReadStateRecord> => {
  const lastReadSequence = Number(row?.last_read_sequence ?? 0);
  return {
    threadId,
    userId: actor.userId,
    lastDeliveredMessageId: row?.last_delivered_message_id ?? null,
    lastDeliveredSequence: Number(row?.last_delivered_sequence ?? 0),
    lastDeliveredAt: iso(row?.last_delivered_at ?? null),
    lastReadMessageId: row?.last_read_message_id ?? null,
    lastReadSequence,
    lastReadAt: iso(row?.last_read_at ?? null),
    unreadCount: await unreadCountAfter(
      client,
      actor,
      threadId,
      lastReadSequence
    ),
    version: row?.version ?? 1,
    updatedAt: (row?.updated_at ?? new Date(0)).toISOString()
  };
};

const getCollaborationReceiptStateForRealtime = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  input: { threadId: string }
): Promise<CollaborationReadStateRecord | null> => {
  const thread = await getAuthorizedThreadRow(client, actor, input.threadId, {
    required: "read",
    includeArchived: true
  });
  if (!thread) return null;
  const result = await client.query<ReceiptStateRow>(
    `
      select
        last_delivered_message_id,
        last_delivered_sequence,
        last_delivered_at,
        last_read_message_id,
        last_read_sequence,
        last_read_at,
        version,
        updated_at
      from collaboration_receipt_states
      where thread_id = $1
        and user_id = $2
      limit 1
    `,
    [thread.id, actor.userId]
  );
  return receiptStateRecord(client, actor, thread.id, result.rows[0]);
};

const advanceCollaborationReceiptState = async (
  client: pg.PoolClient,
  actor: ActorContext,
  input: {
    threadId: string;
    messageId: string;
    state: "delivered" | "read";
  }
): Promise<CollaborationReadStateRecord | null> => {
  const thread = await getAuthorizedThreadRow(client, actor, input.threadId, {
    required: "read",
    includeArchived: true,
    forUpdate: true
  });
  if (!thread) return null;
  const message = await client.query<{
    id: string;
    thread_sequence: string | number;
  }>(
    `
      select id, thread_sequence
      from collaboration_messages
      where id = $1
        and thread_id = $2
      limit 1
    `,
    [input.messageId, thread.id]
  );
  const target = message.rows[0];
  if (!target) {
    throw new CollaborationStateConflictError(
      "Receipt-state message does not belong to the authorized thread"
    );
  }
  const targetSequence = Number(target.thread_sequence);
  const current = await client.query<ReceiptStateRow>(
    `
      select
        last_delivered_message_id,
        last_delivered_sequence,
        last_delivered_at,
        last_read_message_id,
        last_read_sequence,
        last_read_at,
        version,
        updated_at
      from collaboration_receipt_states
      where thread_id = $1 and user_id = $2
      for update
    `,
    [thread.id, actor.userId]
  );
  const currentSequence = Number(
    input.state === "read"
      ? (current.rows[0]?.last_read_sequence ?? 0)
      : (current.rows[0]?.last_delivered_sequence ?? 0)
  );
  if (targetSequence <= currentSequence) {
    return receiptStateRecord(client, actor, thread.id, current.rows[0]);
  }
  const updated = await client.query<ReceiptStateRow>(
    `
      insert into collaboration_receipt_states (
        thread_id,
        user_id,
        last_delivered_message_id,
        last_delivered_sequence,
        last_delivered_at,
        last_read_message_id,
        last_read_sequence,
        last_read_at
      )
      values (
        $1,
        $2,
        $3::uuid,
        $4::bigint,
        now(),
        case when $5::text = 'read' then $3::uuid else null end,
        case when $5::text = 'read' then $4::bigint else 0::bigint end,
        case when $5::text = 'read' then now() else null end
      )
      on conflict (thread_id, user_id) do update
        set last_delivered_message_id =
              case
                when collaboration_receipt_states.last_delivered_sequence < excluded.last_delivered_sequence
                then excluded.last_delivered_message_id
                else collaboration_receipt_states.last_delivered_message_id
              end,
            last_delivered_sequence =
              greatest(
                collaboration_receipt_states.last_delivered_sequence,
                excluded.last_delivered_sequence
              ),
            last_delivered_at =
              case
                when collaboration_receipt_states.last_delivered_sequence < excluded.last_delivered_sequence
                then excluded.last_delivered_at
                else collaboration_receipt_states.last_delivered_at
              end,
            last_read_message_id =
              case
                when collaboration_receipt_states.last_read_sequence < excluded.last_read_sequence
                then excluded.last_read_message_id
                else collaboration_receipt_states.last_read_message_id
              end,
            last_read_sequence =
              greatest(
                collaboration_receipt_states.last_read_sequence,
                excluded.last_read_sequence
              ),
            last_read_at =
              case
                when collaboration_receipt_states.last_read_sequence < excluded.last_read_sequence
                then excluded.last_read_at
                else collaboration_receipt_states.last_read_at
              end,
            version = collaboration_receipt_states.version + 1,
            updated_at = now()
      returning
        last_delivered_message_id,
        last_delivered_sequence,
        last_delivered_at,
        last_read_message_id,
        last_read_sequence,
        last_read_at,
        version,
        updated_at
    `,
    [thread.id, actor.userId, target.id, targetSequence, input.state]
  );
  const row = updated.rows[0];
  if (!row) {
    throw new CollaborationStateConflictError(
      "Receipt state did not advance monotonically"
    );
  }
  await appendCollaborationOutboxEventWithClient(client, {
    family: "receipt_state_updated",
    scope: thread.scope,
    personalOwnerUserId: thread.personal_owner_user_id,
    teamId: thread.team_id,
    teamWorkspaceId: thread.team_workspace_id,
    threadId: thread.id,
    messageId: target.id,
    shareGrantId: thread.share_grant_id,
    logicalMemoryId: thread.shared_logical_memory_id,
    resourceType: "collaboration_receipt_state",
    resourceId: uuidFromHash(
      `koed:collaboration:receipt-state:v1\n${thread.id}\n${actor.userId}`
    ),
    actorPrincipalId: actor.userId,
    mutationId: uuidFromHash(
      `koed:collaboration:receipt-state-event:v1\n${thread.id}\n${actor.userId}\n${input.state}\n${targetSequence}`
    )
  });
  return receiptStateRecord(client, actor, thread.id, row);
};

const listAuthorizedOutboxRows = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  input:
    | { scope: "personal"; afterCursor: number; limit?: number }
    | {
        scope: "team";
        teamId: string;
        afterCursor: number;
        limit?: number;
      }
): Promise<{ rows: OutboxRow[]; limit: number } | null> => {
  const afterCursor = requireNonNegativeInteger(
    input.afterCursor,
    "afterCursor"
  );
  if (input.scope === "personal") {
    if (!(await activeUser(client, actor))) return null;
  } else if (!(await activeTeamMember(client, actor, input.teamId))) {
    return null;
  }
  const limit = boundedLimit(input.limit, MAX_REPLAY_SIZE, 100);
  const result = await client.query<OutboxRow>(
    `
      select event.*
      from collaboration_outbox event
      where event.scope = $2::collaboration_scope
        and ($2::collaboration_scope = 'personal' or event.team_id = $3::uuid)
        and event.cursor > $4
        and event.available_at <= now()
        and event.replay_until > now()
        and event.invalidated_at is null
        and (
          (
            event.scope = 'personal'
            and event.personal_owner_user_id = $1
          )
          or (
            event.scope = 'team'
            and exists (
              select 1
              from teams t
              join team_memberships tm
                on tm.team_id = t.id
               and tm.user_id = $1
               and tm.status = 'enabled'
               and tm.disabled_at is null
              join users u
                on u.id = tm.user_id
               and u.disabled_at is null
               and u.deleted_at is null
              where t.id = event.team_id
                and t.lifecycle = 'active'
                and t.entitlement_status in ('active', 'grace')
            )
            and (
              event.family in (
                'team_lifecycle',
                'team_membership_access',
                'workspace_lifecycle_access'
              )
              or
              (
                event.thread_id is not null
                and exists (
                  select 1
                  from collaboration_threads ct
                  ${authorizedThreadJoinsSql}
                  where ct.id = event.thread_id
                    and ct.lifecycle in ('active', 'archived')
                    and ${authorizedThreadPredicate("read")}
                )
              )
              or (
                event.thread_id is null
                and (
                  event.team_workspace_id is null
                  or exists (
                    select 1
                    from team_workspaces tw
                    join team_workspace_access_grants twag
                      on twag.team_workspace_id = tw.id
                     and twag.team_id = tw.team_id
                     and twag.user_id = $1
                     and twag.disabled_at is null
                     and twag.access in ('read', 'write')
                    where tw.id = event.team_workspace_id
                      and tw.team_id = event.team_id
                      and tw.lifecycle = 'active'
                      and tw.archived_at is null
                  )
                )
              )
            )
          )
        )
      order by event.cursor
      limit $5
    `,
    [
      actor.userId,
      input.scope,
      input.scope === "team" ? input.teamId : null,
      afterCursor,
      limit + 1
    ]
  );
  return { rows: result.rows, limit };
};

export const collaborationSubscriptionPrincipalHash = (
  principalId: string
): string => hashDomain("subscription-principal", principalId);

export const createCollaborationRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider }
): CollaborationRepository & CollaborationRealtimeMaterializationRepository => {
  const requireProvider = (): EnvelopeEncryptionProvider => {
    if (!options.envelopeEncryptionProvider) {
      throw new Error(
        "Envelope encryption provider is required for collaboration"
      );
    }
    return options.envelopeEncryptionProvider;
  };
  return {
    async listTeamParticipants(actor, teamId) {
      if (!(await activeTeamMember(pool, actor, teamId))) return null;
      const result = await pool.query<{
        user_id: string;
        display_name: string | null;
      }>(
        `
          select u.id as user_id, u.display_name
          from team_memberships tm
          join users u
            on u.id = tm.user_id
           and u.disabled_at is null
           and u.deleted_at is null
          where tm.team_id = $1
            and tm.status = 'enabled'
            and tm.disabled_at is null
          order by coalesce(nullif(trim(u.display_name), ''), u.id::text), u.id
        `,
        [teamId]
      );
      return result.rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name
      }));
    },

    async createThread(actor, input) {
      return withTransaction(pool, async (client) => {
        const prepared = await prepareThreadCreation(client, actor, input);
        if (!prepared) return null;
        return insertThread(client, actor, requireProvider(), prepared);
      });
    },

    async getThread(actor, input) {
      const row = await getAuthorizedThreadRow(pool, actor, input.threadId, {
        required: "read",
        includeArchived: input.includeArchived === true
      });
      return row
        ? (await mapThreadRows(pool, actor, requireProvider(), [row]))[0]!
        : null;
    },

    async listThreads(actor, input) {
      const rows = await listAuthorizedThreadRows(pool, actor, input);
      return rows === null
        ? null
        : mapThreadRows(pool, actor, requireProvider(), rows);
    },

    async renameThread(actor, input) {
      return withTransaction(pool, (client) =>
        updateThreadName(client, actor, requireProvider(), input)
      );
    },

    async updateThreadTopic(actor, input) {
      return withTransaction(pool, (client) =>
        updateThreadTopicValue(client, actor, requireProvider(), input)
      );
    },

    async archiveThread(actor, input) {
      return withTransaction(pool, (client) =>
        transitionThreadLifecycle(
          client,
          actor,
          requireProvider(),
          input,
          "archive"
        )
      );
    },

    async restoreThread(actor, input) {
      return withTransaction(pool, (client) =>
        transitionThreadLifecycle(
          client,
          actor,
          requireProvider(),
          input,
          "restore"
        )
      );
    },

    async sendMessage(actor, input) {
      return withTransaction(pool, (client) =>
        sendCollaborationMessage(client, actor, requireProvider(), input)
      );
    },

    async listMessages(actor, input) {
      return listCollaborationMessages(pool, actor, requireProvider(), input);
    },

    async getMessageForRealtime(actor, input) {
      return getCollaborationMessageForRealtime(
        pool,
        actor,
        requireProvider(),
        input
      );
    },

    async isEventAuthorized(actor, input) {
      return authorizedEventExists(pool, actor, input);
    },

    async getReceiptStateForRealtime(actor, input) {
      return getCollaborationReceiptStateForRealtime(pool, actor, input);
    },

    async listMessageReceiptsForRealtime(actor, input) {
      return listCollaborationMessageReceiptsForRealtime(pool, actor, input);
    },

    async getPersonalMemoryForRealtime(actor, input) {
      return getCapturedSessionSummaryWithClient(pool, actor, input.sessionId);
    },

    async advanceReadState(actor, input) {
      return withTransaction(pool, (client) =>
        advanceCollaborationReceiptState(client, actor, {
          ...input,
          state: "read"
        })
      );
    },

    async advanceDeliveryState(actor, input) {
      return withTransaction(pool, (client) =>
        advanceCollaborationReceiptState(client, actor, {
          ...input,
          state: "delivered"
        })
      );
    },

    async getAuthorizedSnapshot(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read read only");
        const rows = await listAuthorizedThreadRows(
          client,
          actor,
          {
            ...input,
            limit: MAX_SNAPSHOT_THREADS + 1
          },
          MAX_SNAPSHOT_THREADS + 1
        );
        if (rows === null) {
          await client.query("rollback");
          return null;
        }
        if (rows.length > MAX_SNAPSHOT_THREADS) {
          throw new CollaborationStateConflictError(
            "Authorized collaboration snapshot exceeds the bounded thread limit"
          );
        }
        const highWater = await client.query<{ cursor: string | number }>(
          `select greatest(
             coalesce((
               select max(event.cursor)
                 from collaboration_outbox event
                where event.scope = $1::collaboration_scope
                  and (
                    ($1::collaboration_scope = 'personal'
                      and event.personal_owner_user_id = $3)
                    or ($1::collaboration_scope = 'team'
                      and event.team_id = $2::uuid)
                  )
             ), 0),
             coalesce((
               select watermark.high_water_cursor
                 from collaboration_replay_watermarks watermark
                where watermark.scope = $1::collaboration_scope
                  and (
                    ($1::collaboration_scope = 'personal'
                      and watermark.personal_owner_user_id = $3)
                    or ($1::collaboration_scope = 'team'
                      and watermark.team_id = $2::uuid)
                  )
             ), 0)
           ) as cursor`,
          [
            input.scope,
            input.scope === "team" ? input.teamId : null,
            actor.userId
          ]
        );
        const threads = await mapThreadRows(
          client,
          actor,
          requireProvider(),
          rows
        );
        await client.query("commit");
        return {
          scope: input.scope,
          personalOwnerUserId: input.scope === "personal" ? actor.userId : null,
          teamId: input.scope === "team" ? input.teamId : null,
          highWaterCursor: Number(highWater.rows[0]?.cursor ?? 0),
          threads
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async replayEvents(actor, input) {
      const result = await listAuthorizedOutboxRows(pool, actor, input);
      if (result === null) return null;
      const hasMore = result.rows.length > result.limit;
      return {
        afterCursor: input.afterCursor,
        events: result.rows.slice(0, result.limit).map(mapOutboxRow),
        hasMore
      };
    },

    async pruneExpiredReplayHistory(input = {}) {
      return withTransaction(pool, (client) =>
        pruneExpiredReplayHistoryWithClient(client, input.limit)
      );
    },

    async createSubscription(actor, input) {
      return withTransaction(pool, (client) =>
        createOrUpdateCollaborationSubscriptionWithClient(client, actor, input)
      );
    },

    async recoverSubscription(actor, input) {
      return withTransaction(pool, (client) =>
        recoverCollaborationSubscriptionWithClient(client, actor, input)
      );
    },

    async acknowledgeSubscription(actor, input) {
      return withTransaction(pool, (client) =>
        acknowledgeCollaborationSubscriptionWithClient(client, actor, input)
      );
    },

    async revokeSubscriptions(input) {
      return withTransaction(pool, (client) =>
        revokeCollaborationSubscriptionsWithClient(client, input)
      );
    }
  };
};
