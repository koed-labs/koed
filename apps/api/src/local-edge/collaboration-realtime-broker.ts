import { createHash, createHmac, randomUUID } from "node:crypto";
import type {
  CollaborationRepository,
  CollaborationSubscriptionRecord,
  DbPool
} from "@koed/db";
import { collaborationSubscriptionPrincipalHash } from "@koed/db";
import {
  calculateCollaborationReconnectDelay,
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_RECONNECT_BACKOFF_CAP_MS,
  COLLABORATION_RECONNECT_MAX_ATTEMPTS,
  COLLABORATION_RECONNECT_UNAVAILABLE_COOLDOWN_MS,
  COLLABORATION_RECONNECT_WINDOW_MS,
  COLLABORATION_RENDERER_ACK_DEADLINE_MS,
  COLLABORATION_RENDERER_MAX_PENDING_BYTES,
  COLLABORATION_RENDERER_MAX_PENDING_EVENTS,
  collaborationRendererEventSchema,
  collaborationSafeErrorMessages,
  isLoopbackHostname,
  readLocalEdgeClientCredentialAuthorization,
  type CollaborationRendererEvent,
  type CollaborationSafeError,
  type LocalEdgeClientCredentialAuthorization
} from "@koed/shared";
import * as shared from "@koed/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  materializePersonalRealtimeEvent,
  type PersonalRealtimeMaterializationRepository
} from "../collaboration/realtime.js";
import {
  acknowledgeLocalEdgeCollaborationDeliverySchema,
  createLocalEdgeCollaborationSubscriptionSchema,
  localEdgeCollaborationBackendParamsSchema,
  localEdgeCollaborationStreamQuerySchema,
  localEdgeCollaborationSubscriptionParamsSchema,
  unsubscribeLocalEdgeCollaborationSchema
} from "./schemas.js";
import {
  activeUpstreamBackend,
  assertUpstreamOperationPathAllowed,
  readLocalEdgeUpstreamRegistry,
  resolveLocalEdgeRouteDecision,
  safeUpstreamProxyUrl,
  upstreamBackendById,
  upstreamSupportsCollaborationRealtime,
  type LocalEdgeUpstreamBackend
} from "./upstream-routing.js";

const protocolVersion = COLLABORATION_CONTRACT_VERSION;
const remoteSnapshotPath = "/v1/collaboration/realtime/snapshot";
const remoteStreamPath = "/v1/collaboration/realtime/stream";
const remoteAckPath = "/v1/collaboration/realtime/ack";
const remotePrincipalStatusPath = "/v1/local-edge/device-credentials/status";
const defaultSnapshotBytes = 4 * 1024 * 1024;
const defaultRemoteEventBytes = 512 * 1024;
const defaultPendingEvents = COLLABORATION_RENDERER_MAX_PENDING_EVENTS;
const defaultPendingBytes = COLLABORATION_RENDERER_MAX_PENDING_BYTES;
const defaultMaxConnections = 100;
const defaultAckDeadlineMs = COLLABORATION_RENDERER_ACK_DEADLINE_MS;
const defaultReconnectBaseMs = 250;
const defaultReconnectMaxMs = COLLABORATION_RECONNECT_BACKOFF_CAP_MS;
const defaultReconnectAttempts = COLLABORATION_RECONNECT_MAX_ATTEMPTS;
const defaultReconnectWindowMs = COLLABORATION_RECONNECT_WINDOW_MS;
const defaultReconnectStableResetMs = 30_000;
const defaultReconnectUnavailableCooldownMs =
  COLLABORATION_RECONNECT_UNAVAILABLE_COOLDOWN_MS;
const defaultReconnectJitter = 0.2;

const remoteCursorSchema = z
  .string()
  .min(16)
  .max(4096)
  .regex(/^crt1\.[A-Za-z0-9_-]+$/);
const timestampSchema = z.string().max(64).datetime({ offset: true });
const nullableUuidSchema = z.uuid().nullable();

const remoteThreadCommonSchema = z.object({
  id: z.uuid(),
  logicalId: z.uuid(),
  name: z.string().max(120).nullable(),
  topic: z.string().max(2_000).nullable(),
  createdByUserId: nullableUuidSchema,
  version: z.number().int().safe().positive(),
  lifecycle: z.enum([
    "active",
    "archived",
    "tombstoned",
    "purge_pending",
    "purged"
  ]),
  latestSequence: z.number().int().safe().min(0),
  lastReadMessageId: nullableUuidSchema,
  lastReadSequence: z.number().int().safe().min(0),
  unreadCount: z.number().int().safe().min(0),
  participants: z
    .array(
      z
        .object({
          userId: z.uuid(),
          displayName: z.string().max(320).nullable()
        })
        .strict()
    )
    .max(40),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastActivityAt: timestampSchema,
  archivedAt: timestampSchema.nullable()
});

const remoteThreadSchema = z.discriminatedUnion("scope", [
  remoteThreadCommonSchema
    .extend({
      scope: z.literal("personal"),
      kind: z.enum(["notes_to_self", "personal_channel"]),
      personalOwnerUserId: z.uuid(),
      teamId: z.null(),
      teamWorkspaceId: z.null(),
      sharedLogicalMemoryId: z.null(),
      shareGrantId: z.null(),
      systemKey: z.null()
    })
    .strict(),
  remoteThreadCommonSchema
    .extend({
      scope: z.literal("team"),
      kind: z.enum([
        "workspace_channel",
        "dm",
        "group_dm",
        "shared_session_discussion"
      ]),
      personalOwnerUserId: z.null(),
      teamId: z.uuid(),
      teamWorkspaceId: nullableUuidSchema,
      sharedLogicalMemoryId: nullableUuidSchema,
      shareGrantId: nullableUuidSchema,
      systemKey: z.literal("workspace.general").nullable()
    })
    .strict()
]);

const remoteSubscriptionCommonSchema = z.object({
  id: z.uuid(),
  protocolVersion: z.literal(protocolVersion),
  state: z.enum(["active", "requires_snapshot", "revoked", "expired"]),
  snapshotHighWaterCursor: z.number().int().safe().min(0).nullable(),
  acknowledgedEventId: nullableUuidSchema,
  acknowledgedCursor: z.number().int().safe().min(0),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastAcknowledgedAt: timestampSchema.nullable(),
  expiresAt: timestampSchema,
  revokedAt: timestampSchema.nullable()
});

const remoteSubscriptionSchema = z.discriminatedUnion("scope", [
  remoteSubscriptionCommonSchema
    .extend({
      scope: z.literal("personal"),
      personalOwnerUserId: z.uuid(),
      teamId: z.null()
    })
    .strict(),
  remoteSubscriptionCommonSchema
    .extend({
      scope: z.literal("team"),
      personalOwnerUserId: z.null(),
      teamId: z.uuid()
    })
    .strict()
]);

const remoteSnapshotSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    subscription: remoteSubscriptionSchema,
    snapshot: z.discriminatedUnion("scope", [
      z
        .object({
          scope: z.literal("personal"),
          personalOwnerUserId: z.uuid(),
          teamId: z.null(),
          highWaterCursor: remoteCursorSchema,
          threads: z.array(remoteThreadSchema).max(5_000)
        })
        .strict(),
      z
        .object({
          scope: z.literal("team"),
          personalOwnerUserId: z.null(),
          teamId: z.uuid(),
          highWaterCursor: remoteCursorSchema,
          threads: z.array(remoteThreadSchema).max(5_000)
        })
        .strict()
    ]),
    cursor: remoteCursorSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cursor !== value.snapshot.highWaterCursor) {
      context.addIssue({
        code: "custom",
        path: ["cursor"],
        message: "snapshot cursors do not match"
      });
    }
    if (
      value.subscription.scope !== value.snapshot.scope ||
      value.subscription.personalOwnerUserId !==
        value.snapshot.personalOwnerUserId ||
      value.subscription.teamId !== value.snapshot.teamId ||
      value.subscription.state !== "active"
    ) {
      context.addIssue({
        code: "custom",
        path: ["subscription"],
        message: "snapshot subscription is not active for the requested scope"
      });
    }
  });

const remoteAckResponseSchema = z
  .object({ subscription: remoteSubscriptionSchema })
  .strict();

const collaborationEventFamilySchema = z.enum([
  "team_lifecycle",
  "team_membership_access",
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
  "access_revoked"
]);

const remoteEventSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    eventId: z.uuid(),
    cursor: remoteCursorSchema,
    type: collaborationEventFamilySchema,
    occurredAt: timestampSchema,
    subscription: z.object({ id: z.uuid() }).strict(),
    resource: z
      .object({
        scope: z.enum(["personal", "team"]),
        type: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[A-Za-z0-9._:-]+$/),
        id: z.string().min(1).max(160),
        teamId: nullableUuidSchema,
        teamWorkspaceId: nullableUuidSchema,
        threadId: nullableUuidSchema,
        messageId: nullableUuidSchema,
        sharedSessionId: nullableUuidSchema,
        shareGrantId: nullableUuidSchema,
        logicalMemoryId: nullableUuidSchema
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
            message: "Realtime resource scope and Team identity do not match"
          });
        }
        if (resource.sharedSessionId !== resource.shareGrantId) {
          context.addIssue({
            code: "custom",
            path: ["sharedSessionId"],
            message: "Shared Session identity must match the Share Grant"
          });
        }
      }),
    actor: z.object({ principalId: nullableUuidSchema }).strict(),
    update: z.unknown()
  })
  .strict();

const remotePrincipalStatusSchema = z
  .object({
    ok: z.literal(true),
    auth: z.literal("device_credential"),
    user: z
      .object({
        id: z.uuid(),
        email: z.string().max(320).optional(),
        displayName: z.string().max(320).nullable()
      })
      .strict()
  })
  .passthrough();

const remoteControlSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    subscription: z.object({ id: z.uuid() }).strict(),
    reason: z.enum([
      "access_revoked",
      "requires_snapshot",
      "backpressure",
      "server_shutdown"
    ])
  })
  .strict();

type LocalSubscriptionState =
  | "active"
  | "requires_snapshot"
  | "revoked"
  | "expired";

interface LocalSubscriptionRow {
  id: string;
  scope: "personal" | "team";
  upstreamBackendId: string;
  credentialBindingHash: string;
  teamId: string | null;
  protocolVersion: number;
  remoteSubscriptionId: string;
  remoteCursor: string;
  lastAcknowledgedEventId: string | null;
  state: LocalSubscriptionState;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  lastConnectedAt: Date | string | null;
  lastAcknowledgedAt: Date | string | null;
  expiresAt: Date | string;
  revokedAt: Date | string | null;
}

interface LocalBinding {
  localOwnerUserId: string;
  scope: "personal" | "team";
  upstreamBackendId: string;
  upstreamBackendIdentity: string;
  remotePrincipalId: string;
  teamId: string | null;
  credentialBindingHash: string;
  clientInstanceId: string;
  subscriptionKey: string;
  upstreamBackend: LocalEdgeUpstreamBackend;
  upstreamAuthorization: string;
}

interface PendingSnapshot {
  kind: "snapshot";
  localSubscriptionId: string;
  expectedVersion: number;
  binding: LocalBinding;
  deliveryId: string;
  remoteSubscriptionId: string;
  remoteCursor: string;
  remoteExpiresAt: Date;
}

interface PendingRemoteEvent {
  kind: "remote_event";
  localSubscriptionId: string;
  binding: LocalBinding;
  deliveryId: string;
  eventId: string;
  remoteSubscriptionId: string;
  remoteCursor: string;
  bytes: number;
}

interface PersonalBinding {
  localOwnerUserId: string;
  credentialBindingHash: string;
  clientInstanceHash: string;
  subscriptionKeyHash: string;
}

interface PendingPersonalSnapshot {
  kind: "personal_snapshot";
  localSubscriptionId: string;
  expectedVersion: number;
  binding: PersonalBinding;
  deliveryId: string;
  highWaterCursor: number;
  expiresAt: Date;
}

interface PendingPersonalEvent {
  kind: "personal_event";
  localSubscriptionId: string;
  binding: PersonalBinding;
  deliveryId: string;
  eventId: string;
  cursor: number;
  bytes: number;
}

type PendingEvent = PendingRemoteEvent | PendingPersonalEvent;
type CollaborationControlReason = Extract<
  CollaborationRendererEvent,
  { type: "control" }
>["reason"];

interface ActiveConnection {
  localSubscriptionId: string;
  binding: LocalBinding;
  row: LocalSubscriptionRow;
  reply: FastifyReply;
  abort: AbortController;
  stopped: boolean;
  seenEventIds: Set<string>;
}

interface ActivePersonalConnection {
  localSubscriptionId: string;
  binding: PersonalBinding;
  subscription: CollaborationSubscriptionRecord;
  reply: FastifyReply;
  abort: AbortController;
  stopped: boolean;
  seenEventIds: Set<string>;
  cursor: number;
  flushing: boolean;
  flushRequested: boolean;
  listenNotification: (() => void) | null;
  listenError: ((error: Error) => void) | null;
  listenClient:
    | (BrokerDbClient & {
        on?: (
          event: "notification" | "error",
          listener: (() => void) | ((error: Error) => void)
        ) => void;
        off?: (
          event: "notification" | "error",
          listener: (() => void) | ((error: Error) => void)
        ) => void;
      })
    | null;
}

type LocalEdgeCredentialReader =
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
  operationFamily: "personal_collaboration_read"
) => DesktopLocalCredentialAuthorization | null;

interface ActiveLocalUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface CollaborationRealtimeBrokerOptions {
  app: FastifyInstance;
  pool: DbPool | null;
  koedHome: string;
  upstreamBackendsPath: string;
  brokerSecret: string;
  corsOrigins: Set<string>;
  resolveUpstreamAuthorization: (
    backend: LocalEdgeUpstreamBackend
  ) => string | null;
  requireCollaborationRepository: () => CollaborationRepository;
  requireCollaborationMaterializationRepository: () => PersonalRealtimeMaterializationRepository;
  resolveActiveLocalUser: (userId: string) => Promise<ActiveLocalUser | null>;
  quarantineCrossIdentitySyncForBackend: (
    ownerUserId: string,
    upstreamBackendId: string
  ) => Promise<void>;
  revokeSharedMemoryAuthorityForBackend: (
    ownerUserId: string,
    upstreamBackendId: string
  ) => Promise<void>;
  fetch?: typeof fetch;
  readLocalEdgeClientCredential?: LocalEdgeCredentialReader;
  verifyDesktopLocalCredential?: DesktopCredentialVerifier;
  maxConnections?: number;
  maxPendingEvents?: number;
  maxPendingBytes?: number;
  maxSnapshotBytes?: number;
  maxRemoteEventBytes?: number;
  ackDeadlineMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxReconnectAttempts?: number;
  reconnectWindowMs?: number;
  reconnectStableResetMs?: number;
  reconnectUnavailableCooldownMs?: number;
  reconnectJitter?: number;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
  afterRemoteAck?: () => Promise<void>;
  onRemoteNavigationInvalidated?: (backendId: string) => void;
}

export interface CollaborationRealtimeBrokerService {
  registerRoutes(): void;
  close(): Promise<void>;
}

const hmac = (secret: string, domain: string, values: string[]): string => {
  const digest = createHmac("sha256", secret);
  digest.update(`koed:local-edge:collaboration:${domain}:v1\n`, "utf8");
  for (const value of values) {
    digest.update(String(Buffer.byteLength(value, "utf8")), "utf8");
    digest.update(":", "utf8");
    digest.update(value, "utf8");
    digest.update("\n", "utf8");
  }
  return digest.digest("base64url");
};

const hmacHex = (secret: string, domain: string, values: string[]): string => {
  const digest = createHmac("sha256", secret);
  digest.update(`koed:local-edge:collaboration:${domain}:v1\n`, "utf8");
  for (const value of values) {
    digest.update(String(Buffer.byteLength(value, "utf8")), "utf8");
    digest.update(":", "utf8");
    digest.update(value, "utf8");
    digest.update("\n", "utf8");
  }
  return digest.digest("hex");
};

export { calculateCollaborationReconnectDelay } from "@koed/shared";

const defaultSleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted")
      );
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error ? signal.reason : new Error("aborted")
        );
      },
      { once: true }
    );
  });

const iso = (value: Date | string | null): string | null =>
  value === null
    ? null
    : value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString();

const publicSubscription = (row: LocalSubscriptionRow) => ({
  id: row.id,
  protocolVersion: row.protocolVersion,
  scope:
    row.scope === "personal"
      ? ({ scope: "personal" } as const)
      : ({ scope: "team", teamId: row.teamId! } as const),
  state: row.state,
  version: row.version,
  expiresAt: iso(row.expiresAt)
});

const publicPersonalSubscription = (
  record: CollaborationSubscriptionRecord,
  ownerUserId: string
) => {
  if (
    record.scope !== "personal" ||
    record.personalOwnerUserId !== ownerUserId ||
    record.teamId !== null
  ) {
    fail("Personal collaboration subscription binding is invalid", 500);
  }
  return {
    id: record.id,
    protocolVersion,
    scope: { scope: "personal" as const },
    state: record.state,
    version: 1,
    expiresAt: record.expiresAt
  };
};

const selectColumns = `
  id,
  scope,
  upstream_backend_id as "upstreamBackendId",
  credential_binding_hash as "credentialBindingHash",
  team_id as "teamId",
  protocol_version as "protocolVersion",
  remote_subscription_id as "remoteSubscriptionId",
  remote_cursor as "remoteCursor",
  last_acknowledged_event_id as "lastAcknowledgedEventId",
  state,
  version,
  created_at as "createdAt",
  updated_at as "updatedAt",
  last_connected_at as "lastConnectedAt",
  last_acknowledged_at as "lastAcknowledgedAt",
  expires_at as "expiresAt",
  revoked_at as "revokedAt"
`;

const fail = (message: string, statusCode: number): never => {
  throw Object.assign(new Error(message), { statusCode });
};

const parseOrFail = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("Invalid request payload", 400);
  return parsed.data as T;
};

const requirePool = (pool: DbPool | null): DbPool =>
  pool ?? fail("Database is not configured", 503);

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

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

interface BrokerDbClient {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

const withTransaction = async <T>(
  pool: DbPool,
  work: (client: BrokerDbClient) => Promise<T>
): Promise<T> => {
  const client = await (
    pool.connect as unknown as () => Promise<BrokerDbClient>
  )();
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

const parseHost = (host: string): string | null => {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
};

const safeRemotePrincipalStatusUrl = (
  backend: LocalEdgeUpstreamBackend
): URL => {
  const base = new URL(backend.baseUrl.replace(/\/+$/, "/"));
  if (base.username || base.password || base.search || base.hash) {
    fail("Unsafe upstream backend URL", 424);
  }
  return new URL(remotePrincipalStatusPath.replace(/^\//, ""), base);
};

const isLoopbackAddress = (address: string): boolean =>
  address === "127.0.0.1" ||
  address === "::1" ||
  address === "::ffff:127.0.0.1";

const assertLocalTrust = (
  request: FastifyRequest,
  corsOrigins: Set<string>
): void => {
  const hostname = parseHost(request.headers.host ?? "");
  if (
    !hostname ||
    !isLoopbackHostname(hostname) ||
    !isLoopbackAddress(request.ip)
  ) {
    fail("Local collaboration realtime routes require localhost", 403);
  }
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    fail("Local collaboration realtime origin is not allowed", 403);
  }
  const normalized = origin.replace(/\/+$/, "");
  if (!isLoopbackHostname(parsed!.hostname) || !corsOrigins.has(normalized)) {
    fail("Local collaboration realtime origin is not allowed", 403);
  }
};

const readBoundedText = async (
  response: Response,
  maxBytes: number
): Promise<string> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    fail("Upstream collaboration response is too large", 502);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        fail("Upstream collaboration response is too large", 502);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

const writeLocalEvent = async (
  reply: FastifyReply,
  event: string,
  payload: unknown,
  id?: string
): Promise<void> => {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  const block = `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  if (reply.raw.write(block)) return;
  await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
};

const writeLocalComment = async (
  reply: FastifyReply,
  comment: string
): Promise<void> => {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  if (reply.raw.write(`: ${comment}\n\n`)) return;
  await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
};

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

const rendererEvent = (value: unknown): CollaborationRendererEvent =>
  collaborationRendererEventSchema.parse(value);

const rendererUpdateEvent = (
  value: unknown
): Extract<CollaborationRendererEvent, { type: "update" }> => {
  const event = rendererEvent(value);
  if (event.type !== "update") {
    return fail("Collaboration renderer update is invalid", 500);
  }
  return event as Extract<CollaborationRendererEvent, { type: "update" }>;
};

const writeRendererEvent = async (
  reply: FastifyReply,
  value: unknown,
  id?: string
): Promise<CollaborationRendererEvent> => {
  const event = rendererEvent(value);
  await writeLocalEvent(reply, "collaboration", event, id);
  return event;
};

interface ParsedSseEvent {
  event: string;
  data: string;
}

const consumeSse = async (
  body: ReadableStream<Uint8Array>,
  maxEventBytes: number,
  onEvent: (event: ParsedSseEvent) => Promise<void>
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeBlock = async (block: string) => {
    if (!block || block.startsWith(":")) return;
    if (Buffer.byteLength(block, "utf8") > maxEventBytes) {
      fail("Upstream collaboration event is too large", 502);
    }
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trimStart();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    await onEvent({ event, data: data.join("\n") });
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder
        .decode(chunk.value, { stream: true })
        .replace(/\r\n/g, "\n");
      if (Buffer.byteLength(buffer, "utf8") > maxEventBytes * 2) {
        fail("Upstream collaboration event is too large", 502);
      }
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        await consumeBlock(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await consumeBlock(buffer);
  } finally {
    reader.releaseLock();
  }
};

export const createCollaborationRealtimeBroker = (
  options: CollaborationRealtimeBrokerOptions
): CollaborationRealtimeBrokerService => {
  if (Buffer.byteLength(options.brokerSecret, "utf8") < 32) {
    throw new TypeError("Collaboration realtime broker secret is too short");
  }
  const upstreamFetch = options.fetch ?? fetch;
  const readLocalEdgeCredential =
    options.readLocalEdgeClientCredential ??
    readLocalEdgeClientCredentialAuthorization;
  const verifyDesktopCredential =
    options.verifyDesktopLocalCredential ?? verifyStoredDesktopLocalCredential;
  const maxConnections = Math.max(
    1,
    options.maxConnections ?? defaultMaxConnections
  );
  const maxPendingEvents = Math.min(
    COLLABORATION_RENDERER_MAX_PENDING_EVENTS,
    Math.max(1, options.maxPendingEvents ?? defaultPendingEvents)
  );
  const maxPendingBytes = Math.min(
    COLLABORATION_RENDERER_MAX_PENDING_BYTES,
    Math.max(1, options.maxPendingBytes ?? defaultPendingBytes)
  );
  const maxSnapshotBytes = Math.max(
    1,
    options.maxSnapshotBytes ?? defaultSnapshotBytes
  );
  const maxRemoteEventBytes = Math.max(
    1,
    options.maxRemoteEventBytes ?? defaultRemoteEventBytes
  );
  const reconnectBaseMs = Math.min(
    COLLABORATION_RECONNECT_BACKOFF_CAP_MS,
    Math.max(1, options.reconnectBaseMs ?? defaultReconnectBaseMs)
  );
  const reconnectMaxMs = Math.min(
    COLLABORATION_RECONNECT_BACKOFF_CAP_MS,
    Math.max(reconnectBaseMs, options.reconnectMaxMs ?? defaultReconnectMaxMs)
  );
  const maxReconnectAttempts = Math.min(
    COLLABORATION_RECONNECT_MAX_ATTEMPTS,
    Math.max(0, options.maxReconnectAttempts ?? defaultReconnectAttempts)
  );
  const reconnectWindowMs = Math.max(
    1,
    options.reconnectWindowMs ?? defaultReconnectWindowMs
  );
  const reconnectStableResetMs = Math.max(
    1,
    options.reconnectStableResetMs ?? defaultReconnectStableResetMs
  );
  const reconnectUnavailableCooldownMs = Math.min(
    COLLABORATION_RECONNECT_WINDOW_MS,
    Math.max(
      1,
      options.reconnectUnavailableCooldownMs ??
        defaultReconnectUnavailableCooldownMs
    )
  );
  const reconnectJitter = options.reconnectJitter ?? defaultReconnectJitter;
  const ackDeadlineMs = Math.min(
    COLLABORATION_RENDERER_ACK_DEADLINE_MS,
    Math.max(1, options.ackDeadlineMs ?? defaultAckDeadlineMs)
  );
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const repository = () => options.requireCollaborationRepository();
  const pendingSnapshots = new Map<string, PendingSnapshot>();
  const pendingPersonalSnapshots = new Map<string, PendingPersonalSnapshot>();
  const pendingEvents = new Map<string, PendingEvent>();
  const pendingEventOrder = new Map<string, string[]>();
  const pendingEventDeadlines = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const connections = new Map<string, ActiveConnection>();
  const personalConnections = new Map<string, ActivePersonalConnection>();
  let pendingEventBytes = 0;
  let closing = false;
  let registered = false;

  const credentialHash = (values: string[]) =>
    hmacHex(options.brokerSecret, "credential-binding", [...values]);

  const authorizeLocalOwner = async (
    request: FastifyRequest
  ): Promise<DesktopLocalCredentialAuthorization> => {
    assertLocalTrust(request, options.corsOrigins);
    const authorization = request.headers.authorization?.trim() ?? "";
    const credential = verifyDesktopCredential(
      options.koedHome,
      authorization,
      "personal_collaboration_read"
    );
    if (!credential) {
      fail("Koed-Desktop local credential required", 401);
    }
    const authorizedCredential = credential!;
    const user = await options.resolveActiveLocalUser(
      authorizedCredential.ownerUserId
    );
    if (!user || user.id !== authorizedCredential.ownerUserId) {
      fail("Local Personal owner is not active", 403);
    }
    return authorizedCredential;
  };

  const authorizePersonal = async (
    request: FastifyRequest
  ): Promise<PersonalBinding> => {
    const credential = await authorizeLocalOwner(request);
    const bindingHash = credentialHash([
      "personal",
      credential.ownerUserId,
      credential.credentialKeyId,
      credential.authorization
    ]);
    return {
      localOwnerUserId: credential.ownerUserId,
      credentialBindingHash: bindingHash,
      clientInstanceHash: sha256(credential.credentialKeyId),
      subscriptionKeyHash: sha256(
        `personal:${credential.ownerUserId}:${credential.credentialKeyId}`
      )
    };
  };

  const resolveRemotePrincipalId = async (
    backend: LocalEdgeUpstreamBackend,
    authorization: string
  ): Promise<string> => {
    let response: Response;
    try {
      response = await upstreamFetch(safeRemotePrincipalStatusUrl(backend), {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization
        }
      });
    } catch {
      return fail("Remote collaboration principal is unavailable", 424);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return fail("Remote collaboration principal is unavailable", 424);
    }
    const text = await readBoundedText(response, 64 * 1024);
    try {
      return remotePrincipalStatusSchema.parse(JSON.parse(text)).user.id;
    } catch {
      return fail("Remote collaboration principal is invalid", 502);
    }
  };

  const remotePrincipalAuthorizationState = async (
    binding: LocalBinding
  ): Promise<"active" | "revoked" | "unavailable"> => {
    let response: Response;
    try {
      response = await upstreamFetch(
        safeRemotePrincipalStatusUrl(binding.upstreamBackend),
        {
          method: "GET",
          redirect: "error",
          headers: {
            accept: "application/json",
            authorization: binding.upstreamAuthorization
          }
        }
      );
    } catch {
      return "unavailable";
    }
    if ([401, 403, 410].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return "revoked";
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return "unavailable";
    }
    try {
      const text = await readBoundedText(response, 64 * 1024);
      const principal = remotePrincipalStatusSchema.parse(JSON.parse(text));
      return principal.user.id === binding.remotePrincipalId
        ? "active"
        : "revoked";
    } catch {
      return "unavailable";
    }
  };

  const authorizeTeam = async (
    request: FastifyRequest,
    upstreamBackendId: string,
    teamId: string
  ): Promise<LocalBinding> => {
    const credential = await authorizeLocalOwner(request);
    const registry = readLocalEdgeUpstreamRegistry(
      options.upstreamBackendsPath
    );
    const upstreamBackend = upstreamBackendById(registry, upstreamBackendId);
    if (!upstreamBackend) fail("Upstream backend is unavailable", 424);
    if (!upstreamSupportsCollaborationRealtime(upstreamBackend!)) {
      fail("Upstream collaboration realtime protocol is unavailable", 424);
    }
    const localEdgeCredential = readLocalEdgeCredential(
      options.koedHome,
      upstreamBackendId
    );
    if (
      !localEdgeCredential ||
      localEdgeCredential.backendId !== upstreamBackendId ||
      !localEdgeCredential.operationFamilies.includes("team_workspace_read")
    ) {
      return fail("Team collaboration realtime authority is unavailable", 424);
    }
    const authorizedLocalEdgeCredential =
      localEdgeCredential as LocalEdgeClientCredentialAuthorization;
    const upstreamAuthorization = options.resolveUpstreamAuthorization(
      upstreamBackend!
    );
    const decision = resolveLocalEdgeRouteDecision({
      operationFamily: "team_workspace_read",
      requestedMode: "live_upstream_proxy",
      upstreamBackend,
      upstreamBackendId,
      deviceCredential: {
        upstreamBackendId: authorizedLocalEdgeCredential.backendId,
        operationFamilies: authorizedLocalEdgeCredential.operationFamilies
      },
      upstreamCredentialAvailable: Boolean(upstreamAuthorization)
    });
    if (decision.action !== "live_upstream_proxy" || !upstreamAuthorization) {
      fail("Upstream collaboration realtime is unavailable", 424);
    }
    const upstreamBackendIdentity = new URL(
      upstreamBackend!.baseUrl
    ).toString();
    const remotePrincipalId = await resolveRemotePrincipalId(
      upstreamBackend!,
      upstreamAuthorization!
    );
    const bindingHash = credentialHash([
      "team",
      credential.ownerUserId,
      credential.credentialKeyId,
      credential.authorization,
      upstreamBackendId,
      upstreamBackendIdentity,
      authorizedLocalEdgeCredential.credentialKeyId,
      remotePrincipalId,
      teamId
    ]);
    return {
      localOwnerUserId: credential.ownerUserId,
      scope: "team",
      upstreamBackendId,
      upstreamBackendIdentity,
      remotePrincipalId,
      teamId,
      credentialBindingHash: bindingHash,
      clientInstanceId: `lcb1.${hmac(options.brokerSecret, "client-instance", [
        bindingHash,
        upstreamBackendId,
        teamId
      ])}`,
      subscriptionKey: `lcb1.${hmac(options.brokerSecret, "subscription-key", [
        bindingHash,
        upstreamBackendId,
        teamId
      ])}`,
      upstreamBackend: upstreamBackend!,
      upstreamAuthorization: upstreamAuthorization!
    };
  };

  const configuredRemotePersonalBackend =
    (): LocalEdgeUpstreamBackend | null => {
      const backend = activeUpstreamBackend(
        readLocalEdgeUpstreamRegistry(options.upstreamBackendsPath)
      );
      return backend?.routePolicy.personalCollaboration === "enabled"
        ? backend
        : null;
    };

  const authorizeRemotePersonal = async (
    request: FastifyRequest
  ): Promise<LocalBinding> => {
    const credential = await authorizeLocalOwner(request);
    const upstreamBackend = configuredRemotePersonalBackend();
    if (!upstreamBackend) {
      return fail("Upstream Personal collaboration is unavailable", 424);
    }
    if (!upstreamSupportsCollaborationRealtime(upstreamBackend)) {
      fail("Upstream collaboration realtime protocol is unavailable", 424);
    }
    const localEdgeCredential = readLocalEdgeCredential(
      options.koedHome,
      upstreamBackend.id
    );
    if (
      !localEdgeCredential ||
      localEdgeCredential.backendId !== upstreamBackend.id ||
      !localEdgeCredential.operationFamilies.includes(
        "personal_collaboration_read"
      )
    ) {
      return fail(
        "Personal collaboration realtime authority is unavailable",
        424
      );
    }
    const upstreamAuthorization =
      options.resolveUpstreamAuthorization(upstreamBackend);
    const decision = resolveLocalEdgeRouteDecision({
      operationFamily: "personal_collaboration_read",
      requestedMode: "live_upstream_proxy",
      upstreamBackend,
      upstreamBackendId: upstreamBackend.id,
      deviceCredential: {
        upstreamBackendId: localEdgeCredential.backendId,
        operationFamilies: localEdgeCredential.operationFamilies
      },
      upstreamCredentialAvailable: Boolean(upstreamAuthorization)
    });
    if (decision.action !== "live_upstream_proxy" || !upstreamAuthorization) {
      fail("Upstream Personal collaboration is unavailable", 424);
    }
    const upstreamBackendIdentity = new URL(upstreamBackend.baseUrl).toString();
    const remotePrincipalId = await resolveRemotePrincipalId(
      upstreamBackend,
      upstreamAuthorization!
    );
    const bindingHash = credentialHash([
      "personal-remote",
      credential.ownerUserId,
      credential.credentialKeyId,
      credential.authorization,
      upstreamBackend.id,
      upstreamBackendIdentity,
      localEdgeCredential.credentialKeyId,
      remotePrincipalId
    ]);
    return {
      localOwnerUserId: credential.ownerUserId,
      scope: "personal",
      upstreamBackendId: upstreamBackend.id,
      upstreamBackendIdentity,
      remotePrincipalId,
      teamId: null,
      credentialBindingHash: bindingHash,
      clientInstanceId: `lcb1.${hmac(options.brokerSecret, "client-instance", [
        bindingHash,
        upstreamBackend.id,
        "personal"
      ])}`,
      subscriptionKey: `lcb1.${hmac(options.brokerSecret, "subscription-key", [
        bindingHash,
        upstreamBackend.id,
        "personal"
      ])}`,
      upstreamBackend,
      upstreamAuthorization: upstreamAuthorization!
    };
  };

  const loadByBinding = async (
    binding: LocalBinding
  ): Promise<LocalSubscriptionRow | null> => {
    const result = await requirePool(options.pool).query<LocalSubscriptionRow>(
      `select ${selectColumns}
       from local_edge_collaboration_subscriptions
       where upstream_backend_id = $1
         and credential_binding_hash = $2
         and scope = $3::collaboration_scope
         and team_id is not distinct from $4::uuid
         and protocol_version = $5`,
      [
        binding.upstreamBackendId,
        binding.credentialBindingHash,
        binding.scope,
        binding.teamId,
        protocolVersion
      ]
    );
    return result.rows[0] ?? null;
  };

  const loadExact = async (
    subscriptionId: string,
    binding: LocalBinding
  ): Promise<LocalSubscriptionRow> => {
    const result = await requirePool(options.pool).query<LocalSubscriptionRow>(
      `select ${selectColumns}
       from local_edge_collaboration_subscriptions
       where id = $1
         and upstream_backend_id = $2
         and credential_binding_hash = $3
         and scope = $4::collaboration_scope
         and team_id is not distinct from $5::uuid
         and protocol_version = $6`,
      [
        subscriptionId,
        binding.upstreamBackendId,
        binding.credentialBindingHash,
        binding.scope,
        binding.teamId,
        protocolVersion
      ]
    );
    return (
      result.rows[0] ?? fail("Local collaboration subscription not found", 404)
    );
  };

  const personalSubscriptionBinding = (binding: PersonalBinding) => ({
    backendIdentityHash: sha256("koed:desktop-local"),
    principalIdHash: collaborationSubscriptionPrincipalHash(
      binding.localOwnerUserId
    ),
    deviceCredentialId: null,
    clientInstanceHash: binding.clientInstanceHash,
    subscriptionKeyHash: binding.subscriptionKeyHash,
    protocolVersion
  });

  const recoverPersonalSubscription = async (
    subscriptionId: string,
    binding: PersonalBinding
  ): Promise<CollaborationSubscriptionRecord> => {
    const recovered = await repository().recoverSubscription(
      { userId: binding.localOwnerUserId },
      {
        ...personalSubscriptionBinding(binding),
        scope: "personal",
        subscriptionId,
        afterCursor: 0,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000)
      }
    );
    const subscription =
      recovered?.subscription ??
      fail("Local collaboration subscription not found", 404);
    if (
      subscription.scope !== "personal" ||
      subscription.personalOwnerUserId !== binding.localOwnerUserId ||
      subscription.teamId !== null
    ) {
      fail("Local collaboration subscription is not active", 409);
    }
    if (subscription.state === "revoked") {
      fail("Local collaboration subscription access was revoked", 410);
    }
    if (subscription.state !== "active") {
      fail("Local collaboration subscription is not active", 409);
    }
    if (new Date(subscription.expiresAt) <= now()) {
      fail("Local collaboration subscription is not active", 409);
    }
    return subscription;
  };

  const postRemote = async (
    binding: LocalBinding,
    path: string,
    body: unknown
  ): Promise<unknown> => {
    assertUpstreamOperationPathAllowed(
      binding.scope === "personal"
        ? "personal_collaboration_read"
        : "team_workspace_read",
      "POST",
      path
    );
    let response: Response;
    try {
      response = await upstreamFetch(
        safeUpstreamProxyUrl(binding.upstreamBackend, path),
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: binding.upstreamAuthorization
          },
          body: JSON.stringify(body)
        }
      );
    } catch {
      fail("Upstream collaboration request failed", 502);
    }
    if (!response!.ok) fail("Upstream collaboration request failed", 502);
    const text = await readBoundedText(response!, maxSnapshotBytes);
    try {
      return JSON.parse(text);
    } catch {
      fail("Upstream collaboration response is invalid", 502);
    }
  };

  const persistSnapshot = async (
    pending: PendingSnapshot
  ): Promise<LocalSubscriptionRow> =>
    withTransaction(requirePool(options.pool), async (client) => {
      const lockKey = `${pending.binding.upstreamBackendId}:${pending.binding.scope}:${pending.binding.teamId ?? "personal"}:${protocolVersion}`;
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey]
      );
      const selected = await client.query<LocalSubscriptionRow>(
        `select ${selectColumns}
         from local_edge_collaboration_subscriptions
         where upstream_backend_id = $1
           and credential_binding_hash = $2
           and scope = $3::collaboration_scope
           and team_id is not distinct from $4::uuid
           and protocol_version = $5
         for update`,
        [
          pending.binding.upstreamBackendId,
          pending.binding.credentialBindingHash,
          pending.binding.scope,
          pending.binding.teamId,
          protocolVersion
        ]
      );
      const existing = selected.rows[0];
      if (!existing) {
        if (pending.expectedVersion !== 0) {
          fail("Local collaboration subscription changed", 409);
        }
        const inserted = await client.query<LocalSubscriptionRow>(
          `insert into local_edge_collaboration_subscriptions (
             id, scope, upstream_backend_id, credential_binding_hash, team_id,
             protocol_version, remote_subscription_id, remote_cursor,
             last_acknowledged_event_id, state, version, expires_at
           ) values ($1, $2::collaboration_scope, $3, $4, $5, $6, $7, $8, null, 'active', 1, $9)
           returning ${selectColumns}`,
          [
            pending.localSubscriptionId,
            pending.binding.scope,
            pending.binding.upstreamBackendId,
            pending.binding.credentialBindingHash,
            pending.binding.teamId,
            protocolVersion,
            pending.remoteSubscriptionId,
            pending.remoteCursor,
            pending.remoteExpiresAt
          ]
        );
        return inserted.rows[0]!;
      }
      if (
        existing.id !== pending.localSubscriptionId ||
        existing.version !== pending.expectedVersion ||
        existing.state !== "requires_snapshot"
      ) {
        fail("Local collaboration subscription changed", 409);
      }
      const updated = await client.query<LocalSubscriptionRow>(
        `update local_edge_collaboration_subscriptions
         set remote_subscription_id = $2,
             remote_cursor = $3,
             last_acknowledged_event_id = null,
             state = 'active',
             version = version + 1,
             updated_at = now(),
             expires_at = $4,
             revoked_at = null
         where id = $1 and version = $5
         returning ${selectColumns}`,
        [
          pending.localSubscriptionId,
          pending.remoteSubscriptionId,
          pending.remoteCursor,
          pending.remoteExpiresAt,
          pending.expectedVersion
        ]
      );
      return (
        updated.rows[0] ?? fail("Local collaboration subscription changed", 409)
      );
    });

  const persistAwaitingSnapshot = async (
    pending: Omit<PendingSnapshot, "expectedVersion">
  ): Promise<LocalSubscriptionRow> =>
    withTransaction(requirePool(options.pool), async (client) => {
      const lockKey = `${pending.binding.upstreamBackendId}:${pending.binding.scope}:${pending.binding.teamId ?? "personal"}:${protocolVersion}`;
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey]
      );
      await client.query(
        `update local_edge_collaboration_subscriptions
         set state = 'expired',
             version = version + 1,
             updated_at = now()
         where upstream_backend_id = $1
           and scope = $2::collaboration_scope
           and team_id is not distinct from $3::uuid
           and protocol_version = $4
           and credential_binding_hash <> $5
           and state in ('active', 'requires_snapshot')`,
        [
          pending.binding.upstreamBackendId,
          pending.binding.scope,
          pending.binding.teamId,
          protocolVersion,
          pending.binding.credentialBindingHash
        ]
      );
      const selected = await client.query<LocalSubscriptionRow>(
        `select ${selectColumns}
         from local_edge_collaboration_subscriptions
         where upstream_backend_id = $1
           and credential_binding_hash = $2
           and scope = $3::collaboration_scope
           and team_id is not distinct from $4::uuid
           and protocol_version = $5
         for update`,
        [
          pending.binding.upstreamBackendId,
          pending.binding.credentialBindingHash,
          pending.binding.scope,
          pending.binding.teamId,
          protocolVersion
        ]
      );
      const existing = selected.rows[0];
      if (!existing) {
        const inserted = await client.query<LocalSubscriptionRow>(
          `insert into local_edge_collaboration_subscriptions (
             id, scope, upstream_backend_id, credential_binding_hash, team_id,
             protocol_version, remote_subscription_id, remote_cursor,
             last_acknowledged_event_id, state, version, expires_at
           ) values ($1, $2::collaboration_scope, $3, $4, $5, $6, $7, $8, null, 'requires_snapshot', 1, $9)
           returning ${selectColumns}`,
          [
            pending.localSubscriptionId,
            pending.binding.scope,
            pending.binding.upstreamBackendId,
            pending.binding.credentialBindingHash,
            pending.binding.teamId,
            protocolVersion,
            pending.remoteSubscriptionId,
            pending.remoteCursor,
            pending.remoteExpiresAt
          ]
        );
        return inserted.rows[0]!;
      }
      const updated = await client.query<LocalSubscriptionRow>(
        `update local_edge_collaboration_subscriptions
         set remote_subscription_id = $2,
             remote_cursor = $3,
             last_acknowledged_event_id = null,
             state = 'requires_snapshot',
             version = version + 1,
             updated_at = now(),
             expires_at = $4,
             revoked_at = null
         where id = $1 and version = $5
         returning ${selectColumns}`,
        [
          existing.id,
          pending.remoteSubscriptionId,
          pending.remoteCursor,
          pending.remoteExpiresAt,
          existing.version
        ]
      );
      return (
        updated.rows[0] ?? fail("Local collaboration subscription changed", 409)
      );
    });

  const persistEventAck = async (
    pending: PendingRemoteEvent,
    expectedVersion: number
  ): Promise<LocalSubscriptionRow> =>
    withTransaction(requirePool(options.pool), async (client) => {
      const selected = await client.query<LocalSubscriptionRow>(
        `select ${selectColumns}
         from local_edge_collaboration_subscriptions
         where id = $1
           and upstream_backend_id = $2
           and credential_binding_hash = $3
           and scope = $4::collaboration_scope
           and team_id is not distinct from $5::uuid
           and protocol_version = $6
         for update`,
        [
          pending.localSubscriptionId,
          pending.binding.upstreamBackendId,
          pending.binding.credentialBindingHash,
          pending.binding.scope,
          pending.binding.teamId,
          protocolVersion
        ]
      );
      const row = selected.rows[0];
      if (
        !row ||
        row.version !== expectedVersion ||
        row.state !== "active" ||
        row.remoteSubscriptionId !== pending.remoteSubscriptionId
      ) {
        fail("Local collaboration subscription changed", 409);
      }
      const updated = await client.query<LocalSubscriptionRow>(
        `update local_edge_collaboration_subscriptions
         set remote_cursor = $2,
             last_acknowledged_event_id = $3,
             last_acknowledged_at = now(),
             updated_at = now(),
             version = version + 1
         where id = $1 and version = $4
         returning ${selectColumns}`,
        [
          pending.localSubscriptionId,
          pending.remoteCursor,
          pending.eventId,
          expectedVersion
        ]
      );
      return (
        updated.rows[0] ?? fail("Local collaboration subscription changed", 409)
      );
    });

  const transitionState = async (
    connection: ActiveConnection,
    state: "requires_snapshot" | "revoked"
  ): Promise<void> => {
    const result = await requirePool(options.pool).query<LocalSubscriptionRow>(
      `update local_edge_collaboration_subscriptions
       set state = $2::collaboration_stream_state,
           version = version + 1,
           updated_at = now(),
           revoked_at = case when $2 = 'revoked' then now() else revoked_at end
       where id = $1 and version = $3
       returning ${selectColumns}`,
      [connection.row.id, state, connection.row.version]
    );
    if (result.rows[0]) connection.row = result.rows[0];
  };

  const pendingFor = (subscriptionId: string): PendingEvent[] =>
    (pendingEventOrder.get(subscriptionId) ?? [])
      .map((deliveryId) => pendingEvents.get(deliveryId))
      .filter((event): event is PendingEvent => Boolean(event));

  const pendingSnapshotCount = (): number => {
    const current = now();
    for (const [deliveryId, pending] of pendingSnapshots) {
      if (pending.remoteExpiresAt <= current)
        pendingSnapshots.delete(deliveryId);
    }
    for (const [deliveryId, pending] of pendingPersonalSnapshots) {
      if (pending.expiresAt <= current) {
        pendingPersonalSnapshots.delete(deliveryId);
      }
    }
    return pendingSnapshots.size + pendingPersonalSnapshots.size;
  };

  const removePendingEvent = (deliveryId: string): PendingEvent | null => {
    const pending = pendingEvents.get(deliveryId);
    if (!pending) return null;
    pendingEvents.delete(deliveryId);
    pendingEventBytes = Math.max(0, pendingEventBytes - pending.bytes);
    clearTimeout(pendingEventDeadlines.get(deliveryId));
    pendingEventDeadlines.delete(deliveryId);
    const order = pendingEventOrder.get(pending.localSubscriptionId) ?? [];
    const nextOrder = order.filter((id) => id !== deliveryId);
    if (nextOrder.length > 0) {
      pendingEventOrder.set(pending.localSubscriptionId, nextOrder);
    } else {
      pendingEventOrder.delete(pending.localSubscriptionId);
    }
    connections
      .get(pending.localSubscriptionId)
      ?.seenEventIds.delete(pending.eventId);
    personalConnections
      .get(pending.localSubscriptionId)
      ?.seenEventIds.delete(pending.eventId);
    return pending;
  };

  const clearPendingEventsForSubscription = (subscriptionId: string): void => {
    for (const [deliveryId, pending] of pendingEvents) {
      if (pending.localSubscriptionId === subscriptionId) {
        removePendingEvent(deliveryId);
      }
    }
    pendingEventOrder.delete(subscriptionId);
  };

  const canQueuePendingEvent = (
    subscriptionId: string,
    bytes: number
  ): boolean => {
    const queued = pendingFor(subscriptionId);
    const queuedBytes = queued.reduce((total, item) => total + item.bytes, 0);
    return (
      pendingEvents.size < maxPendingEvents &&
      pendingEventBytes + bytes <= maxPendingBytes &&
      queued.length < maxPendingEvents &&
      queuedBytes + bytes <= maxPendingBytes
    );
  };

  const addPendingEvent = (pending: PendingEvent): boolean => {
    if (
      pendingEvents.has(pending.deliveryId) ||
      !canQueuePendingEvent(pending.localSubscriptionId, pending.bytes)
    ) {
      return false;
    }
    pendingEvents.set(pending.deliveryId, pending);
    pendingEventBytes += pending.bytes;
    const order = pendingEventOrder.get(pending.localSubscriptionId) ?? [];
    pendingEventOrder.set(pending.localSubscriptionId, [
      ...order,
      pending.deliveryId
    ]);
    return true;
  };

  const stopConnection = (connection: ActiveConnection): void => {
    if (connection.stopped) return;
    connection.stopped = true;
    connection.abort.abort();
    if (connections.get(connection.localSubscriptionId) === connection) {
      connections.delete(connection.localSubscriptionId);
    }
    if (
      !connection.reply.raw.destroyed &&
      !connection.reply.raw.writableEnded
    ) {
      connection.reply.raw.end();
    }
  };

  const stopPersonalConnection = (
    connection: ActivePersonalConnection
  ): void => {
    if (connection.stopped) return;
    connection.stopped = true;
    connection.abort.abort();
    if (
      personalConnections.get(connection.localSubscriptionId) === connection
    ) {
      personalConnections.delete(connection.localSubscriptionId);
    }
    if (connection.listenClient && connection.listenNotification) {
      connection.listenClient.off?.(
        "notification",
        connection.listenNotification
      );
    }
    if (connection.listenClient && connection.listenError) {
      connection.listenClient.off?.("error", connection.listenError);
    }
    connection.listenNotification = null;
    connection.listenError = null;
    connection.listenClient?.release();
    connection.listenClient = null;
    if (
      !connection.reply.raw.destroyed &&
      !connection.reply.raw.writableEnded
    ) {
      connection.reply.raw.end();
    }
  };

  const controlEvent = (
    subscriptionId: string,
    reason: CollaborationControlReason
  ): CollaborationRendererEvent =>
    rendererEvent({
      contractVersion: protocolVersion,
      type: "control",
      subscriptionId,
      occurredAt: now().toISOString(),
      reason
    });

  const sendControlAndStop = async (
    connection: ActiveConnection,
    reason: CollaborationControlReason
  ) => {
    clearPendingEventsForSubscription(connection.localSubscriptionId);
    await writeRendererEvent(
      connection.reply,
      controlEvent(connection.localSubscriptionId, reason)
    );
    stopConnection(connection);
  };

  const sendPersonalControlAndStop = async (
    connection: ActivePersonalConnection,
    reason: CollaborationControlReason
  ) => {
    clearPendingEventsForSubscription(connection.localSubscriptionId);
    await writeRendererEvent(
      connection.reply,
      controlEvent(connection.localSubscriptionId, reason)
    );
    stopPersonalConnection(connection);
  };

  const writeConnectionEvent = async (
    connection: ActiveConnection,
    state:
      | "connecting"
      | "live"
      | "reconnecting"
      | "unavailable"
      | "access_revoked",
    reconnectAttempt: number,
    retryAt: string | null,
    error: CollaborationSafeError | null
  ): Promise<void> => {
    await writeRendererEvent(connection.reply, {
      contractVersion: protocolVersion,
      type: "connection",
      connection: {
        state,
        backendId: connection.binding.upstreamBackendId,
        connectedAt: state === "live" ? now().toISOString() : null,
        retryAt,
        reconnectAttempt,
        protocolVersion
      },
      error
    });
  };

  const writePersonalLiveEvent = async (
    connection: ActivePersonalConnection
  ): Promise<void> => {
    await writeRendererEvent(connection.reply, {
      contractVersion: protocolVersion,
      type: "connection",
      connection: {
        state: "live",
        backendId: null,
        connectedAt: now().toISOString(),
        retryAt: null,
        reconnectAttempt: 0,
        protocolVersion
      },
      error: null
    });
  };

  const handleRemoteEvent = async (
    connection: ActiveConnection,
    parsed: ParsedSseEvent
  ): Promise<void> => {
    if (!parsed.data || connection.stopped) return;
    if (parsed.event === "ready" || parsed.event === "heartbeat") {
      if (parsed.event === "heartbeat") {
        await writeLocalComment(connection.reply, "heartbeat");
      }
      return;
    }
    if (parsed.event === "control" || parsed.event === "access_revoked") {
      let control: z.infer<typeof remoteControlSchema>;
      try {
        control = remoteControlSchema.parse(JSON.parse(parsed.data));
      } catch {
        fail("Upstream collaboration control event is invalid", 502);
      }
      if (control!.subscription.id !== connection.row.remoteSubscriptionId) {
        fail("Upstream collaboration control binding is invalid", 502);
      }
      options.onRemoteNavigationInvalidated?.(
        connection.binding.upstreamBackendId
      );
      if (
        control!.reason === "access_revoked" ||
        parsed.event === "access_revoked"
      ) {
        await transitionState(connection, "revoked");
        if (
          (await remotePrincipalAuthorizationState(connection.binding)) ===
          "revoked"
        ) {
          await writeConnectionEvent(
            connection,
            "access_revoked",
            0,
            null,
            safeError("access_revoked")
          );
        }
        await sendControlAndStop(connection, "access_revoked");
      } else if (control!.reason === "requires_snapshot") {
        await transitionState(connection, "requires_snapshot");
        await sendControlAndStop(connection, "requires_snapshot");
      } else {
        await sendControlAndStop(connection, control!.reason);
      }
      return;
    }
    if (parsed.event !== "collaboration_event") return;
    let event: z.infer<typeof remoteEventSchema>;
    try {
      event = remoteEventSchema.parse(JSON.parse(parsed.data));
    } catch {
      fail("Upstream collaboration event is invalid", 502);
    }
    if (
      event!.subscription.id !== connection.row.remoteSubscriptionId ||
      event!.resource.scope !== connection.binding.scope ||
      event!.resource.teamId !== connection.binding.teamId
    ) {
      fail("Upstream collaboration event binding is invalid", 502);
    }
    if (
      event!.type === "access_revoked" &&
      event!.resource.shareGrantId === null
    ) {
      await transitionState(connection, "revoked");
      if (
        (await remotePrincipalAuthorizationState(connection.binding)) ===
        "revoked"
      ) {
        await writeConnectionEvent(
          connection,
          "access_revoked",
          0,
          null,
          safeError("access_revoked")
        );
      }
      await sendControlAndStop(connection, "access_revoked");
      return;
    }
    if (
      event!.eventId === connection.row.lastAcknowledgedEventId ||
      connection.seenEventIds.has(event!.eventId) ||
      pendingFor(connection.localSubscriptionId).some(
        (pending) => pending.eventId === event!.eventId
      )
    ) {
      return;
    }
    options.onRemoteNavigationInvalidated?.(
      connection.binding.upstreamBackendId
    );
    const payload = rendererUpdateEvent({
      contractVersion: protocolVersion,
      type: "update",
      subscriptionId: connection.localSubscriptionId,
      deliveryId: hmac(options.brokerSecret, "event-delivery", [
        connection.localSubscriptionId,
        event!.eventId
      ]),
      eventId: event!.eventId,
      occurredAt: event!.occurredAt,
      family: event!.type,
      resource: {
        scope: event!.resource.scope,
        teamId: event!.resource.teamId,
        workspaceId: event!.resource.teamWorkspaceId,
        threadId: event!.resource.threadId,
        messageId: event!.resource.messageId,
        sharedSessionId: event!.resource.sharedSessionId,
        shareGrantId: event!.resource.shareGrantId
      },
      update: event!.update
    });
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const pending: PendingRemoteEvent = {
      kind: "remote_event",
      localSubscriptionId: connection.localSubscriptionId,
      binding: connection.binding,
      deliveryId: payload.deliveryId,
      eventId: event!.eventId,
      remoteSubscriptionId: connection.row.remoteSubscriptionId,
      remoteCursor: event!.cursor,
      bytes
    };
    if (!addPendingEvent(pending)) {
      await sendControlAndStop(connection, "backpressure");
      return;
    }
    connection.seenEventIds.add(event!.eventId);
    const deadline = setTimeout(() => {
      if (!pendingEvents.has(pending.deliveryId)) return;
      removePendingEvent(pending.deliveryId);
      void sendControlAndStop(connection, "backpressure");
    }, ackDeadlineMs);
    deadline.unref?.();
    pendingEventDeadlines.set(pending.deliveryId, deadline);
    await writeRendererEvent(connection.reply, payload, payload.deliveryId);
  };

  const flushPersonalReplay = async (
    connection: ActivePersonalConnection
  ): Promise<void> => {
    if (connection.stopped) return;
    const replay = await repository().replayEvents(
      { userId: connection.binding.localOwnerUserId },
      {
        scope: "personal",
        afterCursor: connection.cursor,
        limit: maxPendingEvents
      }
    );
    if (!replay) {
      await sendPersonalControlAndStop(connection, "access_revoked");
      return;
    }
    for (const event of replay.events) {
      if (connection.stopped) return;
      if (
        event.id === connection.subscription.acknowledgedEventId ||
        connection.seenEventIds.has(event.id) ||
        pendingFor(connection.localSubscriptionId).some(
          (pending) => pending.eventId === event.id
        )
      ) {
        connection.cursor = Math.max(connection.cursor, event.cursor);
        continue;
      }
      const materialized = await materializePersonalRealtimeEvent(
        { userId: connection.binding.localOwnerUserId },
        event,
        options.requireCollaborationMaterializationRepository()
      );
      if (materialized.action !== "deliver") {
        await sendPersonalControlAndStop(connection, "requires_snapshot");
        return;
      }
      const payload = rendererUpdateEvent({
        contractVersion: protocolVersion,
        type: "update",
        subscriptionId: connection.localSubscriptionId,
        deliveryId: hmac(options.brokerSecret, "personal-event-delivery", [
          connection.localSubscriptionId,
          event.id,
          String(event.cursor)
        ]),
        eventId: event.id,
        occurredAt: event.occurredAt,
        family: event.family,
        resource: {
          scope: event.scope,
          teamId: event.teamId,
          workspaceId: event.teamWorkspaceId,
          threadId: event.threadId,
          messageId: event.messageId,
          sharedSessionId: event.shareGrantId,
          shareGrantId: event.shareGrantId
        },
        update: materialized.update
      });
      const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      const pending: PendingPersonalEvent = {
        kind: "personal_event",
        localSubscriptionId: connection.localSubscriptionId,
        binding: connection.binding,
        deliveryId: payload.deliveryId,
        eventId: event.id,
        cursor: event.cursor,
        bytes
      };
      if (!addPendingEvent(pending)) {
        await sendPersonalControlAndStop(connection, "backpressure");
        return;
      }
      connection.seenEventIds.add(event.id);
      const deadline = setTimeout(() => {
        if (!pendingEvents.has(pending.deliveryId)) return;
        removePendingEvent(pending.deliveryId);
        void sendPersonalControlAndStop(connection, "backpressure");
      }, ackDeadlineMs);
      deadline.unref?.();
      pendingEventDeadlines.set(pending.deliveryId, deadline);
      await writeRendererEvent(connection.reply, payload, payload.deliveryId);
      connection.cursor = Math.max(connection.cursor, event.cursor);
    }
    if (replay.hasMore && !connection.stopped) connection.flushRequested = true;
  };

  const drainPersonalReplay = async (
    connection: ActivePersonalConnection
  ): Promise<void> => {
    if (connection.stopped) return;
    if (connection.flushing) {
      connection.flushRequested = true;
      return;
    }
    connection.flushing = true;
    try {
      do {
        connection.flushRequested = false;
        await flushPersonalReplay(connection);
      } while (connection.flushRequested && !connection.stopped);
    } finally {
      connection.flushing = false;
    }
  };

  const openRemoteStream = async (
    connection: ActiveConnection
  ): Promise<Response> => {
    assertUpstreamOperationPathAllowed(
      connection.binding.scope === "personal"
        ? "personal_collaboration_read"
        : "team_workspace_read",
      "GET",
      remoteStreamPath
    );
    const query = new URLSearchParams({
      scope: connection.binding.scope,
      clientInstanceId: connection.binding.clientInstanceId,
      subscriptionKey: connection.binding.subscriptionKey,
      cursor: connection.row.remoteCursor
    });
    if (connection.binding.teamId) {
      query.set("teamId", connection.binding.teamId);
    }
    try {
      return await upstreamFetch(
        safeUpstreamProxyUrl(
          connection.binding.upstreamBackend,
          `${remoteStreamPath}?${query.toString()}`
        ),
        {
          method: "GET",
          redirect: "error",
          headers: {
            accept: "text/event-stream",
            authorization: connection.binding.upstreamAuthorization
          },
          signal: connection.abort.signal
        }
      );
    } catch {
      return fail("Upstream collaboration stream failed", 502);
    }
  };

  const runConnection = async (connection: ActiveConnection): Promise<void> => {
    const reconnectAttempts: number[] = [];
    while (!closing && !connection.stopped) {
      let connectedAt: number | null = null;
      try {
        const response = await openRemoteStream(connection);
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 410
        ) {
          await response.body?.cancel().catch(() => undefined);
          await transitionState(connection, "revoked");
          await sendControlAndStop(connection, "access_revoked");
          return;
        }
        const body = response.body;
        if (!response.ok || !body) {
          await body?.cancel().catch(() => undefined);
          fail("Upstream collaboration stream failed", 502);
        }
        connectedAt = now().getTime();
        await writeConnectionEvent(connection, "live", 0, null, null);
        await consumeSse(body!, maxRemoteEventBytes, (event) =>
          handleRemoteEvent(connection, event)
        );
        if (connection.stopped) return;
      } catch {
        if (connection.abort.signal.aborted || connection.stopped || closing) {
          return;
        }
      }
      const attemptNow = now().getTime();
      if (
        connectedAt !== null &&
        attemptNow - connectedAt >= reconnectStableResetMs
      ) {
        reconnectAttempts.length = 0;
      }
      while (
        reconnectAttempts.length > 0 &&
        attemptNow - reconnectAttempts[0]! >= reconnectWindowMs
      ) {
        reconnectAttempts.shift();
      }
      if (reconnectAttempts.length >= maxReconnectAttempts) {
        const retryAt = new Date(
          attemptNow + reconnectUnavailableCooldownMs
        ).toISOString();
        await writeConnectionEvent(
          connection,
          "unavailable",
          reconnectAttempts.length,
          retryAt,
          safeError("temporarily_unavailable", reconnectUnavailableCooldownMs)
        );
        if (maxReconnectAttempts === 0) {
          stopConnection(connection);
          return;
        }
        try {
          await sleep(reconnectUnavailableCooldownMs, connection.abort.signal);
        } catch {
          return;
        }
        reconnectAttempts.length = 0;
        continue;
      }
      reconnectAttempts.push(attemptNow);
      const reconnectAttempt = reconnectAttempts.length;
      const delay = calculateCollaborationReconnectDelay({
        attempt: reconnectAttempt - 1,
        baseMs: reconnectBaseMs,
        maxMs: reconnectMaxMs,
        jitter: reconnectJitter,
        random: random()
      });
      await writeConnectionEvent(
        connection,
        "reconnecting",
        reconnectAttempt,
        new Date(attemptNow + delay).toISOString(),
        safeError("temporarily_unavailable", delay)
      );
      try {
        await sleep(delay, connection.abort.signal);
      } catch {
        return;
      }
    }
  };

  const registerRoutes = () => {
    if (registered) return;
    registered = true;

    options.app.post(
      "/v1/local-edge/collaboration/realtime/subscriptions",
      async (request) => {
        const input = parseOrFail(
          createLocalEdgeCollaborationSubscriptionSchema,
          request.body
        );
        if (input.scope === "personal" && !configuredRemotePersonalBackend()) {
          const binding = await authorizePersonal(request);
          const hasPendingForBinding = [
            ...pendingPersonalSnapshots.values()
          ].some(
            (pending) =>
              pending.binding.credentialBindingHash ===
              binding.credentialBindingHash
          );
          if (
            !hasPendingForBinding &&
            pendingSnapshotCount() >= maxConnections
          ) {
            fail("Local collaboration snapshot limit reached", 429);
          }
          const snapshot = await repository().getAuthorizedSnapshot(
            { userId: binding.localOwnerUserId },
            { scope: "personal", includeArchived: true }
          );
          if (!snapshot) {
            return fail("Personal collaboration snapshot is unavailable", 403);
          }
          const authorizedSnapshot = snapshot;
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
          const subscription = await repository().createSubscription(
            { userId: binding.localOwnerUserId },
            {
              ...personalSubscriptionBinding(binding),
              scope: "personal",
              snapshotHighWaterCursor: authorizedSnapshot.highWaterCursor,
              expiresAt
            }
          );
          if (!subscription) {
            return fail(
              "Personal collaboration subscription cannot be created",
              403
            );
          }
          const createdSubscription = subscription;
          const localSubscriptionId = createdSubscription.id;
          const deliveryId = hmac(
            options.brokerSecret,
            "personal-snapshot-delivery",
            [
              localSubscriptionId,
              binding.localOwnerUserId,
              String(authorizedSnapshot.highWaterCursor)
            ]
          );
          const responsePayload = {
            protocolVersion,
            subscription: {
              id: localSubscriptionId,
              protocolVersion,
              scope: { scope: "personal" as const },
              state: "awaiting_snapshot_ack",
              version: 1,
              expiresAt: expiresAt.toISOString()
            },
            delivery: {
              deliveryId,
              eventId: null,
              type: "snapshot",
              snapshot: {
                scope: "personal",
                personalOwnerUserId: binding.localOwnerUserId,
                highWaterCursor: authorizedSnapshot.highWaterCursor,
                threads: authorizedSnapshot.threads
              }
            }
          };
          if (
            Buffer.byteLength(JSON.stringify(responsePayload), "utf8") >
            maxSnapshotBytes
          ) {
            fail("Local collaboration snapshot is too large", 413);
          }
          for (const [key, pending] of pendingPersonalSnapshots) {
            if (pending.localSubscriptionId === localSubscriptionId) {
              pendingPersonalSnapshots.delete(key);
            }
          }
          pendingPersonalSnapshots.set(deliveryId, {
            kind: "personal_snapshot",
            localSubscriptionId,
            expectedVersion: 1,
            binding,
            deliveryId,
            highWaterCursor: authorizedSnapshot.highWaterCursor,
            expiresAt
          });
          return responsePayload;
        }
        const binding =
          input.scope === "personal"
            ? await authorizeRemotePersonal(request)
            : await authorizeTeam(
                request,
                input.upstream_backend_id,
                input.team_id
              );
        const existing = await loadByBinding(binding);
        const hasPendingForBinding = [...pendingSnapshots.values()].some(
          (pending) =>
            pending.binding.upstreamBackendId === binding.upstreamBackendId &&
            pending.binding.credentialBindingHash ===
              binding.credentialBindingHash &&
            pending.binding.scope === binding.scope &&
            pending.binding.teamId === binding.teamId
        );
        if (!hasPendingForBinding && pendingSnapshotCount() >= maxConnections) {
          fail("Local collaboration snapshot limit reached", 429);
        }
        const rawSnapshot = await postRemote(binding, remoteSnapshotPath, {
          scope: binding.scope,
          ...(binding.teamId ? { teamId: binding.teamId } : {}),
          clientInstanceId: binding.clientInstanceId,
          subscriptionKey: binding.subscriptionKey
        });
        let remote: z.infer<typeof remoteSnapshotSchema>;
        try {
          remote = remoteSnapshotSchema.parse(rawSnapshot);
        } catch {
          fail("Upstream collaboration snapshot is invalid", 502);
        }
        if (
          remote!.snapshot.scope !== binding.scope ||
          remote!.snapshot.teamId !== binding.teamId ||
          (binding.scope === "personal" &&
            remote!.snapshot.personalOwnerUserId !== binding.remotePrincipalId)
        ) {
          fail("Upstream collaboration snapshot binding is invalid", 502);
        }
        const localSubscriptionId = existing?.id ?? randomUUID();
        const deliveryId = hmac(options.brokerSecret, "snapshot-delivery", [
          localSubscriptionId,
          remote!.subscription.id,
          remote!.cursor
        ]);
        const remoteExpiresAt = new Date(remote!.subscription.expiresAt);
        if (
          !Number.isFinite(remoteExpiresAt.getTime()) ||
          remoteExpiresAt <= now()
        ) {
          fail("Upstream collaboration snapshot is expired", 502);
        }
        const currentConnection = connections.get(localSubscriptionId);
        if (currentConnection) stopConnection(currentConnection);
        for (const [key, pending] of pendingSnapshots) {
          if (pending.localSubscriptionId === localSubscriptionId) {
            pendingSnapshots.delete(key);
          }
        }
        const pendingSnapshot = {
          kind: "snapshot",
          localSubscriptionId,
          binding,
          deliveryId,
          remoteSubscriptionId: remote!.subscription.id,
          remoteCursor: remote!.cursor,
          remoteExpiresAt
        } satisfies Omit<PendingSnapshot, "expectedVersion">;
        const awaiting = await persistAwaitingSnapshot(pendingSnapshot);
        for (const [key, pending] of pendingSnapshots) {
          if (
            pending.binding.upstreamBackendId === binding.upstreamBackendId &&
            pending.binding.scope === binding.scope &&
            pending.binding.teamId === binding.teamId &&
            pending.binding.credentialBindingHash !==
              binding.credentialBindingHash
          ) {
            pendingSnapshots.delete(key);
          }
        }
        for (const connection of connections.values()) {
          if (
            connection.binding.upstreamBackendId ===
              binding.upstreamBackendId &&
            connection.binding.scope === binding.scope &&
            connection.binding.teamId === binding.teamId &&
            connection.binding.credentialBindingHash !==
              binding.credentialBindingHash
          ) {
            stopConnection(connection);
          }
        }
        pendingSnapshots.set(deliveryId, {
          ...pendingSnapshot,
          expectedVersion: awaiting.version
        });
        return {
          protocolVersion,
          subscription: {
            id: localSubscriptionId,
            protocolVersion,
            scope:
              binding.scope === "personal"
                ? { scope: "personal" as const }
                : { scope: "team" as const, teamId: binding.teamId! },
            state: "awaiting_snapshot_ack",
            version: awaiting.version,
            expiresAt: remoteExpiresAt.toISOString()
          },
          delivery: {
            deliveryId,
            eventId: null,
            type: "snapshot",
            snapshot: {
              scope: binding.scope,
              ...(binding.scope === "personal"
                ? {
                    personalOwnerUserId: binding.localOwnerUserId,
                    highWaterCursor: 0
                  }
                : { teamId: binding.teamId! }),
              threads: remote!.snapshot.threads
            }
          }
        };
      }
    );

    options.app.post(
      "/v1/local-edge/collaboration/realtime/subscriptions/:subscriptionId/ack",
      async (request) => {
        const params = parseOrFail(
          localEdgeCollaborationSubscriptionParamsSchema,
          request.params
        );
        const input = parseOrFail(
          acknowledgeLocalEdgeCollaborationDeliverySchema,
          request.body
        );
        if (input.scope === "personal" && !configuredRemotePersonalBackend()) {
          const binding = await authorizePersonal(request);
          const snapshot = pendingPersonalSnapshots.get(input.delivery_id);
          if (snapshot) {
            if (
              input.event_id !== null ||
              params.subscriptionId !== snapshot.localSubscriptionId ||
              input.expected_version !== snapshot.expectedVersion ||
              binding.credentialBindingHash !==
                snapshot.binding.credentialBindingHash
            ) {
              fail("Local collaboration delivery cannot be acknowledged", 403);
            }
            const subscription = await recoverPersonalSubscription(
              snapshot.localSubscriptionId,
              binding
            );
            pendingPersonalSnapshots.delete(input.delivery_id);
            return {
              protocolVersion,
              subscription: publicPersonalSubscription(
                subscription,
                binding.localOwnerUserId
              )
            };
          }
          const pendingCandidate = pendingEvents.get(input.delivery_id);
          if (!pendingCandidate || pendingCandidate.kind !== "personal_event") {
            if (input.event_id === null) {
              await recoverPersonalSubscription(params.subscriptionId, binding);
              return fail(
                "Collaboration snapshot acknowledgement was lost",
                409
              );
            }
            return fail(
              "Local collaboration delivery cannot be acknowledged",
              403
            );
          }
          const pending = pendingCandidate as PendingPersonalEvent;
          if (
            input.event_id !== pending.eventId ||
            params.subscriptionId !== pending.localSubscriptionId ||
            binding.credentialBindingHash !==
              pending.binding.credentialBindingHash
          ) {
            fail("Local collaboration delivery cannot be acknowledged", 403);
          }
          const order =
            pendingEventOrder.get(pending.localSubscriptionId) ?? [];
          if (order[0] !== pending.deliveryId) {
            fail(
              "Local collaboration deliveries must be acknowledged in order",
              409
            );
          }
          const subscription = await repository().acknowledgeSubscription(
            { userId: binding.localOwnerUserId },
            {
              ...personalSubscriptionBinding(binding),
              subscriptionId: pending.localSubscriptionId,
              eventId: pending.eventId,
              cursor: pending.cursor
            }
          );
          if (!subscription) {
            return fail(
              "Local collaboration delivery cannot be acknowledged",
              403
            );
          }
          const acknowledgedSubscription =
            subscription as CollaborationSubscriptionRecord;
          removePendingEvent(pending.deliveryId);
          const connection = personalConnections.get(
            pending.localSubscriptionId
          );
          if (connection) {
            connection.subscription = acknowledgedSubscription;
            connection.cursor = Math.max(connection.cursor, pending.cursor);
          }
          return {
            protocolVersion,
            subscription: publicPersonalSubscription(
              acknowledgedSubscription,
              binding.localOwnerUserId
            )
          };
        }
        const binding =
          input.scope === "personal"
            ? await authorizeRemotePersonal(request)
            : await authorizeTeam(
                request,
                input.upstream_backend_id,
                input.team_id
              );
        const snapshot = pendingSnapshots.get(input.delivery_id);
        if (snapshot) {
          if (
            input.event_id !== null ||
            params.subscriptionId !== snapshot.localSubscriptionId ||
            input.expected_version !== snapshot.expectedVersion ||
            binding.upstreamBackendId !== snapshot.binding.upstreamBackendId ||
            binding.scope !== snapshot.binding.scope ||
            binding.teamId !== snapshot.binding.teamId ||
            binding.credentialBindingHash !==
              snapshot.binding.credentialBindingHash
          ) {
            fail("Local collaboration delivery cannot be acknowledged", 403);
          }
          const row = await persistSnapshot(snapshot);
          pendingSnapshots.delete(input.delivery_id);
          return { protocolVersion, subscription: publicSubscription(row) };
        }
        const pendingCandidate = pendingEvents.get(input.delivery_id);
        if (!pendingCandidate || pendingCandidate.kind !== "remote_event") {
          if (input.event_id === null) {
            const awaiting = await loadExact(params.subscriptionId, binding);
            if (awaiting.state === "requires_snapshot") {
              return fail(
                "Collaboration snapshot acknowledgement was lost",
                409
              );
            }
          }
          return fail(
            "Local collaboration delivery cannot be acknowledged",
            403
          );
        }
        const eventPending = pendingCandidate as PendingRemoteEvent;
        if (
          input.event_id !== eventPending.eventId ||
          params.subscriptionId !== eventPending.localSubscriptionId ||
          binding.upstreamBackendId !==
            eventPending.binding.upstreamBackendId ||
          binding.scope !== eventPending.binding.scope ||
          binding.teamId !== eventPending.binding.teamId ||
          binding.credentialBindingHash !==
            eventPending.binding.credentialBindingHash
        ) {
          fail("Local collaboration delivery cannot be acknowledged", 403);
        }
        const order =
          pendingEventOrder.get(eventPending.localSubscriptionId) ?? [];
        if (order[0] !== eventPending.deliveryId) {
          fail(
            "Local collaboration deliveries must be acknowledged in order",
            409
          );
        }
        const rawAck = await postRemote(eventPending.binding, remoteAckPath, {
          subscriptionId: eventPending.remoteSubscriptionId,
          eventId: eventPending.eventId,
          cursor: eventPending.remoteCursor,
          clientInstanceId: eventPending.binding.clientInstanceId,
          subscriptionKey: eventPending.binding.subscriptionKey
        });
        let remoteAck: z.infer<typeof remoteAckResponseSchema>;
        try {
          remoteAck = remoteAckResponseSchema.parse(rawAck);
        } catch {
          fail("Upstream collaboration acknowledgement is invalid", 502);
        }
        if (
          remoteAck!.subscription.id !== eventPending.remoteSubscriptionId ||
          remoteAck!.subscription.scope !== eventPending.binding.scope ||
          remoteAck!.subscription.teamId !== eventPending.binding.teamId ||
          (eventPending.binding.scope === "personal" &&
            remoteAck!.subscription.personalOwnerUserId !==
              eventPending.binding.remotePrincipalId) ||
          remoteAck!.subscription.state !== "active" ||
          remoteAck!.subscription.acknowledgedEventId !== eventPending.eventId
        ) {
          fail(
            "Upstream collaboration acknowledgement binding is invalid",
            502
          );
        }
        await options.afterRemoteAck?.();
        const row = await persistEventAck(eventPending, input.expected_version);
        removePendingEvent(eventPending.deliveryId);
        const connection = connections.get(eventPending.localSubscriptionId);
        if (connection) connection.row = row;
        return { protocolVersion, subscription: publicSubscription(row) };
      }
    );

    options.app.get(
      "/v1/local-edge/collaboration/realtime/subscriptions/:subscriptionId/stream",
      async (request, reply) => {
        const params = parseOrFail(
          localEdgeCollaborationSubscriptionParamsSchema,
          request.params
        );
        const input = parseOrFail(
          localEdgeCollaborationStreamQuerySchema,
          request.query
        );
        if (input.scope === "personal" && !configuredRemotePersonalBackend()) {
          const binding = await authorizePersonal(request);
          const subscription = await recoverPersonalSubscription(
            params.subscriptionId,
            binding
          );
          const existingConnection = personalConnections.get(
            params.subscriptionId
          );
          if (
            connections.size +
              personalConnections.size -
              (existingConnection ? 1 : 0) >=
            maxConnections
          ) {
            fail("Local collaboration realtime connection limit reached", 429);
          }
          if (existingConnection) stopPersonalConnection(existingConnection);
          reply.hijack();
          reply.raw.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no"
          });
          const connection: ActivePersonalConnection = {
            localSubscriptionId: params.subscriptionId,
            binding,
            subscription,
            reply,
            abort: new AbortController(),
            stopped: false,
            seenEventIds: new Set(
              pendingFor(params.subscriptionId).map((event) => event.eventId)
            ),
            cursor: Math.max(
              subscription.acknowledgedCursor,
              subscription.snapshotHighWaterCursor ?? 0
            ),
            flushing: false,
            flushRequested: false,
            listenNotification: null,
            listenError: null,
            listenClient: null
          };
          personalConnections.set(params.subscriptionId, connection);
          await writePersonalLiveEvent(connection);
          reply.raw.once("close", () => stopPersonalConnection(connection));
          void (async () => {
            try {
              const client = await (
                requirePool(options.pool).connect as unknown as () => Promise<
                  ActivePersonalConnection["listenClient"]
                >
              )();
              if (!client || connection.stopped) {
                client?.release();
                return;
              }
              connection.listenClient = client;
              const onNotification = () => {
                if (connection.stopped) return;
                connection.flushRequested = true;
                void drainPersonalReplay(connection).catch(async () => {
                  if (!connection.stopped) {
                    await sendPersonalControlAndStop(
                      connection,
                      "server_shutdown"
                    );
                  }
                });
              };
              const onError = () => {
                if (connection.stopped) return;
                void sendPersonalControlAndStop(connection, "server_shutdown");
              };
              connection.listenNotification = onNotification;
              connection.listenError = onError;
              client.on?.("notification", onNotification);
              client.on?.("error", onError);
              await client.query("listen koed_collaboration_realtime");
              await drainPersonalReplay(connection);
            } catch {
              if (!connection.stopped) {
                await sendPersonalControlAndStop(connection, "server_shutdown");
              }
            }
          })();
          return;
        }
        const binding =
          input.scope === "personal"
            ? await authorizeRemotePersonal(request)
            : await authorizeTeam(
                request,
                input.upstream_backend_id,
                input.team_id
              );
        const row = await loadExact(params.subscriptionId, binding);
        if (row.state === "revoked") {
          fail("Local collaboration subscription access was revoked", 410);
        }
        if (row.state !== "active" || new Date(row.expiresAt) <= now()) {
          fail("Local collaboration subscription is not active", 409);
        }
        const existingConnection = connections.get(params.subscriptionId);
        if (
          connections.size +
            personalConnections.size -
            (existingConnection ? 1 : 0) >=
          maxConnections
        ) {
          fail("Local collaboration realtime connection limit reached", 429);
        }
        if (existingConnection) stopConnection(existingConnection);
        const connected = await requirePool(
          options.pool
        ).query<LocalSubscriptionRow>(
          `update local_edge_collaboration_subscriptions
           set last_connected_at = now(), updated_at = now()
           where id = $1 and version = $2
           returning ${selectColumns}`,
          [row.id, row.version]
        );
        if (connected.rows[0]) Object.assign(row, connected.rows[0]);
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        const connection: ActiveConnection = {
          localSubscriptionId: params.subscriptionId,
          binding,
          row,
          reply,
          abort: new AbortController(),
          stopped: false,
          seenEventIds: new Set(
            pendingFor(params.subscriptionId).map((event) => event.eventId)
          )
        };
        connections.set(params.subscriptionId, connection);
        await writeConnectionEvent(connection, "connecting", 0, null, null);
        reply.raw.once("close", () => stopConnection(connection));
        void runConnection(connection);
      }
    );

    options.app.delete(
      "/v1/local-edge/collaboration/realtime/backends/:backendId/subscriptions",
      async (request) => {
        assertLocalTrust(request, options.corsOrigins);
        const binding = await authorizePersonal(request);
        const params = parseOrFail(
          localEdgeCollaborationBackendParamsSchema,
          request.params
        );
        await options.quarantineCrossIdentitySyncForBackend(
          binding.localOwnerUserId,
          params.backendId
        );
        await options.revokeSharedMemoryAuthorityForBackend(
          binding.localOwnerUserId,
          params.backendId
        );
        const result = await requirePool(options.pool).query<{ id: string }>(
          `delete from local_edge_collaboration_subscriptions
           where upstream_backend_id = $1
           returning id`,
          [params.backendId]
        );
        const revokedIds = new Set(result.rows.map((row) => row.id));
        for (const connection of [...connections.values()]) {
          if (connection.binding.upstreamBackendId === params.backendId) {
            revokedIds.add(connection.localSubscriptionId);
            stopConnection(connection);
          }
        }
        for (const [deliveryId, pending] of pendingSnapshots) {
          if (revokedIds.has(pending.localSubscriptionId)) {
            pendingSnapshots.delete(deliveryId);
          }
        }
        for (const [deliveryId, pending] of pendingEvents) {
          if (revokedIds.has(pending.localSubscriptionId)) {
            removePendingEvent(deliveryId);
          }
        }
        for (const subscriptionId of revokedIds) {
          pendingEventOrder.delete(subscriptionId);
        }
        return {
          protocolVersion,
          revokedSubscriptionCount: revokedIds.size
        };
      }
    );

    options.app.delete(
      "/v1/local-edge/collaboration/realtime/subscriptions/:subscriptionId",
      async (request) => {
        const params = parseOrFail(
          localEdgeCollaborationSubscriptionParamsSchema,
          request.params
        );
        const input = parseOrFail(
          unsubscribeLocalEdgeCollaborationSchema,
          request.body
        );
        if (input.scope === "personal" && !configuredRemotePersonalBackend()) {
          const binding = await authorizePersonal(request);
          const subscription = await recoverPersonalSubscription(
            params.subscriptionId,
            binding
          );
          if (input.expected_version !== 1) {
            fail("Local collaboration subscription changed", 409);
          }
          await repository().revokeSubscriptions({
            scope: "personal",
            backendIdentityHash: sha256("koed:desktop-local"),
            principalIdHash: collaborationSubscriptionPrincipalHash(
              binding.localOwnerUserId
            ),
            reason: "client_replaced"
          });
          const connection = personalConnections.get(params.subscriptionId);
          if (connection) stopPersonalConnection(connection);
          for (const [deliveryId, pending] of pendingPersonalSnapshots) {
            if (pending.localSubscriptionId === params.subscriptionId) {
              pendingPersonalSnapshots.delete(deliveryId);
            }
          }
          for (const [deliveryId, pending] of pendingEvents) {
            if (pending.localSubscriptionId === params.subscriptionId) {
              removePendingEvent(deliveryId);
            }
          }
          pendingEventOrder.delete(params.subscriptionId);
          return {
            protocolVersion,
            subscription: {
              ...publicPersonalSubscription(
                subscription,
                binding.localOwnerUserId
              ),
              state: "expired"
            }
          };
        }
        const binding =
          input.scope === "personal"
            ? await authorizeRemotePersonal(request)
            : await authorizeTeam(
                request,
                input.upstream_backend_id,
                input.team_id
              );
        await loadExact(params.subscriptionId, binding);
        const result = await requirePool(
          options.pool
        ).query<LocalSubscriptionRow>(
          `update local_edge_collaboration_subscriptions
           set state = 'expired', version = version + 1, updated_at = now()
           where id = $1
             and upstream_backend_id = $2
             and credential_binding_hash = $3
             and scope = $4::collaboration_scope
             and team_id is not distinct from $5::uuid
             and protocol_version = $6
             and version = $7
           returning ${selectColumns}`,
          [
            params.subscriptionId,
            binding.upstreamBackendId,
            binding.credentialBindingHash,
            binding.scope,
            binding.teamId,
            protocolVersion,
            input.expected_version
          ]
        );
        const row =
          result.rows[0] ??
          fail("Local collaboration subscription changed", 409);
        const connection = connections.get(params.subscriptionId);
        if (connection) stopConnection(connection);
        for (const [deliveryId, pending] of pendingSnapshots) {
          if (pending.localSubscriptionId === params.subscriptionId) {
            pendingSnapshots.delete(deliveryId);
          }
        }
        for (const [deliveryId, pending] of pendingEvents) {
          if (pending.localSubscriptionId === params.subscriptionId) {
            removePendingEvent(deliveryId);
          }
        }
        pendingEventOrder.delete(params.subscriptionId);
        return { protocolVersion, subscription: publicSubscription(row) };
      }
    );
  };

  const close = (): Promise<void> => {
    closing = true;
    for (const connection of connections.values()) stopConnection(connection);
    for (const connection of personalConnections.values()) {
      stopPersonalConnection(connection);
    }
    connections.clear();
    personalConnections.clear();
    pendingSnapshots.clear();
    pendingPersonalSnapshots.clear();
    for (const deadline of pendingEventDeadlines.values()) {
      clearTimeout(deadline);
    }
    pendingEventDeadlines.clear();
    pendingEvents.clear();
    pendingEventOrder.clear();
    pendingEventBytes = 0;
    return Promise.resolve();
  };

  return { registerRoutes, close };
};
