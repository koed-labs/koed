import { z } from "zod";
import {
  teamManualStatuses,
  teamPresenceStatusCatalogue
} from "./team-presence.js";
export {
  TEAM_ACTIVITY_WRITE_THROTTLE_MS,
  coarsePresenceFromTeamPresence,
  deriveTeamPresenceSnapshot
} from "./team-presence.js";
import { assertSecureHttpTransport } from "./http-transport-security.js";
import {
  approvalDecisionDisplaySchema,
  personalDesktopToolDisplaySchema
} from "./personal-desktop-contract.js";

export const COLLABORATION_CONTRACT_VERSION = 3;
export const COLLABORATION_NAME_MAX_CODE_POINTS = 80;
export const COLLABORATION_DISPLAY_NAME_MAX_CODE_POINTS = 128;
export const COLLABORATION_TOPIC_DESCRIPTION_MAX_UTF8_BYTES = 1_024;
export const COLLABORATION_MESSAGE_MAX_UTF8_BYTES = 32_768;
export const COLLABORATION_HISTORY_PAGE_MAX_ITEMS = 100;
export const COLLABORATION_SOURCE_PAGE_MAX_ITEMS = 100;
export const COLLABORATION_MAX_DM_PARTICIPANTS = 40;
export const COLLABORATION_REALTIME_CURSOR_MAX_BYTES = 4_096;
export const COLLABORATION_RENDERER_MAX_PENDING_EVENTS = 500;
export const COLLABORATION_RENDERER_MAX_PENDING_BYTES = 5 * 1_024 * 1_024;
export const COLLABORATION_RENDERER_ACK_DEADLINE_MS = 30_000;
export const COLLABORATION_MESSAGE_BURST_MAX_COUNT = 20;
export const COLLABORATION_MESSAGE_BURST_WINDOW_MS = 10_000;
export const COLLABORATION_MESSAGE_SUSTAINED_MAX_COUNT = 60;
export const COLLABORATION_MESSAGE_SUSTAINED_WINDOW_MS = 60_000;
export const COLLABORATION_TEAM_MESSAGE_MAX_PER_MINUTE = 600;
export const COLLABORATION_DEPLOYMENT_MESSAGE_MAX_PER_MINUTE = 6_000;
export const COLLABORATION_INVITE_CREATION_MAX_PER_HOUR = 10;
export const COLLABORATION_CHANNEL_CREATION_MAX_PER_HOUR = 20;
export const COLLABORATION_CONNECTION_ATTEMPT_MAX_PER_MINUTE = 10;
export const COLLABORATION_RECONNECT_MAX_ATTEMPTS = 10;
export const COLLABORATION_RECONNECT_WINDOW_MS = 5 * 60_000;
export const COLLABORATION_RECONNECT_BACKOFF_CAP_MS = 30_000;
export const COLLABORATION_RECONNECT_UNAVAILABLE_COOLDOWN_MS = 60_000;
export const COLLABORATION_SEND_RETRY_MAX_ATTEMPTS = 5;
export const COLLABORATION_RENDERED_ROW_MAX_COUNT = 250;
export const COLLABORATION_DECRYPT_BATCH_MAX_ITEMS = 100;
export const COLLABORATION_SPLIT_VIEW_BREAKPOINT_PX = 900;
export const COLLABORATION_SPLIT_VIEW_SOURCE_MIN_PX = 360;
export const COLLABORATION_SPLIT_VIEW_DISCUSSION_MIN_PX = 320;

export const calculateCollaborationReconnectDelay = (input: {
  attempt: number;
  baseMs: number;
  maxMs: number;
  jitter: number;
  random: number;
}): number => {
  const attempt = Math.max(0, Math.min(Math.trunc(input.attempt), 30));
  const baseMs = Math.max(1, Math.floor(input.baseMs));
  const maxMs = Math.max(baseMs, Math.floor(input.maxMs));
  const jitter = Math.max(0, Math.min(input.jitter, 0.5));
  const random = Math.max(0, Math.min(input.random, 1));
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  const factor = 1 - jitter + random * jitter * 2;
  return Math.max(1, Math.min(maxMs, Math.round(exponential * factor)));
};

export const COLLABORATION_DEFAULT_LIMITS = {
  nameMaxNormalizedCodePoints: COLLABORATION_NAME_MAX_CODE_POINTS,
  displayNameMaxNormalizedCodePoints:
    COLLABORATION_DISPLAY_NAME_MAX_CODE_POINTS,
  topicDescriptionMaxUtf8Bytes: COLLABORATION_TOPIC_DESCRIPTION_MAX_UTF8_BYTES,
  messageMaxUtf8Bytes: COLLABORATION_MESSAGE_MAX_UTF8_BYTES,
  historyPageMaxItems: COLLABORATION_HISTORY_PAGE_MAX_ITEMS,
  rendererMaxPendingEvents: COLLABORATION_RENDERER_MAX_PENDING_EVENTS,
  rendererMaxPendingBytes: COLLABORATION_RENDERER_MAX_PENDING_BYTES,
  rendererAcknowledgementDeadlineMs: COLLABORATION_RENDERER_ACK_DEADLINE_MS,
  messageBurstMaxCount: COLLABORATION_MESSAGE_BURST_MAX_COUNT,
  messageBurstWindowMs: COLLABORATION_MESSAGE_BURST_WINDOW_MS,
  messageSustainedMaxCount: COLLABORATION_MESSAGE_SUSTAINED_MAX_COUNT,
  messageSustainedWindowMs: COLLABORATION_MESSAGE_SUSTAINED_WINDOW_MS,
  teamMessageMaxPerMinute: COLLABORATION_TEAM_MESSAGE_MAX_PER_MINUTE,
  deploymentMessageMaxPerMinute:
    COLLABORATION_DEPLOYMENT_MESSAGE_MAX_PER_MINUTE,
  inviteCreationMaxPerHour: COLLABORATION_INVITE_CREATION_MAX_PER_HOUR,
  channelCreationMaxPerHour: COLLABORATION_CHANNEL_CREATION_MAX_PER_HOUR,
  connectionAttemptMaxPerMinute:
    COLLABORATION_CONNECTION_ATTEMPT_MAX_PER_MINUTE,
  reconnectMaxAttempts: COLLABORATION_RECONNECT_MAX_ATTEMPTS,
  reconnectWindowMs: COLLABORATION_RECONNECT_WINDOW_MS,
  reconnectBackoffCapMs: COLLABORATION_RECONNECT_BACKOFF_CAP_MS,
  reconnectUnavailableCooldownMs:
    COLLABORATION_RECONNECT_UNAVAILABLE_COOLDOWN_MS,
  sendRetryMaxAttempts: COLLABORATION_SEND_RETRY_MAX_ATTEMPTS,
  renderedRowMaxCount: COLLABORATION_RENDERED_ROW_MAX_COUNT,
  decryptBatchMaxItems: COLLABORATION_DECRYPT_BATCH_MAX_ITEMS,
  splitViewBreakpointPx: COLLABORATION_SPLIT_VIEW_BREAKPOINT_PX,
  splitViewSourceMinPx: COLLABORATION_SPLIT_VIEW_SOURCE_MIN_PX,
  splitViewDiscussionMinPx: COLLABORATION_SPLIT_VIEW_DISCUSSION_MIN_PX
} as const;

const MAX_TEAMS_PER_SNAPSHOT = 50;
const MAX_WORKSPACES_PER_TEAM = 20;
const MAX_CHANNELS_PER_WORKSPACE = 50;
const MAX_DIRECT_MESSAGES_PER_TEAM = 100;
const MAX_SHARED_SESSIONS_PER_WORKSPACE = 100;
const MAX_PERSONAL_CHANNELS = 100;
const MAX_PERSONAL_MEMORY_ENTRIES = 100;
const MAX_TEAM_PEOPLE = 5_000;
const MAX_SAFE_ERROR_MESSAGE_BYTES = 512;
const MAX_INVITATION_BYTES = 4_096;
const MAX_SHARED_SOURCE_BODY_BYTES = 256 * 1_024;
const MAX_REMOTE_BACKEND_URL_BYTES = 2_048;
const utf8Encoder = new TextEncoder();

const utf8Bytes = (value: string): number =>
  utf8Encoder.encode(value).byteLength;

export const collaborationSafeErrorMessages = {
  invalid_input: "Check the entered information and try again.",
  not_available: "This collaboration item is not available.",
  permission_denied: "You do not have access to this collaboration item.",
  access_revoked: "Access to this collaboration item has ended.",
  conflict: "This item changed. Reload it and try again.",
  rate_limited: "Too many requests. Try again shortly.",
  offline: "Collaboration is offline. Personal Memory remains available.",
  temporarily_unavailable: "Collaboration is temporarily unavailable.",
  representation_pending:
    "Koed is preparing this Shared Memory summary on your connected AI Client.",
  history_expired: "Older activity is no longer available. Reload to continue.",
  internal_error: "Something went wrong. Try again."
} as const;

const normalizedRequiredTextSchema = z
  .string()
  .transform((value) => value.trim().normalize("NFC"))
  .pipe(z.string().min(1));

const normalizedOptionalTextSchema = z
  .string()
  .transform((value) => value.trim().normalize("NFC"));

const boundedCodePoints = (maximum: number) =>
  normalizedRequiredTextSchema.refine(
    (value) => [...value].length <= maximum,
    `Must contain at most ${maximum} normalized Unicode code points`
  );

const boundedOptionalUtf8 = (maximum: number) =>
  normalizedOptionalTextSchema.refine(
    (value) => utf8Bytes(value) <= maximum,
    `Must contain at most ${maximum} UTF-8 bytes`
  );

const boundedRequiredUtf8 = (maximum: number) =>
  normalizedRequiredTextSchema.refine(
    (value) => utf8Bytes(value) <= maximum,
    `Must contain at most ${maximum} UTF-8 bytes`
  );

const dangerousApprovalCopyPattern =
  /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u;

const authoritativeApprovalCopy = (maximum: number) =>
  boundedRequiredUtf8(maximum).refine(
    (value) => !dangerousApprovalCopyPattern.test(value),
    "Approval copy must not contain line, control, or bidirectional formatting characters"
  );

const distinctUuidArray = (minimum: number, maximum: number) =>
  z
    .array(z.uuid())
    .min(minimum)
    .max(maximum)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: "Identifiers must be distinct"
        });
      }
    });

export const collaborationNameSchema = boundedCodePoints(
  COLLABORATION_NAME_MAX_CODE_POINTS
);

export const collaborationDisplayNameSchema = boundedCodePoints(
  COLLABORATION_DISPLAY_NAME_MAX_CODE_POINTS
);

export const collaborationTopicDescriptionSchema = boundedOptionalUtf8(
  COLLABORATION_TOPIC_DESCRIPTION_MAX_UTF8_BYTES
);

export const collaborationMessageBodySchema = boundedRequiredUtf8(
  COLLABORATION_MESSAGE_MAX_UTF8_BYTES
);

export const collaborationIdentifierSchema = z.uuid();

export const collaborationTimestampSchema = z
  .string()
  .max(64)
  .datetime({ offset: true });

export const collaborationOpaqueCursorSchema = z
  .string()
  .min(16)
  .refine(
    (value) => utf8Bytes(value) <= COLLABORATION_REALTIME_CURSOR_MAX_BYTES,
    `Must contain at most ${COLLABORATION_REALTIME_CURSOR_MAX_BYTES} UTF-8 bytes`
  )
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/);

export const collaborationRealtimeCursorSchema =
  collaborationOpaqueCursorSchema.regex(/^crt1\.[A-Za-z0-9_-]+$/);

export const collaborationDeliveryIdSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const hasUnsafeRemotePathShape = (value: string): boolean => {
  const pathStart = value.indexOf("/", value.indexOf("://") + 3);
  if (pathStart < 0) return false;
  const rawPath = value.slice(pathStart).split(/[?#]/, 1)[0] ?? "";
  return (
    /(?:^|\/)(?:\.{1,2}|%(?:2e|2E)(?:%(?:2e|2E))?)(?:\/|$)/.test(rawPath) ||
    /%(?:00|2f|2F|5c|5C)/.test(rawPath)
  );
};

const hasWhitespaceOrControl = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      /\s/u.test(character) ||
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    );
  });

export const collaborationRemoteBackendUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => utf8Bytes(value) <= MAX_REMOTE_BACKEND_URL_BYTES,
    `Must contain at most ${MAX_REMOTE_BACKEND_URL_BYTES} UTF-8 bytes`
  )
  .refine((value) => !hasWhitespaceOrControl(value), {
    message: "Remote URL must not contain control characters or whitespace"
  })
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Remote URL is invalid" });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "Remote URL must use HTTP or HTTPS"
      });
      return;
    }
    try {
      assertSecureHttpTransport(parsed, "Remote URL");
    } catch {
      context.addIssue({
        code: "custom",
        message: "Remote URL requires HTTPS except for loopback development"
      });
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
      context.addIssue({
        code: "custom",
        message: "Remote URL must be a credential-free backend address"
      });
    }
    if (parsed.search || parsed.hash) {
      context.addIssue({
        code: "custom",
        message: "Remote URL must not contain a query string or fragment"
      });
    }
    if (hasUnsafeRemotePathShape(value)) {
      context.addIssue({
        code: "custom",
        message: "Remote URL path is unsafe"
      });
    }
  })
  .transform((value) => new URL(value).toString().replace(/\/+$/, ""));

const upstreamBackendIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/);

export const collaborationBackendIdentitySchema = z
  .object({
    id: upstreamBackendIdSchema,
    baseUrl: collaborationRemoteBackendUrlSchema
  })
  .strict();

const collaborationRevisionSchema = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/);

const positiveVersionSchema = z.number().int().safe().positive();
const nonNegativeSequenceSchema = z.number().int().safe().min(0);

export const collaborationLimitsSchema = z
  .object({
    nameMaxNormalizedCodePoints: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_NAME_MAX_CODE_POINTS),
    displayNameMaxNormalizedCodePoints: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_DISPLAY_NAME_MAX_CODE_POINTS),
    topicDescriptionMaxUtf8Bytes: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_TOPIC_DESCRIPTION_MAX_UTF8_BYTES),
    messageMaxUtf8Bytes: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_MESSAGE_MAX_UTF8_BYTES),
    historyPageMaxItems: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_HISTORY_PAGE_MAX_ITEMS),
    rendererMaxPendingEvents: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_RENDERER_MAX_PENDING_EVENTS),
    rendererMaxPendingBytes: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_RENDERER_MAX_PENDING_BYTES),
    rendererAcknowledgementDeadlineMs: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_RENDERER_ACK_DEADLINE_MS),
    messageBurstMaxCount: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_MESSAGE_BURST_MAX_COUNT),
    messageBurstWindowMs: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_MESSAGE_BURST_WINDOW_MS),
    messageSustainedMaxCount: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_MESSAGE_SUSTAINED_MAX_COUNT),
    messageSustainedWindowMs: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_MESSAGE_SUSTAINED_WINDOW_MS),
    teamMessageMaxPerMinute: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_TEAM_MESSAGE_MAX_PER_MINUTE),
    deploymentMessageMaxPerMinute: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_DEPLOYMENT_MESSAGE_MAX_PER_MINUTE),
    inviteCreationMaxPerHour: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_INVITE_CREATION_MAX_PER_HOUR),
    channelCreationMaxPerHour: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_CHANNEL_CREATION_MAX_PER_HOUR),
    connectionAttemptMaxPerMinute: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_CONNECTION_ATTEMPT_MAX_PER_MINUTE),
    reconnectMaxAttempts: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_RECONNECT_MAX_ATTEMPTS),
    reconnectWindowMs: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_RECONNECT_WINDOW_MS),
    reconnectBackoffCapMs: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_RECONNECT_BACKOFF_CAP_MS),
    reconnectUnavailableCooldownMs: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_RECONNECT_UNAVAILABLE_COOLDOWN_MS),
    sendRetryMaxAttempts: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_SEND_RETRY_MAX_ATTEMPTS),
    renderedRowMaxCount: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_RENDERED_ROW_MAX_COUNT),
    decryptBatchMaxItems: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_DECRYPT_BATCH_MAX_ITEMS),
    splitViewBreakpointPx: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_SPLIT_VIEW_BREAKPOINT_PX),
    splitViewSourceMinPx: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_SPLIT_VIEW_SOURCE_MIN_PX),
    splitViewDiscussionMinPx: z
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_SPLIT_VIEW_DISCUSSION_MIN_PX)
  })
  .strict();

export const collaborationConnectionSchema = z
  .object({
    state: z.enum([
      "disconnected",
      "connecting",
      "live",
      "reconnecting",
      "unavailable",
      "access_revoked"
    ]),
    backendId: upstreamBackendIdSchema.nullable(),
    connectedAt: collaborationTimestampSchema.nullable(),
    retryAt: collaborationTimestampSchema.nullable(),
    reconnectAttempt: z
      .number()
      .int()
      .min(0)
      .max(COLLABORATION_RECONNECT_MAX_ATTEMPTS),
    protocolVersion: z.literal(COLLABORATION_CONTRACT_VERSION)
  })
  .strict();

export const collaborationSafeErrorSchema = z
  .object({
    code: z.enum([
      "invalid_input",
      "not_available",
      "permission_denied",
      "access_revoked",
      "conflict",
      "rate_limited",
      "offline",
      "temporarily_unavailable",
      "representation_pending",
      "history_expired",
      "internal_error"
    ]),
    userMessage: boundedRequiredUtf8(MAX_SAFE_ERROR_MESSAGE_BYTES),
    retryable: z.boolean(),
    retryAfterMs: z.number().int().min(0).max(300_000).nullable()
  })
  .strict()
  .superRefine((error, context) => {
    if (error.userMessage !== collaborationSafeErrorMessages[error.code]) {
      context.addIssue({
        code: "custom",
        path: ["userMessage"],
        message: "Safe error message must match its public error code"
      });
    }
  });

export const collaborationPersonSchema = z
  .object({
    id: z.uuid(),
    displayName: collaborationDisplayNameSchema,
    presence: z.enum(["available", "away", "offline"]),
    membershipState: z.enum(["enabled", "disabled"])
  })
  .strict();

export const collaborationWorkspaceAccessSchema = z
  .object({
    workspaceId: z.uuid(),
    userId: z.uuid(),
    access: z.enum(["disabled", "read", "write"]),
    version: positiveVersionSchema.nullable()
  })
  .strict()
  .superRefine((access, context) => {
    if (access.access !== "disabled" && access.version === null) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: "Enabled Workspace Access must have a version"
      });
    }
  });

const collaborationPersonManagementSchema = z
  .object({
    membershipId: z.uuid(),
    email: z
      .email()
      .max(320)
      .transform((value) => value.trim().toLowerCase()),
    role: z.enum(["owner", "admin", "member"]),
    status: z.enum(["invited", "enabled", "disabled"]),
    version: positiveVersionSchema,
    workspaceAccess: z.array(collaborationWorkspaceAccessSchema).max(250)
  })
  .strict();

const teamPresenceStatusKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

const collaborationTeamManualStatusSchema = z.union([
  z.enum(teamManualStatuses),
  teamPresenceStatusKeySchema.transform(() => "unknown" as const)
]);

export const collaborationTeamPresenceStatusCatalogueSchema = z
  .object({
    version: positiveVersionSchema,
    statuses: z
      .array(
        z
          .object({
            key: teamPresenceStatusKeySchema,
            label: z.string().trim().min(1).max(80)
          })
          .strict()
      )
      .min(1)
      .max(32)
  })
  .strict()
  .superRefine((catalogue, context) => {
    const keys = catalogue.statuses.map((status) => status.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["statuses"],
        message: "Team Presence status catalogue keys must be unique"
      });
    }
  });

export const collaborationTeamPersonSchema = collaborationPersonSchema
  .extend({
    teamPresence: z
      .object({
        mode: z.enum(["auto", "manual"]),
        manualStatus: collaborationTeamManualStatusSchema,
        activityLevel: z
          .enum(["active", "recently_active", "idle", "inactive"])
          .nullable(),
        lastActivityAt: collaborationTimestampSchema.nullable(),
        nextTransitionAt: collaborationTimestampSchema.nullable(),
        preferenceVersion: positiveVersionSchema
      })
      .strict(),
    management: collaborationPersonManagementSchema.optional()
  })
  .strict()
  .superRefine((person, context) => {
    if (
      person.management?.workspaceAccess.some(
        (access) => access.userId !== person.id
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["management", "workspaceAccess"],
        message: "Workspace Access must belong to the managed Team member"
      });
    }
  });

const participantSchema = collaborationPersonSchema.omit({ presence: true });

const distinctParticipantsSchema = z
  .array(participantSchema)
  .max(COLLABORATION_MAX_DM_PARTICIPANTS)
  .superRefine((participants, context) => {
    const ids = participants.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Participants must be distinct"
      });
    }
  });

const threadLifecycleSchema = z.enum([
  "active",
  "archived",
  "tombstoned",
  "purge_pending",
  "purged"
]);

const threadBaseShape = {
  id: z.uuid(),
  logicalId: z.uuid(),
  name: collaborationNameSchema.nullable(),
  topic: collaborationTopicDescriptionSchema.nullable(),
  version: positiveVersionSchema,
  lifecycle: threadLifecycleSchema,
  canPost: z.boolean(),
  latestSequence: nonNegativeSequenceSchema,
  unreadCount: nonNegativeSequenceSchema,
  lastReadMessageId: z.uuid().nullable(),
  lastReadSequence: nonNegativeSequenceSchema,
  createdAt: collaborationTimestampSchema,
  updatedAt: collaborationTimestampSchema,
  lastActivityAt: collaborationTimestampSchema,
  archivedAt: collaborationTimestampSchema.nullable()
} as const;

const personalThreadBaseShape = {
  ...threadBaseShape,
  scope: z.literal("personal"),
  ownerUserId: z.uuid()
} as const;

const teamThreadBaseShape = {
  ...threadBaseShape,
  scope: z.literal("team"),
  teamId: z.uuid()
} as const;

const notesToSelfThreadSchema = z
  .object({
    ...personalThreadBaseShape,
    kind: z.literal("notes_to_self"),
    name: z.null(),
    topic: z.null(),
    participants: distinctParticipantsSchema.length(1)
  })
  .strict()
  .superRefine((thread, context) => {
    if (thread.participants[0]?.id !== thread.ownerUserId) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "Notes-to-self participant must be the Personal owner"
      });
    }
  });

const personalChannelThreadSchema = z
  .object({
    ...personalThreadBaseShape,
    kind: z.literal("personal_channel"),
    name: collaborationNameSchema
  })
  .strict();

const workspaceChannelThreadSchema = z
  .object({
    ...teamThreadBaseShape,
    kind: z.literal("workspace_channel"),
    name: collaborationNameSchema,
    workspaceId: z.uuid()
  })
  .strict();

const directMessageThreadSchema = z
  .object({
    ...teamThreadBaseShape,
    kind: z.literal("dm"),
    name: z.null(),
    topic: z.null(),
    participants: distinctParticipantsSchema.length(2)
  })
  .strict();

const groupDirectMessageThreadSchema = z
  .object({
    ...teamThreadBaseShape,
    kind: z.literal("group_dm"),
    participants: distinctParticipantsSchema
      .min(3)
      .max(COLLABORATION_MAX_DM_PARTICIPANTS)
  })
  .strict();

const sharedSessionDiscussionThreadSchema = z
  .object({
    ...teamThreadBaseShape,
    kind: z.literal("shared_session_discussion"),
    workspaceId: z.uuid(),
    sharedLogicalMemoryId: z.uuid(),
    shareGrantId: z.uuid()
  })
  .strict();

export const collaborationThreadSchema = z.discriminatedUnion("kind", [
  notesToSelfThreadSchema,
  personalChannelThreadSchema,
  workspaceChannelThreadSchema,
  directMessageThreadSchema,
  groupDirectMessageThreadSchema,
  sharedSessionDiscussionThreadSchema
]);

export const collaborationMessageSchema = z
  .object({
    id: z.uuid(),
    clientMessageId: z.uuid().nullable().optional(),
    threadId: z.uuid(),
    scope: z.enum(["personal", "team"]),
    teamId: z.uuid().nullable(),
    sequence: z.number().int().safe().positive(),
    sender: participantSchema,
    senderKind: z.literal("user"),
    body: collaborationMessageBodySchema,
    createdAt: collaborationTimestampSchema,
    updatedAt: collaborationTimestampSchema,
    editedAt: z.null(),
    deletedAt: z.null(),
    delivery: z.enum(["queued", "sent", "failed"]),
    recipientStatus: z.enum(["sent", "delivered", "read"]).nullable(),
    failure: collaborationSafeErrorSchema.nullable()
  })
  .strict()
  .superRefine((message, context) => {
    if (
      (message.scope === "personal" && message.teamId !== null) ||
      (message.scope === "team" && message.teamId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["teamId"],
        message: "Message Team identity must match its scope"
      });
    }
    if (message.delivery !== "failed" && message.failure !== null) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "Only failed messages may carry a safe failure"
      });
    }
    if (message.delivery !== "sent" && message.recipientStatus !== null) {
      context.addIssue({
        code: "custom",
        path: ["recipientStatus"],
        message: "Only sent messages may carry a recipient status"
      });
    }
  });

const personalDurableSendAuthoritySchema = z
  .object({
    scope: z.literal("personal"),
    ownerUserId: z.uuid(),
    threadId: z.uuid()
  })
  .strict();

const teamDurableSendAuthoritySchema = z
  .object({
    scope: z.literal("team"),
    backendId: upstreamBackendIdSchema,
    principalUserId: z.uuid(),
    teamId: z.uuid(),
    workspaceId: z.uuid().nullable(),
    threadId: z.uuid()
  })
  .strict();

export const collaborationDurableSendAuthoritySchema = z.discriminatedUnion(
  "scope",
  [personalDurableSendAuthoritySchema, teamDurableSendAuthoritySchema]
);

export const collaborationDurableSendSchema = z
  .object({
    clientMessageId: z.uuid(),
    authority: collaborationDurableSendAuthoritySchema,
    body: collaborationMessageBodySchema.nullable(),
    localCreationOrder: z.number().int().safe().positive(),
    state: z.enum(["queued", "manual_retry", "failed", "sent"]),
    retryable: z.boolean(),
    removalSupported: z.literal(false),
    failure: collaborationSafeErrorSchema.nullable(),
    createdAt: collaborationTimestampSchema,
    updatedAt: collaborationTimestampSchema
  })
  .strict()
  .superRefine((send, context) => {
    if (
      (send.state === "queued" || send.state === "manual_retry") !==
      send.retryable
    ) {
      context.addIssue({
        code: "custom",
        path: ["retryable"],
        message: "Durable send retryability must match its state"
      });
    }
    if (
      (send.state === "queued" || send.state === "sent") &&
      send.failure !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "Queued and sent durable records cannot carry a failure"
      });
    }
    if (
      (send.state === "manual_retry" || send.state === "failed") &&
      send.failure === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "Failed durable records require a safe failure"
      });
    }
  });

export const collaborationReadStateSchema = z
  .object({
    threadId: z.uuid(),
    deliveredMessageId: z.uuid().nullable(),
    deliveredSequence: nonNegativeSequenceSchema,
    deliveredAt: collaborationTimestampSchema.nullable(),
    messageId: z.uuid().nullable(),
    sequence: nonNegativeSequenceSchema,
    readAt: collaborationTimestampSchema.nullable(),
    unreadCount: nonNegativeSequenceSchema,
    version: positiveVersionSchema,
    updatedAt: collaborationTimestampSchema
  })
  .strict()
  .superRefine((state, context) => {
    const deliveryIsEmpty =
      state.deliveredMessageId === null &&
      state.deliveredSequence === 0 &&
      state.deliveredAt === null;
    const deliveryIsComplete =
      state.deliveredMessageId !== null &&
      state.deliveredSequence > 0 &&
      state.deliveredAt !== null;
    if (!deliveryIsEmpty && !deliveryIsComplete) {
      context.addIssue({
        code: "custom",
        path: ["deliveredMessageId"],
        message: "Delivered receipt fields must be empty or complete"
      });
    }
    const readIsEmpty =
      state.messageId === null && state.sequence === 0 && state.readAt === null;
    const readIsComplete =
      state.messageId !== null && state.sequence > 0 && state.readAt !== null;
    if (!readIsEmpty && !readIsComplete) {
      context.addIssue({
        code: "custom",
        path: ["messageId"],
        message: "Read receipt fields must be empty or complete"
      });
    }
    if (state.deliveredSequence < state.sequence) {
      context.addIssue({
        code: "custom",
        path: ["deliveredSequence"],
        message: "Delivered sequence cannot trail the read sequence"
      });
    }
  });

export const collaborationMessageReceiptSchema = z
  .object({
    messageId: z.uuid(),
    recipientStatus: z.enum(["sent", "delivered", "read"])
  })
  .strict();

const pageMetadataShape = {
  snapshotRevision: collaborationRevisionSchema,
  olderCursor: collaborationOpaqueCursorSchema.nullable(),
  newerCursor: collaborationOpaqueCursorSchema.nullable(),
  hasOlder: z.boolean(),
  hasNewer: z.boolean()
} as const;

export const collaborationMessagePageSchema = z
  .object({
    ...pageMetadataShape,
    threadId: z.uuid(),
    items: z
      .array(collaborationMessageSchema)
      .max(COLLABORATION_HISTORY_PAGE_MAX_ITEMS)
  })
  .strict()
  .superRefine((page, context) => {
    if (page.items.some((message) => message.threadId !== page.threadId)) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Every message must belong to the page thread"
      });
    }
    for (let index = 1; index < page.items.length; index += 1) {
      if (page.items[index - 1]!.sequence >= page.items[index]!.sequence) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "sequence"],
          message: "Message page sequences must be strictly increasing"
        });
        break;
      }
    }
  });

export const sharedMemoryRepresentationSchema = z.enum([
  "memory_events",
  "lcm_leaves",
  "lcm_rollups",
  "curated_assertions"
]);

const distinctSharedMemoryRepresentationsSchema = z
  .array(sharedMemoryRepresentationSchema)
  .min(1)
  .max(4)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "Shared Memory representations must be distinct"
      });
    }
  });

export const sharedMemoryEventSourceKindSchema = z.enum([
  "user_message",
  "agent_message",
  "thought",
  "tool_call",
  "tool_result"
]);

const sharedMemoryEventSourceItemSchema = z
  .object({
    id: z.uuid(),
    sourceKind: sharedMemoryEventSourceKindSchema,
    occurredAt: collaborationTimestampSchema,
    body: boundedRequiredUtf8(MAX_SHARED_SOURCE_BODY_BYTES),
    actorName: collaborationDisplayNameSchema.nullable(),
    toolName: boundedCodePoints(COLLABORATION_NAME_MAX_CODE_POINTS).nullable(),
    toolCallId: boundedCodePoints(240).nullable(),
    approvalDecisionDisplay: approvalDecisionDisplaySchema.optional(),
    toolDisplay: personalDesktopToolDisplaySchema.optional()
  })
  .strict()
  .superRefine((item, context) => {
    if (item.approvalDecisionDisplay && item.sourceKind !== "agent_message") {
      context.addIssue({
        code: "custom",
        path: ["approvalDecisionDisplay"],
        message: "Auto approval display requires an agent message"
      });
    }
    if (
      item.toolDisplay &&
      item.sourceKind !== "tool_call" &&
      item.sourceKind !== "tool_result"
    ) {
      context.addIssue({
        code: "custom",
        path: ["toolDisplay"],
        message: "Tool display requires a tool source item"
      });
    }
  });

const sharedMemoryEventItemSchema = z
  .object({
    id: z.uuid(),
    representation: z.literal("memory_events"),
    sequence: z.number().int().safe().positive(),
    occurredAt: collaborationTimestampSchema,
    sourceItems: z.array(sharedMemoryEventSourceItemSchema).min(1).max(100)
  })
  .strict();

const sharedLcmItemSchema = z
  .object({
    id: z.uuid(),
    representation: z.enum(["lcm_leaves", "lcm_rollups"]),
    sequence: z.number().int().safe().positive(),
    occurredAt: collaborationTimestampSchema,
    summaryText: boundedRequiredUtf8(MAX_SHARED_SOURCE_BODY_BYTES),
    lexicalAnchors: z
      .array(z.string().min(1).max(120))
      .max(12)
      .refine((anchors) => new Set(anchors).size === anchors.length, {
        message: "LCM lexical anchors must be exact-deduplicated"
      }),
    sourceCount: z.number().int().safe().positive(),
    sourceRevision: collaborationRevisionSchema
  })
  .strict();

const sharedCuratedAssertionItemSchema = z
  .object({
    id: z.uuid(),
    representation: z.literal("curated_assertions"),
    sequence: z.number().int().safe().positive(),
    occurredAt: collaborationTimestampSchema,
    assertionText: boundedRequiredUtf8(MAX_SHARED_SOURCE_BODY_BYTES),
    topicTitle: boundedRequiredUtf8(MAX_SHARED_SOURCE_BODY_BYTES).nullable(),
    tags: z.array(z.string().min(1).max(120)).max(32),
    sourceCount: z.number().int().safe().positive(),
    sourceRevision: collaborationRevisionSchema
  })
  .strict();

export const sharedMemorySourceItemSchema = z.discriminatedUnion(
  "representation",
  [
    sharedMemoryEventItemSchema,
    sharedLcmItemSchema,
    sharedCuratedAssertionItemSchema
  ]
);

export const sharedMemorySessionSchema = z
  .object({
    id: z.uuid(),
    logicalMemoryId: z.uuid(),
    shareGrantId: z.uuid(),
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    owner: participantSchema,
    title: collaborationNameSchema,
    latestActivityAt: collaborationTimestampSchema,
    representation: sharedMemoryRepresentationSchema,
    representationState: z.enum(["current", "stale", "pending", "unavailable"]),
    liveState: z.enum(["live", "reconnecting", "ended"]),
    sourceState: z.enum([
      "ready",
      "loading",
      "unavailable",
      "permission_denied",
      "revoked"
    ]),
    sourceRevision: collaborationRevisionSchema.nullable(),
    companionThreadId: z.uuid(),
    unreadCompanionCount: nonNegativeSequenceSchema,
    version: positiveVersionSchema
  })
  .strict()
  .superRefine((session, context) => {
    if (session.id !== session.shareGrantId) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "Shared Session identity must match the Share Grant"
      });
    }
  });

export const sharedMemorySourcePageSchema = z
  .object({
    ...pageMetadataShape,
    sharedSessionId: z.uuid(),
    representation: sharedMemoryRepresentationSchema,
    items: z
      .array(sharedMemorySourceItemSchema)
      .max(COLLABORATION_SOURCE_PAGE_MAX_ITEMS)
  })
  .strict()
  .superRefine((page, context) => {
    if (
      page.items.some((item) => item.representation !== page.representation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Source items must match the selected representation"
      });
    }
    for (let index = 1; index < page.items.length; index += 1) {
      if (page.items[index - 1]!.sequence >= page.items[index]!.sequence) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "sequence"],
          message: "Shared source sequences must be strictly increasing"
        });
        break;
      }
    }
  });

export const collaborationSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal_memory") }).strict(),
  z.object({ kind: z.literal("notes_to_self") }).strict(),
  z
    .object({ kind: z.literal("personal_channel"), threadId: z.uuid() })
    .strict(),
  z.object({ kind: z.literal("team_people"), teamId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("workspace_channel"),
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      threadId: z.uuid()
    })
    .strict(),
  z
    .object({
      kind: z.literal("team_direct_message"),
      teamId: z.uuid(),
      threadId: z.uuid()
    })
    .strict(),
  z
    .object({
      kind: z.literal("workspace_shared_memory"),
      teamId: z.uuid(),
      workspaceId: z.uuid()
    })
    .strict(),
  z
    .object({
      kind: z.literal("shared_session"),
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      sharedSessionId: z.uuid()
    })
    .strict()
]);

export const isPersonalCollaborationSelection = (
  selection: z.infer<typeof collaborationSelectionSchema>
): boolean =>
  selection.kind === "personal_memory" ||
  selection.kind === "notes_to_self" ||
  selection.kind === "personal_channel";

export const isTeamCollaborationSelection = (
  selection: z.infer<typeof collaborationSelectionSchema>
): boolean => !isPersonalCollaborationSelection(selection);

const threadNavigationSchema = collaborationThreadSchema;

const workspaceNavigationSchema = z
  .object({
    id: z.uuid(),
    name: collaborationNameSchema,
    description: collaborationTopicDescriptionSchema.nullable(),
    access: z.enum(["read", "write"]),
    lifecycle: z.enum(["active", "archived", "purged"]),
    version: positiveVersionSchema,
    channels: z
      .array(workspaceChannelThreadSchema)
      .max(MAX_CHANNELS_PER_WORKSPACE),
    sharedMemory: z
      .array(sharedMemorySessionSchema)
      .max(MAX_SHARED_SESSIONS_PER_WORKSPACE)
  })
  .strict();

const teamNavigationSchema = z
  .object({
    id: z.uuid(),
    name: collaborationNameSchema,
    role: z.enum(["owner", "admin", "member"]),
    lifecycle: z.enum([
      "active",
      "suspended",
      "deletion_requested",
      "tombstoned",
      "purged"
    ]),
    unreadCount: nonNegativeSequenceSchema,
    membershipVersion: positiveVersionSchema.optional(),
    people: z.array(collaborationTeamPersonSchema).max(MAX_TEAM_PEOPLE),
    directMessages: z
      .array(
        z.union([directMessageThreadSchema, groupDirectMessageThreadSchema])
      )
      .max(MAX_DIRECT_MESSAGES_PER_TEAM),
    workspaces: z.array(workspaceNavigationSchema).max(MAX_WORKSPACES_PER_TEAM),
    version: positiveVersionSchema
  })
  .strict();

export const personalMemoryEntrySchema = z
  .object({
    id: z.uuid(),
    logicalMemoryId: z.uuid().nullable(),
    title: collaborationNameSchema,
    projectName: collaborationNameSchema.nullable(),
    updatedAt: collaborationTimestampSchema,
    preview: boundedOptionalUtf8(
      COLLABORATION_TOPIC_DESCRIPTION_MAX_UTF8_BYTES
    ),
    eventCount: nonNegativeSequenceSchema,
    hasSynchronizedRevision: z.boolean(),
    syncState: z.enum([
      "not_started",
      "paused",
      "processing",
      "partially_available",
      "ready",
      "stale",
      "failed",
      "revoked"
    ])
  })
  .strict();

const collaborationNavigationSchema = z
  .object({
    personalOwner: collaborationPersonSchema,
    teamPrincipal: collaborationPersonSchema.nullable(),
    personal: z
      .object({
        memory: z
          .array(personalMemoryEntrySchema)
          .max(MAX_PERSONAL_MEMORY_ENTRIES),
        notesToSelf: notesToSelfThreadSchema,
        channels: z
          .array(personalChannelThreadSchema)
          .max(MAX_PERSONAL_CHANNELS)
      })
      .strict(),
    teams: z.array(teamNavigationSchema).max(MAX_TEAMS_PER_SNAPSHOT)
  })
  .strict()
  .superRefine((navigation, context) => {
    if (
      navigation.personal.notesToSelf.ownerUserId !==
        navigation.personalOwner.id ||
      navigation.personal.channels.some(
        (thread) => thread.ownerUserId !== navigation.personalOwner.id
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["personal"],
        message: "Personal navigation must belong to the current User"
      });
    }
    const teamIds = navigation.teams.map(({ id }) => id);
    if (new Set(teamIds).size !== teamIds.length) {
      context.addIssue({
        code: "custom",
        path: ["teams"],
        message: "Team navigation entries must be distinct"
      });
    }
    if (navigation.teams.length > 0 && navigation.teamPrincipal === null) {
      context.addIssue({
        code: "custom",
        path: ["teamPrincipal"],
        message: "Team navigation requires an enrolled remote Team principal"
      });
    }
    if (navigation.teamPrincipal?.id === navigation.personalOwner.id) {
      context.addIssue({
        code: "custom",
        path: ["teamPrincipal", "id"],
        message:
          "The remote Team principal must be distinct from the local Personal owner"
      });
    }
    for (const [teamIndex, team] of navigation.teams.entries()) {
      if (
        navigation.teamPrincipal &&
        !team.people.some(
          (person) =>
            person.id === navigation.teamPrincipal!.id &&
            person.membershipState === "enabled"
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["teams", teamIndex, "people"],
          message: "Team navigation must include the enabled remote principal"
        });
      }
      if (team.directMessages.some((thread) => thread.teamId !== team.id)) {
        context.addIssue({
          code: "custom",
          path: ["teams", teamIndex, "directMessages"],
          message: "Direct messages must belong to their navigation Team"
        });
      }
      for (const [workspaceIndex, workspace] of team.workspaces.entries()) {
        if (
          workspace.channels.some(
            (thread) =>
              thread.teamId !== team.id || thread.workspaceId !== workspace.id
          ) ||
          workspace.sharedMemory.some(
            (session) =>
              session.teamId !== team.id || session.workspaceId !== workspace.id
          )
        ) {
          context.addIssue({
            code: "custom",
            path: ["teams", teamIndex, "workspaces", workspaceIndex],
            message: "Workspace resources must match their Team and Workspace"
          });
        }
      }
    }
  });

const emptyViewSchema = z.object({ kind: z.literal("empty") }).strict();
const personalMemoryViewSchema = z
  .object({
    kind: z.literal("personal_memory"),
    entries: z.array(personalMemoryEntrySchema).max(MAX_PERSONAL_MEMORY_ENTRIES)
  })
  .strict();
const threadViewSchema = z
  .object({
    kind: z.literal("thread"),
    thread: collaborationThreadSchema,
    messages: collaborationMessagePageSchema
  })
  .strict()
  .superRefine((view, context) => {
    if (view.thread.id !== view.messages.threadId) {
      context.addIssue({
        code: "custom",
        path: ["messages", "threadId"],
        message: "Message page must belong to the selected thread"
      });
    }
  });
const teamPeopleViewSchema = z
  .object({
    kind: z.literal("team_people"),
    teamId: z.uuid(),
    people: z.array(collaborationTeamPersonSchema).max(MAX_TEAM_PEOPLE)
  })
  .strict();
const sharedMemoryIndexViewSchema = z
  .object({
    kind: z.literal("shared_memory_index"),
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    sessions: z
      .array(sharedMemorySessionSchema)
      .max(MAX_SHARED_SESSIONS_PER_WORKSPACE)
  })
  .strict();
const sharedSessionViewSchema = z
  .object({
    kind: z.literal("shared_session"),
    session: sharedMemorySessionSchema,
    source: sharedMemorySourcePageSchema,
    companion: z
      .object({
        thread: sharedSessionDiscussionThreadSchema,
        messages: collaborationMessagePageSchema
      })
      .strict()
  })
  .strict()
  .superRefine((view, context) => {
    if (
      view.source.sharedSessionId !== view.session.id ||
      view.companion.thread.id !== view.session.companionThreadId ||
      view.companion.messages.threadId !== view.session.companionThreadId
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Shared source and companion data must match the selected session"
      });
    }
  });

export const collaborationViewSchema = z.union([
  emptyViewSchema,
  personalMemoryViewSchema,
  threadViewSchema,
  teamPeopleViewSchema,
  sharedMemoryIndexViewSchema,
  sharedSessionViewSchema
]);

export const collaborationSnapshotSchema = z
  .object({
    contractVersion: z.literal(COLLABORATION_CONTRACT_VERSION),
    snapshotRevision: collaborationRevisionSchema,
    generatedAt: collaborationTimestampSchema,
    connection: collaborationConnectionSchema,
    limits: collaborationLimitsSchema,
    teamPresenceStatusCatalogue:
      collaborationTeamPresenceStatusCatalogueSchema.default(() => ({
        version: teamPresenceStatusCatalogue.version,
        statuses: teamPresenceStatusCatalogue.statuses.map((status) => ({
          ...status
        }))
      })),
    outbox: z.array(collaborationDurableSendSchema).max(1_000).optional(),
    navigation: collaborationNavigationSchema,
    selection: collaborationSelectionSchema,
    view: collaborationViewSchema
  })
  .strict()
  .superRefine((snapshot, context) => {
    const { selection, view } = snapshot;
    if (view.kind === "empty") return;

    const valid =
      (selection.kind === "personal_memory" &&
        view.kind === "personal_memory") ||
      (selection.kind === "notes_to_self" &&
        view.kind === "thread" &&
        view.thread.kind === "notes_to_self") ||
      (selection.kind === "personal_channel" &&
        view.kind === "thread" &&
        view.thread.scope === "personal" &&
        view.thread.kind === "personal_channel" &&
        view.thread.id === selection.threadId) ||
      (selection.kind === "team_people" &&
        view.kind === "team_people" &&
        view.teamId === selection.teamId) ||
      (selection.kind === "workspace_channel" &&
        view.kind === "thread" &&
        view.thread.kind === "workspace_channel" &&
        view.thread.id === selection.threadId &&
        view.thread.teamId === selection.teamId &&
        view.thread.workspaceId === selection.workspaceId) ||
      (selection.kind === "team_direct_message" &&
        view.kind === "thread" &&
        (view.thread.kind === "dm" || view.thread.kind === "group_dm") &&
        view.thread.id === selection.threadId &&
        view.thread.teamId === selection.teamId) ||
      (selection.kind === "workspace_shared_memory" &&
        view.kind === "shared_memory_index" &&
        view.teamId === selection.teamId &&
        view.workspaceId === selection.workspaceId) ||
      (selection.kind === "shared_session" &&
        view.kind === "shared_session" &&
        view.session.id === selection.sharedSessionId &&
        view.session.teamId === selection.teamId &&
        view.session.workspaceId === selection.workspaceId);

    if (!valid) {
      context.addIssue({
        code: "custom",
        path: ["view"],
        message: "Selected view must match the active navigation selection"
      });
    }
  });

export const collaborationThreadReferenceSchema = z.discriminatedUnion(
  "scope",
  [
    z
      .object({
        scope: z.literal("personal"),
        threadId: z.uuid()
      })
      .strict(),
    z
      .object({
        scope: z.literal("team"),
        teamId: z.uuid(),
        threadId: z.uuid()
      })
      .strict()
  ]
);

export const sharedMemorySessionReferenceSchema = z
  .object({
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    sharedSessionId: z.uuid()
  })
  .strict();

export const collaborationActionGrantReferenceSchema = z
  .object({ id: z.uuid() })
  .strict();

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const normalizedEmailSchema = z
  .email()
  .max(320)
  .transform((value) => value.trim().toLowerCase());

const actionGrantIntent = <const TName extends string, T extends z.ZodRawShape>(
  intent: TName,
  inputShape: T
) =>
  z
    .object({
      intent: z.literal(intent),
      commandRequestId: z.uuid(),
      ...inputShape
    })
    .strict();

export const collaborationActionGrantIntentSchema = z.discriminatedUnion(
  "intent",
  [
    actionGrantIntent("collaboration.create_team", {
      name: collaborationNameSchema
    }),
    actionGrantIntent("collaboration.join_team", {
      invitation: boundedRequiredUtf8(MAX_INVITATION_BYTES)
    }),
    actionGrantIntent("collaboration.create_workspace", {
      teamId: z.uuid(),
      name: collaborationNameSchema,
      description: collaborationTopicDescriptionSchema.nullable()
    }),
    actionGrantIntent("collaboration.create_invitation", {
      teamId: z.uuid(),
      email: normalizedEmailSchema,
      role: z.enum(["owner", "admin", "member"]),
      defaultWorkspaceId: z.uuid(),
      defaultWorkspaceAccess: z.enum(["read", "write"]),
      ttlHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 30)
    }),
    actionGrantIntent("collaboration.revoke_invitation", {
      teamId: z.uuid(),
      invitationId: z.uuid(),
      expectedVersion: positiveVersionSchema
    }),
    actionGrantIntent("collaboration.update_member_role", {
      teamId: z.uuid(),
      userId: z.uuid(),
      role: z.enum(["owner", "admin", "member"]),
      expectedVersion: positiveVersionSchema
    }),
    actionGrantIntent("collaboration.disable_member", {
      teamId: z.uuid(),
      userId: z.uuid(),
      expectedVersion: positiveVersionSchema
    }),
    actionGrantIntent("collaboration.leave_team", {
      teamId: z.uuid(),
      expectedVersion: positiveVersionSchema
    }),
    actionGrantIntent("collaboration.archive_workspace", {
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      expectedVersion: positiveVersionSchema
    }),
    actionGrantIntent("collaboration.restore_workspace", {
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      expectedVersion: positiveVersionSchema
    }),
    actionGrantIntent("collaboration.set_workspace_access", {
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      userId: z.uuid(),
      access: z.enum(["disabled", "read", "write"]),
      expectedVersion: positiveVersionSchema.nullable()
    }),
    actionGrantIntent("collaboration.preview_shared_memory", {
      logicalMemoryId: z.uuid(),
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      representation: sharedMemoryRepresentationSchema,
      allowedRepresentations: distinctSharedMemoryRepresentationsSchema
    }),
    actionGrantIntent("collaboration.share_memory", {
      mutationId: z.uuid(),
      logicalGrantId: z.uuid(),
      consentId: z.uuid(),
      logicalMemoryId: z.uuid(),
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      mode: z.enum(["snapshot", "continuous"]),
      allowedRepresentations: distinctSharedMemoryRepresentationsSchema,
      selectedRepresentation: sharedMemoryRepresentationSchema,
      previewRevision: positiveVersionSchema,
      previewHash: sha256Schema,
      expiresAt: collaborationTimestampSchema.nullable()
    }),
    actionGrantIntent("collaboration.revoke_shared_memory", {
      mutationId: z.uuid(),
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      shareGrantId: z.uuid(),
      expectedGrantVersion: positiveVersionSchema,
      reasonCode: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[A-Za-z0-9_.:-]+$/)
    }),
    actionGrantIntent("collaboration.share_conversation_source", {
      mutationId: z.uuid(),
      teamId: z.uuid(),
      shareGrantId: z.uuid(),
      expectedVersion: z.number().int().safe().min(0),
      mode: z.enum(["snapshot", "continuous"])
    }),
    actionGrantIntent("collaboration.revoke_conversation_source", {
      mutationId: z.uuid(),
      teamId: z.uuid(),
      shareGrantId: z.uuid(),
      expectedVersion: positiveVersionSchema,
      reasonCode: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/)
    }),
    actionGrantIntent("collaboration.change_shared_memory_representation", {
      mutationId: z.uuid(),
      logicalMemoryId: z.uuid(),
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      shareGrantId: z.uuid(),
      consentId: z.uuid(),
      representation: sharedMemoryRepresentationSchema,
      expectedGrantVersion: positiveVersionSchema,
      mode: z.enum(["snapshot", "continuous"]),
      allowedRepresentations: distinctSharedMemoryRepresentationsSchema,
      previewRevision: positiveVersionSchema,
      previewHash: sha256Schema,
      expiresAt: collaborationTimestampSchema.nullable()
    }),
    actionGrantIntent("collaboration.managed_conversation_handoff", {
      executionId: z.uuid(),
      operationId: z.uuid(),
      targetDeviceId: z.uuid()
    }),
    actionGrantIntent("collaboration.managed_conversation_fork", {
      executionId: z.uuid(),
      operationId: z.uuid(),
      targetDeviceId: z.uuid(),
      reason: z.enum([
        "user_requested",
        "incompatible_provider",
        "origin_unavailable",
        "independent_work"
      ])
    })
  ]
);

const collaborationActionGrantStatusStateSchema = z.enum([
  "pending",
  "review_required",
  "approved",
  "consumed",
  "denied",
  "revoked",
  "expired",
  "canceled"
]);

export const collaborationApprovalTierSchema = z.enum([
  "direct",
  "native_review",
  "step_up"
]);

export const collaborationApprovalReviewSchema = z
  .object({
    version: z.literal(1),
    title: authoritativeApprovalCopy(160),
    description: authoritativeApprovalCopy(600),
    consequence: authoritativeApprovalCopy(600),
    confirmLabel: authoritativeApprovalCopy(80),
    details: z
      .array(
        z
          .object({
            label: authoritativeApprovalCopy(80),
            value: authoritativeApprovalCopy(320)
          })
          .strict()
      )
      .max(12)
  })
  .strict();

const actionGrantActivationUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => utf8Bytes(value) <= MAX_REMOTE_BACKEND_URL_BYTES)
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Activation URL is invalid"
      });
      return;
    }
    try {
      assertSecureHttpTransport(parsed, "Activation URL");
    } catch {
      context.addIssue({
        code: "custom",
        message: "Activation URL requires HTTPS except for loopback development"
      });
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      context.addIssue({
        code: "custom",
        message: "Activation URL shape is invalid"
      });
    }
  });

export const collaborationActionGrantStatusSchema = z
  .object({
    version: z.literal(1),
    actionGrant: collaborationActionGrantReferenceSchema,
    approvalTier: collaborationApprovalTierSchema,
    review: collaborationApprovalReviewSchema.nullable(),
    state: collaborationActionGrantStatusStateSchema,
    activationUrl: actionGrantActivationUrlSchema.nullable(),
    expiresAt: collaborationTimestampSchema
  })
  .strict()
  .superRefine((status, context) => {
    if ((status.approvalTier === "direct") !== (status.review === null)) {
      context.addIssue({
        code: "custom",
        path: ["review"],
        message:
          status.approvalTier === "direct"
            ? "Direct Action Grants must not carry confirmation copy"
            : "Reviewed Action Grants require authoritative confirmation copy"
      });
    }
    const browserPending = status.state === "pending";
    if (browserPending !== (status.activationUrl !== null)) {
      context.addIssue({
        code: "custom",
        path: ["activationUrl"],
        message: browserPending
          ? "Pending Action Grants require an activation URL"
          : "Terminal or approved Action Grants must not expose activation URLs"
      });
    }
    if (browserPending && status.approvalTier !== "step_up") {
      context.addIssue({
        code: "custom",
        path: ["approvalTier"],
        message: "Only Step-up Action Grants may await browser approval"
      });
    }
    if (
      (status.state === "review_required") !==
      (status.approvalTier === "native_review" &&
        status.state !== "approved" &&
        !["consumed", "denied", "revoked", "expired", "canceled"].includes(
          status.state
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message:
          "Native-review Action Grants must await an exact native decision"
      });
    }
  });

const oneTimeInvitationUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => utf8Bytes(value) <= MAX_INVITATION_BYTES)
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invitation URL is invalid"
      });
      return;
    }
    try {
      assertSecureHttpTransport(parsed, "Invitation URL");
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invitation URL requires HTTPS except for loopback development"
      });
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      context.addIssue({
        code: "custom",
        message: "Invitation URL shape is invalid"
      });
    }
  });

export const collaborationInvitationSchema = z
  .object({
    id: z.uuid(),
    teamId: z.uuid(),
    defaultWorkspaceId: z.uuid(),
    defaultWorkspaceAccess: z.enum(["read", "write"]),
    email: normalizedEmailSchema,
    role: z.enum(["owner", "admin", "member"]),
    lifecycle: z.enum(["pending", "accepted", "revoked", "expired"]),
    version: positiveVersionSchema,
    createdAt: collaborationTimestampSchema,
    expiresAt: collaborationTimestampSchema,
    acceptedAt: collaborationTimestampSchema.nullable(),
    revokedAt: collaborationTimestampSchema.nullable()
  })
  .strict();

export const collaborationInvitationPageSchema = z
  .object({
    teamId: z.uuid(),
    items: z
      .array(collaborationInvitationSchema)
      .max(COLLABORATION_HISTORY_PAGE_MAX_ITEMS),
    nextCursor: collaborationOpaqueCursorSchema.nullable()
  })
  .strict()
  .superRefine((page, context) => {
    if (page.items.some((invitation) => invitation.teamId !== page.teamId)) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Invitations must belong to the requested Team"
      });
    }
  });

export const collaborationMembershipSchema = z
  .object({
    id: z.uuid(),
    teamId: z.uuid(),
    userId: z.uuid(),
    displayName: collaborationDisplayNameSchema.nullable(),
    email: normalizedEmailSchema.nullable(),
    role: z.enum(["owner", "admin", "member"]),
    status: z.enum(["invited", "enabled", "disabled"]),
    version: positiveVersionSchema,
    createdAt: collaborationTimestampSchema,
    updatedAt: collaborationTimestampSchema,
    acceptedAt: collaborationTimestampSchema.nullable(),
    disabledAt: collaborationTimestampSchema.nullable()
  })
  .strict();

export const collaborationWorkspaceSchema = z
  .object({
    id: z.uuid(),
    teamId: z.uuid(),
    name: collaborationNameSchema,
    description: collaborationTopicDescriptionSchema.nullable(),
    lifecycle: z.enum(["active", "archived", "purge_pending", "purged"]),
    version: positiveVersionSchema,
    createdAt: collaborationTimestampSchema,
    updatedAt: collaborationTimestampSchema,
    archivedAt: collaborationTimestampSchema.nullable()
  })
  .strict();

export const sharedMemoryPreviewSchema = z
  .object({
    logicalMemoryId: z.uuid(),
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    representation: sharedMemoryRepresentationSchema,
    allowedRepresentations: distinctSharedMemoryRepresentationsSchema,
    previewRevision: positiveVersionSchema,
    sourceRevision: nonNegativeSequenceSchema,
    policyRevision: positiveVersionSchema,
    contentPolicyVersion: positiveVersionSchema,
    classifierVersion: positiveVersionSchema,
    redactedContentHash: sha256Schema,
    previewHash: sha256Schema,
    itemCount: z.number().int().safe().min(1),
    items: z
      .array(sharedMemorySourceItemSchema)
      .max(COLLABORATION_SOURCE_PAGE_MAX_ITEMS),
    nextCursor: collaborationOpaqueCursorSchema.nullable()
  })
  .strict()
  .superRefine((preview, context) => {
    if (!preview.allowedRepresentations.includes(preview.representation)) {
      context.addIssue({
        code: "custom",
        path: ["allowedRepresentations"],
        message: "Preview representation must be owner-authorized"
      });
    }
    if (
      preview.items.some(
        (item) => item.representation !== preview.representation
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Preview items must match the selected representation"
      });
    }
  });

export const sharedMemoryConsentSchema = z
  .object({
    id: z.uuid(),
    logicalMemoryId: z.uuid(),
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    mode: z.enum(["snapshot", "continuous"]),
    state: z.enum(["pending", "active", "paused", "revoked", "expired"]),
    version: positiveVersionSchema,
    allowedRepresentations: distinctSharedMemoryRepresentationsSchema,
    selectedRepresentation: sharedMemoryRepresentationSchema,
    previewRevision: positiveVersionSchema,
    previewHash: sha256Schema,
    sourceRevision: nonNegativeSequenceSchema,
    createdAt: collaborationTimestampSchema,
    updatedAt: collaborationTimestampSchema,
    activatedAt: collaborationTimestampSchema.nullable(),
    revokedAt: collaborationTimestampSchema.nullable()
  })
  .strict()
  .superRefine((consent, context) => {
    if (
      !consent.allowedRepresentations.includes(consent.selectedRepresentation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedRepresentation"],
        message: "Selected representation must be consented"
      });
    }
  });

export const sharedMemoryGrantSchema = z
  .object({
    id: z.uuid(),
    logicalGrantId: z.uuid(),
    logicalMemoryId: z.uuid(),
    ownerUserId: z.uuid().nullable(),
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    consentId: z.uuid(),
    ownerAllowedRepresentations: distinctSharedMemoryRepresentationsSchema,
    activeRepresentation: sharedMemoryRepresentationSchema.nullable(),
    representationPolicyRevision: positiveVersionSchema,
    sourceRevision: nonNegativeSequenceSchema,
    grantVersion: positiveVersionSchema,
    lifecycle: z.enum([
      "active",
      "unavailable",
      "revoked",
      "tombstoned",
      "purge_pending",
      "purged"
    ]),
    createdAt: collaborationTimestampSchema,
    updatedAt: collaborationTimestampSchema,
    revokedAt: collaborationTimestampSchema.nullable(),
    companionThreadId: z.uuid()
  })
  .strict();

const commandBaseShape = {
  contractVersion: z.literal(COLLABORATION_CONTRACT_VERSION),
  requestId: z.uuid()
} as const;

const command = <const TName extends string, T extends z.ZodRawShape>(
  name: TName,
  inputShape: T
) =>
  z
    .object({
      ...commandBaseShape,
      command: z.literal(name),
      input: z.object(inputShape).strict()
    })
    .strict();

const expectedVersionInputShape = { expectedVersion: positiveVersionSchema };

export const collaborationRendererCommandSchema = z
  .discriminatedUnion("command", [
    command("collaboration.load", {
      forceRemoteNavigation: z.boolean().optional()
    }),
    command("collaboration.select", {
      selection: collaborationSelectionSchema,
      navigationIntent: z.enum(["foreground", "prewarm"]).optional()
    }),
    command("collaboration.connect_backend", {
      remoteUrl: collaborationRemoteBackendUrlSchema
    }),
    command("collaboration.reconnect_backend", {}),
    command("collaboration.disconnect_backend", {}),
    command("collaboration.request_action_grant", {
      intent: collaborationActionGrantIntentSchema
    }),
    command("collaboration.await_action_grant", {
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.confirm_action_grant", {
      actionGrant: collaborationActionGrantReferenceSchema,
      decision: z.enum(["approve", "cancel"])
    }),
    command("collaboration.cancel_action_grant", {
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.create_team", {
      name: collaborationNameSchema,
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.join_team", {
      invitation: boundedRequiredUtf8(MAX_INVITATION_BYTES),
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.create_workspace", {
      teamId: z.uuid(),
      name: collaborationNameSchema,
      description: collaborationTopicDescriptionSchema.nullable(),
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.create_notes_to_self", {}),
    command("collaboration.create_personal_channel", {
      name: collaborationNameSchema,
      topic: collaborationTopicDescriptionSchema.nullable()
    }),
    command("collaboration.create_workspace_channel", {
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      name: collaborationNameSchema,
      topic: collaborationTopicDescriptionSchema.nullable()
    }),
    command("collaboration.start_direct_message", {
      teamId: z.uuid(),
      participantUserId: z.uuid()
    }),
    command("collaboration.start_group_direct_message", {
      teamId: z.uuid(),
      participantUserIds: distinctUuidArray(
        2,
        COLLABORATION_MAX_DM_PARTICIPANTS - 1
      )
    }),
    command("collaboration.set_team_presence", {
      teamId: z.uuid(),
      mode: z.enum(["auto", "manual"]),
      manualStatus: z.enum(["available", "do_not_disturb", "out_of_office"]),
      expectedVersion: positiveVersionSchema
    }),
    command("collaboration.report_team_activity", {
      teamIds: distinctUuidArray(1, 50)
    }),
    command("collaboration.rename_thread", {
      thread: collaborationThreadReferenceSchema,
      name: collaborationNameSchema,
      ...expectedVersionInputShape
    }),
    command("collaboration.update_thread_topic", {
      thread: collaborationThreadReferenceSchema,
      topic: collaborationTopicDescriptionSchema.nullable(),
      ...expectedVersionInputShape
    }),
    command("collaboration.archive_thread", {
      thread: collaborationThreadReferenceSchema,
      ...expectedVersionInputShape
    }),
    command("collaboration.restore_thread", {
      thread: collaborationThreadReferenceSchema,
      ...expectedVersionInputShape
    }),
    command("collaboration.send_message", {
      thread: collaborationThreadReferenceSchema,
      clientMessageId: z.uuid(),
      body: collaborationMessageBodySchema
    }),
    command("collaboration.retry_message", {
      thread: collaborationThreadReferenceSchema,
      clientMessageId: z.uuid(),
      body: collaborationMessageBodySchema
    }),
    command("collaboration.mark_read", {
      thread: collaborationThreadReferenceSchema,
      messageId: z.uuid()
    }),
    command("collaboration.mark_delivered", {
      thread: collaborationThreadReferenceSchema,
      messageId: z.uuid()
    }),
    command("collaboration.load_message_page", {
      thread: collaborationThreadReferenceSchema,
      direction: z.enum(["older", "newer"]),
      cursor: collaborationOpaqueCursorSchema.nullable(),
      limit: z.number().int().min(1).max(COLLABORATION_HISTORY_PAGE_MAX_ITEMS)
    }),
    command("collaboration.load_shared_source_page", {
      sharedSession: sharedMemorySessionReferenceSchema,
      direction: z.enum(["older", "newer"]),
      cursor: collaborationOpaqueCursorSchema.nullable(),
      limit: z.number().int().min(1).max(COLLABORATION_SOURCE_PAGE_MAX_ITEMS)
    }),
    command("collaboration.create_invitation", {
      teamId: z.uuid(),
      email: normalizedEmailSchema,
      role: z.enum(["owner", "admin", "member"]),
      defaultWorkspaceId: z.uuid(),
      defaultWorkspaceAccess: z.enum(["read", "write"]),
      ttlHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 30),
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.list_invitations", {
      teamId: z.uuid(),
      includeRevoked: z.boolean(),
      cursor: collaborationOpaqueCursorSchema.nullable(),
      limit: z.number().int().min(1).max(COLLABORATION_HISTORY_PAGE_MAX_ITEMS)
    }),
    command("collaboration.revoke_invitation", {
      teamId: z.uuid(),
      invitationId: z.uuid(),
      expectedVersion: positiveVersionSchema,
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.update_member_role", {
      teamId: z.uuid(),
      userId: z.uuid(),
      role: z.enum(["owner", "admin", "member"]),
      expectedVersion: positiveVersionSchema,
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.disable_member", {
      teamId: z.uuid(),
      userId: z.uuid(),
      expectedVersion: positiveVersionSchema,
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.leave_team", {
      teamId: z.uuid(),
      expectedVersion: positiveVersionSchema,
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.archive_workspace", {
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      expectedVersion: positiveVersionSchema,
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.restore_workspace", {
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      expectedVersion: positiveVersionSchema,
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.set_workspace_access", {
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      userId: z.uuid(),
      access: z.enum(["disabled", "read", "write"]),
      expectedVersion: positiveVersionSchema.nullable(),
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.list_owned_shared_memory_grants", {
      logicalMemoryId: z.uuid()
    }),
    command("collaboration.prepare_shared_memory_source", {
      sessionId: z.uuid(),
      consentedAt: collaborationTimestampSchema
    }),
    command("collaboration.pause_shared_memory_sync", {
      sessionId: z.uuid()
    }),
    command("collaboration.resume_shared_memory_sync", {
      sessionId: z.uuid()
    }),
    command("collaboration.revoke_shared_memory_sync", {
      sessionId: z.uuid()
    }),
    command("collaboration.preview_shared_memory", {
      logicalMemoryId: z.uuid(),
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      representation: sharedMemoryRepresentationSchema,
      allowedRepresentations: distinctSharedMemoryRepresentationsSchema,
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.load_shared_memory_preview_page", {
      previewHash: sha256Schema,
      cursor: collaborationOpaqueCursorSchema,
      limit: z.number().int().min(1).max(COLLABORATION_SOURCE_PAGE_MAX_ITEMS)
    }),
    command("collaboration.share_memory", {
      mutationId: z.uuid(),
      logicalGrantId: z.uuid(),
      consentId: z.uuid(),
      logicalMemoryId: z.uuid(),
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      mode: z.enum(["snapshot", "continuous"]),
      allowedRepresentations: distinctSharedMemoryRepresentationsSchema,
      selectedRepresentation: sharedMemoryRepresentationSchema,
      previewRevision: positiveVersionSchema,
      previewHash: sha256Schema,
      expiresAt: collaborationTimestampSchema.nullable(),
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.revoke_shared_memory", {
      mutationId: z.uuid(),
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      shareGrantId: z.uuid(),
      expectedGrantVersion: positiveVersionSchema,
      reasonCode: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[A-Za-z0-9_.:-]+$/),
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.change_shared_memory_representation", {
      mutationId: z.uuid(),
      logicalMemoryId: z.uuid(),
      teamId: z.uuid(),
      workspaceId: z.uuid(),
      shareGrantId: z.uuid(),
      consentId: z.uuid(),
      representation: sharedMemoryRepresentationSchema,
      expectedGrantVersion: positiveVersionSchema,
      mode: z.enum(["snapshot", "continuous"]),
      allowedRepresentations: distinctSharedMemoryRepresentationsSchema,
      previewRevision: positiveVersionSchema,
      previewHash: sha256Schema,
      expiresAt: collaborationTimestampSchema.nullable(),
      actionGrant: collaborationActionGrantReferenceSchema
    }),
    command("collaboration.subscribe", {
      scope: z.discriminatedUnion("scope", [
        z.object({ scope: z.literal("personal") }).strict(),
        z
          .object({
            scope: z.literal("team"),
            teamId: z.uuid()
          })
          .strict()
      ])
    }),
    command("collaboration.unsubscribe", { subscriptionId: z.uuid() }),
    command("collaboration.acknowledge_delivery", {
      subscriptionId: z.uuid(),
      deliveryId: collaborationDeliveryIdSchema,
      eventId: z.uuid().nullable(),
      expectedSubscriptionVersion: positiveVersionSchema
    })
  ])
  .superRefine((rendererCommand, context) => {
    if (
      rendererCommand.command === "collaboration.preview_shared_memory" &&
      !rendererCommand.input.allowedRepresentations.includes(
        rendererCommand.input.representation
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["input", "representation"],
        message: "Preview representation must be owner-authorized"
      });
    }
  });

export const collaborationSubscriptionSchema = z
  .object({
    id: z.uuid(),
    scope: z.discriminatedUnion("scope", [
      z.object({ scope: z.literal("personal") }).strict(),
      z.object({ scope: z.literal("team"), teamId: z.uuid() }).strict()
    ]),
    state: z.enum([
      "awaiting_snapshot_ack",
      "active",
      "requires_snapshot",
      "revoked",
      "expired"
    ]),
    version: positiveVersionSchema,
    expiresAt: collaborationTimestampSchema
  })
  .strict();

const successResultBaseShape = {
  contractVersion: z.literal(COLLABORATION_CONTRACT_VERSION),
  requestId: z.uuid(),
  ok: z.literal(true)
} as const;

const successResult = <const TName extends string, T extends z.ZodType>(
  commandName: TName,
  dataSchema: T
) =>
  z
    .object({
      ...successResultBaseShape,
      command: z.literal(commandName),
      data: dataSchema
    })
    .strict();

const emptyResultDataSchema = z.object({}).strict();

const directSnapshotResultCommands = [
  "collaboration.load",
  "collaboration.select",
  "collaboration.reconnect_backend",
  "collaboration.disconnect_backend"
] as const;

const createdResourceSnapshotResultCommands = [
  "collaboration.create_team",
  "collaboration.join_team",
  "collaboration.create_workspace"
] as const;

const connectBackendSnapshotResultCommand =
  "collaboration.connect_backend" as const;

export const collaborationSnapshotResultCommands = [
  ...directSnapshotResultCommands,
  connectBackendSnapshotResultCommand,
  ...createdResourceSnapshotResultCommands
] as const;

const collaborationSnapshotResultCommandSet = new Set<string>(
  collaborationSnapshotResultCommands
);

export const collaborationCommandReturnsSnapshot = (
  commandName: string
): boolean => collaborationSnapshotResultCommandSet.has(commandName);

const threadResultCommands = [
  "collaboration.create_notes_to_self",
  "collaboration.create_personal_channel",
  "collaboration.create_workspace_channel",
  "collaboration.start_direct_message",
  "collaboration.start_group_direct_message",
  "collaboration.rename_thread",
  "collaboration.update_thread_topic",
  "collaboration.archive_thread",
  "collaboration.restore_thread"
] as const;

const snapshotSuccessSchemas = [
  ...directSnapshotResultCommands,
  ...createdResourceSnapshotResultCommands
].map((name) =>
  successResult(
    name,
    z.object({ snapshot: collaborationSnapshotSchema }).strict()
  )
);
const threadSuccessSchemas = threadResultCommands.map((name) =>
  successResult(name, z.object({ thread: collaborationThreadSchema }).strict())
);

const commandNameSchema = z.enum([
  ...collaborationSnapshotResultCommands,
  "collaboration.request_action_grant",
  "collaboration.await_action_grant",
  "collaboration.confirm_action_grant",
  "collaboration.cancel_action_grant",
  ...threadResultCommands,
  "collaboration.send_message",
  "collaboration.retry_message",
  "collaboration.mark_read",
  "collaboration.mark_delivered",
  "collaboration.load_message_page",
  "collaboration.load_shared_source_page",
  "collaboration.create_invitation",
  "collaboration.list_invitations",
  "collaboration.revoke_invitation",
  "collaboration.update_member_role",
  "collaboration.disable_member",
  "collaboration.leave_team",
  "collaboration.archive_workspace",
  "collaboration.restore_workspace",
  "collaboration.set_workspace_access",
  "collaboration.set_team_presence",
  "collaboration.report_team_activity",
  "collaboration.list_owned_shared_memory_grants",
  "collaboration.prepare_shared_memory_source",
  "collaboration.pause_shared_memory_sync",
  "collaboration.resume_shared_memory_sync",
  "collaboration.revoke_shared_memory_sync",
  "collaboration.preview_shared_memory",
  "collaboration.load_shared_memory_preview_page",
  "collaboration.share_memory",
  "collaboration.revoke_shared_memory",
  "collaboration.change_shared_memory_representation",
  "collaboration.subscribe",
  "collaboration.unsubscribe",
  "collaboration.acknowledge_delivery"
]);

const failureResultSchema = z
  .object({
    contractVersion: z.literal(COLLABORATION_CONTRACT_VERSION),
    requestId: z.uuid(),
    command: commandNameSchema,
    ok: z.literal(false),
    error: collaborationSafeErrorSchema
  })
  .strict();

export const collaborationCommandResultSchema = z.union([
  ...snapshotSuccessSchemas,
  ...threadSuccessSchemas,
  successResult(
    connectBackendSnapshotResultCommand,
    z
      .object({
        backend: collaborationBackendIdentitySchema,
        snapshot: collaborationSnapshotSchema
      })
      .strict()
      .superRefine((data, context) => {
        if (data.snapshot.connection.backendId !== data.backend.id) {
          context.addIssue({
            code: "custom",
            path: ["snapshot", "connection", "backendId"],
            message: "Connected snapshot must identify the canonical backend"
          });
        }
      })
  ),
  successResult(
    "collaboration.request_action_grant",
    z.object({ status: collaborationActionGrantStatusSchema }).strict()
  ),
  successResult(
    "collaboration.await_action_grant",
    z.object({ status: collaborationActionGrantStatusSchema }).strict()
  ),
  z
    .object({
      ...successResultBaseShape,
      command: z.enum([
        "collaboration.confirm_action_grant",
        "collaboration.cancel_action_grant"
      ]),
      data: z.object({ status: collaborationActionGrantStatusSchema }).strict()
    })
    .strict(),
  successResult(
    "collaboration.send_message",
    z.union([
      z.object({ durableSend: collaborationDurableSendSchema }).strict(),
      z.object({ message: collaborationMessageSchema }).strict()
    ])
  ),
  successResult(
    "collaboration.retry_message",
    z.union([
      z.object({ durableSend: collaborationDurableSendSchema }).strict(),
      z.object({ message: collaborationMessageSchema }).strict()
    ])
  ),
  successResult(
    "collaboration.mark_read",
    z.object({ readState: collaborationReadStateSchema }).strict()
  ),
  successResult(
    "collaboration.mark_delivered",
    z.object({ readState: collaborationReadStateSchema }).strict()
  ),
  successResult(
    "collaboration.load_message_page",
    z.object({ page: collaborationMessagePageSchema }).strict()
  ),
  successResult(
    "collaboration.load_shared_source_page",
    z.object({ page: sharedMemorySourcePageSchema }).strict()
  ),
  successResult(
    "collaboration.create_invitation",
    z
      .object({
        invitation: collaborationInvitationSchema,
        invitationUrl: oneTimeInvitationUrlSchema
      })
      .strict()
  ),
  successResult(
    "collaboration.list_invitations",
    z.object({ page: collaborationInvitationPageSchema }).strict()
  ),
  successResult(
    "collaboration.revoke_invitation",
    z.object({ invitation: collaborationInvitationSchema }).strict()
  ),
  successResult(
    "collaboration.update_member_role",
    z.object({ membership: collaborationMembershipSchema }).strict()
  ),
  successResult(
    "collaboration.disable_member",
    z.object({ membership: collaborationMembershipSchema }).strict()
  ),
  successResult(
    "collaboration.leave_team",
    z.object({ membership: collaborationMembershipSchema }).strict()
  ),
  successResult(
    "collaboration.archive_workspace",
    z.object({ workspace: collaborationWorkspaceSchema }).strict()
  ),
  successResult(
    "collaboration.restore_workspace",
    z.object({ workspace: collaborationWorkspaceSchema }).strict()
  ),
  successResult(
    "collaboration.set_workspace_access",
    z.object({ access: collaborationWorkspaceAccessSchema }).strict()
  ),
  successResult(
    "collaboration.set_team_presence",
    z.object({ person: collaborationTeamPersonSchema }).strict()
  ),
  successResult(
    "collaboration.report_team_activity",
    z.object({ acceptedTeamIds: z.array(z.uuid()).max(50) }).strict()
  ),
  successResult(
    "collaboration.list_owned_shared_memory_grants",
    z.object({ grants: z.array(sharedMemoryGrantSchema).max(250) }).strict()
  ),
  successResult(
    "collaboration.prepare_shared_memory_source",
    z.object({ entry: personalMemoryEntrySchema }).strict()
  ),
  successResult(
    "collaboration.pause_shared_memory_sync",
    z.object({ entry: personalMemoryEntrySchema }).strict()
  ),
  successResult(
    "collaboration.resume_shared_memory_sync",
    z.object({ entry: personalMemoryEntrySchema }).strict()
  ),
  successResult(
    "collaboration.revoke_shared_memory_sync",
    z.object({ entry: personalMemoryEntrySchema }).strict()
  ),
  successResult(
    "collaboration.preview_shared_memory",
    z.object({ preview: sharedMemoryPreviewSchema }).strict()
  ),
  successResult(
    "collaboration.load_shared_memory_preview_page",
    z.object({ preview: sharedMemoryPreviewSchema }).strict()
  ),
  successResult(
    "collaboration.share_memory",
    z.object({ grant: sharedMemoryGrantSchema }).strict()
  ),
  successResult(
    "collaboration.revoke_shared_memory",
    z.object({ grant: sharedMemoryGrantSchema }).strict()
  ),
  successResult(
    "collaboration.change_shared_memory_representation",
    z.object({ grant: sharedMemoryGrantSchema }).strict()
  ),
  successResult(
    "collaboration.subscribe",
    z.object({ subscription: collaborationSubscriptionSchema }).strict()
  ),
  successResult("collaboration.unsubscribe", emptyResultDataSchema),
  successResult(
    "collaboration.acknowledge_delivery",
    z
      .object({
        subscriptionId: z.uuid(),
        acknowledgedEventId: z.uuid().nullable(),
        subscriptionVersion: positiveVersionSchema
      })
      .strict()
  ),
  failureResultSchema
]);

const realtimeResourceSchema = z
  .object({
    scope: z.enum(["personal", "team"]),
    teamId: z.uuid().nullable(),
    workspaceId: z.uuid().nullable(),
    threadId: z.uuid().nullable(),
    messageId: z.uuid().nullable(),
    sharedSessionId: z.uuid().nullable(),
    shareGrantId: z.uuid().nullable()
  })
  .strict()
  .superRefine((resource, context) => {
    if (
      (resource.scope === "personal" && resource.teamId !== null) ||
      (resource.scope === "team" && resource.teamId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["teamId"],
        message: "Realtime resource Team identity must match its scope"
      });
    }
  });

export const collaborationRendererUpdateSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("navigation_snapshot"),
      navigation: collaborationNavigationSchema,
      selection: collaborationSelectionSchema,
      view: collaborationViewSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("thread_upserted"),
      thread: threadNavigationSchema
    })
    .strict(),
  z.object({ type: z.literal("thread_removed"), threadId: z.uuid() }).strict(),
  z
    .object({
      type: z.literal("message_created"),
      message: collaborationMessageSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("receipt_state_updated"),
      readState: collaborationReadStateSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("message_receipts_updated"),
      threadId: z.uuid(),
      receipts: z
        .array(collaborationMessageReceiptSchema)
        .max(COLLABORATION_RENDERED_ROW_MAX_COUNT)
    })
    .strict(),
  z
    .object({
      type: z.literal("team_person_upserted"),
      teamId: z.uuid(),
      person: collaborationTeamPersonSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("shared_session_upserted"),
      session: sharedMemorySessionSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("shared_session_removed"),
      sharedSessionId: z.uuid()
    })
    .strict(),
  z
    .object({
      type: z.literal("personal_memory_upserted"),
      entry: personalMemoryEntrySchema
    })
    .strict(),
  z
    .object({
      type: z.literal("managed_conversation_upserted"),
      execution: z
        .object({
          id: z.uuid(),
          projectId: z.string().trim().min(1).max(2_048),
          provider: z.literal("codex"),
          state: z.enum([
            "starting",
            "running",
            "reconciling",
            "quiesce_requested",
            "quiesced",
            "stopping",
            "stopped",
            "failed",
            "fenced"
          ]),
          stateVersion: positiveVersionSchema,
          executionGeneration: positiveVersionSchema,
          logicalSessionId: z.uuid().nullable(),
          sessionId: z.uuid().nullable(),
          providerThreadId: z.string().trim().min(1).max(2_048).nullable(),
          providerCliVersion: z.string().trim().min(1).max(255).nullable(),
          lastErrorCode: z.string().trim().min(1).max(120).nullable(),
          createdAt: collaborationTimestampSchema,
          updatedAt: collaborationTimestampSchema,
          startedAt: collaborationTimestampSchema.nullable(),
          quiescedAt: collaborationTimestampSchema.nullable(),
          stoppedAt: collaborationTimestampSchema.nullable()
        })
        .strict()
    })
    .strict()
]);

export const collaborationRealtimeEventFamilySchema = z.enum([
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

const personalRealtimeSnapshotSchema = z
  .object({
    scope: z.literal("personal"),
    snapshotRevision: collaborationRevisionSchema,
    personalOwner: collaborationNavigationSchema.shape.personalOwner,
    personal: collaborationNavigationSchema.shape.personal,
    selection: collaborationSelectionSchema,
    view: collaborationViewSchema
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.selection.kind !== "personal_memory" &&
      snapshot.selection.kind !== "notes_to_self" &&
      snapshot.selection.kind !== "personal_channel"
    ) {
      context.addIssue({
        code: "custom",
        path: ["selection"],
        message: "Personal realtime snapshot requires a Personal selection"
      });
    }
  });

const teamRealtimeSnapshotSchema = z
  .object({
    scope: z.literal("team"),
    teamId: z.uuid(),
    snapshotRevision: collaborationRevisionSchema,
    teamPrincipal: collaborationPersonSchema,
    team: teamNavigationSchema,
    selection: collaborationSelectionSchema,
    view: collaborationViewSchema
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.team.id !== snapshot.teamId) {
      context.addIssue({
        code: "custom",
        path: ["team", "id"],
        message: "Realtime Team snapshot must match its subscription scope"
      });
    }
    if (
      !snapshot.team.people.some(
        (person) =>
          person.id === snapshot.teamPrincipal.id &&
          person.membershipState === "enabled"
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["teamPrincipal"],
        message: "Realtime Team snapshot requires its enabled remote principal"
      });
    }
    if (
      !("teamId" in snapshot.selection) ||
      snapshot.selection.teamId !== snapshot.teamId
    ) {
      context.addIssue({
        code: "custom",
        path: ["selection"],
        message: "Realtime selection must match its subscription Team"
      });
    }
  });

export const collaborationRealtimeSnapshotSchema = z.discriminatedUnion(
  "scope",
  [personalRealtimeSnapshotSchema, teamRealtimeSnapshotSchema]
);

const realtimeSnapshotDeliverySchema = z
  .object({
    contractVersion: z.literal(COLLABORATION_CONTRACT_VERSION),
    type: z.literal("snapshot"),
    subscription: collaborationSubscriptionSchema,
    deliveryId: collaborationDeliveryIdSchema,
    eventId: z.null(),
    snapshot: collaborationRealtimeSnapshotSchema
  })
  .strict()
  .superRefine((delivery, context) => {
    if (
      delivery.subscription.scope.scope !== delivery.snapshot.scope ||
      (delivery.snapshot.scope === "team" &&
        (delivery.subscription.scope.scope !== "team" ||
          delivery.subscription.scope.teamId !== delivery.snapshot.teamId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["snapshot", "scope"],
        message: "Realtime snapshot must match its subscription"
      });
    }
  });

const realtimeUpdateDeliverySchema = z
  .object({
    contractVersion: z.literal(COLLABORATION_CONTRACT_VERSION),
    type: z.literal("update"),
    subscriptionId: z.uuid(),
    deliveryId: collaborationDeliveryIdSchema,
    eventId: z.uuid(),
    occurredAt: collaborationTimestampSchema,
    family: collaborationRealtimeEventFamilySchema,
    resource: realtimeResourceSchema,
    update: collaborationRendererUpdateSchema
  })
  .strict()
  .superRefine((delivery, context) => {
    const { family, resource, update } = delivery;
    const allowedUpdateTypes: Record<
      z.infer<typeof collaborationRealtimeEventFamilySchema>,
      ReadonlySet<z.infer<typeof collaborationRendererUpdateSchema>["type"]>
    > = {
      team_lifecycle: new Set(["navigation_snapshot"]),
      team_membership_access: new Set(["navigation_snapshot"]),
      team_presence_changed: new Set(["team_person_upserted"]),
      workspace_lifecycle_access: new Set(["navigation_snapshot"]),
      thread_lifecycle: new Set([
        "thread_upserted",
        "thread_removed",
        "shared_session_upserted"
      ]),
      message_created: new Set(["message_created"]),
      receipt_state_updated: new Set([
        "receipt_state_updated",
        "message_receipts_updated"
      ]),
      share_grant_lifecycle: new Set([
        "shared_session_upserted",
        "shared_session_removed"
      ]),
      representation_changed: new Set([
        "shared_session_upserted",
        "shared_session_removed"
      ]),
      memory_event_available: new Set([
        "shared_session_upserted",
        "shared_session_removed"
      ]),
      lcm_leaf_available: new Set([
        "shared_session_upserted",
        "shared_session_removed"
      ]),
      lcm_rollup_available: new Set([
        "shared_session_upserted",
        "shared_session_removed"
      ]),
      shared_session_discussion_activity: new Set([
        "message_created",
        "receipt_state_updated",
        "thread_upserted"
      ]),
      personal_memory_changed: new Set(["personal_memory_upserted"]),
      managed_conversation_changed: new Set(["managed_conversation_upserted"]),
      access_revoked: new Set(["shared_session_removed"])
    };

    if (!allowedUpdateTypes[family].has(update.type)) {
      context.addIssue({
        code: "custom",
        path: ["update", "type"],
        message: "Realtime update does not match its event family"
      });
      return;
    }

    if (
      update.type === "personal_memory_upserted" &&
      (resource.scope !== "personal" ||
        resource.teamId !== null ||
        resource.workspaceId !== null ||
        resource.threadId !== null ||
        resource.messageId !== null ||
        resource.sharedSessionId !== null ||
        resource.shareGrantId !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resource"],
        message: "Personal Memory updates require a Personal-only resource"
      });
    }

    if (
      update.type === "managed_conversation_upserted" &&
      (resource.scope !== "personal" ||
        resource.teamId !== null ||
        resource.workspaceId !== null ||
        resource.threadId !== null ||
        resource.messageId !== null ||
        resource.sharedSessionId !== null ||
        resource.shareGrantId !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resource"],
        message: "Managed Conversation updates require a Personal-only resource"
      });
    }

    if (
      update.type === "message_created" &&
      (update.message.threadId !== resource.threadId ||
        update.message.id !== resource.messageId ||
        update.message.scope !== resource.scope ||
        update.message.teamId !== resource.teamId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["update", "message"],
        message: "Realtime message must match its authorized resource"
      });
    }
    if (
      update.type === "receipt_state_updated" &&
      update.readState.threadId !== resource.threadId
    ) {
      context.addIssue({
        code: "custom",
        path: ["update", "readState"],
        message: "Realtime read state must match its authorized thread"
      });
    }
    if (
      update.type === "message_receipts_updated" &&
      update.threadId !== resource.threadId
    ) {
      context.addIssue({
        code: "custom",
        path: ["update", "threadId"],
        message: "Realtime message receipts must match their authorized thread"
      });
    }
    if (
      (update.type === "thread_upserted" &&
        update.thread.id !== resource.threadId) ||
      (update.type === "thread_removed" &&
        update.threadId !== resource.threadId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["update"],
        message: "Realtime thread update must match its authorized resource"
      });
    }
    if (
      (update.type === "shared_session_upserted" &&
        update.session.id !== resource.sharedSessionId) ||
      (update.type === "shared_session_removed" &&
        update.sharedSessionId !== resource.sharedSessionId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["update"],
        message: "Shared Memory update must match its authorized resource"
      });
    }
  });

export const collaborationRealtimeControlSchema = z
  .object({
    contractVersion: z.literal(COLLABORATION_CONTRACT_VERSION),
    type: z.literal("control"),
    subscriptionId: z.uuid(),
    occurredAt: collaborationTimestampSchema,
    reason: z.enum([
      "access_revoked",
      "requires_snapshot",
      "backpressure",
      "stream_replaced",
      "server_shutdown"
    ])
  })
  .strict();

export const collaborationConnectionEventSchema = z
  .object({
    contractVersion: z.literal(COLLABORATION_CONTRACT_VERSION),
    type: z.literal("connection"),
    connection: collaborationConnectionSchema,
    error: collaborationSafeErrorSchema.nullable()
  })
  .strict();

export const collaborationDurableSendEventSchema = z
  .object({
    contractVersion: z.literal(COLLABORATION_CONTRACT_VERSION),
    type: z.literal("durable_send"),
    eventId: z.uuid(),
    send: collaborationDurableSendSchema,
    message: collaborationMessageSchema.nullable()
  })
  .strict()
  .superRefine((event, context) => {
    if ((event.send.state === "sent") !== (event.message !== null)) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Only a sent durable record carries its confirmed message"
      });
    }
    if (
      event.message &&
      (event.message.clientMessageId !== event.send.clientMessageId ||
        event.message.threadId !== event.send.authority.threadId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Confirmed message must match the durable send identity"
      });
    }
  });

export const collaborationRendererEventSchema = z.discriminatedUnion("type", [
  realtimeSnapshotDeliverySchema,
  realtimeUpdateDeliverySchema,
  collaborationRealtimeControlSchema,
  collaborationConnectionEventSchema,
  collaborationDurableSendEventSchema
]);

export type CollaborationLimits = z.infer<typeof collaborationLimitsSchema>;
export type CollaborationBackendIdentity = z.infer<
  typeof collaborationBackendIdentitySchema
>;
export type CollaborationConnection = z.infer<
  typeof collaborationConnectionSchema
>;
export type CollaborationSafeError = z.infer<
  typeof collaborationSafeErrorSchema
>;
export type CollaborationPerson = z.infer<typeof collaborationPersonSchema>;
export type CollaborationTeamPerson = z.infer<
  typeof collaborationTeamPersonSchema
>;
export type CollaborationThread = z.infer<typeof collaborationThreadSchema>;
export type CollaborationMessage = z.infer<typeof collaborationMessageSchema>;
export type CollaborationDurableSend = z.infer<
  typeof collaborationDurableSendSchema
>;
export type CollaborationReadState = z.infer<
  typeof collaborationReadStateSchema
>;
export type CollaborationMessagePage = z.infer<
  typeof collaborationMessagePageSchema
>;
export type SharedMemoryRepresentation = z.infer<
  typeof sharedMemoryRepresentationSchema
>;
export type PersonalMemoryEntry = z.infer<typeof personalMemoryEntrySchema>;
export type SharedMemorySourceItem = z.infer<
  typeof sharedMemorySourceItemSchema
>;
export type SharedMemorySession = z.infer<typeof sharedMemorySessionSchema>;
export type SharedMemorySourcePage = z.infer<
  typeof sharedMemorySourcePageSchema
>;
export type CollaborationSelection = z.infer<
  typeof collaborationSelectionSchema
>;
export type CollaborationThreadReference = z.infer<
  typeof collaborationThreadReferenceSchema
>;
export type SharedMemorySessionReference = z.infer<
  typeof sharedMemorySessionReferenceSchema
>;
export type CollaborationActionGrantIntent = z.infer<
  typeof collaborationActionGrantIntentSchema
>;
export type CollaborationActionGrantReference = z.infer<
  typeof collaborationActionGrantReferenceSchema
>;
export type CollaborationActionGrantStatus = z.infer<
  typeof collaborationActionGrantStatusSchema
>;
export type CollaborationApprovalTier = z.infer<
  typeof collaborationApprovalTierSchema
>;
export type CollaborationApprovalReview = z.infer<
  typeof collaborationApprovalReviewSchema
>;
export type CollaborationInvitation = z.infer<
  typeof collaborationInvitationSchema
>;
export type CollaborationInvitationPage = z.infer<
  typeof collaborationInvitationPageSchema
>;
export type CollaborationMembership = z.infer<
  typeof collaborationMembershipSchema
>;
export type CollaborationWorkspace = z.infer<
  typeof collaborationWorkspaceSchema
>;
export type CollaborationWorkspaceAccess = z.infer<
  typeof collaborationWorkspaceAccessSchema
>;
export type SharedMemoryPreview = z.infer<typeof sharedMemoryPreviewSchema>;
export type SharedMemoryConsent = z.infer<typeof sharedMemoryConsentSchema>;
export type SharedMemoryGrant = z.infer<typeof sharedMemoryGrantSchema>;
export type CollaborationView = z.infer<typeof collaborationViewSchema>;
export type CollaborationSnapshot = z.infer<typeof collaborationSnapshotSchema>;
export type CollaborationRendererCommand = z.infer<
  typeof collaborationRendererCommandSchema
>;
export type CollaborationCommandResult = z.infer<
  typeof collaborationCommandResultSchema
>;
export type CollaborationSubscription = z.infer<
  typeof collaborationSubscriptionSchema
>;
export type CollaborationRealtimeControl = z.infer<
  typeof collaborationRealtimeControlSchema
>;
export type CollaborationRealtimeSnapshot = z.infer<
  typeof collaborationRealtimeSnapshotSchema
>;
export type CollaborationRendererEvent = z.infer<
  typeof collaborationRendererEventSchema
>;
