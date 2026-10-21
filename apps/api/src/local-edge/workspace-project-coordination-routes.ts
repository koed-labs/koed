import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  fetchBoundedJson,
  verifyDesktopLocalCredentialAuthorization,
  verifyLocalEdgeClientCredentialAuthorization
} from "@koed/shared";
import {
  PersonalWorkspaceProjectConflictError,
  PersonalWorkspaceProjectUnavailableError,
  workspaceProjectCopyManifestHash,
  type PersonalWorkspaceProjectRepository,
  type ProjectSourceRepository,
  type createFlashcardDeckRepository
} from "@koed/db";
import type { CollaborationRepository } from "@koed/db";
import { ensureDeckLearning } from "../memory/deck-learning-routes.js";
import type { ApiRouteContext } from "../server/context.js";
import { workspaceProjectWorkItemSchema } from "@koed/shared/workspace-project-contract";
import {
  projectSourceUploadSchema,
  projectSourceSchema,
  projectSourceReadSchema
} from "@koed/shared";
import { createHash } from "node:crypto";
import {
  deckSchema,
  deckProgressListSchema,
  deckProgressSchema,
  putDeckProgressSchema
} from "@koed/shared";
import { authenticateProjectOperation } from "../projects/desktop-read-auth.js";
import {
  readLocalEdgeUpstreamRegistry,
  safeUpstreamProxyUrl,
  upstreamBackendById
} from "./upstream-routing.js";

const idParams = z.object({ projectId: z.uuid() }).strict();
const confirmSchema = z
  .object({
    teamBackendId: z.string().trim().min(1).max(160),
    workspaceProjectId: z.uuid(),
    expectedPersonalProjectVersion: z.number().int().positive()
  })
  .strict();
const prepareSchema = z
  .object({
    teamBackendId: z.string().trim().min(1).max(160),
    shareAttemptKey: z.string().trim().min(8).max(200),
    targetTeamId: z.uuid(),
    targetWorkspaceId: z.uuid()
  })
  .strict();
const targetProofSchema = z
  .object({
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    ownerUserId: z.uuid(),
    canStart: z.boolean()
  })
  .strict();
const cancelReceiptSchema = z
  .object({
    canceled: z.literal(true),
    receiptId: z.uuid(),
    teamId: z.uuid(),
    workspaceId: z.uuid(),
    ownerUserId: z.uuid(),
    shareAttemptKey: z.string().min(8)
  })
  .strict();
const principalSchema = z
  .object({
    ok: z.literal(true),
    auth: z.literal("device_credential"),
    user: z.object({ id: z.uuid() }).passthrough()
  })
  .passthrough();
const proofSchema = z
  .object({
    projectId: z.uuid(),
    workspaceId: z.uuid(),
    teamId: z.uuid(),
    ownerTeamMemberId: z.uuid(),
    ownerUserId: z.uuid(),
    projectVersion: z.number().int().positive(),
    copyManifestHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
const deckCopyMapSchema = z
  .object({
    projectId: z.uuid(),
    copyManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    cards: z
      .array(
        z
          .object({
            sourceDeckId: z.uuid(),
            deckId: z.uuid(),
            sourceCardId: z.uuid(),
            cardId: z.uuid()
          })
          .strict()
      )
      .max(50000)
  })
  .strict();
const copyBackDeckSchema = z
  .object({
    id: z.uuid(),
    sourceOwnerTeamMemberId: z.uuid(),
    sourceDeckId: z.uuid().nullable(),
    title: z.string().min(1).max(500),
    scope: z.string().max(2000),
    madeFrom: z.string().max(4000),
    createdByAgentId: z.uuid().nullable(),
    cards: z
      .array(
        z
          .object({
            id: z.uuid(),
            sourceCardId: z.uuid().nullable(),
            question: z.string().min(1).max(4000),
            answer: z.string().min(1).max(16000),
            sourceRef: z.string().max(2048).nullable(),
            topicLabel: z.string().max(240).nullable()
          })
          .strict()
      )
      .max(500)
  })
  .strict();
const copyBackDecksSchema = z
  .array(copyBackDeckSchema)
  .max(100)
  .superRefine((decks, context) => {
    const deckIds = new Set<string>();
    const cardIds = new Set<string>();
    for (const deck of decks) {
      if (deckIds.has(deck.id))
        context.addIssue({ code: "custom", message: "Duplicate Team Deck ID" });
      deckIds.add(deck.id);
      for (const card of deck.cards) {
        if (cardIds.has(card.id))
          context.addIssue({
            code: "custom",
            message: "Duplicate Team Card ID"
          });
        cardIds.add(card.id);
      }
    }
  });
const lifecycleSchema = z
  .object({
    id: z.uuid(),
    active: z.boolean(),
    canWrite: z.boolean(),
    version: z.number().int().positive(),
    memberVersion: z.number().int().positive()
  })
  .strict();
const leaveStageSchema = z
  .object({
    teamBackendId: z.string().trim().min(1).max(160),
    teamId: z.uuid()
  })
  .strict();
const finishStageSchema = z
  .object({
    teamBackendId: z.string().trim().min(1).max(160),
    stageIds: z.array(z.uuid()).max(100)
  })
  .strict();
const leaveReviewSchema = z
  .object({
    team: z
      .object({ id: z.uuid(), version: z.number().int().positive() })
      .passthrough(),
    membership: z
      .object({
        userId: z.uuid(),
        role: z.enum(["owner", "admin", "member"]),
        version: z.number().int().positive()
      })
      .passthrough(),
    activeOwnerCount: z.number().int().nonnegative(),
    ownedWorkspaceProjects: z.array(
      z
        .object({
          id: z.uuid(),
          version: z.number().int().positive()
        })
        .strict()
    )
  })
  .passthrough();
const tombstoneSchema = z
  .object({
    projectId: z.uuid(),
    teamId: z.uuid(),
    ownerUserId: z.uuid(),
    version: z.number().int().positive(),
    allMemberLinksDisabled: z.literal(true),
    grantsFrozen: z.literal(true),
    threadArchived: z.literal(true)
  })
  .passthrough();

const denied = (message: string, statusCode = 403): never => {
  throw Object.assign(new Error(message), { statusCode });
};

export const registerWorkspaceProjectCoordinationRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext,
  repository: PersonalWorkspaceProjectRepository | null,
  sourceRepository: ProjectSourceRepository | null,
  requestSourceIngestion?: () => void,
  deckRepository?: ReturnType<typeof createFlashcardDeckRepository> | null,
  personalNotes?: Pick<
    CollaborationRepository,
    | "createPersonalNote"
    | "findPersonalNoteByIdempotencyKey"
    | "getPersonalNote"
  > | null
) => {
  const repo = () =>
    repository ?? denied("Personal Workspace Project state unavailable", 503);
  const authenticateLocal = async (request: FastifyRequest, write = true) => {
    if (!request.headers.authorization?.trim().startsWith("Koed-Desktop "))
      denied("Desktop local credential required");
    const actor = await authenticateProjectOperation(
      request,
      {
        auth: context.auth,
        deploymentProfile: context.config.deploymentProfile,
        koedHome: context.config.koedHome
      },
      write
    );
    const local = verifyDesktopLocalCredentialAuthorization(
      context.config.koedHome,
      request.headers.authorization,
      {
        ownerUserId: actor.id,
        operationFamily: write
          ? "personal_collaboration_write"
          : "personal_collaboration_read"
      }
    );
    if (!local) denied("Enrolled local credential required");
    return { actor, local: local! };
  };
  const authenticate = async (
    request: FastifyRequest,
    backendId: string,
    family: "team_workspace_read" | "team_workspace_write",
    personalWrite = true
  ) => {
    const { actor, local } = await authenticateLocal(request, personalWrite);
    const teamHeader = request.headers["x-koed-team-client-credential"];
    const team = verifyLocalEdgeClientCredentialAuthorization(
      context.config.koedHome,
      (Array.isArray(teamHeader) ? teamHeader[0] : teamHeader)?.trim(),
      { backendId, operationFamily: family }
    );
    if (!team) denied("Enrolled Team credential required");
    return { actor, local: local!, team: team! };
  };
  const requestTeam = async (backendId: string, path: string) => {
    const backend = upstreamBackendById(
      readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
      backendId
    );
    if (!backend) denied("Team backend is not enrolled", 424);
    const authorization = context.localEdge.resolveUpstreamAuthorization(
      backend!
    );
    if (!authorization) denied("Team upstream credential unavailable", 424);
    const remote = await fetchBoundedJson(
      context.localEdge.fetch,
      safeUpstreamProxyUrl(backend!, path),
      {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: authorization!
        }
      },
      { timeoutMs: 15_000, maxBytes: 8_000_000 }
    );
    if (!remote.response.ok)
      denied("Authoritative Team Project state unavailable", 424);
    return remote.payload;
  };
  const deckRepo = () =>
    deckRepository ?? denied("Personal Deck progress unavailable", 503);
  const linkedDeck = async (
    request: FastifyRequest,
    projectId: string,
    deckId: string,
    write: boolean
  ) => {
    const local = await authenticateLocal(request, write);
    const link = await repo().getLink(local.actor.id, projectId);
    if (!link) denied("Shared Project link unavailable", 404);
    await authenticate(
      request,
      link!.teamBackendId,
      "team_workspace_read",
      write
    );
    const principal = await teamPrincipal(link!.teamBackendId);
    if (
      (await repo().principalBinding(local.actor.id, link!.teamBackendId)) !==
      principal
    )
      denied("Enrolled Team principal changed", 409);
    const remote = deckSchema.parse(
      await requestTeam(
        link!.teamBackendId,
        `/v1/workspace-projects/${link!.workspaceProjectId}/decks/${deckId}`
      )
    );
    if (remote.projectId !== link!.workspaceProjectId || remote.id !== deckId)
      denied("Team Deck identity changed", 409);
    return { ownerUserId: local.actor.id, link: link!, deck: remote };
  };
  app.get(
    "/v1/local-edge/projects/:projectId/decks/:deckId/progress",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const { projectId, deckId } = z
        .object({ projectId: z.uuid(), deckId: z.uuid() })
        .strict()
        .parse(request.params);
      const current = await linkedDeck(request, projectId, deckId, false);
      const local = await deckRepo().progress(current.ownerUserId, projectId);
      if (
        local.link.teamBackendId !== current.link.teamBackendId ||
        local.link.workspaceProjectId !== current.link.workspaceProjectId
      )
        denied("Project link changed", 409);
      const active = new Set(current.deck.cards.map((c) => c.id));
      return deckProgressListSchema.parse({
        progress: local.progress
          .filter((p) => p.deckId === deckId && active.has(p.cardId))
          .map((p) => ({
            cardId: p.cardId,
            box: p.box,
            nextAt: p.nextAt,
            misses: p.misses
          }))
      });
    }
  );
  app.put(
    "/v1/local-edge/projects/:projectId/decks/:deckId/cards/:cardId/progress",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const { projectId, deckId, cardId } = z
        .object({ projectId: z.uuid(), deckId: z.uuid(), cardId: z.uuid() })
        .strict()
        .parse(request.params);
      const body = putDeckProgressSchema.parse(request.body);
      const current = await linkedDeck(request, projectId, deckId, true);
      if (!current.deck.cards.some((c) => c.id === cardId))
        denied("Team Card unavailable", 404);
      return deckProgressSchema.parse(
        await deckRepo().putProgress(
          current.ownerUserId,
          projectId,
          deckId,
          cardId,
          body,
          {
            teamBackendId: current.link.teamBackendId,
            workspaceProjectId: current.link.workspaceProjectId
          }
        )
      );
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/decks/:deckId/cards/:cardId/learning",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const { projectId, deckId, cardId } = z
        .object({ projectId: z.uuid(), deckId: z.uuid(), cardId: z.uuid() })
        .strict()
        .parse(request.params);
      const { mode, expectedDeckVersion, expectedCardVersion } = z
        .object({
          mode: z.enum(["begin", "reconcile"]),
          expectedDeckVersion: z.number().int().positive(),
          expectedCardVersion: z.number().int().positive()
        })
        .strict()
        .parse(request.body);
      const current = await linkedDeck(request, projectId, deckId, true);
      const card = current.deck.cards.find((item) => item.id === cardId);
      if (
        mode === "begin" &&
        (current.deck.version !== expectedDeckVersion ||
          card?.version !== expectedCardVersion)
      )
        denied("Deck Card changed before first Again", 409);
      const local = await deckRepo().progress(current.ownerUserId, projectId);
      if (
        !personalNotes ||
        !card ||
        local.link.teamBackendId !== current.link.teamBackendId ||
        local.link.workspaceProjectId !== current.link.workspaceProjectId
      )
        denied("Deck Card is unavailable", 409);
      return ensureDeckLearning({
        context,
        notes: personalNotes!,
        ownerId: current.ownerUserId,
        cardId,
        question: card!.question,
        sourceKey: `${projectId}:${current.link.teamBackendId}:${current.link.workspaceProjectId}`,
        mode
      });
    }
  );
  const cancelTeamAttempt = async (
    backendId: string,
    teamId: string,
    workspaceId: string,
    shareAttemptKey: string,
    expectedOwnerUserId: string
  ) => {
    const backend = upstreamBackendById(
      readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
      backendId
    );
    if (!backend) denied("Team backend is not enrolled", 424);
    const authorization = context.localEdge.resolveUpstreamAuthorization(
      backend!
    );
    if (!authorization) denied("Team upstream credential unavailable", 424);
    const remote = await fetchBoundedJson(
      context.localEdge.fetch,
      safeUpstreamProxyUrl(
        backend!,
        `/v1/teams/${teamId}/workspaces/${workspaceId}/share-attempt-cancellations`
      ),
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: authorization!
        },
        body: JSON.stringify({ shareAttemptKey, expectedOwnerUserId })
      },
      { timeoutMs: 15_000, maxBytes: 64_000 }
    );
    if (!remote.response.ok)
      denied(
        remote.response.status === 409
          ? "Team Project already exists; resume sharing to reconcile it"
          : "Team first-share cancellation was not confirmed",
        remote.response.status === 409 ? 409 : 424
      );
    return cancelReceiptSchema.parse(remote.payload);
  };
  const teamPrincipal = async (backendId: string) => {
    const backend = upstreamBackendById(
      readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
      backendId
    );
    if (!backend) denied("Team backend is not enrolled", 424);
    const authorization = context.localEdge.resolveUpstreamAuthorization(
      backend!
    );
    if (!authorization) denied("Team upstream credential unavailable", 424);
    const base = new URL(backend!.baseUrl.replace(/\/+$/, "/"));
    if (base.username || base.password || base.search || base.hash)
      denied("Unsafe Team backend", 424);
    const remote = await fetchBoundedJson(
      context.localEdge.fetch,
      new URL("v1/local-edge/device-credentials/status", base),
      {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: authorization!
        }
      },
      { timeoutMs: 15_000, maxBytes: 64_000 }
    );
    if (!remote.response.ok) denied("Enrolled Team principal unavailable", 424);
    return principalSchema.parse(remote.payload).user.id;
  };
  const reconcileInactive = async (
    ownerUserId: string,
    principal: string,
    personalProjectId: string,
    teamBackendId: string,
    workspaceProjectId: string
  ) => {
    const stage = await repo().getStagedCopyBackForProject(
      ownerUserId,
      teamBackendId,
      workspaceProjectId
    );
    if (!stage)
      return repo().reconcileInvalidation(
        ownerUserId,
        personalProjectId,
        workspaceProjectId
      );
    if (stage.personalProjectId !== personalProjectId)
      denied("Staged copy-back does not match linked Project", 409);
    const proof = tombstoneSchema.parse(
      await requestTeam(
        teamBackendId,
        `/v1/workspace-projects/${workspaceProjectId}/tombstone-proof`
      )
    );
    if (
      proof.projectId !== workspaceProjectId ||
      proof.teamId !== stage.teamId ||
      proof.ownerUserId !== principal ||
      proof.version <= stage.reviewedProjectVersion
    )
      denied("Team tombstone does not match reviewed leave", 409);
    const workItems = z
      .array(
        workspaceProjectWorkItemSchema.pick({
          id: true,
          sourceOwnerTeamMemberId: true,
          sourceWorkItemId: true,
          kind: true,
          key: true,
          title: true,
          goal: true,
          status: true,
          dueOn: true,
          doneAt: true
        })
      )
      .parse(stage.workItems);
    const decks = copyBackDecksSchema.parse(stage.decks);
    const result = await repo().copyBackOwnedProject(
      ownerUserId,
      personalProjectId,
      {
        stageId: stage.id,
        workspaceProjectId,
        ownerTeamMemberId: stage.ownerTeamMemberId,
        workItems,
        decks
      }
    );
    return { ...result, cleared: true, stageId: stage.id };
  };
  app.post(
    "/v1/local-edge/projects/:projectId/workspace-project-sources/upload",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 35 * 1024 * 1024 },
    async (request, reply) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().min(1),
          workspaceProjectId: z.uuid(),
          upload: projectSourceUploadSchema
        })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "team_workspace_write"
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Linked Project unavailable", 404);
      const principal = await teamPrincipal(body.teamBackendId);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== principal
      )
        denied("Enrolled Team principal changed", 409);
      const lifecycle = lifecycleSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/workspace-projects/${body.workspaceProjectId}/lifecycle`
        )
      );
      if (
        !lifecycle.active ||
        !lifecycle.canWrite ||
        lifecycle.id !== body.workspaceProjectId
      )
        denied("Team Project write access unavailable", 403);
      if (!sourceRepository)
        denied("Personal Source ingestion unavailable", 503);
      const uploaded = await sourceRepository!.uploadLinkedDocument(
        authority.actor.id,
        projectId,
        body.upload,
        {
          teamBackendId: body.teamBackendId,
          workspaceProjectId: body.workspaceProjectId
        }
      );
      requestSourceIngestion?.();
      return reply.code(202).send(projectSourceSchema.parse(uploaded.source));
    }
  );
  app.get(
    "/v1/local-edge/projects/:projectId/workspace-project-sources/:teamSourceId/content",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const { projectId, teamSourceId } = z
        .object({ projectId: z.uuid(), teamSourceId: z.uuid() })
        .strict()
        .parse(request.params);
      const { teamBackendId, workspaceProjectId } = z
        .object({
          teamBackendId: z.string().min(1),
          workspaceProjectId: z.uuid()
        })
        .strict()
        .parse(request.query);
      const authority = await authenticate(
        request,
        teamBackendId,
        "team_workspace_read"
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== teamBackendId ||
        link.workspaceProjectId !== workspaceProjectId
      )
        denied("Linked Project unavailable", 404);
      if (
        (await repo().principalBinding(authority.actor.id, teamBackendId)) !==
        (await teamPrincipal(teamBackendId))
      )
        denied("Enrolled Team principal changed", 409);
      const proofSchema = z
        .object({
          workspaceProjectId: z.uuid(),
          sourceId: z.uuid(),
          sourceProjectSourceId: z.uuid(),
          uploaderTeamMemberId: z.uuid(),
          sourceVersion: z.number().int().positive(),
          personalNoteId: z.uuid().nullable(),
          personalNoteRevisionId: z.uuid().nullable()
        })
        .strict();
      const path = `/v1/workspace-projects/${workspaceProjectId}/sources/${teamSourceId}/uploader-proof`;
      const proof = proofSchema.parse(await requestTeam(teamBackendId, path));
      if (
        proof.workspaceProjectId !== workspaceProjectId ||
        proof.sourceId !== teamSourceId
      )
        denied("Uploader Source proof changed", 409);
      if (!sourceRepository) denied("Personal Source storage unavailable", 503);
      const content = projectSourceReadSchema.parse(
        await sourceRepository!.readDocument(
          authority.actor.id,
          projectId,
          proof.sourceProjectSourceId,
          { teamBackendId, workspaceProjectId }
        )
      );
      if (
        content.sourceId !== proof.sourceProjectSourceId ||
        content.noteId !== proof.personalNoteId ||
        content.noteRevisionId !== proof.personalNoteRevisionId
      )
        denied(
          "Team Source metadata does not match the uploader's current Note",
          409
        );
      // Recheck Team authority after decrypting; a revoked member receives no body.
      const current = proofSchema.parse(await requestTeam(teamBackendId, path));
      if (
        current.sourceProjectSourceId !== proof.sourceProjectSourceId ||
        current.uploaderTeamMemberId !== proof.uploaderTeamMemberId ||
        current.workspaceProjectId !== proof.workspaceProjectId ||
        current.sourceId !== proof.sourceId ||
        current.sourceVersion !== proof.sourceVersion ||
        current.personalNoteId !== proof.personalNoteId ||
        current.personalNoteRevisionId !== proof.personalNoteRevisionId
      )
        denied("Uploader Source proof changed", 409);
      return content;
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/workspace-project-prepare",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = prepareSchema.parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "team_workspace_read"
      );
      const principal = await teamPrincipal(body.teamBackendId);
      const target = targetProofSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/teams/${body.targetTeamId}/workspaces/${body.targetWorkspaceId}/share-target?shareAttemptKey=${encodeURIComponent(body.shareAttemptKey)}`
        )
      );
      if (
        target.teamId !== body.targetTeamId ||
        target.workspaceId !== body.targetWorkspaceId ||
        target.ownerUserId !== principal ||
        !target.canStart
      )
        denied("Team sharing target changed", 409);
      await repo().bindPrincipal(authority.actor.id, {
        teamBackendId: body.teamBackendId,
        teamPrincipalUserId: principal,
        localCredentialKeyId: authority.local.credentialKeyId,
        teamCredentialKeyId: authority.team.credentialKeyId
      });
      try {
        return await repo().beginShare(authority.actor.id, projectId, body);
      } catch (error) {
        if (error instanceof PersonalWorkspaceProjectConflictError)
          denied(error.message, 409);
        if (error instanceof PersonalWorkspaceProjectUnavailableError)
          denied(error.message, 404);
        throw error;
      }
    }
  );
  app.get(
    "/v1/local-edge/projects/:projectId/workspace-project-share-attempt",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const local = await authenticateLocal(request);
      const pending = await repo().pendingShare(local.actor.id, projectId);
      if (!pending) return { attempt: null };
      if (!pending.targetTeamId || !pending.targetWorkspaceId)
        denied("Historical first-share attempt needs explicit recovery", 409);
      const authority = await authenticate(
        request,
        pending.teamBackendId,
        "team_workspace_read"
      );
      if (authority.actor.id !== local.actor.id)
        denied("Personal sharing owner changed", 409);
      const principal = await teamPrincipal(pending.teamBackendId);
      if (
        (await repo().principalBinding(
          local.actor.id,
          pending.teamBackendId
        )) !== principal
      )
        denied("Enrolled Team principal changed", 409);
      const target = targetProofSchema.parse(
        await requestTeam(
          pending.teamBackendId,
          `/v1/teams/${pending.targetTeamId}/workspaces/${pending.targetWorkspaceId}/share-target?shareAttemptKey=${encodeURIComponent(pending.shareAttemptKey)}`
        )
      );
      if (
        target.teamId !== pending.targetTeamId ||
        target.workspaceId !== pending.targetWorkspaceId ||
        target.ownerUserId !== principal ||
        !target.canStart
      )
        denied("Team sharing target changed", 409);
      return { attempt: pending };
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/workspace-project-share-cancel",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      z.object({})
        .strict()
        .parse(request.body ?? {});
      const local = await authenticateLocal(request);
      const attempt = await repo().shareAttempt(local.actor.id, projectId);
      if (!attempt || !["pending", "canceled"].includes(attempt.state))
        denied("No cancelable first-share attempt", 409);
      const pending = attempt!;
      if (!pending.targetTeamId || !pending.targetWorkspaceId)
        denied("Historical first-share attempt needs explicit recovery", 409);
      const teamId = pending.targetTeamId!;
      const workspaceId = pending.targetWorkspaceId!;
      const authority = await authenticate(
        request,
        pending.teamBackendId,
        "team_workspace_write"
      );
      if (authority.actor.id !== local.actor.id)
        denied("Personal sharing owner changed", 409);
      const principal = await teamPrincipal(pending.teamBackendId);
      if (
        (await repo().principalBinding(
          local.actor.id,
          pending.teamBackendId
        )) !== principal
      )
        denied("Enrolled Team principal changed", 409);
      if (pending.state === "pending") {
        const receipt = await cancelTeamAttempt(
          pending.teamBackendId,
          teamId,
          workspaceId,
          pending.shareAttemptKey,
          principal
        );
        if (
          receipt.teamId !== teamId ||
          receipt.workspaceId !== workspaceId ||
          receipt.shareAttemptKey !== pending.shareAttemptKey ||
          receipt.ownerUserId !== principal
        )
          denied("Team cancellation receipt changed", 409);
      }
      return repo().cancelShare(local.actor.id, projectId, {
        teamBackendId: pending.teamBackendId,
        shareAttemptKey: pending.shareAttemptKey,
        targetTeamId: teamId,
        targetWorkspaceId: workspaceId
      });
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/workspace-project-confirm",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = confirmSchema.parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "team_workspace_read"
      );
      const proof = proofSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/workspace-projects/${body.workspaceProjectId}/link-proof`
        )
      );
      const principal = await teamPrincipal(body.teamBackendId);
      if (
        proof.projectId !== body.workspaceProjectId ||
        proof.ownerUserId !== principal
      )
        denied(
          "Team copy does not match the enrolled owner and Personal snapshot",
          409
        );
      const linked = await repo().getLink(authority.actor.id, projectId);
      if (
        linked &&
        linked.ownerUserId === authority.actor.id &&
        linked.teamBackendId === body.teamBackendId &&
        linked.workspaceProjectId === body.workspaceProjectId
      )
        return repo().markMoved(authority.actor.id, projectId, {
          expectedPersonalProjectVersion: body.expectedPersonalProjectVersion,
          expectedManifestHash: proof.copyManifestHash,
          teamBackendId: body.teamBackendId,
          teamId: proof.teamId,
          workspaceId: proof.workspaceId,
          workspaceProjectId: proof.projectId
        });
      const snapshot = await repo().shareSnapshot(
        authority.actor.id,
        projectId
      );
      if (
        snapshot.personalProjectVersion !==
          body.expectedPersonalProjectVersion ||
        proof.copyManifestHash !== workspaceProjectCopyManifestHash(snapshot)
      )
        denied("Personal Project changed before Team confirmation", 409);
      const deckCopyMap = deckCopyMapSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/workspace-projects/${body.workspaceProjectId}/deck-copy-map`
        )
      );
      if (
        deckCopyMap.projectId !== body.workspaceProjectId ||
        deckCopyMap.copyManifestHash !== proof.copyManifestHash
      )
        denied("Team Deck copy changed", 409);
      await repo().bindPrincipal(authority.actor.id, {
        teamBackendId: body.teamBackendId,
        teamPrincipalUserId: principal,
        localCredentialKeyId: authority.local.credentialKeyId,
        teamCredentialKeyId: authority.team.credentialKeyId
      });
      return repo().markMoved(authority.actor.id, projectId, {
        expectedPersonalProjectVersion: body.expectedPersonalProjectVersion,
        expectedManifestHash: proof.copyManifestHash,
        teamBackendId: body.teamBackendId,
        teamId: proof.teamId,
        workspaceId: proof.workspaceId,
        workspaceProjectId: proof.projectId,
        deckCopyMap: deckCopyMap.cards
      });
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/workspace-project-reconcile",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const local = await authenticateLocal(request);
      const link = await repo().getLink(local.actor.id, projectId);
      if (!link) return { projectId, cleared: false, detached: 0 };
      const authority = await authenticate(
        request,
        link.teamBackendId,
        "team_workspace_read"
      );
      const principal = await teamPrincipal(link.teamBackendId);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          link.teamBackendId
        )) !== principal
      )
        denied("Enrolled Team principal changed", 409);
      const state = lifecycleSchema.parse(
        await requestTeam(
          link.teamBackendId,
          `/v1/workspace-projects/${link.workspaceProjectId}/lifecycle`
        )
      );
      if (state.id !== link.workspaceProjectId)
        denied("Team Project lifecycle identity changed", 409);
      if (state.active) return { projectId, cleared: false, detached: 0 };
      return reconcileInactive(
        authority.actor.id,
        principal,
        projectId,
        link.teamBackendId,
        link.workspaceProjectId
      );
    }
  );
  app.post(
    "/v1/local-edge/workspace-projects/:projectId/reconcile",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const { projectId: workspaceProjectId } = idParams.parse(request.params);
      const body = z
        .object({ teamBackendId: z.string().trim().min(1).max(160) })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "team_workspace_read"
      );
      const principal = await teamPrincipal(body.teamBackendId);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== principal
      )
        denied("Enrolled Team principal changed", 409);
      const personalProjectId = await repo().getLinkedPersonalProject(
        authority.actor.id,
        body.teamBackendId,
        workspaceProjectId
      );
      if (!personalProjectId) return { cleared: false, detached: 0 };
      const state = lifecycleSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/workspace-projects/${workspaceProjectId}/lifecycle`
        )
      );
      if (state.id !== workspaceProjectId)
        denied("Team Project lifecycle identity changed", 409);
      if (state.active) return { cleared: false, detached: 0 };
      return reconcileInactive(
        authority.actor.id,
        principal,
        personalProjectId,
        body.teamBackendId,
        workspaceProjectId
      );
    }
  );
  app.post(
    "/v1/local-edge/workspace-project-team-leave-stage",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const body = leaveStageSchema.parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "team_workspace_read"
      );
      const principal = await teamPrincipal(body.teamBackendId);
      const boundPrincipal = await repo().principalBinding(
        authority.actor.id,
        body.teamBackendId
      );
      if (boundPrincipal !== null && boundPrincipal !== principal)
        denied("Enrolled Team principal changed", 409);
      const review = leaveReviewSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/teams/${body.teamId}/workspace-project-leave-review`
        )
      );
      if (
        review.team.id !== body.teamId ||
        review.membership.userId !== principal
      )
        denied("Team leave review belongs to another principal", 409);
      if (review.membership.role === "owner" && review.activeOwnerCount <= 1)
        denied("Last Team owner cannot leave", 409);
      if (review.ownedWorkspaceProjects.length > 0 && boundPrincipal === null)
        denied(
          "Owned Project needs a verified Personal link before Team leave",
          409
        );
      const ownedSetHash = createHash("sha256")
        .update(JSON.stringify(review.ownedWorkspaceProjects))
        .digest("hex");
      const stages: Array<{ workspaceProjectId: string; stageId: string }> = [];
      for (const project of review.ownedWorkspaceProjects) {
        const personalProjectId =
          (await repo().getLinkedPersonalProject(
            authority.actor.id,
            body.teamBackendId,
            project.id
          )) ??
          denied(
            "Owned Project needs a verified Personal link before Team leave",
            409
          );
        const proof = proofSchema.parse(
          await requestTeam(
            body.teamBackendId,
            `/v1/workspace-projects/${project.id}/link-proof`
          )
        );
        if (
          proof.projectId !== project.id ||
          proof.teamId !== body.teamId ||
          proof.ownerUserId !== principal ||
          proof.projectVersion !== project.version
        )
          denied("Owned Project changed during Team leave staging", 409);
        const items: z.infer<typeof workspaceProjectWorkItemSchema>[] = [];
        const itemIds = new Set<string>();
        let offset: number | null = 0;
        let stagedBytes = 0;
        while (offset !== null) {
          const query = new URLSearchParams({
            offset: String(offset),
            expectedProjectVersion: String(project.version)
          });
          const page = z
            .object({
              items: z.array(workspaceProjectWorkItemSchema).max(50),
              nextOffset: z.number().int().nonnegative().nullable(),
              projectVersion: z.number().int().positive()
            })
            .strict()
            .parse(
              await requestTeam(
                body.teamBackendId,
                `/v1/workspace-projects/${project.id}/work-items?${query}`
              )
            );
          if (
            page.projectVersion !== project.version ||
            (page.nextOffset !== null &&
              (page.items.length !== 50 || page.nextOffset !== offset + 50))
          )
            denied("Owned Project changed during Team leave staging", 409);
          for (const item of page.items) {
            if (itemIds.has(item.id))
              denied("Owned Project page contains duplicate Work Items", 409);
            itemIds.add(item.id);
          }
          stagedBytes += Buffer.byteLength(JSON.stringify(page.items), "utf8");
          if (
            items.length + page.items.length > 5_000 ||
            stagedBytes > 7_000_000
          )
            denied("Owned Project copy-back exceeds the staging limit", 413);
          items.push(...page.items);
          offset = page.nextOffset;
        }
        const deckPage = z
          .object({
            projectId: z.uuid(),
            projectVersion: z.number().int().positive(),
            decks: copyBackDecksSchema
          })
          .strict()
          .parse(
            await requestTeam(
              body.teamBackendId,
              `/v1/workspace-projects/${project.id}/copy-back-decks?expectedProjectVersion=${project.version}`
            )
          );
        if (
          deckPage.projectId !== project.id ||
          deckPage.projectVersion !== project.version
        )
          denied("Owned Project Decks changed during Team leave staging", 409);
        stagedBytes += Buffer.byteLength(
          JSON.stringify(deckPage.decks),
          "utf8"
        );
        if (stagedBytes > 7_000_000)
          denied("Owned Project copy-back exceeds the staging limit", 413);
        const staged = await repo().stageOwnedCopyBack(authority.actor.id, {
          personalProjectId,
          teamBackendId: body.teamBackendId,
          teamId: body.teamId,
          workspaceProjectId: project.id,
          ownerTeamMemberId: proof.ownerTeamMemberId,
          reviewedTeamVersion: review.team.version,
          reviewedMemberVersion: review.membership.version,
          reviewedProjectVersion: project.version,
          ownedSetHash,
          workItems: items.map(
            ({
              id,
              sourceOwnerTeamMemberId,
              sourceWorkItemId,
              kind,
              key,
              title,
              goal,
              status,
              dueOn,
              doneAt
            }) => ({
              id,
              sourceOwnerTeamMemberId,
              sourceWorkItemId,
              kind,
              key,
              title,
              goal,
              status,
              dueOn,
              doneAt
            })
          ),
          decks: deckPage.decks
        });
        stages.push({
          workspaceProjectId: project.id,
          stageId: staged.stageId
        });
      }
      return {
        teamId: body.teamId,
        expectedTeamVersion: review.team.version,
        expectedMembershipVersion: review.membership.version,
        expectedOwnedWorkspaceProjects: review.ownedWorkspaceProjects,
        ownedSetHash,
        stages
      };
    }
  );
  app.post(
    "/v1/local-edge/workspace-project-team-leave-finish",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const body = finishStageSchema.parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "team_workspace_read"
      );
      const principal = await teamPrincipal(body.teamBackendId);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== principal
      )
        denied("Enrolled Team principal changed", 409);
      const completed = [];
      for (const stageId of body.stageIds) {
        const stage =
          (await repo().getStagedCopyBack(authority.actor.id, stageId)) ??
          denied("Copy-back stage unavailable", 404);
        if (stage.teamBackendId !== body.teamBackendId)
          denied("Copy-back stage unavailable", 404);
        if (stage.state === "applied") {
          completed.push({ stageId, alreadyApplied: true });
          continue;
        }
        const proof = tombstoneSchema.parse(
          await requestTeam(
            body.teamBackendId,
            `/v1/workspace-projects/${stage.workspaceProjectId}/tombstone-proof`
          )
        );
        if (
          proof.projectId !== stage.workspaceProjectId ||
          proof.teamId !== stage.teamId ||
          proof.ownerUserId !== principal ||
          proof.version <= stage.reviewedProjectVersion
        )
          denied("Team tombstone does not match reviewed leave", 409);
        const workItems = z
          .array(
            workspaceProjectWorkItemSchema.pick({
              id: true,
              sourceOwnerTeamMemberId: true,
              sourceWorkItemId: true,
              kind: true,
              key: true,
              title: true,
              goal: true,
              status: true,
              dueOn: true,
              doneAt: true
            })
          )
          .parse(stage.workItems);
        const decks = copyBackDecksSchema.parse(stage.decks);
        const result = await repo().copyBackOwnedProject(
          authority.actor.id,
          stage.personalProjectId,
          {
            stageId,
            workspaceProjectId: stage.workspaceProjectId,
            ownerTeamMemberId: stage.ownerTeamMemberId,
            workItems,
            decks
          }
        );
        completed.push({ stageId, ...result });
      }
      return { completed };
    }
  );
};
