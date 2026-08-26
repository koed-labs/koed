import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import type {
  ActorContext,
  CollaborationMessageRecord,
  CollaborationRepository,
  CollaborationThreadRecord,
  CreateCollaborationThreadInput,
  MemorySourceRepository,
  PersonalNoteRecord
} from "@koed/db";
import {
  CollaborationIdempotencyConflictError,
  CollaborationVersionConflictError
} from "@koed/db";
import {
  sharedMemoryGrantScopedPrincipalId,
  sharedMemoryGrantScopedSourceId
} from "@koed/shared";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MemoryRateLimitStore } from "../infra/rate-limit.js";
import {
  createCollaborationAdmissionController,
  type CollaborationAdmissionController
} from "./admission.js";
import { registerCollaborationRoutes } from "./routes.js";

const iso = "2026-07-17T00:00:00.000Z";

type FixtureUser = {
  id: string;
  email: string;
  displayName: string | null;
  roleByTeam: Map<string, "owner" | "admin" | "member">;
  workspaceAccess: Map<string, "read" | "write">;
};

const jsonBody = <T>(response: { body: string }): T =>
  JSON.parse(response.body) as T;

const createCollaborationFixture = () => {
  const ids = {
    alice: randomUUID(),
    bob: randomUUID(),
    carol: randomUUID(),
    dave: randomUUID(),
    teamA: randomUUID(),
    teamB: randomUUID(),
    workspaceA: randomUUID(),
    workspaceB: randomUUID(),
    deployment: randomUUID(),
    logicalMemory: randomUUID(),
    shareGrant: randomUUID()
  };
  const users = new Map<string, FixtureUser>([
    [
      ids.alice,
      {
        id: ids.alice,
        email: "alice@example.test",
        displayName: "Alice",
        roleByTeam: new Map([
          [ids.teamA, "owner"],
          [ids.teamB, "member"]
        ]),
        workspaceAccess: new Map([
          [ids.workspaceA, "write"],
          [ids.workspaceB, "write"]
        ])
      }
    ],
    [
      ids.bob,
      {
        id: ids.bob,
        email: "bob@example.test",
        displayName: "Bob",
        roleByTeam: new Map([[ids.teamA, "member"]]),
        workspaceAccess: new Map([[ids.workspaceA, "read"]])
      }
    ],
    [
      ids.carol,
      {
        id: ids.carol,
        email: "carol@example.test",
        displayName: "Carol",
        roleByTeam: new Map([[ids.teamA, "admin"]]),
        workspaceAccess: new Map()
      }
    ],
    [
      ids.dave,
      {
        id: ids.dave,
        email: "dave@example.test",
        displayName: "Dave",
        roleByTeam: new Map([[ids.teamB, "member"]]),
        workspaceAccess: new Map([[ids.workspaceB, "write"]])
      }
    ]
  ]);
  const threads = new Map<string, CollaborationThreadRecord>();
  const messages = new Map<string, CollaborationMessageRecord[]>();
  const notes = new Map<string, PersonalNoteRecord>();
  const noteOwners = new Map<string, string>();
  const noteRequests = new Map<string, { body: string; noteId: string }>();
  const threadRequests = new Map<
    string,
    { request: string; threadId: string }
  >();
  const messageRequests = new Map<
    string,
    { bodyText: string; messageId: string }
  >();
  let storedThreadCount = 0;
  let storedMessageCount = 0;
  let storedNoteCount = 0;

  const participant = (userId: string) => ({
    userId,
    displayName: users.get(userId)?.displayName ?? null
  });

  const newThread = (input: {
    kind: CollaborationThreadRecord["kind"];
    actorUserId: string;
    personalOwnerUserId?: string | null;
    teamId?: string | null;
    teamWorkspaceId?: string | null;
    sharedLogicalMemoryId?: string | null;
    shareGrantId?: string | null;
    name?: string | null;
    topic?: string | null;
    participantUserIds?: string[];
  }): CollaborationThreadRecord => {
    const thread: CollaborationThreadRecord = {
      id: randomUUID(),
      logicalId: randomUUID(),
      scope: input.personalOwnerUserId ? "personal" : "team",
      kind: input.kind,
      personalOwnerUserId: input.personalOwnerUserId ?? null,
      teamId: input.teamId ?? null,
      teamWorkspaceId: input.teamWorkspaceId ?? null,
      sharedLogicalMemoryId: input.sharedLogicalMemoryId ?? null,
      shareGrantId: input.shareGrantId ?? null,
      systemKey: null,
      name: input.name ?? null,
      topic: input.topic ?? null,
      createdByUserId: input.actorUserId,
      version: 1,
      lifecycle: "active",
      latestSequence: 0,
      lastReadMessageId: null,
      lastReadSequence: 0,
      unreadCount: 0,
      participants: (input.participantUserIds ?? []).map(participant),
      createdAt: iso,
      updatedAt: iso,
      lastActivityAt: iso,
      archivedAt: null
    };
    threads.set(thread.id, thread);
    storedThreadCount += 1;
    return thread;
  };

  const personalThread = newThread({
    kind: "personal_channel",
    actorUserId: ids.alice,
    personalOwnerUserId: ids.alice,
    name: "Alice private"
  });
  const workspaceThread = newThread({
    kind: "workspace_channel",
    actorUserId: ids.alice,
    teamId: ids.teamA,
    teamWorkspaceId: ids.workspaceA,
    name: "Workspace A"
  });
  const sharedSessionThread = newThread({
    kind: "shared_session_discussion",
    actorUserId: ids.alice,
    teamId: ids.teamA,
    teamWorkspaceId: ids.workspaceA,
    sharedLogicalMemoryId: ids.logicalMemory,
    shareGrantId: ids.shareGrant
  });

  const teamMember = (userId: string, teamId: string): boolean =>
    users.get(userId)?.roleByTeam.has(teamId) === true;

  const workspaceAccess = (
    userId: string,
    workspaceId: string | null
  ): "read" | "write" | null =>
    workspaceId
      ? (users.get(userId)?.workspaceAccess.get(workspaceId) ?? null)
      : null;

  const workspaceTeamId = (workspaceId: string): string | null =>
    workspaceId === ids.workspaceA
      ? ids.teamA
      : workspaceId === ids.workspaceB
        ? ids.teamB
        : null;

  const canRead = (userId: string, thread: CollaborationThreadRecord) => {
    if (thread.scope === "personal") {
      return thread.personalOwnerUserId === userId;
    }
    if (!thread.teamId || !teamMember(userId, thread.teamId)) return false;
    if (thread.kind === "dm" || thread.kind === "group_dm") {
      return thread.participants.some((item) => item.userId === userId);
    }
    return workspaceAccess(userId, thread.teamWorkspaceId) !== null;
  };

  const canWrite = (userId: string, thread: CollaborationThreadRecord) => {
    if (!canRead(userId, thread)) return false;
    if (thread.scope === "personal") return true;
    if (thread.kind === "dm" || thread.kind === "group_dm") return true;
    return workspaceAccess(userId, thread.teamWorkspaceId) === "write";
  };

  const authorizedThread = (
    actor: ActorContext,
    threadId: string,
    required: "read" | "write",
    includeArchived = false
  ): CollaborationThreadRecord | null => {
    const thread = threads.get(threadId);
    if (!thread) return null;
    if (thread.lifecycle === "archived" && !includeArchived) return null;
    const allowed =
      required === "read"
        ? canRead(actor.userId, thread)
        : canWrite(actor.userId, thread);
    return allowed ? thread : null;
  };

  const createThread = (
    actor: ActorContext,
    input: CreateCollaborationThreadInput
  ): CollaborationThreadRecord | null => {
    const requestKey = `${actor.userId}:${input.kind}:${input.idempotencyKey}`;
    const request = JSON.stringify(input);
    const existing = threadRequests.get(requestKey);
    if (existing) {
      if (existing.request !== request) {
        throw new CollaborationIdempotencyConflictError();
      }
      return authorizedThread(actor, existing.threadId, "write", true);
    }

    let thread: CollaborationThreadRecord;
    if (input.kind === "personal_channel") {
      thread = newThread({
        kind: input.kind,
        actorUserId: actor.userId,
        personalOwnerUserId: actor.userId,
        name: input.name,
        topic: input.topic
      });
    } else if (input.kind === "dm" || input.kind === "group_dm") {
      const participantUserIds = [
        ...new Set([actor.userId, ...input.participantUserIds])
      ];
      if (
        !teamMember(actor.userId, input.teamId) ||
        participantUserIds.some(
          (participantUserId) => !teamMember(participantUserId, input.teamId)
        )
      ) {
        return null;
      }
      thread = newThread({
        kind: input.kind,
        actorUserId: actor.userId,
        teamId: input.teamId,
        participantUserIds
      });
    } else {
      if (!("teamWorkspaceId" in input)) return null;
      if (
        !teamMember(actor.userId, input.teamId) ||
        workspaceAccess(actor.userId, input.teamWorkspaceId) !== "write"
      ) {
        return null;
      }
      thread = newThread({
        kind: input.kind,
        actorUserId: actor.userId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        name: "name" in input ? input.name : null,
        topic: "topic" in input ? input.topic : null,
        sharedLogicalMemoryId:
          "sharedLogicalMemoryId" in input ? input.sharedLogicalMemoryId : null,
        shareGrantId: "shareGrantId" in input ? input.shareGrantId : null
      });
    }
    threadRequests.set(requestKey, { request, threadId: thread.id });
    return thread;
  };

  const repository: CollaborationRepository &
    Pick<
      MemorySourceRepository,
      "getPersonalNoteMemoryEvent" | "getLocalSyncDeployment"
    > = {
    async getLocalSyncDeployment() {
      return {
        id: ids.deployment,
        protocolDeploymentId: ids.deployment,
        locality: "local",
        profile: "local_personal",
        baseUrl: null,
        upstreamBackendId: null
      };
    },
    async listTeamParticipants(actor, teamId) {
      if (!teamMember(actor.userId, teamId)) return null;
      return [...users.values()]
        .filter((user) => user.roleByTeam.has(teamId))
        .map((user) => participant(user.id));
    },
    async createThread(actor, input) {
      return createThread(actor, input);
    },
    async getThread(actor, input) {
      return authorizedThread(
        actor,
        input.threadId,
        "read",
        input.includeArchived
      );
    },
    async listThreads(actor, input) {
      if (input.scope === "personal") {
        if (!users.has(actor.userId)) return null;
      } else if (!teamMember(actor.userId, input.teamId)) {
        return null;
      } else if (
        input.teamWorkspaceId &&
        (workspaceTeamId(input.teamWorkspaceId) !== input.teamId ||
          workspaceAccess(actor.userId, input.teamWorkspaceId) === null)
      ) {
        return null;
      }
      return [...threads.values()]
        .filter((thread) =>
          input.scope === "personal"
            ? thread.scope === "personal"
            : thread.scope === "team" && thread.teamId === input.teamId
        )
        .filter(
          (thread) => input.includeArchived || thread.lifecycle !== "archived"
        )
        .filter((thread) =>
          input.scope === "team" && input.teamWorkspaceId
            ? thread.teamWorkspaceId === input.teamWorkspaceId
            : true
        )
        .filter((thread) =>
          input.scope === "team" && input.kinds?.length
            ? input.kinds.includes(thread.kind as (typeof input.kinds)[number])
            : true
        )
        .filter((thread) => canRead(actor.userId, thread))
        .slice(0, input.limit ?? 100);
    },
    async renameThread(actor, input) {
      const thread = authorizedThread(actor, input.threadId, "write");
      if (!thread) return null;
      if (thread.version !== input.expectedVersion) {
        throw new CollaborationVersionConflictError();
      }
      thread.name = input.name;
      thread.version += 1;
      return thread;
    },
    async updateThreadTopic(actor, input) {
      const thread = authorizedThread(actor, input.threadId, "write");
      if (!thread) return null;
      if (thread.version !== input.expectedVersion) {
        throw new CollaborationVersionConflictError();
      }
      thread.topic = input.topic;
      thread.version += 1;
      return thread;
    },
    async archiveThread(actor, input) {
      const thread = authorizedThread(actor, input.threadId, "write");
      if (!thread) return null;
      if (thread.version !== input.expectedVersion) {
        throw new CollaborationVersionConflictError();
      }
      thread.lifecycle = "archived";
      thread.archivedAt = iso;
      thread.version += 1;
      return thread;
    },
    async restoreThread(actor, input) {
      const thread = authorizedThread(actor, input.threadId, "write", true);
      if (!thread) return null;
      if (thread.version !== input.expectedVersion) {
        throw new CollaborationVersionConflictError();
      }
      thread.lifecycle = "active";
      thread.archivedAt = null;
      thread.version += 1;
      return thread;
    },
    async sendMessage(actor, input) {
      const thread = authorizedThread(actor, input.threadId, "write");
      if (!thread) return null;
      const requestKey = `${input.threadId}:${actor.userId}:${input.idempotencyKey}`;
      const existing = messageRequests.get(requestKey);
      if (existing) {
        if (existing.bodyText !== input.bodyText) {
          throw new CollaborationIdempotencyConflictError();
        }
        return (
          messages
            .get(input.threadId)
            ?.find((message) => message.id === existing.messageId) ?? null
        );
      }
      const threadMessages = messages.get(input.threadId) ?? [];
      const message: CollaborationMessageRecord = {
        id: randomUUID(),
        threadId: input.threadId,
        threadSequence: threadMessages.length + 1,
        audienceVersion: 1,
        scope: thread.scope,
        personalOwnerUserId: thread.personalOwnerUserId,
        teamId: thread.teamId,
        teamWorkspaceId: thread.teamWorkspaceId,
        senderKind: "user",
        senderPrincipalId: actor.userId,
        senderUserId: actor.userId,
        senderDisplayName: users.get(actor.userId)?.displayName ?? null,
        recipientStatus: "sent",
        bodyText: input.bodyText,
        metadata: {},
        provenance: { kind: "user_message", id: randomUUID() },
        createdAt: iso,
        updatedAt: iso
      };
      threadMessages.push(message);
      messages.set(input.threadId, threadMessages);
      messageRequests.set(requestKey, {
        bodyText: input.bodyText,
        messageId: message.id
      });
      storedMessageCount += 1;
      thread.latestSequence = message.threadSequence;
      return message;
    },
    async listMessages(actor, input) {
      if (!authorizedThread(actor, input.threadId, "read", true)) return null;
      const all = messages.get(input.threadId) ?? [];
      const selected = all
        .filter(
          (message) =>
            message.threadSequence > (input.afterSequence ?? 0) &&
            (input.beforeSequence === undefined ||
              message.threadSequence < input.beforeSequence)
        )
        .slice(0, input.limit ?? 50);
      return {
        messages: selected,
        hasMore: selected.length < all.length,
        nextBeforeSequence: selected[0]?.threadSequence ?? null,
        nextAfterSequence: selected[selected.length - 1]?.threadSequence ?? null
      };
    },
    async listPersonalNotes(actor, input = {}) {
      const selected = [...notes.values()]
        .filter((note) => noteOwners.get(note.noteId) === actor.userId)
        .filter(
          (note) =>
            input.beforeSequence === undefined ||
            note.sourceSequence < input.beforeSequence
        )
        .sort((left, right) => right.sourceSequence - left.sourceSequence)
        .slice(0, input.limit ?? 50);
      return {
        notes: selected,
        nextBeforeSequence: null
      };
    },
    async getPersonalNote(actor, input) {
      const note = notes.get(input.noteId);
      return note && noteOwners.get(note.noteId) === actor.userId ? note : null;
    },
    async createPersonalNote(actor, input) {
      const requestKey = `${actor.userId}:${input.idempotencyKey}`;
      const existing = noteRequests.get(requestKey);
      if (existing) {
        if (existing.body !== input.body) {
          throw new CollaborationIdempotencyConflictError();
        }
        return notes.get(existing.noteId)!;
      }
      storedNoteCount += 1;
      const noteId = randomUUID();
      const note: PersonalNoteRecord = {
        noteId,
        logicalMemoryId: randomUUID(),
        title: input.body.split(/\r?\n/u)[0]!,
        titleVersion: 1,
        body: input.body,
        revisionId: randomUUID(),
        revision: 1,
        contentHash: "a".repeat(64),
        memoryEventId: null,
        projectionState: "pending",
        projectionFailureCode: null,
        createdAt: iso,
        updatedAt: iso,
        sourceSequence: storedNoteCount
      };
      notes.set(noteId, note);
      noteOwners.set(noteId, actor.userId);
      noteRequests.set(requestKey, { body: input.body, noteId });
      return note;
    },
    async renamePersonalNote(actor, input) {
      const note = await this.getPersonalNote(actor, { noteId: input.noteId });
      if (!note) return null;
      if (note.titleVersion !== input.expectedTitleVersion) {
        throw new CollaborationVersionConflictError();
      }
      const renamed = {
        ...note,
        title: input.title,
        titleVersion: note.titleVersion + 1
      };
      notes.set(note.noteId, renamed);
      return renamed;
    },
    async updatePersonalNoteBody(actor, input) {
      const note = await this.getPersonalNote(actor, { noteId: input.noteId });
      if (!note) return null;
      if (note.revision !== input.expectedRevision) {
        throw new CollaborationVersionConflictError();
      }
      const updated: PersonalNoteRecord = {
        ...note,
        body: input.body,
        revisionId: randomUUID(),
        revision: note.revision + 1,
        contentHash: "b".repeat(64),
        memoryEventId: null,
        projectionState: "pending",
        updatedAt: iso
      };
      notes.set(note.noteId, updated);
      return updated;
    },
    async listPendingPersonalNoteRevisions() {
      return [...notes.values()]
        .filter((note) => note.projectionState !== "available")
        .map((note) => ({
          ownerUserId: noteOwners.get(note.noteId)!,
          noteId: note.noteId,
          revision: note.revision
        }));
    },
    async markPersonalNoteProjectionAvailable(actor, input) {
      const note = await this.getPersonalNote(actor, { noteId: input.noteId });
      if (!note || note.revision !== input.revision) return null;
      const projected: PersonalNoteRecord = {
        ...note,
        memoryEventId: input.memoryEventId,
        projectionState: "available",
        projectionFailureCode: null
      };
      notes.set(note.noteId, projected);
      return projected;
    },
    async markPersonalNoteProjectionFailed(actor, input) {
      const note = await this.getPersonalNote(actor, { noteId: input.noteId });
      if (!note || note.revision !== input.revision) return;
      notes.set(note.noteId, {
        ...note,
        projectionState: "failed",
        projectionFailureCode: input.failureCode
      });
    },
    async getPersonalNoteMemoryEvent(actor, noteId) {
      const note = await this.getPersonalNote(actor, { noteId });
      return note?.memoryEventId
        ? {
            id: note.memoryEventId,
            actor: "user",
            eventType: "personal_note_revision",
            sourceRuntime: null,
            captureMethod: "api",
            model: null,
            projectId: null,
            projectName: null,
            projectPath: null,
            sessionId: null,
            threadId: null,
            threadName: null,
            timestamp: note.createdAt,
            sourceEventTime: note.createdAt,
            sourceSequence: note.sourceSequence,
            capturedAt: note.createdAt,
            createdAt: note.createdAt,
            visibility: "personal",
            invalidatedAt: null,
            invalidationReason: null,
            contentPreview: note.body,
            content: note.body,
            metadata: {},
            linkedNodeIds: []
          }
        : null;
    },
    async advanceReadState(actor, input) {
      if (!authorizedThread(actor, input.threadId, "read", true)) return null;
      const message = messages
        .get(input.threadId)
        ?.find((candidate) => candidate.id === input.messageId);
      if (!message) return null;
      return {
        threadId: input.threadId,
        userId: actor.userId,
        lastDeliveredMessageId: message.id,
        lastDeliveredSequence: message.threadSequence,
        lastDeliveredAt: iso,
        lastReadMessageId: message.id,
        lastReadSequence: message.threadSequence,
        lastReadAt: iso,
        unreadCount: 0,
        version: 1,
        updatedAt: iso
      };
    },
    async advanceDeliveryState(actor, input) {
      if (!authorizedThread(actor, input.threadId, "read", true)) return null;
      const message = messages
        .get(input.threadId)
        ?.find((candidate) => candidate.id === input.messageId);
      if (!message) return null;
      return {
        threadId: input.threadId,
        userId: actor.userId,
        lastDeliveredMessageId: message.id,
        lastDeliveredSequence: message.threadSequence,
        lastDeliveredAt: iso,
        lastReadMessageId: null,
        lastReadSequence: 0,
        lastReadAt: null,
        unreadCount: message.senderUserId === actor.userId ? 0 : 1,
        version: 1,
        updatedAt: iso
      };
    },
    async getAuthorizedSnapshot() {
      return null;
    },
    async replayEvents() {
      return null;
    },
    async pruneExpiredReplayHistory() {
      return { deletedEventCount: 0, deletedSubscriptionCount: 0 };
    },
    async createSubscription() {
      return null;
    },
    async recoverSubscription() {
      return null;
    },
    async acknowledgeSubscription() {
      return null;
    },
    async revokeSubscriptions() {
      return { revokedCount: 0 };
    }
  };

  return {
    ids,
    users,
    repository,
    personalThread,
    workspaceThread,
    sharedSessionThread,
    stats: {
      get storedThreadCount() {
        return storedThreadCount;
      },
      get storedMessageCount() {
        return storedMessageCount;
      }
    }
  };
};

const buildTestServer = async (
  fixture: ReturnType<typeof createCollaborationFixture>,
  admission?: CollaborationAdmissionController,
  projectPersonalNote: (input: {
    ownerUserId: string;
    note: PersonalNoteRecord;
  }) => Promise<void> = async () => undefined
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
  const noRateLimit = async () => {};
  const noAdmission = async () => [];
  const authenticateSession = async (request: FastifyRequest) => {
    const user = fixture.users.get(request.cookies.cm_session ?? "");
    if (!user) {
      throw Object.assign(new Error("Session cookie required"), {
        statusCode: 401
      });
    }
    return user;
  };
  registerCollaborationRoutes(app, {
    requireCollaborationRepository: () => fixture.repository,
    requireSharedMemoryRepository: () => ({
      async listWorkspaceGrants(_actor, input) {
        const available =
          input.teamId === fixture.ids.teamA &&
          input.teamWorkspaceId === fixture.ids.workspaceA &&
          input.offset === 0;
        return {
          entries: available
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
                  title: "Shared session",
                  activeRepresentation: "memory_events" as const,
                  representationState: "available" as const,
                  representationSourceRevision: 1,
                  representationUpdatedAt: iso,
                  freshness: "fresh" as const,
                  lifecycle: "active" as const,
                  createdAt: iso,
                  updatedAt: iso,
                  companionScope: {
                    scope: "team" as const,
                    kind: "shared_session_discussion" as const,
                    teamId: fixture.ids.teamA,
                    teamWorkspaceId: fixture.ids.workspaceA,
                    logicalMemoryId: fixture.ids.logicalMemory,
                    shareGrantId: fixture.ids.shareGrant
                  }
                }
              ]
            : [],
          limit: input.limit,
          offset: input.offset,
          hasMore: false
        };
      }
    }),
    projectPersonalNote,
    authenticateApiToken: async (request) => {
      const authorization = request.headers.authorization?.trim() ?? "";
      const user =
        authorization === "Bearer personal-api-token"
          ? fixture.users.get(fixture.ids.alice)
          : null;
      if (!user) {
        throw Object.assign(new Error("Invalid API token"), {
          statusCode: 401
        });
      }
      return user;
    },
    authenticateSessionOrDeviceCredential: async (
      request,
      operationFamily,
      options = {}
    ) => {
      const authorization = request.headers.authorization?.trim() ?? "";
      if (/^Bearer(?:\s|$)/i.test(authorization)) {
        throw Object.assign(
          new Error(
            options.apiTokenError ??
              "Session cookie or scoped device credential required"
          ),
          { statusCode: 403 }
        );
      }
      const match = /^Koed-Device\s+([^:]+):(.+)$/i.exec(authorization);
      if (!match) return authenticateSession(request);
      const user = fixture.users.get(match[1] ?? "");
      if (!user) {
        throw Object.assign(new Error("Invalid device credential"), {
          statusCode: 401
        });
      }
      const operationFamilies = new Set((match[2] ?? "").split(","));
      if (!operationFamilies.has(operationFamily)) {
        throw Object.assign(
          new Error("Device credential is not allowed for this operation"),
          { statusCode: 403 }
        );
      }
      return user;
    },
    readRateLimit: noRateLimit,
    writeRateLimit: noRateLimit,
    admission: admission ?? {
      admitMessage: noAdmission,
      admitChannelCreation: noAdmission,
      admitInviteCreation: noAdmission,
      admitConnectionFailure: noAdmission
    }
  });
  return app;
};

const sessionHeaders = (
  userId: string,
  extra: Record<string, string> = {}
) => ({
  cookie: `cm_session=${userId}`,
  ...extra
});

const deviceHeaders = (
  userId: string,
  operationFamilies: Array<
    | "personal_collaboration_read"
    | "personal_collaboration_write"
    | "team_chat_read"
    | "team_chat_write"
  >
) => ({
  authorization: `Koed-Device ${userId}:${operationFamilies.join(",")}`
});

describe("collaboration HTTP routes", () => {
  it("projects committed Personal Notes without projecting channel messages", async () => {
    const fixture = createCollaborationFixture();
    const projected: Array<{
      ownerUserId: string;
      note: PersonalNoteRecord;
    }> = [];
    const app = await buildTestServer(fixture, undefined, async (input) => {
      projected.push(input);
    });
    const noteResponse = await app.inject({
      method: "POST",
      url: "/v1/collaboration/personal/notes",
      headers: sessionHeaders(fixture.ids.alice, {
        "idempotency-key": "note-message"
      }),
      payload: { bodyText: "The launch date is September 14." }
    });
    expect(noteResponse.statusCode).toBe(201);
    expect(projected).toEqual([
      expect.objectContaining({
        ownerUserId: fixture.ids.alice,
        note: expect.objectContaining({
          body: "The launch date is September 14.",
          revision: 1,
          projectionState: "pending"
        })
      })
    ]);

    const channelResponse = await app.inject({
      method: "POST",
      url: `/v1/collaboration/personal/threads/${fixture.personalThread.id}/messages`,
      headers: sessionHeaders(fixture.ids.alice, {
        "idempotency-key": "personal-channel-message"
      }),
      payload: {
        bodyText: "This Personal channel message stays collaboration-only."
      }
    });
    expect(channelResponse.statusCode).toBe(201);
    expect(projected).toHaveLength(1);

    await app.close();
  });

  it("lists, loads, and renames only the owner's bound Personal Notes", async () => {
    const fixture = createCollaborationFixture();
    const projectPersonalNote = vi.fn(async () => undefined);
    const app = await buildTestServer(fixture, undefined, projectPersonalNote);
    const note = await fixture.repository.createPersonalNote(
      { userId: fixture.ids.alice },
      {
        idempotencyKey: "fixed-note-message",
        body: "Launch decision\nShip on Friday."
      }
    );

    const list = await app.inject({
      method: "GET",
      url: "/v1/collaboration/personal/notes?limit=50",
      headers: { authorization: "Bearer personal-api-token" }
    });
    expect(list.statusCode).toBe(200);
    expect(projectPersonalNote).not.toHaveBeenCalled();
    expect(
      jsonBody<{ notes: Array<Record<string, unknown>> }>(list).notes[0]
    ).toMatchObject({
      noteId: note.noteId,
      title: "Launch decision",
      titleVersion: 1,
      revision: 1,
      memoryEventId: null,
      projectionState: "pending"
    });
    expect(
      jsonBody<{ notes: Array<Record<string, unknown>> }>(list).notes[0]
    ).not.toHaveProperty("logicalMemoryId");

    const exact = await app.inject({
      method: "GET",
      url: `/v1/collaboration/personal/notes/${note.noteId}`,
      headers: { authorization: "Bearer personal-api-token" }
    });
    expect(exact.statusCode).toBe(200);
    expect(
      jsonBody<{ note: { body: string; event: null } }>(exact).note.body
    ).toBe("Launch decision\nShip on Friday.");
    expect(jsonBody<{ note: { event: null } }>(exact).note.event).toBeNull();

    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/collaboration/personal/notes/${note.noteId}/title`,
      headers: { authorization: "Bearer personal-api-token" },
      payload: { expectedTitleVersion: 1, title: "Friday launch" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(
      jsonBody<{ note: Record<string, unknown> }>(renamed).note
    ).toMatchObject({ title: "Friday launch", titleVersion: 2 });

    const outsider = await app.inject({
      method: "GET",
      url: `/v1/collaboration/personal/notes/${note.noteId}`,
      headers: sessionHeaders(fixture.ids.bob)
    });
    expect(outsider.statusCode).toBe(404);
    await app.close();
  });

  it("creates a Personal Note through the owner-scoped Notes route", async () => {
    const fixture = createCollaborationFixture();
    const projected: Array<{
      ownerUserId: string;
      note: PersonalNoteRecord;
    }> = [];
    const app = await buildTestServer(fixture, undefined, async (input) => {
      projected.push(input);
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/collaboration/personal/notes",
      headers: {
        authorization: "Bearer personal-api-token",
        "idempotency-key": "desktop-note-create"
      },
      payload: { bodyText: "Local note\nSaved in Personal Memory." }
    });

    expect(created.statusCode, created.body).toBe(201);
    expect(
      jsonBody<{ note: Record<string, unknown> }>(created).note
    ).toMatchObject({
      title: "Local note",
      titleVersion: 1,
      revision: 1,
      memoryEventId: null,
      projectionState: "pending",
      body: "Local note\nSaved in Personal Memory.",
      event: null
    });
    expect(projected).toEqual([
      expect.objectContaining({
        ownerUserId: fixture.ids.alice,
        note: expect.objectContaining({
          body: "Local note\nSaved in Personal Memory.",
          revision: 1
        })
      })
    ]);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/collaboration/personal/notes?limit=50",
      headers: { authorization: "Bearer personal-api-token" }
    });
    expect(listed.statusCode).toBe(200);
    expect(jsonBody<{ notes: unknown[] }>(listed).notes).toHaveLength(1);
    await app.close();
  });

  it("requires a session and fails closed for API Tokens", async () => {
    const fixture = createCollaborationFixture();
    const app = await buildTestServer(fixture);
    const url = "/v1/collaboration/personal/threads";

    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url,
          headers: { authorization: "Bearer personal-api-token" }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url,
          headers: sessionHeaders(fixture.ids.alice, {
            authorization: "Bearer personal-api-token"
          })
        })
      ).statusCode
    ).toBe(403);

    await app.close();
  });

  it("allows only explicitly scoped device credentials for Team collaboration", async () => {
    const fixture = createCollaborationFixture();
    const app = await buildTestServer(fixture);
    const teamThreadsUrl = `/v1/collaboration/teams/${fixture.ids.teamA}/threads`;
    const teamMessagesUrl = `${teamThreadsUrl}/${fixture.workspaceThread.id}/messages`;

    expect(
      (
        await app.inject({
          method: "GET",
          url: teamThreadsUrl,
          headers: deviceHeaders(fixture.ids.alice, ["team_chat_read"])
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: teamMessagesUrl,
          headers: {
            ...deviceHeaders(fixture.ids.alice, ["team_chat_read"]),
            "idempotency-key": "read-scope-cannot-write"
          },
          payload: { bodyText: "Must be denied" }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: teamMessagesUrl,
          headers: {
            ...deviceHeaders(fixture.ids.alice, ["team_chat_write"]),
            "idempotency-key": "write-scope-can-write"
          },
          payload: { bodyText: "Scoped device message" }
        })
      ).statusCode
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/collaboration/personal/threads",
          headers: deviceHeaders(fixture.ids.alice, ["team_chat_read"])
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/collaboration/personal/threads",
          headers: deviceHeaders(fixture.ids.alice, [
            "personal_collaboration_read"
          ])
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: teamThreadsUrl,
          headers: { authorization: "Bearer personal-api-token" }
        })
      ).statusCode
    ).toBe(403);

    await app.close();
  });

  it("uses grant-scoped Shared Session identifiers at the Team collaboration boundary", async () => {
    const fixture = createCollaborationFixture();
    const app = await buildTestServer(fixture);
    const publicLogicalMemoryId = sharedMemoryGrantScopedSourceId(
      fixture.ids.shareGrant,
      fixture.ids.logicalMemory
    );

    const listed = await app.inject({
      method: "GET",
      url: `/v1/collaboration/teams/${fixture.ids.teamA}/threads`,
      headers: sessionHeaders(fixture.ids.alice)
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const listedThread = jsonBody<{ threads: CollaborationThreadRecord[] }>(
      listed
    ).threads.find((thread) => thread.id === fixture.sharedSessionThread.id);
    expect(listedThread?.sharedLogicalMemoryId).toBe(publicLogicalMemoryId);
    expect(listedThread?.createdByUserId).toBe(
      sharedMemoryGrantScopedPrincipalId(
        fixture.ids.shareGrant,
        fixture.ids.alice
      )
    );
    expect(listed.body).not.toContain(fixture.ids.logicalMemory);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/collaboration/teams/${fixture.ids.teamA}/threads/${fixture.sharedSessionThread.id}`,
      headers: sessionHeaders(fixture.ids.alice)
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.body).not.toContain(fixture.ids.alice);

    const created = await app.inject({
      method: "POST",
      url: `/v1/collaboration/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/shared-sessions/${publicLogicalMemoryId}/discussion`,
      headers: sessionHeaders(fixture.ids.alice, {
        "idempotency-key": "scoped-shared-session-discussion"
      }),
      payload: { shareGrantId: fixture.ids.shareGrant }
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(
      jsonBody<{ thread: CollaborationThreadRecord }>(created).thread
        .sharedLogicalMemoryId
    ).toBe(publicLogicalMemoryId);
    expect(created.body).not.toContain(fixture.ids.logicalMemory);
    expect(created.body).not.toContain(fixture.ids.alice);

    const wrongGrant = await app.inject({
      method: "POST",
      url: `/v1/collaboration/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/shared-sessions/${publicLogicalMemoryId}/discussion`,
      headers: sessionHeaders(fixture.ids.alice, {
        "idempotency-key": "wrong-scoped-shared-session-discussion"
      }),
      payload: { shareGrantId: randomUUID() }
    });
    expect(wrongGrant.statusCode).toBe(403);

    await app.close();
  });

  it("does not leak Personal, Team, or Workspace threads across path scopes", async () => {
    const fixture = createCollaborationFixture();
    const app = await buildTestServer(fixture);

    const crossUser = await app.inject({
      method: "GET",
      url: `/v1/collaboration/personal/threads/${fixture.personalThread.id}`,
      headers: sessionHeaders(fixture.ids.bob)
    });
    expect(crossUser.statusCode).toBe(403);

    const crossTeam = await app.inject({
      method: "GET",
      url: `/v1/collaboration/teams/${fixture.ids.teamB}/threads/${fixture.workspaceThread.id}`,
      headers: sessionHeaders(fixture.ids.alice)
    });
    expect(crossTeam.statusCode).toBe(403);

    const unauthorizedTeam = await app.inject({
      method: "GET",
      url: `/v1/collaboration/teams/${fixture.ids.teamA}/threads`,
      headers: sessionHeaders(fixture.ids.dave)
    });
    expect(unauthorizedTeam.statusCode).toBe(403);

    const crossWorkspace = await app.inject({
      method: "GET",
      url: `/v1/collaboration/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceB}/channels`,
      headers: sessionHeaders(fixture.ids.bob)
    });
    expect(crossWorkspace.statusCode).toBe(403);

    await app.close();
  });

  it("returns one message for an idempotent retry and conflicts on key reuse", async () => {
    const fixture = createCollaborationFixture();
    const app = await buildTestServer(fixture);
    const url = `/v1/collaboration/personal/threads/${fixture.personalThread.id}/messages`;
    const headers = sessionHeaders(fixture.ids.alice, {
      "idempotency-key": "message-retry-1"
    });

    const first = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { bodyText: "Persist this once" }
    });
    const retry = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { bodyText: "Persist this once" }
    });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(
      jsonBody<{ message: CollaborationMessageRecord }>(retry).message.id
    ).toBe(jsonBody<{ message: CollaborationMessageRecord }>(first).message.id);
    expect(fixture.stats.storedMessageCount).toBe(1);

    const conflict = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { bodyText: "Different content" }
    });
    expect(conflict.statusCode).toBe(409);

    await app.close();
  });

  it("rejects message bursts before mutation with recoverable rate-limit headers", async () => {
    const fixture = createCollaborationFixture();
    const app = await buildTestServer(
      fixture,
      createCollaborationAdmissionController(
        new MemoryRateLimitStore(),
        (value) => value
      )
    );
    const url = `/v1/collaboration/personal/threads/${fixture.personalThread.id}/messages`;

    for (let index = 0; index < 20; index += 1) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: sessionHeaders(fixture.ids.alice, {
          "idempotency-key": `message-burst-${index}`
        }),
        payload: { bodyText: `Message ${index}` }
      });
      expect(response.statusCode).toBe(201);
    }

    const rejected = await app.inject({
      method: "POST",
      url,
      headers: sessionHeaders(fixture.ids.alice, {
        "idempotency-key": "message-burst-rejected"
      }),
      payload: { bodyText: "Must not be stored" }
    });
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["x-ratelimit-policy"]).toBe("messageBurst");
    expect(rejected.headers["retry-after"]).toBeDefined();
    expect(fixture.stats.storedMessageCount).toBe(20);

    await app.close();
  });

  it("requires repository-backed Workspace write access regardless of Team role", async () => {
    const fixture = createCollaborationFixture();
    const app = await buildTestServer(fixture);
    const threadUrl = `/v1/collaboration/teams/${fixture.ids.teamA}/threads/${fixture.workspaceThread.id}`;

    const readerList = await app.inject({
      method: "GET",
      url: `${threadUrl}/messages`,
      headers: sessionHeaders(fixture.ids.bob)
    });
    expect(readerList.statusCode).toBe(200);

    const readerWrite = await app.inject({
      method: "POST",
      url: `${threadUrl}/messages`,
      headers: sessionHeaders(fixture.ids.bob, {
        "idempotency-key": "reader-write"
      }),
      payload: { bodyText: "Must be denied" }
    });
    expect(readerWrite.statusCode).toBe(403);

    const adminWithoutWorkspaceAccess = await app.inject({
      method: "GET",
      url: threadUrl,
      headers: sessionHeaders(fixture.ids.carol)
    });
    expect(adminWithoutWorkspaceAccess.statusCode).toBe(403);

    const writerCreate = await app.inject({
      method: "POST",
      url: `/v1/collaboration/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/channels`,
      headers: sessionHeaders(fixture.ids.alice, {
        "idempotency-key": "writer-channel"
      }),
      payload: { name: "Writer channel" }
    });
    expect(writerCreate.statusCode).toBe(201);

    await app.close();
  });

  it("validates strict UUIDs, field lengths, idempotency keys, and route body size", async () => {
    const fixture = createCollaborationFixture();
    const app = await buildTestServer(fixture);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/collaboration/teams/not-a-uuid/threads",
          headers: sessionHeaders(fixture.ids.alice)
        })
      ).statusCode
    ).toBe(400);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/collaboration/teams/${fixture.ids.teamA}/direct-messages`,
          headers: sessionHeaders(fixture.ids.alice, {
            "idempotency-key": "self-dm"
          }),
          payload: { participantUserId: fixture.ids.alice }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/collaboration/teams/${fixture.ids.teamA}/group-direct-messages`,
          headers: sessionHeaders(fixture.ids.alice, {
            "idempotency-key": "self-group-dm"
          }),
          payload: {
            participantUserIds: [fixture.ids.alice, fixture.ids.bob]
          }
        })
      ).statusCode
    ).toBe(400);

    const channelUrl = `/v1/collaboration/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/channels`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: channelUrl,
          headers: sessionHeaders(fixture.ids.alice, {
            "idempotency-key": "too-long-name"
          }),
          payload: { name: "n".repeat(81) }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: channelUrl,
          headers: sessionHeaders(fixture.ids.alice, {
            "idempotency-key": `k${"x".repeat(512)}`
          }),
          payload: { name: "Header limit" }
        })
      ).statusCode
    ).toBe(400);

    const messageUrl = `/v1/collaboration/personal/threads/${fixture.personalThread.id}/messages`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: messageUrl,
          headers: sessionHeaders(fixture.ids.alice, {
            "idempotency-key": "message-byte-limit"
          }),
          payload: { bodyText: "é".repeat(16_385) }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: messageUrl,
          headers: sessionHeaders(fixture.ids.alice, {
            "idempotency-key": "message-http-body-limit"
          }),
          payload: { bodyText: "m".repeat(80 * 1024) }
        })
      ).statusCode
    ).toBe(413);

    await app.close();
  });

  it("supports Personal lifecycle, history, and read-state contracts", async () => {
    const fixture = createCollaborationFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.alice, {
      "idempotency-key": "personal-lifecycle"
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/collaboration/personal/channels",
      headers,
      payload: { name: "Drafts", topic: "Initial" }
    });
    expect(created.statusCode).toBe(201);
    const createdThread = jsonBody<{ thread: CollaborationThreadRecord }>(
      created
    ).thread;
    const baseUrl = `/v1/collaboration/personal/threads/${createdThread.id}`;

    const renamed = await app.inject({
      method: "PATCH",
      url: `${baseUrl}/name`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: { expectedVersion: 1, name: "Working drafts" }
    });
    expect(renamed.statusCode).toBe(200);

    const topic = await app.inject({
      method: "PATCH",
      url: `${baseUrl}/topic`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: { expectedVersion: 2, topic: null }
    });
    expect(topic.statusCode).toBe(200);

    const sent = await app.inject({
      method: "POST",
      url: `${baseUrl}/messages`,
      headers: sessionHeaders(fixture.ids.alice, {
        "idempotency-key": "personal-lifecycle-message"
      }),
      payload: { bodyText: "First note" }
    });
    expect(sent.statusCode).toBe(201);
    const message = jsonBody<{ message: CollaborationMessageRecord }>(
      sent
    ).message;

    const read = await app.inject({
      method: "PUT",
      url: `${baseUrl}/read-state`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: { messageId: message.id }
    });
    expect(read.statusCode).toBe(200);
    expect(jsonBody<{ readState: { lastReadSequence: number } }>(read)).toEqual(
      expect.objectContaining({
        readState: expect.objectContaining({ lastReadSequence: 1 })
      })
    );

    const delivered = await app.inject({
      method: "PUT",
      url: `${baseUrl}/delivery-state`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: { messageId: message.id }
    });
    expect(delivered.statusCode).toBe(200);
    expect(
      jsonBody<{ readState: { lastDeliveredSequence: number } }>(delivered)
    ).toEqual(
      expect.objectContaining({
        readState: expect.objectContaining({ lastDeliveredSequence: 1 })
      })
    );

    const archived = await app.inject({
      method: "POST",
      url: `${baseUrl}/archive`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: { expectedVersion: 3 }
    });
    expect(archived.statusCode).toBe(200);

    const restored = await app.inject({
      method: "POST",
      url: `${baseUrl}/restore`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: { expectedVersion: 4 }
    });
    expect(restored.statusCode).toBe(200);
    expect(
      jsonBody<{ thread: CollaborationThreadRecord }>(restored).thread.lifecycle
    ).toBe("active");

    await app.close();
  });
});
