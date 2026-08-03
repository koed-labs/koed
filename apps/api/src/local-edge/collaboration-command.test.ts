import { randomUUID } from "node:crypto";

import type {
  CapturedSessionRepository,
  CapturedSessionSummaryRecord,
  CollaborationMessageRecord,
  CollaborationRepository,
  CollaborationThreadRecord,
  CrossIdentitySyncRelationshipRecord
} from "@koed/db";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationSafeErrorMessages
} from "@koed/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { registerCollaborationCommandRoute } from "./collaboration-command.js";
import type { CollaborationActionGrantControl } from "./collaboration-action-grant-control.js";
import type { CollaborationSharedMemoryControl } from "./collaboration-shared-memory-control.js";
import type { SourceSyncRelationshipRepository } from "../cross-identity-sync/source-relationship-service.js";
import type { LocalEdgeUpstreamBackend } from "./upstream-routing.js";

const localAuthorization = "Koed-Device local-client:local-secret";
const desktopAuthorization = `Koed-Desktop koed_desktop_${"a".repeat(40)}:${"b".repeat(43)}`;
const upstreamAuthorization = "Koed-Device upstream-device:upstream-secret";
const iso = "2026-07-17T00:00:00.000Z";

type CollaborationRendererCommand = {
  contractVersion: number;
  requestId: string;
  command: string;
  input: Record<string, unknown>;
};

const ids = {
  request: randomUUID(),
  team: randomUUID(),
  workspace: randomUUID(),
  thread: randomUUID(),
  logicalThread: randomUUID(),
  actor: randomUUID(),
  participant: randomUUID(),
  participantTwo: randomUUID(),
  remotePrincipal: randomUUID(),
  membership: randomUUID(),
  message: randomUUID(),
  messageTwo: randomUUID(),
  messageThree: randomUUID(),
  clientMessage: randomUUID(),
  personalThread: randomUUID(),
  personalLogicalThread: randomUUID(),
  notesThread: randomUUID(),
  notesLogicalThread: randomUUID(),
  personalMessageTwo: randomUUID(),
  sharedGrant: randomUUID(),
  sharedLogicalMemory: randomUUID(),
  sharedDiscussionThread: randomUUID(),
  sharedDiscussionLogicalThread: randomUUID(),
  sharedSourceItem: randomUUID(),
  otherOwner: randomUUID(),
  session: randomUUID(),
  localDeployment: randomUUID(),
  localProtocolDeployment: randomUUID(),
  remoteDeployment: randomUUID(),
  remoteProtocolDeployment: randomUUID(),
  remoteExternalUser: randomUUID()
};

const teamThreadBase = {
  id: ids.thread,
  logicalId: ids.logicalThread,
  scope: "team" as const,
  version: 1,
  lifecycle: "active" as const,
  canPost: true,
  latestSequence: 0,
  unreadCount: 0,
  lastReadMessageId: null,
  lastReadSequence: 0,
  createdAt: iso,
  updatedAt: iso,
  lastActivityAt: iso,
  archivedAt: null,
  teamId: ids.team
};

const teamThread = {
  ...teamThreadBase,
  kind: "workspace_channel" as const,
  name: "General",
  topic: null,
  workspaceId: ids.workspace
};

const teamMessage = {
  id: ids.message,
  threadId: ids.thread,
  scope: "team" as const,
  teamId: ids.team,
  sequence: 1,
  sender: {
    id: ids.participant,
    displayName: "Alice",
    membershipState: "enabled" as const
  },
  senderKind: "user" as const,
  body: "hello",
  createdAt: iso,
  updatedAt: iso,
  editedAt: null,
  deletedAt: null,
  delivery: "sent" as const,
  recipientStatus: "sent" as const,
  failure: null
};

const teamMessageAt = (sequence: number) => ({
  ...teamMessage,
  id:
    sequence === 1
      ? ids.message
      : sequence === 2
        ? ids.messageTwo
        : ids.messageThree,
  sequence,
  body: `team message ${sequence}`
});

const sharedDiscussionThread = {
  ...teamThreadBase,
  id: ids.sharedDiscussionThread,
  logicalId: ids.sharedDiscussionLogicalThread,
  kind: "shared_session_discussion" as const,
  name: "Shared discussion",
  topic: null,
  workspaceId: ids.workspace,
  sharedLogicalMemoryId: ids.sharedLogicalMemory,
  shareGrantId: ids.sharedGrant,
  latestSequence: 1,
  unreadCount: 1
};

const sharedDiscussionMessage = {
  ...teamMessage,
  id: ids.messageThree,
  threadId: ids.sharedDiscussionThread,
  sequence: 1,
  body: "Discuss the shared source."
};

const sharedSourcePage = {
  snapshotRevision: `ssr1.${"a".repeat(64)}`,
  olderCursor: null,
  newerCursor: null,
  hasOlder: false,
  hasNewer: false,
  sharedSessionId: ids.sharedGrant,
  representation: "memory_events" as const,
  items: [
    {
      id: ids.sharedSourceItem,
      representation: "memory_events" as const,
      sequence: 1,
      occurredAt: iso,
      sourceItems: [
        {
          id: ids.sharedSourceItem,
          sourceKind: "user_message" as const,
          occurredAt: iso,
          body: "Use the exact authorized source representation.",
          actorName: null,
          toolName: null,
          toolCallId: null
        }
      ]
    }
  ]
};

const remoteTeam = {
  id: ids.team,
  name: "Product Team",
  version: 1,
  lifecycle: "active" as const
};

const remoteWorkspace = {
  id: ids.workspace,
  teamId: ids.team,
  name: "Electron Team App",
  description: null,
  version: 1,
  lifecycle: "active" as const,
  archivedAt: null
};

const remoteSharedGrant = {
  id: ids.sharedGrant,
  logicalMemoryId: ids.sharedLogicalMemory,
  ownerUserId: ids.participant,
  activeRepresentation: "memory_events",
  representationState: "available",
  representationSourceRevision: 7,
  representationUpdatedAt: iso,
  lifecycle: "active",
  createdAt: iso,
  updatedAt: iso,
  companionScope: {
    scope: "team",
    kind: "shared_session_discussion",
    teamId: ids.team,
    teamWorkspaceId: ids.workspace,
    logicalMemoryId: ids.sharedLogicalMemory,
    shareGrantId: ids.sharedGrant
  }
};

const directMessageThread = {
  ...teamThreadBase,
  kind: "dm" as const,
  name: null,
  topic: null,
  participants: [
    {
      id: ids.actor,
      displayName: "Alice",
      membershipState: "enabled" as const
    },
    {
      id: ids.participant,
      displayName: "Bob",
      membershipState: "enabled" as const
    }
  ]
};

const groupDirectMessageThread = {
  ...teamThreadBase,
  kind: "group_dm" as const,
  name: "Project group",
  topic: null,
  participants: [
    {
      id: ids.actor,
      displayName: "Alice",
      membershipState: "enabled" as const
    },
    {
      id: ids.participant,
      displayName: "Bob",
      membershipState: "enabled" as const
    },
    {
      id: ids.participantTwo,
      displayName: "Carol",
      membershipState: "enabled" as const
    }
  ]
};

const readState = {
  threadId: ids.thread,
  deliveredMessageId: ids.message,
  deliveredSequence: 1,
  deliveredAt: iso,
  messageId: ids.message,
  sequence: 1,
  readAt: iso,
  unreadCount: 0,
  version: 1,
  updatedAt: iso
};

const backend = (
  overrides: Partial<LocalEdgeUpstreamBackend> = {}
): LocalEdgeUpstreamBackend => ({
  id: "team-vps",
  baseUrl: "https://team.example.test/koed",
  routePolicy: {
    personalMemoryRead: "disabled",
    teamWorkspaceRead: "enabled",
    shareGrantManagement: "enabled",
    captureWrites: "disabled",
    sync: "enabled",
    admin: "enabled"
  },
  credential: { status: "configured" },
  capabilities: {
    state: "validated",
    expiresAt: "2099-01-01T00:15:00.000Z",
    schemaVersion: 6,
    payload: {
      capabilitySchemaVersion: 6,
      capabilities: {
        "memory.collaboration": { availability: "partial" }
      }
    }
  },
  ...overrides
});

const syncRecipientKey = {
  algorithm: "RSA-OAEP-SHA256" as const,
  keyId: "sync-recipient:test",
  keyVersion: 1,
  publicJwk: {
    kty: "RSA" as const,
    n: "test-modulus",
    e: "AQAB",
    alg: "RSA-OAEP-256" as const,
    key_ops: ["encrypt"] as ["encrypt"],
    ext: true as const,
    kid: "sync-recipient:test",
    use: "enc" as const
  }
};

const sourceSyncBackend = (): LocalEdgeUpstreamBackend =>
  backend({
    credential: {
      status: "configured",
      reference: "upstream-device:test"
    } as LocalEdgeUpstreamBackend["credential"] & { reference: string },
    capabilities: {
      state: "validated",
      expiresAt: "2099-01-01T00:15:00.000Z",
      schemaVersion: 6,
      payload: {
        capabilitySchemaVersion: 6,
        capabilities: {
          "memory.collaboration": { availability: "available" },
          "memory.crossIdentitySync": { availability: "available" }
        }
      }
    }
  });

type CreateSourceRelationshipInput = Parameters<
  SourceSyncRelationshipRepository["createSourceSyncRelationship"]
>[1];

const sourceRelationshipRecord = (
  input: CreateSourceRelationshipInput,
  localUserId: string,
  state: CrossIdentitySyncRelationshipRecord["state"]
): CrossIdentitySyncRelationshipRecord => ({
  id: input.relationshipId,
  logicalMemoryId: input.logicalMemoryId,
  side: "source",
  localReplicaId: input.localReplicaId,
  localUserId,
  remoteDeploymentIdentityId: input.remoteDeploymentIdentityId,
  remoteUserIdentityId: input.remoteUserIdentityId,
  remoteReplicaId: input.remoteReplicaId,
  sourceBoundary: "captured_session",
  syncMode: "live",
  state,
  idempotencyKey: input.idempotencyKey,
  creationRequestHash: input.creationRequestHash,
  policyManifest: input.policyManifest,
  consentManifest: input.consentManifest,
  sourceCursor: 0,
  targetProcessingCursor: 0,
  packageSequence: 0,
  lastPackageId: null,
  sourceSummaryRevisionHash: null,
  targetSummaryRevisionHash: null,
  lastSyncedAt: state === "ready" ? iso : null,
  staleAfter: null,
  pausedAt: state === "paused" ? iso : null,
  stateBeforePause: state === "paused" ? "ready" : null,
  revokedAt: null,
  revocationId: null
});

const createSourceRepository = (
  ownerUserId = ids.actor,
  summaryOverrides: Partial<CapturedSessionSummaryRecord> = {}
) => {
  const createInputs: CreateSourceRelationshipInput[] = [];
  const sourceActors: string[] = [];
  const summaryActors: string[] = [];
  const activationActors: string[] = [];
  const retryActors: string[] = [];
  let relationship: CrossIdentitySyncRelationshipRecord | null = null;
  let logicalMemoryId: string | null = null;
  const summary = (): CapturedSessionSummaryRecord => ({
    sessionId: ids.session,
    logicalMemoryId,
    title: "Architecture review",
    projectName: "koed_team_conversations",
    updatedAt: iso,
    eventCount: 7,
    hasSynchronizedRevision: relationship?.lastSyncedAt !== null,
    syncState:
      relationship?.state === "ready"
        ? "ready"
        : relationship?.state === "paused"
          ? "paused"
          : relationship?.state === "revoked"
            ? "revoked"
            : "processing",
    ...summaryOverrides
  });
  const repository: CommandRepository = {
    ...createPersonalRepository(),
    getCapturedSessionSyncSource: async (actor, sessionId) => {
      sourceActors.push(actor.userId);
      return actor.userId === ownerUserId && sessionId === ids.session
        ? {
            originSessionId: ids.session,
            externalSessionId: "codex-session",
            sourceRuntime: "codex",
            captureMethod: "transcript",
            capturedAt: iso,
            title: "Architecture review",
            sourceAdapterVersion: "1.0.0"
          }
        : null;
    },
    listCapturedSessionSummaries: async (actor) => {
      summaryActors.push(actor.userId);
      return actor.userId === ownerUserId ? [summary()] : [];
    },
    createSourceSyncRelationship: async (actor, input) => {
      if (actor.userId !== ownerUserId || input.sessionId !== ids.session) {
        return null;
      }
      createInputs.push(input);
      logicalMemoryId = input.logicalMemoryId;
      relationship ??= sourceRelationshipRecord(input, ownerUserId, "paused");
      return {
        relationship,
        logicalMemory: {
          id: input.logicalMemoryId,
          ownerUserId,
          ownerPrincipalId: ownerUserId,
          originDeploymentIdentityId: input.localDeploymentIdentityId,
          sourceBoundary: "captured_session",
          originSourceId: input.sessionId,
          localSessionId: input.sessionId,
          logicalKey: `captured-session:${input.sessionId}`
        },
        localReplica: {
          id: input.localReplicaId,
          logicalMemoryId: input.logicalMemoryId,
          deploymentIdentityId: input.localDeploymentIdentityId,
          ownerUserId,
          ownerPrincipalId: ownerUserId,
          replicaRole: "source",
          localSessionId: input.sessionId,
          freshnessStatus: "fresh"
        }
      };
    },
    activateSourceSyncRelationship: async (input) => {
      activationActors.push(input.localUserId);
      if (
        !relationship ||
        input.localUserId !== ownerUserId ||
        input.relationshipId !== relationship.id ||
        relationship.state === "failed" ||
        relationship.revokedAt
      ) {
        return null;
      }
      relationship = { ...relationship, state: "ready", lastSyncedAt: iso };
      return relationship;
    },
    retryCrossIdentitySyncRelationship: async (actor, relationshipId) => {
      retryActors.push(actor.userId);
      if (
        actor.userId !== ownerUserId ||
        !relationship ||
        relationship.id !== relationshipId ||
        relationship.state !== "failed" ||
        relationship.revokedAt
      ) {
        return null;
      }
      relationship = {
        ...relationship,
        state: "created",
        lastSyncedAt: null
      };
      return relationship;
    },
    getSourceSyncRelationshipForSession: async (actor, sessionId) =>
      actor.userId === ownerUserId && sessionId === ids.session
        ? relationship
        : null,
    pauseCrossIdentitySyncRelationship: async (actor, relationshipId) => {
      if (
        actor.userId !== ownerUserId ||
        !relationship ||
        relationship.id !== relationshipId ||
        relationship.revokedAt
      ) {
        return null;
      }
      relationship = {
        ...relationship,
        stateBeforePause:
          relationship.state === "paused"
            ? relationship.stateBeforePause
            : relationship.state,
        state: "paused",
        pausedAt: relationship.pausedAt ?? iso
      };
      return relationship;
    },
    resumeCrossIdentitySyncRelationship: async (actor, relationshipId) => {
      if (
        actor.userId !== ownerUserId ||
        !relationship ||
        relationship.id !== relationshipId ||
        relationship.state !== "paused" ||
        relationship.revokedAt
      ) {
        return null;
      }
      relationship = {
        ...relationship,
        state: relationship.stateBeforePause ?? "ready",
        stateBeforePause: null,
        pausedAt: null
      };
      return relationship;
    },
    revokeCrossIdentitySyncRelationship: async (actor, input) => {
      if (
        actor.userId !== ownerUserId ||
        !relationship ||
        relationship.id !== input.syncRelationshipId ||
        relationship.revokedAt
      ) {
        return null;
      }
      relationship = {
        ...relationship,
        state: "revoked",
        pausedAt: null,
        stateBeforePause: null,
        revokedAt: iso,
        revocationId: randomUUID()
      };
      return relationship;
    }
  };
  return {
    repository,
    createInputs,
    sourceActors,
    summaryActors,
    activationActors,
    retryActors,
    failRelationship: () => {
      if (relationship) relationship = { ...relationship, state: "failed" };
    },
    relationship: () => relationship
  };
};

const sourceSyncResponse = (
  source: ReturnType<typeof createSourceRepository>,
  call: FetchCall
): Response => {
  const path = new URL(call.url).pathname.replace(/^\/koed/, "");
  if (path === "/v1/cross-identity-sync/intake/context") {
    return Response.json({
      target_deployment_id: ids.remoteProtocolDeployment,
      target_deployment_profile: "team_self_hosted",
      target_user_id: ids.remotePrincipal,
      recipient_key: syncRecipientKey
    });
  }
  if (path === "/v1/cross-identity-sync/intake/relationships") {
    const created = source.createInputs.at(-1);
    if (!created) return Response.json({}, { status: 500 });
    return Response.json({
      relationship: { id: created.relationshipId, state: "ready" },
      target_deployment_id: ids.remoteProtocolDeployment,
      target_deployment_profile: "team_self_hosted",
      target_user_id: ids.remotePrincipal,
      target_replica_id: created.remoteReplicaId,
      recipient_key: syncRecipientKey
    });
  }
  return Response.json({}, { status: 404 });
};

const prepareSourceCommand = (
  requestId = randomUUID()
): CollaborationRendererCommand => ({
  contractVersion: COLLABORATION_CONTRACT_VERSION,
  requestId,
  command: "collaboration.prepare_shared_memory_source",
  input: { sessionId: ids.session, consentedAt: iso }
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

const personalThreadRecord = (
  overrides: Partial<CollaborationThreadRecord> = {}
): CollaborationThreadRecord => ({
  id: ids.personalThread,
  logicalId: ids.personalLogicalThread,
  scope: "personal",
  kind: "personal_channel",
  personalOwnerUserId: ids.actor,
  teamId: null,
  teamWorkspaceId: null,
  sharedLogicalMemoryId: null,
  shareGrantId: null,
  systemKey: null,
  name: "Personal",
  topic: null,
  createdByUserId: ids.actor,
  version: 1,
  lifecycle: "active",
  latestSequence: 3,
  lastReadMessageId: null,
  lastReadSequence: 0,
  unreadCount: 3,
  participants: [],
  createdAt: iso,
  updatedAt: iso,
  lastActivityAt: iso,
  archivedAt: null,
  ...overrides
});

const personalMessageRecord = (
  sequence: number,
  overrides: Partial<CollaborationMessageRecord> = {}
): CollaborationMessageRecord => ({
  id:
    sequence === 1
      ? ids.message
      : sequence === 2
        ? ids.personalMessageTwo
        : ids.clientMessage,
  threadId: ids.personalThread,
  threadSequence: sequence,
  audienceVersion: 1,
  scope: "personal",
  personalOwnerUserId: ids.actor,
  teamId: null,
  teamWorkspaceId: null,
  senderKind: "user",
  senderPrincipalId: ids.actor,
  senderUserId: ids.actor,
  senderDisplayName: "Alice",
  recipientStatus: "sent",
  bodyText: `message ${sequence}`,
  metadata: {},
  provenance: { kind: "user", id: ids.actor },
  createdAt: iso,
  updatedAt: iso,
  ...overrides
});

type CommandRepository = CollaborationRepository &
  Pick<CapturedSessionRepository, "listCapturedSessionSummaries"> &
  SourceSyncRelationshipRepository;

const createPersonalRepository = (): CommandRepository => {
  let channel = personalThreadRecord();
  const notes = personalThreadRecord({
    id: ids.notesThread,
    logicalId: ids.notesLogicalThread,
    kind: "notes_to_self",
    name: null,
    topic: null,
    latestSequence: 0,
    unreadCount: 0,
    participants: [{ userId: ids.actor, displayName: "Alice" }]
  });
  const messages = [1, 2, 3].map((sequence) => personalMessageRecord(sequence));
  const ownedThread = (actor: { userId: string }, threadId: string) =>
    actor.userId === ids.actor
      ? ([notes, channel].find((thread) => thread.id === threadId) ?? null)
      : null;

  return {
    listTeamParticipants: async () => null,
    createThread: async (actor, input) => {
      if (actor.userId !== ids.actor) return null;
      if (input.kind === "notes_to_self") return notes;
      if (input.kind !== "personal_channel") return null;
      channel = personalThreadRecord({
        name: input.name,
        topic: input.topic ?? null
      });
      return channel;
    },
    getThread: async (actor, input) => ownedThread(actor, input.threadId),
    listThreads: async (actor, input) =>
      actor.userId === ids.actor && input.scope === "personal"
        ? [notes, channel]
        : null,
    renameThread: async (actor, input) => {
      if (!ownedThread(actor, input.threadId)) return null;
      channel = { ...channel, name: input.name, version: channel.version + 1 };
      return channel;
    },
    updateThreadTopic: async (actor, input) => {
      if (!ownedThread(actor, input.threadId)) return null;
      channel = {
        ...channel,
        topic: input.topic,
        version: channel.version + 1
      };
      return channel;
    },
    archiveThread: async (actor, input) => {
      if (!ownedThread(actor, input.threadId)) return null;
      channel = {
        ...channel,
        lifecycle: "archived",
        archivedAt: iso,
        version: channel.version + 1
      };
      return channel;
    },
    restoreThread: async (actor, input) => {
      if (!ownedThread(actor, input.threadId)) return null;
      channel = {
        ...channel,
        lifecycle: "active",
        archivedAt: null,
        version: channel.version + 1
      };
      return channel;
    },
    sendMessage: async (actor, input) =>
      ownedThread(actor, input.threadId)
        ? personalMessageRecord(4, {
            id: input.idempotencyKey,
            bodyText: input.bodyText
          })
        : null,
    listMessages: async (actor, input) => {
      const thread = ownedThread(actor, input.threadId);
      if (!thread) return null;
      if (thread.kind === "notes_to_self") {
        return {
          messages: [],
          hasMore: false,
          nextBeforeSequence: null,
          nextAfterSequence: null
        };
      }
      const ascending = input.afterSequence !== undefined;
      const filtered = messages.filter(
        (message) =>
          message.threadSequence > (input.afterSequence ?? 0) &&
          (input.beforeSequence === undefined ||
            message.threadSequence < input.beforeSequence)
      );
      const ordered = ascending ? filtered : [...filtered].reverse();
      const limit = input.limit ?? 50;
      const selected = ordered.slice(0, limit);
      if (!ascending) selected.reverse();
      return {
        messages: selected,
        hasMore: ordered.length > limit,
        nextBeforeSequence: selected[0]?.threadSequence ?? null,
        nextAfterSequence: selected.at(-1)?.threadSequence ?? null
      };
    },
    advanceReadState: async (actor, input) =>
      ownedThread(actor, input.threadId)
        ? {
            threadId: input.threadId,
            userId: actor.userId,
            lastDeliveredMessageId: input.messageId,
            lastDeliveredSequence: 1,
            lastDeliveredAt: iso,
            lastReadMessageId: input.messageId,
            lastReadSequence: 1,
            lastReadAt: iso,
            unreadCount: 0,
            version: 1,
            updatedAt: iso
          }
        : null,
    advanceDeliveryState: async (actor, input) =>
      ownedThread(actor, input.threadId)
        ? {
            threadId: input.threadId,
            userId: actor.userId,
            lastDeliveredMessageId: input.messageId,
            lastDeliveredSequence: 1,
            lastDeliveredAt: iso,
            lastReadMessageId: null,
            lastReadSequence: 0,
            lastReadAt: null,
            unreadCount: 1,
            version: 1,
            updatedAt: iso
          }
        : null,
    getAuthorizedSnapshot: async (actor, input) =>
      actor.userId === ids.actor && input.scope === "personal"
        ? {
            scope: "personal",
            personalOwnerUserId: ids.actor,
            teamId: null,
            highWaterCursor: 9,
            threads: [notes, channel]
          }
        : null,
    getCapturedSessionSyncSource: async () => null,
    ensureLocalSyncDeployment: async () => ({
      id: ids.localDeployment,
      protocolDeploymentId: ids.localProtocolDeployment,
      locality: "local",
      profile: "developer",
      baseUrl: null,
      upstreamBackendId: null
    }),
    upsertRemoteSyncDeployment: async (input) => ({
      id: ids.remoteDeployment,
      protocolDeploymentId: input.protocolDeploymentId,
      locality: "remote",
      profile: input.profile,
      baseUrl: input.baseUrl ?? null,
      upstreamBackendId: input.upstreamBackendId ?? null
    }),
    upsertExternalSyncUserIdentity: async (input) => ({
      id: ids.remoteExternalUser,
      deploymentIdentityId: input.deploymentIdentityId,
      externalSubjectId: input.externalSubjectId,
      status: "active"
    }),
    linkExternalSyncUser: async () => undefined,
    createSourceSyncRelationship: async () => null,
    activateSourceSyncRelationship: async () => null,
    getSourceSyncRelationshipForSession: async () => null,
    pauseCrossIdentitySyncRelationship: async () => null,
    resumeCrossIdentitySyncRelationship: async () => null,
    listCapturedSessionSummaries: async () => [],
    replayEvents: async () => null,
    pruneExpiredReplayHistory: async () => ({
      deletedEventCount: 0,
      deletedSubscriptionCount: 0
    }),
    createSubscription: async (actor, input) =>
      actor.userId === ids.actor && input.scope === "personal"
        ? {
            id: ids.request,
            protocolVersion: COLLABORATION_CONTRACT_VERSION,
            scope: "personal",
            personalOwnerUserId: ids.actor,
            teamId: null,
            state: "active",
            snapshotHighWaterCursor: input.snapshotHighWaterCursor,
            acknowledgedEventId: null,
            acknowledgedCursor: 0,
            createdAt: iso,
            updatedAt: iso,
            lastAcknowledgedAt: null,
            expiresAt: input.expiresAt.toISOString(),
            revokedAt: null
          }
        : null,
    recoverSubscription: async () => null,
    acknowledgeSubscription: async () => null,
    revokeSubscriptions: async () => ({ revokedCount: 0 }),
    retryCrossIdentitySyncRelationship: async () => null,
    revokeCrossIdentitySyncRelationship: async () => null
  };
};

interface HarnessOptions {
  teamCollaborationEnabled?: boolean;
  backend?: LocalEdgeUpstreamBackend | null;
  registryBackends?: LocalEdgeUpstreamBackend[];
  activeBackendId?: string | null;
  localFamilies?: string[];
  upstreamAuthorization?: string | null;
  response?: (call: FetchCall) => Promise<Response> | Response;
  personalRepository?: CommandRepository;
  desktopOwnerUserId?: string;
  activeUser?: { id: string; email: string; displayName: string | null } | null;
  actionGrantControl?: CollaborationActionGrantControl;
  sharedMemoryControl?: CollaborationSharedMemoryControl;
}

const resultPayloadFor = (
  command: CollaborationRendererCommand
): Record<string, unknown> => {
  if (
    command.command === "collaboration.send_message" ||
    command.command === "collaboration.retry_message"
  ) {
    return { message: teamMessage };
  }
  if (
    command.command === "collaboration.mark_read" ||
    command.command === "collaboration.mark_delivered"
  ) {
    return { readState };
  }
  if (command.command === "collaboration.start_direct_message") {
    return { thread: directMessageThread };
  }
  if (command.command === "collaboration.start_group_direct_message") {
    return { thread: groupDirectMessageThread };
  }
  if (command.command === "collaboration.rename_thread") {
    return { thread: { ...teamThread, name: command.input.name } };
  }
  if (command.command === "collaboration.update_thread_topic") {
    return { thread: { ...teamThread, topic: command.input.topic } };
  }
  if (command.command === "collaboration.archive_thread") {
    return {
      thread: {
        ...teamThread,
        lifecycle: "archived",
        canPost: false,
        archivedAt: iso
      }
    };
  }
  return { thread: teamThread };
};

const createHarness = (options: HarnessOptions = {}) => {
  const app = Fastify();
  const calls: FetchCall[] = [];
  const localCredentialReads: string[] = [];
  let repositoryRequests = 0;
  const configuredBackend =
    options.backend === undefined ? backend() : options.backend;
  const registryBackends =
    options.registryBackends ?? (configuredBackend ? [configuredBackend] : []);
  const localFamilies = options.localFamilies ?? [
    "team_workspace_read",
    "team_chat_read",
    "team_chat_write"
  ];
  const fetchFn = (async (input, init = {}) => {
    const call = {
      url: input instanceof URL ? input.toString() : String(input),
      init
    };
    calls.push(call);
    return (
      (await options.response?.(call)) ?? Response.json({ thread: teamThread })
    );
  }) as typeof fetch;
  const personalRepository =
    options.personalRepository ?? createPersonalRepository();
  const desktopOwnerUserId = options.desktopOwnerUserId ?? ids.actor;
  let navigationInvalidationListener: ((backendId: string) => void) | null =
    null;

  app.setErrorHandler((error, _request, reply) => {
    const statusCodeCandidate =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : typeof statusCodeCandidate === "number"
          ? statusCodeCandidate
          : 500;
    reply.status(statusCode).send({
      error: error instanceof Error ? error.message : "Request failed"
    });
  });
  registerCollaborationCommandRoute(app, {
    deploymentProfile: "developer",
    resolveVerifiedLocalDeploymentId: () =>
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    teamCollaborationEnabled: options.teamCollaborationEnabled ?? true,
    koedHome: "/tmp/koed-command-test",
    upstreamBackendsPath: "/tmp/koed-command-test/upstream.json",
    corsOrigins: new Set(["http://localhost:5174"]),
    fetch: fetchFn,
    resolveUpstreamAuthorization: () =>
      options.upstreamAuthorization === undefined
        ? upstreamAuthorization
        : options.upstreamAuthorization,
    requireCollaborationRepository: () => {
      repositoryRequests += 1;
      return personalRepository;
    },
    resolveActiveLocalUser: async (userId) => {
      const activeUser =
        options.activeUser === undefined
          ? { id: ids.actor, email: "alice@example.test", displayName: "Alice" }
          : options.activeUser;
      return activeUser?.id === userId ? activeUser : null;
    },
    actionGrantControl: options.actionGrantControl,
    sharedMemoryControl: options.sharedMemoryControl,
    verifyDesktopLocalCredential: (_koedHome, authorization, family) =>
      authorization === desktopAuthorization
        ? {
            authorization: desktopAuthorization,
            credentialKeyId: `koed_desktop_${"a".repeat(40)}`,
            ownerUserId: desktopOwnerUserId,
            operationFamilies: [
              "personal_collaboration_read",
              "personal_collaboration_write"
            ].filter((candidate) => candidate === family) as Array<
              "personal_collaboration_read" | "personal_collaboration_write"
            >
          }
        : null,
    readLocalEdgeClientCredential: (_koedHome, backendId) => {
      localCredentialReads.push(backendId);
      return backendId === "team-vps"
        ? {
            authorization: localAuthorization,
            backendId: "team-vps",
            credentialKeyId: "local-client",
            operationFamilies: localFamilies
          }
        : null;
    },
    readUpstreamRegistry: () => ({
      schemaVersion: 2,
      activeBackendId:
        options.activeBackendId === undefined
          ? (configuredBackend?.id ?? null)
          : options.activeBackendId,
      backends: registryBackends
    }),
    subscribeRemoteNavigationInvalidation: (listener) => {
      navigationInvalidationListener = listener;
      return () => {
        navigationInvalidationListener = null;
      };
    }
  });
  return {
    app,
    calls,
    localCredentialReads,
    repositoryRequests: () => repositoryRequests,
    invalidateRemoteNavigation: (backendId = "team-vps") => {
      navigationInvalidationListener?.(backendId);
    }
  };
};

const commandRequest = (command: CollaborationRendererCommand) => ({
  upstream_backend_id: "team-vps",
  command
});

const personalCommandRequest = (command: CollaborationRendererCommand) => ({
  command
});

const injectCommand = (
  app: ReturnType<typeof Fastify>,
  command: CollaborationRendererCommand,
  authorization = desktopAuthorization
) =>
  app.inject({
    method: "POST",
    url: "/v1/local-edge/collaboration/command",
    headers: {
      authorization,
      host: "localhost:3300"
    },
    payload: commandRequest(command)
  });

const injectPersonalCommand = (
  app: ReturnType<typeof Fastify>,
  command: CollaborationRendererCommand,
  authorization = desktopAuthorization
) =>
  app.inject({
    method: "POST",
    url: "/v1/local-edge/collaboration/command",
    headers: { authorization, host: "localhost:3300" },
    payload: personalCommandRequest(command)
  });

type MessagePageTestResult = {
  ok: boolean;
  command: string;
  data: { page: { olderCursor: string | null } };
};

type LoadTestResult = {
  ok: boolean;
  command: string;
  data: {
    snapshot: {
      teamPresenceStatusCatalogue: {
        version: number;
        statuses: Array<{ key: string; label: string }>;
      };
      navigation: {
        personalOwner: { id: string };
        teamPrincipal: { id: string } | null;
        teams: Array<{
          id: string;
          role: string;
          directMessages: Array<{ id: string }>;
          people: Array<{
            id: string;
            teamPresence: { manualStatus: string };
          }>;
          workspaces: Array<{
            id: string;
            access: string;
            lifecycle: "active" | "archived" | "purged";
            channels: Array<{ id: string }>;
            sharedMemory: Array<{
              id: string;
              logicalMemoryId: string;
              companionThreadId: string;
              unreadCompanionCount: number;
            }>;
          }>;
        }>;
      };
    };
  };
};

const collaborationResultValidator: {
  parse(value: unknown): unknown;
} = collaborationCommandResultSchema;
const collaborationCommandValidator: {
  parse(value: unknown): unknown;
} = collaborationRendererCommandSchema;

const parseResultAs = <T>(body: string): T =>
  collaborationResultValidator.parse(JSON.parse(body)) as T;

const parseResult = (body: string): unknown => parseResultAs<unknown>(body);

const parseCommand = (command: unknown): CollaborationRendererCommand =>
  collaborationCommandValidator.parse(command) as CollaborationRendererCommand;

const remotePresence = {
  presence: "available" as const,
  teamPresence: {
    mode: "auto" as const,
    manualStatus: "available" as const,
    activityLevel: "active" as const,
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    nextTransitionAt: "2026-07-01T00:05:00.001Z",
    preferenceVersion: 1
  }
};

const remoteNavigationPayload = (input?: {
  threads?: unknown[];
  workspaces?: unknown[];
}) => ({
  principal: {
    id: ids.remotePrincipal,
    email: "remote-alice@example.test",
    displayName: "Remote Alice"
  },
  teamPresenceStatusCatalogue: {
    version: 1,
    statuses: [
      { key: "available", label: "Available" },
      { key: "do_not_disturb", label: "Do not disturb" },
      { key: "out_of_office", label: "Out of office" }
    ]
  },
  teams: [
    {
      team: remoteTeam,
      membership: {
        teamId: ids.team,
        userId: ids.remotePrincipal,
        role: "member",
        status: "enabled",
        version: 1
      },
      members: [
        {
          userId: ids.remotePrincipal,
          displayName: "Remote Alice",
          status: "enabled",
          ...remotePresence
        },
        {
          userId: ids.participant,
          displayName: "Bob",
          status: "enabled",
          ...remotePresence
        }
      ],
      threads: input?.threads ?? [
        teamThread,
        directMessageThread,
        sharedDiscussionThread
      ],
      highWaterCursor: 3,
      workspaces: input?.workspaces ?? [
        {
          teamWorkspace: remoteWorkspace,
          access: {
            teamWorkspaceId: ids.workspace,
            teamId: ids.team,
            userId: ids.remotePrincipal,
            access: "write",
            canRecall: true
          },
          shareGrants: [remoteSharedGrant]
        }
      ]
    }
  ]
});

const remoteCompositionResponse = (call: FetchCall): Response => {
  const url = new URL(call.url);
  const path = url.pathname.replace(/^\/koed/, "");
  if (path === "/v1/local-edge/device-credentials/status") {
    return Response.json({
      ok: true,
      auth: "device_credential",
      user: {
        id: ids.remotePrincipal,
        email: "remote-alice@example.test",
        displayName: "Remote Alice"
      },
      credential: {
        id: randomUUID(),
        ownerUserId: ids.remotePrincipal,
        operationFamilies: [
          "team_workspace_read",
          "team_chat_read",
          "team_chat_write"
        ]
      }
    });
  }
  if (path === "/v1/teams/navigation") {
    return Response.json(remoteNavigationPayload());
  }
  if (path === "/v1/teams") {
    return Response.json({ teams: [remoteTeam] });
  }
  if (path === `/v1/teams/${ids.team}/membership`) {
    return Response.json({
      membership: {
        teamId: ids.team,
        userId: ids.remotePrincipal,
        role: "member",
        status: "enabled",
        version: 1
      }
    });
  }
  if (path === `/v1/teams/${ids.team}/members`) {
    return Response.json({
      members: [
        {
          userId: ids.remotePrincipal,
          displayName: "Remote Alice",
          status: "enabled",
          ...remotePresence
        },
        {
          userId: ids.participant,
          displayName: "Bob",
          status: "enabled",
          ...remotePresence
        }
      ]
    });
  }
  if (path === `/v1/teams/${ids.team}/workspaces`) {
    return Response.json({ teamWorkspaces: [remoteWorkspace] });
  }
  if (path === `/v1/team-workspaces/${ids.workspace}/access`) {
    return Response.json({
      access: {
        teamWorkspaceId: ids.workspace,
        teamId: ids.team,
        userId: ids.remotePrincipal,
        access: "write",
        canRecall: true
      }
    });
  }
  if (path === `/v1/collaboration/teams/${ids.team}/threads`) {
    return Response.json({
      threads: [teamThread, directMessageThread, sharedDiscussionThread]
    });
  }
  if (
    path ===
    `/v1/shared-memory/teams/${ids.team}/workspaces/${ids.workspace}/share-grants`
  ) {
    return Response.json({
      shareGrants: [remoteSharedGrant],
      pagination: { limit: 100, offset: 0, hasMore: false, nextOffset: null }
    });
  }
  if (path === `/v1/collaboration/teams/${ids.team}/threads/${ids.thread}`) {
    return Response.json({ thread: { ...teamThread, latestSequence: 3 } });
  }
  if (
    path ===
    `/v1/collaboration/teams/${ids.team}/threads/${ids.sharedDiscussionThread}`
  ) {
    return Response.json({ thread: sharedDiscussionThread });
  }
  const threadMatch = path.match(
    new RegExp(`^/v1/collaboration/teams/${ids.team}/threads/([^/]+)$`)
  );
  if (threadMatch) {
    return Response.json({
      thread: { ...teamThread, id: threadMatch[1]!, latestSequence: 3 }
    });
  }
  if (
    path ===
    `/v1/collaboration/teams/${ids.team}/threads/${ids.thread}/messages`
  ) {
    const before = Number(url.searchParams.get("beforeSequence") ?? 4);
    const sequence = Math.max(1, before - 1);
    return Response.json({
      messages: [teamMessageAt(sequence)],
      hasMore: sequence > 1,
      nextBeforeSequence: sequence,
      nextAfterSequence: sequence
    });
  }
  if (
    path ===
    `/v1/collaboration/teams/${ids.team}/threads/${ids.sharedDiscussionThread}/messages`
  ) {
    return Response.json({
      messages: [sharedDiscussionMessage],
      hasMore: false,
      nextBeforeSequence: null,
      nextAfterSequence: null
    });
  }
  return Response.json({ thread: teamThread });
};

const supportedMappings: Array<{
  command: CollaborationRendererCommand;
  method: string;
  path: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
}> = [
  {
    command: {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.create_workspace_channel",
      input: {
        teamId: ids.team,
        workspaceId: ids.workspace,
        name: "General",
        topic: null
      }
    },
    method: "POST",
    path: `/koed/v1/collaboration/teams/${ids.team}/workspaces/${ids.workspace}/channels`,
    body: { name: "General", topic: null },
    idempotencyKey: ids.request
  },
  {
    command: {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.start_direct_message",
      input: { teamId: ids.team, participantUserId: ids.participant }
    },
    method: "POST",
    path: `/koed/v1/collaboration/teams/${ids.team}/direct-messages`,
    body: { participantUserId: ids.participant },
    idempotencyKey: ids.request
  },
  {
    command: {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.start_group_direct_message",
      input: {
        teamId: ids.team,
        participantUserIds: [ids.participant, ids.participantTwo]
      }
    },
    method: "POST",
    path: `/koed/v1/collaboration/teams/${ids.team}/group-direct-messages`,
    body: { participantUserIds: [ids.participant, ids.participantTwo] },
    idempotencyKey: ids.request
  },
  {
    command: {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.rename_thread",
      input: {
        thread: { scope: "team", teamId: ids.team, threadId: ids.thread },
        name: "Renamed",
        expectedVersion: 1
      }
    },
    method: "PATCH",
    path: `/koed/v1/collaboration/teams/${ids.team}/threads/${ids.thread}/name`,
    body: { name: "Renamed", expectedVersion: 1 }
  },
  {
    command: {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.update_thread_topic",
      input: {
        thread: { scope: "team", teamId: ids.team, threadId: ids.thread },
        topic: "Topic",
        expectedVersion: 1
      }
    },
    method: "PATCH",
    path: `/koed/v1/collaboration/teams/${ids.team}/threads/${ids.thread}/topic`,
    body: { topic: "Topic", expectedVersion: 1 }
  },
  ...(["archive", "restore"] as const).map((action) => ({
    command: {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: `collaboration.${action}_thread` as const,
      input: {
        thread: {
          scope: "team" as const,
          teamId: ids.team,
          threadId: ids.thread
        },
        expectedVersion: 1
      }
    } as CollaborationRendererCommand,
    method: "POST",
    path: `/koed/v1/collaboration/teams/${ids.team}/threads/${ids.thread}/${action}`,
    body: { expectedVersion: 1 }
  })),
  {
    command: {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.send_message",
      input: {
        thread: { scope: "team", teamId: ids.team, threadId: ids.thread },
        clientMessageId: ids.clientMessage,
        body: "hello"
      }
    },
    method: "POST",
    path: `/koed/v1/collaboration/teams/${ids.team}/threads/${ids.thread}/messages`,
    body: { bodyText: "hello" },
    idempotencyKey: ids.clientMessage
  },
  {
    command: {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.mark_read",
      input: {
        thread: { scope: "team", teamId: ids.team, threadId: ids.thread },
        messageId: ids.message
      }
    },
    method: "PUT",
    path: `/koed/v1/collaboration/teams/${ids.team}/threads/${ids.thread}/read-state`,
    body: { messageId: ids.message }
  },
  {
    command: {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.mark_delivered",
      input: {
        thread: { scope: "team", teamId: ids.team, threadId: ids.thread },
        messageId: ids.message
      }
    },
    method: "PUT",
    path: `/koed/v1/collaboration/teams/${ids.team}/threads/${ids.thread}/delivery-state`,
    body: { messageId: ids.message }
  },
  {
    command: {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.retry_message",
      input: {
        thread: { scope: "team", teamId: ids.team, threadId: ids.thread },
        clientMessageId: ids.clientMessage,
        body: "hello"
      }
    },
    method: "POST",
    path: `/koed/v1/collaboration/teams/${ids.team}/threads/${ids.thread}/messages`,
    body: { bodyText: "hello" },
    idempotencyKey: ids.clientMessage
  }
];

describe("local-edge collaboration command route", () => {
  it("authorizes browser-confirmed actions from the remote device credential without exposing them to the local AI-client credential", async () => {
    const actionGrantId = randomUUID();
    const dispatchedFamilies: string[][] = [];
    const actionGrantControl: CollaborationActionGrantControl = {
      describeIntent: (_backend, intent) => ({
        operationFamily: "admin",
        action: "team.create",
        teamId: null,
        targetId: null,
        method: "POST",
        path: "/v1/teams",
        body: { name: "Product Team" },
        idempotencyKey: intent.commandRequestId
      }),
      dispatch: async (command, context) => {
        dispatchedFamilies.push([...context.operationFamilies]);
        const parsed = collaborationRendererCommandSchema.parse(command);
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: parsed.requestId,
          command: "collaboration.request_action_grant",
          ok: true,
          data: {
            status: {
              version: 1,
              actionGrant: { id: actionGrantId },
              state: "pending",
              activationUrl: "https://team.example.test/action-grant",
              expiresAt: "2099-01-01T00:05:00.000Z"
            }
          }
        });
      },
      resolveSecret: async () => null
    };
    const harness = createHarness({
      actionGrantControl,
      response: (call) => {
        expect(new URL(call.url).pathname).toBe(
          "/v1/local-edge/device-credentials/status"
        );
        return Response.json({
          ok: true,
          auth: "device_credential",
          user: {
            id: ids.remotePrincipal,
            email: "remote-alice@example.test",
            displayName: "Remote Alice"
          },
          credential: {
            id: randomUUID(),
            ownerUserId: ids.remotePrincipal,
            operationFamilies: ["action_grant"]
          }
        });
      }
    });

    const response = await injectCommand(harness.app, {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.request_action_grant",
      input: {
        intent: {
          intent: "collaboration.create_team",
          commandRequestId: randomUUID(),
          name: "Product Team"
        }
      }
    } as CollaborationRendererCommand);

    expect(parseResult(response.body)).toMatchObject({
      ok: true,
      data: { status: { actionGrant: { id: actionGrantId } } }
    });
    expect(dispatchedFamilies).toEqual([["action_grant"]]);
    expect(harness.localCredentialReads).toEqual([]);
  });

  it("fails closed when the remote device credential lacks the browser-confirmed action family", async () => {
    let dispatched = false;
    const actionGrantControl: CollaborationActionGrantControl = {
      describeIntent: (_backend, intent) => ({
        operationFamily: "admin",
        action: "team.create",
        teamId: null,
        targetId: null,
        method: "POST",
        path: "/v1/teams",
        body: { name: "Product Team" },
        idempotencyKey: intent.commandRequestId
      }),
      dispatch: async () => {
        dispatched = true;
        return null;
      },
      resolveSecret: async () => null
    };
    const harness = createHarness({
      actionGrantControl,
      response: () =>
        Response.json({
          ok: true,
          auth: "device_credential",
          user: {
            id: ids.remotePrincipal,
            email: "remote-alice@example.test",
            displayName: "Remote Alice"
          },
          credential: {
            id: randomUUID(),
            ownerUserId: ids.remotePrincipal,
            operationFamilies: ["team_workspace_read"]
          }
        })
    });

    const response = await injectCommand(harness.app, {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.request_action_grant",
      input: {
        intent: {
          intent: "collaboration.create_team",
          commandRequestId: randomUUID(),
          name: "Product Team"
        }
      }
    } as CollaborationRendererCommand);

    expect(parseResult(response.body)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" }
    });
    expect(dispatched).toBe(false);
  });

  it("prepares a captured session source and returns its authoritative Personal Memory entry", async () => {
    const source = createSourceRepository();
    const command = prepareSourceCommand();
    const harness = createHarness({
      backend: sourceSyncBackend(),
      personalRepository: source.repository,
      response: (call) => sourceSyncResponse(source, call)
    });

    const response = await injectCommand(harness.app, command);
    const result = collaborationCommandResultSchema.parse(
      parseResult(response.body)
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(result).toMatchObject({
      requestId: command.requestId,
      command: command.command,
      ok: true,
      data: {
        entry: {
          id: ids.session,
          logicalMemoryId: source.relationship()?.logicalMemoryId,
          title: "Architecture review",
          projectName: "koed_team_conversations",
          preview: "7 Memory Events",
          eventCount: 7,
          hasSynchronizedRevision: true,
          syncState: "ready"
        }
      }
    });
    expect(source.sourceActors).toEqual([ids.actor]);
    expect(source.summaryActors).toEqual([ids.actor]);
    expect(source.activationActors).toEqual([ids.actor]);
    expect(harness.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/koed/v1/cross-identity-sync/intake/context",
      "/koed/v1/cross-identity-sync/intake/relationships"
    ]);
    expect(response.body).not.toContain("remoteReplicaId");
    await harness.app.close();
  });

  it("isolates source preparation to the Desktop credential's active owner", async () => {
    const source = createSourceRepository(ids.otherOwner);
    const harness = createHarness({
      backend: sourceSyncBackend(),
      personalRepository: source.repository,
      response: (call) => sourceSyncResponse(source, call)
    });

    const response = await injectCommand(harness.app, prepareSourceCommand());

    expect(parseResult(response.body)).toMatchObject({
      ok: false,
      error: { code: "not_available" }
    });
    expect(source.sourceActors).toEqual([ids.actor]);
    expect(source.summaryActors).toEqual([]);
    expect(source.createInputs).toEqual([]);
    expect(harness.calls).toEqual([]);
    await harness.app.close();
  });

  it("retries source preparation idempotently against the deterministic relationship", async () => {
    const source = createSourceRepository();
    const harness = createHarness({
      backend: sourceSyncBackend(),
      personalRepository: source.repository,
      response: (call) => sourceSyncResponse(source, call)
    });
    const first = prepareSourceCommand();
    const retry = prepareSourceCommand();

    const firstResponse = await injectCommand(harness.app, first);
    const retryResponse = await injectCommand(harness.app, retry);

    expect(parseResult(firstResponse.body)).toMatchObject({
      requestId: first.requestId,
      ok: true,
      data: { entry: { id: ids.session, syncState: "ready" } }
    });
    expect(parseResult(retryResponse.body)).toMatchObject({
      requestId: retry.requestId,
      ok: true,
      data: { entry: { id: ids.session, syncState: "ready" } }
    });
    expect(
      new Set(source.createInputs.map((input) => input.relationshipId)).size
    ).toBe(1);
    expect(
      new Set(source.createInputs.map((input) => input.logicalMemoryId)).size
    ).toBe(1);
    expect(source.createInputs.map((input) => input.idempotencyKey)).toEqual([
      first.requestId,
      first.requestId
    ]);
    expect(source.createInputs.map((input) => input.consentManifest)).toEqual([
      source.createInputs[0]?.consentManifest,
      source.createInputs[0]?.consentManifest
    ]);
    await harness.app.close();
  });

  it("recovers a failed source relationship through the repository retry lifecycle", async () => {
    const source = createSourceRepository();
    let targetFailed = false;
    const harness = createHarness({
      backend: sourceSyncBackend(),
      personalRepository: source.repository,
      response: (call) => {
        const path = new URL(call.url).pathname.replace(/^\/koed/, "");
        if (path === "/v1/cross-identity-sync/intake/relationships") {
          const created = source.createInputs.at(-1);
          if (!created) return Response.json({}, { status: 500 });
          return Response.json({
            relationship: {
              id: created.relationshipId,
              state: targetFailed ? "failed" : "ready"
            },
            target_deployment_id: ids.remoteProtocolDeployment,
            target_deployment_profile: "team_self_hosted",
            target_user_id: ids.remotePrincipal,
            target_replica_id: created.remoteReplicaId,
            recipient_key: syncRecipientKey
          });
        }
        if (
          path ===
          `/v1/cross-identity-sync/relationships/${source.relationship()?.id}/retry`
        ) {
          targetFailed = false;
          return Response.json({
            relationship: {
              id: source.relationship()?.id,
              state: "processing"
            }
          });
        }
        return sourceSyncResponse(source, call);
      }
    });
    const first = await injectCommand(harness.app, prepareSourceCommand());
    const relationshipId = source.relationship()?.id;

    expect(parseResult(first.body)).toMatchObject({
      ok: true,
      data: { entry: { syncState: "ready" } }
    });
    source.failRelationship();
    targetFailed = true;

    const recovered = await injectCommand(harness.app, prepareSourceCommand());

    expect(parseResult(recovered.body)).toMatchObject({
      ok: true,
      data: { entry: { syncState: "ready" } }
    });
    expect(source.relationship()?.id).toBe(relationshipId);
    expect(source.retryActors).toEqual([ids.actor]);
    expect(source.activationActors).toEqual([ids.actor, ids.actor, ids.actor]);
    expect(harness.calls.map((call) => new URL(call.url).pathname)).toContain(
      `/koed/v1/cross-identity-sync/relationships/${relationshipId}/retry`
    );
    expect(
      new Set(source.createInputs.map((input) => input.relationshipId))
    ).toEqual(new Set([relationshipId]));
    await harness.app.close();
  });

  it("returns a typed unavailable failure when the selected backend is unavailable", async () => {
    const source = createSourceRepository();
    const harness = createHarness({
      backend: null,
      personalRepository: source.repository
    });

    const response = await injectCommand(harness.app, prepareSourceCommand());

    expect(response.statusCode).toBe(200);
    expect(parseResult(response.body)).toMatchObject({
      ok: false,
      error: { code: "temporarily_unavailable", retryable: true }
    });
    expect(source.sourceActors).toEqual([]);
    expect(source.createInputs).toEqual([]);
    expect(harness.calls).toEqual([]);
    await harness.app.close();
  });

  it("preserves command correlation through source intake", async () => {
    const source = createSourceRepository();
    const command = prepareSourceCommand();
    const harness = createHarness({
      backend: sourceSyncBackend(),
      personalRepository: source.repository,
      response: (call) => sourceSyncResponse(source, call)
    });

    const response = await injectCommand(harness.app, command);
    const intake = harness.calls.find((call) =>
      new URL(call.url).pathname.endsWith(
        "/v1/cross-identity-sync/intake/relationships"
      )
    );
    const intakeBody = JSON.parse(String(intake?.init.body)) as Record<
      string,
      unknown
    >;

    expect(parseResult(response.body)).toMatchObject({
      requestId: command.requestId,
      command: "collaboration.prepare_shared_memory_source",
      ok: true
    });
    expect(intakeBody).toMatchObject({
      idempotency_key: command.requestId,
      origin_session_id: ids.session,
      source_user_id: ids.actor
    });
    await harness.app.close();
  });

  it("bounds captured-session labels without changing source memory", async () => {
    const source = createSourceRepository(ids.actor, {
      title: `Architecture ${"😀".repeat(100)}`,
      projectName: `Project ${"界".repeat(100)}`
    });
    const harness = createHarness({
      backend: sourceSyncBackend(),
      personalRepository: source.repository,
      response: (call) => sourceSyncResponse(source, call)
    });

    const response = await injectCommand(harness.app, prepareSourceCommand());
    const result = collaborationCommandResultSchema.parse(
      parseResult(response.body)
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        entry: {
          id: ids.session,
          title: expect.any(String),
          projectName: expect.any(String)
        }
      }
    });
    if (
      !result.ok ||
      result.command !== "collaboration.prepare_shared_memory_source"
    ) {
      throw new Error("Expected Shared Memory source preparation to succeed");
    }
    expect([...result.data.entry.title]).toHaveLength(80);
    expect([...(result.data.entry.projectName ?? "")]).toHaveLength(80);
    expect(source.createInputs).toHaveLength(1);
    await harness.app.close();
  });

  it("pauses and resumes the exact local Shared Memory source relationship", async () => {
    const source = createSourceRepository();
    const harness = createHarness({
      backend: sourceSyncBackend(),
      personalRepository: source.repository,
      response: (call) => sourceSyncResponse(source, call)
    });
    expect(
      parseResult(
        (await injectCommand(harness.app, prepareSourceCommand())).body
      )
    ).toMatchObject({ ok: true });

    const pause: CollaborationRendererCommand = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.pause_shared_memory_sync",
      input: { sessionId: ids.session }
    };
    expect(
      parseResult((await injectCommand(harness.app, pause)).body)
    ).toMatchObject({
      ok: true,
      data: { entry: { id: ids.session, syncState: "paused" } }
    });

    const resume: CollaborationRendererCommand = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.resume_shared_memory_sync",
      input: { sessionId: ids.session }
    };
    expect(
      parseResult((await injectCommand(harness.app, resume)).body)
    ).toMatchObject({
      ok: true,
      data: { entry: { id: ids.session, syncState: "ready" } }
    });
    expect(source.createInputs).toHaveLength(2);
    expect(
      new Set(source.createInputs.map((input) => input.relationshipId))
    ).toEqual(new Set([source.relationship()?.id]));
    expect(harness.calls.map((call) => new URL(call.url).pathname)).toEqual(
      expect.arrayContaining([
        "/koed/v1/cross-identity-sync/intake/context",
        "/koed/v1/cross-identity-sync/intake/relationships"
      ])
    );

    const revoke: CollaborationRendererCommand = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.revoke_shared_memory_sync",
      input: { sessionId: ids.session }
    };
    expect(
      parseResult((await injectCommand(harness.app, revoke)).body)
    ).toMatchObject({
      ok: true,
      data: {
        entry: {
          id: ids.session,
          syncState: "revoked",
          hasSynchronizedRevision: true
        }
      }
    });
    await harness.app.close();
  });

  it("routes Shared Memory commands through the durable local control with bound identity", async () => {
    const command: CollaborationRendererCommand = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.preview_shared_memory",
      input: {
        logicalMemoryId: ids.sharedLogicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["memory_events"],
        actionGrant: { id: randomUUID() }
      }
    };
    const dispatches: unknown[] = [];
    const harness = createHarness({
      sharedMemoryControl: {
        resolvePreviewTarget: async () => null,
        resolveConsentPreview: async () => null,
        loadInitialSharedSession: async () => null,
        dispatch: async (input, context) => {
          dispatches.push({ input, context });
          return collaborationCommandResultSchema.parse({
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: command.requestId,
            command: command.command,
            ok: false,
            error: {
              code: "not_available",
              userMessage: collaborationSafeErrorMessages.not_available,
              retryable: false,
              retryAfterMs: null
            }
          });
        }
      }
    });

    const response = await injectCommand(harness.app, command);

    expect(response.statusCode, response.body).toBe(200);
    expect(parseResult(response.body)).toMatchObject({
      requestId: command.requestId,
      command: command.command,
      ok: false,
      error: { code: "not_available" }
    });
    expect(dispatches).toEqual([
      {
        input: command,
        context: {
          upstreamBackendId: "team-vps",
          localOwnerUserId: ids.actor,
          desktopCredentialKeyId: `koed_desktop_${"a".repeat(40)}`
        }
      }
    ]);
    expect(harness.calls).toHaveLength(0);
  });

  it("executes the complete Personal command path locally without a Team backend", async () => {
    const harness = createHarness({
      backend: null,
      upstreamAuthorization: null
    });
    const commands = [
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.load",
        input: {}
      },
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.create_personal_channel",
        input: { name: "Personal", topic: null }
      },
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.rename_thread",
        input: {
          thread: { scope: "personal", threadId: ids.personalThread },
          name: "Renamed",
          expectedVersion: 1
        }
      },
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.update_thread_topic",
        input: {
          thread: { scope: "personal", threadId: ids.personalThread },
          topic: "Local topic",
          expectedVersion: 2
        }
      },
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.archive_thread",
        input: {
          thread: { scope: "personal", threadId: ids.personalThread },
          expectedVersion: 3
        }
      },
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.restore_thread",
        input: {
          thread: { scope: "personal", threadId: ids.personalThread },
          expectedVersion: 4
        }
      },
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.send_message",
        input: {
          thread: { scope: "personal", threadId: ids.personalThread },
          clientMessageId: randomUUID(),
          body: "local message"
        }
      },
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.mark_read",
        input: {
          thread: { scope: "personal", threadId: ids.personalThread },
          messageId: ids.message
        }
      },
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.subscribe",
        input: { scope: { scope: "personal" } }
      }
    ] as CollaborationRendererCommand[];

    const results = [];
    for (const command of commands) {
      const response = await injectPersonalCommand(harness.app, command);
      expect(response.statusCode).toBe(200);
      const result = parseResult(response.body);
      expect(result).toMatchObject({
        requestId: command.requestId,
        command: command.command,
        ok: true
      });
      results.push(result);
    }

    expect(results[0]).toMatchObject({
      data: {
        snapshot: {
          connection: { state: "disconnected", backendId: null },
          navigation: {
            personalOwner: { id: ids.actor, membershipState: "enabled" },
            teamPrincipal: null,
            personal: { channels: [{ ownerUserId: ids.actor }] },
            teams: []
          }
        }
      }
    });
    expect(results[6]).toMatchObject({
      data: {
        message: {
          scope: "personal",
          teamId: null,
          sender: { id: ids.actor },
          body: "local message"
        }
      }
    });
    expect(results[8]).toMatchObject({
      data: {
        subscription: {
          scope: { scope: "personal" },
          state: "active"
        }
      }
    });
    expect(harness.calls).toHaveLength(0);
  });

  it("uses the remote Personal authority without creating a divergent local channel", async () => {
    const remoteChannel = personalThreadRecord({
      personalOwnerUserId: ids.remotePrincipal,
      createdByUserId: ids.remotePrincipal,
      name: "Remote Personal"
    });
    const harness = createHarness({
      backend: backend({
        routePolicy: {
          personalCollaboration: "enabled",
          teamWorkspaceRead: "enabled"
        }
      }),
      localFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write",
        "team_workspace_read"
      ],
      response: (call) => {
        const path = new URL(call.url).pathname.replace(/^\/koed/, "");
        if (path === "/v1/local-edge/device-credentials/status") {
          return Response.json({
            ok: true,
            auth: "device_credential",
            user: {
              id: ids.remotePrincipal,
              email: "remote-alice@example.test",
              displayName: "Remote Alice"
            },
            credential: {
              id: randomUUID(),
              ownerUserId: ids.remotePrincipal,
              operationFamilies: [
                "personal_collaboration_read",
                "personal_collaboration_write",
                "team_workspace_read"
              ]
            }
          });
        }
        if (path === "/v1/collaboration/personal/channels") {
          return Response.json({ thread: remoteChannel });
        }
        return new Response("not found", { status: 404 });
      }
    });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.create_personal_channel",
      input: { name: "Remote Personal", topic: null }
    } as CollaborationRendererCommand;

    const response = await injectPersonalCommand(harness.app, command);

    expect(parseResult(response.body)).toMatchObject({
      ok: true,
      data: {
        thread: {
          id: ids.personalThread,
          scope: "personal",
          name: "Remote Personal"
        }
      }
    });
    expect(harness.repositoryRequests()).toBe(0);
    expect(
      harness.calls.map((call) => ({
        method: call.init.method,
        path: new URL(call.url).pathname.replace(/^\/koed/, "")
      }))
    ).toEqual([
      {
        method: "GET",
        path: "/v1/local-edge/device-credentials/status"
      },
      {
        method: "POST",
        path: "/v1/collaboration/personal/channels"
      }
    ]);
  });

  it("fails closed when remote Personal authority is enabled without write scope", async () => {
    const harness = createHarness({
      backend: backend({
        routePolicy: {
          personalCollaboration: "enabled",
          teamWorkspaceRead: "enabled"
        }
      }),
      localFamilies: ["personal_collaboration_read", "team_workspace_read"]
    });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.create_personal_channel",
      input: { name: "Must not be local", topic: null }
    } as CollaborationRendererCommand;

    const response = await injectPersonalCommand(harness.app, command);

    expect(parseResult(response.body)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" }
    });
    expect(harness.repositoryRequests()).toBe(0);
    expect(harness.calls).toHaveLength(0);
  });

  it("uses signed owner, thread, and direction-bound Personal message cursors", async () => {
    const harness = createHarness({ backend: null });
    const firstCommand = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.load_message_page",
      input: {
        thread: { scope: "personal", threadId: ids.personalThread },
        direction: "older",
        cursor: null,
        limit: 1
      }
    } as CollaborationRendererCommand;
    const first = parseResultAs<MessagePageTestResult>(
      (await injectPersonalCommand(harness.app, firstCommand)).body
    );
    expect(first).toMatchObject({
      ok: true,
      data: { page: { items: [{ sequence: 3 }], hasOlder: true } }
    });
    if (!first.ok || first.command !== "collaboration.load_message_page") {
      throw new Error("Expected Personal message page");
    }
    const cursor = first.data.page.olderCursor;
    expect(cursor).toMatch(/^cpc1\./);

    const nextCommand = {
      ...firstCommand,
      requestId: randomUUID(),
      input: { ...firstCommand.input, cursor }
    } satisfies CollaborationRendererCommand;
    expect(
      parseResult((await injectPersonalCommand(harness.app, nextCommand)).body)
    ).toMatchObject({
      ok: true,
      data: { page: { items: [{ sequence: 2 }] } }
    });

    const tampered = `${cursor!.slice(0, -1)}${cursor!.endsWith("a") ? "b" : "a"}`;
    const invalidCommands = [
      {
        ...nextCommand,
        requestId: randomUUID(),
        input: { ...nextCommand.input, cursor: tampered }
      },
      {
        ...nextCommand,
        requestId: randomUUID(),
        input: {
          ...nextCommand.input,
          thread: { scope: "personal", threadId: ids.notesThread }
        }
      },
      {
        ...nextCommand,
        requestId: randomUUID(),
        input: { ...nextCommand.input, direction: "newer" }
      }
    ] as CollaborationRendererCommand[];
    for (const command of invalidCommands) {
      expect(
        parseResult((await injectPersonalCommand(harness.app, command)).body)
      ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
  });

  it("composes Personal state with authorized remote Team catalog and Shared Memory indexes", async () => {
    const harness = createHarness({ response: remoteCompositionResponse });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.load",
      input: {}
    } as CollaborationRendererCommand;

    const response = await injectPersonalCommand(harness.app, command);
    expect(response.statusCode).toBe(200);
    const result = parseResultAs<LoadTestResult>(response.body);
    expect(result).toMatchObject({
      ok: true,
      data: {
        snapshot: {
          connection: { state: "live", backendId: "team-vps" },
          navigation: {
            personalOwner: { id: ids.actor },
            teamPrincipal: { id: ids.remotePrincipal }
          }
        }
      }
    });
    if (!result.ok || result.command !== "collaboration.load") {
      throw new Error("Expected collaboration.load success");
    }
    const team = result.data.snapshot.navigation.teams[0]!;
    const workspace = team.workspaces[0]!;
    expect(team).toMatchObject({
      id: ids.team,
      role: "member",
      directMessages: [{ id: ids.thread }]
    });
    expect(team.people.map((person) => person.id)).toContain(
      ids.remotePrincipal
    );
    expect(workspace).toMatchObject({
      id: ids.workspace,
      access: "write",
      channels: [{ id: ids.thread }],
      sharedMemory: [
        {
          id: ids.sharedGrant,
          logicalMemoryId: ids.sharedLogicalMemory,
          companionThreadId: ids.sharedDiscussionThread,
          unreadCompanionCount: 1
        }
      ]
    });
    expect(result.data.snapshot.navigation.personalOwner.id).not.toBe(
      result.data.snapshot.navigation.teamPrincipal?.id
    );
    expect(result.data.snapshot.navigation.personalOwner.id).toBe(ids.actor);
    expect(result.data.snapshot.navigation.teamPrincipal?.id).toBe(
      ids.remotePrincipal
    );
    expect(harness.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/local-edge/device-credentials/status",
      "/koed/v1/teams/navigation"
    ]);
    for (const call of harness.calls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe(upstreamAuthorization);
      expect(headers.get("authorization")).not.toBe(desktopAuthorization);
      expect(headers.get("cookie")).toBeNull();
    }
  });

  it("keeps a future remote Presence status from invalidating Team navigation", async () => {
    const harness = createHarness({
      response: (call) => {
        const path = new URL(call.url).pathname.replace(/^\/koed/, "");
        if (path === "/v1/teams/navigation") {
          const payload = remoteNavigationPayload();
          return Response.json({
            ...payload,
            teamPresenceStatusCatalogue: {
              version: 2,
              statuses: [
                ...payload.teamPresenceStatusCatalogue.statuses,
                { key: "heads_down", label: "Heads down" }
              ]
            },
            teams: payload.teams.map((team) => ({
              ...team,
              members: team.members.map((member, index) =>
                index === 0
                  ? {
                      ...member,
                      teamPresence: {
                        ...member.teamPresence,
                        manualStatus: "heads_down"
                      }
                    }
                  : member
              )
            }))
          });
        }
        return remoteCompositionResponse(call);
      }
    });
    const result = parseResultAs<LoadTestResult>(
      (
        await injectPersonalCommand(harness.app, {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: randomUUID(),
          command: "collaboration.load",
          input: {}
        } as CollaborationRendererCommand)
      ).body
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || result.command !== "collaboration.load") {
      throw new Error("Expected collaboration.load success");
    }
    expect(
      result.data.snapshot.navigation.teams[0]?.people[0]?.teamPresence
        .manualStatus
    ).toBe("unknown");
    expect(result.data.snapshot.teamPresenceStatusCatalogue.version).toBe(2);
    expect(
      result.data.snapshot.teamPresenceStatusCatalogue.statuses
    ).toContainEqual({
      key: "heads_down",
      label: "Heads down"
    });
  });

  it("reuses Team navigation until an authoritative realtime event invalidates it", async () => {
    const harness = createHarness({ response: remoteCompositionResponse });
    const load = () =>
      injectPersonalCommand(harness.app, {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.load",
        input: {}
      } as CollaborationRendererCommand);
    const navigationReads = () =>
      harness.calls.filter(
        (call) => new URL(call.url).pathname === "/koed/v1/teams/navigation"
      ).length;

    expect((await load()).statusCode).toBe(200);
    expect((await load()).statusCode).toBe(200);
    expect(navigationReads()).toBe(1);

    const authoritative = await injectPersonalCommand(harness.app, {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.load",
      input: { forceRemoteNavigation: true }
    } as CollaborationRendererCommand);
    expect(authoritative.statusCode).toBe(200);
    expect(navigationReads()).toBe(2);

    harness.invalidateRemoteNavigation();
    expect((await load()).statusCode).toBe(200);
    expect(navigationReads()).toBe(3);
  });

  it("does not let a forced Team navigation refresh reuse an older in-flight read", async () => {
    let releaseFirstNavigation!: (response: Response) => void;
    const firstNavigation = new Promise<Response>((resolve) => {
      releaseFirstNavigation = resolve;
    });
    let navigationReads = 0;
    let firstNavigationStarted!: () => void;
    const navigationStarted = new Promise<void>((resolve) => {
      firstNavigationStarted = resolve;
    });
    const harness = createHarness({
      response: (call) => {
        const path = new URL(call.url).pathname.replace(/^\/koed/, "");
        if (path !== "/v1/teams/navigation") {
          return remoteCompositionResponse(call);
        }
        navigationReads += 1;
        if (navigationReads === 1) {
          firstNavigationStarted();
          return firstNavigation;
        }
        return remoteCompositionResponse(call);
      }
    });
    const load = (forceRemoteNavigation = false) =>
      injectPersonalCommand(harness.app, {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.load",
        input: forceRemoteNavigation ? { forceRemoteNavigation: true } : {}
      } as CollaborationRendererCommand);

    const initial = load();
    await navigationStarted;
    const forced = load(true);
    releaseFirstNavigation(
      Response.json({
        ...remoteNavigationPayload(),
        snapshotRevision: "remote-before-write"
      })
    );

    expect((await initial).statusCode).toBe(200);
    expect((await forced).statusCode).toBe(200);
    expect(navigationReads).toBe(2);
  });

  it("does not advertise remote Team navigation when Team collaboration is disabled", async () => {
    const harness = createHarness({
      teamCollaborationEnabled: false,
      response: remoteCompositionResponse
    });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.load",
      input: {}
    } as CollaborationRendererCommand;

    const response = await injectPersonalCommand(harness.app, command);
    expect(response.statusCode).toBe(200);
    expect(parseResultAs<LoadTestResult>(response.body)).toMatchObject({
      ok: true,
      data: {
        snapshot: {
          navigation: { teamPrincipal: null, teams: [] }
        }
      }
    });
    expect(harness.calls).toEqual([]);
  });

  it("retains the Team while excluding archived Workspaces from active navigation and content reads", async () => {
    const archivedWorkspaceId = randomUUID();
    const archivedAccessPath = `/v1/team-workspaces/${archivedWorkspaceId}/access`;
    const archivedSharedMemoryPath = `/v1/shared-memory/teams/${ids.team}/workspaces/${archivedWorkspaceId}/share-grants`;
    const harness = createHarness({
      response: (call) => {
        const path = new URL(call.url).pathname.replace(/^\/koed/, "");
        if (path === "/v1/teams/navigation") {
          return Response.json(
            remoteNavigationPayload({
              workspaces: [
                {
                  teamWorkspace: remoteWorkspace,
                  access: {
                    teamWorkspaceId: ids.workspace,
                    teamId: ids.team,
                    userId: ids.remotePrincipal,
                    access: "write",
                    canRecall: true
                  },
                  shareGrants: [remoteSharedGrant]
                },
                {
                  teamWorkspace: {
                    ...remoteWorkspace,
                    id: archivedWorkspaceId,
                    name: "Archived Workspace",
                    version: 2,
                    lifecycle: "archived",
                    archivedAt: iso
                  },
                  access: {
                    teamWorkspaceId: archivedWorkspaceId,
                    teamId: ids.team,
                    userId: ids.remotePrincipal,
                    access: "write",
                    canRecall: true
                  },
                  shareGrants: []
                }
              ]
            })
          );
        }
        if (path === archivedAccessPath)
          return Response.json(
            { error: "Workspace is archived" },
            { status: 403 }
          );
        if (path === archivedSharedMemoryPath) {
          return Response.json(
            { error: "Workspace is archived" },
            { status: 403 }
          );
        }
        return remoteCompositionResponse(call);
      }
    });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.load",
      input: {}
    } as CollaborationRendererCommand;

    const response = await injectPersonalCommand(harness.app, command);
    expect(response.statusCode).toBe(200);
    const result = parseResultAs<LoadTestResult>(response.body);
    expect(result).toMatchObject({
      ok: true,
      data: {
        snapshot: {
          connection: { state: "live", backendId: "team-vps" },
          navigation: { teams: [{ id: ids.team }] }
        }
      }
    });
    expect(result.data.snapshot.navigation.teams[0]?.workspaces).toEqual([
      expect.objectContaining({ id: ids.workspace, lifecycle: "active" })
    ]);
    const calledPaths = harness.calls.map((call) =>
      new URL(call.url).pathname.replace(/^\/koed/, "")
    );
    expect(calledPaths).not.toContain(archivedAccessPath);
    expect(calledPaths.includes(archivedSharedMemoryPath)).toBe(false);
  });

  it("retains authorized Team navigation when selecting Personal Memory", async () => {
    const harness = createHarness({ response: remoteCompositionResponse });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.select",
      input: { selection: { kind: "personal_memory" } }
    } as CollaborationRendererCommand;

    const response = await injectPersonalCommand(harness.app, command);
    expect(response.statusCode).toBe(200);
    const result = parseResult(response.body);
    expect(result).toMatchObject({
      ok: true,
      data: {
        snapshot: {
          selection: { kind: "personal_memory" },
          connection: { state: "live", backendId: "team-vps" },
          navigation: {
            personalOwner: { id: ids.actor },
            teamPrincipal: { id: ids.remotePrincipal },
            teams: [{ id: ids.team }]
          }
        }
      }
    });
    expect(harness.calls.map((call) => new URL(call.url).pathname)).toContain(
      "/koed/v1/teams/navigation"
    );
  });

  it("maps the canonical default Workspace channel name from its system key", async () => {
    const harness = createHarness({
      response: (call) => {
        const path = new URL(call.url).pathname.replace(/^\/koed/, "");
        if (path === "/v1/teams/navigation") {
          return Response.json(
            remoteNavigationPayload({
              threads: [
                {
                  id: ids.thread,
                  logicalId: ids.logicalThread,
                  scope: "team",
                  kind: "workspace_channel",
                  personalOwnerUserId: null,
                  teamId: ids.team,
                  teamWorkspaceId: ids.workspace,
                  sharedLogicalMemoryId: null,
                  shareGrantId: null,
                  systemKey: "workspace.general",
                  name: null,
                  topic: null,
                  createdByUserId: ids.remotePrincipal,
                  version: 1,
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
                }
              ],
              workspaces: [
                {
                  teamWorkspace: remoteWorkspace,
                  access: {
                    teamWorkspaceId: ids.workspace,
                    teamId: ids.team,
                    userId: ids.remotePrincipal,
                    access: "write",
                    canRecall: true
                  },
                  shareGrants: []
                }
              ]
            })
          );
        }
        return remoteCompositionResponse(call);
      }
    });
    const response = await injectPersonalCommand(
      harness.app,
      parseCommand({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.load",
        input: {}
      })
    );
    const result = parseResultAs<LoadTestResult>(response.body);

    expect(result).toMatchObject({
      ok: true,
      data: {
        snapshot: {
          navigation: {
            teams: [
              {
                workspaces: [
                  { channels: [{ id: ids.thread, name: "general" }] }
                ]
              }
            ]
          }
        }
      }
    });
  });

  it("uses the explicit active backend instead of an older disconnected registry row", async () => {
    const disconnected = backend({
      id: "old-backend",
      baseUrl: "https://old.example.test",
      credential: { status: "revoked" },
      routePolicy: { teamWorkspaceRead: "disabled" }
    });
    const active = backend();
    const harness = createHarness({
      registryBackends: [disconnected, active],
      activeBackendId: active.id,
      response: remoteCompositionResponse
    });
    const result = parseResult(
      (
        await injectPersonalCommand(harness.app, {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: randomUUID(),
          command: "collaboration.load",
          input: {}
        } as CollaborationRendererCommand)
      ).body
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        snapshot: { connection: { state: "live", backendId: "team-vps" } }
      }
    });
    expect(harness.localCredentialReads).toEqual(["team-vps"]);
    expect(harness.calls.every(({ url }) => !url.includes("old.example"))).toBe(
      true
    );
  });

  it("keeps load useful as Personal-only when a registered Team backend cannot be read", async () => {
    const harness = createHarness({
      localFamilies: ["team_chat_read", "team_chat_write"],
      response: remoteCompositionResponse
    });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.load",
      input: {}
    } as CollaborationRendererCommand;

    const result = parseResult(
      (await injectPersonalCommand(harness.app, command)).body
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        snapshot: {
          connection: { state: "unavailable", backendId: "team-vps" },
          navigation: {
            personalOwner: { id: ids.actor },
            teamPrincipal: null,
            teams: []
          }
        }
      }
    });
    expect(harness.calls).toHaveLength(0);
  });

  it("revalidates Team selections through upstream authority instead of trusting renderer IDs", async () => {
    const harness = createHarness({ response: remoteCompositionResponse });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.select",
      input: {
        selection: {
          kind: "workspace_channel",
          teamId: ids.team,
          workspaceId: randomUUID(),
          threadId: ids.thread
        }
      }
    } as CollaborationRendererCommand;

    const result = parseResult(
      (await injectCommand(harness.app, command)).body
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "not_available" }
    });
    expect(
      harness.calls.some((call) =>
        new URL(call.url).pathname.endsWith(
          `/v1/collaboration/teams/${ids.team}/threads/${ids.thread}`
        )
      )
    ).toBe(true);
  });

  it("loads manager-only member and Workspace Access details without widening the roster", async () => {
    const ownerResponse = (call: FetchCall): Response => {
      const path = new URL(call.url).pathname.replace(/^\/koed/, "");
      if (path === "/v1/teams/navigation") {
        const payload = remoteNavigationPayload();
        payload.teams[0]!.membership.role = "owner";
        return Response.json(payload);
      }
      if (path === `/v1/teams/${ids.team}/members/manage`) {
        return Response.json({
          members: [
            {
              id: ids.membership,
              teamId: ids.team,
              userId: ids.remotePrincipal,
              role: "owner",
              status: "enabled",
              version: 1,
              email: "remote-alice@example.test",
              displayName: "Remote Alice",
              ...remotePresence,
              workspaceAccess: [
                {
                  teamWorkspaceId: ids.workspace,
                  userId: ids.remotePrincipal,
                  access: "write",
                  version: 2
                }
              ]
            }
          ]
        });
      }
      return remoteCompositionResponse(call);
    };
    const harness = createHarness({ response: ownerResponse });
    const result = parseResultAs<LoadTestResult>(
      (
        await injectCommand(harness.app, {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: randomUUID(),
          command: "collaboration.select",
          input: { selection: { kind: "team_people", teamId: ids.team } }
        })
      ).body
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        snapshot: {
          view: {
            kind: "team_people",
            people: [
              {
                id: ids.remotePrincipal,
                management: {
                  membershipId: ids.membership,
                  email: "remote-alice@example.test",
                  role: "owner",
                  status: "enabled",
                  version: 1,
                  workspaceAccess: [
                    {
                      workspaceId: ids.workspace,
                      userId: ids.remotePrincipal,
                      access: "write",
                      version: 2
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    });
    if (!result.ok || result.command !== "collaboration.select") {
      throw new Error("Expected collaboration.select success");
    }
    expect(
      result.data.snapshot.navigation.teams[0]?.people.every(
        (person) => !("management" in person)
      )
    ).toBe(true);
    expect(
      harness.calls.some(
        (call) =>
          new URL(call.url).pathname ===
          `/koed/v1/teams/${ids.team}/members/manage`
      )
    ).toBe(true);
  });

  it("selects an authorized Shared Memory session with its exact source and companion history", async () => {
    const dispatches: Array<{
      command: CollaborationRendererCommand;
      context: unknown;
    }> = [];
    const harness = createHarness({
      response: remoteCompositionResponse,
      sharedMemoryControl: {
        resolvePreviewTarget: async () => null,
        resolveConsentPreview: async () => null,
        dispatch: async () => null,
        loadInitialSharedSession: async (input, context) => {
          const parsed = parseCommand({
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: input.requestId,
            command: "collaboration.load_shared_source_page",
            input: {
              sharedSession: {
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                sharedSessionId: input.sharedSessionId
              },
              direction: "older",
              cursor: null,
              limit: input.limit
            }
          });
          dispatches.push({ command: parsed, context });
          return {
            sourceResult: collaborationCommandResultSchema.parse({
              contractVersion: COLLABORATION_CONTRACT_VERSION,
              requestId: parsed.requestId,
              command: parsed.command,
              ok: true,
              data: { page: sharedSourcePage }
            }),
            companion: {
              thread: sharedDiscussionThread,
              messages: {
                messages: [sharedDiscussionMessage],
                hasMore: false,
                nextBeforeSequence: null,
                nextAfterSequence: null
              }
            }
          };
        }
      }
    });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.select",
      input: {
        selection: {
          kind: "shared_session",
          teamId: ids.team,
          workspaceId: ids.workspace,
          sharedSessionId: ids.sharedGrant
        }
      }
    } satisfies CollaborationRendererCommand;

    const result = parseResult(
      (await injectCommand(harness.app, command)).body
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        snapshot: {
          selection: command.input.selection,
          view: {
            kind: "shared_session",
            session: {
              id: ids.sharedGrant,
              representation: "memory_events",
              companionThreadId: ids.sharedDiscussionThread,
              unreadCompanionCount: 1
            },
            source: {
              sharedSessionId: ids.sharedGrant,
              representation: "memory_events",
              items: [{ id: ids.sharedSourceItem }]
            },
            companion: {
              thread: {
                id: ids.sharedDiscussionThread,
                kind: "shared_session_discussion",
                unreadCount: 1
              },
              messages: {
                threadId: ids.sharedDiscussionThread,
                items: [{ body: "Discuss the shared source." }]
              }
            }
          }
        }
      }
    });
    expect(dispatches).toMatchObject([
      {
        command: {
          requestId: command.requestId,
          command: "collaboration.load_shared_source_page",
          input: {
            sharedSession: {
              teamId: ids.team,
              workspaceId: ids.workspace,
              sharedSessionId: ids.sharedGrant
            },
            direction: "older",
            cursor: null,
            limit: 100
          }
        },
        context: {
          upstreamBackendId: "team-vps",
          localOwnerUserId: ids.actor
        }
      }
    ]);
    expect(harness.calls).toHaveLength(2);
    await harness.app.close();
  });

  it("dispatches Shared Memory source-page commands and returns the authorized page", async () => {
    const dispatched: CollaborationRendererCommand[] = [];
    const harness = createHarness({
      sharedMemoryControl: {
        resolvePreviewTarget: async () => null,
        resolveConsentPreview: async () => null,
        loadInitialSharedSession: async () => null,
        dispatch: async (command) => {
          const parsed = parseCommand(command);
          dispatched.push(parsed);
          if (parsed.command !== "collaboration.load_shared_source_page") {
            return null;
          }
          return collaborationCommandResultSchema.parse({
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: parsed.requestId,
            command: parsed.command,
            ok: true,
            data: { page: sharedSourcePage }
          });
        }
      }
    });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.load_shared_source_page",
      input: {
        sharedSession: {
          teamId: ids.team,
          workspaceId: ids.workspace,
          sharedSessionId: ids.sharedGrant
        },
        direction: "older",
        cursor: null,
        limit: 25
      }
    } as CollaborationRendererCommand;

    const result = parseResult(
      (await injectCommand(harness.app, command)).body
    );

    expect(result).toMatchObject({
      requestId: command.requestId,
      command: command.command,
      ok: true,
      data: { page: sharedSourcePage }
    });
    expect(dispatched).toEqual([command]);
    expect(harness.calls).toEqual([]);
    await harness.app.close();
  });

  it.each([
    "access_revoked",
    "permission_denied",
    "temporarily_unavailable"
  ] as const)(
    "fails closed when Shared Memory source authority returns %s",
    async (code) => {
      const harness = createHarness({
        sharedMemoryControl: {
          resolvePreviewTarget: async () => null,
          resolveConsentPreview: async () => null,
          loadInitialSharedSession: async () => null,
          dispatch: async (command) => {
            const parsed = parseCommand(command);
            return collaborationCommandResultSchema.parse({
              contractVersion: COLLABORATION_CONTRACT_VERSION,
              requestId: parsed.requestId,
              command: parsed.command,
              ok: false,
              error: {
                code,
                userMessage: collaborationSafeErrorMessages[code],
                retryable: code === "temporarily_unavailable",
                retryAfterMs: null
              }
            });
          }
        }
      });
      const command = {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.load_shared_source_page",
        input: {
          sharedSession: {
            teamId: ids.team,
            workspaceId: ids.workspace,
            sharedSessionId: ids.sharedGrant
          },
          direction: "older",
          cursor: null,
          limit: 25
        }
      } as CollaborationRendererCommand;

      expect(
        parseResult((await injectCommand(harness.app, command)).body)
      ).toMatchObject({ ok: false, error: { code } });
      expect(harness.calls).toEqual([]);
      await harness.app.close();
    }
  );

  it.each([
    "access_revoked",
    "permission_denied",
    "temporarily_unavailable"
  ] as const)(
    "fails closed when Shared Memory selection source authority returns %s",
    async (code) => {
      let sourceDispatches = 0;
      const harness = createHarness({
        response: remoteCompositionResponse,
        sharedMemoryControl: {
          resolvePreviewTarget: async () => null,
          resolveConsentPreview: async () => null,
          dispatch: async () => null,
          loadInitialSharedSession: async (input) => {
            sourceDispatches += 1;
            return {
              sourceResult: collaborationCommandResultSchema.parse({
                contractVersion: COLLABORATION_CONTRACT_VERSION,
                requestId: input.requestId,
                command: "collaboration.load_shared_source_page",
                ok: false,
                error: {
                  code,
                  userMessage: collaborationSafeErrorMessages[code],
                  retryable: code === "temporarily_unavailable",
                  retryAfterMs: null
                }
              }),
              companion: {}
            };
          }
        }
      });
      const command = {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.select",
        input: {
          selection: {
            kind: "shared_session",
            teamId: ids.team,
            workspaceId: ids.workspace,
            sharedSessionId: ids.sharedGrant
          }
        }
      } as CollaborationRendererCommand;

      expect(
        parseResult((await injectCommand(harness.app, command)).body)
      ).toMatchObject({ ok: false, error: { code } });
      expect(sourceDispatches).toBe(1);
      await harness.app.close();
    }
  );

  it("rejects a fallback representation while selecting Shared Memory", async () => {
    const harness = createHarness({
      response: remoteCompositionResponse,
      sharedMemoryControl: {
        resolvePreviewTarget: async () => null,
        resolveConsentPreview: async () => null,
        dispatch: async () => null,
        loadInitialSharedSession: async (input) => ({
          sourceResult: collaborationCommandResultSchema.parse({
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: input.requestId,
            command: "collaboration.load_shared_source_page",
            ok: true,
            data: {
              page: {
                ...sharedSourcePage,
                representation: "lcm_leaves",
                items: [
                  {
                    id: ids.sharedSourceItem,
                    representation: "lcm_leaves",
                    sequence: 1,
                    occurredAt: iso,
                    summaryText: "This representation was not selected.",
                    sourceCount: 1,
                    sourceRevision: `ssr1.${"b".repeat(64)}`
                  }
                ]
              }
            }
          }),
          companion: {}
        })
      }
    });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.select",
      input: {
        selection: {
          kind: "shared_session",
          teamId: ids.team,
          workspaceId: ids.workspace,
          sharedSessionId: ids.sharedGrant
        }
      }
    } as CollaborationRendererCommand;

    expect(
      parseResult((await injectCommand(harness.app, command)).body)
    ).toMatchObject({ ok: false, error: { code: "not_available" } });
    await harness.app.close();
  });

  it("uses backend, principal, thread, and direction-bound opaque Team message cursors", async () => {
    const harness = createHarness({ response: remoteCompositionResponse });
    const firstCommand = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.load_message_page",
      input: {
        thread: { scope: "team", teamId: ids.team, threadId: ids.thread },
        direction: "older",
        cursor: null,
        limit: 1
      }
    } as CollaborationRendererCommand;
    const first = parseResultAs<MessagePageTestResult>(
      (await injectCommand(harness.app, firstCommand)).body
    );
    expect(first).toMatchObject({
      ok: true,
      data: { page: { items: [{ sequence: 3 }], hasOlder: true } }
    });
    if (!first.ok || first.command !== "collaboration.load_message_page") {
      throw new Error("Expected Team message page");
    }
    const cursor = first.data.page.olderCursor;
    expect(cursor).toMatch(/^ctmc1\./);

    const nextCommand = {
      ...firstCommand,
      requestId: randomUUID(),
      input: { ...firstCommand.input, cursor }
    } as CollaborationRendererCommand;
    expect(
      parseResult((await injectCommand(harness.app, nextCommand)).body)
    ).toMatchObject({
      ok: true,
      data: { page: { items: [{ sequence: 2 }] } }
    });

    const tampered = `${cursor!.slice(0, -1)}${cursor!.endsWith("a") ? "b" : "a"}`;
    const invalid = [
      {
        ...nextCommand,
        requestId: randomUUID(),
        input: { ...nextCommand.input, cursor: tampered }
      },
      {
        ...nextCommand,
        requestId: randomUUID(),
        input: {
          ...nextCommand.input,
          thread: { scope: "team", teamId: ids.team, threadId: randomUUID() }
        }
      },
      {
        ...nextCommand,
        requestId: randomUUID(),
        input: { ...nextCommand.input, direction: "newer" }
      }
    ] as CollaborationRendererCommand[];
    for (const item of invalid) {
      expect(
        parseResult((await injectCommand(harness.app, item)).body)
      ).toMatchObject({
        ok: false,
        error: { code: "invalid_input" }
      });
    }
    const messageCalls = harness.calls.filter((call) =>
      new URL(call.url).pathname.endsWith(
        `/v1/collaboration/teams/${ids.team}/threads/${ids.thread}/messages`
      )
    );
    expect(
      messageCalls.every(
        (call) => !new URL(call.url).searchParams.has("cursor")
      )
    ).toBe(true);
  });

  it.each(["", localAuthorization, `${desktopAuthorization.slice(0, -1)}c`])(
    "rejects missing, LEC, or tampered DLC for Personal commands",
    async (authorization) => {
      const harness = createHarness({ backend: null });
      const command = {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.load",
        input: {}
      } as CollaborationRendererCommand;
      const response = await injectPersonalCommand(
        harness.app,
        command,
        authorization
      );
      expect(response.statusCode).toBe(401);
      expect(harness.calls).toHaveLength(0);
    }
  );

  it("revalidates the DLC owner and rejects disabled or mismatched local Users", async () => {
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.load",
      input: {}
    } as CollaborationRendererCommand;
    const disabled = createHarness({ activeUser: null });
    expect(
      parseResult((await injectPersonalCommand(disabled.app, command)).body)
    ).toMatchObject({ ok: false, error: { code: "access_revoked" } });

    const mismatched = createHarness({
      desktopOwnerUserId: ids.otherOwner,
      activeUser: {
        id: ids.otherOwner,
        email: "other@example.test",
        displayName: "Other"
      }
    });
    expect(
      parseResult((await injectPersonalCommand(mismatched.app, command)).body)
    ).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  });

  it("accepts DLC for Team commands and rejects Personal commands using LEC", async () => {
    const teamResponse = await injectCommand(
      createHarness().app,
      supportedMappings[0]!.command,
      desktopAuthorization
    );
    const personalResponse = await injectPersonalCommand(
      createHarness().app,
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.load",
        input: {}
      } as CollaborationRendererCommand,
      localAuthorization
    );
    expect(parseResult(teamResponse.body)).toMatchObject({ ok: true });
    expect(personalResponse.statusCode).toBe(401);
  });

  it("revalidates the DLC owner before resolving Team authority", async () => {
    const harness = createHarness({ activeUser: null });
    const response = await injectCommand(
      harness.app,
      supportedMappings[0]!.command
    );

    expect(parseResult(response.body)).toMatchObject({
      ok: false,
      error: { code: "access_revoked" }
    });
    expect(harness.localCredentialReads).toHaveLength(0);
    expect(harness.calls).toHaveLength(0);
  });

  it("strictly rejects cross-scope and authority-smuggling request envelopes", async () => {
    const harness = createHarness();
    const personal = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.create_personal_channel",
      input: { name: "Personal", topic: null }
    } as CollaborationRendererCommand;
    const team = supportedMappings[0]!.command;
    const payloads = [
      { upstream_backend_id: "team-vps", command: personal },
      { command: team },
      {
        command: {
          ...personal,
          input: { ...personal.input, teamId: ids.team }
        }
      },
      {
        command: {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: randomUUID(),
          command: "collaboration.rename_thread",
          input: {
            thread: {
              scope: "team",
              teamId: ids.team,
              threadId: ids.thread
            },
            name: "Cross scope",
            expectedVersion: 1
          }
        }
      }
    ];
    for (const payload of payloads) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/local-edge/collaboration/command",
        headers: {
          authorization: desktopAuthorization,
          host: "localhost:3300"
        },
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(harness.calls).toHaveLength(0);
  });

  it("executes retry_message only with its immutable client identity and body", async () => {
    const harness = createHarness({ backend: null });
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.retry_message",
      input: {
        thread: { scope: "personal", threadId: ids.personalThread },
        clientMessageId: ids.clientMessage,
        body: "message 3"
      }
    } as CollaborationRendererCommand;
    expect(
      parseResult((await injectPersonalCommand(harness.app, command)).body)
    ).toMatchObject({
      ok: true,
      data: {
        message: { id: ids.clientMessage, body: "message 3" }
      }
    });
    expect(harness.calls).toHaveLength(0);
  });

  it.each(supportedMappings)(
    "maps $command.command to its exact canonical operation",
    async ({ command, method, path, body, idempotencyKey }) => {
      const harness = createHarness({
        response: () => Response.json(resultPayloadFor(command))
      });
      const response = await injectCommand(harness.app, command);

      expect(response.statusCode).toBe(200);
      const result = parseResult(response.body);
      expect(result).toMatchObject({
        requestId: command.requestId,
        command: command.command,
        ok: true
      });
      expect(harness.calls).toHaveLength(1);
      const call = harness.calls[0]!;
      expect(new URL(call.url).pathname).toBe(path);
      expect(call.init.method).toBe(method);
      expect(JSON.parse(String(call.init.body))).toEqual(body);
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe(upstreamAuthorization);
      expect(headers.get("idempotency-key")).toBe(idempotencyKey ?? null);
      expect(call.init.redirect).toBe("error");
    }
  );

  it("substitutes stored upstream auth and does not forward local auth or cookies", async () => {
    const command = supportedMappings[7]!.command;
    const harness = createHarness({
      response: (call) => {
        const headers = new Headers(call.init.headers);
        expect(headers.get("authorization")).toBe(upstreamAuthorization);
        expect(headers.get("authorization")).not.toBe(desktopAuthorization);
        expect(headers.get("cookie")).toBeNull();
        return Response.json({
          ...resultPayloadFor(command),
          requestId: randomUUID(),
          command: "collaboration.load",
          credential: "must-not-escape",
          cursor: "must-not-escape"
        });
      }
    });
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/command",
      headers: {
        authorization: desktopAuthorization,
        cookie: "cm_session=must-not-forward",
        host: "localhost:3300"
      },
      payload: commandRequest(command)
    });

    const result = parseResultAs<{
      requestId: string;
      command: string;
    }>(response.body);
    expect(result.requestId).toBe(command.requestId);
    expect(result.command).toBe(command.command);
    expect(harness.localCredentialReads).toEqual(["team-vps"]);
    expect(response.body).not.toContain("must-not-escape");
    expect(response.body).not.toContain("upstream-secret");
  });

  it.each([
    "",
    localAuthorization,
    "Bearer personal-token",
    upstreamAuthorization
  ])(
    "rejects non-DLC local-boundary authorization %j",
    async (authorization) => {
      const harness = createHarness();
      const response = await injectCommand(
        harness.app,
        supportedMappings[0]!.command,
        authorization
      );
      expect(response.statusCode).toBe(401);
      expect(harness.calls).toHaveLength(0);
    }
  );

  it("rejects a session cookie as a DLC substitute at the local boundary", async () => {
    const harness = createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/command",
      headers: {
        cookie: "cm_session=browser-session",
        host: "localhost:3300"
      },
      payload: commandRequest(supportedMappings[0]!.command)
    });

    expect(response.statusCode).toBe(401);
    expect(harness.localCredentialReads).toHaveLength(0);
    expect(harness.calls).toHaveLength(0);
  });

  it("fails closed when the stored internal LEC lacks the command family", async () => {
    const harness = createHarness({ localFamilies: ["team_chat_read"] });
    const response = await injectCommand(
      harness.app,
      supportedMappings[0]!.command
    );
    expect(parseResult(response.body)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" }
    });
    expect(harness.calls).toHaveLength(0);
  });

  it.each([
    {
      command: {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.set_team_presence",
        input: {
          teamId: ids.team,
          mode: "auto",
          manualStatus: "available",
          expectedVersion: 1
        }
      } as CollaborationRendererCommand,
      response: {
        person: {
          userId: ids.remotePrincipal,
          displayName: "Remote Alice",
          status: "enabled",
          ...remotePresence
        }
      }
    },
    {
      command: {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.report_team_activity",
        input: { teamIds: [ids.team] }
      } as CollaborationRendererCommand,
      response: { acceptedTeamIds: [ids.team] }
    }
  ])(
    "authorizes $command.command with the documented Team read credential family",
    async ({ command, response: upstreamResponse }) => {
      const harness = createHarness({
        localFamilies: ["team_workspace_read", "team_chat_read"],
        response: () => Response.json(upstreamResponse)
      });
      const response = await injectCommand(harness.app, command);

      expect(parseResult(response.body)).toMatchObject({ ok: true });
      expect(harness.calls).toHaveLength(1);
    }
  );

  it.each([
    {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.set_team_presence",
      input: {
        teamId: ids.team,
        mode: "auto",
        manualStatus: "available",
        expectedVersion: 1
      }
    },
    {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.report_team_activity",
      input: { teamIds: [ids.team] }
    }
  ] as CollaborationRendererCommand[])(
    "rejects $command when the enrolled credential lacks Team read authority",
    async (command) => {
      const harness = createHarness({ localFamilies: ["team_chat_write"] });
      const response = await injectCommand(harness.app, command);

      expect(parseResult(response.body)).toMatchObject({
        ok: false,
        error: { code: "permission_denied" }
      });
      expect(harness.calls).toHaveLength(0);
    }
  );

  it("strictly rejects extra fields and malicious backend identifiers", async () => {
    const harness = createHarness();
    const command = supportedMappings[0]!.command;
    const payloads = [
      { ...commandRequest(command), authorization: upstreamAuthorization },
      {
        ...commandRequest(command),
        command: { ...command, credential: upstreamAuthorization }
      },
      { ...commandRequest(command), upstream_backend_id: "team-vps/../evil" },
      {
        ...commandRequest(command),
        command: {
          ...command,
          input: { ...command.input, teamId: "../other-team" }
        }
      },
      commandRequest({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.connect_backend",
        input: { remoteUrl: "https://user:password@team.example.test" }
      } as CollaborationRendererCommand)
    ];
    for (const payload of payloads) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/local-edge/collaboration/command",
        headers: {
          authorization: desktopAuthorization,
          host: "localhost:3300"
        },
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects non-local hosts and disallowed origins", async () => {
    const harness = createHarness();
    const command = supportedMappings[0]!.command;
    const hostResponse = await harness.app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/command",
      headers: { authorization: desktopAuthorization, host: "attacker.test" },
      payload: commandRequest(command)
    });
    const originResponse = await harness.app.inject({
      method: "POST",
      url: "/v1/local-edge/collaboration/command",
      headers: {
        authorization: desktopAuthorization,
        host: "localhost:3300",
        origin: "https://attacker.test"
      },
      payload: commandRequest(command)
    });
    expect(hostResponse.statusCode).toBe(403);
    expect(originResponse.statusCode).toBe(403);
    expect(harness.calls).toHaveLength(0);
  });

  it.each([
    { backend: null, families: ["team_chat_write"] },
    {
      backend: backend({ routePolicy: { teamWorkspaceRead: "disabled" } }),
      families: ["team_chat_write"]
    },
    {
      backend: backend({
        capabilities: {
          state: "validated",
          expiresAt: "2000-01-01T00:00:00.000Z",
          schemaVersion: 6,
          payload: {
            capabilitySchemaVersion: 6,
            capabilities: {
              "memory.collaboration": { availability: "available" }
            }
          }
        }
      }),
      families: ["team_chat_write"]
    },
    {
      backend: backend({
        capabilities: {
          state: "validated",
          expiresAt: "2099-01-01T00:00:00.000Z",
          schemaVersion: 5,
          payload: {
            capabilitySchemaVersion: 5,
            capabilities: {
              "memory.collaboration": { availability: "available" }
            }
          }
        }
      }),
      families: ["team_chat_write"]
    }
  ])(
    "fails closed on registry, route-policy, or capability mismatch",
    async ({ backend: configuredBackend, families }) => {
      const harness = createHarness({
        backend: configuredBackend,
        localFamilies: families
      });
      const response = await injectCommand(
        harness.app,
        supportedMappings[0]!.command
      );
      expect(parseResult(response.body)).toMatchObject({
        ok: false,
        error: { code: "temporarily_unavailable" }
      });
      expect(harness.repositoryRequests()).toBe(0);
      expect(harness.calls).toHaveLength(0);
    }
  );

  it("fails closed when stored upstream auth is unavailable", async () => {
    const harness = createHarness({ upstreamAuthorization: null });
    const response = await injectCommand(
      harness.app,
      supportedMappings[0]!.command
    );
    expect(parseResult(response.body)).toMatchObject({
      ok: false,
      error: { code: "temporarily_unavailable" }
    });
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects credential-bearing backend URLs without making a request", async () => {
    const harness = createHarness({
      backend: backend({
        baseUrl: "https://embedded:secret@team.example.test/koed"
      })
    });
    const response = await injectCommand(
      harness.app,
      supportedMappings[0]!.command
    );
    expect(parseResult(response.body)).toMatchObject({
      ok: false,
      error: { code: "temporarily_unavailable" }
    });
    expect(response.body).not.toContain("embedded");
    expect(response.body).not.toContain("secret");
    expect(harness.calls).toHaveLength(0);
  });

  it("does not follow upstream redirects", async () => {
    const harness = createHarness({
      response: (call) => {
        expect(call.init.redirect).toBe("error");
        throw new TypeError("redirect blocked");
      }
    });
    const response = await injectCommand(
      harness.app,
      supportedMappings[0]!.command
    );
    expect(parseResult(response.body)).toMatchObject({
      ok: false,
      error: { code: "offline" }
    });
  });

  it("bounds upstream responses and returns only correlated contract data", async () => {
    const harness = createHarness({
      response: () =>
        new Response("{}", {
          headers: { "content-length": String(3 * 1024 * 1024) }
        })
    });
    const command = supportedMappings[0]!.command;
    const response = await injectCommand(harness.app, command);
    expect(parseResult(response.body)).toMatchObject({
      requestId: command.requestId,
      command: command.command,
      ok: false,
      error: { code: "internal_error" }
    });
  });

  it("adapts current canonical route DTOs to the shared result contract", async () => {
    const canonicalThread = {
      id: ids.thread,
      logicalId: ids.logicalThread,
      scope: "team",
      kind: "workspace_channel",
      personalOwnerUserId: null,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      sharedLogicalMemoryId: null,
      shareGrantId: null,
      systemKey: null,
      name: "General",
      topic: null,
      createdByUserId: ids.actor,
      version: 1,
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
    };
    const canonicalMessage = {
      id: ids.message,
      threadId: ids.thread,
      threadSequence: 1,
      scope: "team",
      personalOwnerUserId: null,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      senderKind: "user",
      senderPrincipalId: ids.participant,
      senderUserId: ids.participant,
      senderDisplayName: null,
      audienceVersion: 1,
      recipientStatus: "sent",
      bodyText: "hello",
      metadata: {},
      provenance: { kind: "user", id: ids.participant },
      createdAt: iso,
      updatedAt: iso
    };
    const canonicalReadState = {
      threadId: ids.thread,
      userId: ids.actor,
      lastDeliveredMessageId: ids.message,
      lastDeliveredSequence: 1,
      lastDeliveredAt: iso,
      lastReadMessageId: ids.message,
      lastReadSequence: 1,
      lastReadAt: iso,
      unreadCount: 0,
      version: 1,
      updatedAt: iso
    };
    const cases = [
      {
        command: supportedMappings[0]!.command,
        payload: { thread: canonicalThread },
        expected: { data: { thread: teamThread } }
      },
      {
        command: supportedMappings[7]!.command,
        payload: { message: canonicalMessage },
        expected: {
          data: {
            message: {
              ...teamMessage,
              sender: { ...teamMessage.sender, displayName: "Team member" }
            }
          }
        }
      },
      {
        command: supportedMappings[8]!.command,
        payload: { readState: canonicalReadState },
        expected: { data: { readState } }
      }
    ];
    for (const item of cases) {
      const harness = createHarness({
        response: () => Response.json(item.payload)
      });
      const response = await injectCommand(harness.app, item.command);
      expect(parseResult(response.body)).toMatchObject({
        ok: true,
        ...item.expected
      });
    }
  });

  it("rejects cross-Team upstream results with correlated typed failure", async () => {
    const command = supportedMappings[0]!.command;
    const harness = createHarness({
      response: () =>
        Response.json({
          thread: { ...teamThread, teamId: randomUUID() },
          requestId: randomUUID(),
          command: "collaboration.load"
        })
    });
    const response = await injectCommand(harness.app, command);
    expect(parseResult(response.body)).toMatchObject({
      requestId: command.requestId,
      command: command.command,
      ok: false,
      error: { code: "internal_error" }
    });
  });

  it.each([
    {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: "collaboration.subscribe",
      input: { scope: { scope: "team", teamId: ids.team } }
    }
  ] as CollaborationRendererCommand[])(
    "returns typed not_available without proxying unsupported $command",
    async (command) => {
      const harness = createHarness();
      const response = await injectCommand(harness.app, command);
      expect(response.statusCode).toBe(200);
      expect(parseResult(response.body)).toMatchObject({
        requestId: command.requestId,
        command: command.command,
        ok: false,
        error: { code: "not_available" }
      });
      expect(harness.calls).toHaveLength(0);
    }
  );

  it("maps upstream denial and retry statuses to safe typed failures", async () => {
    const command = supportedMappings[0]!.command;
    const denied = createHarness({
      response: () =>
        new Response("credential=must-not-escape", { status: 403 })
    });
    const rateLimited = createHarness({
      response: () =>
        new Response("cursor=must-not-escape", {
          status: 429,
          headers: { "retry-after": "2" }
        })
    });
    const deniedResponse = await injectCommand(denied.app, command);
    const rateResponse = await injectCommand(rateLimited.app, command);
    expect(parseResult(deniedResponse.body)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" }
    });
    expect(parseResult(rateResponse.body)).toMatchObject({
      ok: false,
      error: { code: "rate_limited", retryAfterMs: 2000 }
    });
    expect(deniedResponse.body).not.toContain("must-not-escape");
    expect(rateResponse.body).not.toContain("must-not-escape");
  });
});
