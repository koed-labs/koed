import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import type {
  ActorContext,
  AuthorizedCollaborationSnapshotRecord,
  CollaborationOutboxEventRecord,
  CollaborationRealtimeMaterializationRepository,
  CollaborationRepository,
  CollaborationSubscriptionRecord,
  CollaborationThreadRecord,
  DeviceCredentialAuthContext
} from "@koed/db";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationRealtimeEventFamilySchema,
  sharedMemoryGrantScopedPrincipalId,
  sharedMemoryGrantScopedSourceId,
  type SharedMemoryRepresentation
} from "@koed/shared";
import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createCollaborationRealtimeService,
  materializePendingShareLifecycleEvent,
  materializePersonalMemoryChangedEvent,
  type CollaborationRealtimeServiceOptions
} from "./realtime.js";

const iso = "2026-07-17T00:00:00.000Z";
const cursorSecret = "test-collaboration-realtime-secret";
const backendIdentity = "test-backend";

const realtimeFamilyCases = [
  ["team_lifecycle", "control", null],
  ["team_membership_access", "control", null],
  ["team_presence_changed", "collaboration_event", "team_person_upserted"],
  ["workspace_lifecycle_access", "control", null],
  ["thread_lifecycle", "collaboration_event", "thread_upserted"],
  ["message_created", "collaboration_event", "message_created"],
  ["receipt_state_updated", "collaboration_event", "receipt_state_updated"],
  ["share_grant_lifecycle", "collaboration_event", "shared_session_upserted"],
  ["fidelity_changed", "collaboration_event", "shared_session_upserted"],
  ["source_revision_changed", "collaboration_event", "shared_session_upserted"],
  ["memory_event_available", "collaboration_event", "shared_session_upserted"],
  ["lcm_leaf_available", "collaboration_event", "shared_session_upserted"],
  ["lcm_rollup_available", "collaboration_event", "shared_session_upserted"],
  [
    "shared_session_discussion_activity",
    "collaboration_event",
    "message_created"
  ],
  ["personal_memory_changed", "control", null],
  ["pending_share_lifecycle", "control", null],
  ["managed_conversation_changed", "control", null],
  ["access_revoked", "access_revoked", null]
] as const satisfies ReadonlyArray<
  readonly [
    CollaborationOutboxEventRecord["family"],
    "control" | "collaboration_event" | "access_revoked",
    (
      | "thread_upserted"
      | "message_created"
      | "receipt_state_updated"
      | "team_person_upserted"
      | "shared_session_upserted"
      | null
    )
  ]
>;

type TestUser = { id: string; email: string; displayName: string | null };

type RealtimeSubscriptionBinding = {
  backendIdentityHash: string;
  principalIdHash: string;
  deviceCredentialId: string | null;
  clientInstanceHash: string;
  subscriptionKeyHash: string;
  protocolVersion: number;
};

type StoredSubscription = CollaborationSubscriptionRecord & {
  binding: RealtimeSubscriptionBinding;
};

const jsonBody = <T>(response: { body: string }): T =>
  JSON.parse(response.body) as T;

const event = (input: {
  cursor: number;
  scope: "personal" | "team";
  teamId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  teamWorkspaceId?: string | null;
  shareGrantId?: string | null;
  logicalMemoryId?: string | null;
  actorPrincipalId?: string | null;
  resourceType?: string;
  resourceId?: string;
  family?: CollaborationOutboxEventRecord["family"];
}): CollaborationOutboxEventRecord => {
  const threadId = input.threadId ?? randomUUID();
  const messageId =
    input.messageId === undefined ? randomUUID() : input.messageId;
  return {
    id: randomUUID(),
    cursor: input.cursor,
    protocolVersion: COLLABORATION_CONTRACT_VERSION,
    family: input.family ?? "message_created",
    scope: input.scope,
    personalOwnerUserId: input.scope === "personal" ? randomUUID() : null,
    teamId: input.scope === "team" ? input.teamId! : null,
    teamWorkspaceId:
      input.scope === "team" ? (input.teamWorkspaceId ?? randomUUID()) : null,
    threadId,
    messageId,
    shareGrantId: input.shareGrantId ?? null,
    logicalMemoryId: input.logicalMemoryId ?? null,
    resourceType: input.resourceType ?? "collaboration_message",
    resourceId: input.resourceId ?? messageId ?? threadId,
    actorPrincipalId: input.actorPrincipalId ?? randomUUID(),
    mutationId: randomUUID(),
    occurredAt: iso
  };
};

const bindingMatches = (
  actual: RealtimeSubscriptionBinding,
  expected: RealtimeSubscriptionBinding
) =>
  actual.backendIdentityHash === expected.backendIdentityHash &&
  actual.principalIdHash === expected.principalIdHash &&
  actual.deviceCredentialId === expected.deviceCredentialId &&
  actual.clientInstanceHash === expected.clientInstanceHash &&
  actual.subscriptionKeyHash === expected.subscriptionKeyHash &&
  actual.protocolVersion === expected.protocolVersion;

const createRepositoryFixture = () => {
  const ids = {
    alice: randomUUID(),
    bob: randomUUID(),
    teamA: randomUUID(),
    teamB: randomUUID(),
    workspace: randomUUID(),
    shareGrant: randomUUID(),
    logicalMemory: randomUUID(),
    companionThread: randomUUID()
  };
  const users = new Map<string, TestUser>([
    [
      ids.alice,
      { id: ids.alice, email: "alice@example.test", displayName: "Alice" }
    ],
    [ids.bob, { id: ids.bob, email: "bob@example.test", displayName: "Bob" }]
  ]);
  const teamsByUser = new Map<string, Set<string>>([
    [ids.alice, new Set([ids.teamA])],
    [ids.bob, new Set([ids.teamB])]
  ]);
  const events: CollaborationOutboxEventRecord[] = [
    event({
      cursor: 1,
      scope: "team" as const,
      teamId: ids.teamA,
      actorPrincipalId: ids.alice
    }),
    event({
      cursor: 2,
      scope: "team",
      teamId: ids.teamB,
      actorPrincipalId: ids.bob
    })
  ];
  const subscriptions = new Map<string, StoredSubscription>();
  const revokedTeams = new Set<string>();
  const revokedMemberships = new Set<string>();
  let requiresSnapshotBelowCursor = 0;

  const canAccess = (
    actor: ActorContext,
    scope: { scope: "personal" } | { scope: "team"; teamId: string }
  ) =>
    scope.scope === "personal"
      ? users.has(actor.userId)
      : teamsByUser.get(actor.userId)?.has(scope.teamId) === true &&
        !revokedTeams.has(scope.teamId) &&
        !revokedMemberships.has(`${actor.userId}:${scope.teamId}`);

  const newSubscription = (
    binding: RealtimeSubscriptionBinding,
    scope: { scope: "personal" } | { scope: "team"; teamId: string },
    highWaterCursor: number,
    expiresAt: Date
  ): StoredSubscription => ({
    id: randomUUID(),
    binding,
    protocolVersion: COLLABORATION_CONTRACT_VERSION,
    scope: scope.scope,
    personalOwnerUserId: scope.scope === "personal" ? ids.alice : null,
    teamId: scope.scope === "team" ? scope.teamId : null,
    state: "active",
    snapshotHighWaterCursor: highWaterCursor,
    acknowledgedEventId: null,
    acknowledgedCursor: 0,
    createdAt: iso,
    updatedAt: iso,
    lastAcknowledgedAt: null,
    expiresAt: expiresAt.toISOString(),
    revokedAt: null
  });

  const replayEvents = vi.fn<CollaborationRepository["replayEvents"]>(
    async (actor, input) => {
      if (!canAccess(actor, input)) return null;
      const selected = events
        .filter((candidate) =>
          input.scope === "personal"
            ? candidate.scope === "personal"
            : candidate.scope === "team" && candidate.teamId === input.teamId
        )
        .filter((candidate) => candidate.cursor > input.afterCursor);
      const limit = input.limit ?? 100;
      return {
        afterCursor: input.afterCursor,
        events: selected.slice(0, limit),
        hasMore: selected.length > limit
      };
    }
  );
  const recoverSubscription = vi.fn<
    CollaborationRepository["recoverSubscription"]
  >(async (actor, input) => {
    if (!canAccess(actor, input)) return null;
    const subscription = subscriptions.get(input.subscriptionId);
    if (!subscription || !bindingMatches(subscription.binding, input)) {
      return null;
    }
    const sameScope =
      input.scope === "personal"
        ? subscription.scope === "personal"
        : subscription.scope === "team" && subscription.teamId === input.teamId;
    if (!sameScope) return null;
    if (input.afterCursor < requiresSnapshotBelowCursor) {
      subscription.state = "requires_snapshot";
      return { subscription, requiresSnapshot: true };
    }
    return { subscription, requiresSnapshot: false };
  });
  const materializationRepository = {
    isEventAuthorized: vi.fn(async (actor: ActorContext, input) => {
      const matching = events.find(
        (candidate) =>
          candidate.id === input.eventId && candidate.cursor === input.cursor
      );
      return Boolean(
        matching &&
        canAccess(
          actor,
          matching.scope === "personal"
            ? { scope: "personal" }
            : { scope: "team", teamId: matching.teamId! }
        )
      );
    }),
    getMessageForRealtime: vi.fn(async (actor: ActorContext, input) => {
      const matching = events.find(
        (candidate) =>
          candidate.threadId === input.threadId &&
          candidate.messageId === input.messageId
      );
      if (
        !matching ||
        !canAccess(
          actor,
          matching.scope === "personal"
            ? { scope: "personal" }
            : { scope: "team", teamId: matching.teamId! }
        )
      ) {
        return null;
      }
      const sender = users.get(matching.actorPrincipalId ?? "");
      if (!sender) return null;
      return {
        id: input.messageId,
        threadId: input.threadId,
        threadSequence: matching.cursor,
        audienceVersion: 1,
        scope: matching.scope,
        personalOwnerUserId: matching.personalOwnerUserId,
        teamId: matching.teamId,
        teamWorkspaceId: matching.teamWorkspaceId,
        senderKind: "user" as const,
        senderPrincipalId: sender.id,
        senderUserId: sender.id,
        senderDisplayName: sender.displayName,
        recipientStatus: null,
        bodyText: "Authorized realtime message",
        metadata: {},
        provenance: { kind: "user_message", id: matching.id },
        createdAt: matching.occurredAt,
        updatedAt: matching.occurredAt
      };
    }),
    getReceiptStateForRealtime: vi.fn<
      CollaborationRealtimeMaterializationRepository["getReceiptStateForRealtime"]
    >(async () => null),
    listMessageReceiptsForRealtime: vi.fn<
      CollaborationRealtimeMaterializationRepository["listMessageReceiptsForRealtime"]
    >(async () => []),
    getPersonalMemoryForRealtime: vi.fn<
      CollaborationRealtimeMaterializationRepository["getPersonalMemoryForRealtime"]
    >(async () => null),
    getManagedConversationExecution: vi.fn(async () => null),
    getManagedConversationRuntimeBinding: vi.fn(async () => null)
  };

  const repository: CollaborationRepository = {
    async createPersonalNote() {
      throw new Error("unused");
    },
    async listPendingPersonalNoteRevisions() {
      return [];
    },
    async listPersonalNotes() {
      throw new Error("unused");
    },
    async getPersonalNote() {
      throw new Error("unused");
    },
    async renamePersonalNote() {
      throw new Error("unused");
    },
    async updatePersonalNoteBody() {
      throw new Error("unused");
    },
    async markPersonalNoteProjectionAvailable() {
      throw new Error("unused");
    },
    async markPersonalNoteProjectionFailed() {
      throw new Error("unused");
    },
    async listTeamParticipants() {
      throw new Error("unused");
    },
    async createThread() {
      throw new Error("unused");
    },
    async getThread() {
      throw new Error("unused");
    },
    async listThreads() {
      throw new Error("unused");
    },
    async renameThread() {
      throw new Error("unused");
    },
    async updateThreadTopic() {
      throw new Error("unused");
    },
    async archiveThread() {
      throw new Error("unused");
    },
    async restoreThread() {
      throw new Error("unused");
    },
    async sendMessage() {
      throw new Error("unused");
    },
    async listMessages() {
      throw new Error("unused");
    },
    async advanceDeliveryState() {
      throw new Error("unused");
    },
    async advanceReadState() {
      throw new Error("unused");
    },
    async getAuthorizedSnapshot(actor, input) {
      if (!canAccess(actor, input)) return null;
      return {
        scope: input.scope,
        personalOwnerUserId: input.scope === "personal" ? actor.userId : null,
        teamId: input.scope === "team" ? input.teamId : null,
        highWaterCursor: 0,
        threads: []
      } satisfies AuthorizedCollaborationSnapshotRecord;
    },
    replayEvents,
    async pruneExpiredReplayHistory() {
      return { deletedEventCount: 0, deletedSubscriptionCount: 0 };
    },
    async createSubscription(actor, input) {
      if (!canAccess(actor, input)) return null;
      const subscription = newSubscription(
        input,
        input,
        input.snapshotHighWaterCursor,
        input.expiresAt
      );
      subscriptions.set(subscription.id, subscription);
      return subscription;
    },
    recoverSubscription,
    async acknowledgeSubscription(actor, input) {
      const subscription = subscriptions.get(input.subscriptionId);
      if (!subscription || !bindingMatches(subscription.binding, input)) {
        return null;
      }
      const scope =
        subscription.scope === "personal"
          ? ({ scope: "personal" } as const)
          : ({ scope: "team", teamId: subscription.teamId! } as const);
      if (!canAccess(actor, scope)) return null;
      const matching = events.find(
        (candidate) =>
          candidate.id === input.eventId && candidate.cursor === input.cursor
      );
      if (!matching) {
        throw Object.assign(new Error("unauthorized event"), {
          statusCode: 409
        });
      }
      subscription.acknowledgedEventId = input.eventId;
      subscription.acknowledgedCursor = input.cursor;
      subscription.lastAcknowledgedAt = iso;
      return subscription;
    },
    async revokeSubscriptions(input) {
      let revokedCount = 0;
      for (const subscription of subscriptions.values()) {
        const sameScope =
          input.scope === "personal"
            ? subscription.scope === "personal"
            : subscription.scope === "team" &&
              subscription.teamId === input.teamId;
        if (sameScope && subscription.state === "active") {
          subscription.state = "revoked";
          subscription.revokedAt = iso;
          revokedCount += 1;
        }
      }
      return { revokedCount };
    }
  };

  return {
    ids,
    users,
    events,
    subscriptions,
    revokedTeams,
    revokedMemberships,
    repository,
    materializationRepository,
    replayEvents,
    recoverSubscription,
    setRequiresSnapshotBelowCursor(value: number) {
      requiresSnapshotBelowCursor = value;
    }
  };
};

const services: Array<{ close(): void | Promise<void> }> = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close();
  }
});

const buildTestServer = async (
  fixture: ReturnType<typeof createRepositoryFixture>,
  options: {
    maxClients?: number;
    maxClientsPerPrincipal?: number;
    maxUnacknowledgedEvents?: number;
    maxUnacknowledgedBytes?: number;
    ackDeadlineMs?: number;
    heartbeatMs?: number;
    authorizationRecheckMs?: number;
    auth?: CollaborationRealtimeServiceOptions["auth"];
    pool?: CollaborationRealtimeServiceOptions["pool"];
    listenerReconnectBaseMs?: number;
    listenerReconnectMaxMs?: number;
    listenerReconnectJitter?: number;
    replayBatchSize?: number;
    sharedMemoryRepository?: CollaborationRealtimeServiceOptions["sharedMemoryRepository"];
    teamPresenceRepository?: CollaborationRealtimeServiceOptions["teamPresenceRepository"];
  } = {}
) => {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const candidate =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : typeof candidate === "number"
          ? candidate
          : 500;
    reply.status(statusCode).send({
      error:
        error instanceof z.ZodError
          ? "Invalid request payload"
          : error instanceof Error
            ? error.message
            : "Request failed"
    });
  });
  const service = await createCollaborationRealtimeService({
    app,
    auth: options.auth ?? {
      authenticateSessionOrDeviceCredential: async (
        request,
        _operation,
        authOptions
      ) => {
        if (/^Bearer(?:\s|$)/i.test(request.headers.authorization ?? "")) {
          throw Object.assign(
            new Error(authOptions?.apiTokenError ?? "forbidden"),
            {
              statusCode: 403
            }
          );
        }
        const user = fixture.users.get(request.cookies.cm_session ?? "");
        if (!user) {
          throw Object.assign(new Error("Session cookie required"), {
            statusCode: 401
          });
        }
        return user;
      },
      resolveDeviceCredentialContext: async () => null
    },
    repository: fixture.repository,
    materializationRepository: fixture.materializationRepository,
    sharedMemoryRepository: options.sharedMemoryRepository ?? null,
    teamPresenceRepository: options.teamPresenceRepository ?? null,
    pool: options.pool ?? null,
    corsOrigins: new Set(["https://app.example.test"]),
    backendIdentity,
    cursorSecret,
    maxClients: options.maxClients,
    maxClientsPerPrincipal: options.maxClientsPerPrincipal,
    maxUnacknowledgedEvents: options.maxUnacknowledgedEvents,
    maxUnacknowledgedBytes: options.maxUnacknowledgedBytes,
    ackDeadlineMs: options.ackDeadlineMs,
    heartbeatMs: options.heartbeatMs ?? 10_000,
    authorizationRecheckMs: options.authorizationRecheckMs,
    listenerReconnectBaseMs: options.listenerReconnectBaseMs,
    listenerReconnectMaxMs: options.listenerReconnectMaxMs,
    listenerReconnectJitter: options.listenerReconnectJitter,
    replayBatchSize: options.replayBatchSize
  });
  service.registerRoutes();
  services.push(service, app);
  return app;
};

const sessionHeaders = (
  userId: string,
  extra: Record<string, string> = {}
) => ({
  cookie: `cm_session=${userId}`,
  origin: "https://app.example.test",
  ...extra
});

const deviceHeaders = (credentialKeyId = "realtime-device") => ({
  authorization: `Koed-Device ${credentialKeyId}:secret`,
  origin: "https://app.example.test"
});

const createDeviceAuth = (
  fixture: ReturnType<typeof createRepositoryFixture>,
  state: { active: boolean; operationFamilies: Set<string> }
) => {
  const credentialId = randomUUID();
  const cache = new WeakMap<
    FastifyRequest,
    Promise<DeviceCredentialAuthContext | null>
  >();
  const resolveDeviceCredentialContext = vi.fn(
    (request: FastifyRequest): Promise<DeviceCredentialAuthContext | null> => {
      const cached = cache.get(request);
      if (cached) return cached;
      const context = Promise.resolve(
        state.active
          ? ({
              user: fixture.users.get(fixture.ids.alice)!,
              credential: {
                id: credentialId,
                ownerUserId: fixture.ids.alice,
                enrollmentChallengeId: null,
                credentialKeyId: "realtime-device",
                upstreamBackendId: randomUUID(),
                deviceInstanceId: randomUUID(),
                lineageId: randomUUID(),
                deviceLabel: null,
                credentialVersion: 1,
                verifierKind: "secret_hash",
                operationFamilies: [...state.operationFamilies],
                metadata: {},
                createdAt: iso,
                updatedAt: iso,
                lastUsedAt: null,
                lastValidatedAt: iso,
                expiresAt: null,
                revokedAt: null,
                revokedByUserId: null,
                revocationReason: null
              }
            } as DeviceCredentialAuthContext)
          : null
      );
      cache.set(request, context);
      return context;
    }
  );
  const authenticateSessionOrDeviceCredential: CollaborationRealtimeServiceOptions["auth"]["authenticateSessionOrDeviceCredential"] =
    async (request, operationFamily, options = {}) => {
      if (/^Bearer(?:\s|$)/i.test(request.headers.authorization ?? "")) {
        throw Object.assign(new Error(options.apiTokenError ?? "forbidden"), {
          statusCode: 403
        });
      }
      if (/^Koed-Device(?:\s|$)/i.test(request.headers.authorization ?? "")) {
        const context = await resolveDeviceCredentialContext(request);
        if (!context) {
          throw Object.assign(new Error("Invalid device credential"), {
            statusCode: 401
          });
        }
        if (!context.credential.operationFamilies.includes(operationFamily)) {
          throw Object.assign(new Error("Device operation family denied"), {
            statusCode: 403
          });
        }
        return context.user;
      }
      const user = fixture.users.get(request.cookies.cm_session ?? "");
      if (!user) {
        throw Object.assign(new Error("Session cookie required"), {
          statusCode: 401
        });
      }
      return user;
    };
  return {
    auth: {
      authenticateSessionOrDeviceCredential,
      resolveDeviceCredentialContext
    },
    credentialId,
    resolveDeviceCredentialContext
  };
};

const createTeamSnapshot = async (
  app: Awaited<ReturnType<typeof buildTestServer>>,
  userId: string,
  teamId: string,
  binding = {
    clientInstanceId: "client-instance-0001",
    subscriptionKey: "subscription-key-0001"
  },
  headers: Record<string, string> = sessionHeaders(userId)
) => {
  const response = await app.inject({
    method: "POST",
    url: "/v1/collaboration/realtime/snapshot",
    headers,
    payload: { scope: "team", teamId, ...binding }
  });
  expect(response.statusCode).toBe(200);
  return jsonBody<{
    cursor: string;
    subscription: CollaborationSubscriptionRecord;
    snapshot: {
      highWaterCursor: string;
      threads: CollaborationThreadRecord[];
    };
  }>(response);
};

const openTeamStream = async (
  app: Awaited<ReturnType<typeof buildTestServer>>,
  input: {
    userId: string;
    teamId: string;
    cursor: string;
    clientInstanceId?: string;
    subscriptionKey?: string;
    headers?: Record<string, string>;
  }
) => {
  if (!app.server.listening) {
    await app.listen({ port: 0, host: "127.0.0.1" });
  }
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not listen on TCP");
  }
  const controller = new AbortController();
  const url = new URL(
    `http://127.0.0.1:${address.port}/v1/collaboration/realtime/stream`
  );
  url.searchParams.set("scope", "team");
  url.searchParams.set("teamId", input.teamId);
  url.searchParams.set(
    "clientInstanceId",
    input.clientInstanceId ?? "client-instance-0001"
  );
  url.searchParams.set(
    "subscriptionKey",
    input.subscriptionKey ?? "subscription-key-0001"
  );
  url.searchParams.set("cursor", input.cursor);
  const response = await fetch(url, {
    headers: input.headers ?? sessionHeaders(input.userId),
    signal: controller.signal
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    get text() {
      return text;
    },
    async readUntil(eventName: string, timeoutMs = 1_000) {
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        while (!text.includes(`event: ${eventName}\n`)) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
        expect(text).toContain(`event: ${eventName}\n`);
        return text;
      } finally {
        clearTimeout(timeout);
      }
    },
    async expectOpenFor(durationMs: number) {
      let closed = false;
      void reader.closed.then(
        () => {
          closed = true;
        },
        () => {
          closed = true;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      expect(closed).toBe(false);
    },
    close() {
      controller.abort();
      reader.releaseLock();
    }
  };
};

const readStreamUntil = async (
  app: Awaited<ReturnType<typeof buildTestServer>>,
  input: {
    userId: string;
    teamId: string;
    cursor: string;
    clientInstanceId?: string;
    subscriptionKey?: string;
    headers?: Record<string, string>;
    eventName: string;
  }
) => {
  const stream = await openTeamStream(app, input);
  try {
    return await stream.readUntil(input.eventName);
  } finally {
    stream.close();
  }
};

const eventData = (stream: string, eventName: string): unknown => {
  const block = stream
    .split("\n\n")
    .find((candidate) => candidate.includes(`event: ${eventName}\n`));
  const data = block?.split("\n").find((line) => line.startsWith("data: "));
  if (!data) throw new Error(`missing ${eventName} data`);
  return JSON.parse(data.slice("data: ".length)) as unknown;
};

const allEventData = <T>(stream: string, eventName: string): T[] =>
  stream
    .split("\n\n")
    .filter((candidate) => candidate.includes(`event: ${eventName}\n`))
    .map((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (!data) throw new Error(`missing ${eventName} data`);
      return JSON.parse(data.slice("data: ".length)) as T;
    });

const createListenerPool = () => {
  const listeners: Array<{
    query: (sql: string) => Promise<unknown>;
    notification?: (message: { channel: string; payload?: string }) => void;
    error?: (error: unknown) => void;
    release: () => void;
  }> = [];
  const connect = vi.fn(async () => {
    const state: (typeof listeners)[number] = {
      query: vi.fn(async (sql: string): Promise<unknown> => {
        void sql;
        return undefined;
      }),
      release: vi.fn()
    };
    const listener = {
      query: state.query,
      on(
        name: "notification" | "error",
        callback:
          | ((message: { channel: string; payload?: string }) => void)
          | ((error: unknown) => void)
      ) {
        if (name === "notification") {
          state.notification = callback as typeof state.notification;
        } else {
          state.error = callback as typeof state.error;
        }
      },
      removeAllListeners: vi.fn(),
      release: state.release
    };
    listeners.push(state);
    return listener;
  });
  return { connect, listeners };
};

const sharedCompanionThread = (
  fixture: ReturnType<typeof createRepositoryFixture>
): CollaborationThreadRecord => ({
  id: fixture.ids.companionThread,
  logicalId: randomUUID(),
  scope: "team",
  kind: "shared_session_discussion",
  personalOwnerUserId: null,
  teamId: fixture.ids.teamA,
  teamWorkspaceId: fixture.ids.workspace,
  sharedLogicalMemoryId: fixture.ids.logicalMemory,
  shareGrantId: fixture.ids.shareGrant,
  systemKey: null,
  name: null,
  topic: null,
  createdByUserId: fixture.ids.alice,
  version: 1,
  lifecycle: "active",
  latestSequence: 0,
  lastReadMessageId: null,
  lastReadSequence: 0,
  unreadCount: 0,
  participants: [
    { userId: fixture.ids.alice, displayName: "Alice" },
    { userId: fixture.ids.bob, displayName: "Bob" }
  ],
  createdAt: iso,
  updatedAt: iso,
  lastActivityAt: iso,
  archivedAt: null
});

const workspaceChannelThread = (
  fixture: ReturnType<typeof createRepositoryFixture>
): CollaborationThreadRecord => ({
  id: fixture.events[0]!.threadId!,
  logicalId: randomUUID(),
  scope: "team",
  kind: "workspace_channel",
  personalOwnerUserId: null,
  teamId: fixture.ids.teamA,
  teamWorkspaceId: fixture.ids.workspace,
  sharedLogicalMemoryId: null,
  shareGrantId: null,
  systemKey: null,
  name: "release-coordination",
  topic: "Realtime contract coverage",
  createdByUserId: fixture.ids.alice,
  version: 2,
  lifecycle: "active",
  latestSequence: 0,
  lastReadMessageId: null,
  lastReadSequence: 0,
  unreadCount: 0,
  participants: [],
  createdAt: iso,
  updatedAt: iso,
  lastActivityAt: iso,
  archivedAt: null
});

const workspaceGrantPage = (
  fixture: ReturnType<typeof createRepositoryFixture>,
  includeGrant = true
) => {
  const companionScope = {
    scope: "team" as const,
    kind: "shared_session_discussion" as const,
    teamId: fixture.ids.teamA,
    teamWorkspaceId: fixture.ids.workspace,
    logicalMemoryId: fixture.ids.logicalMemory,
    shareGrantId: fixture.ids.shareGrant
  };
  return {
    entries: includeGrant
      ? [
          {
            shareGrantId: fixture.ids.shareGrant,
            logicalMemoryId: fixture.ids.logicalMemory,
            ownerUserId: fixture.ids.alice,
            ownerDisplayName: "Alice",
            sourceCapabilities: ["memory_events" as const],
            activationRepresentation: "memory_events" as const,
            maximumFidelity: "memory_events" as const,
            includeCuratedMemory: false,
            title: "Shared Memory",
            activeRepresentation: "memory_events" as const,
            representationState: "available" as const,
            representationSourceRevision: 7,
            representationUpdatedAt: iso,
            freshness: "fresh" as const,
            lifecycle: "active" as const,
            createdAt: iso,
            updatedAt: iso,
            companionScope
          }
        ]
      : [],
    limit: 100,
    offset: 0,
    hasMore: false
  };
};

describe("collaboration realtime protocol", () => {
  it("requires session auth, denies Bearer API Tokens, and enforces Origin allowlist", async () => {
    const fixture = createRepositoryFixture();
    const app = await buildTestServer(fixture);
    const payload = {
      scope: "team",
      teamId: fixture.ids.teamA,
      clientInstanceId: "client-instance-0001",
      subscriptionKey: "subscription-key-0001"
    };

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/collaboration/realtime/snapshot",
          payload
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/collaboration/realtime/snapshot",
          headers: { authorization: "Bearer api-token" },
          payload
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/collaboration/realtime/snapshot",
          headers: { authorization: "Bearer api-token" },
          payload: {}
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/collaboration/realtime/ack",
          headers: { authorization: "Bearer api-token" },
          payload: {}
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/collaboration/realtime/stream",
          headers: { authorization: "Bearer api-token" }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/collaboration/realtime/snapshot",
          headers: sessionHeaders(fixture.ids.alice, {
            origin: "https://evil.example.test"
          }),
          payload
        })
      ).statusCode
    ).toBe(403);
  });

  it("requires Personal read scope for Personal realtime", async () => {
    const fixture = createRepositoryFixture();
    const payload = {
      scope: "personal",
      clientInstanceId: "personal-client-0001",
      subscriptionKey: "personal-subscription-0001"
    };
    const personalDevice = createDeviceAuth(fixture, {
      active: true,
      operationFamilies: new Set(["personal_collaboration_read"])
    });
    const app = await buildTestServer(fixture, {
      auth: personalDevice.auth
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/collaboration/realtime/snapshot",
          headers: deviceHeaders(),
          payload
        })
      ).statusCode
    ).toBe(200);

    const teamOnlyDevice = createDeviceAuth(fixture, {
      active: true,
      operationFamilies: new Set(["team_workspace_read"])
    });
    const deniedApp = await buildTestServer(fixture, {
      auth: teamOnlyDevice.auth
    });
    expect(
      (
        await deniedApp.inject({
          method: "POST",
          url: "/v1/collaboration/realtime/snapshot",
          headers: deviceHeaders(),
          payload
        })
      ).statusCode
    ).toBe(403);
  });

  it("issues an authorized snapshot with an opaque high-water cursor", async () => {
    const fixture = createRepositoryFixture();
    const app = await buildTestServer(fixture);
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );

    expect(snapshot.cursor).toMatch(/^crt1\./);
    expect(snapshot.snapshot.highWaterCursor).toBe(snapshot.cursor);
    expect(snapshot.subscription.scope).toBe("team");
    expect(snapshot.subscription.teamId).toBe(fixture.ids.teamA);
  });

  it("scopes Shared Session identities in realtime snapshots", async () => {
    const fixture = createRepositoryFixture();
    const companion = sharedCompanionThread(fixture);
    fixture.repository.getAuthorizedSnapshot = vi.fn(async () => ({
      scope: "team" as const,
      personalOwnerUserId: null,
      teamId: fixture.ids.teamA,
      highWaterCursor: 0,
      threads: [companion]
    }));
    const app = await buildTestServer(fixture);
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );

    expect(snapshot.snapshot.threads[0]?.sharedLogicalMemoryId).toBe(
      sharedMemoryGrantScopedSourceId(
        fixture.ids.shareGrant,
        fixture.ids.logicalMemory
      )
    );
    expect(JSON.stringify(snapshot.snapshot)).not.toContain(
      fixture.ids.logicalMemory
    );
    expect(snapshot.snapshot.threads[0]?.createdByUserId).toBe(
      sharedMemoryGrantScopedPrincipalId(
        fixture.ids.shareGrant,
        fixture.ids.alice
      )
    );
  });

  it("keeps an idle TCP realtime response open until the client disconnects", async () => {
    const fixture = createRepositoryFixture();
    const app = await buildTestServer(fixture);
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor
    });
    try {
      await stream.readUntil("ready");
      await stream.expectOpenFor(50);
    } finally {
      stream.close();
    }
  });

  it("atomically replaces overlapping streams for one subscription", async () => {
    const fixture = createRepositoryFixture();
    const app = await buildTestServer(fixture);
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const input = {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor
    };
    const first = await openTeamStream(app, input);
    const second = await openTeamStream(app, input);
    let third: Awaited<ReturnType<typeof openTeamStream>> | null = null;
    try {
      expect(
        eventData(await first.readUntil("control"), "control")
      ).toMatchObject({
        subscription: { id: snapshot.subscription.id },
        reason: "stream_replaced"
      });
      await second.readUntil("ready");

      third = await openTeamStream(app, input);
      expect(
        eventData(await second.readUntil("control"), "control")
      ).toMatchObject({
        subscription: { id: snapshot.subscription.id },
        reason: "stream_replaced"
      });
      await third.readUntil("ready");
      await third.expectOpenFor(25);
    } finally {
      first.close();
      second.close();
      third?.close();
    }
  });

  it("rejects cursor tampering", async () => {
    const fixture = createRepositoryFixture();
    const app = await buildTestServer(fixture);
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const tamperIndex = "crt1.".length + 8;
    const tampered = `${snapshot.cursor.slice(0, tamperIndex)}${
      snapshot.cursor[tamperIndex] === "A" ? "B" : "A"
    }${snapshot.cursor.slice(tamperIndex + 1)}`;

    const response = await app.inject({
      method: "GET",
      url: `/v1/collaboration/realtime/stream?scope=team&teamId=${fixture.ids.teamA}&clientInstanceId=client-instance-0001&subscriptionKey=subscription-key-0001&cursor=${encodeURIComponent(tampered)}`,
      headers: sessionHeaders(fixture.ids.alice)
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects cross-principal and cross-Team cursor reuse", async () => {
    const fixture = createRepositoryFixture();
    const app = await buildTestServer(fixture);
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );

    const crossPrincipal = await app.inject({
      method: "GET",
      url: `/v1/collaboration/realtime/stream?scope=team&teamId=${fixture.ids.teamA}&clientInstanceId=client-instance-0001&subscriptionKey=subscription-key-0001&cursor=${encodeURIComponent(snapshot.cursor)}`,
      headers: sessionHeaders(fixture.ids.bob)
    });
    expect(crossPrincipal.statusCode).toBe(403);

    const crossTeam = await app.inject({
      method: "GET",
      url: `/v1/collaboration/realtime/stream?scope=team&teamId=${fixture.ids.teamB}&clientInstanceId=client-instance-0001&subscriptionKey=subscription-key-0001&cursor=${encodeURIComponent(snapshot.cursor)}`,
      headers: sessionHeaders(fixture.ids.alice)
    });
    expect(crossTeam.statusCode).toBe(403);
  });

  it("returns no subscription metadata to an unauthorized principal", async () => {
    const fixture = createRepositoryFixture();
    const app = await buildTestServer(fixture);
    const authorized = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const binding = {
      clientInstanceId: "unauthorized-client",
      subscriptionKey: "unauthorized-subscription-key"
    };

    const deniedSnapshot = await app.inject({
      method: "POST",
      url: "/v1/collaboration/realtime/snapshot",
      headers: sessionHeaders(fixture.ids.bob),
      payload: { scope: "team", teamId: fixture.ids.teamA, ...binding }
    });
    expect(deniedSnapshot.statusCode).toBe(403);
    expect(jsonBody(deniedSnapshot)).toEqual({
      error: "Collaboration realtime snapshot cannot be viewed"
    });

    const deniedStream = await app.inject({
      method: "GET",
      url: `/v1/collaboration/realtime/stream?scope=team&teamId=${fixture.ids.teamA}&clientInstanceId=client-instance-0001&subscriptionKey=subscription-key-0001&cursor=${encodeURIComponent(authorized.cursor)}`,
      headers: sessionHeaders(fixture.ids.bob)
    });
    expect(deniedStream.statusCode).toBe(403);
    expect(jsonBody(deniedStream)).toEqual({
      error: "Realtime cursor cannot be used here"
    });

    const serializedDenials = `${deniedSnapshot.body}\n${deniedStream.body}`;
    expect(serializedDenials).not.toContain(fixture.ids.teamA);
    expect(serializedDenials).not.toContain(authorized.subscription.id);
    expect(serializedDenials).not.toContain(authorized.cursor);
    expect(serializedDenials).not.toContain(binding.subscriptionKey);
    expect(fixture.subscriptions.size).toBe(1);
  });

  it("replays retained events as content-safe envelopes and acknowledges only server-issued events", async () => {
    const fixture = createRepositoryFixture();
    const app = await buildTestServer(fixture);
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const stream = await readStreamUntil(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor,
      eventName: "collaboration_event"
    });
    const eventBlock = stream
      .split("\n\n")
      .find((block) => block.includes("event: collaboration_event\n"));
    const dataLine = eventBlock
      ?.split("\n")
      .find((line) => line.startsWith("data: {"));
    expect(dataLine).toBeTruthy();
    const envelope = JSON.parse(dataLine!.slice("data: ".length)) as {
      eventId: string;
      cursor: string;
      type: string;
      resource: { type: string; id: string };
      update: unknown;
    };
    expect(envelope.type).toBe("message_created");
    expect(envelope.resource.type).toBe("collaboration_message");
    expect(envelope).toMatchObject({
      update: {
        type: "message_created",
        message: {
          id: fixture.events[0]!.messageId,
          body: "Authorized realtime message"
        }
      }
    });
    expect(JSON.stringify(envelope)).not.toContain("bodyText");

    const ack = await app.inject({
      method: "POST",
      url: "/v1/collaboration/realtime/ack",
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        subscriptionId: snapshot.subscription.id,
        eventId: envelope.eventId,
        cursor: envelope.cursor,
        clientInstanceId: "client-instance-0001",
        subscriptionKey: "subscription-key-0001"
      }
    });
    expect(ack.statusCode).toBe(200);
    expect(
      jsonBody<{ subscription: CollaborationSubscriptionRecord }>(ack)
        .subscription.acknowledgedEventId
    ).toBe(envelope.eventId);

    const forgedAck = await app.inject({
      method: "POST",
      url: "/v1/collaboration/realtime/ack",
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        subscriptionId: snapshot.subscription.id,
        eventId: randomUUID(),
        cursor: envelope.cursor,
        clientInstanceId: "client-instance-0001",
        subscriptionKey: "subscription-key-0001"
      }
    });
    expect(forgedAck.statusCode).toBe(400);
  });

  it("delivers read state only to the principal whose state changed", async () => {
    const fixture = createRepositoryFixture();
    const threadId = randomUUID();
    fixture.events.splice(
      0,
      fixture.events.length,
      event({
        cursor: 1,
        scope: "team",
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspace,
        threadId,
        messageId: threadId,
        actorPrincipalId: fixture.ids.alice,
        resourceType: "collaboration_receipt_state",
        resourceId: `${threadId}:${fixture.ids.alice}`,
        family: "receipt_state_updated"
      })
    );
    fixture.materializationRepository.getReceiptStateForRealtime.mockResolvedValue(
      {
        threadId,
        userId: fixture.ids.alice,
        lastDeliveredMessageId: threadId,
        lastDeliveredSequence: 4,
        lastDeliveredAt: iso,
        lastReadMessageId: threadId,
        lastReadSequence: 4,
        lastReadAt: iso,
        unreadCount: 0,
        version: 2,
        updatedAt: iso
      }
    );
    const app = await buildTestServer(fixture, { heartbeatMs: 20 });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const delivered = await readStreamUntil(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor,
      eventName: "collaboration_event"
    });
    expect(eventData(delivered, "collaboration_event")).toMatchObject({
      update: {
        type: "receipt_state_updated",
        readState: { threadId, sequence: 4 }
      }
    });

    fixture.events[0] = {
      ...fixture.events[0]!,
      id: randomUUID(),
      cursor: 2,
      actorPrincipalId: fixture.ids.bob
    };
    const skippedSnapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA,
      {
        clientInstanceId: "client-instance-0002",
        subscriptionKey: "subscription-key-0002"
      }
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: skippedSnapshot.cursor,
      clientInstanceId: "client-instance-0002",
      subscriptionKey: "subscription-key-0002"
    });
    try {
      const body = await stream.readUntil("heartbeat");
      expect(body).not.toContain("event: collaboration_event\n");
    } finally {
      stream.close();
    }
  });

  it("skips an initial Share Grant event until an authorized representation exists", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(
      0,
      fixture.events.length,
      event({
        cursor: 1,
        scope: "team",
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspace,
        shareGrantId: fixture.ids.shareGrant,
        logicalMemoryId: fixture.ids.logicalMemory,
        actorPrincipalId: fixture.ids.alice,
        messageId: null,
        family: "share_grant_lifecycle",
        resourceType: "shared_memory_grant",
        resourceId: fixture.ids.shareGrant
      })
    );
    const listWorkspaceGrants = vi.fn(async () =>
      workspaceGrantPage(fixture, false)
    );
    const app = await buildTestServer(fixture, {
      heartbeatMs: 20,
      sharedMemoryRepository: {
        getOwnerShare: vi.fn(async () => null),
        listWorkspaceGrants
      }
    });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor
    });
    try {
      const body = await stream.readUntil("heartbeat");
      expect(body).not.toContain("event: collaboration_event\n");
      expect(listWorkspaceGrants).toHaveBeenCalledOnce();
    } finally {
      stream.close();
    }
  });

  it("waits for the companion event without forcing a snapshot reconnect", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(
      0,
      fixture.events.length,
      event({
        cursor: 1,
        scope: "team",
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspace,
        shareGrantId: fixture.ids.shareGrant,
        logicalMemoryId: fixture.ids.logicalMemory,
        messageId: null,
        family: "memory_event_available",
        resourceType: "team_memory_representation",
        resourceId: randomUUID()
      })
    );
    fixture.repository.listThreads = vi.fn(async () => []);
    const app = await buildTestServer(fixture, {
      heartbeatMs: 20,
      sharedMemoryRepository: {
        getOwnerShare: vi.fn(async () => null),
        listWorkspaceGrants: vi.fn(async () => workspaceGrantPage(fixture))
      }
    });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor
    });
    try {
      const body = await stream.readUntil("heartbeat");
      expect(body).not.toContain("event: collaboration_event\n");
      expect(body).not.toContain("event: requires_snapshot\n");
    } finally {
      stream.close();
    }
  });

  it("materializes an authorized Shared Session when its representation becomes available", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(
      0,
      fixture.events.length,
      event({
        cursor: 1,
        scope: "team",
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspace,
        shareGrantId: fixture.ids.shareGrant,
        logicalMemoryId: fixture.ids.logicalMemory,
        actorPrincipalId: fixture.ids.alice,
        messageId: null,
        family: "memory_event_available",
        resourceType: "shared_memory_representation",
        resourceId: fixture.ids.shareGrant
      })
    );
    fixture.repository.listThreads = vi.fn(async () => [
      sharedCompanionThread(fixture)
    ]);
    fixture.repository.listTeamParticipants = vi.fn(async () => [
      { userId: fixture.ids.alice, displayName: "Alice" },
      { userId: fixture.ids.bob, displayName: "Bob" }
    ]);
    const device = createDeviceAuth(fixture, {
      active: true,
      operationFamilies: new Set(["team_workspace_read"])
    });
    const app = await buildTestServer(fixture, {
      auth: device.auth,
      sharedMemoryRepository: {
        getOwnerShare: vi.fn(async () => null),
        listWorkspaceGrants: vi.fn(async () => workspaceGrantPage(fixture))
      }
    });
    const headers = deviceHeaders();
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA,
      undefined,
      headers
    );
    const body = await readStreamUntil(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor,
      headers,
      eventName: "collaboration_event"
    });
    expect(eventData(body, "collaboration_event")).toMatchObject({
      type: "memory_event_available",
      resource: {
        logicalMemoryId: sharedMemoryGrantScopedSourceId(
          fixture.ids.shareGrant,
          fixture.ids.logicalMemory
        )
      },
      actor: {
        principalId: sharedMemoryGrantScopedPrincipalId(
          fixture.ids.shareGrant,
          fixture.ids.alice
        )
      },
      update: {
        type: "shared_session_upserted",
        session: {
          id: fixture.ids.shareGrant,
          logicalMemoryId: sharedMemoryGrantScopedSourceId(
            fixture.ids.shareGrant,
            fixture.ids.logicalMemory
          ),
          owner: {
            id: sharedMemoryGrantScopedPrincipalId(
              fixture.ids.shareGrant,
              fixture.ids.alice
            )
          },
          companionThreadId: fixture.ids.companionThread,
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          sourceState: "ready"
        }
      }
    });
  });

  it("materializes a Shared Session when its companion discussion completes the share", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(
      0,
      fixture.events.length,
      event({
        cursor: 1,
        scope: "team",
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspace,
        threadId: fixture.ids.companionThread,
        shareGrantId: fixture.ids.shareGrant,
        logicalMemoryId: fixture.ids.logicalMemory,
        actorPrincipalId: fixture.ids.alice,
        messageId: null,
        family: "thread_lifecycle",
        resourceType: "collaboration_thread",
        resourceId: fixture.ids.companionThread
      })
    );
    const companion = sharedCompanionThread(fixture);
    fixture.repository.getThread = vi.fn(async () => companion);
    fixture.repository.listThreads = vi.fn(async () => [companion]);
    fixture.repository.listTeamParticipants = vi.fn(async () => [
      { userId: fixture.ids.alice, displayName: "Alice" },
      { userId: fixture.ids.bob, displayName: "Bob" }
    ]);
    const app = await buildTestServer(fixture, {
      sharedMemoryRepository: {
        getOwnerShare: vi.fn(async () => null),
        listWorkspaceGrants: vi.fn(async () => workspaceGrantPage(fixture))
      }
    });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const body = await readStreamUntil(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor,
      eventName: "collaboration_event"
    });
    expect(eventData(body, "collaboration_event")).toMatchObject({
      type: "thread_lifecycle",
      resource: {
        logicalMemoryId: sharedMemoryGrantScopedSourceId(
          fixture.ids.shareGrant,
          fixture.ids.logicalMemory
        )
      },
      actor: {
        principalId: sharedMemoryGrantScopedPrincipalId(
          fixture.ids.shareGrant,
          fixture.ids.alice
        )
      },
      update: {
        type: "shared_session_upserted",
        session: {
          id: fixture.ids.shareGrant,
          logicalMemoryId: sharedMemoryGrantScopedSourceId(
            fixture.ids.shareGrant,
            fixture.ids.logicalMemory
          ),
          owner: {
            id: sharedMemoryGrantScopedPrincipalId(
              fixture.ids.shareGrant,
              fixture.ids.alice
            )
          },
          companionThreadId: fixture.ids.companionThread,
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          sourceState: "ready"
        }
      }
    });
  });

  it("delivers companion discussion messages to a Workspace and Team chat reader", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(
      0,
      fixture.events.length,
      event({
        cursor: 1,
        scope: "team",
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspace,
        threadId: fixture.ids.companionThread,
        shareGrantId: fixture.ids.shareGrant,
        logicalMemoryId: fixture.ids.logicalMemory,
        family: "shared_session_discussion_activity",
        actorPrincipalId: fixture.ids.alice
      })
    );
    const device = createDeviceAuth(fixture, {
      active: true,
      operationFamilies: new Set(["team_workspace_read", "team_chat_read"])
    });
    const app = await buildTestServer(fixture, { auth: device.auth });
    const headers = deviceHeaders();
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA,
      undefined,
      headers
    );
    const body = await readStreamUntil(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor,
      headers,
      eventName: "collaboration_event"
    });

    expect(eventData(body, "collaboration_event")).toMatchObject({
      type: "shared_session_discussion_activity",
      update: {
        type: "message_created",
        message: {
          threadId: fixture.ids.companionThread,
          body: "Authorized realtime message"
        }
      }
    });
  });

  it("keeps the realtime event-family matrix exhaustive with the shared contract", () => {
    expect(realtimeFamilyCases.map(([family]) => family)).toEqual(
      collaborationRealtimeEventFamilySchema.options
    );
  });

  it("materializes the current owner-authorized Personal Memory entry and fails closed on mismatches", async () => {
    const ownerId = randomUUID();
    const sessionId = randomUUID();
    const logicalMemoryId = randomUUID();
    const personalEvent = event({
      cursor: 1,
      scope: "personal",
      teamId: null,
      teamWorkspaceId: null,
      threadId: null,
      messageId: null,
      shareGrantId: null,
      logicalMemoryId,
      actorPrincipalId: ownerId,
      resourceType: "personal_memory_entry",
      resourceId: sessionId,
      family: "personal_memory_changed"
    });
    personalEvent.personalOwnerUserId = ownerId;
    personalEvent.threadId = null;
    personalEvent.messageId = null;
    const repository = {
      isEventAuthorized: vi.fn(async () => true),
      getMessageForRealtime: vi.fn(async () => null),
      getReceiptStateForRealtime: vi.fn(async () => null),
      listMessageReceiptsForRealtime: vi.fn(async () => []),
      getPersonalMemoryForRealtime: vi.fn<
        CollaborationRealtimeMaterializationRepository["getPersonalMemoryForRealtime"]
      >(async () => ({
        sessionId,
        logicalMemoryId,
        title: "Current Personal Memory",
        projectName: "Koed",
        updatedAt: iso,
        eventCount: 2,
        hasSynchronizedRevision: true,
        syncState: "ready" as const
      }))
    } satisfies CollaborationRealtimeMaterializationRepository;

    await expect(
      materializePersonalMemoryChangedEvent(
        { userId: ownerId },
        personalEvent,
        repository
      )
    ).resolves.toMatchObject({
      action: "deliver",
      update: {
        type: "personal_memory_upserted",
        entry: { id: sessionId, logicalMemoryId, syncState: "ready" }
      }
    });
    await expect(
      materializePersonalMemoryChangedEvent(
        { userId: randomUUID() },
        personalEvent,
        repository
      )
    ).resolves.toEqual({ action: "requires_snapshot" });
    repository.getPersonalMemoryForRealtime.mockResolvedValueOnce(null);
    await expect(
      materializePersonalMemoryChangedEvent(
        { userId: ownerId },
        personalEvent,
        repository
      )
    ).resolves.toEqual({ action: "requires_snapshot" });
  });

  it("materializes owner-only Pending Share lifecycle status without Team authority", async () => {
    const ownerId = randomUUID();
    const pendingShareId = randomUUID();
    const logicalMemoryId = randomUUID();
    const source = {
      kind: "captured_session" as const,
      sessionId: randomUUID(),
      logicalMemoryId
    };
    const eventRecord = event({
      cursor: 1,
      scope: "personal",
      teamId: null,
      teamWorkspaceId: null,
      threadId: null,
      messageId: null,
      shareGrantId: null,
      logicalMemoryId: null,
      actorPrincipalId: ownerId,
      resourceType: "pending_share_operations",
      resourceId: pendingShareId,
      family: "pending_share_lifecycle"
    });
    eventRecord.personalOwnerUserId = ownerId;
    eventRecord.threadId = null;
    const repository = {
      getOwnerShare: vi.fn(async () => ({
        kind: "pending" as const,
        pendingShare: {
          source,
          sourceCapabilities: [
            "lcm_rollups",
            "lcm_leaves",
            "memory_events"
          ] as SharedMemoryRepresentation[],
          activationRepresentation: "memory_events" as const,
          id: pendingShareId,
          mutationId: randomUUID(),
          logicalGrantId: randomUUID(),
          consentId: randomUUID(),
          logicalMemoryId,
          teamId: randomUUID(),
          teamWorkspaceId: randomUUID(),
          representation: "memory_events" as const,
          maximumFidelity: "memory_events" as const,
          includeCuratedMemory: false,
          mode: "continuous" as const,
          sourceRevision: 4,
          state: "needs_attention" as const,
          stage: "privacy_filtering" as const,
          workspaceAccessState: "none" as const,
          sourceUpdateState: "failed" as const,
          operationVersion: 3,
          attemptCount: 2,
          redactedFailureCode: "source_preparation_stalled",
          lastProgressAt: iso,
          createdAt: iso,
          updatedAt: iso,
          activatedAt: null,
          revokedAt: null,
          grantId: null,
          grantVersion: null
        },
        sourceAccess: null,
        summary: {
          source,
          sourceSessionId: source.sessionId,
          companionThreadId: null,
          sourceTitle: "Owner conversation",
          teamName: "Team",
          workspaceName: "Workspace",
          workspaceContentAccess: "unavailable" as const,
          mode: "continuous" as const,
          authorizedPreview: null,
          lastReadyRevision: null,
          lastSuccessfulUpdateAt: null
        }
      }))
    };

    await expect(
      materializePendingShareLifecycleEvent(
        { userId: ownerId },
        eventRecord,
        repository
      )
    ).resolves.toMatchObject({
      action: "deliver",
      update: {
        type: "owned_share_status_changed",
        pendingShareId,
        sourceTitle: "Owner conversation",
        state: "needs_attention",
        stage: "privacy_filtering",
        redactedFailureCode: "source_preparation_stalled"
      }
    });
  });

  it.each(realtimeFamilyCases)(
    "covers the exact %s realtime event-family contract",
    async (family, wireEvent, updateType) => {
      const fixture = createRepositoryFixture();
      const threadId = randomUUID();
      const messageId =
        family === "message_created" ||
        family === "receipt_state_updated" ||
        family === "shared_session_discussion_activity"
          ? randomUUID()
          : null;
      const sharedFamily = [
        "share_grant_lifecycle",
        "fidelity_changed",
        "source_revision_changed",
        "memory_event_available",
        "lcm_leaf_available",
        "lcm_rollup_available"
      ].includes(family);
      const resourceType =
        family === "team_presence_changed"
          ? "team_member_presence"
          : family === "receipt_state_updated"
            ? "collaboration_receipt_state"
            : family === "thread_lifecycle"
              ? "collaboration_thread"
              : family === "message_created" ||
                  family === "shared_session_discussion_activity"
                ? "collaboration_message"
                : family === "share_grant_lifecycle" ||
                    family === "source_revision_changed" ||
                    family === "access_revoked"
                  ? "shared_memory_grant"
                  : sharedFamily
                    ? "shared_memory_representation"
                    : family === "workspace_lifecycle_access"
                      ? "team_workspace_access"
                      : family === "team_membership_access"
                        ? "team_membership"
                        : "team";
      fixture.events.splice(
        0,
        fixture.events.length,
        event({
          cursor: 1,
          scope: "team",
          teamId: fixture.ids.teamA,
          teamWorkspaceId: fixture.ids.workspace,
          threadId:
            family === "thread_lifecycle" ||
            family === "message_created" ||
            family === "receipt_state_updated"
              ? threadId
              : family === "shared_session_discussion_activity"
                ? fixture.ids.companionThread
                : null,
          messageId,
          shareGrantId: sharedFamily ? fixture.ids.shareGrant : null,
          logicalMemoryId: sharedFamily ? fixture.ids.logicalMemory : null,
          actorPrincipalId: fixture.ids.alice,
          resourceType,
          resourceId:
            family === "team_presence_changed"
              ? fixture.ids.alice
              : family === "thread_lifecycle"
                ? threadId
                : family === "receipt_state_updated"
                  ? `${threadId}:${fixture.ids.alice}`
                  : sharedFamily
                    ? fixture.ids.shareGrant
                    : undefined,
          family
        })
      );
      if (family === "thread_lifecycle") {
        fixture.repository.getThread = vi.fn(async () =>
          workspaceChannelThread(fixture)
        );
      }
      if (family === "receipt_state_updated") {
        fixture.materializationRepository.getReceiptStateForRealtime.mockResolvedValue(
          {
            threadId,
            userId: fixture.ids.alice,
            lastDeliveredMessageId: threadId,
            lastDeliveredSequence: 9,
            lastDeliveredAt: iso,
            lastReadMessageId: threadId,
            lastReadSequence: 9,
            lastReadAt: iso,
            unreadCount: 0,
            version: 3,
            updatedAt: iso
          }
        );
      }
      if (sharedFamily) {
        fixture.repository.listThreads = vi.fn(async () => [
          sharedCompanionThread(fixture)
        ]);
        fixture.repository.listTeamParticipants = vi.fn(async () => [
          { userId: fixture.ids.alice, displayName: "Alice" }
        ]);
      }
      const app = await buildTestServer(fixture, {
        heartbeatMs: 20,
        teamPresenceRepository:
          family === "team_presence_changed"
            ? {
                getTeamRosterMember: vi.fn(async () => ({
                  userId: fixture.ids.alice,
                  displayName: "Alice",
                  avatarReference: null,
                  status: "enabled" as const,
                  presenceMode: "auto" as const,
                  manualPresenceStatus: "available" as const,
                  presenceVersion: 1,
                  lastHumanActivityAt: iso
                }))
              }
            : null,
        sharedMemoryRepository: sharedFamily
          ? {
              getOwnerShare: vi.fn(async () => null),
              listWorkspaceGrants: vi.fn(async () =>
                workspaceGrantPage(fixture)
              )
            }
          : null
      });
      const snapshot = await createTeamSnapshot(
        app,
        fixture.ids.alice,
        fixture.ids.teamA
      );
      const body = await readStreamUntil(app, {
        userId: fixture.ids.alice,
        teamId: fixture.ids.teamA,
        cursor: snapshot.cursor,
        eventName: wireEvent
      });

      if (wireEvent === "collaboration_event") {
        expect(eventData(body, wireEvent)).toMatchObject({
          type: family,
          update: { type: updateType }
        });
      } else {
        expect(eventData(body, wireEvent)).toMatchObject({
          subscription: { id: snapshot.subscription.id },
          reason:
            wireEvent === "access_revoked"
              ? "access_revoked"
              : "requires_snapshot"
        });
        expect(body).not.toContain(fixture.ids.workspace);
      }
    }
  );

  it("pushes one authorized Team Presence change to two subscribed clients", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(
      0,
      fixture.events.length,
      event({
        cursor: 1,
        scope: "team",
        teamId: fixture.ids.teamA,
        teamWorkspaceId: null,
        threadId: null,
        messageId: null,
        actorPrincipalId: fixture.ids.alice,
        resourceType: "team_member_presence",
        resourceId: fixture.ids.alice,
        family: "team_presence_changed"
      })
    );
    const getTeamRosterMember = vi.fn(async () => ({
      userId: fixture.ids.alice,
      displayName: "Alice",
      avatarReference: null,
      status: "enabled" as const,
      presenceMode: "manual" as const,
      manualPresenceStatus: "do_not_disturb" as const,
      presenceVersion: 2,
      lastHumanActivityAt: iso
    }));
    const device = createDeviceAuth(fixture, {
      active: true,
      operationFamilies: new Set(["team_workspace_read"])
    });
    const app = await buildTestServer(fixture, {
      auth: device.auth,
      heartbeatMs: 20,
      teamPresenceRepository: { getTeamRosterMember }
    });
    const headers = deviceHeaders();
    const [firstClientSnapshot, secondClientSnapshot] = await Promise.all([
      createTeamSnapshot(
        app,
        fixture.ids.alice,
        fixture.ids.teamA,
        undefined,
        headers
      ),
      createTeamSnapshot(
        app,
        fixture.ids.alice,
        fixture.ids.teamA,
        undefined,
        headers
      )
    ]);
    const [aliceBody, bobBody] = await Promise.all([
      readStreamUntil(app, {
        userId: fixture.ids.alice,
        teamId: fixture.ids.teamA,
        cursor: firstClientSnapshot.cursor,
        eventName: "collaboration_event",
        headers
      }),
      readStreamUntil(app, {
        userId: fixture.ids.alice,
        teamId: fixture.ids.teamA,
        cursor: secondClientSnapshot.cursor,
        eventName: "collaboration_event",
        headers
      })
    ]);

    for (const body of [aliceBody, bobBody]) {
      expect(eventData(body, "collaboration_event")).toMatchObject({
        type: "team_presence_changed",
        update: {
          type: "team_person_upserted",
          person: {
            id: fixture.ids.alice,
            presence: "away",
            teamPresence: {
              mode: "manual",
              manualStatus: "do_not_disturb",
              activityLevel: null,
              lastActivityAt: null,
              preferenceVersion: 2
            }
          }
        }
      });
    }
    expect(getTeamRosterMember).toHaveBeenCalledTimes(2);
    expect(getTeamRosterMember).toHaveBeenNthCalledWith(
      1,
      { userId: fixture.ids.alice },
      fixture.ids.teamA,
      fixture.ids.alice
    );
    await app.close();
  });

  it("removes only the revoked Shared Session and leaves the Team stream active", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(
      0,
      fixture.events.length,
      event({
        cursor: 1,
        scope: "team",
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspace,
        shareGrantId: fixture.ids.shareGrant,
        logicalMemoryId: fixture.ids.logicalMemory,
        messageId: null,
        family: "access_revoked",
        resourceType: "shared_memory_grant",
        resourceId: fixture.ids.shareGrant
      })
    );
    const app = await buildTestServer(fixture, { heartbeatMs: 20 });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor
    });
    try {
      const body = await stream.readUntil("collaboration_event");
      expect(eventData(body, "collaboration_event")).toMatchObject({
        update: {
          type: "shared_session_removed",
          sharedSessionId: fixture.ids.shareGrant
        }
      });
      expect(body).not.toContain("event: access_revoked\n");
    } finally {
      stream.close();
    }
  });

  it("signals requires_snapshot when retained replay is unavailable", async () => {
    const fixture = createRepositoryFixture();
    const app = await buildTestServer(fixture);
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    fixture.setRequiresSnapshotBelowCursor(1);
    const stream = await readStreamUntil(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor,
      eventName: "control"
    });
    expect(eventData(stream, "control")).toEqual({
      protocolVersion: COLLABORATION_CONTRACT_VERSION,
      subscription: { id: snapshot.subscription.id },
      reason: "requires_snapshot"
    });
  });

  it("reauthorizes each event after materialization and before serialization", async () => {
    const fixture = createRepositoryFixture();
    const originalMaterialize =
      fixture.materializationRepository.getMessageForRealtime.getMockImplementation();
    expect(originalMaterialize).toBeDefined();
    fixture.materializationRepository.getMessageForRealtime.mockImplementationOnce(
      async (...args) => {
        const message = await originalMaterialize!(...args);
        fixture.revokedTeams.add(fixture.ids.teamA);
        return message;
      }
    );
    const app = await buildTestServer(fixture);
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const body = await readStreamUntil(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor,
      eventName: "control"
    });

    expect(eventData(body, "control")).toEqual({
      protocolVersion: COLLABORATION_CONTRACT_VERSION,
      subscription: { id: snapshot.subscription.id },
      reason: "requires_snapshot"
    });
    expect(body).not.toContain("Authorized realtime message");
  });

  it("stops a multi-event, multi-batch replay before serializing any DTO after authorization loss", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(
      0,
      fixture.events.length,
      ...Array.from({ length: 5 }, (_, index) =>
        event({
          cursor: index + 1,
          scope: "team",
          teamId: fixture.ids.teamA,
          family: "message_created",
          actorPrincipalId: fixture.ids.alice,
          messageId: randomUUID()
        })
      )
    );
    const originalMaterialize =
      fixture.materializationRepository.getMessageForRealtime.getMockImplementation();
    expect(originalMaterialize).toBeDefined();
    let materializationCount = 0;
    fixture.materializationRepository.getMessageForRealtime.mockImplementation(
      async (...args) => {
        const message = await originalMaterialize!(...args);
        materializationCount += 1;
        if (materializationCount === 3) {
          fixture.revokedTeams.add(fixture.ids.teamA);
        }
        return message;
      }
    );
    const serializedProtectedEventIds: string[] = [];
    const protectedEventIds = new Set(
      fixture.events.map((candidate) => candidate.id)
    );
    const stringify = JSON.stringify.bind(JSON);
    const stringifySpy = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((value: unknown) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "eventId" in value &&
          typeof value.eventId === "string" &&
          protectedEventIds.has(value.eventId)
        ) {
          serializedProtectedEventIds.push(value.eventId);
        }
        return stringify(value);
      });
    let body: string;
    try {
      const app = await buildTestServer(fixture, { replayBatchSize: 2 });
      const snapshot = await createTeamSnapshot(
        app,
        fixture.ids.alice,
        fixture.ids.teamA
      );
      body = await readStreamUntil(app, {
        userId: fixture.ids.alice,
        teamId: fixture.ids.teamA,
        cursor: snapshot.cursor,
        eventName: "control"
      });
    } finally {
      stringifySpy.mockRestore();
    }

    expect(fixture.replayEvents).toHaveBeenCalledTimes(2);
    expect(materializationCount).toBe(3);
    expect([...new Set(serializedProtectedEventIds)]).toEqual(
      fixture.events.slice(0, 2).map((candidate) => candidate.id)
    );
    expect(body.match(/event: collaboration_event\n/g)).toHaveLength(2);
    for (const protectedEvent of fixture.events.slice(2)) {
      expect(body).not.toContain(protectedEvent.id);
    }
    expect(eventData(body, "control")).toMatchObject({
      reason: "requires_snapshot"
    });
  });

  it.each([100, 101])(
    "caps a configured replay batch of %i at 100 events",
    async (configuredBatchSize) => {
      const fixture = createRepositoryFixture();
      fixture.events.splice(
        0,
        fixture.events.length,
        ...Array.from({ length: 101 }, (_, index) =>
          event({
            cursor: index + 1,
            scope: "team",
            teamId: fixture.ids.teamA,
            family: "message_created",
            actorPrincipalId: fixture.ids.alice,
            messageId: randomUUID()
          })
        )
      );
      const app = await buildTestServer(fixture, {
        replayBatchSize: configuredBatchSize,
        maxUnacknowledgedEvents: 200,
        heartbeatMs: 20
      });
      const snapshot = await createTeamSnapshot(
        app,
        fixture.ids.alice,
        fixture.ids.teamA
      );
      const body = await readStreamUntil(app, {
        userId: fixture.ids.alice,
        teamId: fixture.ids.teamA,
        cursor: snapshot.cursor,
        eventName: "heartbeat"
      });

      expect(allEventData(body, "collaboration_event")).toHaveLength(101);
      expect(
        fixture.replayEvents.mock.calls.map(([, input]) => input.limit)
      ).toEqual([100, 100]);
    }
  );

  it("enforces bounded stream clients before opening SSE", async () => {
    const fixture = createRepositoryFixture();
    const app = await buildTestServer(fixture, { maxClients: 0 });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const response = await app.inject({
      method: "GET",
      url: `/v1/collaboration/realtime/stream?scope=team&teamId=${fixture.ids.teamA}&clientInstanceId=client-instance-0001&subscriptionKey=subscription-key-0001&cursor=${encodeURIComponent(snapshot.cursor)}`,
      headers: sessionHeaders(fixture.ids.alice)
    });
    expect(response.statusCode).toBe(429);
  });

  it("disconnects a slow consumer at the event bound and replays losslessly from its last acknowledgement", async () => {
    const exactFixture = createRepositoryFixture();
    exactFixture.events.splice(
      0,
      exactFixture.events.length,
      ...Array.from({ length: 3 }, (_, index) =>
        event({
          cursor: index + 1,
          scope: "team",
          teamId: exactFixture.ids.teamA,
          family: "message_created",
          actorPrincipalId: exactFixture.ids.alice,
          messageId: randomUUID()
        })
      )
    );
    const exactApp = await buildTestServer(exactFixture, {
      maxUnacknowledgedEvents: 3,
      heartbeatMs: 20
    });
    const exactSnapshot = await createTeamSnapshot(
      exactApp,
      exactFixture.ids.alice,
      exactFixture.ids.teamA
    );
    const exactStream = await openTeamStream(exactApp, {
      userId: exactFixture.ids.alice,
      teamId: exactFixture.ids.teamA,
      cursor: exactSnapshot.cursor
    });
    try {
      const exactBody = await exactStream.readUntil("heartbeat");
      expect(allEventData(exactBody, "collaboration_event")).toHaveLength(3);
      expect(exactBody).not.toContain('reason":"backpressure');
      await exactStream.expectOpenFor(25);
    } finally {
      exactStream.close();
    }

    const fixture = createRepositoryFixture();
    fixture.events.splice(
      0,
      fixture.events.length,
      ...Array.from({ length: 4 }, (_, index) =>
        event({
          cursor: index + 1,
          scope: "team",
          teamId: fixture.ids.teamA,
          family: "message_created",
          actorPrincipalId: fixture.ids.alice,
          messageId: randomUUID()
        })
      )
    );
    const app = await buildTestServer(fixture, {
      maxUnacknowledgedEvents: 3,
      heartbeatMs: 20
    });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const firstBody = await readStreamUntil(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor,
      eventName: "control"
    });
    const firstDeliveries = allEventData<{
      eventId: string;
      cursor: string;
    }>(firstBody, "collaboration_event");

    expect(firstDeliveries.map(({ eventId }) => eventId)).toEqual(
      fixture.events.slice(0, 3).map(({ id }) => id)
    );
    expect(eventData(firstBody, "control")).toEqual({
      protocolVersion: COLLABORATION_CONTRACT_VERSION,
      subscription: { id: snapshot.subscription.id },
      reason: "backpressure"
    });

    const acknowledged = firstDeliveries[1]!;
    const ack = await app.inject({
      method: "POST",
      url: "/v1/collaboration/realtime/ack",
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        subscriptionId: snapshot.subscription.id,
        eventId: acknowledged.eventId,
        cursor: acknowledged.cursor,
        clientInstanceId: "client-instance-0001",
        subscriptionKey: "subscription-key-0001"
      }
    });
    expect(ack.statusCode).toBe(200);

    const recovered = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: acknowledged.cursor
    });
    try {
      const recoveredBody = await recovered.readUntil("heartbeat");
      const recoveredDeliveries = allEventData<{ eventId: string }>(
        recoveredBody,
        "collaboration_event"
      );
      expect(recoveredDeliveries.map(({ eventId }) => eventId)).toEqual(
        fixture.events.slice(2).map(({ id }) => id)
      );
      expect(recoveredBody).not.toContain('reason":"backpressure');
      await recovered.expectOpenFor(25);
    } finally {
      recovered.close();
    }
  });

  it("admits the exact byte buffer and rejects the first event that would exceed it", async () => {
    const singleEventFixture = () => {
      const fixture = createRepositoryFixture();
      fixture.events.splice(
        0,
        fixture.events.length,
        event({
          cursor: 1,
          scope: "team",
          teamId: fixture.ids.teamA,
          actorPrincipalId: fixture.ids.alice
        })
      );
      return fixture;
    };

    const sizingFixture = singleEventFixture();
    const sizingApp = await buildTestServer(sizingFixture, { heartbeatMs: 20 });
    const sizingSnapshot = await createTeamSnapshot(
      sizingApp,
      sizingFixture.ids.alice,
      sizingFixture.ids.teamA
    );
    const sizingBody = await readStreamUntil(sizingApp, {
      userId: sizingFixture.ids.alice,
      teamId: sizingFixture.ids.teamA,
      cursor: sizingSnapshot.cursor,
      eventName: "heartbeat"
    });
    const serializedEvent = JSON.stringify(
      allEventData(sizingBody, "collaboration_event")[0]
    );
    expect(serializedEvent).toBeDefined();
    const serializedEventBytes = Buffer.byteLength(serializedEvent!, "utf8");

    const exactFixture = singleEventFixture();
    const exactApp = await buildTestServer(exactFixture, {
      maxUnacknowledgedBytes: serializedEventBytes,
      heartbeatMs: 20
    });
    const exactSnapshot = await createTeamSnapshot(
      exactApp,
      exactFixture.ids.alice,
      exactFixture.ids.teamA
    );
    const exactStream = await openTeamStream(exactApp, {
      userId: exactFixture.ids.alice,
      teamId: exactFixture.ids.teamA,
      cursor: exactSnapshot.cursor
    });
    try {
      const exactBody = await exactStream.readUntil("heartbeat");
      expect(allEventData(exactBody, "collaboration_event")).toHaveLength(1);
      expect(exactBody).not.toContain('reason":"backpressure');
      await exactStream.expectOpenFor(25);
    } finally {
      exactStream.close();
    }

    const overFixture = singleEventFixture();
    overFixture.events.push(
      event({
        cursor: 2,
        scope: "team",
        teamId: overFixture.ids.teamA,
        actorPrincipalId: overFixture.ids.alice
      })
    );
    const overApp = await buildTestServer(overFixture, {
      maxUnacknowledgedBytes: serializedEventBytes,
      heartbeatMs: 20
    });
    const overSnapshot = await createTeamSnapshot(
      overApp,
      overFixture.ids.alice,
      overFixture.ids.teamA
    );
    const overBody = await readStreamUntil(overApp, {
      userId: overFixture.ids.alice,
      teamId: overFixture.ids.teamA,
      cursor: overSnapshot.cursor,
      eventName: "control"
    });
    expect(allEventData(overBody, "collaboration_event")).toHaveLength(1);
    expect(eventData(overBody, "control")).toMatchObject({
      subscription: { id: overSnapshot.subscription.id },
      reason: "backpressure"
    });
  });

  it("keeps the stream open at the acknowledgement deadline and closes one millisecond over", async () => {
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fixture = createRepositoryFixture();
    fixture.events.splice(
      0,
      fixture.events.length,
      event({
        cursor: 1,
        scope: "team",
        teamId: fixture.ids.teamA,
        actorPrincipalId: fixture.ids.alice
      })
    );
    const app = await buildTestServer(fixture, {
      ackDeadlineMs: 10,
      heartbeatMs: 50
    });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor
    });
    try {
      await stream.readUntil("collaboration_event");
      now += 10;
      const exactBody = await stream.readUntil("heartbeat");
      expect(exactBody).not.toContain('reason":"backpressure');

      now += 1;
      const overBody = await stream.readUntil("control");
      expect(eventData(overBody, "control")).toMatchObject({
        subscription: { id: snapshot.subscription.id },
        reason: "backpressure"
      });
    } finally {
      stream.close();
      nowSpy.mockRestore();
    }
  });

  it("reauthorizes recovery and denies revoked Team access", async () => {
    const fixture = createRepositoryFixture();
    const app = await buildTestServer(fixture);
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    fixture.revokedTeams.add(fixture.ids.teamA);

    const response = await app.inject({
      method: "GET",
      url: `/v1/collaboration/realtime/stream?scope=team&teamId=${fixture.ids.teamA}&clientInstanceId=client-instance-0001&subscriptionKey=subscription-key-0001&cursor=${encodeURIComponent(snapshot.cursor)}`,
      headers: sessionHeaders(fixture.ids.alice)
    });
    expect(response.statusCode).toBe(403);
  });

  it("independently revokes an idle memoized device credential within the authorization bound", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(0);
    const deviceState = {
      active: true,
      operationFamilies: new Set(["team_workspace_read"])
    };
    const device = createDeviceAuth(fixture, deviceState);
    const app = await buildTestServer(fixture, {
      auth: device.auth,
      heartbeatMs: 10_000,
      authorizationRecheckMs: 30
    });
    const headers = deviceHeaders();
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA,
      undefined,
      headers
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor,
      headers
    });
    try {
      await stream.readUntil("ready");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const revokedAt = Date.now();
      deviceState.active = false;
      const body = await stream.readUntil("access_revoked", 500);

      expect(Date.now() - revokedAt).toBeLessThan(250);
      expect(eventData(body, "access_revoked")).toEqual({
        protocolVersion: COLLABORATION_CONTRACT_VERSION,
        subscription: { id: snapshot.subscription.id },
        reason: "access_revoked"
      });
      expect(
        device.resolveDeviceCredentialContext.mock.calls.length
      ).toBeGreaterThan(3);
    } finally {
      stream.close();
    }
  });

  it("revokes an idle browser session independently of Team membership", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(0);
    let sessionActive = true;
    const authenticateSessionOrDeviceCredential = vi.fn(
      async (request: FastifyRequest) => {
        const user = fixture.users.get(request.cookies.cm_session ?? "");
        if (!sessionActive || !user) {
          throw Object.assign(new Error("Session is no longer active"), {
            statusCode: 401
          });
        }
        return user;
      }
    );
    const app = await buildTestServer(fixture, {
      auth: {
        authenticateSessionOrDeviceCredential,
        resolveDeviceCredentialContext: async () => null
      },
      heartbeatMs: 10_000,
      authorizationRecheckMs: 25
    });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor
    });
    try {
      await stream.readUntil("ready");
      sessionActive = false;
      const body = await stream.readUntil("access_revoked", 500);

      expect(eventData(body, "access_revoked")).toEqual({
        protocolVersion: COLLABORATION_CONTRACT_VERSION,
        subscription: { id: snapshot.subscription.id },
        reason: "access_revoked"
      });
      expect(fixture.revokedTeams).toEqual(new Set());
      expect(
        authenticateSessionOrDeviceCredential.mock.calls.length
      ).toBeGreaterThan(2);
    } finally {
      stream.close();
    }
  });

  it.each([
    "message_created",
    "share_grant_lifecycle",
    "shared_session_discussion_activity",
    "team_lifecycle"
  ] as const)(
    "does not deliver %s events to a team_workspace_read-only device",
    async (family) => {
      const fixture = createRepositoryFixture();
      fixture.events.splice(
        0,
        fixture.events.length,
        event({ cursor: 1, scope: "team", teamId: fixture.ids.teamA, family })
      );
      const device = createDeviceAuth(fixture, {
        active: true,
        operationFamilies: new Set(["team_workspace_read"])
      });
      const app = await buildTestServer(fixture, {
        auth: device.auth,
        heartbeatMs: 20,
        authorizationRecheckMs: 500
      });
      const headers = deviceHeaders();
      const snapshot = await createTeamSnapshot(
        app,
        fixture.ids.alice,
        fixture.ids.teamA,
        undefined,
        headers
      );
      const stream = await openTeamStream(app, {
        userId: fixture.ids.alice,
        teamId: fixture.ids.teamA,
        cursor: snapshot.cursor,
        headers
      });
      try {
        const body = await stream.readUntil("heartbeat");
        expect(body).not.toContain("event: collaboration_event\n");
      } finally {
        stream.close();
      }
    }
  );

  it("immediately requires an authoritative snapshot when open Workspace access is revoked", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(0);
    const pool = createListenerPool();
    const device = createDeviceAuth(fixture, {
      active: true,
      operationFamilies: new Set(["team_workspace_read"])
    });
    const app = await buildTestServer(fixture, {
      auth: device.auth,
      pool,
      heartbeatMs: 10_000
    });
    const headers = deviceHeaders();
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA,
      undefined,
      headers
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor,
      headers
    });
    try {
      await stream.readUntil("ready");
      fixture.events.push(
        event({
          cursor: 1,
          scope: "team",
          teamId: fixture.ids.teamA,
          teamWorkspaceId: fixture.ids.workspace,
          family: "workspace_lifecycle_access",
          resourceType: "team_workspace_access",
          resourceId: fixture.ids.workspace
        })
      );
      pool.listeners[0]!.notification?.({
        channel: "koed_collaboration_realtime",
        payload: JSON.stringify({ scope: "team", teamId: fixture.ids.teamA })
      });
      const body = await stream.readUntil("control", 500);

      expect(eventData(body, "control")).toEqual({
        protocolVersion: COLLABORATION_CONTRACT_VERSION,
        subscription: { id: snapshot.subscription.id },
        reason: "requires_snapshot"
      });
      expect(body).not.toContain(fixture.ids.workspace);
    } finally {
      stream.close();
    }
  });

  it.each([["message_created", ["team_chat_read"]]] as const)(
    "delivers %s events only when the device has its explicit family",
    async (family, requiredFamilies) => {
      const fixture = createRepositoryFixture();
      fixture.events.splice(
        0,
        fixture.events.length,
        event({
          cursor: 1,
          scope: "team",
          teamId: fixture.ids.teamA,
          family,
          actorPrincipalId: fixture.ids.alice
        })
      );
      const device = createDeviceAuth(fixture, {
        active: true,
        operationFamilies: new Set(["team_workspace_read", ...requiredFamilies])
      });
      const app = await buildTestServer(fixture, { auth: device.auth });
      const headers = deviceHeaders();
      const snapshot = await createTeamSnapshot(
        app,
        fixture.ids.alice,
        fixture.ids.teamA,
        undefined,
        headers
      );
      const body = await readStreamUntil(app, {
        userId: fixture.ids.alice,
        teamId: fixture.ids.teamA,
        cursor: snapshot.cursor,
        headers,
        eventName: "collaboration_event"
      });

      expect(body).toContain(`"type":"${family}"`);
    }
  );

  it("detects Team Membership revocation when the advisory notification is dropped", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(0);
    const app = await buildTestServer(fixture, {
      heartbeatMs: 10_000,
      authorizationRecheckMs: 25
    });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor
    });
    try {
      await stream.readUntil("ready");
      fixture.revokedMemberships.add(
        `${fixture.ids.alice}:${fixture.ids.teamA}`
      );
      const body = await stream.readUntil("access_revoked", 500);

      expect(eventData(body, "access_revoked")).toEqual({
        protocolVersion: COLLABORATION_CONTRACT_VERSION,
        subscription: { id: snapshot.subscription.id },
        reason: "access_revoked"
      });
    } finally {
      stream.close();
    }
  });

  it("replays Share Grant revocation when the advisory notification is dropped", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(0);
    const app = await buildTestServer(fixture, {
      heartbeatMs: 10_000,
      authorizationRecheckMs: 25
    });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor
    });
    try {
      await stream.readUntil("ready");
      const revokedAt = Date.now();
      fixture.events.push(
        event({
          cursor: 1,
          scope: "team",
          teamId: fixture.ids.teamA,
          teamWorkspaceId: fixture.ids.workspace,
          shareGrantId: fixture.ids.shareGrant,
          logicalMemoryId: fixture.ids.logicalMemory,
          messageId: null,
          family: "access_revoked",
          resourceType: "shared_memory_grant",
          resourceId: fixture.ids.shareGrant
        })
      );
      const body = await stream.readUntil("collaboration_event", 500);

      expect(Date.now() - revokedAt).toBeLessThan(250);
      expect(eventData(body, "collaboration_event")).toMatchObject({
        update: {
          type: "shared_session_removed",
          sharedSessionId: fixture.ids.shareGrant
        }
      });
      expect(body).not.toContain("event: access_revoked\n");
      await stream.expectOpenFor(30);
    } finally {
      stream.close();
    }
  });

  it("reauthorizes immediately when the PostgreSQL listener is interrupted", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(0);
    const pool = createListenerPool();
    const app = await buildTestServer(fixture, {
      pool,
      heartbeatMs: 10_000,
      authorizationRecheckMs: 5_000,
      listenerReconnectBaseMs: 5,
      listenerReconnectMaxMs: 5,
      listenerReconnectJitter: 0
    });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor
    });
    try {
      await stream.readUntil("ready");
      fixture.revokedTeams.add(fixture.ids.teamA);
      pool.listeners[0]!.error?.(new Error("listener interrupted"));
      const body = await stream.readUntil("access_revoked", 500);
      await new Promise((resolve) => setTimeout(resolve, 15));

      expect(eventData(body, "access_revoked")).toEqual({
        protocolVersion: COLLABORATION_CONTRACT_VERSION,
        subscription: { id: snapshot.subscription.id },
        reason: "access_revoked"
      });
      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(pool.listeners[1]?.query).toHaveBeenCalledWith(
        "LISTEN koed_collaboration_realtime"
      );
    } finally {
      stream.close();
    }
  });

  it("does not poll the outbox from heartbeats and replays it after listener restart", async () => {
    const fixture = createRepositoryFixture();
    fixture.events.splice(0);
    const pool = createListenerPool();
    const app = await buildTestServer(fixture, {
      pool,
      heartbeatMs: 10,
      authorizationRecheckMs: 500,
      listenerReconnectBaseMs: 5,
      listenerReconnectMaxMs: 5,
      listenerReconnectJitter: 0
    });
    const snapshot = await createTeamSnapshot(
      app,
      fixture.ids.alice,
      fixture.ids.teamA
    );
    const stream = await openTeamStream(app, {
      userId: fixture.ids.alice,
      teamId: fixture.ids.teamA,
      cursor: snapshot.cursor
    });
    try {
      await stream.readUntil("heartbeat");
      await new Promise((resolve) => setTimeout(resolve, 45));
      expect(fixture.replayEvents).toHaveBeenCalledTimes(1);

      fixture.events.push(
        event({
          cursor: 1,
          scope: "team",
          teamId: fixture.ids.teamA,
          actorPrincipalId: fixture.ids.alice
        })
      );
      pool.listeners[0]!.error?.(new Error("listener interrupted"));
      const body = await stream.readUntil("collaboration_event", 500);

      expect(body).toContain('"type":"message_created"');
      expect(fixture.replayEvents).toHaveBeenCalledTimes(2);
      expect(pool.connect).toHaveBeenCalledTimes(2);
    } finally {
      stream.close();
    }
  });

  it("backs off and reconnects the PostgreSQL listener after transient failures", async () => {
    vi.useFakeTimers();
    const fixture = createRepositoryFixture();
    const app = Fastify({ logger: false });
    const listener = {
      query: vi.fn(async () => undefined),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      release: vi.fn()
    };
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("first transient failure"))
      .mockRejectedValueOnce(new Error("second transient failure"))
      .mockResolvedValue(listener);
    try {
      const service = await createCollaborationRealtimeService({
        app,
        auth: {
          authenticateSessionOrDeviceCredential: async () =>
            fixture.users.get(fixture.ids.alice)!,
          resolveDeviceCredentialContext: async () => null
        },
        repository: fixture.repository,
        materializationRepository: fixture.materializationRepository,
        sharedMemoryRepository: null,
        pool: { connect },
        corsOrigins: new Set(),
        backendIdentity,
        cursorSecret,
        listenerReconnectBaseMs: 10,
        listenerReconnectMaxMs: 100,
        listenerReconnectJitter: 0.2,
        listenerStableResetMs: 1_000,
        random: () => 0.5
      });
      expect(connect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(connect).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20);
      expect(connect).toHaveBeenCalledTimes(3);
      expect(listener.query).toHaveBeenCalledWith(
        "LISTEN koed_collaboration_realtime"
      );
      service.close();
      expect(listener.release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
});
