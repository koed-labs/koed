import type {
  CollaborationRepository,
  MemorySourceRepository,
  PersonalNoteRecord,
  PublicSquareRepository,
  SharedMemoryRepository,
  TeamAgentRequestsRepository,
  TeamOverviewRepository,
  TeamOverviewSourcesRepository,
  CreateOwnerJobWithClient
} from "@koed/db";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  publicSquareBriefInputSchema,
  publicSquareListQuerySchema,
  teamProjectMemberConnectionInputSchema,
  sharedMemoryGrantScopedSourceId,
  fetchBoundedJsonObject,
  readLocalEdgeUpstreamRegistry,
  upstreamApiUrl,
  upstreamBackendById
} from "@koed/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ApiRouteContext } from "../server/context.js";
import {
  enforceCollaborationAdmission,
  type CollaborationAdmissionController
} from "./admission.js";
import {
  assertUpstreamOperationPathAllowed,
  upstreamAdvertisesCapability,
  upstreamSupportsCollaborationRealtime
} from "../local-edge/upstream-routing.js";
import {
  advanceCollaborationReadStateSchema,
  collaborationIdempotencyHeadersSchema,
  collaborationThreadParamsSchema,
  createCollaborationChannelSchema,
  createTeamSharedProjectSchema,
  createCollaborationDmSchema,
  createCollaborationGroupDmSchema,
  createCollaborationMessageSchema,
  editCollaborationMessageSchema,
  setCollaborationMessageReactionSchema,
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
import {
  createTeamAgentRequestInputSchema,
  decideTeamAgentRequestInputSchema,
  listTeamAgentRequestsQuerySchema,
  postTeamAgentRequestOutcomeInputSchema,
  updateTeamAgentOfferInputSchema,
  updateTeamAgentRequestReviewInputSchema,
  withdrawTeamAgentRequestInputSchema
} from "@koed/shared/team-agent-requests";
import {
  teamOverviewMutationResultSchema,
  teamOverviewQuerySchema,
  teamOverviewSchemaVersion,
  teamOverviewSnapshotSchema,
  teamOverviewSourceMutationSchema,
  type TeamOverviewItem
} from "@koed/shared";

const SMALL_BODY_LIMIT_BYTES = 16 * 1024;
const MESSAGE_BODY_LIMIT_BYTES = 72 * 1024;

const forbidden = (message = "Collaboration resource is not available") =>
  Object.assign(new Error(message), { statusCode: 403 });

const badRequest = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400 });

export interface CollaborationRouteContext extends Pick<
  ApiRouteContext,
  "config" | "localEdge" | "deploymentIdentity"
> {
  requireCollaborationRepository(): CollaborationRepository &
    PublicSquareRepository &
    Pick<MemorySourceRepository, "getPersonalNoteMemoryEvent">;
  requireSharedMemoryRepository(): Pick<
    SharedMemoryRepository,
    "listWorkspaceGrants"
  >;
  requireTeamAgentRequestsRepository(): TeamAgentRequestsRepository;
  requireTeamOverviewRepository(): TeamOverviewRepository;
  requireTeamOverviewSourcesRepository(): TeamOverviewSourcesRepository;
  createOwnerJobWithClient: CreateOwnerJobWithClient;
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
  const localProfiles = new Set(["developer", "local_personal"]);
  type PublicSquareUpstreamAuthority = {
    backend: ReturnType<typeof upstreamBackendById> & {};
    authorization: string;
  };
  const resolvePublicSquareAuthority =
    (): PublicSquareUpstreamAuthority | null => {
      if (!localProfiles.has(context.config.deploymentProfile)) return null;
      const registry = readLocalEdgeUpstreamRegistry(
        context.localEdge.upstreamBackendsPath
      );
      const backend = registry.activeBackendId
        ? upstreamBackendById(registry, registry.activeBackendId)
        : null;
      if (!backend || backend.routePolicy.teamWorkspaceRead !== "enabled")
        return null;
      if (!context.localEdge.remoteOperationsAllowed())
        throw Object.assign(
          new Error("Public Square upstream operations are suspended"),
          { statusCode: 503 }
        );
      const capability = backend.capabilities;
      if (
        capability?.state !== "validated" ||
        (capability.expiresAt &&
          Date.parse(capability.expiresAt) <= Date.now()) ||
        !upstreamSupportsCollaborationRealtime(backend)
      )
        throw Object.assign(
          new Error("Public Square upstream capabilities are unavailable"),
          { statusCode: 503 }
        );
      const authorization =
        context.localEdge.resolveUpstreamAuthorization(backend);
      if (!authorization)
        throw Object.assign(
          new Error("Public Square upstream is not enrolled"),
          { statusCode: 503 }
        );
      return { backend, authorization };
    };
  const authenticatePublicSquare = async (
    request: FastifyRequest,
    operationFamily: "team_chat_read" | "team_chat_write"
  ) => {
    const localProfile = localProfiles.has(context.config.deploymentProfile);
    const bearer = /^Bearer(?:\s|$)/i.test(
      request.headers.authorization?.trim() ?? ""
    );
    if (bearer) {
      if (!localProfile)
        throw Object.assign(
          new Error("API Tokens cannot authorize hosted Team operations"),
          { statusCode: 403 }
        );
      const user = await context.authenticateApiToken(request);
      const remoteAddress = request.socket.remoteAddress?.replace(
        /^::ffff:/u,
        ""
      );
      if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1")
        throw forbidden("Paired local application credential required");
      const supplied = /^Bearer\s+(.+)$/i.exec(
        request.headers.authorization?.trim() ?? ""
      )?.[1];
      let paired = false;
      try {
        const content = JSON.parse(
          await readFile(
            resolve(
              context.config.koedHome,
              "config",
              "local-app-credential.json"
            ),
            "utf8"
          )
        ) as { apiToken?: unknown };
        const expected =
          typeof content.apiToken === "string"
            ? Buffer.from(content.apiToken.trim())
            : Buffer.alloc(0);
        const actual =
          typeof supplied === "string"
            ? Buffer.from(supplied)
            : Buffer.alloc(0);
        paired =
          expected.length > 0 &&
          expected.length === actual.length &&
          timingSafeEqual(expected, actual);
      } catch {
        // Missing or invalid local credential cannot authorize the request.
      }
      if (!paired)
        throw forbidden("Paired local application credential required");
      const authority = resolvePublicSquareAuthority();
      if (!authority)
        throw Object.assign(
          new Error("A local API Token cannot authorize local Team data"),
          { statusCode: 403 }
        );
      return { user, authority };
    }
    const user = await authenticateTeamCollaboration(
      request,
      context,
      operationFamily
    );
    const authority = resolvePublicSquareAuthority();
    if (localProfile && authority)
      throw Object.assign(
        new Error(
          "A paired local API Token is required for remote Public Square"
        ),
        { statusCode: 403 }
      );
    return { user, authority };
  };
  const proxyPublicSquare = async (
    request: FastifyRequest,
    operationFamily: "team_chat_read" | "team_chat_write",
    authority: PublicSquareUpstreamAuthority | null,
    body?: unknown
  ): Promise<Record<string, unknown> | null> => {
    if (!authority) return null;
    const method = request.method as "GET" | "POST" | "PUT" | "DELETE";
    const requestUrl = new URL(request.url, "http://localhost");
    const path = `${requestUrl.pathname}${requestUrl.search}`;
    assertUpstreamOperationPathAllowed(operationFamily, method, path);
    const upstreamUrl = upstreamApiUrl(
      authority.backend.baseUrl,
      requestUrl.pathname
    );
    upstreamUrl.search = requestUrl.search;
    const { response, payload } = await fetchBoundedJsonObject(
      context.localEdge.fetch,
      upstreamUrl,
      {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: authority.authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      },
      { timeoutMs: 15_000, maxBytes: 384 * 1_024, readErrorBody: true }
    );
    if (!response.ok) {
      throw Object.assign(
        new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Public Square authority returned HTTP ${response.status}`
        ),
        { statusCode: response.status >= 500 ? 502 : response.status }
      );
    }
    return payload;
  };

  const overviewCursor = (
    value?: string
  ): { offset: number; fingerprint: string | null } => {
    if (!value) return { offset: 0, fingerprint: null };
    try {
      const decoded = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8")
      ) as { offset?: unknown; fingerprint?: unknown };
      if (
        !Number.isSafeInteger(decoded.offset) ||
        Number(decoded.offset) < 0 ||
        typeof decoded.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(decoded.fingerprint) ||
        Object.keys(decoded).length !== 2 ||
        Buffer.from(value, "base64url").toString("base64url") !== value
      )
        throw new Error();
      return {
        offset: Number(decoded.offset),
        fingerprint: decoded.fingerprint
      };
    } catch {
      throw badRequest("Team overview cursor is invalid");
    }
  };
  const makeTeamOverview = async (
    userId: string,
    limit: number,
    cursor?: string
  ) => {
    const actor = { userId };
    const overviewRepository = context.requireTeamOverviewRepository();
    const sourcesRepository = context.requireTeamOverviewSourcesRepository();
    const teams = await overviewRepository.listAuthorizedTeams(actor);
    const sources = await sourcesRepository.listCurrentItems(actor, teams);
    const rawAttention = sources.attention;
    const rawCatchUp = sources.catchUp;
    const currentJobOutcomes = [...rawAttention, ...rawCatchUp]
      .filter((item) => item.source === "team_job_outcome")
      .map(({ teamId, sourceEventId, sourceRevision }) => ({
        teamId,
        sourceEventId,
        sourceRevision
      }));
    const eventIds = [...rawAttention, ...rawCatchUp].map(
      (item) => item.sourceEventId
    );
    const states = await overviewRepository.listReminderStates(actor, {
      sourceEventIds: eventIds
    });
    const stateByEvent = new Map(
      states.map((state) => [state.sourceEventId, state])
    );
    const sourceFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          actor: `${context.deploymentIdentity.inspect().deploymentId ?? "unknown-authority"}:${userId}`,
          teams: teams.map((team) => team.teamId).sort(),
          sources: [...rawAttention, ...rawCatchUp]
            .map((item) => {
              const state = stateByEvent.get(item.sourceEventId);
              const currentState =
                state?.teamId === item.teamId &&
                state.source === item.source &&
                state.sourceId === item.sourceId &&
                state.sourceRevision === item.sourceRevision
                  ? state
                  : null;
              return {
                teamId: item.teamId,
                source: item.source,
                sourceEventId: item.sourceEventId,
                sourceId: item.sourceId,
                sourceRevision: item.sourceRevision,
                cleared: currentState?.cleared ?? false,
                seen: currentState?.seen ?? false
              };
            })
            .sort(
              (a, b) =>
                a.teamId.localeCompare(b.teamId) ||
                a.sourceEventId.localeCompare(b.sourceEventId)
            )
        })
      )
      .digest("hex");
    const decodedCursor = overviewCursor(cursor);
    if (
      decodedCursor.fingerprint !== null &&
      decodedCursor.fingerprint !== sourceFingerprint
    ) {
      throw Object.assign(new Error("Team overview changed between pages"), {
        statusCode: 409
      });
    }
    const attention: TeamOverviewItem[] = [];
    const cleared: TeamOverviewItem[] = [];
    for (const item of rawAttention) {
      const state = stateByEvent.get(item.sourceEventId);
      const currentState =
        state?.teamId === item.teamId &&
        state.source === item.source &&
        state.sourceId === item.sourceId &&
        state.sourceRevision === item.sourceRevision
          ? state
          : null;
      if (currentState?.cleared) cleared.push(item);
      else attention.push(item);
    }
    const catchUp = rawCatchUp.filter((item) => {
      const state = stateByEvent.get(item.sourceEventId);
      return !(
        state &&
        state.teamId === item.teamId &&
        state.source === item.source &&
        state.sourceId === item.sourceId &&
        state.sourceRevision === item.sourceRevision &&
        state.seen
      );
    });
    const priorityRank = (item: TeamOverviewItem) =>
      item.priority === "blocker" ? 0 : 1;
    attention.sort(
      (a, b) =>
        priorityRank(a) - priorityRank(b) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    );
    catchUp.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    cleared.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const offset = decodedCursor.offset;
    const combined = [...attention, ...catchUp, ...cleared];
    const page = combined.slice(offset, offset + limit);
    const pageAttention = page.filter((item) => attention.includes(item));
    const pageCatchUp = page.filter((item) => catchUp.includes(item));
    const pageCleared = page.filter((item) => cleared.includes(item));
    const teamCounts = teams.map((team) => ({
      ...team,
      badgeCount: attention.filter((item) => item.teamId === team.teamId).length
    }));
    const complete = combined.length <= offset + limit;
    return teamOverviewSnapshotSchema.parse({
      schemaVersion: teamOverviewSchemaVersion,
      access: {
        accountScope: createHash("sha256")
          .update(
            `koed-team-overview:${context.deploymentIdentity.inspect().deploymentId ?? "unknown-authority"}:${userId}`
          )
          .digest("hex"),
        backendId: null
      },
      generatedAt: new Date().toISOString(),
      teams: teamCounts,
      coverage: [
        "message_attention",
        "agent_request",
        "team_job_action",
        "team_job_outcome",
        "pull_request_action"
      ].map((source) => ({ source, complete: true, nextCursor: null })),
      currentJobOutcomes,
      attention: pageAttention,
      catchUp: pageCatchUp,
      cleared: pageCleared,
      nextCursor: complete
        ? null
        : Buffer.from(
            JSON.stringify({
              offset: offset + limit,
              fingerprint: sourceFingerprint
            })
          ).toString("base64url"),
      badgeCount: attention.length
    });
  };

  app.get(
    "/v1/collaboration/teams/overview",
    { preHandler: readRateLimit },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_read"
      );
      if (authority) {
        const proxied = await proxyPublicSquare(
          request,
          "team_chat_read",
          authority
        );
        return teamOverviewSnapshotSchema.parse(proxied);
      }
      const input = teamOverviewQuerySchema.parse(request.query);
      return makeTeamOverview(user.id, input.limit, input.cursor);
    }
  );

  app.post(
    "/v1/collaboration/teams/:teamId/overview/:sourceEventId/:action",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_write"
      );
      const params = z
        .object({
          teamId: z.uuid(),
          sourceEventId: z
            .string()
            .min(1)
            .max(160)
            .regex(/^[A-Za-z0-9._:-]+$/u),
          action: z.enum(["clear", "restore", "seen"])
        })
        .strict()
        .parse(request.params);
      const input = teamOverviewSourceMutationSchema.parse(request.body);
      if (authority) {
        const proxied = await proxyPublicSquare(
          request,
          "team_chat_write",
          authority,
          input
        );
        return teamOverviewMutationResultSchema.parse(proxied);
      }
      const overviewRepository = context.requireTeamOverviewRepository();
      const teams = await overviewRepository.listAuthorizedTeams({
        userId: user.id
      });
      if (!teams.some((team) => team.teamId === params.teamId))
        throw forbidden();
      const current = await context
        .requireTeamOverviewSourcesRepository()
        .listCurrentItems({ userId: user.id }, teams);
      const allCurrent = [...current.attention, ...current.catchUp];
      const item = allCurrent.find(
        (candidate) =>
          candidate.teamId === params.teamId &&
          candidate.sourceEventId === params.sourceEventId
      );
      if (!item || item.sourceRevision !== input.sourceRevision)
        throw Object.assign(new Error("Team overview item changed"), {
          statusCode: 409
        });
      const states = await overviewRepository.listReminderStates(
        { userId: user.id },
        { teamId: params.teamId, sourceEventIds: [item.sourceEventId] }
      );
      const currentState = states.find(
        (state) =>
          state.source === item.source &&
          state.sourceId === item.sourceId &&
          state.sourceRevision === item.sourceRevision
      );
      if (
        params.action === "clear" &&
        !current.attention.some(
          (candidate) => candidate.sourceEventId === item.sourceEventId
        )
      ) {
        throw badRequest("Only attention items can be cleared");
      }
      if (
        params.action === "restore" &&
        !current.attention.some(
          (candidate) => candidate.sourceEventId === item.sourceEventId
        )
      ) {
        throw badRequest("Only current attention items can be restored");
      }
      if (params.action === "restore" && !currentState?.cleared)
        throw Object.assign(new Error("Team overview item is not cleared"), {
          statusCode: 409
        });
      if (
        params.action === "seen" &&
        !current.catchUp.some(
          (candidate) => candidate.sourceEventId === item.sourceEventId
        )
      ) {
        throw badRequest("Only catch-up outcomes can be marked seen");
      }
      if (params.action === "seen" && item.source !== "team_job_outcome")
        throw badRequest("Only Team Job outcomes can be marked seen");
      const state = await context
        .requireTeamOverviewRepository()
        .setReminderState(
          { userId: user.id },
          {
            teamId: params.teamId,
            sourceEventId: item.sourceEventId,
            source: item.source,
            sourceId: item.sourceId,
            sourceRevision: item.sourceRevision,
            ...(params.action === "clear"
              ? { cleared: true }
              : params.action === "restore"
                ? { cleared: false }
                : { seen: true })
          }
        );
      if (!state) {
        const stillAuthorized = (
          await overviewRepository.listAuthorizedTeams({ userId: user.id })
        ).some((team) => team.teamId === params.teamId);
        if (stillAuthorized)
          throw Object.assign(new Error("Team overview item changed"), {
            statusCode: 409
          });
        throw forbidden();
      }
      return teamOverviewMutationResultSchema.parse({
        sourceEventId: state.sourceEventId,
        sourceRevision: state.sourceRevision,
        cleared: state.cleared,
        seen: state.seen
      });
    }
  );

  app.get(
    "/v1/collaboration/teams/:teamId/agent-offers",
    { preHandler: readRateLimit },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_read"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_read",
        authority
      );
      if (proxied) return proxied;
      const page = await context
        .requireTeamAgentRequestsRepository()
        .listOffers({ userId: user.id }, { teamId });
      if (!page) throw forbidden();
      return { teamId, offers: page.items, serverTime: page.serverTime };
    }
  );

  app.put(
    "/v1/collaboration/teams/:teamId/agent-offers/:agentId",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_write"
      );
      const params = z
        .object({ teamId: z.uuid(), agentId: z.uuid() })
        .parse(request.params);
      const input = updateTeamAgentOfferInputSchema.parse(request.body);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_write",
        authority,
        input
      );
      if (proxied) return proxied;
      const offer = await context
        .requireTeamAgentRequestsRepository()
        .updateOffer({ userId: user.id }, { ...params, ...input });
      if (!offer) throw forbidden();
      return { offer };
    }
  );

  app.post(
    "/v1/collaboration/teams/:teamId/agent-requests",
    { preHandler: writeRateLimit, bodyLimit: MESSAGE_BODY_LIMIT_BYTES },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_write"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
      const input = createTeamAgentRequestInputSchema.parse(request.body);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_write",
        authority,
        input
      );
      if (proxied) return proxied;
      const created = await context
        .requireTeamAgentRequestsRepository()
        .createRequest({ userId: user.id }, { teamId, ...input });
      if (!created) throw forbidden();
      return { request: created };
    }
  );

  const listTeamAgentRequests = async (
    request: FastifyRequest,
    inbox: boolean
  ) => {
    const { user, authority } = await authenticatePublicSquare(
      request,
      "team_chat_read"
    );
    const { teamId } = teamCollaborationParamsSchema.parse(request.params);
    const query = listTeamAgentRequestsQuerySchema.parse(request.query);
    const proxied = await proxyPublicSquare(
      request,
      "team_chat_read",
      authority
    );
    if (proxied) return proxied;
    const page = await context
      .requireTeamAgentRequestsRepository()
      .listRequests({ userId: user.id }, { teamId, ...query, inbox });
    if (!page) throw forbidden();
    return page;
  };

  app.get(
    "/v1/collaboration/teams/:teamId/agent-requests",
    { preHandler: readRateLimit },
    async (request) => listTeamAgentRequests(request, false)
  );
  app.get(
    "/v1/collaboration/teams/:teamId/agent-requests/inbox",
    { preHandler: readRateLimit },
    async (request) => listTeamAgentRequests(request, true)
  );

  app.get(
    "/v1/collaboration/teams/:teamId/agent-requests/:requestId/review",
    { preHandler: readRateLimit },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_read"
      );
      const params = z
        .object({ teamId: z.uuid(), requestId: z.uuid() })
        .parse(request.params);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_read",
        authority
      );
      if (proxied) return proxied;
      const review = await context
        .requireTeamAgentRequestsRepository()
        .getReview({ userId: user.id }, params);
      if (!review) throw forbidden();
      return { review };
    }
  );
  app.put(
    "/v1/collaboration/teams/:teamId/agent-requests/:requestId/review",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_write"
      );
      const params = z
        .object({ teamId: z.uuid(), requestId: z.uuid() })
        .parse(request.params);
      const input = updateTeamAgentRequestReviewInputSchema.parse(request.body);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_write",
        authority,
        input
      );
      if (proxied) return proxied;
      const review = await context
        .requireTeamAgentRequestsRepository()
        .updateReview({ userId: user.id }, { ...params, ...input });
      if (!review) throw forbidden();
      return { review };
    }
  );
  app.put(
    "/v1/collaboration/teams/:teamId/agent-requests/:requestId/decision",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_write"
      );
      const params = z
        .object({ teamId: z.uuid(), requestId: z.uuid() })
        .parse(request.params);
      const input = decideTeamAgentRequestInputSchema.parse(request.body);
      if (
        input.decision === "accept" &&
        authority &&
        (authority.backend.routePolicy.managedExecution !== "enabled" ||
          authority.backend.capabilities?.state !== "validated" ||
          (authority.backend.capabilities.expiresAt &&
            Date.parse(authority.backend.capabilities.expiresAt) <=
              Date.now()) ||
          !upstreamAdvertisesCapability(
            authority.backend,
            "memory.managedConversations"
          ))
      ) {
        throw Object.assign(
          new Error("Managed Agent execution is disabled for this upstream"),
          { statusCode: 403 }
        );
      }
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_write",
        authority,
        input
      );
      if (proxied) return proxied;
      if (input.decision === "accept") {
        const authorization = request.headers.authorization?.trim() ?? "";
        if (!/^Bearer(?:\s|$)/i.test(authorization)) {
          await context.authenticateSessionOrDeviceCredential(
            request,
            "managed_execution",
            {
              apiTokenError: "API Tokens cannot authorize Agent execution"
            }
          );
        }
      }
      const repo = context.requireTeamAgentRequestsRepository();
      const result = await repo.decideRequest(
        { userId: user.id },
        { ...params, ...input },
        (client, jobInput) => context.createOwnerJobWithClient(client, jobInput)
      );
      if (!result) throw forbidden();
      return { request: result };
    }
  );
  app.delete(
    "/v1/collaboration/teams/:teamId/agent-requests/:requestId",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_write"
      );
      const params = z
        .object({ teamId: z.uuid(), requestId: z.uuid() })
        .parse(request.params);
      const input = withdrawTeamAgentRequestInputSchema.parse(request.body);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_write",
        authority,
        input
      );
      if (proxied) return proxied;
      const result = await context
        .requireTeamAgentRequestsRepository()
        .withdrawRequest({ userId: user.id }, { ...params, ...input });
      if (!result) throw forbidden();
      return { request: result };
    }
  );
  app.post(
    "/v1/collaboration/teams/:teamId/agent-requests/:requestId/outcome",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_write"
      );
      const params = z
        .object({ teamId: z.uuid(), requestId: z.uuid() })
        .parse(request.params);
      const input = postTeamAgentRequestOutcomeInputSchema.parse(request.body);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_write",
        authority,
        input
      );
      if (proxied) return proxied;
      const result = await context
        .requireTeamAgentRequestsRepository()
        .postOutcome({ userId: user.id }, { ...params, ...input });
      if (!result) throw forbidden();
      return { request: result };
    }
  );

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
      const repository = context.requireCollaborationRepository();
      if (
        !(await repository.ensureTeamGeneralChannel(
          { userId: user.id },
          teamId
        ))
      ) {
        throw forbidden();
      }
      const threads = await repository.listThreads(
        { userId: user.id },
        { scope: "team", teamId, ...query }
      );
      if (!threads) throw forbidden();
      return { threads: publicTeamThreads(threads) };
    }
  );

  app.get(
    "/v1/collaboration/teams/:teamId/channels",
    { preHandler: readRateLimit },
    async (request) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_read"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
      const query = listCollaborationThreadsQuerySchema.parse(request.query);
      const repository = context.requireCollaborationRepository();
      if (
        !(await repository.ensureTeamGeneralChannel(
          { userId: user.id },
          teamId
        ))
      ) {
        throw forbidden();
      }
      const threads = await repository.listThreads(
        { userId: user.id },
        {
          scope: "team",
          teamId,
          kinds: ["team_channel"],
          includeArchived: query.includeArchived,
          limit: query.limit
        }
      );
      if (!threads) throw forbidden();
      return { threads: publicTeamThreads(threads) };
    }
  );

  app.post(
    "/v1/collaboration/teams/:teamId/channels",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_write"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
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
            kind: "team_channel",
            idempotencyKey: parseIdempotencyKey(request),
            teamId,
            ...input
          }
        );
      if (!thread) throw forbidden();
      return reply.status(201).send({
        thread: publicCollaborationThread(thread)
      });
    }
  );

  app.get(
    "/v1/collaboration/teams/:teamId/projects",
    { preHandler: readRateLimit },
    async (request) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_read"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
      const projects = await context
        .requireCollaborationRepository()
        .listTeamSharedProjects({ userId: user.id }, teamId);
      if (!projects) throw forbidden();
      return {
        projects: projects.map(({ id, teamId: projectTeamId, thread }) => ({
          id,
          teamId: projectTeamId,
          name: thread.name,
          thread: publicCollaborationThread(thread)
        }))
      };
    }
  );

  app.post(
    "/v1/collaboration/teams/:teamId/projects",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const user = await authenticateTeamCollaboration(
        request,
        context,
        "team_chat_write"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
      const input = createTeamSharedProjectSchema.parse(request.body);
      await enforceCollaborationAdmission(
        reply,
        context.admission.admitChannelCreation({ userId: user.id, teamId })
      );
      const project = await context
        .requireCollaborationRepository()
        .createTeamSharedProject(
          { userId: user.id },
          {
            teamId,
            idempotencyKey: parseIdempotencyKey(request),
            name: input.name,
            localProjectId: input.localProjectId
          }
        );
      if (!project) throw forbidden();
      return reply.status(201).send({
        project: {
          id: project.id,
          teamId: project.teamId,
          name: project.thread.name
        },
        thread: publicCollaborationThread(project.thread)
      });
    }
  );

  app.get(
    "/v1/collaboration/teams/:teamId/public-square",
    { preHandler: readRateLimit },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_read"
      );
      const { teamId } = teamCollaborationParamsSchema.parse(request.params);
      const query = publicSquareListQuerySchema.parse(request.query);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_read",
        authority
      );
      if (proxied) return proxied;
      const page = await context
        .requireCollaborationRepository()
        .listPublicSquare({ userId: user.id }, { teamId, ...query });
      if (!page) throw forbidden();
      return { page };
    }
  );

  app.get(
    "/v1/collaboration/teams/:teamId/public-square/projects/:teamProjectId/connection",
    { preHandler: readRateLimit },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_read"
      );
      const params = z
        .object({ teamId: z.uuid(), teamProjectId: z.uuid() })
        .parse(request.params);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_read",
        authority
      );
      if (proxied) return proxied;
      const connection = await context
        .requireCollaborationRepository()
        .getPublicSquareConnection({ userId: user.id }, params);
      if (!connection) throw forbidden();
      return { connection };
    }
  );

  app.put(
    "/v1/collaboration/teams/:teamId/public-square/projects/:teamProjectId/connection",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_write"
      );
      const params = z
        .object({ teamId: z.uuid(), teamProjectId: z.uuid() })
        .parse(request.params);
      const input = teamProjectMemberConnectionInputSchema.parse(request.body);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_write",
        authority,
        input
      );
      if (proxied) return proxied;
      const connection = await context
        .requireCollaborationRepository()
        .setPublicSquareConnection(
          { userId: user.id },
          { ...params, ...input }
        );
      if (!connection) throw forbidden();
      return { connection };
    }
  );

  app.post(
    "/v1/collaboration/teams/:teamId/public-square/projects/:teamProjectId/unshare",
    { preHandler: writeRateLimit },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_write"
      );
      const params = z
        .object({ teamId: z.uuid(), teamProjectId: z.uuid() })
        .parse(request.params);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_write",
        authority
      );
      if (proxied) return proxied;
      if (
        !(await context
          .requireCollaborationRepository()
          .unsharePublicSquareProject({ userId: user.id }, params))
      )
        throw forbidden();
      return { ...params, unshared: true as const };
    }
  );

  app.get(
    "/v1/collaboration/teams/:teamId/public-square/:publicationId/brief-draft",
    { preHandler: readRateLimit },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_read"
      );
      const params = z
        .object({ teamId: z.uuid(), publicationId: z.uuid() })
        .parse(request.params);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_read",
        authority
      );
      if (proxied) return proxied;
      const draft = await context
        .requireCollaborationRepository()
        .getPublicSquareBriefDraft({ userId: user.id }, params);
      if (!draft) throw forbidden();
      return { draft };
    }
  );

  app.put(
    "/v1/collaboration/teams/:teamId/public-square/:publicationId/brief",
    { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const { user, authority } = await authenticatePublicSquare(
        request,
        "team_chat_write"
      );
      const params = z
        .object({ teamId: z.uuid(), publicationId: z.uuid() })
        .parse(request.params);
      const input = publicSquareBriefInputSchema.parse(request.body);
      const proxied = await proxyPublicSquare(
        request,
        "team_chat_write",
        authority,
        input
      );
      if (proxied) return proxied;
      const publication = await context
        .requireCollaborationRepository()
        .updatePublicSquareBrief({ userId: user.id }, { ...params, ...input });
      if (!publication) throw forbidden();
      return { publication };
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
    const parseScopedMessageParams = (
      params: unknown
    ): { threadId: string; teamId: string | null; messageId: string } => {
      if (scope === "personal") {
        return {
          ...collaborationThreadParamsSchema
            .extend({ messageId: z.uuid() })
            .parse(params),
          teamId: null
        };
      }
      return teamCollaborationThreadParamsSchema
        .extend({ messageId: z.uuid() })
        .parse(params);
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
        if (scope === "personal" && input.mentionUserIds?.length)
          throw badRequest("Mentions are only available in Team messages");
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
        const result = await repository.sendMessageWithReceipt(
          { userId: user.id },
          {
            threadId: params.threadId,
            rootMessageId: input.rootMessageId ?? null,
            idempotencyKey: parseIdempotencyKey(request),
            ...input
          }
        );
        if (!result) throw forbidden();
        return reply.status(201).send(result);
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
        if (scope !== "team" && input.rootMessageId)
          throw badRequest(
            "Reply read cursors are only available for Team channels"
          );
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

    app.patch(
      `${basePath}/messages/:messageId`,
      { preHandler: writeRateLimit, bodyLimit: MESSAGE_BODY_LIMIT_BYTES },
      async (request) => {
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
        const params = parseScopedMessageParams(request.params);
        const input = editCollaborationMessageSchema.parse(request.body);
        if (scope !== "team") throw forbidden();
        const repository = context.requireCollaborationRepository();
        await requireTeamThread(
          repository,
          user.id,
          params.teamId!,
          params.threadId
        );
        const message = await repository.editMessage(
          { userId: user.id },
          {
            threadId: params.threadId,
            messageId: params.messageId,
            bodyText: input.bodyText,
            expectedVersion: input.expectedVersion,
            ...(input.mentionUserIds !== undefined
              ? { mentionUserIds: input.mentionUserIds }
              : {})
          }
        );
        if (!message) throw forbidden();
        return { message };
      }
    );

    app.put(
      `${basePath}/messages/:messageId/reactions`,
      { preHandler: writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
      async (request) => {
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
        const params = parseScopedMessageParams(request.params);
        const input = setCollaborationMessageReactionSchema.parse(request.body);
        if (scope !== "team") throw forbidden();
        const repository = context.requireCollaborationRepository();
        await requireTeamThread(
          repository,
          user.id,
          params.teamId!,
          params.threadId
        );
        const message = await repository.setMessageReaction(
          { userId: user.id },
          {
            threadId: params.threadId,
            messageId: params.messageId,
            emoji: input.emoji,
            active: input.active
          }
        );
        if (!message) throw forbidden();
        return { message };
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
        if (input.rootMessageId)
          throw badRequest("Delivery cursors do not support reply threads");
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
