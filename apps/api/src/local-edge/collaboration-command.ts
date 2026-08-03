import { createHash, createHmac } from "node:crypto";
import {
  collaborationSubscriptionPrincipalHash,
  CollaborationIdempotencyConflictError,
  CollaborationStateConflictError,
  CollaborationVersionConflictError,
  type CapturedSessionRepository,
  type CapturedSessionSummaryRecord,
  type CollaborationMessageRecord,
  type CollaborationReadStateRecord,
  type CollaborationRepository,
  type CollaborationSubscriptionRecord,
  type CollaborationThreadRecord
} from "@koed/db";
import * as shared from "@koed/shared";
import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  COLLABORATION_NAME_MAX_CODE_POINTS,
  COLLABORATION_SOURCE_PAGE_MAX_ITEMS,
  collaborationCommandResultSchema,
  collaborationMessageSchema,
  collaborationReadStateSchema,
  collaborationRendererCommandSchema,
  collaborationSafeErrorMessages,
  collaborationTeamPresenceStatusCatalogueSchema,
  collaborationThreadSchema,
  fetchBoundedJsonObject,
  isLoopbackHostname,
  readLocalEdgeClientCredentialAuthorization,
  resolveCollaborationActionGrantSecret,
  RemoteRequestTimeoutError,
  RemoteResponseLimitError,
  type CollaborationCommandResult,
  type CollaborationMessagePage,
  type CollaborationRendererCommand,
  type CollaborationSafeError,
  type CollaborationSelection,
  type CollaborationSnapshot,
  type CollaborationView,
  type PersonalMemoryEntry,
  type SharedMemorySession,
  type SharedMemorySessionReference,
  type SharedMemorySourcePage
} from "@koed/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { RateLimitHandler } from "../infra/rate-limit.js";
import {
  prepareSourceSyncRelationship,
  type SourceSyncRelationshipRepository
} from "../cross-identity-sync/source-relationship-service.js";
import type { RouteDeploymentMode } from "../server/route-identity.js";
import { localEdgeDeploymentModes } from "../server/route-identity.js";
import {
  collaborationActionGrantControlCommandNames,
  type CollaborationActionGrantControl
} from "./collaboration-action-grant-control.js";
import {
  collaborationCommandScope,
  desktopCollaborationOperationFamily,
  personalCollaborationOperationFor,
  teamCollaborationOperationFor,
  teamCollaborationResultMatchesCommand,
  type CollaborationUpstreamOperation
} from "./collaboration-command-registry.js";
import {
  isCollaborationSharedMemoryControlCommand,
  type CollaborationSharedMemoryControl
} from "./collaboration-shared-memory-control.js";
import {
  createCollaborationTeamControlCursorCodec,
  dispatchCollaborationTeamControlCommand,
  isCollaborationTeamControlCommand
} from "./collaboration-team-control.js";
import { openOpaqueCursor, sealOpaqueCursor } from "./opaque-cursor.js";
import {
  activeUpstreamBackend,
  readLocalEdgeUpstreamRegistry,
  resolveLocalEdgeRouteDecision,
  safeUpstreamProxyUrl,
  upstreamBackendById,
  type LocalEdgeUpstreamBackend,
  type LocalEdgeUpstreamRegistry
} from "./upstream-routing.js";

const COMMAND_BODY_LIMIT_BYTES = 128 * 1024;
const UPSTREAM_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const COLLABORATION_CAPABILITY_SCHEMA_VERSION = 6;
const PERSONAL_SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1_000;
const PERSONAL_CURSOR_PREFIX = "cpc1";
const TEAM_MESSAGE_CURSOR_PREFIX = "ctmc1";

const backendIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/);

const personalCollaborationCommandRequestSchema = z
  .object({
    command: collaborationRendererCommandSchema
  })
  .strict()
  .refine((input) => isPersonalCommand(input.command), {
    message: "Command is not a Personal collaboration command"
  });

const teamCollaborationCommandRequestSchema = z
  .object({
    upstream_backend_id: backendIdSchema,
    command: collaborationRendererCommandSchema
  })
  .strict()
  .refine((input) => isTeamCommand(input.command), {
    message: "Command is not a Team collaboration command"
  });

export const collaborationCommandRequestSchema = z.union([
  personalCollaborationCommandRequestSchema,
  teamCollaborationCommandRequestSchema
]);

type LocalEdgeCredentialResolver =
  typeof readLocalEdgeClientCredentialAuthorization;
interface DesktopLocalCredentialAuthorization {
  authorization: string;
  credentialKeyId: string;
  ownerUserId: string;
  operationFamilies: Array<
    "personal_collaboration_read" | "personal_collaboration_write"
  >;
}

type DesktopCredentialVerifier = (
  koedHome: string,
  authorization: string | undefined,
  operationFamily:
    | "personal_collaboration_read"
    | "personal_collaboration_write"
) => DesktopLocalCredentialAuthorization | null;

interface ActiveLocalUser {
  id: string;
  email: string;
  displayName: string | null;
}

interface CollaborationCommandRouteOptions {
  deploymentProfile: RouteDeploymentMode;
  resolveVerifiedLocalDeploymentId: () => string;
  teamCollaborationEnabled: boolean;
  koedHome: string;
  upstreamBackendsPath: string;
  corsOrigins: Set<string>;
  fetch: typeof fetch;
  resolveUpstreamAuthorization: (
    backend: LocalEdgeUpstreamBackend
  ) => string | null;
  requireCollaborationRepository: () => CollaborationRepository &
    Pick<CapturedSessionRepository, "listCapturedSessionSummaries"> &
    SourceSyncRelationshipRepository;
  resolveActiveLocalUser: (userId: string) => Promise<ActiveLocalUser | null>;
  actionGrantControl?: CollaborationActionGrantControl;
  sharedMemoryControl?: CollaborationSharedMemoryControl;
  readPreHandler?: RateLimitHandler;
  writePreHandler?: RateLimitHandler;
  readLocalEdgeClientCredential?: LocalEdgeCredentialResolver;
  verifyDesktopLocalCredential?: DesktopCredentialVerifier;
  readUpstreamRegistry?: (path: string) => LocalEdgeUpstreamRegistry;
  subscribeRemoteNavigationInvalidation?: (
    listener: (backendId: string) => void
  ) => () => void;
}

type PersonalCommand = Extract<
  CollaborationRendererCommand,
  | { command: "collaboration.load" }
  | { command: "collaboration.select" }
  | { command: "collaboration.create_notes_to_self" }
  | { command: "collaboration.create_personal_channel" }
  | { command: "collaboration.rename_thread" }
  | { command: "collaboration.update_thread_topic" }
  | { command: "collaboration.archive_thread" }
  | { command: "collaboration.restore_thread" }
  | { command: "collaboration.send_message" }
  | { command: "collaboration.retry_message" }
  | { command: "collaboration.mark_read" }
  | { command: "collaboration.mark_delivered" }
  | { command: "collaboration.load_message_page" }
  | { command: "collaboration.subscribe" }
>;

function isPersonalCommand(
  command: CollaborationRendererCommand
): command is PersonalCommand {
  return collaborationCommandScope(command) === "personal";
}

function isTeamCommand(command: CollaborationRendererCommand): boolean {
  return collaborationCommandScope(command) === "team";
}

type SupportedCommand = Extract<
  CollaborationRendererCommand,
  | { command: "collaboration.create_workspace_channel" }
  | { command: "collaboration.start_direct_message" }
  | { command: "collaboration.start_group_direct_message" }
  | { command: "collaboration.set_team_presence" }
  | { command: "collaboration.report_team_activity" }
  | { command: "collaboration.rename_thread" }
  | { command: "collaboration.update_thread_topic" }
  | { command: "collaboration.archive_thread" }
  | { command: "collaboration.restore_thread" }
  | { command: "collaboration.send_message" }
  | { command: "collaboration.retry_message" }
  | { command: "collaboration.mark_read" }
  | { command: "collaboration.mark_delivered" }
  | { command: "collaboration.load_message_page" }
>;

interface PersonalRemoteContext {
  backend: LocalEdgeUpstreamBackend;
  backendId: string;
  upstreamAuthorization: string;
  upstreamDeviceCredentialId: string;
  operationFamilies: ReadonlySet<
    "personal_collaboration_read" | "personal_collaboration_write"
  >;
  principal: z.infer<typeof remotePrincipalSchema>;
}

interface TeamReadContext {
  backend: LocalEdgeUpstreamBackend;
  backendId: string;
  upstreamAuthorization: string;
  upstreamDeviceCredentialId: string;
  operationFamilies: ReadonlySet<
    | "team_workspace_read"
    | "team_chat_read"
    | "team_chat_write"
    | "admin"
    | "action_grant"
    | "share_grant_management"
    | "managed_execution"
  >;
  principal: z.infer<typeof remotePrincipalSchema>;
}

interface RemoteRequestOptions {
  backend: LocalEdgeUpstreamBackend;
  upstreamAuthorization: string;
  operationFamily:
    | "personal_collaboration_read"
    | "personal_collaboration_write"
    | "team_workspace_read"
    | "team_chat_read"
    | "team_chat_write"
    | "admin"
    | "action_grant"
    | "share_grant_management"
    | "managed_execution";
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}

const canonicalParticipantSchema = z
  .object({
    userId: z.uuid(),
    displayName: z.string().nullable()
  })
  .strict();

const canonicalThreadSchema = z
  .object({
    id: z.uuid(),
    logicalId: z.uuid(),
    scope: z.enum(["personal", "team"]),
    kind: z.enum([
      "notes_to_self",
      "personal_channel",
      "workspace_channel",
      "dm",
      "group_dm",
      "shared_session_discussion"
    ]),
    personalOwnerUserId: z.uuid().nullable(),
    teamId: z.uuid().nullable(),
    teamWorkspaceId: z.uuid().nullable(),
    sharedLogicalMemoryId: z.uuid().nullable(),
    shareGrantId: z.uuid().nullable(),
    systemKey: z.literal("workspace.general").nullable(),
    name: z.string().nullable(),
    topic: z.string().nullable(),
    createdByUserId: z.uuid().nullable(),
    version: z.number().int().safe().positive(),
    lifecycle: z.enum([
      "active",
      "archived",
      "tombstoned",
      "purge_pending",
      "purged"
    ]),
    latestSequence: z.number().int().safe().min(0),
    lastReadMessageId: z.uuid().nullable(),
    lastReadSequence: z.number().int().safe().min(0),
    unreadCount: z.number().int().safe().min(0),
    participants: z.array(canonicalParticipantSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastActivityAt: z.string(),
    archivedAt: z.string().nullable()
  })
  .strict();

const canonicalMessageSchema = z
  .object({
    id: z.uuid(),
    threadId: z.uuid(),
    threadSequence: z.number().int().safe().positive(),
    scope: z.enum(["personal", "team"]),
    personalOwnerUserId: z.uuid().nullable(),
    teamId: z.uuid().nullable(),
    teamWorkspaceId: z.uuid().nullable(),
    senderKind: z.literal("user"),
    senderPrincipalId: z.string().nullable(),
    senderUserId: z.uuid(),
    senderDisplayName: z.string().nullable(),
    audienceVersion: z.number().int().safe().positive(),
    recipientStatus: z.enum(["sent", "delivered", "read"]).nullable(),
    bodyText: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    provenance: z
      .object({
        kind: z.string(),
        id: z.string(),
        details: z.record(z.string(), z.unknown()).optional()
      })
      .strict(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();

const canonicalReadStateSchema = z
  .object({
    threadId: z.uuid(),
    userId: z.uuid(),
    lastDeliveredMessageId: z.uuid().nullable(),
    lastDeliveredSequence: z.number().int().safe().min(0),
    lastDeliveredAt: z.string().nullable(),
    lastReadMessageId: z.uuid().nullable(),
    lastReadSequence: z.number().int().safe().min(0),
    lastReadAt: z.string().nullable(),
    unreadCount: z.number().int().safe().min(0),
    version: z.number().int().safe().positive(),
    updatedAt: z.string()
  })
  .strict();

const remotePersonalSnapshotSchema = z
  .object({
    snapshot: z
      .object({
        scope: z.literal("personal"),
        personalOwnerUserId: z.uuid(),
        teamId: z.null(),
        highWaterCursor: z.number().int().safe().min(0),
        threads: z.array(canonicalThreadSchema).max(5_000)
      })
      .strict()
  })
  .strict();

const remotePrincipalSchema = z
  .object({
    id: z.uuid(),
    email: z.string().max(320).optional(),
    displayName: z.string().max(320).nullable()
  })
  .strict();

const remoteDeviceStatusSchema = z
  .object({
    ok: z.literal(true),
    auth: z.literal("device_credential"),
    user: remotePrincipalSchema,
    credential: z
      .object({
        id: z.uuid(),
        ownerUserId: z.uuid(),
        operationFamilies: z.array(z.string().min(1).max(80)).max(32)
      })
      .passthrough()
  })
  .passthrough()
  .superRefine((value, refinement) => {
    if (value.credential.ownerUserId !== value.user.id) {
      refinement.addIssue({
        code: "custom",
        message: "Remote device credential owner does not match principal"
      });
    }
  });

const remoteTeamSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    version: z.number().int().safe().positive(),
    lifecycle: z.enum([
      "active",
      "suspended",
      "deletion_requested",
      "tombstoned",
      "purged"
    ])
  })
  .passthrough();

const remoteMembershipSchema = z
  .object({
    teamId: z.uuid(),
    userId: z.uuid(),
    role: z.enum(["owner", "admin", "member"]),
    status: z.enum(["invited", "enabled", "disabled"])
  })
  .passthrough();

const remoteTeamPresenceSchema = z
  .object({
    mode: z.enum(["auto", "manual"]),
    manualStatus: z.union([
      z.enum(["available", "do_not_disturb", "out_of_office"]),
      z
        .string()
        .trim()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9_]*$/)
        .transform(() => "unknown" as const)
    ]),
    activityLevel: z
      .enum(["active", "recently_active", "idle", "inactive"])
      .nullable(),
    lastActivityAt: z.string().datetime().nullable(),
    nextTransitionAt: z.string().datetime().nullable(),
    preferenceVersion: z.number().int().safe().positive()
  })
  .strict();

const remoteRosterMemberSchema = z
  .object({
    userId: z.uuid(),
    displayName: z.string().nullable(),
    status: z.literal("enabled"),
    presence: z.enum(["available", "away", "offline"]),
    teamPresence: remoteTeamPresenceSchema
  })
  .passthrough();

const remoteManagementWorkspaceAccessSchema = z
  .object({
    teamWorkspaceId: z.uuid(),
    userId: z.uuid(),
    access: z.enum(["disabled", "read", "write"]),
    version: z.number().int().safe().positive()
  })
  .passthrough();

const remoteManagementMemberSchema = z
  .object({
    id: z.uuid(),
    teamId: z.uuid(),
    userId: z.uuid(),
    role: z.enum(["owner", "admin", "member"]),
    status: z.enum(["invited", "enabled", "disabled"]),
    version: z.number().int().safe().positive(),
    email: z.email(),
    displayName: z.string().nullable(),
    presence: z.enum(["available", "away", "offline"]),
    teamPresence: remoteTeamPresenceSchema,
    workspaceAccess: z.array(remoteManagementWorkspaceAccessSchema).max(250)
  })
  .passthrough();

const remoteWorkspaceSchema = z
  .object({
    id: z.uuid(),
    teamId: z.uuid(),
    name: z.string().min(1),
    description: z.string().nullable(),
    version: z.number().int().safe().positive(),
    lifecycle: z.enum(["active", "archived", "purge_pending", "purged"]),
    archivedAt: z.string().nullable()
  })
  .passthrough();

const remoteWorkspaceAccessSchema = z
  .object({
    teamWorkspaceId: z.uuid(),
    teamId: z.uuid(),
    userId: z.uuid(),
    access: z.enum(["read", "write"]),
    canRecall: z.boolean().optional()
  })
  .passthrough();

const remoteSharedGrantIndexSchema = z
  .object({
    id: z.uuid(),
    logicalMemoryId: z.uuid(),
    ownerUserId: z.uuid().nullable(),
    activeRepresentation: z.enum([
      "memory_events",
      "lcm_leaves",
      "lcm_rollups"
    ]),
    representationState: z.enum(["available", "stale"]),
    representationSourceRevision: z.number().int().safe().min(0),
    representationUpdatedAt: z.string(),
    lifecycle: z.literal("active"),
    createdAt: z.string(),
    updatedAt: z.string(),
    companionScope: z
      .object({
        scope: z.literal("team"),
        kind: z.literal("shared_session_discussion"),
        teamId: z.uuid(),
        teamWorkspaceId: z.uuid(),
        logicalMemoryId: z.uuid(),
        shareGrantId: z.uuid()
      })
      .passthrough()
  })
  .passthrough();

const remoteTeamNavigationSchema = z
  .object({
    principal: remotePrincipalSchema,
    teamPresenceStatusCatalogue: collaborationTeamPresenceStatusCatalogueSchema,
    teams: z
      .array(
        z
          .object({
            team: remoteTeamSchema,
            membership: remoteMembershipSchema,
            members: z.array(remoteRosterMemberSchema),
            threads: z.array(z.unknown()).max(5_000),
            highWaterCursor: z.number().int().safe().min(0),
            workspaces: z
              .array(
                z
                  .object({
                    teamWorkspace: remoteWorkspaceSchema,
                    access: remoteWorkspaceAccessSchema,
                    shareGrants: z.array(remoteSharedGrantIndexSchema).max(100)
                  })
                  .strict()
              )
              .max(20)
          })
          .strict()
      )
      .max(50)
  })
  .strict();

const remoteMessagePageSchema = z
  .object({
    messages: z.array(z.unknown()),
    hasMore: z.boolean().optional(),
    nextBeforeSequence: z.number().int().safe().nullable().optional(),
    nextAfterSequence: z.number().int().safe().nullable().optional()
  })
  .passthrough();

const teamMessageCursorPayloadSchema = z
  .object({
    version: z.literal(1),
    backendId: backendIdSchema,
    principalUserId: z.uuid(),
    teamId: z.uuid(),
    threadId: z.uuid(),
    direction: z.enum(["older", "newer"]),
    boundarySequence: z.number().int().safe().min(0),
    snapshotSequence: z.number().int().safe().min(0)
  })
  .strict();

type TeamMessageCursorPayload = z.infer<typeof teamMessageCursorPayloadSchema>;

const safeError = (
  code: CollaborationSafeError["code"],
  retryAfterMs: number | null = null
): CollaborationSafeError => ({
  code,
  userMessage: collaborationSafeErrorMessages[code],
  retryable:
    code === "offline" ||
    code === "temporarily_unavailable" ||
    code === "rate_limited" ||
    code === "conflict",
  retryAfterMs
});

const failureResult = (
  command: CollaborationRendererCommand,
  error: CollaborationSafeError
): CollaborationCommandResult =>
  collaborationCommandResultSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: false,
    error
  });

const retryAfterFrom = (response: Response): number | null => {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(300_000, Math.round(seconds * 1_000))
    : null;
};

const errorForStatus = (response: Response): CollaborationSafeError => {
  if (response.status === 400 || response.status === 422) {
    return safeError("invalid_input");
  }
  if (response.status === 401 || response.status === 403) {
    return safeError("permission_denied");
  }
  if (response.status === 404) return safeError("not_available");
  if (response.status === 409) return safeError("conflict");
  if (response.status === 410) return safeError("access_revoked");
  if (response.status === 429) {
    return safeError("rate_limited", retryAfterFrom(response));
  }
  if ([424, 502, 503, 504].includes(response.status)) {
    return safeError("temporarily_unavailable", retryAfterFrom(response));
  }
  return safeError("internal_error");
};

const httpError = (message: string, statusCode: number): Error =>
  Object.assign(new Error(message), { statusCode });

const isLoopbackAddress = (address: string): boolean =>
  address === "127.0.0.1" ||
  address === "::1" ||
  address === "::ffff:127.0.0.1";

const assertLocalTrust = (
  request: FastifyRequest,
  corsOrigins: Set<string>
): void => {
  if (!isLoopbackHostname(request.hostname) || !isLoopbackAddress(request.ip)) {
    throw httpError("Collaboration commands require localhost", 403);
  }
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw httpError("Collaboration command origin is not allowed", 403);
  }
  const normalized = origin.replace(/\/+$/, "");
  if (
    parsed.username ||
    parsed.password ||
    !isLoopbackHostname(parsed.hostname) ||
    !corsOrigins.has(normalized)
  ) {
    throw httpError("Collaboration command origin is not allowed", 403);
  }
};

type SharedDesktopCredentialApi = {
  readDesktopLocalCredentialAuthorization?: (
    koedHome: string
  ) => DesktopLocalCredentialAuthorization | null;
  verifyDesktopLocalCredentialAuthorization?: (
    koedHome: string,
    authorization: string | undefined,
    input: { ownerUserId: string; operationFamily: string }
  ) => DesktopLocalCredentialAuthorization | null;
};

const verifyStoredDesktopLocalCredential: DesktopCredentialVerifier = (
  koedHome,
  authorization,
  operationFamily
) => {
  const api = shared as unknown as SharedDesktopCredentialApi;
  const stored = api.readDesktopLocalCredentialAuthorization?.(koedHome);
  if (!stored || !api.verifyDesktopLocalCredentialAuthorization) return null;
  return api.verifyDesktopLocalCredentialAuthorization(
    koedHome,
    authorization,
    { ownerUserId: stored.ownerUserId, operationFamily }
  );
};

const normalizedDisplayName = (user: ActiveLocalUser): string => {
  const candidate =
    user.displayName?.trim().normalize("NFC") ||
    user.email.split("@", 1)[0]?.trim().normalize("NFC") ||
    "Koed User";
  return [...candidate].slice(0, 128).join("");
};

const personalThreadFromRecord = (
  thread: CollaborationThreadRecord,
  user: ActiveLocalUser,
  sourceOwnerUserId = user.id
): z.infer<typeof collaborationThreadSchema> | null => {
  if (
    thread.scope !== "personal" ||
    thread.personalOwnerUserId !== sourceOwnerUserId ||
    thread.teamId !== null ||
    (thread.kind !== "notes_to_self" && thread.kind !== "personal_channel")
  ) {
    return null;
  }
  const base = {
    id: thread.id,
    logicalId: thread.logicalId,
    scope: "personal" as const,
    ownerUserId: user.id,
    name: thread.name,
    topic: thread.topic,
    version: thread.version,
    lifecycle: thread.lifecycle,
    canPost: thread.lifecycle === "active",
    latestSequence: thread.latestSequence,
    unreadCount: thread.unreadCount,
    lastReadMessageId: thread.lastReadMessageId,
    lastReadSequence: thread.lastReadSequence,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastActivityAt: thread.lastActivityAt,
    archivedAt: thread.archivedAt
  };
  const candidate =
    thread.kind === "notes_to_self"
      ? {
          ...base,
          kind: "notes_to_self" as const,
          name: null,
          topic: null,
          participants: [
            {
              id: user.id,
              displayName: normalizedDisplayName(user),
              membershipState: "enabled" as const
            }
          ]
        }
      : {
          ...base,
          kind: "personal_channel" as const,
          name: thread.name
        };
  const parsed = collaborationThreadSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

const personalMessageFromRecord = (
  message: CollaborationMessageRecord,
  user: ActiveLocalUser,
  threadId: string,
  sourceOwnerUserId = user.id
): z.infer<typeof collaborationMessageSchema> | null => {
  if (
    message.threadId !== threadId ||
    message.scope !== "personal" ||
    message.personalOwnerUserId !== sourceOwnerUserId ||
    message.teamId !== null ||
    message.senderKind !== "user" ||
    message.senderUserId !== sourceOwnerUserId
  ) {
    return null;
  }
  const parsed = collaborationMessageSchema.safeParse({
    id: message.id,
    threadId: message.threadId,
    scope: "personal",
    teamId: null,
    sequence: message.threadSequence,
    sender: {
      id: user.id,
      displayName: normalizedDisplayName(user),
      membershipState: "enabled"
    },
    senderKind: "user",
    body: message.bodyText,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    editedAt: null,
    deletedAt: null,
    delivery: "sent",
    recipientStatus: message.recipientStatus,
    failure: null
  });
  return parsed.success ? parsed.data : null;
};

const personalReadStateFromRecord = (
  readState: CollaborationReadStateRecord,
  ownerUserId: string,
  threadId: string
): z.infer<typeof collaborationReadStateSchema> | null => {
  if (readState.userId !== ownerUserId || readState.threadId !== threadId) {
    return null;
  }
  const parsed = collaborationReadStateSchema.safeParse({
    threadId: readState.threadId,
    deliveredMessageId: readState.lastDeliveredMessageId,
    deliveredSequence: readState.lastDeliveredSequence,
    deliveredAt: readState.lastDeliveredAt,
    messageId: readState.lastReadMessageId,
    sequence: readState.lastReadSequence,
    readAt: readState.lastReadAt,
    unreadCount: readState.unreadCount,
    version: readState.version,
    updatedAt: readState.updatedAt
  });
  return parsed.success ? parsed.data : null;
};

const personalCursorPayloadSchema = z
  .object({
    version: z.literal(1),
    ownerUserId: z.uuid(),
    threadId: z.uuid(),
    direction: z.enum(["older", "newer"]),
    boundarySequence: z.number().int().safe().min(0),
    snapshotSequence: z.number().int().safe().min(0)
  })
  .strict();

type PersonalCursorPayload = z.infer<typeof personalCursorPayloadSchema>;

const credentialHmac = (
  credential: DesktopLocalCredentialAuthorization,
  domain: string,
  value: string
): string =>
  createHmac("sha256", credential.authorization)
    .update(`koed:${domain}:v1\n${value}`, "utf8")
    .digest("base64url");

const encodePersonalCursor = (
  credential: DesktopLocalCredentialAuthorization,
  payload: PersonalCursorPayload
): string =>
  sealOpaqueCursor({
    secret: credential.authorization,
    prefix: PERSONAL_CURSOR_PREFIX,
    domain: "personal-collaboration-cursor",
    payload
  });

const decodePersonalCursor = (
  credential: DesktopLocalCredentialAuthorization,
  cursor: string,
  expected: Pick<
    PersonalCursorPayload,
    "ownerUserId" | "threadId" | "direction"
  >
): PersonalCursorPayload | null => {
  const parsed = personalCursorPayloadSchema.safeParse(
    openOpaqueCursor({
      secret: credential.authorization,
      prefix: PERSONAL_CURSOR_PREFIX,
      domain: "personal-collaboration-cursor",
      cursor
    })
  );
  if (
    !parsed.success ||
    parsed.data.ownerUserId !== expected.ownerUserId ||
    parsed.data.threadId !== expected.threadId ||
    parsed.data.direction !== expected.direction ||
    parsed.data.boundarySequence > parsed.data.snapshotSequence
  ) {
    return null;
  }
  return parsed.data;
};

const encodeSignedCursor = (
  credential: DesktopLocalCredentialAuthorization,
  prefix: string,
  domain: string,
  payload: Record<string, unknown>
): string => {
  return sealOpaqueCursor({
    secret: credential.authorization,
    prefix,
    domain,
    payload
  });
};

const decodeSignedCursor = (
  credential: DesktopLocalCredentialAuthorization,
  prefix: string,
  domain: string,
  cursor: string
): unknown | null => {
  return openOpaqueCursor({
    secret: credential.authorization,
    prefix,
    domain,
    cursor
  });
};

const encodeTeamMessageCursor = (
  credential: DesktopLocalCredentialAuthorization,
  payload: TeamMessageCursorPayload
): string =>
  encodeSignedCursor(
    credential,
    TEAM_MESSAGE_CURSOR_PREFIX,
    "team-collaboration-message-cursor",
    payload
  );

const decodeTeamMessageCursor = (
  credential: DesktopLocalCredentialAuthorization,
  cursor: string,
  expected: Pick<
    TeamMessageCursorPayload,
    "backendId" | "principalUserId" | "teamId" | "threadId" | "direction"
  >
): TeamMessageCursorPayload | null => {
  const decoded = decodeSignedCursor(
    credential,
    TEAM_MESSAGE_CURSOR_PREFIX,
    "team-collaboration-message-cursor",
    cursor
  );
  const parsed = teamMessageCursorPayloadSchema.safeParse(decoded);
  if (
    !parsed.success ||
    parsed.data.backendId !== expected.backendId ||
    parsed.data.principalUserId !== expected.principalUserId ||
    parsed.data.teamId !== expected.teamId ||
    parsed.data.threadId !== expected.threadId ||
    parsed.data.direction !== expected.direction ||
    parsed.data.boundarySequence > parsed.data.snapshotSequence
  ) {
    return null;
  }
  return parsed.data;
};

const personalSnapshotRevision = (
  credential: DesktopLocalCredentialAuthorization,
  ownerUserId: string,
  highWaterCursor: number
): string =>
  `csr1.${credentialHmac(
    credential,
    "personal-collaboration-snapshot",
    `${ownerUserId}\n${highWaterCursor}`
  )}`;

const personalPageRevision = (
  credential: DesktopLocalCredentialAuthorization,
  ownerUserId: string,
  threadId: string,
  snapshotSequence: number
): string =>
  `cpr1.${credentialHmac(
    credential,
    "personal-collaboration-page",
    `${ownerUserId}\n${threadId}\n${snapshotSequence}`
  )}`;

const personalMessagePage = async (input: {
  repository: CollaborationRepository;
  credential: DesktopLocalCredentialAuthorization;
  user: ActiveLocalUser;
  thread: CollaborationThreadRecord;
  direction: "older" | "newer";
  cursor: string | null;
  limit: number;
}): Promise<CollaborationMessagePage | null> => {
  const decoded = input.cursor
    ? decodePersonalCursor(input.credential, input.cursor, {
        ownerUserId: input.user.id,
        threadId: input.thread.id,
        direction: input.direction
      })
    : null;
  if (input.cursor && !decoded) throw new TypeError("Invalid message cursor");
  const snapshotSequence =
    decoded?.snapshotSequence ?? input.thread.latestSequence;
  if (snapshotSequence > input.thread.latestSequence) {
    throw new TypeError("Invalid message cursor snapshot");
  }
  const boundarySequence = decoded?.boundarySequence ?? 0;
  const page = await input.repository.listMessages(
    { userId: input.user.id },
    input.direction === "older"
      ? {
          threadId: input.thread.id,
          beforeSequence: decoded ? boundarySequence : snapshotSequence + 1,
          limit: input.limit
        }
      : {
          threadId: input.thread.id,
          afterSequence: boundarySequence,
          beforeSequence: snapshotSequence + 1,
          limit: input.limit
        }
  );
  if (!page) return null;
  const items = page.messages.map((message) =>
    personalMessageFromRecord(message, input.user, input.thread.id)
  );
  const canonicalItems = items.filter(
    (message): message is NonNullable<typeof message> => message !== null
  );
  if (canonicalItems.length !== items.length) return null;
  const firstSequence = canonicalItems[0]?.sequence ?? null;
  const lastSequence = canonicalItems.at(-1)?.sequence ?? null;
  const hasOlder = firstSequence !== null && firstSequence > 1;
  const hasNewer = lastSequence !== null && lastSequence < snapshotSequence;
  return {
    snapshotRevision: personalPageRevision(
      input.credential,
      input.user.id,
      input.thread.id,
      snapshotSequence
    ),
    olderCursor: hasOlder
      ? encodePersonalCursor(input.credential, {
          version: 1,
          ownerUserId: input.user.id,
          threadId: input.thread.id,
          direction: "older",
          boundarySequence: firstSequence!,
          snapshotSequence
        })
      : null,
    newerCursor: hasNewer
      ? encodePersonalCursor(input.credential, {
          version: 1,
          ownerUserId: input.user.id,
          threadId: input.thread.id,
          direction: "newer",
          boundarySequence: lastSequence!,
          snapshotSequence
        })
      : null,
    hasOlder,
    hasNewer,
    threadId: input.thread.id,
    items: canonicalItems
  };
};

const supportsCollaborationCommands = (
  backend: LocalEdgeUpstreamBackend
): boolean => {
  const availability =
    backend.capabilities?.payload?.capabilities?.["memory.collaboration"]
      ?.availability;
  return (
    backend.capabilities?.schemaVersion ===
      COLLABORATION_CAPABILITY_SCHEMA_VERSION &&
    backend.capabilities.payload?.capabilitySchemaVersion ===
      COLLABORATION_CAPABILITY_SCHEMA_VERSION &&
    (availability === "available" || availability === "partial")
  );
};

const isSafeBackend = (backend: LocalEdgeUpstreamBackend): boolean => {
  try {
    const parsed = new URL(backend.baseUrl);
    return (
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    );
  } catch {
    return false;
  }
};

const targetThreadFrom = (
  value: unknown,
  command: SupportedCommand
): unknown => {
  const target = collaborationThreadSchema.safeParse(value);
  if (target.success) return target.data;
  const canonical = canonicalThreadSchema.safeParse(value);
  if (!canonical.success || canonical.data.scope !== "team") return null;
  const thread = canonical.data;
  const displayName =
    thread.kind === "workspace_channel" &&
    thread.systemKey === "workspace.general"
      ? "general"
      : thread.name;
  const base = {
    id: thread.id,
    logicalId: thread.logicalId,
    scope: thread.scope,
    name: displayName,
    topic: thread.topic,
    version: thread.version,
    lifecycle: thread.lifecycle,
    canPost: thread.lifecycle === "active",
    latestSequence: thread.latestSequence,
    unreadCount: thread.unreadCount,
    lastReadMessageId: thread.lastReadMessageId,
    lastReadSequence: thread.lastReadSequence,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastActivityAt: thread.lastActivityAt,
    archivedAt: thread.archivedAt,
    teamId: thread.teamId
  };
  if (
    thread.kind === "workspace_channel" &&
    thread.teamId &&
    thread.teamWorkspaceId
  ) {
    return {
      ...base,
      kind: thread.kind,
      workspaceId: thread.teamWorkspaceId
    };
  }
  if (
    thread.kind === "shared_session_discussion" &&
    thread.teamId &&
    thread.teamWorkspaceId &&
    thread.sharedLogicalMemoryId &&
    thread.shareGrantId
  ) {
    return {
      ...base,
      kind: thread.kind,
      workspaceId: thread.teamWorkspaceId,
      sharedLogicalMemoryId: thread.sharedLogicalMemoryId,
      shareGrantId: thread.shareGrantId
    };
  }
  void command;
  if (
    (thread.kind === "dm" || thread.kind === "group_dm") &&
    thread.teamId &&
    thread.participants.every((participant) => participant.displayName)
  ) {
    return {
      ...base,
      kind: thread.kind,
      participants: thread.participants.map((participant) => ({
        id: participant.userId,
        displayName: participant.displayName,
        membershipState: "enabled"
      }))
    };
  }
  return null;
};

const targetMessageFrom = (value: unknown): unknown => {
  const target = collaborationMessageSchema.safeParse(value);
  if (target.success) return target.data;
  const canonical = canonicalMessageSchema.safeParse(value);
  if (!canonical.success || canonical.data.scope !== "team") return null;
  const message = canonical.data;
  return {
    id: message.id,
    threadId: message.threadId,
    scope: message.scope,
    teamId: message.teamId,
    sequence: message.threadSequence,
    sender: {
      id: message.senderUserId,
      displayName: message.senderDisplayName ?? "Team member",
      membershipState: "enabled"
    },
    senderKind: message.senderKind,
    body: message.bodyText,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    editedAt: null,
    deletedAt: null,
    delivery: "sent",
    recipientStatus: message.recipientStatus,
    failure: null
  };
};

const targetReadStateFrom = (value: unknown): unknown => {
  const target = collaborationReadStateSchema.safeParse(value);
  if (target.success) return target.data;
  const canonical = canonicalReadStateSchema.safeParse(value);
  if (!canonical.success) return null;
  return {
    threadId: canonical.data.threadId,
    deliveredMessageId: canonical.data.lastDeliveredMessageId,
    deliveredSequence: canonical.data.lastDeliveredSequence,
    deliveredAt: canonical.data.lastDeliveredAt,
    messageId: canonical.data.lastReadMessageId,
    sequence: canonical.data.lastReadSequence,
    readAt: canonical.data.lastReadAt,
    unreadCount: canonical.data.unreadCount,
    version: canonical.data.version,
    updatedAt: canonical.data.updatedAt
  };
};

const targetResultValue = (
  command: SupportedCommand,
  operation: CollaborationUpstreamOperation,
  value: unknown
): unknown => {
  if (operation.resultKey === "thread") return targetThreadFrom(value, command);
  if (operation.resultKey === "message") return targetMessageFrom(value);
  if (operation.resultKey === "person") {
    const person = remoteRosterMemberSchema.safeParse(value);
    return person.success ? remotePersonFrom(person.data) : null;
  }
  if (operation.resultKey === "acceptedTeamIds") {
    const accepted = z.array(z.uuid()).max(50).safeParse(value);
    return accepted.success ? accepted.data : null;
  }
  return targetReadStateFrom(value);
};

const successResult = (
  command: SupportedCommand,
  operation: CollaborationUpstreamOperation,
  payload: Record<string, unknown>
): CollaborationCommandResult | null => {
  const value = targetResultValue(
    command,
    operation,
    payload[operation.resultKey]
  );
  if (!teamCollaborationResultMatchesCommand(command, value)) return null;
  const parsed = collaborationCommandResultSchema.safeParse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: true,
    data: { [operation.resultKey]: value }
  });
  if (
    !parsed.success ||
    parsed.data.requestId !== command.requestId ||
    parsed.data.command !== command.command
  ) {
    return null;
  }
  return parsed.data;
};

const personalSuccessResult = (
  command: CollaborationRendererCommand,
  data: Record<string, unknown>
): CollaborationCommandResult | null => {
  const parsed = collaborationCommandResultSchema.safeParse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: true,
    data
  });
  return parsed.success &&
    parsed.data.requestId === command.requestId &&
    parsed.data.command === command.command
    ? parsed.data
    : null;
};

const requirePersonalThreadRecord = async (
  repository: CollaborationRepository,
  userId: string,
  threadId: string,
  includeArchived: boolean
): Promise<CollaborationThreadRecord | null> => {
  const thread = await repository.getThread(
    { userId },
    { threadId, includeArchived }
  );
  return thread?.scope === "personal" &&
    thread.personalOwnerUserId === userId &&
    thread.teamId === null &&
    (thread.kind === "notes_to_self" || thread.kind === "personal_channel")
    ? thread
    : null;
};

const displayNameFrom = (
  value: { displayName?: string | null; email?: string | null },
  fallback: string
): string => {
  const candidate =
    value.displayName?.trim().normalize("NFC") ||
    value.email?.split("@", 1)[0]?.trim().normalize("NFC") ||
    fallback;
  return [...candidate].slice(0, 128).join("");
};

const remotePersonFrom = (
  value: z.infer<typeof remoteRosterMemberSchema>
): Record<string, unknown> => ({
  id: value.userId,
  displayName: displayNameFrom(value, "Team member"),
  presence: value.presence,
  teamPresence: value.teamPresence,
  membershipState: "enabled"
});

const remoteManagedPersonFrom = (
  value: z.infer<typeof remoteManagementMemberSchema>
): Record<string, unknown> => ({
  id: value.userId,
  displayName: displayNameFrom(value, "Team member"),
  presence: value.presence,
  teamPresence: value.teamPresence,
  membershipState: value.status === "enabled" ? "enabled" : "disabled",
  management: {
    membershipId: value.id,
    email: value.email,
    role: value.role,
    status: value.status,
    version: value.version,
    workspaceAccess: value.workspaceAccess.map((access) => ({
      workspaceId: access.teamWorkspaceId,
      userId: access.userId,
      access: access.access,
      version: access.version
    }))
  }
});

const remotePrincipalPersonFrom = (
  value: z.infer<typeof remotePrincipalSchema>
): Record<string, unknown> => ({
  id: value.id,
  displayName: displayNameFrom(value, "Team user"),
  presence: "offline",
  membershipState: "enabled"
});

const mappedWorkspaceLifecycle = (
  lifecycle: z.infer<typeof remoteWorkspaceSchema>["lifecycle"]
): "active" | "archived" | "purged" =>
  lifecycle === "active" || lifecycle === "archived" ? lifecycle : "purged";

const teamSnapshotRevision = (
  credential: DesktopLocalCredentialAuthorization,
  backendId: string,
  principalUserId: string,
  revisionInput: unknown
): string =>
  `ctr1.${credentialHmac(
    credential,
    "team-collaboration-snapshot",
    `${backendId}\n${principalUserId}\n${JSON.stringify(revisionInput)}`
  )}`;

const teamPageRevision = (
  credential: DesktopLocalCredentialAuthorization,
  payload: Pick<
    TeamMessageCursorPayload,
    "backendId" | "principalUserId" | "teamId" | "threadId" | "snapshotSequence"
  >
): string =>
  `ctpr1.${credentialHmac(
    credential,
    "team-collaboration-page",
    `${payload.backendId}\n${payload.principalUserId}\n${payload.teamId}\n${payload.threadId}\n${payload.snapshotSequence}`
  )}`;

const queryPath = (
  path: string,
  query: Record<string, string | number | boolean | null | undefined>
): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
};

const safeUpstreamCommandUrl = (
  backend: LocalEdgeUpstreamBackend,
  path: string
): URL => {
  if (path !== "/v1/local-edge/device-credentials/status") {
    return safeUpstreamProxyUrl(backend, path);
  }
  const base = new URL(backend.baseUrl.replace(/\/+$/, "/"));
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("Unsafe upstream backend URL");
  }
  return new URL(path.replace(/^\//, ""), base);
};

const requireRemoteJson = async (
  fetcher: typeof fetch,
  options: RemoteRequestOptions
): Promise<Record<string, unknown>> => {
  let remote: Awaited<ReturnType<typeof fetchBoundedJsonObject>>;
  try {
    remote = await fetchBoundedJsonObject(
      fetcher,
      safeUpstreamCommandUrl(options.backend, options.path),
      {
        method: options.method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: options.upstreamAuthorization,
          ...(options.method === "GET"
            ? {}
            : { "content-type": "application/json" }),
          ...(options.idempotencyKey
            ? { "idempotency-key": options.idempotencyKey }
            : {})
        },
        ...(options.method === "GET"
          ? {}
          : { body: JSON.stringify(options.body ?? {}) })
      },
      {
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        maxBytes: UPSTREAM_RESPONSE_LIMIT_BYTES
      }
    );
  } catch (error) {
    const invalidResponse =
      error instanceof RemoteResponseLimitError || error instanceof SyntaxError;
    throw Object.assign(
      error instanceof RemoteRequestTimeoutError
        ? new Error("Upstream request timed out")
        : invalidResponse
          ? new Error("Upstream response is invalid")
          : new Error("Upstream request failed"),
      {
        collaborationSafeError:
          error instanceof RemoteRequestTimeoutError
            ? safeError("temporarily_unavailable")
            : invalidResponse
              ? safeError("internal_error")
              : safeError("offline")
      }
    );
  }
  const { response, payload } = remote;
  if (!response.ok) {
    throw Object.assign(new Error("Upstream request was rejected"), {
      collaborationSafeError: errorForStatus(response)
    });
  }
  return payload;
};

const safeErrorFromUnknown = (
  error: unknown,
  fallback: CollaborationSafeError["code"] = "temporarily_unavailable"
): CollaborationSafeError => {
  const safe =
    error &&
    typeof error === "object" &&
    "collaborationSafeError" in error &&
    (error as { collaborationSafeError?: unknown }).collaborationSafeError;
  const parsed = safe
    ? z
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
            "history_expired",
            "internal_error"
          ]),
          userMessage: z.string(),
          retryable: z.boolean(),
          retryAfterMs: z.number().int().nullable()
        })
        .safeParse(safe)
    : null;
  return parsed?.success ? parsed.data : safeError(fallback);
};

const sourceSyncErrorFor = (error: unknown): CollaborationSafeError => {
  const statusCode =
    error && typeof error === "object" && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : null;
  if (statusCode === 401 || statusCode === 403) {
    return safeError("permission_denied");
  }
  if (statusCode === 404) return safeError("not_available");
  if (statusCode === 409) return safeError("conflict");
  if (statusCode === 410) return safeError("access_revoked");
  if (statusCode === 424 || statusCode === 503) {
    return safeError("temporarily_unavailable");
  }
  return safeErrorFromUnknown(error);
};

const personalMemoryEntryFromSummary = (
  entry: CapturedSessionSummaryRecord
): PersonalMemoryEntry => ({
  id: entry.sessionId,
  logicalMemoryId: entry.logicalMemoryId,
  title: boundedCollaborationLabel(entry.title, "Captured Session"),
  projectName: entry.projectName
    ? boundedCollaborationLabel(entry.projectName, "Project")
    : null,
  updatedAt: entry.updatedAt,
  preview:
    entry.eventCount === 1
      ? "1 Memory Event"
      : `${entry.eventCount} Memory Events`,
  eventCount: entry.eventCount,
  hasSynchronizedRevision: entry.hasSynchronizedRevision,
  syncState: entry.syncState
});

const boundedCollaborationLabel = (value: string, fallback: string): string => {
  const normalized = value.trim().normalize("NFC") || fallback;
  return [...normalized].slice(0, COLLABORATION_NAME_MAX_CODE_POINTS).join("");
};

const loadPersonalSnapshot = async (input: {
  repository: CollaborationRepository &
    Pick<CapturedSessionRepository, "listCapturedSessionSummaries">;
  credential: DesktopLocalCredentialAuthorization;
  user: ActiveLocalUser;
}): Promise<Record<string, unknown> | null> => {
  let snapshot = await input.repository.getAuthorizedSnapshot(
    { userId: input.user.id },
    { scope: "personal", includeArchived: true }
  );
  if (!snapshot) return null;
  let notes = snapshot.threads.find(
    (thread) => thread.kind === "notes_to_self"
  );
  if (!notes) {
    if (
      !input.credential.operationFamilies.includes(
        "personal_collaboration_write"
      )
    ) {
      return null;
    }
    await input.repository.createThread(
      { userId: input.user.id },
      {
        kind: "notes_to_self",
        idempotencyKey: `desktop-notes-${input.user.id}`
      }
    );
    snapshot = await input.repository.getAuthorizedSnapshot(
      { userId: input.user.id },
      { scope: "personal", includeArchived: true }
    );
    notes = snapshot?.threads.find((thread) => thread.kind === "notes_to_self");
  }
  if (!snapshot || !notes) return null;
  const mapped = snapshot.threads.map((thread) =>
    personalThreadFromRecord(thread, input.user)
  );
  if (mapped.some((thread) => thread === null)) return null;
  const mappedNotes = mapped.find((thread) => thread?.kind === "notes_to_self");
  if (!mappedNotes) return null;
  const messages = await personalMessagePage({
    repository: input.repository,
    credential: input.credential,
    user: input.user,
    thread: notes,
    direction: "older",
    cursor: null,
    limit: COLLABORATION_DEFAULT_LIMITS.historyPageMaxItems
  });
  if (!messages) return null;
  const personalMemory = await input.repository.listCapturedSessionSummaries(
    { userId: input.user.id },
    { limit: COLLABORATION_DEFAULT_LIMITS.historyPageMaxItems }
  );
  return {
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    snapshotRevision: personalSnapshotRevision(
      input.credential,
      input.user.id,
      snapshot.highWaterCursor
    ),
    generatedAt: new Date().toISOString(),
    connection: {
      state: "disconnected",
      backendId: null,
      connectedAt: null,
      retryAt: null,
      reconnectAttempt: 0,
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    },
    limits: COLLABORATION_DEFAULT_LIMITS,
    navigation: {
      personalOwner: {
        id: input.user.id,
        displayName: normalizedDisplayName(input.user),
        presence: "offline",
        membershipState: "enabled"
      },
      teamPrincipal: null,
      personal: {
        memory: personalMemory.map(personalMemoryEntryFromSummary),
        notesToSelf: mappedNotes,
        channels: mapped.filter((thread) => thread?.kind === "personal_channel")
      },
      teams: []
    },
    selection: { kind: "notes_to_self" },
    view: { kind: "thread", thread: mappedNotes, messages }
  };
};

const remotePersonalMessagePage = async (input: {
  fetcher: typeof fetch;
  credential: DesktopLocalCredentialAuthorization;
  context: PersonalRemoteContext;
  user: ActiveLocalUser;
  thread: z.infer<typeof canonicalThreadSchema>;
  direction: "older" | "newer";
  cursor: string | null;
  limit: number;
}): Promise<CollaborationMessagePage | null> => {
  if (
    input.thread.scope !== "personal" ||
    input.thread.personalOwnerUserId !== input.context.principal.id
  ) {
    return null;
  }
  const decoded = input.cursor
    ? decodePersonalCursor(input.credential, input.cursor, {
        ownerUserId: input.user.id,
        threadId: input.thread.id,
        direction: input.direction
      })
    : null;
  if (input.cursor && !decoded) throw new TypeError("Invalid message cursor");
  const snapshotSequence =
    decoded?.snapshotSequence ?? input.thread.latestSequence;
  if (snapshotSequence > input.thread.latestSequence) {
    throw new TypeError("Invalid message cursor snapshot");
  }
  const boundarySequence = decoded?.boundarySequence ?? 0;
  const path = queryPath(
    `/v1/collaboration/personal/threads/${encodeURIComponent(input.thread.id)}/messages`,
    input.direction === "older"
      ? {
          beforeSequence: decoded ? boundarySequence : snapshotSequence + 1,
          limit: input.limit
        }
      : {
          afterSequence: boundarySequence,
          beforeSequence: snapshotSequence + 1,
          limit: input.limit
        }
  );
  const payload = await requireRemoteJson(input.fetcher, {
    backend: input.context.backend,
    upstreamAuthorization: input.context.upstreamAuthorization,
    operationFamily: "personal_collaboration_read",
    method: "GET",
    path
  });
  const page = remoteMessagePageSchema.parse(payload);
  const messages = page.messages.map((value) => {
    const parsed = canonicalMessageSchema.safeParse(value);
    return parsed.success
      ? personalMessageFromRecord(
          parsed.data as CollaborationMessageRecord,
          input.user,
          input.thread.id,
          input.context.principal.id
        )
      : null;
  });
  if (messages.some((message) => message === null)) return null;
  const canonicalMessages = messages.filter(
    (message): message is NonNullable<typeof message> => message !== null
  );
  const firstSequence = canonicalMessages[0]?.sequence ?? null;
  const lastSequence = canonicalMessages.at(-1)?.sequence ?? null;
  const hasOlder = firstSequence !== null && firstSequence > 1;
  const hasNewer = lastSequence !== null && lastSequence < snapshotSequence;
  return {
    snapshotRevision: personalPageRevision(
      input.credential,
      input.user.id,
      input.thread.id,
      snapshotSequence
    ),
    olderCursor: hasOlder
      ? encodePersonalCursor(input.credential, {
          version: 1,
          ownerUserId: input.user.id,
          threadId: input.thread.id,
          direction: "older",
          boundarySequence: firstSequence!,
          snapshotSequence
        })
      : null,
    newerCursor: hasNewer
      ? encodePersonalCursor(input.credential, {
          version: 1,
          ownerUserId: input.user.id,
          threadId: input.thread.id,
          direction: "newer",
          boundarySequence: lastSequence!,
          snapshotSequence
        })
      : null,
    hasOlder,
    hasNewer,
    threadId: input.thread.id,
    items: canonicalMessages
  };
};

const loadRemotePersonalSnapshot = async (input: {
  fetcher: typeof fetch;
  credential: DesktopLocalCredentialAuthorization;
  context: PersonalRemoteContext;
  user: ActiveLocalUser;
  localSnapshot: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> => {
  const readSnapshot = async () =>
    remotePersonalSnapshotSchema.parse(
      await requireRemoteJson(input.fetcher, {
        backend: input.context.backend,
        upstreamAuthorization: input.context.upstreamAuthorization,
        operationFamily: "personal_collaboration_read",
        method: "GET",
        path: "/v1/collaboration/personal/snapshot"
      })
    ).snapshot;
  let snapshot = await readSnapshot();
  let notes = snapshot.threads.find(
    (thread) => thread.kind === "notes_to_self"
  );
  if (
    !notes &&
    input.context.operationFamilies.has("personal_collaboration_write")
  ) {
    await requireRemoteJson(input.fetcher, {
      backend: input.context.backend,
      upstreamAuthorization: input.context.upstreamAuthorization,
      operationFamily: "personal_collaboration_write",
      method: "POST",
      path: "/v1/collaboration/personal/notes-to-self",
      body: {},
      idempotencyKey: `desktop-notes-${input.context.principal.id}`
    });
    snapshot = await readSnapshot();
    notes = snapshot.threads.find((thread) => thread.kind === "notes_to_self");
  }
  if (snapshot.personalOwnerUserId !== input.context.principal.id || !notes) {
    return null;
  }
  const mapped = snapshot.threads.map((thread) =>
    personalThreadFromRecord(
      thread as CollaborationThreadRecord,
      input.user,
      input.context.principal.id
    )
  );
  if (mapped.some((thread) => thread === null)) return null;
  const mappedNotes = mapped.find((thread) => thread?.kind === "notes_to_self");
  if (!mappedNotes) return null;
  const messages = await remotePersonalMessagePage({
    fetcher: input.fetcher,
    credential: input.credential,
    context: input.context,
    user: input.user,
    thread: notes,
    direction: "older",
    cursor: null,
    limit: COLLABORATION_DEFAULT_LIMITS.historyPageMaxItems
  });
  if (!messages) return null;
  const navigation =
    input.localSnapshot.navigation &&
    typeof input.localSnapshot.navigation === "object" &&
    !Array.isArray(input.localSnapshot.navigation)
      ? (input.localSnapshot.navigation as Record<string, unknown>)
      : null;
  const personal =
    navigation?.personal &&
    typeof navigation.personal === "object" &&
    !Array.isArray(navigation.personal)
      ? (navigation.personal as Record<string, unknown>)
      : null;
  if (!navigation || !personal) return null;
  return {
    ...input.localSnapshot,
    snapshotRevision: personalSnapshotRevision(
      input.credential,
      input.user.id,
      snapshot.highWaterCursor
    ),
    generatedAt: new Date().toISOString(),
    connection: {
      state: "live",
      backendId: input.context.backendId,
      connectedAt: new Date().toISOString(),
      retryAt: null,
      reconnectAttempt: 0,
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    },
    navigation: {
      ...navigation,
      personal: {
        ...personal,
        notesToSelf: mappedNotes,
        channels: mapped.filter((thread) => thread?.kind === "personal_channel")
      }
    },
    selection: { kind: "notes_to_self" },
    view: { kind: "thread", thread: mappedNotes, messages }
  };
};

const threadDtoFromRemote = (
  value: unknown
): Record<string, unknown> | null => {
  const dto = targetThreadFrom(value, {
    command: "collaboration.load_message_page",
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-000000000000",
    input: {
      thread: {
        scope: "team",
        teamId: "00000000-0000-4000-8000-000000000000",
        threadId: "00000000-0000-4000-8000-000000000000"
      },
      direction: "older",
      cursor: null,
      limit: 1
    }
  } as SupportedCommand);
  return dto && typeof dto === "object" && !Array.isArray(dto)
    ? (dto as Record<string, unknown>)
    : null;
};

const loadRemoteTeamNavigation = async (input: {
  fetcher: typeof fetch;
  credential: DesktopLocalCredentialAuthorization;
  context: TeamReadContext;
}): Promise<{
  snapshotRevision: string;
  teamPresenceStatusCatalogue: z.infer<
    typeof collaborationTeamPresenceStatusCatalogueSchema
  >;
  teamPrincipal: Record<string, unknown>;
  teams: Record<string, unknown>[];
}> => {
  const payload = remoteTeamNavigationSchema.parse(
    await requireRemoteJson(input.fetcher, {
      backend: input.context.backend,
      upstreamAuthorization: input.context.upstreamAuthorization,
      operationFamily: "team_workspace_read",
      method: "GET",
      path: "/v1/teams/navigation"
    })
  );
  if (
    payload.principal.id !== input.context.principal.id ||
    !input.context.operationFamilies.has("team_chat_read")
  ) {
    throw Object.assign(new Error("Remote Team principal is invalid"), {
      collaborationSafeError: safeError("permission_denied")
    });
  }
  const principal = remotePrincipalPersonFrom(payload.principal);
  const navigationTeams: Record<string, unknown>[] = [];

  for (const entry of payload.teams) {
    const { team, membership } = entry;
    if (
      membership.teamId !== team.id ||
      membership.userId !== input.context.principal.id ||
      membership.status !== "enabled"
    ) {
      throw Object.assign(new Error("Remote Team membership is invalid"), {
        collaborationSafeError: safeError("permission_denied")
      });
    }
    const people = entry.members;
    if (
      !people.some((person) => person.userId === input.context.principal.id)
    ) {
      throw Object.assign(new Error("Remote Team principal is absent"), {
        collaborationSafeError: safeError("permission_denied")
      });
    }
    const threads = entry.threads
      .map(threadDtoFromRemote)
      .filter((thread): thread is Record<string, unknown> => thread !== null)
      .filter((thread) => thread.teamId === team.id);
    const directMessages = threads.filter(
      (thread) => thread.kind === "dm" || thread.kind === "group_dm"
    );
    const workspaces = entry.workspaces
      .filter(({ teamWorkspace }) => teamWorkspace.teamId === team.id)
      .filter(({ teamWorkspace }) => teamWorkspace.lifecycle === "active");
    const mappedWorkspaces: Record<string, unknown>[] = [];
    for (const {
      teamWorkspace: workspace,
      access,
      shareGrants
    } of workspaces) {
      if (
        access.teamId !== team.id ||
        access.teamWorkspaceId !== workspace.id ||
        access.userId !== input.context.principal.id
      ) {
        throw Object.assign(new Error("Remote Workspace access is invalid"), {
          collaborationSafeError: safeError("permission_denied")
        });
      }
      const channels = threads.filter(
        (thread) =>
          thread.kind === "workspace_channel" &&
          thread.workspaceId === workspace.id
      );
      const companionThreads = threads.filter(
        (thread) =>
          thread.kind === "shared_session_discussion" &&
          thread.workspaceId === workspace.id
      );
      const sharedGrants = shareGrants.filter(
        (grant) =>
          grant.companionScope.teamId === team.id &&
          grant.companionScope.teamWorkspaceId === workspace.id &&
          grant.companionScope.logicalMemoryId === grant.logicalMemoryId &&
          grant.companionScope.shareGrantId === grant.id
      );
      const sharedMemory = sharedGrants.flatMap((grant) => {
        const companion = companionThreads.find(
          (thread) => thread.shareGrantId === grant.id
        );
        if (
          !companion ||
          typeof companion.id !== "string" ||
          typeof companion.unreadCount !== "number"
        ) {
          return [];
        }
        return [
          {
            id: grant.id,
            logicalMemoryId: grant.logicalMemoryId,
            shareGrantId: grant.id,
            teamId: team.id,
            workspaceId: workspace.id,
            owner: {
              id: grant.ownerUserId ?? input.context.principal.id,
              displayName:
                people.find((person) => person.userId === grant.ownerUserId)
                  ?.displayName ?? "Team member",
              membershipState: "enabled"
            },
            title: "Shared Memory",
            latestActivityAt: grant.updatedAt,
            representation: grant.activeRepresentation,
            representationState:
              grant.representationState === "stale" ? "stale" : "current",
            liveState: "live",
            sourceState: "ready",
            sourceRevision: `ssr1.${sha256(
              `${grant.id}:${grant.representationSourceRevision}`
            )}`,
            companionThreadId: companion.id,
            unreadCompanionCount: companion.unreadCount,
            version: 1
          }
        ];
      });
      mappedWorkspaces.push({
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        access: access.access,
        lifecycle: mappedWorkspaceLifecycle(workspace.lifecycle),
        version: workspace.version,
        channels,
        sharedMemory
      });
    }
    navigationTeams.push({
      id: team.id,
      name: team.name,
      role: membership.role,
      lifecycle: team.lifecycle,
      unreadCount: threads.reduce(
        (count, thread) =>
          count +
          (typeof thread.unreadCount === "number" ? thread.unreadCount : 0),
        0
      ),
      people: people.map(remotePersonFrom),
      directMessages,
      workspaces: mappedWorkspaces,
      version: team.version
    });
  }

  return {
    snapshotRevision: teamSnapshotRevision(
      input.credential,
      input.context.backendId,
      input.context.principal.id,
      {
        teams: navigationTeams.map((team) => ({
          id: team.id,
          version: team.version,
          workspaces: Array.isArray(team.workspaces)
            ? team.workspaces.map((workspace) =>
                workspace && typeof workspace === "object"
                  ? {
                      id: (workspace as { id?: unknown }).id,
                      version: (workspace as { version?: unknown }).version
                    }
                  : null
              )
            : []
        }))
      }
    ),
    teamPresenceStatusCatalogue: payload.teamPresenceStatusCatalogue,
    teamPrincipal: principal,
    teams: navigationTeams
  };
};

type ConnectedRemoteTeamNavigation = Awaited<
  ReturnType<typeof loadRemoteTeamNavigation>
> & {
  backendId: string;
};

const loadPersonalSelection = async (input: {
  snapshot: CollaborationSnapshot;
  repository: CollaborationRepository;
  credential: DesktopLocalCredentialAuthorization;
  user: ActiveLocalUser;
  selection: CollaborationSelection;
}): Promise<CollaborationView | null> => {
  if (input.selection.kind === "personal_memory") {
    return {
      kind: "personal_memory",
      entries: input.snapshot.navigation.personal.memory
    };
  }
  const threadId =
    input.selection.kind === "notes_to_self"
      ? input.snapshot.navigation.personal.notesToSelf.id
      : input.selection.kind === "personal_channel"
        ? input.selection.threadId
        : null;
  if (!threadId) return null;
  const thread = await requirePersonalThreadRecord(
    input.repository,
    input.user.id,
    threadId,
    true
  );
  if (!thread) return null;
  const mapped = personalThreadFromRecord(thread, input.user);
  if (
    !mapped ||
    (input.selection.kind === "notes_to_self" &&
      mapped.kind !== "notes_to_self") ||
    (input.selection.kind === "personal_channel" &&
      mapped.kind !== "personal_channel")
  ) {
    return null;
  }
  const messages = await personalMessagePage({
    repository: input.repository,
    credential: input.credential,
    user: input.user,
    thread,
    direction: "older",
    cursor: null,
    limit: COLLABORATION_DEFAULT_LIMITS.historyPageMaxItems
  });
  return messages ? { kind: "thread", thread: mapped, messages } : null;
};

const loadRemotePersonalSelection = async (input: {
  fetcher: typeof fetch;
  snapshot: CollaborationSnapshot;
  credential: DesktopLocalCredentialAuthorization;
  context: PersonalRemoteContext;
  user: ActiveLocalUser;
  selection: CollaborationSelection;
}): Promise<CollaborationView | null> => {
  if (input.selection.kind === "personal_memory") {
    return {
      kind: "personal_memory",
      entries: input.snapshot.navigation.personal.memory
    };
  }
  const threadId =
    input.selection.kind === "notes_to_self"
      ? input.snapshot.navigation.personal.notesToSelf.id
      : input.selection.kind === "personal_channel"
        ? input.selection.threadId
        : null;
  if (!threadId) return null;
  const payload = await requireRemoteJson(input.fetcher, {
    backend: input.context.backend,
    upstreamAuthorization: input.context.upstreamAuthorization,
    operationFamily: "personal_collaboration_read",
    method: "GET",
    path: `/v1/collaboration/personal/threads/${encodeURIComponent(threadId)}`
  });
  const parsedThread = canonicalThreadSchema.safeParse(payload.thread);
  if (
    !parsedThread.success ||
    parsedThread.data.scope !== "personal" ||
    parsedThread.data.personalOwnerUserId !== input.context.principal.id
  ) {
    return null;
  }
  const mapped = personalThreadFromRecord(
    parsedThread.data as CollaborationThreadRecord,
    input.user,
    input.context.principal.id
  );
  if (
    !mapped ||
    (input.selection.kind === "notes_to_self" &&
      mapped.kind !== "notes_to_self") ||
    (input.selection.kind === "personal_channel" &&
      mapped.kind !== "personal_channel")
  ) {
    return null;
  }
  const messages = await remotePersonalMessagePage({
    fetcher: input.fetcher,
    credential: input.credential,
    context: input.context,
    user: input.user,
    thread: parsedThread.data,
    direction: "older",
    cursor: null,
    limit: COLLABORATION_DEFAULT_LIMITS.historyPageMaxItems
  });
  return messages ? { kind: "thread", thread: mapped, messages } : null;
};

const teamMessagePage = async (input: {
  fetcher: typeof fetch;
  credential: DesktopLocalCredentialAuthorization;
  context: TeamReadContext;
  teamId: string;
  thread: Record<string, unknown>;
  direction: "older" | "newer";
  cursor: string | null;
  limit: number;
  prefetchedPage?: unknown;
}): Promise<CollaborationMessagePage | null> => {
  if (
    input.thread.scope !== "team" ||
    input.thread.teamId !== input.teamId ||
    typeof input.thread.id !== "string" ||
    typeof input.thread.latestSequence !== "number"
  ) {
    return null;
  }
  const decoded = input.cursor
    ? decodeTeamMessageCursor(input.credential, input.cursor, {
        backendId: input.context.backendId,
        principalUserId: input.context.principal.id,
        teamId: input.teamId,
        threadId: input.thread.id,
        direction: input.direction
      })
    : null;
  if (input.cursor && !decoded) throw new TypeError("Invalid message cursor");
  const snapshotSequence =
    decoded?.snapshotSequence ?? input.thread.latestSequence;
  if (snapshotSequence > input.thread.latestSequence) {
    throw new TypeError("Invalid message cursor snapshot");
  }
  const boundarySequence = decoded?.boundarySequence ?? 0;
  const payload =
    input.prefetchedPage ??
    (await requireRemoteJson(input.fetcher, {
      backend: input.context.backend,
      upstreamAuthorization: input.context.upstreamAuthorization,
      operationFamily: "team_chat_read",
      method: "GET",
      path: queryPath(
        `/v1/collaboration/teams/${encodeURIComponent(input.teamId)}/threads/${encodeURIComponent(input.thread.id)}/messages`,
        input.direction === "older"
          ? {
              beforeSequence: decoded ? boundarySequence : snapshotSequence + 1,
              limit: input.limit
            }
          : {
              afterSequence: boundarySequence,
              beforeSequence: snapshotSequence + 1,
              limit: input.limit
            }
      )
    }));
  const page = remoteMessagePageSchema.parse(payload);
  const messages = page.messages
    .map(targetMessageFrom)
    .filter(
      (message): message is Record<string, unknown> =>
        Boolean(message) &&
        typeof message === "object" &&
        !Array.isArray(message)
    );
  if (
    messages.length !== page.messages.length ||
    messages.some(
      (message) =>
        message.scope !== "team" ||
        message.teamId !== input.teamId ||
        message.threadId !== input.thread.id
    )
  ) {
    return null;
  }
  const firstSequence =
    typeof messages[0]?.sequence === "number" ? messages[0].sequence : null;
  const lastSequence =
    typeof messages.at(-1)?.sequence === "number"
      ? (messages.at(-1)!.sequence as number)
      : null;
  const hasOlder = firstSequence !== null && firstSequence > 1;
  const hasNewer = lastSequence !== null && lastSequence < snapshotSequence;
  const cursorBase = {
    version: 1 as const,
    backendId: input.context.backendId,
    principalUserId: input.context.principal.id,
    teamId: input.teamId,
    threadId: input.thread.id,
    snapshotSequence
  };
  return {
    snapshotRevision: teamPageRevision(input.credential, cursorBase),
    olderCursor: hasOlder
      ? encodeTeamMessageCursor(input.credential, {
          ...cursorBase,
          direction: "older",
          boundarySequence: firstSequence!
        })
      : null,
    newerCursor: hasNewer
      ? encodeTeamMessageCursor(input.credential, {
          ...cursorBase,
          direction: "newer",
          boundarySequence: lastSequence!
        })
      : null,
    hasOlder,
    hasNewer,
    threadId: input.thread.id,
    items: messages as CollaborationMessagePage["items"]
  };
};

const findTeamInSnapshot = (
  snapshot: CollaborationSnapshot,
  teamId: string
): CollaborationSnapshot["navigation"]["teams"][number] | null =>
  snapshot.navigation.teams.find((team) => team.id === teamId) ?? null;

const findSharedSessionInSnapshot = (
  snapshot: CollaborationSnapshot,
  reference: SharedMemorySessionReference
): SharedMemorySession | null => {
  const team = findTeamInSnapshot(snapshot, reference.teamId);
  const workspace = team?.workspaces.find(
    (candidate) => candidate.id === reference.workspaceId
  );
  return (
    workspace?.sharedMemory.find(
      (candidate) => candidate.id === reference.sharedSessionId
    ) ?? null
  );
};

const loadTeamSelection = async (input: {
  fetcher: typeof fetch;
  credential: DesktopLocalCredentialAuthorization;
  context: TeamReadContext;
  snapshot: CollaborationSnapshot;
  selection: CollaborationSelection;
  loadSharedInitialView: (session: SharedMemorySession) => Promise<{
    source: SharedMemorySourcePage;
    thread: unknown;
    messages: unknown;
  } | null>;
}): Promise<CollaborationView | null> => {
  const selection = input.selection;
  if (!("teamId" in selection)) return null;
  const team = findTeamInSnapshot(input.snapshot, selection.teamId);
  if (!team) return null;
  if (selection.kind === "team_people") {
    const canManage = team.role === "owner" || team.role === "admin";
    const payload = await requireRemoteJson(input.fetcher, {
      backend: input.context.backend,
      upstreamAuthorization: input.context.upstreamAuthorization,
      operationFamily: "team_workspace_read",
      method: "GET",
      path: `/v1/teams/${encodeURIComponent(selection.teamId)}/members${canManage ? "/manage" : ""}`
    });
    if (canManage) {
      const people = z
        .array(remoteManagementMemberSchema)
        .parse(payload.members);
      if (
        !people.some((person) => person.userId === input.context.principal.id)
      ) {
        return null;
      }
      return {
        kind: "team_people",
        teamId: selection.teamId,
        people: people.map(remoteManagedPersonFrom)
      } as unknown as CollaborationView;
    }
    const people = z.array(remoteRosterMemberSchema).parse(payload.members);
    if (!people.some((person) => person.userId === input.context.principal.id))
      return null;
    return {
      kind: "team_people",
      teamId: selection.teamId,
      people: people.map(remotePersonFrom)
    } as unknown as CollaborationView;
  }
  if (selection.kind === "workspace_shared_memory") {
    const workspace = team.workspaces.find(
      (candidate) => candidate.id === selection.workspaceId
    );
    return workspace
      ? {
          kind: "shared_memory_index",
          teamId: selection.teamId,
          workspaceId: selection.workspaceId,
          sessions: workspace.sharedMemory
        }
      : null;
  }
  if (
    selection.kind === "workspace_channel" ||
    selection.kind === "team_direct_message"
  ) {
    const threadPayload = await requireRemoteJson(input.fetcher, {
      backend: input.context.backend,
      upstreamAuthorization: input.context.upstreamAuthorization,
      operationFamily: "team_chat_read",
      method: "GET",
      path: `/v1/collaboration/teams/${encodeURIComponent(selection.teamId)}/threads/${encodeURIComponent(selection.threadId)}`
    });
    const thread = threadDtoFromRemote(threadPayload.thread);
    if (
      !thread ||
      thread.id !== selection.threadId ||
      thread.teamId !== selection.teamId
    ) {
      return null;
    }
    if (
      selection.kind === "workspace_channel" &&
      (thread.kind !== "workspace_channel" ||
        thread.workspaceId !== selection.workspaceId)
    ) {
      return null;
    }
    if (
      selection.kind === "team_direct_message" &&
      thread.kind !== "dm" &&
      thread.kind !== "group_dm"
    ) {
      return null;
    }
    const messages = await teamMessagePage({
      fetcher: input.fetcher,
      credential: input.credential,
      context: input.context,
      teamId: selection.teamId,
      thread,
      direction: "older",
      cursor: null,
      limit: COLLABORATION_DEFAULT_LIMITS.historyPageMaxItems
    });
    return messages
      ? ({ kind: "thread", thread, messages } as CollaborationView)
      : null;
  }
  if (selection.kind === "shared_session") {
    const session = findSharedSessionInSnapshot(input.snapshot, selection);
    if (!session) return null;
    const initial = await input.loadSharedInitialView(session);
    if (!initial) return null;
    const thread = threadDtoFromRemote(initial.thread);
    if (
      !thread ||
      thread.id !== session.companionThreadId ||
      thread.kind !== "shared_session_discussion" ||
      thread.teamId !== selection.teamId ||
      thread.workspaceId !== selection.workspaceId ||
      thread.sharedLogicalMemoryId !== session.logicalMemoryId ||
      thread.shareGrantId !== session.shareGrantId ||
      typeof thread.unreadCount !== "number"
    ) {
      return null;
    }
    const selectedSession = {
      ...session,
      unreadCompanionCount: thread.unreadCount
    };
    const source = initial.source;
    const messages = await teamMessagePage({
      fetcher: input.fetcher,
      credential: input.credential,
      context: input.context,
      teamId: selection.teamId,
      thread,
      direction: "older",
      cursor: null,
      limit: COLLABORATION_DEFAULT_LIMITS.historyPageMaxItems,
      prefetchedPage: initial.messages
    });
    return source && messages
      ? ({
          kind: "shared_session",
          session: selectedSession,
          source,
          companion: { thread, messages }
        } as CollaborationView)
      : null;
  }
  return null;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const personalSubscriptionFromRecord = (
  record: CollaborationSubscriptionRecord,
  ownerUserId: string
): Record<string, unknown> | null =>
  record.scope === "personal" &&
  record.personalOwnerUserId === ownerUserId &&
  record.teamId === null
    ? {
        id: record.id,
        scope: { scope: "personal" },
        state: record.state,
        version: 1,
        expiresAt: record.expiresAt
      }
    : null;

const snapshotWithRemoteNavigation = (
  personalSnapshot: Record<string, unknown>,
  remote: ConnectedRemoteTeamNavigation | null,
  unavailableBackendId: string | null = null,
  reportValidationFailure?: (
    issues: Array<{ code: string; message: string; path: string[] }>
  ) => void
): CollaborationSnapshot | null => {
  const navigation =
    personalSnapshot.navigation &&
    typeof personalSnapshot.navigation === "object" &&
    !Array.isArray(personalSnapshot.navigation)
      ? (personalSnapshot.navigation as Record<string, unknown>)
      : null;
  if (!navigation) return null;
  const personalConnection =
    personalSnapshot.connection &&
    typeof personalSnapshot.connection === "object" &&
    !Array.isArray(personalSnapshot.connection)
      ? (personalSnapshot.connection as Record<string, unknown>)
      : null;
  const personalRemoteLive =
    personalConnection?.state === "live" &&
    typeof personalConnection.backendId === "string";
  const snapshot = {
    ...personalSnapshot,
    snapshotRevision:
      remote?.snapshotRevision ?? personalSnapshot.snapshotRevision,
    ...(remote
      ? { teamPresenceStatusCatalogue: remote.teamPresenceStatusCatalogue }
      : {}),
    connection: remote
      ? {
          state: "live",
          backendId: remote.backendId,
          connectedAt: new Date().toISOString(),
          retryAt: null,
          reconnectAttempt: 0,
          protocolVersion: COLLABORATION_CONTRACT_VERSION
        }
      : personalRemoteLive
        ? personalConnection
        : unavailableBackendId
          ? {
              state: "unavailable",
              backendId: unavailableBackendId,
              connectedAt: null,
              retryAt: null,
              reconnectAttempt: 0,
              protocolVersion: COLLABORATION_CONTRACT_VERSION
            }
          : personalSnapshot.connection,
    navigation: {
      ...navigation,
      teamPrincipal: remote?.teamPrincipal ?? null,
      teams: remote?.teams ?? []
    }
  };
  const parsed = collaborationCommandResultSchema.safeParse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: "00000000-0000-4000-8000-000000000000",
    command: "collaboration.load",
    ok: true,
    data: { snapshot }
  });
  if (!parsed.success) {
    reportValidationFailure?.(
      parsed.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.map(String)
      }))
    );
  }
  return parsed.success &&
    parsed.data.ok &&
    parsed.data.command === "collaboration.load"
    ? parsed.data.data.snapshot
    : null;
};

const personalErrorFor = (error: unknown): CollaborationSafeError => {
  if (
    error instanceof CollaborationIdempotencyConflictError ||
    error instanceof CollaborationStateConflictError ||
    error instanceof CollaborationVersionConflictError
  ) {
    return safeError("conflict");
  }
  if (error instanceof TypeError || error instanceof z.ZodError) {
    return safeError("invalid_input");
  }
  return safeError("internal_error");
};

const dispatchRemotePersonalCommand = async (input: {
  fetcher: typeof fetch;
  command: PersonalCommand;
  context: PersonalRemoteContext;
  user: ActiveLocalUser;
}): Promise<CollaborationCommandResult> => {
  const operation = personalCollaborationOperationFor(input.command);
  if (!operation) {
    return failureResult(input.command, safeError("not_available"));
  }
  if (!input.context.operationFamilies.has(operation.operationFamily)) {
    return failureResult(input.command, safeError("permission_denied"));
  }
  try {
    const payload = await requireRemoteJson(input.fetcher, {
      backend: input.context.backend,
      upstreamAuthorization: input.context.upstreamAuthorization,
      operationFamily: operation.operationFamily,
      method: operation.method,
      path: operation.path,
      body: operation.body,
      idempotencyKey: operation.idempotencyKey
    });
    let value: unknown = null;
    if (operation.resultKey === "thread") {
      const parsed = canonicalThreadSchema.safeParse(payload.thread);
      value =
        parsed.success &&
        parsed.data.scope === "personal" &&
        parsed.data.personalOwnerUserId === input.context.principal.id
          ? personalThreadFromRecord(
              parsed.data as CollaborationThreadRecord,
              input.user,
              input.context.principal.id
            )
          : null;
    } else if (operation.resultKey === "message") {
      const parsed = canonicalMessageSchema.safeParse(payload.message);
      value =
        parsed.success &&
        parsed.data.scope === "personal" &&
        input.command.command !== "collaboration.create_notes_to_self" &&
        "thread" in input.command.input
          ? personalMessageFromRecord(
              parsed.data as CollaborationMessageRecord,
              input.user,
              input.command.input.thread.threadId,
              input.context.principal.id
            )
          : null;
    } else {
      const parsed = canonicalReadStateSchema.safeParse(payload.readState);
      value =
        parsed.success &&
        (input.command.command === "collaboration.mark_read" ||
          input.command.command === "collaboration.mark_delivered")
          ? personalReadStateFromRecord(
              parsed.data as CollaborationReadStateRecord,
              input.context.principal.id,
              input.command.input.thread.threadId
            )
          : null;
    }
    if (!value) {
      return failureResult(input.command, safeError("internal_error"));
    }
    return (
      personalSuccessResult(input.command, {
        [operation.resultKey]: value
      }) ?? failureResult(input.command, safeError("internal_error"))
    );
  } catch (error) {
    return failureResult(input.command, safeErrorFromUnknown(error));
  }
};

const dispatchPersonalCommand = async (input: {
  command: PersonalCommand;
  repository: CollaborationRepository &
    Pick<CapturedSessionRepository, "listCapturedSessionSummaries">;
  credential: DesktopLocalCredentialAuthorization;
  user: ActiveLocalUser;
}): Promise<CollaborationCommandResult> => {
  const { command, repository, credential, user } = input;
  const unavailable = () =>
    failureResult(command, safeError("permission_denied"));
  const invalidResult = () =>
    failureResult(command, safeError("internal_error"));
  try {
    switch (command.command) {
      case "collaboration.load": {
        const snapshot = await loadPersonalSnapshot({
          repository,
          credential,
          user
        });
        return snapshot
          ? (personalSuccessResult(command, { snapshot }) ?? invalidResult())
          : unavailable();
      }
      case "collaboration.select":
        return unavailable();
      case "collaboration.create_notes_to_self":
      case "collaboration.create_personal_channel": {
        const thread = await repository.createThread(
          { userId: user.id },
          command.command === "collaboration.create_notes_to_self"
            ? { kind: "notes_to_self", idempotencyKey: command.requestId }
            : {
                kind: "personal_channel",
                idempotencyKey: command.requestId,
                name: command.input.name,
                topic: command.input.topic
              }
        );
        if (!thread) return unavailable();
        const mapped = personalThreadFromRecord(thread, user);
        if (
          !mapped ||
          (command.command === "collaboration.create_personal_channel" &&
            (mapped.kind !== "personal_channel" ||
              mapped.name !== command.input.name ||
              mapped.topic !== command.input.topic))
        ) {
          return invalidResult();
        }
        return (
          personalSuccessResult(command, { thread: mapped }) ?? invalidResult()
        );
      }
      case "collaboration.rename_thread":
      case "collaboration.update_thread_topic":
      case "collaboration.archive_thread":
      case "collaboration.restore_thread": {
        const reference = command.input.thread;
        const existing = await requirePersonalThreadRecord(
          repository,
          user.id,
          reference.threadId,
          command.command === "collaboration.restore_thread"
        );
        if (!existing) return unavailable();
        const thread =
          command.command === "collaboration.rename_thread"
            ? await repository.renameThread(
                { userId: user.id },
                {
                  threadId: reference.threadId,
                  expectedVersion: command.input.expectedVersion,
                  name: command.input.name
                }
              )
            : command.command === "collaboration.update_thread_topic"
              ? await repository.updateThreadTopic(
                  { userId: user.id },
                  {
                    threadId: reference.threadId,
                    expectedVersion: command.input.expectedVersion,
                    topic: command.input.topic
                  }
                )
              : command.command === "collaboration.archive_thread"
                ? await repository.archiveThread(
                    { userId: user.id },
                    {
                      threadId: reference.threadId,
                      expectedVersion: command.input.expectedVersion
                    }
                  )
                : await repository.restoreThread(
                    { userId: user.id },
                    {
                      threadId: reference.threadId,
                      expectedVersion: command.input.expectedVersion
                    }
                  );
        if (!thread) return unavailable();
        const mapped = personalThreadFromRecord(thread, user);
        const matches =
          mapped?.id === reference.threadId &&
          (command.command !== "collaboration.rename_thread" ||
            mapped.name === command.input.name) &&
          (command.command !== "collaboration.update_thread_topic" ||
            mapped.topic === command.input.topic) &&
          (command.command !== "collaboration.archive_thread" ||
            mapped.lifecycle === "archived") &&
          (command.command !== "collaboration.restore_thread" ||
            mapped.lifecycle === "active");
        return matches
          ? (personalSuccessResult(command, { thread: mapped }) ??
              invalidResult())
          : invalidResult();
      }
      case "collaboration.send_message":
      case "collaboration.retry_message": {
        const existing = await requirePersonalThreadRecord(
          repository,
          user.id,
          command.input.thread.threadId,
          false
        );
        if (!existing) return unavailable();
        const message = await repository.sendMessage(
          { userId: user.id },
          {
            threadId: existing.id,
            idempotencyKey: command.input.clientMessageId,
            bodyText: command.input.body
          }
        );
        if (!message) return unavailable();
        const mapped = personalMessageFromRecord(message, user, existing.id);
        return mapped?.body === command.input.body
          ? (personalSuccessResult(command, { message: mapped }) ??
              invalidResult())
          : invalidResult();
      }
      case "collaboration.mark_read": {
        const existing = await requirePersonalThreadRecord(
          repository,
          user.id,
          command.input.thread.threadId,
          true
        );
        if (!existing) return unavailable();
        const readState = await repository.advanceReadState(
          { userId: user.id },
          { threadId: existing.id, messageId: command.input.messageId }
        );
        if (!readState) return unavailable();
        const mapped = personalReadStateFromRecord(
          readState,
          user.id,
          existing.id
        );
        return mapped?.messageId === command.input.messageId
          ? (personalSuccessResult(command, { readState: mapped }) ??
              invalidResult())
          : invalidResult();
      }
      case "collaboration.mark_delivered": {
        const existing = await requirePersonalThreadRecord(
          repository,
          user.id,
          command.input.thread.threadId,
          true
        );
        if (!existing) return unavailable();
        const readState = await repository.advanceDeliveryState(
          { userId: user.id },
          { threadId: existing.id, messageId: command.input.messageId }
        );
        if (!readState) return unavailable();
        const mapped = personalReadStateFromRecord(
          readState,
          user.id,
          existing.id
        );
        return mapped?.deliveredMessageId === command.input.messageId
          ? (personalSuccessResult(command, { readState: mapped }) ??
              invalidResult())
          : invalidResult();
      }
      case "collaboration.load_message_page": {
        const existing = await requirePersonalThreadRecord(
          repository,
          user.id,
          command.input.thread.threadId,
          true
        );
        if (!existing) return unavailable();
        const page = await personalMessagePage({
          repository,
          credential,
          user,
          thread: existing,
          direction: command.input.direction,
          cursor: command.input.cursor,
          limit: command.input.limit
        });
        return page
          ? (personalSuccessResult(command, { page }) ?? invalidResult())
          : unavailable();
      }
      case "collaboration.subscribe": {
        const snapshot = await repository.getAuthorizedSnapshot(
          { userId: user.id },
          { scope: "personal", includeArchived: true }
        );
        if (!snapshot) return unavailable();
        const expiresAt = new Date(Date.now() + PERSONAL_SUBSCRIPTION_TTL_MS);
        const subscription = await repository.createSubscription(
          { userId: user.id },
          {
            scope: "personal",
            backendIdentityHash: sha256("koed:desktop-local"),
            principalIdHash: collaborationSubscriptionPrincipalHash(user.id),
            deviceCredentialId: null,
            clientInstanceHash: sha256(credential.credentialKeyId),
            subscriptionKeyHash: sha256(
              `personal:${user.id}:${credential.credentialKeyId}`
            ),
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            snapshotHighWaterCursor: snapshot.highWaterCursor,
            expiresAt
          }
        );
        if (!subscription) return unavailable();
        const mapped = personalSubscriptionFromRecord(subscription, user.id);
        return mapped
          ? (personalSuccessResult(command, { subscription: mapped }) ??
              invalidResult())
          : invalidResult();
      }
    }
  } catch (error) {
    return failureResult(command, personalErrorFor(error));
  }
};

export const registerCollaborationCommandRoute = (
  app: FastifyInstance,
  options: CollaborationCommandRouteOptions
): void => {
  const readLocalEdgeCredential =
    options.readLocalEdgeClientCredential ??
    readLocalEdgeClientCredentialAuthorization;
  const verifyDesktopCredential =
    options.verifyDesktopLocalCredential ?? verifyStoredDesktopLocalCredential;
  const readRegistry =
    options.readUpstreamRegistry ?? readLocalEdgeUpstreamRegistry;
  const routeOptions = { bodyLimit: COMMAND_BODY_LIMIT_BYTES };
  const remoteNavigationCache = new Map<
    string,
    {
      storedAt: number;
      value: ConnectedRemoteTeamNavigation;
    }
  >();
  const remoteNavigationInFlight = new Map<
    string,
    Promise<ConnectedRemoteTeamNavigation>
  >();
  const REMOTE_NAVIGATION_CACHE_MAX = 32;
  const REMOTE_NAVIGATION_CACHE_RETENTION_MS = 15 * 60_000;
  const removeNavigationInvalidationListener =
    options.subscribeRemoteNavigationInvalidation?.((backendId) => {
      for (const [key, entry] of remoteNavigationCache) {
        if (entry.value.backendId === backendId) {
          remoteNavigationCache.delete(key);
        }
      }
    });
  if (removeNavigationInvalidationListener) {
    app.addHook("onClose", () => {
      removeNavigationInvalidationListener();
    });
  }

  const resolvePersonalRemoteContext = async (
    operationFamily:
      | "personal_collaboration_read"
      | "personal_collaboration_write"
  ): Promise<PersonalRemoteContext | null> => {
    const backend = activeUpstreamBackend(
      readRegistry(options.upstreamBackendsPath)
    );
    if (!backend) return null;
    if (backend.routePolicy.personalCollaboration !== "enabled") return null;
    if (!isSafeBackend(backend)) {
      throw Object.assign(new Error("Upstream backend is unsafe"), {
        collaborationSafeError: safeError("temporarily_unavailable")
      });
    }
    const upstreamAuthorization = options.resolveUpstreamAuthorization(backend);
    const localEdgeCredential = readLocalEdgeCredential(
      options.koedHome,
      backend.id
    );
    if (
      !upstreamAuthorization ||
      !localEdgeCredential ||
      localEdgeCredential.backendId !== backend.id ||
      !localEdgeCredential.operationFamilies.includes(operationFamily)
    ) {
      throw Object.assign(
        new Error("Personal collaboration authority is unavailable"),
        { collaborationSafeError: safeError("permission_denied") }
      );
    }
    const decision = resolveLocalEdgeRouteDecision({
      operationFamily,
      requestedMode: "live_upstream_proxy",
      upstreamBackend: backend,
      upstreamBackendId: backend.id,
      deviceCredential: {
        upstreamBackendId: backend.id,
        operationFamilies: localEdgeCredential.operationFamilies
      },
      upstreamCredentialAvailable: true
    });
    if (
      decision.action !== "live_upstream_proxy" ||
      !supportsCollaborationCommands(backend)
    ) {
      throw Object.assign(
        new Error("Personal collaboration authority is unavailable"),
        { collaborationSafeError: safeError("temporarily_unavailable") }
      );
    }
    const status = await requireRemoteJson(options.fetch, {
      backend,
      upstreamAuthorization,
      operationFamily,
      method: "GET",
      path: "/v1/local-edge/device-credentials/status"
    });
    const parsedStatus = remoteDeviceStatusSchema.parse(status);
    const operationFamilies = new Set<
      "personal_collaboration_read" | "personal_collaboration_write"
    >();
    for (const family of parsedStatus.credential.operationFamilies) {
      if (
        family === "personal_collaboration_read" ||
        family === "personal_collaboration_write"
      ) {
        operationFamilies.add(family);
      }
    }
    if (!operationFamilies.has(operationFamily)) {
      throw Object.assign(
        new Error("Personal collaboration authority is unavailable"),
        { collaborationSafeError: safeError("permission_denied") }
      );
    }
    return {
      backend,
      backendId: backend.id,
      upstreamAuthorization,
      upstreamDeviceCredentialId: parsedStatus.credential.id,
      operationFamilies,
      principal: parsedStatus.user
    };
  };

  const resolveTeamReadContext = async (
    operationFamily:
      | "team_workspace_read"
      | "team_chat_read"
      | "team_chat_write"
      | "admin"
      | "action_grant"
      | "share_grant_management"
      | "managed_execution",
    backendId?: string
  ): Promise<TeamReadContext | null> => {
    const registry = readRegistry(options.upstreamBackendsPath);
    const backend = backendId
      ? upstreamBackendById(registry, backendId)
      : activeUpstreamBackend(registry);
    if (!backend || !isSafeBackend(backend)) return null;
    const upstreamAuthorization = options.resolveUpstreamAuthorization(backend);
    const isDesktopMediatedFamily =
      operationFamily === "action_grant" ||
      operationFamily === "share_grant_management" ||
      operationFamily === "managed_execution";
    const localEdgeCredential = isDesktopMediatedFamily
      ? null
      : readLocalEdgeCredential(options.koedHome, backend.id);
    if (
      !upstreamAuthorization ||
      (!isDesktopMediatedFamily &&
        (!localEdgeCredential ||
          localEdgeCredential.backendId !== backend.id ||
          !localEdgeCredential.operationFamilies.includes(operationFamily)))
    ) {
      return null;
    }
    const locallyAllowedFamilies = isDesktopMediatedFamily
      ? [operationFamily]
      : localEdgeCredential!.operationFamilies;
    const decision = resolveLocalEdgeRouteDecision({
      operationFamily,
      requestedMode: "live_upstream_proxy",
      upstreamBackend: backend,
      upstreamBackendId: backend.id,
      deviceCredential: {
        upstreamBackendId: backend.id,
        operationFamilies: locallyAllowedFamilies
      },
      upstreamCredentialAvailable: true
    });
    if (
      decision.action !== "live_upstream_proxy" ||
      !supportsCollaborationCommands(backend)
    ) {
      return null;
    }
    const status = await requireRemoteJson(options.fetch, {
      backend,
      upstreamAuthorization,
      operationFamily,
      method: "GET",
      path: "/v1/local-edge/device-credentials/status"
    });
    const parsedStatus = remoteDeviceStatusSchema.parse(status);
    const operationFamilies = new Set<
      | "team_workspace_read"
      | "team_chat_read"
      | "team_chat_write"
      | "admin"
      | "action_grant"
      | "share_grant_management"
      | "managed_execution"
      | "managed_execution"
    >();
    for (const family of parsedStatus.credential.operationFamilies) {
      if (
        family === "team_workspace_read" ||
        family === "team_chat_read" ||
        family === "team_chat_write" ||
        family === "admin" ||
        family === "action_grant" ||
        family === "share_grant_management" ||
        family === "managed_execution"
      ) {
        operationFamilies.add(family);
      }
    }
    if (!operationFamilies.has(operationFamily)) return null;
    return {
      backend,
      backendId: backend.id,
      upstreamAuthorization,
      upstreamDeviceCredentialId: parsedStatus.credential.id,
      operationFamilies,
      principal: parsedStatus.user
    };
  };

  const resolveAnyTeamContext = async (
    backendId: string,
    families: readonly (
      | "team_workspace_read"
      | "team_chat_read"
      | "team_chat_write"
      | "admin"
      | "action_grant"
      | "share_grant_management"
      | "managed_execution"
    )[]
  ): Promise<TeamReadContext | null> => {
    for (const family of families) {
      const context = await resolveTeamReadContext(family, backendId);
      if (context) return context;
    }
    return null;
  };

  const loadCachedRemoteTeamNavigation = async (input: {
    credential: DesktopLocalCredentialAuthorization;
    context: TeamReadContext;
    force: boolean;
  }) => {
    const key = [
      input.context.backendId,
      input.context.principal.id,
      input.credential.credentialKeyId
    ].join(":");
    const now = Date.now();
    const cached = remoteNavigationCache.get(key);
    if (
      !input.force &&
      cached &&
      now - cached.storedAt <= REMOTE_NAVIGATION_CACHE_RETENTION_MS
    ) {
      remoteNavigationCache.delete(key);
      remoteNavigationCache.set(key, cached);
      return cached.value;
    }
    const existing = remoteNavigationInFlight.get(key);
    if (existing) {
      if (!input.force) return existing;
      try {
        await existing;
      } catch {
        // A forced read still gets one fresh attempt after an older read fails.
      }
      const newer = remoteNavigationInFlight.get(key);
      if (newer && newer !== existing) return newer;
    }
    const pending = loadRemoteTeamNavigation({
      fetcher: options.fetch,
      credential: input.credential,
      context: input.context
    })
      .then((navigation) => {
        const value = {
          backendId: input.context.backendId,
          ...navigation
        };
        remoteNavigationCache.delete(key);
        remoteNavigationCache.set(key, { storedAt: Date.now(), value });
        while (remoteNavigationCache.size > REMOTE_NAVIGATION_CACHE_MAX) {
          const oldest = remoteNavigationCache.keys().next().value;
          if (typeof oldest !== "string") break;
          remoteNavigationCache.delete(oldest);
        }
        return value;
      })
      .finally(() => {
        remoteNavigationInFlight.delete(key);
      });
    remoteNavigationInFlight.set(key, pending);
    return pending;
  };

  app.post(
    "/v1/local-edge/collaboration/command",
    routeOptions,
    async (request, reply) => {
      if (
        !localEdgeDeploymentModes.some(
          (profile) => profile === options.deploymentProfile
        )
      ) {
        throw httpError("Local edge route is unavailable", 404);
      }
      assertLocalTrust(request, options.corsOrigins);
      const input = collaborationCommandRequestSchema.parse(request.body);
      const desktopFamily = desktopCollaborationOperationFamily(input.command);
      await (desktopFamily === "personal_collaboration_read"
        ? options.readPreHandler?.(request, reply)
        : options.writePreHandler?.(request, reply));
      const authorization = request.headers.authorization?.trim() ?? "";
      const credential = verifyDesktopCredential(
        options.koedHome,
        authorization,
        desktopFamily
      );
      if (!credential) {
        throw httpError("Koed-Desktop local credential required", 401);
      }
      const user = await options.resolveActiveLocalUser(credential.ownerUserId);
      if (!user || user.id !== credential.ownerUserId) {
        return failureResult(input.command, safeError("access_revoked"));
      }

      if (!("upstream_backend_id" in input)) {
        let personalRemoteContext: PersonalRemoteContext | null;
        try {
          personalRemoteContext =
            await resolvePersonalRemoteContext(desktopFamily);
        } catch (error) {
          return failureResult(
            input.command,
            safeErrorFromUnknown(error, "temporarily_unavailable")
          );
        }
        const reportSnapshotValidationFailure = (
          issues: Array<{ code: string; message: string; path: string[] }>
        ) => {
          request.log.error(
            {
              validation: {
                schema: "collaboration_snapshot",
                issues
              }
            },
            "Collaboration snapshot validation failed"
          );
        };
        const composePersonalSnapshot = async (
          personalSnapshot: Record<string, unknown>,
          forceRemoteNavigation = false
        ): Promise<CollaborationSnapshot | null> => {
          let remote: ConnectedRemoteTeamNavigation | null = null;
          let unavailableBackendId: string | null = null;
          const registeredBackend = options.teamCollaborationEnabled
            ? activeUpstreamBackend(readRegistry(options.upstreamBackendsPath))
            : null;
          if (registeredBackend) {
            unavailableBackendId = registeredBackend.id;
            try {
              const context = await resolveTeamReadContext(
                "team_workspace_read",
                registeredBackend.id
              );
              if (context) {
                remote = await loadCachedRemoteTeamNavigation({
                  credential,
                  context,
                  force: forceRemoteNavigation
                });
                unavailableBackendId = null;
              }
            } catch (error) {
              request.log.warn(
                {
                  event: {
                    name: "collaboration.remote_navigation.unavailable",
                    category: "collaboration"
                  },
                  upstream: { backend_id: registeredBackend.id },
                  error_name:
                    error instanceof Error ? error.name : "UnknownError"
                },
                "Remote Team navigation is unavailable"
              );
              remote = null;
            }
          }
          return snapshotWithRemoteNavigation(
            personalSnapshot,
            remote,
            unavailableBackendId,
            reportSnapshotValidationFailure
          );
        };
        const command = input.command as PersonalCommand;
        if (command.command === "collaboration.load") {
          const repository = options.requireCollaborationRepository();
          let personalSnapshot = await loadPersonalSnapshot({
            repository,
            credential,
            user
          });
          if (!personalSnapshot) {
            return failureResult(command, safeError("permission_denied"));
          }
          if (personalRemoteContext) {
            const remotePersonalSnapshot = await loadRemotePersonalSnapshot({
              fetcher: options.fetch,
              credential,
              context: personalRemoteContext,
              user,
              localSnapshot: personalSnapshot
            });
            if (!remotePersonalSnapshot) {
              return failureResult(
                command,
                safeError("temporarily_unavailable")
              );
            }
            personalSnapshot = remotePersonalSnapshot;
          }
          const snapshot = await composePersonalSnapshot(
            personalSnapshot,
            command.input.forceRemoteNavigation === true
          );
          return snapshot
            ? (personalSuccessResult(command, { snapshot }) ??
                failureResult(command, safeError("internal_error")))
            : failureResult(command, safeError("internal_error"));
        }
        if (command.command === "collaboration.select") {
          const repository = options.requireCollaborationRepository();
          let personalSnapshot = await loadPersonalSnapshot({
            repository,
            credential,
            user
          });
          if (personalSnapshot && personalRemoteContext) {
            personalSnapshot = await loadRemotePersonalSnapshot({
              fetcher: options.fetch,
              credential,
              context: personalRemoteContext,
              user,
              localSnapshot: personalSnapshot
            });
          }
          const parsedPersonalSnapshot = personalSnapshot
            ? await composePersonalSnapshot(personalSnapshot)
            : null;
          if (!parsedPersonalSnapshot) {
            return failureResult(command, safeError("permission_denied"));
          }
          const view = personalRemoteContext
            ? await loadRemotePersonalSelection({
                fetcher: options.fetch,
                snapshot: parsedPersonalSnapshot,
                credential,
                context: personalRemoteContext,
                user,
                selection: command.input.selection
              })
            : await loadPersonalSelection({
                snapshot: parsedPersonalSnapshot,
                repository,
                credential,
                user,
                selection: command.input.selection
              });
          if (!view) {
            return failureResult(command, safeError("not_available"));
          }
          const snapshot = {
            ...parsedPersonalSnapshot,
            generatedAt: new Date().toISOString(),
            selection: command.input.selection,
            view
          };
          return (
            personalSuccessResult(command, { snapshot }) ??
            failureResult(command, safeError("internal_error"))
          );
        }
        if (
          personalRemoteContext &&
          command.command === "collaboration.load_message_page" &&
          command.input.thread.scope === "personal"
        ) {
          try {
            const threadPayload = await requireRemoteJson(options.fetch, {
              backend: personalRemoteContext.backend,
              upstreamAuthorization:
                personalRemoteContext.upstreamAuthorization,
              operationFamily: "personal_collaboration_read",
              method: "GET",
              path: `/v1/collaboration/personal/threads/${encodeURIComponent(command.input.thread.threadId)}`
            });
            const thread = canonicalThreadSchema.parse(threadPayload.thread);
            const page = await remotePersonalMessagePage({
              fetcher: options.fetch,
              credential,
              context: personalRemoteContext,
              user,
              thread,
              direction: command.input.direction,
              cursor: command.input.cursor,
              limit: command.input.limit
            });
            return page
              ? (personalSuccessResult(command, { page }) ??
                  failureResult(command, safeError("internal_error")))
              : failureResult(command, safeError("not_available"));
          } catch (error) {
            return failureResult(
              command,
              safeErrorFromUnknown(error, "invalid_input")
            );
          }
        }
        if (
          personalRemoteContext &&
          command.command !== "collaboration.subscribe"
        ) {
          return dispatchRemotePersonalCommand({
            fetcher: options.fetch,
            command,
            context: personalRemoteContext,
            user
          });
        }
        return dispatchPersonalCommand({
          command,
          repository: options.requireCollaborationRepository(),
          credential,
          user
        });
      }
      if (
        input.command.command ===
          "collaboration.prepare_shared_memory_source" ||
        input.command.command === "collaboration.pause_shared_memory_sync" ||
        input.command.command === "collaboration.resume_shared_memory_sync" ||
        input.command.command === "collaboration.revoke_shared_memory_sync"
      ) {
        const command = input.command;
        const repository = options.requireCollaborationRepository();
        try {
          if (
            command.command === "collaboration.prepare_shared_memory_source" ||
            command.command === "collaboration.resume_shared_memory_sync"
          ) {
            await prepareSourceSyncRelationship(
              {
                deploymentProfile: options.deploymentProfile,
                resolveVerifiedLocalDeploymentId:
                  options.resolveVerifiedLocalDeploymentId,
                upstreamBackendsPath: options.upstreamBackendsPath,
                fetch: options.fetch,
                resolveUpstreamAuthorization:
                  options.resolveUpstreamAuthorization,
                requireRepository: () => repository,
                readUpstreamRegistry: readRegistry
              },
              {
                localUserId: user.id,
                sessionId: command.input.sessionId,
                upstreamBackendId: input.upstream_backend_id,
                idempotencyKey: command.requestId,
                consentedAt:
                  command.command ===
                  "collaboration.prepare_shared_memory_source"
                    ? command.input.consentedAt
                    : new Date().toISOString()
              }
            );
          } else {
            const relationship =
              await repository.getSourceSyncRelationshipForSession(
                { userId: user.id },
                command.input.sessionId
              );
            if (!relationship) {
              return failureResult(command, safeError("not_available"));
            }
            const updated =
              command.command === "collaboration.pause_shared_memory_sync"
                ? await repository.pauseCrossIdentitySyncRelationship(
                    { userId: user.id },
                    relationship.id
                  )
                : await repository.revokeCrossIdentitySyncRelationship(
                    { userId: user.id },
                    {
                      syncRelationshipId: relationship.id,
                      reason: "owner_stopped_sync"
                    }
                  );
            if (!updated) {
              return failureResult(command, safeError("conflict"));
            }
          }
          const summaries = await repository.listCapturedSessionSummaries(
            { userId: user.id },
            { limit: 500 }
          );
          const summary = summaries.find(
            (entry) => entry.sessionId === command.input.sessionId
          );
          if (!summary) {
            return failureResult(command, safeError("not_available"));
          }
          return (
            personalSuccessResult(command, {
              entry: personalMemoryEntryFromSummary(summary)
            }) ?? failureResult(command, safeError("internal_error"))
          );
        } catch (error) {
          return failureResult(command, sourceSyncErrorFor(error));
        }
      }
      if (
        collaborationActionGrantControlCommandNames.some(
          (name) => name === input.command.command
        )
      ) {
        const control = options.actionGrantControl;
        if (!control) {
          return failureResult(
            input.command,
            safeError("temporarily_unavailable")
          );
        }
        const backend = upstreamBackendById(
          readRegistry(options.upstreamBackendsPath),
          input.upstream_backend_id
        );
        if (!backend || !isSafeBackend(backend)) {
          return failureResult(
            input.command,
            safeError("temporarily_unavailable")
          );
        }
        const preferredFamilies =
          input.command.command === "collaboration.request_action_grant"
            ? (() => {
                if (
                  input.command.input.intent.intent ===
                    "collaboration.preview_shared_memory" ||
                  input.command.input.intent.intent ===
                    "collaboration.consent_shared_memory"
                ) {
                  return ["share_grant_management"] as const;
                }
                if (
                  input.command.input.intent.intent ===
                    "collaboration.managed_conversation_handoff" ||
                  input.command.input.intent.intent ===
                    "collaboration.managed_conversation_fork"
                ) {
                  return ["managed_execution"] as const;
                }
                const operation = control.describeIntent(
                  backend,
                  input.command.input.intent
                );
                if (!operation) return [] as const;
                return operation.operationFamily === "admin"
                  ? (["action_grant"] as const)
                  : (["share_grant_management"] as const);
              })()
            : ([
                "action_grant",
                "share_grant_management",
                "managed_execution"
              ] as const);
        const context = await resolveAnyTeamContext(
          input.upstream_backend_id,
          preferredFamilies
        );
        if (!context) {
          return failureResult(input.command, safeError("permission_denied"));
        }
        const result = await control.dispatch(input.command, {
          backend: context.backend,
          localOwnerUserId: user.id,
          principalUserId: context.principal.id,
          upstreamDeviceCredentialId: context.upstreamDeviceCredentialId,
          upstreamDeviceAuthorization: context.upstreamAuthorization,
          operationFamilies: new Set(
            [...context.operationFamilies].filter(
              (
                family
              ): family is
                | "action_grant"
                | "share_grant_management"
                | "managed_execution" =>
                family === "action_grant" ||
                family === "share_grant_management" ||
                family === "managed_execution"
            )
          ),
          resolveSharedMemoryPreviewTarget:
            options.sharedMemoryControl &&
            input.command.command === "collaboration.request_action_grant"
              ? (preview) =>
                  options.sharedMemoryControl!.resolvePreviewTarget(preview, {
                    upstreamBackendId: input.upstream_backend_id,
                    localOwnerUserId: user.id,
                    desktopCredentialKeyId: credential.credentialKeyId
                  })
              : undefined,
          resolveSharedMemoryConsentPreview:
            options.sharedMemoryControl &&
            input.command.command === "collaboration.request_action_grant"
              ? (consent) =>
                  options.sharedMemoryControl!.resolveConsentPreview(consent, {
                    upstreamBackendId: input.upstream_backend_id,
                    localOwnerUserId: user.id,
                    desktopCredentialKeyId: credential.credentialKeyId
                  })
              : undefined
        });
        return (
          result ?? failureResult(input.command, safeError("not_available"))
        );
      }
      if (isCollaborationTeamControlCommand(input.command)) {
        const operationFamily =
          input.command.command === "collaboration.list_invitations"
            ? "team_workspace_read"
            : "action_grant";
        const context = await resolveTeamReadContext(
          operationFamily,
          input.upstream_backend_id
        );
        if (!context) {
          return failureResult(input.command, safeError("permission_denied"));
        }
        const dispatched = await dispatchCollaborationTeamControlCommand(
          input.command,
          {
            backend: context.backend,
            principalUserId: context.principal.id,
            upstreamDeviceCredentialId: context.upstreamDeviceCredentialId,
            upstreamDeviceAuthorization: context.upstreamAuthorization,
            operationFamilies: new Set(
              [...context.operationFamilies].filter(
                (family): family is "team_workspace_read" | "action_grant" =>
                  family === "team_workspace_read" || family === "action_grant"
              )
            ),
            fetch: options.fetch,
            teamCreationRequestIdempotency: true,
            loadSnapshot: async () => {
              const personal = await loadPersonalSnapshot({
                repository: options.requireCollaborationRepository(),
                credential,
                user
              });
              if (!personal) throw new Error("Personal snapshot unavailable");
              const remote = await loadCachedRemoteTeamNavigation({
                credential,
                context,
                force: true
              });
              const snapshot = snapshotWithRemoteNavigation(personal, remote);
              if (!snapshot) throw new Error("Team snapshot unavailable");
              return snapshot;
            },
            cursorCodec: createCollaborationTeamControlCursorCodec(
              Buffer.from(credential.authorization, "utf8")
            ),
            resolveActionGrantSecret: (binding) =>
              Promise.resolve(
                resolveCollaborationActionGrantSecret(options.koedHome, {
                  referenceId: binding.reference.id,
                  backendId: binding.backendId,
                  deploymentBaseUrl: context.backend.baseUrl,
                  deviceCredentialId: binding.deviceCredentialId,
                  localOwnerUserId: user.id,
                  principalUserId: binding.principalUserId,
                  operationFamily: binding.operationFamily,
                  action: binding.action,
                  teamId: binding.teamId,
                  targetId: binding.targetId,
                  method: binding.method,
                  path: binding.path,
                  body: binding.body,
                  idempotencyKey: input.command.requestId
                })
              )
          }
        );
        if (dispatched.status === "handled") return dispatched.result;
        return failureResult(
          input.command,
          safeError(
            dispatched.status === "integration_required"
              ? "temporarily_unavailable"
              : "not_available"
          )
        );
      }
      if (isCollaborationSharedMemoryControlCommand(input.command)) {
        const result = await options.sharedMemoryControl?.dispatch(
          input.command,
          {
            upstreamBackendId: input.upstream_backend_id,
            localOwnerUserId: user.id,
            desktopCredentialKeyId: credential.credentialKeyId
          }
        );
        return (
          result ??
          failureResult(input.command, safeError("temporarily_unavailable"))
        );
      }
      const operation = teamCollaborationOperationFor(input.command);
      if (!operation) {
        if (input.command.command === "collaboration.select") {
          const context = await resolveTeamReadContext(
            "team_workspace_read",
            input.upstream_backend_id
          );
          if (!context) {
            return failureResult(
              input.command,
              safeError("temporarily_unavailable")
            );
          }
          try {
            const repository = options.requireCollaborationRepository();
            const personalSnapshot = await loadPersonalSnapshot({
              repository,
              credential,
              user
            });
            if (!personalSnapshot) {
              return failureResult(
                input.command,
                safeError("permission_denied")
              );
            }
            const remote = await loadCachedRemoteTeamNavigation({
              credential,
              context,
              force: false
            });
            const baseSnapshot = snapshotWithRemoteNavigation(
              personalSnapshot,
              remote
            );
            if (!baseSnapshot) {
              return failureResult(input.command, safeError("internal_error"));
            }
            const view = await loadTeamSelection({
              fetcher: options.fetch,
              credential,
              context,
              snapshot: baseSnapshot,
              selection: input.command.input.selection,
              loadSharedInitialView: async (session) => {
                const control = options.sharedMemoryControl;
                if (!control) {
                  throw Object.assign(
                    new Error("Shared Memory source control is unavailable"),
                    {
                      collaborationSafeError: safeError(
                        "temporarily_unavailable"
                      )
                    }
                  );
                }
                const loaded = await control.loadInitialSharedSession(
                  {
                    requestId: input.command.requestId,
                    teamId: session.teamId,
                    workspaceId: session.workspaceId,
                    sharedSessionId: session.id,
                    representation: session.representation,
                    limit: COLLABORATION_SOURCE_PAGE_MAX_ITEMS
                  },
                  {
                    upstreamBackendId: input.upstream_backend_id,
                    localOwnerUserId: user.id,
                    desktopCredentialKeyId: credential.credentialKeyId
                  }
                );
                if (!loaded) return null;
                const result = loaded.sourceResult;
                if (!result.ok) {
                  throw Object.assign(
                    new Error("Shared Memory source read was rejected"),
                    { collaborationSafeError: result.error }
                  );
                }
                const companion = loaded.companion;
                if (
                  result.command !== "collaboration.load_shared_source_page" ||
                  result.data.page.sharedSessionId !== session.id ||
                  result.data.page.representation !== session.representation ||
                  !companion.thread ||
                  !companion.messages
                ) {
                  return null;
                }
                return {
                  source: result.data.page,
                  thread: companion.thread,
                  messages: companion.messages
                };
              }
            });
            if (!view) {
              return failureResult(input.command, safeError("not_available"));
            }
            const snapshot = {
              ...baseSnapshot,
              generatedAt: new Date().toISOString(),
              selection: input.command.input.selection,
              view
            };
            return (
              personalSuccessResult(input.command as PersonalCommand, {
                snapshot
              }) ?? failureResult(input.command, safeError("internal_error"))
            );
          } catch (error) {
            return failureResult(input.command, safeErrorFromUnknown(error));
          }
        }
        return failureResult(input.command, safeError("not_available"));
      }
      const command = input.command as SupportedCommand;

      if (input.command.command === "collaboration.load_message_page") {
        const threadRef = input.command.input.thread;
        if (threadRef.scope !== "team") {
          return failureResult(input.command, safeError("invalid_input"));
        }
        const context = await resolveTeamReadContext(
          "team_chat_read",
          input.upstream_backend_id
        );
        if (!context) {
          return failureResult(
            input.command,
            safeError("temporarily_unavailable")
          );
        }
        try {
          const threadPayload = await requireRemoteJson(options.fetch, {
            backend: context.backend,
            upstreamAuthorization: context.upstreamAuthorization,
            operationFamily: "team_chat_read",
            method: "GET",
            path: `/v1/collaboration/teams/${encodeURIComponent(threadRef.teamId)}/threads/${encodeURIComponent(threadRef.threadId)}`
          });
          const thread = threadDtoFromRemote(threadPayload.thread);
          if (
            !thread ||
            thread.id !== threadRef.threadId ||
            thread.teamId !== threadRef.teamId
          ) {
            return failureResult(input.command, safeError("not_available"));
          }
          const page = await teamMessagePage({
            fetcher: options.fetch,
            credential,
            context,
            teamId: threadRef.teamId,
            thread,
            direction: input.command.input.direction,
            cursor: input.command.input.cursor,
            limit: input.command.input.limit
          });
          return page
            ? (personalSuccessResult(input.command as PersonalCommand, {
                page
              }) ?? failureResult(input.command, safeError("internal_error")))
            : failureResult(input.command, safeError("not_available"));
        } catch (error) {
          return failureResult(
            input.command,
            safeErrorFromUnknown(error, "invalid_input")
          );
        }
      }

      const backend = upstreamBackendById(
        readRegistry(options.upstreamBackendsPath),
        input.upstream_backend_id
      );
      if (!backend) {
        return failureResult(
          input.command,
          safeError("temporarily_unavailable")
        );
      }
      if (!isSafeBackend(backend)) {
        return failureResult(
          input.command,
          safeError("temporarily_unavailable")
        );
      }
      const upstreamAuthorization =
        options.resolveUpstreamAuthorization(backend);
      const localEdgeCredential = readLocalEdgeCredential(
        options.koedHome,
        input.upstream_backend_id
      );
      if (
        localEdgeCredential &&
        localEdgeCredential.backendId === input.upstream_backend_id &&
        !localEdgeCredential.operationFamilies.includes(
          operation.operationFamily
        )
      ) {
        return failureResult(input.command, safeError("permission_denied"));
      }
      const decision = resolveLocalEdgeRouteDecision({
        operationFamily: operation.operationFamily,
        requestedMode: "live_upstream_proxy",
        upstreamBackend: backend,
        upstreamBackendId: input.upstream_backend_id,
        deviceCredential: localEdgeCredential
          ? {
              upstreamBackendId: localEdgeCredential.backendId,
              operationFamilies: localEdgeCredential.operationFamilies
            }
          : null,
        upstreamCredentialAvailable: Boolean(upstreamAuthorization)
      });
      if (
        decision.action !== "live_upstream_proxy" ||
        !upstreamAuthorization ||
        !supportsCollaborationCommands(backend)
      ) {
        return failureResult(
          input.command,
          safeError("temporarily_unavailable")
        );
      }

      let remote: Awaited<ReturnType<typeof fetchBoundedJsonObject>>;
      try {
        remote = await fetchBoundedJsonObject(
          options.fetch,
          safeUpstreamProxyUrl(backend, operation.path),
          {
            method: operation.method,
            redirect: "error",
            headers: {
              accept: "application/json",
              authorization: upstreamAuthorization,
              "content-type": "application/json",
              ...(operation.idempotencyKey
                ? { "idempotency-key": operation.idempotencyKey }
                : {})
            },
            body: JSON.stringify(operation.body)
          },
          {
            timeoutMs: UPSTREAM_TIMEOUT_MS,
            maxBytes: UPSTREAM_RESPONSE_LIMIT_BYTES
          }
        );
      } catch (error) {
        return failureResult(
          input.command,
          safeError(
            error instanceof RemoteRequestTimeoutError
              ? "temporarily_unavailable"
              : error instanceof RemoteResponseLimitError ||
                  error instanceof SyntaxError
                ? "internal_error"
                : "offline"
          )
        );
      }

      const { response, payload } = remote;
      if (!response.ok) {
        return failureResult(input.command, errorForStatus(response));
      }
      return (
        successResult(command, operation, payload) ??
        failureResult(input.command, safeError("internal_error"))
      );
    }
  );
};
