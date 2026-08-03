import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
  AuthorizedCollaborationSnapshotRecord,
  CollaborationOutboxEventRecord,
  CollaborationRepository,
  CollaborationSubscriptionRecord,
  DbPool
} from "@koed/db";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationRendererEventSchema,
  type CollaborationRendererEvent
} from "@koed/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateCollaborationReconnectDelay,
  createCollaborationRealtimeBroker,
  type CollaborationRealtimeBrokerOptions,
  type CollaborationRealtimeBrokerService
} from "./collaboration-realtime-broker.js";
import type { PersonalRealtimeMaterializationRepository } from "../collaboration/realtime.js";

const teamA = "11111111-1111-4111-8111-111111111111";
const teamB = "22222222-2222-4222-8222-222222222222";
const remoteSubscriptionId = "33333333-3333-4333-8333-333333333333";
const eventA = "44444444-4444-4444-8444-444444444444";
const eventB = "55555555-5555-4555-8555-555555555555";
const snapshotCursor = `crt1.${"a".repeat(40)}`;
const eventCursorA = `crt1.${"b".repeat(40)}`;
const eventCursorB = `crt1.${"c".repeat(40)}`;
const brokerSecret = "test-local-collaboration-broker-secret-0001";
const desktopOwnerUserId = "77777777-7777-4777-8777-777777777777";
const remotePrincipalA = "99999999-9999-4999-8999-999999999999";
const remotePrincipalB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sharedSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const logicalMemoryId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const threadId = "66666666-6666-4666-8666-666666666666";
const desktopAuthorization =
  "Koed-Desktop koed_desktop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const localEdgeAuthorizationA = "Koed-Device local-a:local-secret-a";
const localEdgeAuthorizationB = "Koed-Device local-b:local-secret-b";
const remotePrincipalStatusPath = "/v1/local-edge/device-credentials/status";

interface MemoryRow {
  id: string;
  scope: "personal" | "team";
  upstreamBackendId: string;
  credentialBindingHash: string;
  teamId: string | null;
  protocolVersion: number;
  remoteSubscriptionId: string;
  remoteCursor: string;
  lastAcknowledgedEventId: string | null;
  state: "active" | "requires_snapshot" | "revoked" | "expired";
  version: number;
  createdAt: Date;
  updatedAt: Date;
  lastConnectedAt: Date | null;
  lastAcknowledgedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

class MemoryPool {
  rows: MemoryRow[] = [];
  listenCount = 0;
  private readonly notificationListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  notify() {
    for (const listener of this.notificationListeners) listener();
  }

  interrupt(error: Error) {
    for (const listener of this.errorListeners) listener(error);
  }

  errorListenerCount() {
    return this.errorListeners.size;
  }

  async connect() {
    return {
      query: this.query.bind(this),
      on: (
        event: string,
        listener: (() => void) | ((error: Error) => void)
      ) => {
        if (event === "notification") {
          this.notificationListeners.add(listener as () => void);
        }
        if (event === "error") {
          this.errorListeners.add(listener as (error: Error) => void);
        }
      },
      off: (
        event: string,
        listener: (() => void) | ((error: Error) => void)
      ) => {
        if (event === "notification") {
          this.notificationListeners.delete(listener as () => void);
        }
        if (event === "error") {
          this.errorListeners.delete(listener as (error: Error) => void);
        }
      },
      release: vi.fn()
    };
  }

  async query<T = unknown>(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (
      normalized === "begin" ||
      normalized === "commit" ||
      normalized === "rollback" ||
      normalized.startsWith("select pg_advisory_xact_lock")
    ) {
      return { rows: [] as T[] };
    }
    if (normalized.startsWith("listen ")) {
      this.listenCount += 1;
      return { rows: [] as T[] };
    }
    if (
      normalized.startsWith(
        "insert into local_edge_collaboration_subscriptions"
      )
    ) {
      const now = new Date("2026-07-17T00:00:00.000Z");
      const row: MemoryRow = {
        id: values[0] as string,
        scope: values[1] as "personal" | "team",
        upstreamBackendId: values[2] as string,
        credentialBindingHash: values[3] as string,
        teamId: (values[4] as string | null) ?? null,
        protocolVersion: values[5] as number,
        remoteSubscriptionId: values[6] as string,
        remoteCursor: values[7] as string,
        lastAcknowledgedEventId: null,
        state: normalized.includes("'requires_snapshot'")
          ? "requires_snapshot"
          : "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
        lastConnectedAt: null,
        lastAcknowledgedAt: null,
        expiresAt: values[8] as Date,
        revokedAt: null
      };
      this.rows.push(row);
      return { rows: [row as T] };
    }
    if (
      normalized.startsWith("select") &&
      normalized.includes("where id = $1")
    ) {
      const row = this.rows.find(
        (candidate) =>
          candidate.id === values[0] &&
          candidate.upstreamBackendId === values[1] &&
          candidate.credentialBindingHash === values[2] &&
          candidate.scope === values[3] &&
          candidate.teamId === values[4] &&
          candidate.protocolVersion === values[5]
      );
      return { rows: row ? [row as T] : [] };
    }
    if (
      normalized.startsWith("select") &&
      normalized.includes("where upstream_backend_id = $1")
    ) {
      const row = this.rows.find(
        (candidate) =>
          candidate.upstreamBackendId === values[0] &&
          candidate.credentialBindingHash === values[1] &&
          candidate.scope === values[2] &&
          candidate.teamId === values[3] &&
          candidate.protocolVersion === values[4]
      );
      return { rows: row ? [row as T] : [] };
    }
    if (
      normalized.startsWith("update local_edge_collaboration_subscriptions") &&
      normalized.includes("set remote_subscription_id = $2")
    ) {
      const row = this.rows.find(
        (candidate) =>
          candidate.id === values[0] && candidate.version === values[4]
      );
      if (!row) return { rows: [] as T[] };
      row.remoteSubscriptionId = values[1] as string;
      row.remoteCursor = values[2] as string;
      row.expiresAt = values[3] as Date;
      row.lastAcknowledgedEventId = null;
      row.state = normalized.includes("state = 'requires_snapshot'")
        ? "requires_snapshot"
        : "active";
      row.revokedAt = null;
      row.version += 1;
      row.updatedAt = new Date();
      return { rows: [row as T] };
    }
    if (
      normalized.startsWith("update local_edge_collaboration_subscriptions") &&
      normalized.includes("set remote_cursor = $2")
    ) {
      const row = this.rows.find(
        (candidate) =>
          candidate.id === values[0] && candidate.version === values[3]
      );
      if (!row) return { rows: [] as T[] };
      row.remoteCursor = values[1] as string;
      row.lastAcknowledgedEventId = values[2] as string;
      row.lastAcknowledgedAt = new Date();
      row.updatedAt = new Date();
      row.version += 1;
      return { rows: [row as T] };
    }
    if (
      normalized.startsWith("update local_edge_collaboration_subscriptions") &&
      normalized.includes("set state = $2::collaboration_stream_state")
    ) {
      const row = this.rows.find(
        (candidate) =>
          candidate.id === values[0] && candidate.version === values[2]
      );
      if (!row) return { rows: [] as T[] };
      row.state = values[1] as MemoryRow["state"];
      row.version += 1;
      row.updatedAt = new Date();
      if (row.state === "revoked") row.revokedAt = new Date();
      return { rows: [row as T] };
    }
    if (
      normalized.startsWith("update local_edge_collaboration_subscriptions") &&
      normalized.includes("set last_connected_at = now()")
    ) {
      const row = this.rows.find(
        (candidate) =>
          candidate.id === values[0] && candidate.version === values[1]
      );
      if (!row) return { rows: [] as T[] };
      row.lastConnectedAt = new Date();
      row.updatedAt = new Date();
      return { rows: [row as T] };
    }
    if (
      normalized.startsWith(
        "delete from local_edge_collaboration_subscriptions"
      ) &&
      normalized.includes("where upstream_backend_id = $1")
    ) {
      const rows = this.rows.filter(
        (candidate) => candidate.upstreamBackendId === values[0]
      );
      this.rows = this.rows.filter(
        (candidate) => candidate.upstreamBackendId !== values[0]
      );
      return { rows: rows.map((row) => ({ id: row.id }) as T) };
    }
    if (
      normalized.startsWith("update local_edge_collaboration_subscriptions") &&
      normalized.includes("credential_binding_hash <> $5")
    ) {
      const rows = this.rows.filter(
        (candidate) =>
          candidate.upstreamBackendId === values[0] &&
          candidate.scope === values[1] &&
          candidate.teamId === values[2] &&
          candidate.protocolVersion === values[3] &&
          candidate.credentialBindingHash !== values[4] &&
          (candidate.state === "active" ||
            candidate.state === "requires_snapshot")
      );
      for (const row of rows) {
        row.state = "expired";
        row.version += 1;
        row.updatedAt = new Date();
      }
      return { rows: [] as T[] };
    }
    if (
      normalized.startsWith("update local_edge_collaboration_subscriptions") &&
      normalized.includes("set state = 'expired'")
    ) {
      const row = this.rows.find(
        (candidate) =>
          candidate.id === values[0] &&
          candidate.upstreamBackendId === values[1] &&
          candidate.credentialBindingHash === values[2] &&
          candidate.scope === values[3] &&
          candidate.teamId === values[4] &&
          candidate.protocolVersion === values[5] &&
          candidate.version === values[6]
      );
      if (!row) return { rows: [] as T[] };
      row.state = "expired";
      row.version += 1;
      row.updatedAt = new Date();
      return { rows: [row as T] };
    }
    throw new Error(`Unhandled test SQL: ${normalized}`);
  }
}

class MemoryCollaborationRepository {
  snapshot: AuthorizedCollaborationSnapshotRecord = {
    scope: "personal",
    personalOwnerUserId: desktopOwnerUserId,
    teamId: null,
    highWaterCursor: 12,
    threads: []
  };

  subscription: CollaborationSubscriptionRecord | null = null;
  events: CollaborationOutboxEventRecord[] = [];
  personalMemorySummary = {
    sessionId: sharedSessionId,
    logicalMemoryId,
    title: "Realtime Personal Memory",
    projectName: "Koed",
    updatedAt: "2026-07-17T00:01:00.000Z",
    eventCount: 4,
    hasSynchronizedRevision: true,
    syncState: "ready" as const
  };
  personalMemoryAvailable = true;
  managedConversationExecution = {
    id: "77777777-7777-4777-8777-777777777777",
    ownerUserId: desktopOwnerUserId,
    projectId: "lp_879b5bd75537e69064a8a01eb501ec16",
    provider: "codex" as const,
    state: "running" as const,
    stateVersion: 2,
    executionGeneration: 1,
    runnerDeploymentId: null,
    runnerDeviceId: null,
    runnerId: null,
    runnerLeaseExpiresAt: null,
    logicalSessionId: "66666666-6666-4666-8666-666666666666",
    providerThreadId: "provider-thread-1",
    providerCliVersion: "0.145.0",
    sourceGenerationId: null,
    lastErrorCode: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:01:00.000Z",
    startedAt: "2026-07-17T00:00:01.000Z",
    quiescedAt: null,
    stoppedAt: null
  };
  managedConversationRuntimeBinding = {
    executionId: "77777777-7777-4777-8777-777777777777",
    ownerUserId: desktopOwnerUserId,
    deploymentId: "55555555-5555-4555-8555-555555555555",
    deviceId: "44444444-4444-4444-8444-444444444444",
    executionGeneration: 1,
    projectPath: "/workspace/koed",
    localSessionId: "33333333-3333-4333-8333-333333333333",
    providerThreadId: "provider-thread-1",
    transcriptPath: "/tmp/provider-thread-1.jsonl",
    managedHome: "/tmp/managed",
    providerCliVersion: "0.145.0",
    sourceGenerationId: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:01:00.000Z"
  };
  acknowledged: Array<{ eventId: string; cursor: number }> = [];
  revoked = false;
  afterReplayRead:
    | ((
        input: { afterCursor: number },
        events: CollaborationOutboxEventRecord[]
      ) => void | Promise<void>)
    | null = null;

  async getAuthorizedSnapshot(
    actor: { userId: string },
    input: { scope: "personal" } | { scope: "team"; teamId: string }
  ) {
    if (input.scope !== "personal" || actor.userId !== desktopOwnerUserId) {
      return null;
    }
    return this.snapshot;
  }

  async createSubscription(actor: { userId: string }) {
    if (actor.userId !== desktopOwnerUserId) return null;
    this.subscription = {
      id: "88888888-8888-4888-8888-888888888888",
      protocolVersion: COLLABORATION_CONTRACT_VERSION,
      scope: "personal",
      personalOwnerUserId: desktopOwnerUserId,
      teamId: null,
      state: "active",
      snapshotHighWaterCursor: this.snapshot.highWaterCursor,
      acknowledgedEventId: null,
      acknowledgedCursor: 0,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      lastAcknowledgedAt: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null
    };
    return this.subscription;
  }

  async recoverSubscription(actor: { userId: string }) {
    if (actor.userId !== desktopOwnerUserId || !this.subscription) {
      return null;
    }
    return { subscription: this.subscription, requiresSnapshot: false };
  }

  async replayEvents(
    actor: { userId: string },
    input: { scope: "personal"; afterCursor: number; limit?: number }
  ) {
    if (actor.userId !== desktopOwnerUserId || input.scope !== "personal") {
      return null;
    }
    const limit = input.limit ?? 100;
    const available = this.events.filter(
      (event) => event.cursor > input.afterCursor
    );
    const events = available.slice(0, limit);
    const hasMore = available.length > events.length;
    await this.afterReplayRead?.(input, events);
    return {
      afterCursor: input.afterCursor,
      events,
      hasMore
    };
  }

  async acknowledgeSubscription(
    actor: { userId: string },
    input: { subscriptionId: string; eventId: string; cursor: number }
  ) {
    if (
      actor.userId !== desktopOwnerUserId ||
      !this.subscription ||
      input.subscriptionId !== this.subscription.id
    ) {
      return null;
    }
    this.acknowledged.push({ eventId: input.eventId, cursor: input.cursor });
    this.subscription = {
      ...this.subscription,
      acknowledgedEventId: input.eventId,
      acknowledgedCursor: input.cursor,
      lastAcknowledgedAt: "2026-07-17T00:02:00.000Z"
    };
    return this.subscription;
  }

  async getPersonalMemoryForRealtime(
    actor: { userId: string },
    input: { sessionId: string }
  ) {
    if (
      actor.userId !== desktopOwnerUserId ||
      !this.personalMemoryAvailable ||
      input.sessionId !== this.personalMemorySummary.sessionId
    ) {
      return null;
    }
    return this.personalMemorySummary;
  }

  async getManagedConversationExecution(
    actor: { userId: string },
    executionId: string
  ) {
    return actor.userId === desktopOwnerUserId &&
      executionId === this.managedConversationExecution.id
      ? this.managedConversationExecution
      : null;
  }

  async getManagedConversationRuntimeBinding(
    actor: { userId: string },
    executionId: string
  ) {
    return actor.userId === desktopOwnerUserId &&
      executionId === this.managedConversationRuntimeBinding.executionId
      ? this.managedConversationRuntimeBinding
      : null;
  }

  async revokeSubscriptions() {
    this.revoked = true;
    return { revokedCount: 1 };
  }
}

interface RemoteCall {
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

interface Harness {
  app: FastifyInstance;
  service: CollaborationRealtimeBrokerService;
  pool: MemoryPool;
  repository: MemoryCollaborationRepository;
  calls: RemoteCall[];
  quarantineCrossIdentitySyncForBackend: ReturnType<typeof vi.fn>;
  revokeSharedMemoryAuthorityForBackend: ReturnType<typeof vi.fn>;
  directory: string;
  setActiveLocalOwner(active: boolean): void;
  setRemotePrincipal(principalId: string): void;
  setRemotePrincipalStatus(status: number): void;
  baseUrl(): Promise<string>;
}

interface HarnessOptions {
  remotePersonal?: boolean;
  stream?: (init?: RequestInit) => Response;
  ackStatus?: number;
  afterRemoteAck?: () => Promise<void>;
  maxPendingEvents?: number;
  maxPendingBytes?: number;
  maxConnections?: number;
  ackDeadlineMs?: number;
  maxReconnectAttempts?: number;
  reconnectWindowMs?: number;
  reconnectStableResetMs?: number;
  reconnectUnavailableCooldownMs?: number;
  sleep?: CollaborationRealtimeBrokerOptions["sleep"];
  now?: CollaborationRealtimeBrokerOptions["now"];
  capabilitySchemaVersion?: number;
  realtimeProtocolVersion?: number;
  upstreamAuthorizationAvailable?: boolean;
  localEdgeCredentialAvailable?: boolean;
  activeLocalOwner?: boolean;
  remotePrincipalId?: string;
  remotePrincipalStatus?: number;
  pool?: MemoryPool;
  repository?: MemoryCollaborationRepository;
  quarantineCrossIdentitySyncForBackend?: (
    ownerUserId: string,
    upstreamBackendId: string
  ) => Promise<void>;
  revokeSharedMemoryAuthorityForBackend?: (
    ownerUserId: string,
    upstreamBackendId: string
  ) => Promise<void>;
  onRemoteNavigationInvalidated?: (backendId: string) => void;
}

const snapshotResponse = (teamId: string) => ({
  protocolVersion: COLLABORATION_CONTRACT_VERSION,
  subscription: {
    id: remoteSubscriptionId,
    protocolVersion: COLLABORATION_CONTRACT_VERSION,
    scope: "team",
    personalOwnerUserId: null,
    teamId,
    state: "active",
    snapshotHighWaterCursor: 0,
    acknowledgedEventId: null,
    acknowledgedCursor: 0,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    lastAcknowledgedAt: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null
  },
  snapshot: {
    scope: "team",
    personalOwnerUserId: null,
    teamId,
    highWaterCursor: snapshotCursor,
    threads: []
  },
  cursor: snapshotCursor
});

const personalSnapshotResponse = () => ({
  protocolVersion: COLLABORATION_CONTRACT_VERSION,
  subscription: {
    id: remoteSubscriptionId,
    protocolVersion: COLLABORATION_CONTRACT_VERSION,
    scope: "personal",
    personalOwnerUserId: remotePrincipalA,
    teamId: null,
    state: "active",
    snapshotHighWaterCursor: 0,
    acknowledgedEventId: null,
    acknowledgedCursor: 0,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    lastAcknowledgedAt: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null
  },
  snapshot: {
    scope: "personal",
    personalOwnerUserId: remotePrincipalA,
    teamId: null,
    highWaterCursor: snapshotCursor,
    threads: []
  },
  cursor: snapshotCursor
});

const messageUpdate = (eventId: string, scope: "personal" | "team") => ({
  type: "message_created" as const,
  message: {
    id: eventId,
    threadId,
    scope,
    teamId: scope === "team" ? teamA : null,
    sequence: 1,
    sender: {
      id: scope === "team" ? remotePrincipalA : desktopOwnerUserId,
      displayName: scope === "team" ? "Remote member" : "Owner",
      membershipState: "enabled"
    },
    senderKind: "user",
    body: `Message ${eventId}`,
    createdAt: "2026-07-17T00:01:00.000Z",
    updatedAt: "2026-07-17T00:01:00.000Z",
    editedAt: null,
    deletedAt: null,
    delivery: "sent",
    recipientStatus: null,
    failure: null
  }
});

const remoteEvent = (
  eventId: string,
  cursor: string,
  resource: Partial<{
    sharedSessionId: string | null;
    shareGrantId: string | null;
    logicalMemoryId: string | null;
  }> = {}
) => ({
  protocolVersion: COLLABORATION_CONTRACT_VERSION,
  eventId,
  cursor,
  type: "message_created",
  occurredAt: "2026-07-17T00:01:00.000Z",
  subscription: { id: remoteSubscriptionId },
  resource: {
    scope: "team",
    type: "collaboration_message",
    id: eventId,
    teamId: teamA,
    teamWorkspaceId: null,
    threadId,
    messageId: eventId,
    sharedSessionId: null,
    shareGrantId: null,
    logicalMemoryId: null,
    ...resource
  },
  actor: { principalId: remotePrincipalA },
  update: messageUpdate(eventId, "team")
});

const remotePresenceEvent = (
  eventId: string,
  cursor: string,
  personId = remotePrincipalA
) => ({
  protocolVersion: COLLABORATION_CONTRACT_VERSION,
  eventId,
  cursor,
  type: "team_presence_changed",
  occurredAt: "2026-07-17T00:01:00.000Z",
  subscription: { id: remoteSubscriptionId },
  resource: {
    scope: "team",
    type: "team_member_presence",
    id: personId,
    teamId: teamA,
    teamWorkspaceId: null,
    threadId: null,
    messageId: null,
    sharedSessionId: null,
    shareGrantId: null,
    logicalMemoryId: null
  },
  actor: { principalId: personId },
  update: {
    type: "team_person_upserted",
    teamId: teamA,
    person: {
      id: personId,
      displayName: "Remote member",
      presence: "away",
      membershipState: "enabled",
      teamPresence: {
        mode: "manual",
        manualStatus: "do_not_disturb",
        activityLevel: null,
        lastActivityAt: null,
        nextTransitionAt: null,
        preferenceVersion: 2
      }
    }
  }
});

const personalOutboxEvent = (
  eventId = eventA,
  cursor = 13
): CollaborationOutboxEventRecord => ({
  id: eventId,
  cursor,
  protocolVersion: COLLABORATION_CONTRACT_VERSION,
  family: "personal_memory_changed",
  scope: "personal",
  personalOwnerUserId: desktopOwnerUserId,
  teamId: null,
  teamWorkspaceId: null,
  threadId: null,
  messageId: null,
  shareGrantId: null,
  logicalMemoryId,
  resourceType: "personal_memory_entry",
  resourceId: sharedSessionId,
  actorPrincipalId: desktopOwnerUserId,
  mutationId: "mutation-1",
  occurredAt: "2026-07-17T00:01:00.000Z"
});

const managedConversationOutboxEvent = (
  eventId = eventA,
  cursor = 13
): CollaborationOutboxEventRecord => ({
  id: eventId,
  cursor,
  protocolVersion: COLLABORATION_CONTRACT_VERSION,
  family: "managed_conversation_changed",
  scope: "personal",
  personalOwnerUserId: desktopOwnerUserId,
  teamId: null,
  teamWorkspaceId: null,
  threadId: null,
  messageId: null,
  shareGrantId: null,
  logicalMemoryId: null,
  resourceType: "managed_conversation_execution",
  resourceId: "77777777-7777-4777-8777-777777777777",
  actorPrincipalId: desktopOwnerUserId,
  mutationId: "mutation-managed-1",
  occurredAt: "2026-07-17T00:01:00.000Z"
});

const sseResponse = (events: Array<{ event: string; data: unknown }>) =>
  new Response(
    events
      .map(
        ({ event, data }) =>
          `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      )
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );

const createHarness = async (
  options: HarnessOptions = {}
): Promise<Harness> => {
  const directory = mkdtempSync(resolve(tmpdir(), "koed-local-collaboration-"));
  const registryPath = resolve(directory, "upstreams.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      schemaVersion: 2,
      activeBackendId: "backend-a",
      backends: ["backend-a", "backend-b"].map((id) => ({
        id,
        baseUrl: `https://${id}.example.test/koed`,
        routePolicy: {
          teamWorkspaceRead: "enabled",
          ...(options.remotePersonal
            ? { personalCollaboration: "enabled" as const }
            : {})
        },
        capabilities: {
          state: "validated",
          expiresAt: "2099-01-01T00:00:00.000Z",
          schemaVersion: options.capabilitySchemaVersion ?? 6,
          payload: {
            capabilitySchemaVersion: options.capabilitySchemaVersion ?? 6,
            capabilities: {
              "memory.collaboration": { availability: "partial" }
            },
            protocols: {
              collaborationRealtime: {
                version:
                  options.realtimeProtocolVersion ??
                  COLLABORATION_CONTRACT_VERSION,
                transport: "sse"
              }
            }
          }
        }
      }))
    })
  );
  const app = Fastify({ logger: false });
  const pool = options.pool ?? new MemoryPool();
  const repository = options.repository ?? new MemoryCollaborationRepository();
  const quarantineCrossIdentitySyncForBackend = vi.fn(
    options.quarantineCrossIdentitySyncForBackend ?? (async () => undefined)
  );
  const revokeSharedMemoryAuthorityForBackend = vi.fn(
    options.revokeSharedMemoryAuthorityForBackend ?? (async () => undefined)
  );
  let activeLocalOwner = options.activeLocalOwner !== false;
  let remotePrincipalId = options.remotePrincipalId ?? remotePrincipalA;
  let remotePrincipalStatus = options.remotePrincipalStatus ?? 200;
  const calls: RemoteCall[] = [];
  const remoteFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body
    });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith(remotePrincipalStatusPath)) {
      if (remotePrincipalStatus !== 200) {
        return new Response("denied", { status: remotePrincipalStatus });
      }
      return Response.json({
        ok: true,
        auth: "device_credential",
        user: {
          id: remotePrincipalId,
          email: "remote@example.test",
          displayName: "Remote member"
        }
      });
    }
    if (pathname.endsWith("/snapshot")) {
      return Response.json(
        body?.scope === "personal"
          ? personalSnapshotResponse()
          : snapshotResponse(String(body?.teamId))
      );
    }
    if (pathname.endsWith("/ack")) {
      return options.ackStatus && options.ackStatus !== 200
        ? new Response("denied", { status: options.ackStatus })
        : Response.json({
            subscription: {
              ...(body?.scope === "personal"
                ? personalSnapshotResponse().subscription
                : snapshotResponse(teamA).subscription),
              acknowledgedEventId: body?.eventId,
              acknowledgedCursor: 1,
              lastAcknowledgedAt: "2026-07-17T00:01:00.000Z"
            }
          });
    }
    if (pathname.endsWith("/stream")) {
      return options.stream?.(init) ?? sseResponse([]);
    }
    return new Response("not found", { status: 404 });
  };
  const verifyDesktop: NonNullable<
    CollaborationRealtimeBrokerOptions["verifyDesktopLocalCredential"]
  > = (_koedHome, authorization, family) => {
    if (
      authorization !== desktopAuthorization ||
      family !== "personal_collaboration_read"
    ) {
      return null;
    }
    return {
      authorization: desktopAuthorization,
      credentialKeyId: "koed_desktop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ownerUserId: desktopOwnerUserId,
      operationFamilies: ["personal_collaboration_read"]
    };
  };
  const readLocalEdgeCredential: NonNullable<
    CollaborationRealtimeBrokerOptions["readLocalEdgeClientCredential"]
  > = (_koedHome, backendId) => {
    if (options.localEdgeCredentialAvailable === false) return null;
    if (backendId !== "backend-a" && backendId !== "backend-b") return null;
    return {
      authorization:
        backendId === "backend-a"
          ? localEdgeAuthorizationA
          : localEdgeAuthorizationB,
      backendId,
      credentialKeyId: backendId === "backend-a" ? "local-a" : "local-b",
      operationFamilies: options.remotePersonal
        ? ["team_workspace_read", "personal_collaboration_read"]
        : ["team_workspace_read"]
    };
  };
  const service = createCollaborationRealtimeBroker({
    app,
    pool: pool as unknown as DbPool,
    koedHome: directory,
    upstreamBackendsPath: registryPath,
    brokerSecret,
    corsOrigins: new Set(["http://localhost:5174"]),
    resolveUpstreamAuthorization: (backend) =>
      options.upstreamAuthorizationAvailable === false
        ? null
        : `Bearer remote-secret-${backend.id}`,
    requireCollaborationRepository: () =>
      repository as unknown as CollaborationRepository,
    requireCollaborationMaterializationRepository: () =>
      repository as unknown as PersonalRealtimeMaterializationRepository,
    resolveActiveLocalUser: async (userId) =>
      !activeLocalOwner
        ? null
        : {
            id: userId,
            email: "owner@example.test",
            displayName: "Owner"
          },
    quarantineCrossIdentitySyncForBackend,
    revokeSharedMemoryAuthorityForBackend,
    fetch: remoteFetch,
    verifyDesktopLocalCredential: verifyDesktop,
    readLocalEdgeClientCredential: readLocalEdgeCredential,
    maxConnections: options.maxConnections,
    maxPendingEvents: options.maxPendingEvents,
    maxPendingBytes: options.maxPendingBytes,
    ackDeadlineMs: options.ackDeadlineMs,
    maxReconnectAttempts: options.maxReconnectAttempts ?? 0,
    reconnectWindowMs: options.reconnectWindowMs,
    reconnectStableResetMs: options.reconnectStableResetMs,
    reconnectUnavailableCooldownMs: options.reconnectUnavailableCooldownMs,
    reconnectJitter: 0,
    sleep: options.sleep,
    now: options.now,
    afterRemoteAck: options.afterRemoteAck,
    onRemoteNavigationInvalidated: options.onRemoteNavigationInvalidated
  });
  service.registerRoutes();
  let listeningUrl: string | null = null;
  return {
    app,
    service,
    pool,
    repository,
    calls,
    quarantineCrossIdentitySyncForBackend,
    revokeSharedMemoryAuthorityForBackend,
    directory,
    setActiveLocalOwner(active) {
      activeLocalOwner = active;
    },
    setRemotePrincipal(principalId) {
      remotePrincipalId = principalId;
    },
    setRemotePrincipalStatus(status) {
      remotePrincipalStatus = status;
    },
    async baseUrl() {
      if (listeningUrl) return listeningUrl;
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string")
        throw new Error("no address");
      listeningUrl = `http://127.0.0.1:${address.port}`;
      return listeningUrl;
    }
  };
};

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.service.close();
    await harness.app.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

const localHeaders = (authorization = desktopAuthorization) => ({
  authorization,
  origin: "http://localhost:5174",
  host: "localhost:3300"
});

const createSnapshot = async (
  harness: Harness,
  input: { backendId?: string; teamId?: string; authorization?: string } = {}
) => {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/local-edge/collaboration/realtime/subscriptions",
    headers: localHeaders(input.authorization ?? desktopAuthorization),
    payload: {
      scope: "team",
      upstream_backend_id: input.backendId ?? "backend-a",
      team_id: input.teamId ?? teamA
    }
  });
  return { response, body: response.json() as Record<string, any> };
};

const createPersonalSnapshot = async (harness: Harness) => {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/local-edge/collaboration/realtime/subscriptions",
    headers: localHeaders(),
    payload: { scope: "personal" }
  });
  return { response, body: response.json() as Record<string, any> };
};

const acknowledgeSnapshot = async (
  harness: Harness,
  created: Record<string, any>,
  overrides: Record<string, unknown> = {}
) =>
  harness.app.inject({
    method: "POST",
    url: `/v1/local-edge/collaboration/realtime/subscriptions/${created.subscription.id}/ack`,
    headers: localHeaders(),
    payload: {
      scope: "team",
      upstream_backend_id: "backend-a",
      team_id: teamA,
      delivery_id: created.delivery.deliveryId,
      event_id: null,
      expected_version: created.subscription.version,
      ...overrides
    }
  });

const acknowledgePersonalSnapshot = async (
  harness: Harness,
  created: Record<string, any>
) =>
  harness.app.inject({
    method: "POST",
    url: `/v1/local-edge/collaboration/realtime/subscriptions/${created.subscription.id}/ack`,
    headers: localHeaders(),
    payload: {
      scope: "personal",
      delivery_id: created.delivery.deliveryId,
      event_id: null,
      expected_version: created.subscription.version
    }
  });

const openLocalStream = async (harness: Harness, subscriptionId: string) => {
  const baseUrl = await harness.baseUrl();
  const controller = new AbortController();
  const url = new URL(
    `/v1/local-edge/collaboration/realtime/subscriptions/${subscriptionId}/stream`,
    baseUrl
  );
  url.searchParams.set("upstream_backend_id", "backend-a");
  url.searchParams.set("team_id", teamA);
  url.searchParams.set("scope", "team");
  const response = await fetch(url, {
    headers: {
      authorization: desktopAuthorization,
      origin: "http://localhost:5174"
    },
    signal: controller.signal
  });
  return { response, controller };
};

const openPersonalStream = async (harness: Harness, subscriptionId: string) => {
  const baseUrl = await harness.baseUrl();
  const controller = new AbortController();
  const url = new URL(
    `/v1/local-edge/collaboration/realtime/subscriptions/${subscriptionId}/stream`,
    baseUrl
  );
  url.searchParams.set("scope", "personal");
  const response = await fetch(url, {
    headers: {
      authorization: desktopAuthorization,
      origin: "http://localhost:5174"
    },
    signal: controller.signal
  });
  return { response, controller };
};

const readFirstChunk = async (response: Response): Promise<string> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    const chunk = await reader.read();
    return chunk.done ? "" : decoder.decode(chunk.value, { stream: true });
  } finally {
    reader.releaseLock();
  }
};

const readUntil = async (
  response: Response,
  pattern: string
): Promise<string> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.includes(pattern)) return text;
    }
  } finally {
    reader.releaseLock();
  }
};

const readStream = async (response: Response): Promise<string> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

const brokerFrames = (stream: string): CollaborationRendererEvent[] =>
  stream
    .split("\n\n")
    .filter((candidate) =>
      candidate.split("\n").some((line) => line.startsWith("data: "))
    )
    .map((block) => {
      expect(block).toContain("event: collaboration\n");
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (!data) throw new Error("event data not found");
      return collaborationRendererEventSchema.parse(JSON.parse(data.slice(6)));
    });

const eventPayload = (stream: string) => {
  const event = brokerFrames(stream).find(
    (candidate) => candidate.type === "update"
  );
  if (!event || event.type !== "update")
    throw new Error("update event not found");
  return event;
};

describe("local collaboration realtime broker", () => {
  it("serves Personal snapshot and stream locally without an upstream backend", async () => {
    const harness = await createHarness({
      upstreamAuthorizationAvailable: false,
      localEdgeCredentialAvailable: false
    });
    harnesses.push(harness);

    const { response, body } = await createPersonalSnapshot(harness);
    expect(response.statusCode, response.body).toBe(200);
    expect(body.subscription.scope).toEqual({ scope: "personal" });
    expect(body.delivery.snapshot).toMatchObject({
      scope: "personal",
      personalOwnerUserId: desktopOwnerUserId
    });
    expect(harness.calls).toHaveLength(0);

    const ack = await acknowledgePersonalSnapshot(harness, body);
    expect(ack.statusCode).toBe(200);
    expect(ack.json()).toEqual({
      protocolVersion: COLLABORATION_CONTRACT_VERSION,
      subscription: {
        id: body.subscription.id,
        protocolVersion: COLLABORATION_CONTRACT_VERSION,
        scope: { scope: "personal" },
        state: "active",
        version: 1,
        expiresAt: expect.any(String)
      }
    });

    const { response: stream, controller } = await openPersonalStream(
      harness,
      body.subscription.id
    );
    expect(stream.status).toBe(200);
    expect(brokerFrames(await readFirstChunk(stream))).toEqual([
      expect.objectContaining({
        type: "connection",
        connection: expect.objectContaining({ state: "live", backendId: null })
      })
    ]);
    controller.abort();
  });

  it("persists remote Personal subscriptions with a Personal binding", async () => {
    const harness = await createHarness({ remotePersonal: true });
    harnesses.push(harness);

    const { response, body } = await createPersonalSnapshot(harness);

    expect(response.statusCode, response.body).toBe(200);
    expect(body.subscription).toMatchObject({
      scope: { scope: "personal" },
      state: "awaiting_snapshot_ack"
    });
    expect(body.delivery.snapshot).toEqual({
      scope: "personal",
      personalOwnerUserId: desktopOwnerUserId,
      highWaterCursor: 0,
      threads: []
    });
    expect(harness.pool.rows).toEqual([
      expect.objectContaining({
        scope: "personal",
        teamId: null,
        upstreamBackendId: "backend-a",
        state: "requires_snapshot"
      })
    ]);
    expect(harness.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/local-edge/device-credentials/status",
      "/koed/v1/collaboration/realtime/snapshot"
    ]);

    const ack = await acknowledgePersonalSnapshot(harness, body);
    expect(ack.statusCode).toBe(200);
    expect(harness.pool.rows[0]).toMatchObject({
      scope: "personal",
      teamId: null,
      state: "active"
    });
  });

  it("closes a Personal stream safely when its database listener is interrupted", async () => {
    const harness = await createHarness({
      upstreamAuthorizationAvailable: false,
      localEdgeCredentialAvailable: false
    });
    harnesses.push(harness);
    const { body } = await createPersonalSnapshot(harness);
    await acknowledgePersonalSnapshot(harness, body);
    const { response } = await openPersonalStream(
      harness,
      body.subscription.id
    );
    await vi.waitFor(() => expect(harness.pool.errorListenerCount()).toBe(1));

    expect(() =>
      harness.pool.interrupt(
        Object.assign(new Error("database restarted"), { code: "57P01" })
      )
    ).not.toThrow();
    const stream = await readStream(response);

    expect(stream).toContain('"type":"control"');
    expect(stream).toContain('"reason":"server_shutdown"');
    expect(harness.pool.errorListenerCount()).toBe(0);
  });

  it("replays and acknowledges Personal outbox events without backend fallback", async () => {
    const harness = await createHarness({
      upstreamAuthorizationAvailable: false,
      localEdgeCredentialAvailable: false
    });
    harness.repository.events.push(personalOutboxEvent());
    harnesses.push(harness);

    const { body } = await createPersonalSnapshot(harness);
    await acknowledgePersonalSnapshot(harness, body);
    const { response, controller } = await openPersonalStream(
      harness,
      body.subscription.id
    );
    const stream = await readUntil(response, '"type":"update"');
    controller.abort();
    const event = eventPayload(stream);
    expect(event).toMatchObject({
      family: "personal_memory_changed",
      update: {
        type: "personal_memory_upserted",
        entry: {
          id: sharedSessionId,
          logicalMemoryId,
          syncState: "ready"
        }
      }
    });

    const ack = await harness.app.inject({
      method: "POST",
      url: `/v1/local-edge/collaboration/realtime/subscriptions/${body.subscription.id}/ack`,
      headers: localHeaders(),
      payload: {
        scope: "personal",
        delivery_id: event.deliveryId,
        event_id: event.eventId,
        expected_version: 1
      }
    });

    expect(ack.statusCode).toBe(200);
    expect(harness.repository.acknowledged).toEqual([
      { eventId: eventA, cursor: 13 }
    ]);
    expect(harness.calls).toHaveLength(0);
  });

  it("replays managed conversation state through the Personal stream", async () => {
    const harness = await createHarness({
      upstreamAuthorizationAvailable: false,
      localEdgeCredentialAvailable: false
    });
    harness.repository.events.push(managedConversationOutboxEvent());
    harnesses.push(harness);

    const { body } = await createPersonalSnapshot(harness);
    await acknowledgePersonalSnapshot(harness, body);
    const { response, controller } = await openPersonalStream(
      harness,
      body.subscription.id
    );
    const stream = await readUntil(response, '"type":"update"');
    controller.abort();
    const event = eventPayload(stream);

    expect(event).toMatchObject({
      family: "managed_conversation_changed",
      update: {
        type: "managed_conversation_upserted",
        execution: {
          id: "77777777-7777-4777-8777-777777777777",
          state: "running",
          sessionId: "33333333-3333-4333-8333-333333333333",
          providerThreadId: "provider-thread-1"
        }
      }
    });

    const ack = await harness.app.inject({
      method: "POST",
      url: `/v1/local-edge/collaboration/realtime/subscriptions/${body.subscription.id}/ack`,
      headers: localHeaders(),
      payload: {
        scope: "personal",
        delivery_id: event.deliveryId,
        event_id: event.eventId,
        expected_version: 1
      }
    });

    expect(ack.statusCode).toBe(200);
    expect(harness.repository.acknowledged).toEqual([
      { eventId: eventA, cursor: 13 }
    ]);
    expect(harness.calls).toHaveLength(0);
  });

  it.each([
    ["wrong owner", { personalOwnerUserId: remotePrincipalA }],
    ["unavailable current state", null]
  ])(
    "requires a Personal resnapshot for %s materialization",
    async (_case, patch) => {
      const harness = await createHarness({
        upstreamAuthorizationAvailable: false,
        localEdgeCredentialAvailable: false
      });
      if (patch === null) harness.repository.personalMemoryAvailable = false;
      harness.repository.events.push({
        ...personalOutboxEvent(),
        ...(patch ?? {})
      });
      harnesses.push(harness);

      const { body } = await createPersonalSnapshot(harness);
      await acknowledgePersonalSnapshot(harness, body);
      const { response } = await openPersonalStream(
        harness,
        body.subscription.id
      );
      const stream = await readStream(response);

      expect(stream).toContain('"type":"control"');
      expect(stream).toContain('"reason":"requires_snapshot"');
      expect(stream).not.toContain('"personal_memory_upserted"');
    }
  );

  it("marks the backend credential revoked when a terminal Team frame also fails principal authorization", async () => {
    const remoteStream = {
      controller: null as ReadableStreamDefaultController<Uint8Array> | null
    };
    const harness = await createHarness({
      stream: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              remoteStream.controller = controller;
            }
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    harness.calls.splice(0);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const remoteController = remoteStream.controller;
    if (!remoteController) throw new Error("remote stream did not open");
    harness.setRemotePrincipalStatus(401);
    const remoteFrame = `event: access_revoked\ndata: ${JSON.stringify({
      protocolVersion: COLLABORATION_CONTRACT_VERSION,
      subscription: { id: remoteSubscriptionId },
      reason: "access_revoked"
    })}\n\n`;
    remoteController.enqueue(new TextEncoder().encode(remoteFrame));
    remoteController.close();
    const stream = await readStream(response);
    expect(response.status).toBe(200);
    expect(stream).toContain('"state":"access_revoked"');
    expect(
      harness.calls.filter((call) =>
        call.url.endsWith(remotePrincipalStatusPath)
      )
    ).toHaveLength(2);
    expect(brokerFrames(stream)).toContainEqual(
      expect.objectContaining({
        type: "connection",
        connection: expect.objectContaining({ state: "access_revoked" })
      })
    );
  });

  it("keeps Personal Memory replay acknowledgement-bound under backpressure", async () => {
    const harness = await createHarness({
      maxPendingEvents: 1,
      upstreamAuthorizationAvailable: false,
      localEdgeCredentialAvailable: false
    });
    harness.repository.events.push(
      personalOutboxEvent(eventA, 13),
      personalOutboxEvent(eventB, 14)
    );
    harnesses.push(harness);

    const { body } = await createPersonalSnapshot(harness);
    await acknowledgePersonalSnapshot(harness, body);
    const { response } = await openPersonalStream(
      harness,
      body.subscription.id
    );
    const frames = brokerFrames(await readStream(response));

    expect(frames.filter((frame) => frame.type === "update")).toHaveLength(1);
    expect(frames).toContainEqual(
      expect.objectContaining({ type: "control", reason: "backpressure" })
    );
    expect(harness.repository.acknowledged).toEqual([]);
    expect(harness.repository.subscription?.acknowledgedCursor).toBe(0);
  });

  it("rejects local realtime routes when the Desktop owner is revoked", async () => {
    const harness = await createHarness({ activeLocalOwner: false });
    harnesses.push(harness);

    const personal = await createPersonalSnapshot(harness);
    const team = await createSnapshot(harness);

    expect(personal.response.statusCode).toBe(403);
    expect(team.response.statusCode).toBe(403);
    expect(harness.calls).toHaveLength(0);
  });

  it("revalidates the active Desktop owner at acknowledgement boundaries", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    harness.setActiveLocalOwner(false);

    const ack = await acknowledgeSnapshot(harness, body);

    expect(ack.statusCode).toBe(403);
    expect(harness.pool.rows).toHaveLength(1);
    expect(harness.pool.rows[0]).toMatchObject({
      id: body.subscription.id,
      state: "requires_snapshot",
      version: 1
    });
  });

  it("revokes only one backend's persisted subscriptions through the local Desktop boundary", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const backendA = await createSnapshot(harness);
    const backendB = await createSnapshot(harness, {
      backendId: "backend-b",
      teamId: teamB
    });
    await acknowledgeSnapshot(harness, backendA.body);
    await acknowledgeSnapshot(harness, backendB.body, {
      upstream_backend_id: "backend-b",
      team_id: teamB
    });

    const response = await harness.app.inject({
      method: "DELETE",
      url: "/v1/local-edge/collaboration/realtime/backends/backend-a/subscriptions",
      headers: localHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      protocolVersion: COLLABORATION_CONTRACT_VERSION,
      revokedSubscriptionCount: 1
    });
    expect(
      harness.quarantineCrossIdentitySyncForBackend
    ).toHaveBeenCalledExactlyOnceWith(desktopOwnerUserId, "backend-a");
    expect(
      harness.revokeSharedMemoryAuthorityForBackend
    ).toHaveBeenCalledExactlyOnceWith(desktopOwnerUserId, "backend-a");
    expect(
      harness.pool.rows.find((row) => row.id === backendA.body.subscription.id)
    ).toBeUndefined();
    expect(
      harness.pool.rows.find((row) => row.id === backendB.body.subscription.id)
        ?.state
    ).toBe("active");

    harness.setActiveLocalOwner(false);
    const denied = await harness.app.inject({
      method: "DELETE",
      url: "/v1/local-edge/collaboration/realtime/backends/backend-b/subscriptions",
      headers: localHeaders()
    });
    expect(denied.statusCode).toBe(403);
    expect(harness.revokeSharedMemoryAuthorityForBackend).toHaveBeenCalledTimes(
      1
    );
    expect(
      harness.pool.rows.find((row) => row.id === backendB.body.subscription.id)
        ?.state
    ).toBe("active");
  });

  it("rejects ambiguous scope bindings instead of falling back between Personal and Team", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const personalWithTeamFields = await harness.app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/realtime/subscriptions",
      headers: localHeaders(),
      payload: {
        scope: "personal",
        upstream_backend_id: "backend-a",
        team_id: teamA
      }
    });
    const teamWithoutScope = await harness.app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/realtime/subscriptions",
      headers: localHeaders(),
      payload: {
        upstream_backend_id: "backend-a",
        team_id: teamA
      }
    });

    expect(personalWithTeamFields.statusCode).toBe(400);
    expect(teamWithoutScope.statusCode).toBe(400);
    expect(harness.calls).toHaveLength(0);
  });

  it("requires internally held Team Local-Edge and upstream credentials", async () => {
    const missingLocalEdge = await createHarness({
      localEdgeCredentialAvailable: false
    });
    const missingUpstream = await createHarness({
      upstreamAuthorizationAvailable: false
    });
    harnesses.push(missingLocalEdge, missingUpstream);

    expect((await createSnapshot(missingLocalEdge)).response.statusCode).toBe(
      424
    );
    expect((await createSnapshot(missingUpstream)).response.statusCode).toBe(
      424
    );
    expect(missingLocalEdge.calls).toHaveLength(0);
    expect(missingUpstream.calls).toHaveLength(0);
  });

  it("never exposes remote URL, credential, binding keys, subscription ID, or cursor", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { response, body } = await createSnapshot(harness);

    expect(response.statusCode).toBe(200);
    const rendered = JSON.stringify(body);
    expect(rendered).not.toContain("backend-a.example.test");
    expect(rendered).not.toContain("remote-secret");
    expect(rendered).not.toContain("lcb1.");
    expect(rendered).not.toContain(remoteSubscriptionId);
    expect(rendered).not.toContain("crt1.");
    const snapshotCall = harness.calls.find((call) =>
      new URL(call.url).pathname.endsWith("/snapshot")
    );
    expect(snapshotCall?.authorization).toBe("Bearer remote-secret-backend-a");
    expect(snapshotCall?.body?.clientInstanceId).toMatch(/^lcb1\./);
    expect(snapshotCall?.body?.subscriptionKey).toMatch(/^lcb1\./);
  });

  it("requires localhost trust and the current realtime protocol", async () => {
    const harness = await createHarness();
    const incompatible = await createHarness({ realtimeProtocolVersion: 1 });
    harnesses.push(harness, incompatible);

    const badHost = await harness.app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/realtime/subscriptions",
      headers: { ...localHeaders(), host: "remote.example.test" },
      payload: {
        scope: "team",
        upstream_backend_id: "backend-a",
        team_id: teamA
      }
    });
    const badOrigin = await harness.app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/realtime/subscriptions",
      headers: { ...localHeaders(), origin: "https://evil.example.test" },
      payload: {
        scope: "team",
        upstream_backend_id: "backend-a",
        team_id: teamA
      }
    });
    const badProtocol = await createSnapshot(incompatible);

    expect(badHost.statusCode).toBe(403);
    expect(badOrigin.statusCode).toBe(403);
    expect(badProtocol.response.statusCode).toBe(424);
    expect(incompatible.calls).toHaveLength(0);
  });

  it("persists snapshot custody before acknowledgement and activates it only after ack", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    expect(harness.pool.rows).toHaveLength(1);
    expect(harness.pool.rows[0]).toMatchObject({
      remoteSubscriptionId,
      remoteCursor: snapshotCursor,
      version: 1,
      state: "requires_snapshot"
    });

    const ack = await acknowledgeSnapshot(harness, body);
    expect(ack.statusCode).toBe(200);
    expect(ack.json()).toEqual({
      protocolVersion: COLLABORATION_CONTRACT_VERSION,
      subscription: {
        id: body.subscription.id,
        protocolVersion: COLLABORATION_CONTRACT_VERSION,
        scope: { scope: "team", teamId: teamA },
        state: "active",
        version: 2,
        expiresAt: expect.any(String)
      }
    });
    expect(harness.pool.rows).toHaveLength(1);
    expect(harness.pool.rows[0]).toMatchObject({
      remoteSubscriptionId,
      remoteCursor: snapshotCursor,
      version: 2,
      state: "active"
    });
    expect(harness.pool.rows[0]?.credentialBindingHash).toMatch(
      /^[a-f0-9]{64}$/
    );
  });

  it("resnapshots instead of reporting revocation when the API restarts before initial ack", async () => {
    const firstProcess = await createHarness();
    const secondProcess = await createHarness();
    harnesses.push(firstProcess, secondProcess);
    const first = await createSnapshot(firstProcess);
    secondProcess.pool.rows.push(structuredClone(firstProcess.pool.rows[0]!));

    const lostAck = await acknowledgeSnapshot(secondProcess, first.body);
    expect(lostAck.statusCode).toBe(409);
    expect(lostAck.json()).toMatchObject({
      message: expect.stringContaining("snapshot acknowledgement")
    });
    expect(lostAck.json()).not.toMatchObject({
      message: expect.stringContaining("revoked")
    });

    const replay = await createSnapshot(secondProcess);
    expect(replay.response.statusCode).toBe(200);
    expect(replay.body.subscription).toMatchObject({
      id: first.body.subscription.id,
      state: "awaiting_snapshot_ack",
      version: 2
    });
    const acknowledged = await acknowledgeSnapshot(secondProcess, replay.body);
    expect(acknowledged.statusCode).toBe(200);
    expect(secondProcess.pool.rows[0]).toMatchObject({
      state: "active",
      version: 3,
      remoteCursor: snapshotCursor
    });
  });

  it("deduplicates replayed event IDs and emits renderer updates", async () => {
    const onRemoteNavigationInvalidated = vi.fn();
    const harness = await createHarness({
      onRemoteNavigationInvalidated,
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: remoteEvent(eventA, eventCursorA)
          },
          {
            event: "collaboration_event",
            data: remoteEvent(eventA, eventCursorA)
          }
        ])
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const stream = await readStream(response);

    expect(
      brokerFrames(stream).filter((event) => event.type === "update")
    ).toHaveLength(1);
    const payload = eventPayload(stream);
    expect(payload).toMatchObject({
      eventId: eventA,
      type: "update",
      family: "message_created",
      subscriptionId: body.subscription.id,
      update: { type: "message_created" }
    });
    expect(JSON.stringify(payload)).not.toContain("cursor");
    expect(JSON.stringify(payload)).not.toContain("bodyText");
    expect(JSON.stringify(payload)).not.toContain(remoteSubscriptionId);
    expect(onRemoteNavigationInvalidated).toHaveBeenCalledTimes(1);
    expect(onRemoteNavigationInvalidated).toHaveBeenCalledWith("backend-a");
  });

  it("forwards Team Presence updates through the local edge without requiring a snapshot", async () => {
    const harness = await createHarness({
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: remotePresenceEvent(eventA, eventCursorA)
          }
        ])
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const stream = await readStream(response);

    expect(brokerFrames(stream)).toContainEqual(
      expect.objectContaining({
        type: "update",
        family: "team_presence_changed",
        update: expect.objectContaining({
          type: "team_person_upserted",
          teamId: teamA,
          person: expect.objectContaining({
            id: remotePrincipalA,
            presence: "away",
            teamPresence: expect.objectContaining({
              mode: "manual",
              manualStatus: "do_not_disturb",
              preferenceVersion: 2
            })
          })
        })
      })
    );
    expect(
      brokerFrames(stream).some(
        (event) =>
          event.type === "control" && event.reason === "requires_snapshot"
      )
    ).toBe(false);
  });

  it("rejects Team Presence updates outside the authorized person resource", async () => {
    const spoofed = remotePresenceEvent(eventA, eventCursorA);
    spoofed.update.person.id = remotePrincipalB;
    const harness = await createHarness({
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: spoofed
          }
        ])
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const frames = brokerFrames(await readStream(response));

    expect(frames.some((frame) => frame.type === "update")).toBe(false);
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "connection",
        connection: expect.objectContaining({ state: "unavailable" })
      })
    );
    expect(harness.pool.rows[0]).toMatchObject({
      remoteCursor: snapshotCursor,
      lastAcknowledgedEventId: null
    });
  });

  it("accepts the complete remote envelope and preserves Shared Session identity", async () => {
    const harness = await createHarness({
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: remoteEvent(eventA, eventCursorA, {
              sharedSessionId,
              shareGrantId: sharedSessionId,
              logicalMemoryId
            })
          }
        ])
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const payload = eventPayload(await readStream(response));

    expect(payload.resource).toMatchObject({
      sharedSessionId,
      shareGrantId: sharedSessionId
    });
    expect(JSON.stringify(payload)).not.toContain(logicalMemoryId);
  });

  it("delivers a Share Grant revocation without terminating the Team subscription", async () => {
    const scopedRevocation = {
      ...remoteEvent(eventA, eventCursorA, {
        sharedSessionId,
        shareGrantId: sharedSessionId,
        logicalMemoryId
      }),
      type: "access_revoked",
      resource: {
        ...remoteEvent(eventA, eventCursorA).resource,
        type: "team_session_share_grant",
        id: sharedSessionId,
        threadId: null,
        messageId: null,
        sharedSessionId,
        shareGrantId: sharedSessionId,
        logicalMemoryId
      },
      update: {
        type: "shared_session_removed",
        sharedSessionId
      }
    };
    const harness = await createHarness({
      stream: () =>
        sseResponse([{ event: "collaboration_event", data: scopedRevocation }])
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const stream = await readStream(response);
    const payload = eventPayload(stream);

    expect(payload).toMatchObject({
      family: "access_revoked",
      update: {
        type: "shared_session_removed",
        sharedSessionId
      }
    });
    expect(
      brokerFrames(stream).some(
        (frame) => frame.type === "control" && frame.reason === "access_revoked"
      )
    ).toBe(false);
    expect(harness.pool.rows[0]?.state).toBe("active");
  });

  it("rejects a remote envelope whose Shared Session and Share Grant identities disagree", async () => {
    const harness = await createHarness({
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: remoteEvent(eventA, eventCursorA, {
              sharedSessionId,
              shareGrantId: eventB,
              logicalMemoryId
            })
          }
        ])
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const frames = brokerFrames(await readStream(response));

    expect(frames.some((frame) => frame.type === "update")).toBe(false);
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "connection",
        connection: expect.objectContaining({ state: "unavailable" })
      })
    );
    expect(harness.pool.rows[0]).toMatchObject({
      remoteCursor: snapshotCursor,
      lastAcknowledgedEventId: null
    });
  });

  it("does not advance the durable cursor when remote ack fails", async () => {
    const harness = await createHarness({
      ackStatus: 503,
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: remoteEvent(eventA, eventCursorA)
          }
        ])
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const event = eventPayload(await readStream(response));

    const ack = await harness.app.inject({
      method: "POST",
      url: `/v1/local-edge/collaboration/realtime/subscriptions/${body.subscription.id}/ack`,
      headers: localHeaders(),
      payload: {
        scope: "team",
        upstream_backend_id: "backend-a",
        team_id: teamA,
        delivery_id: event.deliveryId,
        event_id: event.eventId,
        expected_version: 2
      }
    });
    expect(ack.statusCode).toBe(502);
    expect(harness.pool.rows[0]).toMatchObject({
      remoteCursor: snapshotCursor,
      lastAcknowledgedEventId: null,
      version: 2
    });
  });

  it("replays safely across the crash window after remote ack and before local commit", async () => {
    let crash = true;
    const harness = await createHarness({
      afterRemoteAck: async () => {
        if (crash) {
          crash = false;
          throw new Error("simulated crash");
        }
      },
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: remoteEvent(eventA, eventCursorA)
          }
        ])
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const event = eventPayload(await readStream(response));
    const request = {
      method: "POST" as const,
      url: `/v1/local-edge/collaboration/realtime/subscriptions/${body.subscription.id}/ack`,
      headers: localHeaders(),
      payload: {
        upstream_backend_id: "backend-a",
        scope: "team",
        team_id: teamA,
        delivery_id: event.deliveryId,
        event_id: event.eventId,
        expected_version: 2
      }
    };

    expect((await harness.app.inject(request)).statusCode).toBe(500);
    expect(harness.pool.rows[0]?.remoteCursor).toBe(snapshotCursor);
    const retry = await harness.app.inject(request);
    expect(retry.statusCode).toBe(200);
    expect(harness.pool.rows[0]).toMatchObject({
      remoteCursor: eventCursorA,
      lastAcknowledgedEventId: eventA,
      version: 3
    });
    expect(
      harness.calls.filter((call) => call.url.endsWith("/ack"))
    ).toHaveLength(2);
  });

  it("rejects backend, Team, and credential substitution and denies unscoped credentials", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);

    expect(
      (
        await acknowledgeSnapshot(harness, body, {
          team_id: teamB
        })
      ).statusCode
    ).toBe(403);
    const backendSwap = await harness.app.inject({
      method: "POST",
      url: `/v1/local-edge/collaboration/realtime/subscriptions/${body.subscription.id}/ack`,
      headers: localHeaders(),
      payload: {
        scope: "team",
        upstream_backend_id: "backend-b",
        team_id: teamA,
        delivery_id: body.delivery.deliveryId,
        event_id: null,
        expected_version: 0
      }
    });
    expect(backendSwap.statusCode).toBe(403);
    expect(
      (await createSnapshot(harness, { authorization: "Koed-Device bad:bad" }))
        .response.statusCode
    ).toBe(401);
    expect(
      (
        await createSnapshot(harness, {
          authorization: "Bearer personal-api-token"
        })
      ).response.statusCode
    ).toBe(401);
    expect(harness.pool.rows).toHaveLength(1);
    expect(harness.pool.rows[0]).toMatchObject({
      id: body.subscription.id,
      state: "requires_snapshot",
      version: 1
    });
  });

  it("starts a distinct Team binding when the authenticated remote principal changes", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const first = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, first.body);
    const firstHash = harness.pool.rows[0]?.credentialBindingHash;

    harness.setRemotePrincipal(remotePrincipalB);
    const second = await createSnapshot(harness);
    expect(second.response.statusCode).toBe(200);
    expect(second.body.subscription.id).not.toBe(first.body.subscription.id);
    expect(harness.pool.rows[0]?.state).toBe("expired");
    expect(harness.pool.rows[1]?.state).toBe("requires_snapshot");
    expect((await acknowledgeSnapshot(harness, first.body)).statusCode).toBe(
      404
    );
    await acknowledgeSnapshot(harness, second.body);

    expect(harness.pool.rows).toHaveLength(2);
    expect(harness.pool.rows[1]?.credentialBindingHash).not.toBe(firstHash);
    expect(harness.pool.rows.map(({ state }) => state)).toEqual([
      "expired",
      "active"
    ]);
  });

  it.each([
    ["requires_snapshot", "requires_snapshot"],
    ["access_revoked", "access_revoked"]
  ] as const)(
    "handles remote %s as a local content-free terminal event",
    async (remoteEventName, reason) => {
      const harness = await createHarness({
        stream: () =>
          sseResponse([
            {
              event:
                remoteEventName === "access_revoked"
                  ? "access_revoked"
                  : "control",
              data: {
                protocolVersion: COLLABORATION_CONTRACT_VERSION,
                subscription: { id: remoteSubscriptionId },
                reason
              }
            }
          ])
      });
      harnesses.push(harness);
      const { body } = await createSnapshot(harness);
      await acknowledgeSnapshot(harness, body);
      const { response } = await openLocalStream(harness, body.subscription.id);
      const stream = await readStream(response);

      expect(brokerFrames(stream)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "control",
            reason
          })
        ])
      );
      expect(stream).toContain(`"reason":"${reason}"`);
      expect(stream).not.toContain(remoteSubscriptionId);
      expect(stream).not.toContain("crt1.");
      expect(harness.pool.rows[0]?.state).toBe(
        reason === "access_revoked" ? "revoked" : "requires_snapshot"
      );
      if (reason === "access_revoked") {
        const reopened = await openLocalStream(harness, body.subscription.id);
        expect(reopened.response.status).toBe(410);
        reopened.controller.abort();
      }
    }
  );

  it("purges unacknowledged renderer deliveries before a terminal control", async () => {
    const harness = await createHarness({
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: remoteEvent(eventA, eventCursorA)
          },
          {
            event: "access_revoked",
            data: {
              protocolVersion: COLLABORATION_CONTRACT_VERSION,
              subscription: { id: remoteSubscriptionId },
              reason: "access_revoked"
            }
          }
        ])
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const stream = await readStream(response);
    const delivery = eventPayload(stream);

    const ack = await harness.app.inject({
      method: "POST",
      url: `/v1/local-edge/collaboration/realtime/subscriptions/${body.subscription.id}/ack`,
      headers: localHeaders(),
      payload: {
        scope: "team",
        upstream_backend_id: "backend-a",
        team_id: teamA,
        delivery_id: delivery.deliveryId,
        event_id: delivery.eventId,
        expected_version: 2
      }
    });

    expect(ack.statusCode).toBe(403);
    expect(
      harness.calls.filter((call) => call.url.endsWith("/ack"))
    ).toHaveLength(0);
    expect(harness.pool.rows[0]).toMatchObject({
      state: "revoked",
      remoteCursor: snapshotCursor,
      lastAcknowledgedEventId: null
    });
  });

  it("bounds reconnect delay and stops after the configured attempts", async () => {
    expect(
      calculateCollaborationReconnectDelay({
        attempt: 0,
        baseMs: 250,
        maxMs: 2_000,
        jitter: 0.2,
        random: 0
      })
    ).toBe(200);
    expect(
      calculateCollaborationReconnectDelay({
        attempt: 20,
        baseMs: 250,
        maxMs: 2_000,
        jitter: 0.2,
        random: 1
      })
    ).toBe(2_000);
    const delays: number[] = [];
    const harness = await createHarness({
      maxReconnectAttempts: 2,
      reconnectUnavailableCooldownMs: 1_234,
      stream: () => new Response("unavailable", { status: 503 }),
      sleep: async (milliseconds, signal) => {
        delays.push(milliseconds);
        if (milliseconds === 1_234) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              {
                once: true
              }
            );
          });
        }
      }
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response, controller } = await openLocalStream(
      harness,
      body.subscription.id
    );
    const stream = await readUntil(response, '"state":"unavailable"');
    controller.abort();

    expect(delays).toEqual([250, 500, 1_234]);
    expect(brokerFrames(stream)).toContainEqual(
      expect.objectContaining({
        type: "connection",
        connection: expect.objectContaining({ state: "unavailable" })
      })
    );
    expect(
      harness.calls.filter((call) =>
        new URL(call.url).pathname.endsWith("/stream")
      )
    ).toHaveLength(3);
  });

  it("prunes reconnect attempts by window and resets after a stable stream", async () => {
    let windowClock = Date.parse("2026-07-17T00:00:00.000Z");
    let windowCalls = 0;
    const windowed = await createHarness({
      maxReconnectAttempts: 1,
      reconnectWindowMs: 100,
      now: () => new Date(windowClock),
      stream: () => {
        windowCalls += 1;
        return windowCalls === 3
          ? new Response("revoked", { status: 403 })
          : new Response("unavailable", { status: 503 });
      },
      sleep: async (milliseconds) => {
        windowClock += milliseconds;
      }
    });
    harnesses.push(windowed);
    const windowedSnapshot = await createSnapshot(windowed);
    await acknowledgeSnapshot(windowed, windowedSnapshot.body);
    const windowedStream = await openLocalStream(
      windowed,
      windowedSnapshot.body.subscription.id
    );
    const windowedFrames = brokerFrames(
      await readStream(windowedStream.response)
    );
    expect(windowCalls).toBe(3);
    expect(
      windowedFrames.filter(
        (frame) =>
          frame.type === "connection" &&
          frame.connection.state === "unavailable"
      )
    ).toHaveLength(0);

    let stableClock = Date.parse("2026-07-17T01:00:00.000Z");
    let stableCalls = 0;
    let closeStableStream: (() => void) | null = null;
    const stable = await createHarness({
      maxReconnectAttempts: 1,
      reconnectWindowMs: 5 * 60_000,
      reconnectStableResetMs: 100,
      now: () => new Date(stableClock),
      stream: () => {
        stableCalls += 1;
        if (stableCalls === 1) {
          return new Response("unavailable", { status: 503 });
        }
        if (stableCalls === 2) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                closeStableStream = () => controller.close();
              }
            }),
            { status: 200 }
          );
        }
        return new Response("revoked", { status: 403 });
      },
      sleep: async (milliseconds) => {
        stableClock += milliseconds;
      }
    });
    harnesses.push(stable);
    const stableSnapshot = await createSnapshot(stable);
    await acknowledgeSnapshot(stable, stableSnapshot.body);
    const stableStream = await openLocalStream(
      stable,
      stableSnapshot.body.subscription.id
    );
    await vi.waitFor(() => expect(closeStableStream).not.toBeNull());
    stableClock += 101;
    (closeStableStream as (() => void) | null)?.();
    const stableFrames = brokerFrames(await readStream(stableStream.response));
    expect(stableCalls).toBe(3);
    expect(
      stableFrames.filter(
        (frame) =>
          frame.type === "connection" &&
          frame.connection.state === "unavailable"
      )
    ).toHaveLength(0);
  });

  it("replaces a stale renderer stream for the same Team subscription", async () => {
    const harness = await createHarness({
      stream: (init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.close(), {
              once: true
            });
          }
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const first = await openLocalStream(harness, body.subscription.id);
    const second = await openLocalStream(harness, body.subscription.id);

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    await expect(first.response.text()).resolves.toContain(
      '"state":"connecting"'
    );
    first.controller.abort();
    second.controller.abort();
  });

  it("replaces a stale renderer stream for the same Personal subscription", async () => {
    const harness = await createHarness({
      upstreamAuthorizationAvailable: false,
      localEdgeCredentialAvailable: false
    });
    harnesses.push(harness);
    const { body } = await createPersonalSnapshot(harness);
    await acknowledgePersonalSnapshot(harness, body);

    const first = await openPersonalStream(harness, body.subscription.id);
    const second = await openPersonalStream(harness, body.subscription.id);

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    await expect(first.response.text()).resolves.toContain('"state":"live"');
    first.controller.abort();
    second.controller.abort();
  });

  it("closes on pending-delivery backpressure without advancing the cursor", async () => {
    const harness = await createHarness({
      maxPendingEvents: 1,
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: remoteEvent(eventA, eventCursorA)
          },
          {
            event: "collaboration_event",
            data: remoteEvent(eventB, eventCursorB)
          }
        ])
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const stream = await readStream(response);

    expect(
      brokerFrames(stream).filter((event) => event.type === "update")
    ).toHaveLength(1);
    expect(stream).toContain('"reason":"backpressure"');
    expect(harness.pool.rows[0]).toMatchObject({
      remoteCursor: snapshotCursor,
      lastAcknowledgedEventId: null,
      version: 2
    });
  });

  it("composes schema-valid race recovery, replay, revocation, bounds, and process-state loss", async () => {
    const firstProcess = await createHarness({
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: remoteEvent(eventA, eventCursorA)
          }
        ])
    });
    harnesses.push(firstProcess);
    const created = await createSnapshot(firstProcess);
    await acknowledgeSnapshot(firstProcess, created.body);
    const firstStream = await openLocalStream(
      firstProcess,
      created.body.subscription.id
    );
    const firstText = await readStream(firstStream.response);
    const firstDelivery = eventPayload(firstText);
    expect(
      brokerFrames(firstText).every(
        (frame) => collaborationRendererEventSchema.safeParse(frame).success
      )
    ).toBe(true);
    expect(firstProcess.pool.rows[0]?.remoteCursor).toBe(snapshotCursor);

    await firstProcess.service.close();
    const restartedProcess = await createHarness({
      pool: firstProcess.pool,
      repository: firstProcess.repository,
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: remoteEvent(eventA, eventCursorA)
          },
          {
            event: "access_revoked",
            data: {
              protocolVersion: COLLABORATION_CONTRACT_VERSION,
              subscription: { id: remoteSubscriptionId },
              reason: "access_revoked"
            }
          }
        ])
    });
    harnesses.push(restartedProcess);
    const replayedStream = await openLocalStream(
      restartedProcess,
      created.body.subscription.id
    );
    const replayedText = await readStream(replayedStream.response);
    const replayedDelivery = eventPayload(replayedText);
    const replayedFrames = brokerFrames(replayedText);
    expect(replayedDelivery.deliveryId).toBe(firstDelivery.deliveryId);
    expect(replayedFrames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "update", eventId: eventA }),
        expect.objectContaining({
          type: "control",
          reason: "access_revoked"
        })
      ])
    );
    const terminal = await openLocalStream(
      restartedProcess,
      created.body.subscription.id
    );
    expect(terminal.response.status).toBe(410);
    terminal.controller.abort();

    const bounded = await createHarness({
      maxPendingEvents: 1,
      stream: () =>
        sseResponse([
          {
            event: "collaboration_event",
            data: remoteEvent(eventA, eventCursorA)
          },
          {
            event: "collaboration_event",
            data: remoteEvent(eventB, eventCursorB)
          }
        ])
    });
    harnesses.push(bounded);
    const boundedSnapshot = await createSnapshot(bounded);
    await acknowledgeSnapshot(bounded, boundedSnapshot.body);
    const boundedStream = await openLocalStream(
      bounded,
      boundedSnapshot.body.subscription.id
    );
    const boundedText = await readStream(boundedStream.response);
    const boundedFrames = brokerFrames(boundedText);
    expect(
      boundedFrames.filter((frame) => frame.type === "update")
    ).toHaveLength(1);
    expect(boundedFrames).toContainEqual(
      expect.objectContaining({ type: "control", reason: "backpressure" })
    );
    expect(bounded.pool.rows[0]?.remoteCursor).toBe(snapshotCursor);

    const boundedSnapshots = await createHarness({ maxConnections: 1 });
    harnesses.push(boundedSnapshots);
    expect(
      (await createPersonalSnapshot(boundedSnapshots)).response.statusCode
    ).toBe(200);
    expect((await createSnapshot(boundedSnapshots)).response.statusCode).toBe(
      429
    );

    const race = await createHarness({
      upstreamAuthorizationAvailable: false,
      localEdgeCredentialAvailable: false
    });
    harnesses.push(race);
    const personal = await createPersonalSnapshot(race);
    await acknowledgePersonalSnapshot(race, personal.body);
    let replayRead = 0;
    race.repository.afterReplayRead = () => {
      expect(race.pool.listenCount).toBeGreaterThan(0);
      if (replayRead === 0) {
        race.repository.events.push(personalOutboxEvent(eventA, 13));
        race.pool.notify();
      } else if (replayRead === 1) {
        race.repository.events.push(personalOutboxEvent(eventB, 14));
        race.pool.notify();
      }
      replayRead += 1;
    };
    const personalStream = await openPersonalStream(
      race,
      personal.body.subscription.id
    );
    const personalText = await readUntil(personalStream.response, eventB);
    personalStream.controller.abort();
    const personalFrames = brokerFrames(personalText);
    expect(
      personalFrames
        .filter((frame) => frame.type === "update")
        .map((frame) => (frame.type === "update" ? frame.eventId : null))
    ).toEqual([eventA, eventB]);
  });

  it("disconnects a renderer that misses the acknowledgement deadline", async () => {
    const harness = await createHarness({
      ackDeadlineMs: 10,
      stream: (init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: collaboration_event\ndata: ${JSON.stringify(remoteEvent(eventA, eventCursorA))}\n\n`
              )
            );
            init?.signal?.addEventListener("abort", () => controller.close(), {
              once: true
            });
          }
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }
    });
    harnesses.push(harness);
    const { body } = await createSnapshot(harness);
    await acknowledgeSnapshot(harness, body);
    const { response } = await openLocalStream(harness, body.subscription.id);
    const stream = await readStream(response);

    expect(stream).toContain(`"eventId":"${eventA}"`);
    expect(stream).toContain('"reason":"backpressure"');
    expect(harness.pool.rows[0]).toMatchObject({
      remoteCursor: snapshotCursor,
      lastAcknowledgedEventId: null,
      version: 2
    });
  });
});
