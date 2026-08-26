import type {
  CollaborationRepository,
  MemorySourceRepository,
  PersonalNoteRecord,
  SharedMemoryRepository
} from "@koed/db";
import { sharedMemoryGrantScopedSourceId } from "@koed/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ApiRouteContext } from "../server/context.js";
import {
  enforceCollaborationAdmission,
  type CollaborationAdmissionController
} from "./admission.js";
import {
  advanceCollaborationReadStateSchema,
  collaborationIdempotencyHeadersSchema,
  collaborationThreadParamsSchema,
  createCollaborationChannelSchema,
  createCollaborationDmSchema,
  createCollaborationGroupDmSchema,
  createCollaborationMessageSchema,
  createSharedSessionDiscussionSchema,
  listCollaborationMessagesQuerySchema,
  listCollaborationThreadsQuerySchema,
  listPersonalNotesQuerySchema,
  personalNoteParamsSchema,
  renamePersonalNoteSchema,
  renameCollaborationThreadSchema,
  sharedSessionDiscussionParamsSchema,
  teamCollaborationParamsSchema,
  teamCollaborationThreadParamsSchema,
  transitionCollaborationThreadSchema,
  updatePersonalNoteBodySchema,
  updateCollaborationTopicSchema,
  workspaceCollaborationParamsSchema
} from "./schemas.js";
import { publicCollaborationThread } from "./public-thread.js";

const SMALL_BODY_LIMIT_BYTES = 16 * 1024;
const MESSAGE_BODY_LIMIT_BYTES = 72 * 1024;

const forbidden = (message = "Collaboration resource is not available") =>
  Object.assign(new Error(message), { statusCode: 403 });

const badRequest = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400 });

export interface CollaborationRouteContext {
  requireCollaborationRepository(): CollaborationRepository &
    Pick<MemorySourceRepository, "getPersonalNoteMemoryEvent">;
  requireSharedMemoryRepository(): Pick<
    SharedMemoryRepository,
    "listWorkspaceGrants"
  >;
  projectPersonalNote(input: {
    ownerUserId: string;
    note: PersonalNoteRecord;
  }): Promise<void>;
  authenticateSessionOrDeviceCredential: ApiRouteContext["auth"]["authenticateSessionOrDeviceCredential"];
  authenticateApiToken: ApiRouteContext["auth"]["authenticateApiToken"];
  readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
  writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  admission: CollaborationAdmissionController;
}

const authenticatePersonalCollaboration = async (
  request: FastifyRequest,
  context: CollaborationRouteContext,
  operationFamily:
    | "personal_collaboration_read"
    | "personal_collaboration_write"
) =>
  context.authenticateSessionOrDeviceCredential(request, operationFamily, {
    apiTokenError: "API Tokens cannot authorize collaboration operations"
  });

const authenticatePersonalNote = async (
  request: FastifyRequest,
  context: CollaborationRouteContext,
  operationFamily:
    | "personal_collaboration_read"
    | "personal_collaboration_write"
) => {
  const authorization = request.headers.authorization?.trim() ?? "";
  return /^Bearer(?:\s|$)/i.test(authorization)
    ? context.authenticateApiToken(request)
    : context.authenticateSessionOrDeviceCredential(request, operationFamily);
};

const authenticateTeamCollaboration = (
  request: FastifyRequest,
  context: CollaborationRouteContext,
  operationFamily: "team_chat_read" | "team_chat_write"
) =>
  context.authenticateSessionOrDeviceCredential(request, operationFamily, {
    apiTokenError: "API Tokens cannot authorize collaboration operations"
  });

const parseIdempotencyKey = (request: FastifyRequest): string =>
  collaborationIdempotencyHeadersSchema.parse(request.headers)[
    "idempotency-key"
  ];

const publicTeamThreads = (
  threads: Awaited<ReturnType<CollaborationRepository["listThreads"]>>
) => threads?.map(publicCollaborationThread) ?? null;

const resolveCanonicalSharedLogicalMemoryId = async (
  repository: Pick<SharedMemoryRepository, "listWorkspaceGrants">,
  actor: { userId: string },
  input: {
    teamId: string;
    teamWorkspaceId: string;
    shareGrantId: string;
    publicLogicalMemoryId: string;
  }
): Promise<string | null> => {
  let offset = 0;
  for (;;) {
    const page = await repository.listWorkspaceGrants(actor, {
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      limit: 100,
      offset
    });
    if (page.limit !== 100 || page.offset !== offset) return null;
    const grant = page.entries.find(
      (entry) => entry.shareGrantId === input.shareGrantId
    );
    if (grant) {
      return grant.lifecycle === "active" &&
        sharedMemoryGrantScopedSourceId(
          grant.shareGrantId,
          grant.logicalMemoryId
        ) === input.publicLogicalMemoryId
        ? grant.logicalMemoryId
        : null;
    }
    if (!page.hasMore) return null;
    offset += page.entries.length;
    if (page.entries.length === 0) return null;
  }
};

const requirePersonalThread = async (
  repository: CollaborationRepository,
  userId: string,
  threadId: string,
  includeArchived = false
) => {
  const thread = await repository.getThread(
    { userId },
    { threadId, includeArchived }
  );
  if (thread?.scope !== "personal" || thread.personalOwnerUserId !== userId) {
    throw forbidden();
  }
  return thread;
};

const requireTeamThread = async (
  repository: CollaborationRepository,
  userId: string,
  teamId: string,
  threadId: string,
  includeArchived = false
) => {
  const thread = await repository.getThread(
    { userId },
    { threadId, includeArchived }
  );
  if (thread?.scope !== "team" || thread.teamId !== teamId) {
    throw forbidden();
  }
  return thread;
};

export const registerCollaborationRoutes = (
  app: FastifyInstance,
  context: CollaborationRouteContext
): void => {
  const { readRateLimit, writeRateLimit } = context;

  app.get(
    "/v1/collaboration/personal/snapshot",
    { preHandler: readRateLimit },
    async (request) => {
      const user = await authenticatePersonalCollaboration(
        request,
        context,
        "personal_collaboration_read"
      );
      const snapshot = await context
        .requireCollaborationRepository()
        .getAuthorizedSnapshot(
          { userId: user.id },
          { scope: "personal", includeArchived: true }
        );
      if (!snapshot) throw forbidden();
      return { snapshot };
    }
  );

  app.get(
    "/v1/collaboration/personal/threads",
    { preHandler: readRateLimit },
    async (request) => {
      const user = await authenticatePersonalCollaboration(
        request,
        context,
        "personal_collaboration_read"
      );
      const query = listCollaborationThreadsQuerySchema.parse(request.query);
      const threads = await context
        .requireCollaborationRepository()
        .listThreads({ userId: user.id }, { scope: "personal", ...query });
      if (!threads) throw forbidden();
      return { threads };
    }
  );

  app.post(
    "/v1/collaboration/personal/channels",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = await authenticatePersonalCollaboration(
        request,
        context,
        "personal_collaboration_write"
      );
      const input = createCollaborationChannelSchema.parse(request.body);
      await enforceCollaborationAdmission(
        reply,
        context.admission.admitChannelCreation({ userId: user.id })
      );
      const thread = await context
        .requireCollaborationRepository()
        .createThread(
          { userId: user.id },
          {
            kind: "personal_channel",
            idempotencyKey: parseIdempotencyKey(request),
            ...input
          }
        );
      if (!thread) throw forbidden();
      return reply.status(201).send({ thread });
    }
  );

  app.get(
    "/v1/collaboration/personal/threads/:threadId",
    { preHandler: readRateLimit },
    async (request) => {
      const user = await authenticatePersonalCollaboration(
        request,
        context,
        "personal_collaboration_read"
      );
      const { threadId } = collaborationThreadParamsSchema.parse(
        request.params
      );
      const thread = await requirePersonalThread(
        context.requireCollaborationRepository(),
        user.id,
        threadId,
        true
      );
      return { thread };
    }
  );

  app.patch(
    "/v1/collaboration/personal/threads/:threadId/name",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const user = await authenticatePersonalCollaboration(
        request,
        context,
        "personal_collaboration_write"
      );
      const { threadId } = collaborationThreadParamsSchema.parse(
        request.params
      );
      const input = renameCollaborationThreadSchema.parse(request.body);
      const repository = context.requireCollaborationRepository();
      await requirePersonalThread(repository, user.id, threadId);
      const thread = await repository.renameThread(
        { userId: user.id },
        { threadId, ...input }
      );
      if (!thread) throw forbidden();
      return { thread };
    }
  );

  app.patch(
    "/v1/collaboration/personal/threads/:threadId/topic",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const user = await authenticatePersonalCollaboration(
        request,
        context,
        "personal_collaboration_write"
      );
      const { threadId } = collaborationThreadParamsSchema.parse(
        request.params
      );
      const input = updateCollaborationTopicSchema.parse(request.body);
      const repository = context.requireCollaborationRepository();
      await requirePersonalThread(repository, user.id, threadId);
      const thread = await repository.updateThreadTopic(
        { userId: user.id },
        { threadId, ...input }
      );
      if (!thread) throw forbidden();
      return { thread };
    }
  );

  app.post(
    "/v1/collaboration/personal/threads/:threadId/archive",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const user = await authenticatePersonalCollaboration(
        request,
        context,
        "personal_collaboration_write"
      );
      const { threadId } = collaborationThreadParamsSchema.parse(
        request.params
      );
      const input = transitionCollaborationThreadSchema.parse(request.body);
      const repository = context.requireCollaborationRepository();
      await requirePersonalThread(repository, user.id, threadId);
      const thread = await repository.archiveThread(
        { userId: user.id },
        { threadId, ...input }
      );
      if (!thread) throw forbidden();
      return { thread };
    }
  );

  app.post(
    "/v1/collaboration/personal/threads/:threadId/restore",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const user = await authenticatePersonalCollaboration(
        request,
        context,
        "personal_collaboration_write"
      );
      const { threadId } = collaborationThreadParamsSchema.parse(
        request.params
      );
      const input = transitionCollaborationThreadSchema.parse(request.body);
      const repository = context.requireCollaborationRepository();
      await requirePersonalThread(repository, user.id, threadId, true);
      const thread = await repository.restoreThread(
        { userId: user.id },
        { threadId, ...input }
      );
      if (!thread) throw forbidden();
      return { thread };
    }
  );

  app.get(
    "/v1/collaboration/teams/:teamId/participants",
    { preHandler: readRateLimit },
    async (request) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_read"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
      const participants = await context
        .requireCollaborationRepository()
        .listTeamParticipants({ userId: user.id }, teamId);
      if (!participants) throw forbidden();
      return { participants };
    }
  );

  app.get(
    "/v1/collaboration/teams/:teamId/threads",
    { preHandler: readRateLimit },
    async (request) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_read"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
      const query = listCollaborationThreadsQuerySchema.parse(request.query);
      const threads = await context
        .requireCollaborationRepository()
        .listThreads({ userId: user.id }, { scope: "team", teamId, ...query });
      if (!threads) throw forbidden();
      return { threads: publicTeamThreads(threads) };
    }
  );

  app.get(
    "/v1/collaboration/teams/:teamId/workspaces/:teamWorkspaceId/channels",
    { preHandler: readRateLimit },
    async (request) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_read"
      );
      const { teamId, teamWorkspaceId } =
        workspaceCollaborationParamsSchema.parse(request.params);
      const query = listCollaborationThreadsQuerySchema.parse(request.query);
      const threads = await context
        .requireCollaborationRepository()
        .listThreads(
          { userId: user.id },
          {
            scope: "team",
            teamId,
            teamWorkspaceId,
            kinds: ["workspace_channel"],
            includeArchived: query.includeArchived,
            limit: query.limit
          }
        );
      if (!threads) throw forbidden();
      return {
        threads
      };
    }
  );

  app.post(
    "/v1/collaboration/teams/:teamId/workspaces/:teamWorkspaceId/channels",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_write"
      );
      const { teamId, teamWorkspaceId } =
        workspaceCollaborationParamsSchema.parse(request.params);
      const input = createCollaborationChannelSchema.parse(request.body);
      await enforceCollaborationAdmission(
        reply,
        context.admission.admitChannelCreation({ userId: user.id, teamId })
      );
      const thread = await context
        .requireCollaborationRepository()
        .createThread(
          { userId: user.id },
          {
            kind: "workspace_channel",
            idempotencyKey: parseIdempotencyKey(request),
            teamId,
            teamWorkspaceId,
            ...input
          }
        );
      if (!thread) throw forbidden();
      return reply.status(201).send({ thread });
    }
  );

  app.get(
    "/v1/collaboration/teams/:teamId/direct-messages",
    { preHandler: readRateLimit },
    async (request) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_read"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
      const query = listCollaborationThreadsQuerySchema.parse(request.query);
      const threads = await context
        .requireCollaborationRepository()
        .listThreads(
          { userId: user.id },
          {
            scope: "team",
            teamId,
            kinds: ["dm", "group_dm"],
            includeArchived: query.includeArchived,
            limit: query.limit
          }
        );
      if (!threads) throw forbidden();
      return {
        threads
      };
    }
  );

  app.post(
    "/v1/collaboration/teams/:teamId/direct-messages",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_write"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
      const input = createCollaborationDmSchema.parse(request.body);
      if (input.participantUserId === user.id) {
        throw badRequest("A direct message requires another Team participant");
      }
      const thread = await context
        .requireCollaborationRepository()
        .createThread(
          { userId: user.id },
          {
            kind: "dm",
            idempotencyKey: parseIdempotencyKey(request),
            teamId,
            participantUserIds: [input.participantUserId]
          }
        );
      if (!thread) throw forbidden();
      return reply.status(201).send({ thread });
    }
  );

  app.post(
    "/v1/collaboration/teams/:teamId/group-direct-messages",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_write"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
      const input = createCollaborationGroupDmSchema.parse(request.body);
      if (input.participantUserIds.includes(user.id)) {
        throw badRequest(
          "participantUserIds must not include the authenticated User"
        );
      }
      const thread = await context
        .requireCollaborationRepository()
        .createThread(
          { userId: user.id },
          {
            kind: "group_dm",
            idempotencyKey: parseIdempotencyKey(request),
            teamId,
            participantUserIds: input.participantUserIds
          }
        );
      if (!thread) throw forbidden();
      return reply.status(201).send({ thread });
    }
  );

  app.post(
    "/v1/collaboration/teams/:teamId/workspaces/:teamWorkspaceId/shared-sessions/:sharedLogicalMemoryId/discussion",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_write"
      );
      const { teamId, teamWorkspaceId, sharedLogicalMemoryId } =
        sharedSessionDiscussionParamsSchema.parse(request.params);
      const { shareGrantId } = createSharedSessionDiscussionSchema.parse(
        request.body
      );
      const canonicalLogicalMemoryId =
        await resolveCanonicalSharedLogicalMemoryId(
          context.requireSharedMemoryRepository(),
          { userId: user.id },
          {
            teamId,
            teamWorkspaceId,
            shareGrantId,
            publicLogicalMemoryId: sharedLogicalMemoryId
          }
        );
      if (!canonicalLogicalMemoryId) throw forbidden();
      const thread = await context
        .requireCollaborationRepository()
        .createThread(
          { userId: user.id },
          {
            kind: "shared_session_discussion",
            idempotencyKey: parseIdempotencyKey(request),
            teamId,
            teamWorkspaceId,
            sharedLogicalMemoryId: canonicalLogicalMemoryId,
            shareGrantId
          }
        );
      if (!thread) throw forbidden();
      return reply.status(201).send({
        thread: publicCollaborationThread(thread)
      });
    }
  );

  app.get(
    "/v1/collaboration/teams/:teamId/threads/:threadId",
    { preHandler: readRateLimit },
    async (request) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_read"
      );
      const { teamId, threadId } = teamCollaborationThreadParamsSchema.parse(
        request.params
      );
      const thread = await requireTeamThread(
        context.requireCollaborationRepository(),
        user.id,
        teamId,
        threadId,
        true
      );
      return { thread: publicCollaborationThread(thread) };
    }
  );

  app.patch(
    "/v1/collaboration/teams/:teamId/threads/:threadId/name",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_write"
      );
      const { teamId, threadId } = teamCollaborationThreadParamsSchema.parse(
        request.params
      );
      const input = renameCollaborationThreadSchema.parse(request.body);
      const repository = context.requireCollaborationRepository();
      await requireTeamThread(repository, user.id, teamId, threadId);
      const thread = await repository.renameThread(
        { userId: user.id },
        { threadId, ...input }
      );
      if (!thread) throw forbidden();
      return { thread: publicCollaborationThread(thread) };
    }
  );

  app.patch(
    "/v1/collaboration/teams/:teamId/threads/:threadId/topic",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_write"
      );
      const { teamId, threadId } = teamCollaborationThreadParamsSchema.parse(
        request.params
      );
      const input = updateCollaborationTopicSchema.parse(request.body);
      const repository = context.requireCollaborationRepository();
      await requireTeamThread(repository, user.id, teamId, threadId);
      const thread = await repository.updateThreadTopic(
        { userId: user.id },
        { threadId, ...input }
      );
      if (!thread) throw forbidden();
      return { thread: publicCollaborationThread(thread) };
    }
  );

  app.post(
    "/v1/collaboration/teams/:teamId/threads/:threadId/archive",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_write"
      );
      const { teamId, threadId } = teamCollaborationThreadParamsSchema.parse(
        request.params
      );
      const input = transitionCollaborationThreadSchema.parse(request.body);
      const repository = context.requireCollaborationRepository();
      await requireTeamThread(repository, user.id, teamId, threadId);
      const thread = await repository.archiveThread(
        { userId: user.id },
        { threadId, ...input }
      );
      if (!thread) throw forbidden();
      return { thread: publicCollaborationThread(thread) };
    }
  );

  app.post(
    "/v1/collaboration/teams/:teamId/threads/:threadId/restore",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_write"
      );
      const { teamId, threadId } = teamCollaborationThreadParamsSchema.parse(
        request.params
      );
      const input = transitionCollaborationThreadSchema.parse(request.body);
      const repository = context.requireCollaborationRepository();
      await requireTeamThread(repository, user.id, teamId, threadId, true);
      const thread = await repository.restoreThread(
        { userId: user.id },
        { threadId, ...input }
      );
      if (!thread) throw forbidden();
      return { thread: publicCollaborationThread(thread) };
    }
  );

  const registerThreadMessageRoutes = (
    basePath:
      | "/v1/collaboration/personal/threads/:threadId"
      | "/v1/collaboration/teams/:teamId/threads/:threadId",
    scope: "personal" | "team"
  ) => {
    const parseScopedParams = (
      params: unknown
    ): { threadId: string; teamId: string | null } => {
      if (scope === "personal") {
        const { threadId } = collaborationThreadParamsSchema.parse(params);
        return { threadId, teamId: null };
      }
      const { threadId, teamId } =
        teamCollaborationThreadParamsSchema.parse(params);
      return { threadId, teamId };
    };

    app.get(
      `${basePath}/messages`,
      { preHandler: readRateLimit },
      async (request) => {
        const user =
          scope === "personal"
            ? await authenticatePersonalCollaboration(
                request,
                context,
                "personal_collaboration_read"
              )
            : await authenticateTeamCollaboration(
                request,
                context,
                "team_chat_read"
              );
        const params = parseScopedParams(request.params);
        const repository = context.requireCollaborationRepository();
        if (scope === "personal") {
          await requirePersonalThread(
            repository,
            user.id,
            params.threadId,
            true
          );
        } else {
          await requireTeamThread(
            repository,
            user.id,
            params.teamId!,
            params.threadId,
            true
          );
        }
        const query = listCollaborationMessagesQuerySchema.parse(request.query);
        const page = await repository.listMessages(
          { userId: user.id },
          { threadId: params.threadId, ...query }
        );
        if (!page) throw forbidden();
        return page;
      }
    );

    app.post(
      `${basePath}/messages`,
      { preHandler: writeRateLimit, bodyLimit: MESSAGE_BODY_LIMIT_BYTES },
      async (request, reply) => {
        const user =
          scope === "personal"
            ? await authenticatePersonalCollaboration(
                request,
                context,
                "personal_collaboration_write"
              )
            : await authenticateTeamCollaboration(
                request,
                context,
                "team_chat_write"
              );
        const params = parseScopedParams(request.params);
        const input = createCollaborationMessageSchema.parse(request.body);
        const repository = context.requireCollaborationRepository();
        if (scope === "personal") {
          await requirePersonalThread(repository, user.id, params.threadId);
        }
        if (scope !== "personal") {
          await requireTeamThread(
            repository,
            user.id,
            params.teamId!,
            params.threadId
          );
        }
        await enforceCollaborationAdmission(
          reply,
          context.admission.admitMessage({
            userId: user.id,
            ...(params.teamId ? { teamId: params.teamId } : {})
          })
        );
        const message = await repository.sendMessage(
          { userId: user.id },
          {
            threadId: params.threadId,
            idempotencyKey: parseIdempotencyKey(request),
            ...input
          }
        );
        if (!message) throw forbidden();
        return reply.status(201).send({ message });
      }
    );

    app.put(
      `${basePath}/read-state`,
      { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
      async (request) => {
        const user =
          scope === "personal"
            ? await authenticatePersonalCollaboration(
                request,
                context,
                "personal_collaboration_read"
              )
            : await authenticateTeamCollaboration(
                request,
                context,
                "team_chat_read"
              );
        const params = parseScopedParams(request.params);
        const input = advanceCollaborationReadStateSchema.parse(request.body);
        const repository = context.requireCollaborationRepository();
        if (scope === "personal") {
          await requirePersonalThread(
            repository,
            user.id,
            params.threadId,
            true
          );
        } else {
          await requireTeamThread(
            repository,
            user.id,
            params.teamId!,
            params.threadId,
            true
          );
        }
        const readState = await repository.advanceReadState(
          { userId: user.id },
          { threadId: params.threadId, ...input }
        );
        if (!readState) throw forbidden();
        return { readState };
      }
    );

    app.put(
      `${basePath}/delivery-state`,
      { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
      async (request) => {
        const user =
          scope === "personal"
            ? await authenticatePersonalCollaboration(
                request,
                context,
                "personal_collaboration_read"
              )
            : await authenticateTeamCollaboration(
                request,
                context,
                "team_chat_read"
              );
        const params = parseScopedParams(request.params);
        const input = advanceCollaborationReadStateSchema.parse(request.body);
        const repository = context.requireCollaborationRepository();
        if (scope === "personal") {
          await requirePersonalThread(
            repository,
            user.id,
            params.threadId,
            true
          );
        } else {
          await requireTeamThread(
            repository,
            user.id,
            params.teamId!,
            params.threadId,
            true
          );
        }
        const readState = await repository.advanceDeliveryState(
          { userId: user.id },
          { threadId: params.threadId, ...input }
        );
        if (!readState) throw forbidden();
        return { readState };
      }
    );
  };

  registerThreadMessageRoutes(
    "/v1/collaboration/personal/threads/:threadId",
    "personal"
  );
  registerThreadMessageRoutes(
    "/v1/collaboration/teams/:teamId/threads/:threadId",
    "team"
  );

  app.get(
    "/v1/collaboration/personal/notes",
    { preHandler: context.readRateLimit },
    async (request) => {
      const user = await authenticatePersonalNote(
        request,
        context,
        "personal_collaboration_read"
      );
      const input = listPersonalNotesQuerySchema.parse(request.query);
      const repository = context.requireCollaborationRepository();
      const page = await repository.listPersonalNotes(
        { userId: user.id },
        input
      );
      const notes = page.notes.map((note) => ({
        noteId: note.noteId,
        title: note.title,
        titleVersion: note.titleVersion,
        revisionId: note.revisionId,
        revision: note.revision,
        contentHash: note.contentHash,
        memoryEventId: note.memoryEventId,
        projectionState: note.projectionState,
        projectionFailureCode: note.projectionFailureCode,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        sourceSequence: note.sourceSequence
      }));
      return { notes, nextBeforeSequence: page.nextBeforeSequence };
    }
  );

  app.post(
    "/v1/collaboration/personal/notes",
    { preHandler: context.writeRateLimit, bodyLimit: MESSAGE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = await authenticatePersonalNote(
        request,
        context,
        "personal_collaboration_write"
      );
      const input = createCollaborationMessageSchema.parse(request.body);
      const repository = context.requireCollaborationRepository();
      await enforceCollaborationAdmission(
        reply,
        context.admission.admitMessage({ userId: user.id })
      );
      const created = await repository.createPersonalNote(
        { userId: user.id },
        {
          body: input.bodyText,
          idempotencyKey: parseIdempotencyKey(request)
        }
      );
      await context
        .projectPersonalNote({ ownerUserId: user.id, note: created })
        .catch(() => undefined);
      const [note, event] = await Promise.all([
        repository.getPersonalNote(
          { userId: user.id },
          { noteId: created.noteId }
        ),
        repository.getPersonalNoteMemoryEvent(
          { userId: user.id },
          created.noteId
        )
      ]);
      if (!note) throw new Error("Personal Note was not stored");
      return reply.status(201).send({
        note: {
          noteId: note.noteId,
          title: note.title,
          titleVersion: note.titleVersion,
          revisionId: note.revisionId,
          revision: note.revision,
          contentHash: note.contentHash,
          memoryEventId: note.memoryEventId,
          projectionState: note.projectionState,
          projectionFailureCode: note.projectionFailureCode,
          body: note.body,
          logicalMemoryId: note.logicalMemoryId,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          sourceSequence: note.sourceSequence,
          event
        }
      });
    }
  );

  app.get(
    "/v1/collaboration/personal/notes/:noteId",
    { preHandler: context.readRateLimit },
    async (request, reply) => {
      const user = await authenticatePersonalNote(
        request,
        context,
        "personal_collaboration_read"
      );
      const { noteId } = personalNoteParamsSchema.parse(request.params);
      const repository = context.requireCollaborationRepository();
      const [note, event] = await Promise.all([
        repository.getPersonalNote({ userId: user.id }, { noteId }),
        repository.getPersonalNoteMemoryEvent({ userId: user.id }, noteId)
      ]);
      if (!note) {
        return reply.status(404).send({ message: "Personal Note not found" });
      }
      return {
        note: {
          noteId: note.noteId,
          title: note.title,
          titleVersion: note.titleVersion,
          revisionId: note.revisionId,
          revision: note.revision,
          contentHash: note.contentHash,
          memoryEventId: note.memoryEventId,
          projectionState: note.projectionState,
          projectionFailureCode: note.projectionFailureCode,
          body: note.body,
          logicalMemoryId: note.logicalMemoryId,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          sourceSequence: note.sourceSequence,
          event
        }
      };
    }
  );

  app.patch(
    "/v1/collaboration/personal/notes/:noteId/title",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = await authenticatePersonalNote(
        request,
        context,
        "personal_collaboration_write"
      );
      const { noteId } = personalNoteParamsSchema.parse(request.params);
      const input = renamePersonalNoteSchema.parse(request.body);
      const repository = context.requireCollaborationRepository();
      const note = await repository.renamePersonalNote(
        { userId: user.id },
        { noteId, ...input }
      );
      if (!note) {
        return reply.status(404).send({ message: "Personal Note not found" });
      }
      return {
        note: {
          noteId: note.noteId,
          title: note.title,
          titleVersion: note.titleVersion,
          revisionId: note.revisionId,
          revision: note.revision,
          contentHash: note.contentHash,
          memoryEventId: note.memoryEventId,
          projectionState: note.projectionState,
          projectionFailureCode: note.projectionFailureCode,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          sourceSequence: note.sourceSequence
        }
      };
    }
  );

  app.patch(
    "/v1/collaboration/personal/notes/:noteId/body",
    { preHandler: context.writeRateLimit, bodyLimit: MESSAGE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = await authenticatePersonalNote(
        request,
        context,
        "personal_collaboration_write"
      );
      const { noteId } = personalNoteParamsSchema.parse(request.params);
      const input = updatePersonalNoteBodySchema.parse(request.body);
      const repository = context.requireCollaborationRepository();
      const updated = await repository.updatePersonalNoteBody(
        { userId: user.id },
        {
          noteId,
          expectedRevision: input.expectedRevision,
          body: input.bodyText,
          idempotencyKey: parseIdempotencyKey(request)
        }
      );
      if (!updated) {
        return reply.status(404).send({ message: "Personal Note not found" });
      }
      await context
        .projectPersonalNote({ ownerUserId: user.id, note: updated })
        .catch(() => undefined);
      const [note, event] = await Promise.all([
        repository.getPersonalNote({ userId: user.id }, { noteId }),
        repository.getPersonalNoteMemoryEvent({ userId: user.id }, noteId)
      ]);
      if (!note) {
        throw new Error("Personal Note revision was not stored");
      }
      return {
        note: {
          noteId: note.noteId,
          title: note.title,
          titleVersion: note.titleVersion,
          revisionId: note.revisionId,
          revision: note.revision,
          contentHash: note.contentHash,
          memoryEventId: note.memoryEventId,
          projectionState: note.projectionState,
          projectionFailureCode: note.projectionFailureCode,
          body: note.body,
          logicalMemoryId: note.logicalMemoryId,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          sourceSequence: note.sourceSequence,
          event
        }
      };
    }
  );
};
