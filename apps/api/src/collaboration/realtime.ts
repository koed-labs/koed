import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import type {
  ActorContext,
  CapturedSessionSummaryRecord,
  CollaborationMessageRecord,
  CollaborationOutboxEventRecord,
  CollaborationReadStateRecord,
  CollaborationRealtimeMaterializationRepository,
  CollaborationRepository,
  CollaborationScope,
  CollaborationThreadRecord,
  DeviceCredentialAuthContext,
  ManagedConversationRepository,
  SharedMemoryReadResult,
  SharedMemoryRepository
} from "@koed/db";
import {
  calculateCollaborationReconnectDelay,
  COLLABORATION_RECONNECT_BACKOFF_CAP_MS,
  COLLABORATION_RENDERER_ACK_DEADLINE_MS,
  COLLABORATION_RENDERER_MAX_PENDING_BYTES,
  COLLABORATION_RENDERER_MAX_PENDING_EVENTS,
  collaborationRendererEventSchema,
  collaborationThreadSchema,
  COLLABORATION_NAME_MAX_CODE_POINTS,
  personalMemoryEntrySchema,
  sharedMemorySessionSchema,
  type CollaborationRendererEvent,
  type PersonalMemoryEntry
} from "@koed/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthHelpers } from "../auth/session.js";
import { collaborationRealtimeProtocolVersion } from "../server/capabilities.js";
import {
  collaborationRealtimeAckSchema,
  collaborationRealtimeSnapshotSchema,
  collaborationRealtimeStreamQuerySchema
} from "./schemas.js";

const protocolVersion = collaborationRealtimeProtocolVersion;
const cursorPrefix = "crt1.";
const listenChannel = "koed_collaboration_realtime";
const defaultSubscriptionTtlMs = 24 * 60 * 60 * 1000;
const defaultHeartbeatMs = 15_000;
const defaultAckDeadlineMs = COLLABORATION_RENDERER_ACK_DEADLINE_MS;
const defaultReplayBatchSize = 100;
const defaultMaxClients = 1_000;
const defaultMaxClientsPerPrincipal = 6;
const defaultMaxUnacknowledgedEvents =
  COLLABORATION_RENDERER_MAX_PENDING_EVENTS;
const defaultMaxUnacknowledgedBytes = COLLABORATION_RENDERER_MAX_PENDING_BYTES;
const defaultListenerReconnectBaseMs = 250;
const defaultListenerReconnectJitter = 0.2;
const defaultListenerStableResetMs = 30_000;
// Leave processing headroom inside the five-second revocation guarantee.
const maxAuthorizationRecheckMs = 4_000;

type ListenClient = {
  query(sql: string): Promise<unknown>;
  on(
    event: "notification",
    callback: (message: { channel: string; payload?: string }) => void
  ): void;
  on(event: "error", callback: (error: unknown) => void): void;
  removeAllListeners?(event: "notification" | "error"): void;
  release(): void;
};

type ListenPool = { connect(): Promise<ListenClient> };

type RealtimeAuth = {
  user: { id: string; email: string; displayName: string | null };
  deviceCredentialId: string | null;
  operationFamilies: ReadonlySet<string> | null;
};

type RealtimeScopeInput =
  | { scope: "personal" }
  | { scope: "team"; teamId: string };

type RealtimeSubscriptionBinding = {
  backendIdentityHash: string;
  principalIdHash: string;
  deviceCredentialId: string | null;
  clientInstanceHash: string;
  subscriptionKeyHash: string;
  protocolVersion: number;
};

type CursorPayload = {
  kind: "koed_collaboration_realtime_cursor";
  version: 1;
  protocolVersion: 1;
  backendIdentityHash: string;
  principalIdHash: string;
  clientInstanceHash: string;
  subscriptionKeyHash: string;
  subscriptionId: string;
  scope: CollaborationScope;
  teamId: string | null;
  eventId: string | null;
  cursor: number;
};

type RealtimeNotification = {
  scope?: unknown;
  personalOwnerUserId?: unknown;
  teamId?: unknown;
  principalIdHash?: unknown;
  control?: unknown;
};

type StreamClient = {
  id: string;
  actor: ActorContext;
  user: RealtimeAuth["user"];
  principalIdHash: string;
  binding: RealtimeSubscriptionBinding;
  scope: RealtimeScopeInput;
  subscriptionId: string;
  cursor: number;
  reply: FastifyReply;
  flushing: boolean;
  pending: boolean;
  closed: boolean;
  unacknowledged: Array<{ cursor: number; bytes: number; sentAt: number }>;
  unacknowledgedBytes: number;
  operationFamilies: ReadonlySet<string> | null;
  reauthenticate: () => Promise<RealtimeAuth>;
  authorizationPromise: Promise<boolean> | null;
  authorizationTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
};

export type CollaborationRealtimeCloseReason =
  | "access_revoked"
  | "requires_snapshot"
  | "backpressure"
  | "stream_replaced"
  | "server_shutdown";

export interface CollaborationRealtimeServiceOptions {
  app: FastifyInstance;
  auth: Pick<
    AuthHelpers,
    "authenticateSessionOrDeviceCredential" | "resolveDeviceCredentialContext"
  >;
  repository: CollaborationRepository | null;
  materializationRepository:
    | (CollaborationRealtimeMaterializationRepository &
        Pick<
          ManagedConversationRepository,
          | "getManagedConversationExecution"
          | "getManagedConversationRuntimeBinding"
        >)
    | null;
  sharedMemoryRepository: Pick<
    SharedMemoryRepository,
    "readGrantRepresentation"
  > | null;
  pool: ListenPool | null;
  corsOrigins: Set<string>;
  backendIdentity: string;
  cursorSecret: string;
  maxClients?: number;
  maxClientsPerPrincipal?: number;
  maxUnacknowledgedEvents?: number;
  maxUnacknowledgedBytes?: number;
  ackDeadlineMs?: number;
  heartbeatMs?: number;
  authorizationRecheckMs?: number;
  replayBatchSize?: number;
  subscriptionTtlMs?: number;
  listenerReconnectBaseMs?: number;
  listenerReconnectMaxMs?: number;
  listenerReconnectJitter?: number;
  listenerStableResetMs?: number;
  random?: () => number;
}

const hashValue = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const bindingHash = (domain: string, value: string): string =>
  hashValue(`koed:collaboration:${domain}:v1\n${value}`);

export const collaborationRealtimePrincipalHash = (principalId: string) =>
  bindingHash("subscription-principal", principalId);

const normalizeOrigin = (value: string): string => value.replace(/\/+$/, "");

const requiredOperationFamiliesForEvent = (
  family: CollaborationOutboxEventRecord["family"]
): readonly string[] => {
  switch (family) {
    case "team_lifecycle":
    case "team_membership_access":
      return ["admin"];
    case "workspace_lifecycle_access":
      return ["team_workspace_read"];
    case "thread_lifecycle":
    case "message_created":
    case "read_state_updated":
      return ["team_chat_read"];
    case "share_grant_lifecycle":
      return ["share_grant_management"];
    case "representation_changed":
    case "memory_event_available":
    case "lcm_leaf_available":
    case "lcm_rollup_available":
      return ["team_workspace_read"];
    case "shared_session_discussion_activity":
      return ["team_workspace_read", "team_chat_read"];
    case "personal_memory_changed":
    case "managed_conversation_changed":
    case "access_revoked":
      return [];
  }
};

const canReceiveEvent = (
  operationFamilies: ReadonlySet<string> | null,
  family: CollaborationOutboxEventRecord["family"]
): boolean =>
  operationFamilies === null ||
  requiredOperationFamiliesForEvent(family).every((operationFamily) =>
    operationFamilies.has(operationFamily)
  );

const encryptionKey = (secret: string): Buffer =>
  createHash("sha256")
    .update("koed:collaboration:realtime-cursor:v1\n", "utf8")
    .update(secret, "utf8")
    .digest();

const encryptCursorPayload = (
  secret: string,
  payload: CursorPayload
): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(cursorPrefix, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  return `${cursorPrefix}${Buffer.concat([
    iv,
    cipher.getAuthTag(),
    ciphertext
  ]).toString("base64url")}`;
};

export const decryptCollaborationRealtimeCursor = (
  secret: string,
  token: string
): CursorPayload => {
  if (!token.startsWith(cursorPrefix)) {
    throw Object.assign(new Error("Realtime cursor is invalid"), {
      statusCode: 400
    });
  }
  try {
    const body = Buffer.from(token.slice(cursorPrefix.length), "base64url");
    if (body.length <= 28) throw new Error("cursor body is empty");
    const iv = body.subarray(0, 12);
    const tag = body.subarray(12, 28);
    const ciphertext = body.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), iv);
    decipher.setAAD(Buffer.from(cursorPrefix, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as CursorPayload;
    if (
      parsed.kind !== "koed_collaboration_realtime_cursor" ||
      parsed.version !== 1 ||
      parsed.protocolVersion !== protocolVersion ||
      !Number.isSafeInteger(parsed.cursor) ||
      parsed.cursor < 0 ||
      (parsed.scope !== "personal" && parsed.scope !== "team") ||
      (parsed.scope === "personal" && parsed.teamId !== null) ||
      (parsed.scope === "team" && typeof parsed.teamId !== "string")
    ) {
      throw new Error("cursor payload is invalid");
    }
    return parsed;
  } catch {
    throw Object.assign(new Error("Realtime cursor is invalid"), {
      statusCode: 400
    });
  }
};

const bindingFor = (input: {
  backendIdentityHash: string;
  userId: string;
  deviceCredentialId: string | null;
  clientInstanceId: string;
  subscriptionKey: string;
}): RealtimeSubscriptionBinding => ({
  backendIdentityHash: input.backendIdentityHash,
  principalIdHash: collaborationRealtimePrincipalHash(input.userId),
  deviceCredentialId: input.deviceCredentialId,
  clientInstanceHash: bindingHash("client-instance", input.clientInstanceId),
  subscriptionKeyHash: bindingHash("subscription-key", input.subscriptionKey),
  protocolVersion
});

const assertCursorMatches = (
  payload: CursorPayload,
  binding: RealtimeSubscriptionBinding,
  scope: RealtimeScopeInput
) => {
  const matches =
    payload.backendIdentityHash === binding.backendIdentityHash &&
    payload.principalIdHash === binding.principalIdHash &&
    payload.clientInstanceHash === binding.clientInstanceHash &&
    payload.subscriptionKeyHash === binding.subscriptionKeyHash &&
    payload.protocolVersion === binding.protocolVersion &&
    payload.scope === scope.scope &&
    (scope.scope === "personal"
      ? payload.teamId === null
      : payload.teamId === scope.teamId);
  if (!matches) {
    throw Object.assign(new Error("Realtime cursor cannot be used here"), {
      statusCode: 403
    });
  }
};

const writeSerializedEvent = (
  reply: FastifyReply,
  event: string,
  serializedPayload: string,
  id?: string
) => {
  if (id) reply.raw.write(`id: ${id}\n`);
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${serializedPayload}\n\n`);
};

const writeEvent = (
  reply: FastifyReply,
  event: string,
  payload: unknown,
  id?: string
) => writeSerializedEvent(reply, event, JSON.stringify(payload), id);

type RendererUpdate = Extract<
  CollaborationRendererEvent,
  { type: "update" }
>["update"];

export type EventMaterialization =
  | { action: "deliver"; update: RendererUpdate }
  | { action: "skip" }
  | { action: "requires_snapshot" };

const boundedCollaborationLabel = (value: string, fallback: string): string => {
  const normalized = value.trim().normalize("NFC") || fallback;
  return [...normalized].slice(0, COLLABORATION_NAME_MAX_CODE_POINTS).join("");
};

export const personalMemoryEntryFromSummary = (
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

export const materializePersonalMemoryChangedEvent = async (
  actor: ActorContext,
  event: CollaborationOutboxEventRecord,
  repository: CollaborationRealtimeMaterializationRepository | null
): Promise<EventMaterialization> => {
  if (
    !repository ||
    event.family !== "personal_memory_changed" ||
    event.scope !== "personal" ||
    event.personalOwnerUserId !== actor.userId ||
    event.actorPrincipalId !== actor.userId ||
    event.teamId !== null ||
    event.teamWorkspaceId !== null ||
    event.threadId !== null ||
    event.messageId !== null ||
    event.shareGrantId !== null ||
    !event.logicalMemoryId ||
    event.resourceType !== "personal_memory_entry"
  ) {
    return { action: "requires_snapshot" };
  }
  try {
    const summary = await repository.getPersonalMemoryForRealtime(actor, {
      sessionId: event.resourceId
    });
    if (
      !summary ||
      summary.sessionId !== event.resourceId ||
      summary.logicalMemoryId !== event.logicalMemoryId
    ) {
      return { action: "requires_snapshot" };
    }
    const entry = personalMemoryEntrySchema.safeParse(
      personalMemoryEntryFromSummary(summary)
    );
    return entry.success
      ? {
          action: "deliver",
          update: { type: "personal_memory_upserted", entry: entry.data }
        }
      : { action: "requires_snapshot" };
  } catch {
    return { action: "requires_snapshot" };
  }
};

export type PersonalRealtimeMaterializationRepository =
  CollaborationRealtimeMaterializationRepository &
    Pick<
      ManagedConversationRepository,
      "getManagedConversationExecution" | "getManagedConversationRuntimeBinding"
    >;

export const materializeManagedConversationChangedEvent = async (
  actor: ActorContext,
  event: CollaborationOutboxEventRecord,
  repository: PersonalRealtimeMaterializationRepository | null
): Promise<EventMaterialization> => {
  if (
    !repository ||
    event.family !== "managed_conversation_changed" ||
    event.scope !== "personal" ||
    event.personalOwnerUserId !== actor.userId ||
    event.actorPrincipalId !== actor.userId ||
    event.teamId !== null ||
    event.teamWorkspaceId !== null ||
    event.threadId !== null ||
    event.messageId !== null ||
    event.shareGrantId !== null ||
    event.logicalMemoryId !== null ||
    event.resourceType !== "managed_conversation_execution"
  ) {
    return { action: "requires_snapshot" };
  }
  const execution = await repository.getManagedConversationExecution(
    actor,
    event.resourceId
  );
  if (!execution) return { action: "requires_snapshot" };
  const runtimeBinding = await repository.getManagedConversationRuntimeBinding(
    actor,
    execution.id
  );
  return {
    action: "deliver",
    update: {
      type: "managed_conversation_upserted",
      execution: {
        id: execution.id,
        projectId: execution.projectId,
        provider: execution.provider,
        state: execution.state,
        stateVersion: execution.stateVersion,
        executionGeneration: execution.executionGeneration,
        logicalSessionId: execution.logicalSessionId,
        sessionId: runtimeBinding?.localSessionId ?? null,
        providerThreadId: execution.providerThreadId,
        providerCliVersion: execution.providerCliVersion,
        lastErrorCode: execution.lastErrorCode,
        createdAt: execution.createdAt,
        updatedAt: execution.updatedAt,
        startedAt: execution.startedAt,
        quiescedAt: execution.quiescedAt,
        stoppedAt: execution.stoppedAt
      }
    }
  };
};

export const materializePersonalRealtimeEvent = (
  actor: ActorContext,
  event: CollaborationOutboxEventRecord,
  repository: PersonalRealtimeMaterializationRepository | null
): Promise<EventMaterialization> => {
  switch (event.family) {
    case "personal_memory_changed":
      return materializePersonalMemoryChangedEvent(actor, event, repository);
    case "managed_conversation_changed":
      return materializeManagedConversationChangedEvent(
        actor,
        event,
        repository
      );
    default:
      return Promise.resolve({ action: "requires_snapshot" });
  }
};

const displayName = (
  value: string | null | undefined,
  fallback: string
): string => value?.trim().normalize("NFC") || fallback;

const rendererThreadFromRecord = (
  thread: CollaborationThreadRecord,
  user: RealtimeAuth["user"]
): RendererUpdate | null => {
  const base = {
    id: thread.id,
    logicalId: thread.logicalId,
    scope: thread.scope,
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
  let candidate: unknown;
  if (
    thread.scope === "personal" &&
    thread.personalOwnerUserId === user.id &&
    thread.teamId === null
  ) {
    candidate =
      thread.kind === "notes_to_self"
        ? {
            ...base,
            kind: "notes_to_self",
            ownerUserId: user.id,
            name: null,
            topic: null,
            participants: [
              {
                id: user.id,
                displayName: displayName(
                  user.displayName,
                  user.email.split("@", 1)[0] || "Koed User"
                ),
                membershipState: "enabled"
              }
            ]
          }
        : thread.kind === "personal_channel" && thread.name
          ? {
              ...base,
              kind: "personal_channel",
              ownerUserId: user.id,
              name: thread.name
            }
          : null;
  } else if (thread.scope === "team" && thread.teamId) {
    const teamBase = { ...base, teamId: thread.teamId };
    if (
      thread.kind === "workspace_channel" &&
      thread.teamWorkspaceId &&
      thread.name
    ) {
      candidate = {
        ...teamBase,
        kind: thread.kind,
        workspaceId: thread.teamWorkspaceId,
        name: thread.name
      };
    } else if (
      thread.kind === "shared_session_discussion" &&
      thread.teamWorkspaceId &&
      thread.sharedLogicalMemoryId &&
      thread.shareGrantId
    ) {
      candidate = {
        ...teamBase,
        kind: thread.kind,
        workspaceId: thread.teamWorkspaceId,
        sharedLogicalMemoryId: thread.sharedLogicalMemoryId,
        shareGrantId: thread.shareGrantId
      };
    } else if (thread.kind === "dm" || thread.kind === "group_dm") {
      candidate = {
        ...teamBase,
        kind: thread.kind,
        participants: thread.participants.map((participant) => ({
          id: participant.userId,
          displayName: displayName(participant.displayName, "Team member"),
          membershipState: "enabled"
        }))
      };
    }
  }
  const parsed = collaborationThreadSchema.safeParse(candidate);
  return parsed.success
    ? { type: "thread_upserted", thread: parsed.data }
    : null;
};

const rendererMessageFromRecord = (
  message: CollaborationMessageRecord,
  user: RealtimeAuth["user"]
): RendererUpdate | null => {
  if (
    message.senderKind !== "user" ||
    !message.senderUserId ||
    (message.scope === "personal" && message.personalOwnerUserId !== user.id)
  ) {
    return null;
  }
  return {
    type: "message_created",
    message: {
      id: message.id,
      threadId: message.threadId,
      scope: message.scope,
      teamId: message.teamId,
      sequence: message.threadSequence,
      sender: {
        id: message.senderUserId,
        displayName: displayName(
          message.senderDisplayName,
          message.senderUserId === user.id
            ? displayName(user.displayName, "Team member")
            : "Team member"
        ),
        membershipState: "enabled"
      },
      senderKind: "user",
      body: message.bodyText,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      editedAt: null,
      deletedAt: null,
      delivery: "sent",
      failure: null
    }
  };
};

const rendererReadStateFromRecord = (
  readState: CollaborationReadStateRecord
): RendererUpdate => ({
  type: "read_state_updated",
  readState: {
    threadId: readState.threadId,
    messageId: readState.lastReadMessageId,
    sequence: readState.lastReadSequence,
    updatedAt: readState.updatedAt
  }
});

const rendererSharedSessionFrom = async (
  client: StreamClient,
  event: CollaborationOutboxEventRecord,
  result: SharedMemoryReadResult,
  repository: CollaborationRepository
): Promise<RendererUpdate | null> => {
  const { grant, representation } = result;
  if (
    event.scope !== "team" ||
    !event.teamId ||
    !event.teamWorkspaceId ||
    !event.shareGrantId ||
    !event.logicalMemoryId ||
    grant.id !== event.shareGrantId ||
    grant.logicalMemoryId !== event.logicalMemoryId ||
    grant.teamId !== event.teamId ||
    grant.teamWorkspaceId !== event.teamWorkspaceId ||
    result.companionScope.shareGrantId !== grant.id ||
    result.companionScope.logicalMemoryId !== grant.logicalMemoryId ||
    result.companionScope.teamId !== grant.teamId ||
    result.companionScope.teamWorkspaceId !== grant.teamWorkspaceId
  ) {
    return null;
  }
  const companion = (
    await repository.listThreads(client.actor, {
      scope: "team",
      teamId: grant.teamId,
      teamWorkspaceId: grant.teamWorkspaceId,
      kinds: ["shared_session_discussion"],
      includeArchived: true,
      limit: 100
    })
  )?.find(
    (thread) =>
      thread.sharedLogicalMemoryId === grant.logicalMemoryId &&
      thread.shareGrantId === grant.id
  );
  if (
    !companion ||
    companion.kind !== "shared_session_discussion" ||
    companion.teamId !== grant.teamId ||
    companion.teamWorkspaceId !== grant.teamWorkspaceId ||
    companion.sharedLogicalMemoryId !== grant.logicalMemoryId ||
    companion.shareGrantId !== grant.id
  ) {
    return null;
  }
  const ownerId = grant.ownerUserId ?? grant.ownerPrincipalId;
  const owner = (
    await repository.listTeamParticipants(client.actor, grant.teamId)
  )?.find((participant) => participant.userId === ownerId);
  const parsed = sharedMemorySessionSchema.safeParse({
    id: grant.id,
    logicalMemoryId: grant.logicalMemoryId,
    shareGrantId: grant.id,
    teamId: grant.teamId,
    workspaceId: grant.teamWorkspaceId,
    owner: {
      id: ownerId,
      displayName: displayName(owner?.displayName, "Team member"),
      membershipState: "enabled"
    },
    title: "Shared Memory",
    latestActivityAt: representation.updatedAt,
    representation: representation.representation,
    representationState: representation.state === "stale" ? "stale" : "current",
    liveState: "live",
    sourceState: "ready",
    sourceRevision: `ssr1.${hashValue(
      `${grant.id}:${representation.sourceRevision}`
    )}`,
    companionThreadId: companion.id,
    unreadCompanionCount: companion.unreadCount,
    version: grant.grantVersion
  });
  return parsed.success
    ? { type: "shared_session_upserted", session: parsed.data }
    : null;
};

const validateRendererUpdate = (
  event: CollaborationOutboxEventRecord,
  subscriptionId: string,
  update: RendererUpdate,
  onInvalid?: (issues: Array<{ path: string; message: string }>) => void
): RendererUpdate | null => {
  const parsed = collaborationRendererEventSchema.safeParse({
    contractVersion: protocolVersion,
    type: "update",
    subscriptionId,
    deliveryId: hashValue(`realtime-validation:${event.id}`),
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
    update
  });
  if (parsed.success && parsed.data.type === "update") {
    return parsed.data.update;
  }
  if (!parsed.success) {
    onInvalid?.(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    );
  }
  return null;
};

const materializeEvent = async (
  client: StreamClient,
  event: CollaborationOutboxEventRecord,
  options: CollaborationRealtimeServiceOptions
): Promise<EventMaterialization> => {
  const materializationRepository = options.materializationRepository;
  const repository = options.repository;
  let update: RendererUpdate | null = null;
  switch (event.family) {
    case "personal_memory_changed":
    case "managed_conversation_changed":
      return materializePersonalRealtimeEvent(
        client.actor,
        event,
        materializationRepository
      );
    case "message_created": {
      if (
        !materializationRepository ||
        !event.threadId ||
        !event.messageId ||
        event.resourceType !== "collaboration_message" ||
        event.resourceId !== event.messageId
      ) {
        return { action: "requires_snapshot" };
      }
      const message = await materializationRepository.getMessageForRealtime(
        client.actor,
        { threadId: event.threadId, messageId: event.messageId }
      );
      if (
        !message ||
        message.id !== event.messageId ||
        message.threadId !== event.threadId ||
        message.scope !== event.scope ||
        message.teamId !== event.teamId
      ) {
        return { action: "requires_snapshot" };
      }
      update = rendererMessageFromRecord(message, client.user);
      break;
    }
    case "read_state_updated": {
      if (event.actorPrincipalId !== client.actor.userId) {
        return { action: "skip" };
      }
      if (
        !materializationRepository ||
        !event.threadId ||
        event.resourceType !== "collaboration_read_state"
      ) {
        return { action: "requires_snapshot" };
      }
      const readState = await materializationRepository.getReadStateForRealtime(
        client.actor,
        {
          threadId: event.threadId
        }
      );
      if (
        !readState ||
        readState.userId !== client.actor.userId ||
        readState.threadId !== event.threadId
      ) {
        return { action: "requires_snapshot" };
      }
      update = rendererReadStateFromRecord(readState);
      break;
    }
    case "thread_lifecycle":
    case "shared_session_discussion_activity": {
      if (!repository || !event.threadId) {
        return { action: "requires_snapshot" };
      }
      if (event.resourceType === "collaboration_message") {
        if (!materializationRepository || !event.messageId) {
          return { action: "requires_snapshot" };
        }
        const message = await materializationRepository.getMessageForRealtime(
          client.actor,
          { threadId: event.threadId, messageId: event.messageId }
        );
        update = message
          ? rendererMessageFromRecord(message, client.user)
          : null;
      } else if (event.resourceType === "collaboration_read_state") {
        if (event.actorPrincipalId !== client.actor.userId) {
          return { action: "skip" };
        }
        const readState =
          await materializationRepository?.getReadStateForRealtime(
            client.actor,
            { threadId: event.threadId }
          );
        update = readState ? rendererReadStateFromRecord(readState) : null;
      } else if (
        event.resourceType === "collaboration_thread" &&
        event.resourceId === event.threadId
      ) {
        const thread = await repository.getThread(client.actor, {
          threadId: event.threadId,
          includeArchived: true
        });
        if (
          thread?.kind === "shared_session_discussion" &&
          options.sharedMemoryRepository &&
          event.shareGrantId &&
          event.logicalMemoryId &&
          event.scope === "team"
        ) {
          const result =
            await options.sharedMemoryRepository.readGrantRepresentation(
              client.actor,
              { shareGrantId: event.shareGrantId }
            );
          update = result
            ? await rendererSharedSessionFrom(client, event, result, repository)
            : null;
        } else {
          update = thread
            ? rendererThreadFromRecord(thread, client.user)
            : { type: "thread_removed", threadId: event.threadId };
        }
      }
      break;
    }
    case "share_grant_lifecycle":
    case "representation_changed":
    case "memory_event_available":
    case "lcm_leaf_available":
    case "lcm_rollup_available": {
      if (
        !options.sharedMemoryRepository ||
        !repository ||
        !event.shareGrantId ||
        !event.logicalMemoryId ||
        event.scope !== "team"
      ) {
        return { action: "requires_snapshot" };
      }
      const result =
        await options.sharedMemoryRepository.readGrantRepresentation(
          client.actor,
          { shareGrantId: event.shareGrantId }
        );
      if (event.family === "share_grant_lifecycle") {
        if (!result) return { action: "skip" };
        update = await rendererSharedSessionFrom(
          client,
          event,
          result,
          repository
        );
      } else if (event.family === "representation_changed") {
        update = result
          ? await rendererSharedSessionFrom(client, event, result, repository)
          : {
              type: "shared_session_removed",
              sharedSessionId: event.shareGrantId
            };
      } else {
        update = result
          ? await rendererSharedSessionFrom(client, event, result, repository)
          : {
              type: "shared_session_removed",
              sharedSessionId: event.shareGrantId
            };
      }
      break;
    }
    case "team_lifecycle":
    case "team_membership_access":
    case "workspace_lifecycle_access":
      return { action: "requires_snapshot" };
    case "access_revoked":
      update = event.shareGrantId
        ? {
            type: "shared_session_removed",
            sharedSessionId: event.shareGrantId
          }
        : null;
      break;
  }
  const validated = update
    ? validateRendererUpdate(event, client.subscriptionId, update, (issues) => {
        options.app.log.warn(
          {
            event: {
              name: "collaboration_realtime.materialization_invalid",
              category: "stream"
            },
            collaborationEvent: {
              id: event.id,
              family: event.family,
              resourceType: event.resourceType,
              resourceId: event.resourceId
            },
            rendererUpdate: { type: update.type },
            validation: { issues }
          },
          "collaboration realtime materialization failed validation"
        );
      })
    : null;
  if (!update) {
    options.app.log.warn(
      {
        event: {
          name: "collaboration_realtime.materialization_unavailable",
          category: "stream"
        },
        collaborationEvent: {
          id: event.id,
          family: event.family,
          resourceType: event.resourceType,
          resourceId: event.resourceId
        }
      },
      "collaboration realtime event could not be materialized"
    );
  }
  return validated
    ? { action: "deliver", update: validated }
    : { action: "requires_snapshot" };
};

const eventEnvelope = (input: {
  event: CollaborationOutboxEventRecord;
  cursor: string;
  subscriptionId: string;
  update: RendererUpdate;
}) => ({
  protocolVersion,
  eventId: input.event.id,
  cursor: input.cursor,
  type: input.event.family,
  occurredAt: input.event.occurredAt,
  subscription: { id: input.subscriptionId },
  resource: {
    scope: input.event.scope,
    type: input.event.resourceType,
    id: input.event.resourceId,
    teamId: input.event.teamId,
    teamWorkspaceId: input.event.teamWorkspaceId,
    threadId: input.event.threadId,
    messageId: input.event.messageId,
    sharedSessionId: input.event.shareGrantId,
    shareGrantId: input.event.shareGrantId,
    logicalMemoryId: input.event.logicalMemoryId
  },
  actor: { principalId: input.event.actorPrincipalId },
  update: input.update
});

const authenticateRealtime = async (
  request: FastifyRequest,
  auth: CollaborationRealtimeServiceOptions["auth"],
  scope: RealtimeScopeInput
): Promise<RealtimeAuth> => {
  const operationFamily =
    scope.scope === "personal"
      ? "personal_collaboration_read"
      : "team_workspace_read";
  const user = await auth.authenticateSessionOrDeviceCredential(
    request,
    operationFamily,
    { apiTokenError: "API Tokens cannot authorize collaboration realtime" }
  );
  const scheme =
    request.headers.authorization?.trim().split(/\s+/, 1)[0]?.toLowerCase() ??
    "";
  if (scheme !== "koed-device") {
    return { user, deviceCredentialId: null, operationFamilies: null };
  }
  const context: DeviceCredentialAuthContext | null =
    await auth.resolveDeviceCredentialContext(request);
  if (!context?.credential.operationFamilies.includes(operationFamily)) {
    throw Object.assign(
      new Error("Device credential is not allowed for collaboration realtime"),
      { statusCode: 403 }
    );
  }
  return {
    user: context.user,
    deviceCredentialId: context.credential.id,
    operationFamilies: new Set(context.credential.operationFamilies)
  };
};

const rejectBearerApiToken = (request: FastifyRequest): void => {
  if (/^Bearer(?:\s|$)/i.test(request.headers.authorization?.trim() ?? "")) {
    throw Object.assign(
      new Error("API Tokens cannot authorize collaboration realtime"),
      { statusCode: 403 }
    );
  }
};

const createRealtimeReauthenticator = (
  request: FastifyRequest,
  auth: CollaborationRealtimeServiceOptions["auth"],
  scope: RealtimeScopeInput
): (() => Promise<RealtimeAuth>) => {
  const headers = { ...request.headers };
  const cookies = { ...request.cookies };
  return () => {
    const freshRequest = Object.create(request) as FastifyRequest;
    Object.defineProperties(freshRequest, {
      headers: { value: headers, enumerable: true },
      cookies: { value: cookies, enumerable: true }
    });
    return authenticateRealtime(freshRequest, auth, scope);
  };
};

const requireRepository = (
  repository: CollaborationRepository | null
): CollaborationRepository => {
  if (!repository) {
    throw Object.assign(new Error("Database is not configured"), {
      statusCode: 503
    });
  }
  return repository;
};

const makeCursor = (
  secret: string,
  input: {
    binding: RealtimeSubscriptionBinding;
    scope: RealtimeScopeInput;
    subscriptionId: string;
    eventId: string | null;
    cursor: number;
  }
): string =>
  encryptCursorPayload(secret, {
    kind: "koed_collaboration_realtime_cursor",
    version: 1,
    protocolVersion,
    backendIdentityHash: input.binding.backendIdentityHash,
    principalIdHash: input.binding.principalIdHash,
    clientInstanceHash: input.binding.clientInstanceHash,
    subscriptionKeyHash: input.binding.subscriptionKeyHash,
    subscriptionId: input.subscriptionId,
    scope: input.scope.scope,
    teamId: input.scope.scope === "team" ? input.scope.teamId : null,
    eventId: input.eventId,
    cursor: input.cursor
  });

const closeClient = (
  client: StreamClient,
  reason: CollaborationRealtimeCloseReason
) => {
  if (client.closed) return;
  client.closed = true;
  if (client.authorizationTimer) clearInterval(client.authorizationTimer);
  if (client.heartbeatTimer) clearInterval(client.heartbeatTimer);
  client.authorizationTimer = null;
  client.heartbeatTimer = null;
  if (reason === "access_revoked") {
    writeEvent(client.reply, "access_revoked", {
      protocolVersion,
      subscription: { id: client.subscriptionId },
      reason
    });
  } else {
    writeEvent(client.reply, "control", {
      protocolVersion,
      subscription: { id: client.subscriptionId },
      reason
    });
  }
  client.reply.raw.end();
};

export const createCollaborationRealtimeService = async (
  options: CollaborationRealtimeServiceOptions
) => {
  const clients = new Set<StreamClient>();
  const clientsBySubscription = new Map<string, StreamClient>();
  const backendIdentityHash = bindingHash(
    "backend-identity",
    options.backendIdentity
  );
  const maxClients = options.maxClients ?? defaultMaxClients;
  const maxClientsPerPrincipal =
    options.maxClientsPerPrincipal ?? defaultMaxClientsPerPrincipal;
  const maxUnacknowledgedEvents = Math.min(
    Math.max(
      Math.trunc(
        options.maxUnacknowledgedEvents ?? defaultMaxUnacknowledgedEvents
      ),
      1
    ),
    defaultMaxUnacknowledgedEvents
  );
  const maxUnacknowledgedBytes = Math.min(
    Math.max(
      Math.trunc(
        options.maxUnacknowledgedBytes ?? defaultMaxUnacknowledgedBytes
      ),
      1
    ),
    defaultMaxUnacknowledgedBytes
  );
  const ackDeadlineMs = Math.min(
    Math.max(Math.trunc(options.ackDeadlineMs ?? defaultAckDeadlineMs), 1),
    defaultAckDeadlineMs
  );
  const heartbeatMs = options.heartbeatMs ?? defaultHeartbeatMs;
  const authorizationRecheckMs = Math.min(
    Math.max(options.authorizationRecheckMs ?? maxAuthorizationRecheckMs, 1),
    maxAuthorizationRecheckMs
  );
  const replayBatchSize = Math.min(
    Math.max(Math.trunc(options.replayBatchSize ?? defaultReplayBatchSize), 1),
    defaultReplayBatchSize
  );
  const subscriptionTtlMs =
    options.subscriptionTtlMs ?? defaultSubscriptionTtlMs;
  const listenerReconnectBaseMs = Math.min(
    Math.max(
      1,
      Math.trunc(
        options.listenerReconnectBaseMs ?? defaultListenerReconnectBaseMs
      )
    ),
    COLLABORATION_RECONNECT_BACKOFF_CAP_MS
  );
  const listenerReconnectMaxMs = Math.min(
    Math.max(
      listenerReconnectBaseMs,
      Math.trunc(
        options.listenerReconnectMaxMs ?? COLLABORATION_RECONNECT_BACKOFF_CAP_MS
      )
    ),
    COLLABORATION_RECONNECT_BACKOFF_CAP_MS
  );
  const listenerReconnectJitter =
    options.listenerReconnectJitter ?? defaultListenerReconnectJitter;
  const listenerStableResetMs = Math.max(
    1,
    options.listenerStableResetMs ?? defaultListenerStableResetMs
  );
  const random = options.random ?? Math.random;
  let listenClient: ListenClient | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let listenerStableTimer: ReturnType<typeof setTimeout> | null = null;
  let listenerReconnectAttempt = 0;
  let closing = false;

  const closeAndForget = (
    client: StreamClient,
    reason: CollaborationRealtimeCloseReason
  ) => {
    closeClient(client, reason);
    clients.delete(client);
    if (clientsBySubscription.get(client.subscriptionId) === client) {
      clientsBySubscription.delete(client.subscriptionId);
    }
  };

  const backpressureExceeded = (
    client: StreamClient,
    additionalEvents = 0,
    additionalBytes = 0
  ): boolean => {
    const oldest = client.unacknowledged[0];
    return (
      client.unacknowledged.length + additionalEvents >
        maxUnacknowledgedEvents ||
      client.unacknowledgedBytes + additionalBytes > maxUnacknowledgedBytes ||
      (oldest ? Date.now() - oldest.sentAt > ackDeadlineMs : false)
    );
  };

  const reauthorize = (client: StreamClient): Promise<boolean> => {
    if (client.closed) return Promise.resolve(false);
    if (client.authorizationPromise) return client.authorizationPromise;
    const authorization = (async () => {
      try {
        const currentAuth = await client.reauthenticate();
        if (client.closed) return false;
        if (
          currentAuth.user.id !== client.actor.userId ||
          currentAuth.deviceCredentialId !== client.binding.deviceCredentialId
        ) {
          closeAndForget(client, "access_revoked");
          return false;
        }
        client.operationFamilies = currentAuth.operationFamilies;
        const recovered = await requireRepository(
          options.repository
        ).recoverSubscription(client.actor, {
          ...client.binding,
          ...client.scope,
          subscriptionId: client.subscriptionId,
          afterCursor: client.cursor,
          expiresAt: new Date(Date.now() + subscriptionTtlMs)
        });
        if (client.closed) return false;
        if (!recovered) {
          closeAndForget(client, "access_revoked");
          return false;
        }
        if (recovered.requiresSnapshot) {
          closeAndForget(client, "requires_snapshot");
          return false;
        }
        return true;
      } catch {
        closeAndForget(client, "access_revoked");
        return false;
      }
    })();
    client.authorizationPromise = authorization;
    void authorization.finally(() => {
      if (client.authorizationPromise === authorization) {
        client.authorizationPromise = null;
      }
    });
    return authorization;
  };

  const flush = async (client: StreamClient) => {
    if (client.flushing || client.closed) {
      client.pending = true;
      return;
    }
    client.flushing = true;
    try {
      do {
        client.pending = false;
        if (backpressureExceeded(client)) {
          closeAndForget(client, "backpressure");
          return;
        }
        if (!(await reauthorize(client))) return;
        const replay = await requireRepository(options.repository).replayEvents(
          client.actor,
          {
            ...client.scope,
            afterCursor: client.cursor,
            limit: replayBatchSize
          }
        );
        if (client.closed) return;
        if (!replay) {
          closeAndForget(client, "access_revoked");
          return;
        }
        for (const event of replay.events) {
          client.cursor = event.cursor;
          if (event.family === "access_revoked" && !event.shareGrantId) {
            closeAndForget(client, "access_revoked");
            return;
          }
          if (!canReceiveEvent(client.operationFamilies, event.family)) {
            continue;
          }
          const materialized = await materializeEvent(client, event, options);
          if (materialized.action === "skip") continue;
          if (materialized.action === "requires_snapshot") {
            closeAndForget(client, "requires_snapshot");
            return;
          }
          const stillAuthorized =
            await options.materializationRepository?.isEventAuthorized(
              client.actor,
              {
                eventId: event.id,
                cursor: event.cursor,
                scope: event.scope,
                teamId: event.teamId
              }
            );
          if (stillAuthorized !== true) {
            closeAndForget(client, "requires_snapshot");
            return;
          }
          const cursor = makeCursor(options.cursorSecret, {
            binding: client.binding,
            scope: client.scope,
            subscriptionId: client.subscriptionId,
            eventId: event.id,
            cursor: event.cursor
          });
          const envelope = eventEnvelope({
            event,
            cursor,
            subscriptionId: client.subscriptionId,
            update: materialized.update
          });
          const serializedEnvelope = JSON.stringify(envelope);
          const bytes = Buffer.byteLength(serializedEnvelope, "utf8");
          if (backpressureExceeded(client, 1, bytes)) {
            closeAndForget(client, "backpressure");
            return;
          }
          client.unacknowledged.push({
            cursor: event.cursor,
            bytes,
            sentAt: Date.now()
          });
          client.unacknowledgedBytes += bytes;
          writeSerializedEvent(
            client.reply,
            "collaboration_event",
            serializedEnvelope,
            cursor
          );
        }
        if (replay.hasMore) client.pending = true;
      } while (client.pending && clients.has(client));
    } catch (error) {
      options.app.log.warn(
        {
          event: {
            name: "collaboration_realtime.flush_failed",
            category: "stream"
          },
          component: "collaboration_realtime",
          subscription: { id: client.subscriptionId },
          err: error
        },
        "could not flush collaboration realtime events"
      );
      closeAndForget(client, "requires_snapshot");
    } finally {
      client.flushing = false;
    }
  };

  const wake = (notification: RealtimeNotification) => {
    for (const client of clients) {
      const samePrincipal =
        typeof notification.principalIdHash !== "string" ||
        notification.principalIdHash === client.principalIdHash;
      const sameScope =
        notification.scope === "personal"
          ? client.scope.scope === "personal" &&
            notification.personalOwnerUserId === client.actor.userId
          : notification.scope === "team"
            ? client.scope.scope === "team" &&
              notification.teamId === client.scope.teamId
            : true;
      if (!samePrincipal || !sameScope) continue;
      if (notification.control === "access_revoked") {
        closeAndForget(client, "access_revoked");
      } else if (notification.control === "requires_snapshot") {
        closeAndForget(client, "requires_snapshot");
      } else {
        void flush(client);
      }
    }
  };

  const releaseListener = (client: ListenClient) => {
    if (listenerStableTimer) clearTimeout(listenerStableTimer);
    listenerStableTimer = null;
    client.removeAllListeners?.("notification");
    client.removeAllListeners?.("error");
    client.release();
    if (listenClient === client) listenClient = null;
  };

  const scheduleReconnect = () => {
    if (closing || !options.pool || reconnectTimer) return;
    const delay = calculateCollaborationReconnectDelay({
      attempt: listenerReconnectAttempt,
      baseMs: listenerReconnectBaseMs,
      maxMs: listenerReconnectMaxMs,
      jitter: listenerReconnectJitter,
      random: random()
    });
    listenerReconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void startListener();
    }, delay);
    reconnectTimer.unref?.();
  };

  const startListener = async () => {
    if (closing || !options.pool) return;
    if (listenClient) releaseListener(listenClient);
    try {
      const connected = await options.pool.connect();
      try {
        await connected.query(`LISTEN ${listenChannel}`);
      } catch (error) {
        connected.release();
        throw error;
      }
      listenClient = connected;
      listenerStableTimer = setTimeout(() => {
        listenerStableTimer = null;
        listenerReconnectAttempt = 0;
      }, listenerStableResetMs);
      listenerStableTimer.unref?.();
      connected.on("notification", (message) => {
        if (message.channel !== listenChannel || !message.payload) return;
        listenerReconnectAttempt = 0;
        try {
          wake(JSON.parse(message.payload) as RealtimeNotification);
        } catch (error) {
          options.app.log.warn(
            {
              event: {
                name: "collaboration_realtime.notification_parse_failed",
                category: "stream"
              },
              component: "collaboration_realtime",
              notification: { payload_length: message.payload.length },
              err: error
            },
            "could not parse collaboration realtime notification"
          );
        }
      });
      connected.on("error", (error) => {
        options.app.log.warn(
          {
            event: {
              name: "collaboration_realtime.listener_failed",
              category: "stream"
            },
            component: "collaboration_realtime",
            err: error
          },
          "collaboration realtime listener failed"
        );
        if (listenClient === connected) {
          for (const client of clients) void reauthorize(client);
          releaseListener(connected);
          scheduleReconnect();
        }
      });
      for (const client of clients) void flush(client);
    } catch (error) {
      options.app.log.warn(
        {
          event: {
            name: "collaboration_realtime.listener_start_failed",
            category: "stream"
          },
          component: "collaboration_realtime",
          err: error
        },
        "could not start collaboration realtime listener"
      );
      scheduleReconnect();
    }
  };

  await startListener();

  const assertOrigin = (request: FastifyRequest) => {
    const origin = request.headers.origin;
    if (!origin) return {};
    const normalized = normalizeOrigin(origin);
    if (!options.corsOrigins.has(normalized)) {
      throw Object.assign(new Error("Realtime origin is not allowed"), {
        statusCode: 403
      });
    }
    return {
      "access-control-allow-origin": normalized,
      "access-control-allow-credentials": "true",
      vary: "Origin"
    };
  };

  const registerRoutes = () => {
    options.app.post("/v1/collaboration/realtime/snapshot", async (request) => {
      assertOrigin(request);
      rejectBearerApiToken(request);
      const input = collaborationRealtimeSnapshotSchema.parse(request.body);
      const realtimeAuth = await authenticateRealtime(
        request,
        options.auth,
        input
      );
      const binding = bindingFor({
        backendIdentityHash,
        userId: realtimeAuth.user.id,
        deviceCredentialId: realtimeAuth.deviceCredentialId,
        clientInstanceId: input.clientInstanceId,
        subscriptionKey: input.subscriptionKey
      });
      const repository = requireRepository(options.repository);
      const snapshot = await repository.getAuthorizedSnapshot(
        { userId: realtimeAuth.user.id },
        input
      );
      if (!snapshot) {
        throw Object.assign(
          new Error("Collaboration realtime snapshot cannot be viewed"),
          { statusCode: 403 }
        );
      }
      const subscription = await repository.createSubscription(
        { userId: realtimeAuth.user.id },
        {
          ...binding,
          ...input,
          snapshotHighWaterCursor: snapshot.highWaterCursor,
          expiresAt: new Date(Date.now() + subscriptionTtlMs)
        }
      );
      if (!subscription) {
        throw Object.assign(
          new Error("Collaboration realtime subscription cannot be created"),
          { statusCode: 403 }
        );
      }
      const cursor = makeCursor(options.cursorSecret, {
        binding,
        scope: input,
        subscriptionId: subscription.id,
        eventId: null,
        cursor: snapshot.highWaterCursor
      });
      return {
        protocolVersion,
        subscription,
        snapshot: {
          scope: snapshot.scope,
          personalOwnerUserId: snapshot.personalOwnerUserId,
          teamId: snapshot.teamId,
          highWaterCursor: cursor,
          threads: snapshot.threads
        },
        cursor
      };
    });

    options.app.post("/v1/collaboration/realtime/ack", async (request) => {
      assertOrigin(request);
      rejectBearerApiToken(request);
      const input = collaborationRealtimeAckSchema.parse(request.body);
      const cursor = decryptCollaborationRealtimeCursor(
        options.cursorSecret,
        input.cursor
      );
      const realtimeAuth = await authenticateRealtime(
        request,
        options.auth,
        cursor.scope === "personal"
          ? { scope: "personal" }
          : { scope: "team", teamId: cursor.teamId! }
      );
      const binding = bindingFor({
        backendIdentityHash,
        userId: realtimeAuth.user.id,
        deviceCredentialId: realtimeAuth.deviceCredentialId,
        clientInstanceId: input.clientInstanceId,
        subscriptionKey: input.subscriptionKey
      });
      if (cursor.subscriptionId !== input.subscriptionId) {
        throw Object.assign(new Error("Realtime cursor cannot be used here"), {
          statusCode: 403
        });
      }
      assertCursorMatches(
        cursor,
        binding,
        cursor.scope === "personal"
          ? { scope: "personal" }
          : { scope: "team", teamId: cursor.teamId! }
      );
      if (cursor.eventId !== input.eventId || cursor.cursor <= 0) {
        throw Object.assign(new Error("Realtime acknowledgement is invalid"), {
          statusCode: 400
        });
      }
      const subscription = await requireRepository(
        options.repository
      ).acknowledgeSubscription(
        { userId: realtimeAuth.user.id },
        {
          ...binding,
          subscriptionId: input.subscriptionId,
          eventId: input.eventId,
          cursor: cursor.cursor
        }
      );
      if (!subscription) {
        throw Object.assign(
          new Error("Collaboration realtime acknowledgement cannot be applied"),
          { statusCode: 403 }
        );
      }
      const client = clientsBySubscription.get(input.subscriptionId);
      if (client) {
        const retained = client.unacknowledged.filter(
          (event) => event.cursor > cursor.cursor
        );
        client.unacknowledgedBytes = retained.reduce(
          (total, event) => total + event.bytes,
          0
        );
        client.unacknowledged = retained;
      }
      return { subscription };
    });

    options.app.get(
      "/v1/collaboration/realtime/stream",
      async (request, reply) => {
        const corsHeaders = assertOrigin(request);
        rejectBearerApiToken(request);
        const query = collaborationRealtimeStreamQuerySchema.parse(
          request.query
        );
        const realtimeAuth = await authenticateRealtime(
          request,
          options.auth,
          query
        );
        const binding = bindingFor({
          backendIdentityHash,
          userId: realtimeAuth.user.id,
          deviceCredentialId: realtimeAuth.deviceCredentialId,
          clientInstanceId: query.clientInstanceId,
          subscriptionKey: query.subscriptionKey
        });
        const headerCursor = request.headers["last-event-id"];
        const token =
          (Array.isArray(headerCursor) ? headerCursor[0] : headerCursor) ??
          query.cursor;
        if (!token) {
          throw Object.assign(new Error("Realtime cursor is required"), {
            statusCode: 400
          });
        }
        const parsedCursor = decryptCollaborationRealtimeCursor(
          options.cursorSecret,
          token
        );
        assertCursorMatches(parsedCursor, binding, query);
        const existingClient = clientsBySubscription.get(
          parsedCursor.subscriptionId
        );
        const replacementCount = existingClient ? 1 : 0;
        if (clients.size - replacementCount >= maxClients) {
          throw Object.assign(new Error("Realtime stream limit reached"), {
            statusCode: 429
          });
        }
        const principalClientCount = [...clients].filter(
          (client) =>
            client !== existingClient &&
            client.principalIdHash === binding.principalIdHash
        ).length;
        if (principalClientCount >= maxClientsPerPrincipal) {
          throw Object.assign(new Error("Realtime stream limit reached"), {
            statusCode: 429
          });
        }
        const recovered = await requireRepository(
          options.repository
        ).recoverSubscription(
          { userId: realtimeAuth.user.id },
          {
            ...binding,
            ...query,
            subscriptionId: parsedCursor.subscriptionId,
            afterCursor: parsedCursor.cursor,
            expiresAt: new Date(Date.now() + subscriptionTtlMs)
          }
        );
        if (!recovered) {
          throw Object.assign(
            new Error("Collaboration realtime stream cannot be viewed"),
            { statusCode: 403 }
          );
        }

        reply.hijack();
        reply.raw.writeHead(200, {
          ...corsHeaders,
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        const client: StreamClient = {
          id: randomBytes(12).toString("base64url"),
          actor: { userId: realtimeAuth.user.id },
          user: realtimeAuth.user,
          principalIdHash: binding.principalIdHash,
          binding,
          scope: query,
          subscriptionId: parsedCursor.subscriptionId,
          cursor: parsedCursor.cursor,
          reply,
          flushing: false,
          pending: false,
          closed: false,
          unacknowledged: [],
          unacknowledgedBytes: 0,
          operationFamilies: realtimeAuth.operationFamilies,
          reauthenticate: createRealtimeReauthenticator(
            request,
            options.auth,
            query
          ),
          authorizationPromise: null,
          authorizationTimer: null,
          heartbeatTimer: null
        };
        const replacedClient = clientsBySubscription.get(client.subscriptionId);
        if (replacedClient) {
          closeAndForget(replacedClient, "stream_replaced");
        }
        clients.add(client);
        clientsBySubscription.set(client.subscriptionId, client);
        if (recovered.requiresSnapshot) {
          closeAndForget(client, "requires_snapshot");
          return;
        }
        writeEvent(reply, "ready", {
          protocolVersion,
          subscription: { id: client.subscriptionId },
          cursor: token
        });
        void flush(client);
        client.authorizationTimer = setInterval(() => {
          // LISTEN/NOTIFY is the low-latency wake-up path. Reconcile the durable
          // outbox during the bounded authorization sweep so a lost advisory
          // notification cannot strand an access change indefinitely.
          void flush(client);
        }, authorizationRecheckMs);
        client.authorizationTimer.unref?.();
        client.heartbeatTimer = setInterval(() => {
          if (client.closed) {
            return;
          }
          if (backpressureExceeded(client)) {
            closeAndForget(client, "backpressure");
            return;
          }
          writeEvent(reply, "heartbeat", {
            protocolVersion,
            subscription: { id: client.subscriptionId }
          });
        }, heartbeatMs);
        client.heartbeatTimer.unref?.();
        reply.raw.once("close", () => {
          if (client.authorizationTimer)
            clearInterval(client.authorizationTimer);
          if (client.heartbeatTimer) clearInterval(client.heartbeatTimer);
          client.authorizationTimer = null;
          client.heartbeatTimer = null;
          client.closed = true;
          clients.delete(client);
          if (clientsBySubscription.get(client.subscriptionId) === client) {
            clientsBySubscription.delete(client.subscriptionId);
          }
        });
      }
    );
  };

  const close = () => {
    closing = true;
    for (const client of clients) {
      closeClient(client, "server_shutdown");
    }
    clients.clear();
    clientsBySubscription.clear();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (listenerStableTimer) clearTimeout(listenerStableTimer);
    listenerStableTimer = null;
    if (listenClient) releaseListener(listenClient);
  };

  return {
    registerRoutes,
    close,
    activeClientCount: () => clients.size
  };
};
