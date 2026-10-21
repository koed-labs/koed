import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  fetchBoundedJson,
  projectSharePolicyReviewSchema,
  projectSharePolicyEnableSchema,
  projectSharePolicyRevokeSchema,
  projectSharePolicyReceiptReadSchema,
  collaborationActionGrantIntentSchema,
  verifyDesktopLocalCredentialAuthorization,
  verifyLocalEdgeClientCredentialAuthorization
} from "@koed/shared";
import {
  PersonalWorkspaceProjectConflictError,
  PersonalWorkspaceProjectUnavailableError,
  workspaceProjectCopyManifestHash,
  type PersonalWorkspaceProjectRepository,
  type PersonalProjectSharePolicyRepository,
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
import type { createLocalSharedMemoryCandidatePreparation } from "./shared-memory-candidate-preparation.js";
import { prepareLocalLcmCandidateRepresentation } from "./shared-memory-candidate-preparation.js";
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
  > | null,
  projectSharePolicyRepository?: PersonalProjectSharePolicyRepository | null,
  candidatePreparation?: ReturnType<
    typeof createLocalSharedMemoryCandidatePreparation
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
    family:
      | "team_workspace_read"
      | "team_workspace_write"
      | "share_grant_management",
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
  const readExplicitRemote = async (
    backendId: string,
    workspaceProjectId: string,
    offer: { mutationId: string; sessionId: string; logicalMemoryId: string }
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
    const result = await fetchBoundedJson(
      context.localEdge.fetch,
      safeUpstreamProxyUrl(
        backend!,
        `/v1/workspace-projects/${encodeURIComponent(workspaceProjectId)}` +
          `/share-policy/explicit-pending/read`
      ),
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: authorization!
        },
        body: JSON.stringify({
          mutationId: offer.mutationId,
          sessionId: offer.sessionId,
          logicalMemoryId: offer.logicalMemoryId
        })
      },
      { timeoutMs: 15_000, maxBytes: 8_000 }
    );
    if (!result.response.ok)
      denied("Exact Team Pending Share read unavailable", 424);
    return z
      .object({
        state: z.enum(["absent", "pending", "activated", "blocked"]),
        pendingShareId: z.uuid().nullable(),
        shareGrantId: z.uuid().nullable(),
        grantVersion: z.number().int().positive().nullable(),
        sourceRevision: z.number().int().positive().nullable(),
        teamId: z.uuid(),
        workspaceId: z.uuid(),
        ownerTeamMemberId: z.uuid()
      })
      .strict()
      .parse(result.payload);
  };
  const fenceExplicitRemote = async (
    backendId: string,
    workspaceProjectId: string,
    offer: { mutationId: string; sessionId: string }
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
    const result = await fetchBoundedJson(
      context.localEdge.fetch,
      safeUpstreamProxyUrl(
        backend!,
        `/v1/workspace-projects/${encodeURIComponent(workspaceProjectId)}` +
          `/share-policy/explicit-pending/fence`
      ),
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: authorization!
        },
        body: JSON.stringify({
          mutationId: offer.mutationId,
          sessionId: offer.sessionId
        })
      },
      { timeoutMs: 15_000, maxBytes: 8_000 }
    );
    if (!result.response.ok)
      denied("Team explicit offer fence unavailable", 424);
    return z
      .object({
        state: z.enum(["fenced", "activated"]),
        shareGrantId: z.uuid().nullable(),
        grantVersion: z.number().int().positive().nullable()
      })
      .strict()
      .parse(result.payload);
  };
  const policyCursorSchema = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,256}$/)
    .optional();
  const decodePolicyCursor = (
    cursor: string | undefined,
    binding: string
  ): string | undefined => {
    if (!cursor) return undefined;
    try {
      const parsed = z
        .object({ binding: z.string(), id: z.uuid() })
        .strict()
        .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (parsed.binding !== binding)
        denied("Project policy cursor scope changed", 409);
      return parsed.id;
    } catch {
      denied("Project policy cursor is invalid", 400);
    }
  };
  const encodePolicyCursor = (binding: string, id: string | null) =>
    id
      ? Buffer.from(JSON.stringify({ binding, id }), "utf8").toString(
          "base64url"
        )
      : null;
  app.get(
    "/v1/local-edge/project-share-policy/active-projects",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const { actor } = await authenticateLocal(request, false);
      if (!projectSharePolicyRepository)
        denied("Project share policy unavailable", 503);
      const query = z
        .object({ cursor: policyCursorSchema })
        .strict()
        .parse(request.query);
      const binding = `owner:${actor.id}`;
      const page = await projectSharePolicyRepository!.listActivePolicyProjects(
        actor.id,
        decodePolicyCursor(query.cursor, binding)
      );
      return {
        ...page,
        nextCursor: page.hasMore
          ? encodePolicyCursor(binding, page.nextCursor)
          : null
      };
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/local-state",
    { preHandler: context.rateLimit.memoryRead, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid()
        })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "share_grant_management",
        false
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      if (!projectSharePolicyRepository)
        denied("Local Project policy custody unavailable", 503);
      const device = z
        .object({ credential: z.object({ id: z.uuid() }).passthrough() })
        .passthrough()
        .parse(
          await requestTeam(
            body.teamBackendId,
            "/v1/local-edge/device-credentials/status"
          )
        );
      return {
        ...(await projectSharePolicyRepository!.localPolicyState({
          ownerUserId: authority.actor.id,
          projectId,
          teamBackendId: body.teamBackendId,
          workspaceProjectId: body.workspaceProjectId
        })),
        currentDeviceCredentialId: device.credential.id
      };
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/manifest",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid()
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
        denied("Exact shared Project link unavailable", 409);
      const principal = await teamPrincipal(body.teamBackendId);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== principal
      )
        denied("Team principal binding changed", 409);
      if (!projectSharePolicyRepository)
        denied("Project share policy unavailable", 503);
      const teamStatus = projectSharePolicyReviewSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/status`
        )
      );
      if (
        teamStatus.projectId !== body.workspaceProjectId ||
        teamStatus.status === "active"
      )
        denied("Team Project policy changed before preparation", 409);
      const device = z
        .object({ credential: z.object({ id: z.uuid() }).passthrough() })
        .passthrough()
        .parse(
          await requestTeam(
            body.teamBackendId,
            "/v1/local-edge/device-credentials/status"
          )
        );
      const signing = await projectSharePolicyRepository!.prepareSigningKey({
        ownerUserId: authority.actor.id,
        projectId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId,
        deviceCredentialId: device.credential.id,
        policyVersion: teamStatus.policyVersion + 1
      });
      const initial = await projectSharePolicyRepository!.buildInitialManifest({
        ownerUserId: authority.actor.id,
        projectId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId
      });
      if (initial.entries.length && !candidatePreparation)
        denied("Local summary preparation unavailable", 503);
      for (const entry of initial.entries) {
        await prepareLocalLcmCandidateRepresentation({
          repository: context.requireRepository(),
          ownerUserId: authority.actor.id,
          sessionId: entry.sessionId,
          representation: "lcm_leaves"
        });
      }
      const candidates = new Map<
        string,
        { logicalMemoryId: string; sourceRevision: number; itemCount: number }
      >();
      for (const entry of initial.entries) {
        const candidate = await candidatePreparation!.loadCandidatePreview({
          localOwnerUserId: authority.actor.id,
          sessionId: entry.sessionId,
          representation: "lcm_leaves",
          mode: "continuous"
        });
        if (!candidate || candidate.itemCount < 1)
          denied(
            "Exact sanitized summary is not ready before Native review",
            409
          );
        candidates.set(entry.sessionId, {
          logicalMemoryId: candidate!.logicalMemoryId,
          sourceRevision: candidate!.sourceRevision,
          itemCount: candidate!.itemCount
        });
      }
      const prepared = await projectSharePolicyRepository!.buildInitialManifest(
        {
          ownerUserId: authority.actor.id,
          projectId,
          teamBackendId: body.teamBackendId,
          workspaceProjectId: body.workspaceProjectId
        }
      );
      if (
        prepared.personalProjectBindingHash !==
          initial.personalProjectBindingHash ||
        prepared.entries.length !== initial.entries.length ||
        prepared.entries.some(
          (entry, index) =>
            entry.sessionId !== initial.entries[index]?.sessionId
        )
      )
        denied(
          "Captured Session set changed during summary preparation; review again",
          409
        );
      for (const entry of prepared.entries) {
        const candidate = candidates.get(entry.sessionId);
        if (
          !candidate ||
          candidate.sourceRevision !== entry.sourceRevision ||
          candidate.logicalMemoryId !== entry.logicalMemoryId ||
          candidate.itemCount < 1
        )
          denied(
            "Exact sanitized summary is not ready; retry preparation before Native review",
            409
          );
      }
      return {
        ...prepared,
        signingPublicKey: signing.signingPublicKey,
        deviceCredentialId: device.credential.id
      };
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/stage-initial",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid(),
          sessionId: z.uuid(),
          expectedPolicyVersion: z.number().int().positive()
        })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "share_grant_management"
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      if (!projectSharePolicyRepository || !candidatePreparation)
        denied("Local policy candidate preparation unavailable", 503);
      const policy = projectSharePolicyReviewSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/status`
        )
      );
      if (
        policy.projectId !== body.workspaceProjectId ||
        policy.status !== "active" ||
        policy.policyVersion !== body.expectedPolicyVersion
      )
        denied("Team Project policy changed", 409);
      const principal = await teamPrincipal(body.teamBackendId);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== principal
      )
        denied("Team principal binding changed", 409);
      const local = await projectSharePolicyRepository!.buildInitialManifest({
        ownerUserId: authority.actor.id,
        projectId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId
      });
      const exact = local.entries.find(
        (entry) => entry.sessionId === body.sessionId
      );
      if (!exact)
        denied(
          "Captured Session is not eligible in the exact Personal Project",
          409
        );
      const candidate = await candidatePreparation!.loadCandidatePreview({
        localOwnerUserId: authority.actor.id,
        sessionId: body.sessionId,
        representation: "lcm_leaves",
        mode: "continuous"
      });
      if (
        !candidate ||
        candidate.source.kind !== "captured_session" ||
        candidate.source.sessionId !== body.sessionId ||
        candidate.logicalMemoryId !== exact!.logicalMemoryId ||
        candidate.sourceRevision !== exact!.sourceRevision ||
        candidate.itemCount < 1 ||
        candidate.items.length !== candidate.itemCount
      )
        denied(
          "Exact sanitized summary candidate is not ready; review the updated source",
          409
        );
      const preparedCandidate = candidate!;
      const fresh = await projectSharePolicyRepository!.buildInitialManifest({
        ownerUserId: authority.actor.id,
        projectId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId
      });
      if (
        fresh.personalProjectBindingHash !== local.personalProjectBindingHash ||
        JSON.stringify(fresh.entries) !== JSON.stringify(local.entries)
      )
        denied("Personal Project source or mapping changed; review again", 409);
      const localIssue = await projectSharePolicyRepository!.reserveLocalIssue({
        ownerUserId: authority.actor.id,
        projectId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId,
        policyVersion: body.expectedPolicyVersion,
        provenance: "initial",
        entry: exact!
      });
      const sourceIdentity =
        candidatePreparation!.resolveCandidateSourceIdentity(
          authority.actor.id
        );
      if (!sourceIdentity)
        denied("Owner source deployment identity unavailable", 424);
      const backend = upstreamBackendById(
        readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
        body.teamBackendId
      );
      if (!backend) denied("Team backend is not enrolled", 424);
      const authorization = context.localEdge.resolveUpstreamAuthorization(
        backend!
      );
      if (!authorization) denied("Team upstream credential unavailable", 424);
      const path = `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/initial-bundles`;
      const stage = await fetchBoundedJson(
        context.localEdge.fetch,
        safeUpstreamProxyUrl(backend!, path),
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: authorization!
          },
          body: JSON.stringify({
            expectedPolicyVersion: body.expectedPolicyVersion,
            personalProjectBindingHash: local.personalProjectBindingHash,
            sessionId: body.sessionId,
            mappingRevision: exact!.mappingRevision,
            candidate: {
              logicalMemoryId: preparedCandidate.logicalMemoryId,
              source: preparedCandidate.source,
              ...sourceIdentity,
              deviceCredentialId: (
                (await requestTeam(
                  body.teamBackendId,
                  "/v1/local-edge/device-credentials/status"
                )) as { credential?: { id?: string } }
              ).credential?.id,
              sourceCapabilities: preparedCandidate.sourceCapabilities,
              activationRepresentation: "lcm_leaves",
              candidateHash: preparedCandidate.candidateHash,
              sourceRevision: preparedCandidate.sourceRevision,
              itemCount: preparedCandidate.itemCount,
              excludedItemCount: preparedCandidate.excludedItemCount,
              manifest: preparedCandidate.manifest,
              byteCount: preparedCandidate.byteCount
            }
          })
        },
        { timeoutMs: 30_000, maxBytes: 64_000 }
      );
      if (!stage.response.ok)
        denied(
          stage.response.status === 409
            ? "Team Project source changed; review again"
            : "Team Project Pending Share could not be staged",
          stage.response.status === 409 ? 409 : 424
        );
      const outcome = z
        .discriminatedUnion("state", [
          z.object({ state: z.literal("staged"), pendingShareId: z.uuid() }),
          z.object({
            state: z.literal("skipped"),
            reason: z.enum(["occupied", "already_issued"])
          })
        ])
        .parse(stage.payload);
      if (outcome.state === "staged")
        await projectSharePolicyRepository!.attachRemotePending({
          ownerUserId: authority.actor.id,
          issueId: localIssue.issueId,
          pendingShareId: outcome.pendingShareId
        });
      return outcome;
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/reconcile-future",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid(),
          expectedPolicyVersion: z.number().int().positive(),
          cursor: policyCursorSchema
        })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "share_grant_management"
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      if (!projectSharePolicyRepository || !candidatePreparation)
        denied("Local policy candidate preparation unavailable", 503);
      const policy = projectSharePolicyReviewSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/status`
        )
      );
      if (
        policy.projectId !== body.workspaceProjectId ||
        policy.status !== "active" ||
        !policy.policyId ||
        policy.policyVersion !== body.expectedPolicyVersion
      )
        denied("Team Project policy changed", 409);
      const teamPrincipalUserId = await teamPrincipal(body.teamBackendId);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== teamPrincipalUserId
      )
        denied("Team principal binding changed", 409);
      const binding =
        `${authority.actor.id}:${projectId}:${body.teamBackendId}:` +
        `${body.workspaceProjectId}:${body.expectedPolicyVersion}`;
      const page = await projectSharePolicyRepository!.listFutureEligible({
        ownerUserId: authority.actor.id,
        projectId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId,
        policyVersion: body.expectedPolicyVersion,
        cursor: decodePolicyCursor(body.cursor, binding)
      });
      const sourceIdentity =
        candidatePreparation!.resolveCandidateSourceIdentity(
          authority.actor.id
        );
      if (!sourceIdentity)
        denied("Owner source deployment identity unavailable", 424);
      const device = z
        .object({ credential: z.object({ id: z.uuid() }).passthrough() })
        .passthrough()
        .parse(
          await requestTeam(
            body.teamBackendId,
            "/v1/local-edge/device-credentials/status"
          )
        );
      const backend = upstreamBackendById(
        readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
        body.teamBackendId
      );
      if (!backend) denied("Team backend is not enrolled", 424);
      const authorization = context.localEdge.resolveUpstreamAuthorization(
        backend!
      );
      if (!authorization) denied("Team upstream credential unavailable", 424);
      const bindingHash =
        await projectSharePolicyRepository!.projectBindingHash({
          ownerUserId: authority.actor.id,
          projectId,
          teamBackendId: body.teamBackendId,
          workspaceProjectId: body.workspaceProjectId
        });
      let staged = 0,
        skipped = 0,
        failed = 0;
      for (const pageEntry of page.entries) {
        try {
          // Closure is local preparation only. It can advance the source
          // revision, so bind the issue to a fresh exact eligible snapshot.
          await prepareLocalLcmCandidateRepresentation({
            repository: context.requireRepository(),
            ownerUserId: authority.actor.id,
            sessionId: pageEntry.sessionId,
            representation: "lcm_leaves"
          });
          const candidate = await candidatePreparation!.loadCandidatePreview({
            localOwnerUserId: authority.actor.id,
            sessionId: pageEntry.sessionId,
            representation: "lcm_leaves",
            mode: "continuous"
          });
          const entry = await projectSharePolicyRepository!.exactFutureEligible(
            {
              ownerUserId: authority.actor.id,
              projectId,
              teamBackendId: body.teamBackendId,
              workspaceProjectId: body.workspaceProjectId,
              policyVersion: body.expectedPolicyVersion,
              sessionId: pageEntry.sessionId
            }
          );
          if (
            !entry ||
            entry.logicalMemoryId !== pageEntry.logicalMemoryId ||
            entry.mappingRevision !== pageEntry.mappingRevision ||
            !candidate ||
            candidate.source.kind !== "captured_session" ||
            candidate.source.sessionId !== entry.sessionId ||
            candidate.logicalMemoryId !== entry.logicalMemoryId ||
            candidate.sourceRevision !== entry.sourceRevision ||
            candidate.itemCount < 1 ||
            candidate.items.length !== candidate.itemCount
          ) {
            failed++;
            continue;
          }
          const localIssue =
            await projectSharePolicyRepository!.reserveLocalIssue({
              ownerUserId: authority.actor.id,
              projectId,
              teamBackendId: body.teamBackendId,
              workspaceProjectId: body.workspaceProjectId,
              policyVersion: body.expectedPolicyVersion,
              provenance: "future",
              entry
            });
          const closureHash = createHash("sha256")
            .update(
              JSON.stringify({
                manifest: candidate.manifest,
                byteCount: candidate.byteCount,
                itemCount: candidate.itemCount,
                excludedItemCount: candidate.excludedItemCount
              })
            )
            .digest("hex");
          const proof = await projectSharePolicyRepository!.signFutureProof({
            ownerUserId: authority.actor.id,
            teamPrincipalUserId,
            projectId,
            teamBackendId: body.teamBackendId,
            workspaceProjectId: body.workspaceProjectId,
            deviceCredentialId: device.credential.id,
            policyId: policy.policyId!,
            ownerTeamMemberId: policy.ownerTeamMemberId,
            policyVersion: body.expectedPolicyVersion,
            personalProjectBindingHash: bindingHash,
            entry,
            candidateHash: candidate.candidateHash,
            closureHash
          });
          const result = await fetchBoundedJson(
            context.localEdge.fetch,
            safeUpstreamProxyUrl(
              backend!,
              `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/future-bundles`
            ),
            {
              method: "POST",
              redirect: "error",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                authorization: authorization!
              },
              body: JSON.stringify({
                expectedPolicyVersion: body.expectedPolicyVersion,
                personalProjectBindingHash: bindingHash,
                sessionId: entry.sessionId,
                mappingRevision: entry.mappingRevision,
                proof,
                candidate: {
                  logicalMemoryId: candidate.logicalMemoryId,
                  source: candidate.source,
                  ...sourceIdentity,
                  deviceCredentialId: device.credential.id,
                  sourceCapabilities: candidate.sourceCapabilities,
                  activationRepresentation: "lcm_leaves",
                  candidateHash: candidate.candidateHash,
                  sourceRevision: candidate.sourceRevision,
                  itemCount: candidate.itemCount,
                  excludedItemCount: candidate.excludedItemCount,
                  manifest: candidate.manifest,
                  byteCount: candidate.byteCount
                }
              })
            },
            { timeoutMs: 30_000, maxBytes: 64_000 }
          );
          if (!result.response.ok) {
            failed++;
            continue;
          }
          const outcome = z
            .discriminatedUnion("state", [
              z.object({
                state: z.literal("staged"),
                pendingShareId: z.uuid()
              }),
              z.object({
                state: z.literal("skipped"),
                reason: z.enum(["occupied", "already_issued"])
              })
            ])
            .parse(result.payload);
          if (outcome.state === "staged") {
            await projectSharePolicyRepository!.attachRemotePending({
              ownerUserId: authority.actor.id,
              issueId: localIssue.issueId,
              pendingShareId: outcome.pendingShareId
            });
            staged++;
          } else skipped++;
        } catch {
          failed++;
        }
      }
      return {
        processed: page.entries.length,
        staged,
        skipped,
        failed,
        hasMore: page.hasMore,
        nextCursor: page.hasMore
          ? encodePolicyCursor(binding, page.nextCursor)
          : null
      };
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/explicit-offers",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid(),
          sessionId: z.uuid(),
          reason: z.enum(["moved_in", "share_again"])
        })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "share_grant_management"
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      if (!projectSharePolicyRepository || !candidatePreparation)
        denied("Exact Conversation offer unavailable", 503);
      const teamPrincipalUserId = await teamPrincipal(body.teamBackendId);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== teamPrincipalUserId
      )
        denied("Team principal binding changed", 409);
      const device = z
        .object({ credential: z.object({ id: z.uuid() }).passthrough() })
        .passthrough()
        .parse(
          await requestTeam(
            body.teamBackendId,
            "/v1/local-edge/device-credentials/status"
          )
        );
      await prepareLocalLcmCandidateRepresentation({
        repository: context.requireRepository(),
        ownerUserId: authority.actor.id,
        sessionId: body.sessionId,
        representation: "lcm_leaves"
      });
      const candidate = await candidatePreparation!.loadCandidatePreview({
        localOwnerUserId: authority.actor.id,
        sessionId: body.sessionId,
        representation: "lcm_leaves",
        mode: "continuous"
      });
      if (
        !candidate ||
        candidate.source.kind !== "captured_session" ||
        candidate.source.sessionId !== body.sessionId ||
        candidate.itemCount < 1
      )
        denied("Exact sanitized Conversation candidate unavailable", 409);
      const target = await projectSharePolicyRepository!.inspectPrivateTarget({
        ownerUserId: authority.actor.id,
        projectId,
        sessionId: body.sessionId
      });
      const offer = await projectSharePolicyRepository!.prepareExplicitOffer({
        ownerUserId: authority.actor.id,
        projectId,
        sessionId: body.sessionId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId,
        teamPrincipalUserId,
        deviceCredentialId: device.credential.id,
        reason: body.reason,
        logicalMemoryId: candidate!.logicalMemoryId,
        mappingRevision: target.mappingRevision,
        sourceRevision: candidate!.sourceRevision,
        candidateHash: candidate!.candidateHash
      });
      return {
        ...offer,
        sessionId: body.sessionId,
        workspaceProjectId: body.workspaceProjectId,
        reason: body.reason,
        mappingRevision: target.mappingRevision,
        sourceRevision: candidate!.sourceRevision,
        source: candidate!.source,
        logicalMemoryId: candidate!.logicalMemoryId,
        sourceCapabilities: candidate!.sourceCapabilities,
        activationRepresentation: "lcm_leaves" as const,
        maximumFidelity: "lcm_leaves" as const,
        mode: "continuous" as const,
        includeCuratedMemory: false,
        candidateHash: candidate!.candidateHash,
        itemCount: candidate!.itemCount,
        excludedItemCount: candidate!.excludedItemCount,
        manifest: candidate!.manifest,
        byteCount: candidate!.byteCount,
        candidateExpiresAt: candidate!.expiresAt
      };
    }
  );
  app.get(
    "/v1/local-edge/projects/:projectId/project-share-policy/explicit-offers/:offerId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const { projectId, offerId } = z
        .object({ projectId: z.uuid(), offerId: z.uuid() })
        .strict()
        .parse(request.params);
      const { teamBackendId } = z
        .object({ teamBackendId: z.string().trim().min(1).max(160) })
        .strict()
        .parse(request.query);
      const authority = await authenticate(
        request,
        teamBackendId,
        "share_grant_management"
      );
      if (!projectSharePolicyRepository || !candidatePreparation)
        denied("Exact Conversation offer unavailable", 503);
      const offer = await projectSharePolicyRepository!.readExplicitOffer({
        ownerUserId: authority.actor.id,
        projectId,
        offerId,
        teamBackendId
      });
      if (offer.state !== "prepared")
        denied(
          "Explicit Conversation offer is no longer available for Native review",
          409
        );
      if (
        (await repo().principalBinding(authority.actor.id, teamBackendId)) !==
        (await teamPrincipal(teamBackendId))
      )
        denied("Team principal binding changed", 409);
      const device = z
        .object({ credential: z.object({ id: z.uuid() }).passthrough() })
        .passthrough()
        .parse(
          await requestTeam(
            teamBackendId,
            "/v1/local-edge/device-credentials/status"
          )
        );
      if (offer.deviceCredentialId !== device.credential.id)
        denied("Native offer device changed", 409);
      const candidate = await candidatePreparation!.loadCandidatePreview({
        localOwnerUserId: authority.actor.id,
        sessionId: offer.sessionId,
        representation: "lcm_leaves",
        mode: "continuous"
      });
      if (
        !candidate ||
        candidate.source.kind !== "captured_session" ||
        candidate.source.sessionId !== offer.sessionId ||
        candidate.logicalMemoryId !== offer.logicalMemoryId ||
        candidate.sourceRevision !== offer.sourceRevision ||
        candidate.candidateHash !== offer.candidateHash
      )
        denied("Exact Conversation offer candidate changed", 409);
      return {
        ...offer,
        source: candidate!.source,
        sourceCapabilities: candidate!.sourceCapabilities,
        activationRepresentation: "lcm_leaves" as const,
        maximumFidelity: "lcm_leaves" as const,
        mode: "continuous" as const,
        includeCuratedMemory: false,
        candidateHash: candidate!.candidateHash,
        itemCount: candidate!.itemCount,
        excludedItemCount: candidate!.excludedItemCount,
        manifest: candidate!.manifest,
        byteCount: candidate!.byteCount,
        candidateExpiresAt: candidate!.expiresAt
      };
    }
  );
  app.get(
    "/v1/local-edge/projects/:projectId/project-share-policy/explicit-offers/:offerId/status",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const { projectId, offerId } = z
        .object({ projectId: z.uuid(), offerId: z.uuid() })
        .strict()
        .parse(request.params);
      const { teamBackendId } = z
        .object({ teamBackendId: z.string().trim().min(1).max(160) })
        .strict()
        .parse(request.query);
      const authority = await authenticate(
        request,
        teamBackendId,
        "share_grant_management",
        false
      );
      if (!projectSharePolicyRepository)
        denied("Exact Conversation offer unavailable", 503);
      const offer = await projectSharePolicyRepository!.readExplicitOffer({
        ownerUserId: authority.actor.id,
        projectId,
        offerId,
        teamBackendId,
        historical: true
      });
      const remote = await readExplicitRemote(
        teamBackendId,
        offer.workspaceProjectId,
        offer
      );
      if (
        remote.sourceRevision !== null &&
        remote.sourceRevision !== offer.sourceRevision
      )
        denied("Team Conversation source differs from reviewed offer", 409);
      if (
        remote.state === "activated" &&
        remote.pendingShareId &&
        remote.shareGrantId &&
        remote.grantVersion
      )
        await projectSharePolicyRepository!.settleExplicitOffer({
          ownerUserId: authority.actor.id,
          projectId,
          offerId,
          teamBackendId,
          workspaceProjectId: offer.workspaceProjectId,
          mutationId: offer.mutationId,
          pendingShareId: remote.pendingShareId,
          shareGrantId: remote.shareGrantId,
          grantVersion: remote.grantVersion,
          teamId: remote.teamId,
          teamWorkspaceId: remote.workspaceId,
          state: "activated"
        });
      else if (remote.state === "blocked")
        await projectSharePolicyRepository!.blockExplicitOffer({
          ownerUserId: authority.actor.id,
          projectId,
          offerId,
          teamBackendId,
          workspaceProjectId: offer.workspaceProjectId,
          mutationId: offer.mutationId
        });
      return {
        offerId,
        state: remote.state,
        pendingShareId: remote.pendingShareId,
        shareGrantId: remote.shareGrantId,
        grantVersion: remote.grantVersion,
        mutationId: offer.mutationId
      };
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/explicit-offers/:offerId/settle",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId, offerId } = z
        .object({ projectId: z.uuid(), offerId: z.uuid() })
        .strict()
        .parse(request.params);
      const { teamBackendId } = z
        .object({ teamBackendId: z.string().trim().min(1).max(160) })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        teamBackendId,
        "share_grant_management"
      );
      if (!projectSharePolicyRepository)
        denied("Exact Conversation offer unavailable", 503);
      const offer = await projectSharePolicyRepository!.readExplicitOffer({
        ownerUserId: authority.actor.id,
        projectId,
        offerId,
        teamBackendId,
        historical: true
      });
      if (
        (await repo().principalBinding(authority.actor.id, teamBackendId)) !==
        (await teamPrincipal(teamBackendId))
      )
        denied("Team principal binding changed", 409);
      const currentDevice = z
        .object({ credential: z.object({ id: z.uuid() }).passthrough() })
        .passthrough()
        .parse(
          await requestTeam(
            teamBackendId,
            "/v1/local-edge/device-credentials/status"
          )
        );
      if (offer.deviceCredentialId !== currentDevice.credential.id)
        denied("Explicit Conversation offer device changed", 409);
      const remote = await readExplicitRemote(
        teamBackendId,
        offer.workspaceProjectId,
        offer
      );
      if (
        remote.sourceRevision !== null &&
        remote.sourceRevision !== offer.sourceRevision
      )
        denied("Team Conversation source differs from reviewed offer", 409);
      if (
        (remote.state !== "pending" && remote.state !== "activated") ||
        !remote.pendingShareId ||
        !remote.shareGrantId ||
        !remote.grantVersion
      )
        return { state: "pending" as const };
      await projectSharePolicyRepository!.settleExplicitOffer({
        ownerUserId: authority.actor.id,
        projectId,
        offerId,
        teamBackendId,
        workspaceProjectId: offer.workspaceProjectId,
        mutationId: offer.mutationId,
        pendingShareId: remote.pendingShareId,
        shareGrantId: remote.shareGrantId,
        grantVersion: remote.grantVersion,
        teamId: remote.teamId,
        teamWorkspaceId: remote.workspaceId,
        state: remote.state === "activated" ? "activated" : "accepted"
      });
      return {
        state: remote.state,
        pendingShareId: remote.pendingShareId,
        shareGrantId: remote.shareGrantId,
        grantVersion: remote.grantVersion
      };
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/explicit-offers/:offerId/fence",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId, offerId } = z
        .object({ projectId: z.uuid(), offerId: z.uuid() })
        .strict()
        .parse(request.params);
      const { teamBackendId } = z
        .object({ teamBackendId: z.string().trim().min(1).max(160) })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        teamBackendId,
        "share_grant_management"
      );
      if (!projectSharePolicyRepository)
        denied("Exact Conversation offer unavailable", 503);
      const offer = await projectSharePolicyRepository!.readExplicitOffer({
        ownerUserId: authority.actor.id,
        projectId,
        offerId,
        teamBackendId,
        historical: true
      });
      const remote = await fenceExplicitRemote(
        teamBackendId,
        offer.workspaceProjectId,
        offer
      );
      if (remote.state === "activated")
        return {
          state: "activation_race" as const,
          shareGrantId: remote.shareGrantId,
          grantVersion: remote.grantVersion
        };
      await projectSharePolicyRepository!.blockExplicitOffer({
        ownerUserId: authority.actor.id,
        projectId,
        offerId,
        teamBackendId,
        workspaceProjectId: offer.workspaceProjectId,
        mutationId: offer.mutationId
      });
      return { state: "fenced" as const };
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/make-private",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid(),
          sessionId: z.uuid()
        })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "share_grant_management"
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      if (!projectSharePolicyRepository)
        denied("Project policy unavailable", 503);
      const target = await projectSharePolicyRepository!.inspectPrivateTarget({
        ownerUserId: authority.actor.id,
        projectId,
        sessionId: body.sessionId
      });
      await projectSharePolicyRepository!.beginPrivate({
        ownerUserId: authority.actor.id,
        projectId,
        sessionId: body.sessionId,
        expectedProjectAssignmentVersion: target.mappingRevision
      });
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== (await teamPrincipal(body.teamBackendId))
      )
        denied("Team principal binding changed", 409);
      let withdrawalTarget: {
        shareGrantId: string;
        grantVersion: number;
      } | null = null;
      const offers = await projectSharePolicyRepository!.listOpenExplicitOffers(
        {
          ownerUserId: authority.actor.id,
          projectId,
          sessionId: body.sessionId,
          teamBackendId: body.teamBackendId,
          workspaceProjectId: body.workspaceProjectId
        }
      );
      for (const offerId of offers) {
        const offer = await projectSharePolicyRepository!.readExplicitOffer({
          ownerUserId: authority.actor.id,
          projectId,
          offerId,
          teamBackendId: body.teamBackendId,
          historical: true
        });
        const fenced = await fenceExplicitRemote(
          body.teamBackendId,
          body.workspaceProjectId,
          offer
        );
        if (fenced.state === "activated") {
          if (!fenced.shareGrantId || !fenced.grantVersion)
            denied(
              "Exact active Conversation withdrawal target unavailable",
              409
            );
          if (
            withdrawalTarget &&
            (withdrawalTarget.shareGrantId !== fenced.shareGrantId ||
              withdrawalTarget.grantVersion !== fenced.grantVersion)
          )
            denied(
              "Multiple active Conversation grants require separate withdrawal",
              409
            );
          withdrawalTarget = {
            shareGrantId: fenced.shareGrantId!,
            grantVersion: fenced.grantVersion!
          };
        } else
          await projectSharePolicyRepository!.blockExplicitOffer({
            ownerUserId: authority.actor.id,
            projectId,
            offerId,
            teamBackendId: body.teamBackendId,
            workspaceProjectId: body.workspaceProjectId,
            mutationId: offer.mutationId
          });
      }
      const policy = projectSharePolicyReviewSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/status`
        )
      );
      if (policy.projectId !== body.workspaceProjectId)
        denied("Team Project policy changed", 409);
      const backend = upstreamBackendById(
        readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
        body.teamBackendId
      );
      if (!backend) denied("Team backend is not enrolled", 424);
      const authorization = context.localEdge.resolveUpstreamAuthorization(
        backend!
      );
      if (!authorization) denied("Team upstream credential unavailable", 424);
      const result = await fetchBoundedJson(
        context.localEdge.fetch,
        safeUpstreamProxyUrl(
          backend!,
          `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/exclusions`
        ),
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: authorization!
          },
          body: JSON.stringify({
            sessionId: body.sessionId,
            expectedPolicyVersion: policy.policyVersion
          })
        },
        { timeoutMs: 15_000, maxBytes: 8_000 }
      );
      if (!result.response.ok)
        denied("Team private exclusion was not acknowledged", 424);
      const ack = z
        .object({
          blocked: z.literal(true),
          withdrawalRequired: z.boolean(),
          withdrawalTarget: z
            .object({
              shareGrantId: z.uuid(),
              grantVersion: z.number().int().positive()
            })
            .strict()
            .nullable()
        })
        .strict()
        .parse(result.payload);
      if (ack.withdrawalRequired && ack.withdrawalTarget) {
        if (
          withdrawalTarget &&
          (withdrawalTarget.shareGrantId !==
            ack.withdrawalTarget.shareGrantId ||
            withdrawalTarget.grantVersion !== ack.withdrawalTarget.grantVersion)
        )
          denied(
            "Multiple active Conversation grants require separate withdrawal",
            409
          );
        withdrawalTarget = ack.withdrawalTarget;
      }
      if (ack.withdrawalRequired && !ack.withdrawalTarget)
        denied("Exact Conversation withdrawal target unavailable", 409);
      if (withdrawalTarget)
        return { state: "withdrawal_required" as const, withdrawalTarget };
      await projectSharePolicyRepository!.markPrivate({
        ownerUserId: authority.actor.id,
        projectId,
        sessionId: body.sessionId,
        expectedProjectAssignmentVersion: target.mappingRevision
      });
      return { state: "private" as const };
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/session-status",
    { preHandler: context.rateLimit.memoryRead, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid(),
          sessionId: z.uuid()
        })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "share_grant_management",
        false
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      if (!projectSharePolicyRepository)
        denied("Project policy unavailable", 503);
      const offers = await projectSharePolicyRepository!.listOpenExplicitOffers(
        {
          ownerUserId: authority.actor.id,
          projectId,
          sessionId: body.sessionId,
          teamBackendId: body.teamBackendId,
          workspaceProjectId: body.workspaceProjectId
        }
      );
      for (const offerId of offers) {
        const offer = await projectSharePolicyRepository!.readExplicitOffer({
          ownerUserId: authority.actor.id,
          projectId,
          offerId,
          teamBackendId: body.teamBackendId,
          historical: true
        });
        const remote = await readExplicitRemote(
          body.teamBackendId,
          body.workspaceProjectId,
          offer
        );
        if (
          remote.state === "activated" &&
          remote.pendingShareId &&
          remote.shareGrantId &&
          remote.grantVersion
        ) {
          if (remote.sourceRevision !== offer.sourceRevision)
            denied("Team Conversation grant differs from exact offer", 409);
          await projectSharePolicyRepository!.settleExplicitOffer({
            ownerUserId: authority.actor.id,
            projectId,
            offerId,
            teamBackendId: body.teamBackendId,
            workspaceProjectId: body.workspaceProjectId,
            mutationId: offer.mutationId,
            pendingShareId: remote.pendingShareId,
            shareGrantId: remote.shareGrantId,
            grantVersion: remote.grantVersion,
            teamId: remote.teamId,
            teamWorkspaceId: remote.workspaceId,
            state: "activated"
          });
        } else if (remote.state === "blocked")
          await projectSharePolicyRepository!.blockExplicitOffer({
            ownerUserId: authority.actor.id,
            projectId,
            offerId,
            teamBackendId: body.teamBackendId,
            workspaceProjectId: body.workspaceProjectId,
            mutationId: offer.mutationId
          });
      }
      return projectSharePolicyRepository!.sessionStatus({
        ownerUserId: authority.actor.id,
        projectId,
        sessionId: body.sessionId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId
      });
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/reconcile-issues",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid(),
          sessionId: z.uuid().optional(),
          cursor: policyCursorSchema
        })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "share_grant_management"
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== (await teamPrincipal(body.teamBackendId))
      )
        denied("Team principal binding changed", 409);
      if (!projectSharePolicyRepository)
        denied("Project policy issue custody unavailable", 503);
      const cursorBinding = `issues:${authority.actor.id}:${projectId}:${body.teamBackendId}:${body.workspaceProjectId}:${body.sessionId ?? "all"}`;
      const page = await projectSharePolicyRepository!.listUnsettledIssues({
        ownerUserId: authority.actor.id,
        projectId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId,
        sessionId: body.sessionId,
        cursor: decodePolicyCursor(body.cursor, cursorBinding)
      });
      let activated = 0;
      let pending = 0;
      for (const issue of page.issues) {
        if (
          issue.teamBackendId !== body.teamBackendId ||
          issue.workspaceProjectId !== body.workspaceProjectId
        )
          denied("Owner-local policy issue scope changed", 409);
        const remote = z
          .object({
            state: z.enum([
              "absent",
              "staged",
              "activated",
              "issued_terminal",
              "blocked"
            ]),
            policyVersion: z.number().int().positive().nullable(),
            sessionId: z.uuid(),
            logicalMemoryId: z.uuid().nullable(),
            sourceRevision: z.number().int().positive().nullable(),
            mappingRevision: z.number().int().positive().nullable(),
            pendingShareId: z.uuid().nullable(),
            shareGrantId: z.uuid().nullable(),
            grantVersion: z.number().int().positive().nullable(),
            grantLifecycle: z.string().nullable(),
            teamId: z.uuid(),
            workspaceId: z.uuid(),
            ownerTeamMemberId: z.uuid()
          })
          .strict()
          .parse(
            await requestTeam(
              body.teamBackendId,
              `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}` +
                `/share-policy/issues/${encodeURIComponent(issue.sessionId)}/status` +
                `?policyVersion=${issue.policyVersion}`
            )
          );
        if (
          remote.state !== "activated" &&
          remote.state !== "issued_terminal"
        ) {
          pending++;
          continue;
        }
        if (
          remote.sessionId !== issue.sessionId ||
          remote.logicalMemoryId !== issue.logicalMemoryId ||
          remote.policyVersion !== issue.policyVersion ||
          remote.sourceRevision !== issue.sourceRevision ||
          remote.mappingRevision !== issue.mappingRevision ||
          (issue.remotePendingShareId !== null &&
            remote.pendingShareId !== issue.remotePendingShareId) ||
          !remote.logicalMemoryId ||
          !remote.pendingShareId ||
          !remote.shareGrantId ||
          !remote.grantVersion
        )
          denied(
            "Team policy issue activation differs from local reservation",
            409
          );
        const exact = {
          ownerUserId: authority.actor.id,
          projectId,
          issueId: issue.issueId,
          sessionId: issue.sessionId,
          teamBackendId: body.teamBackendId,
          workspaceProjectId: body.workspaceProjectId,
          policyVersion: issue.policyVersion,
          mappingRevision: issue.mappingRevision,
          sourceRevision: issue.sourceRevision,
          remotePendingShareId: remote.pendingShareId!,
          logicalMemoryId: remote.logicalMemoryId!,
          teamId: remote.teamId,
          teamWorkspaceId: remote.workspaceId,
          shareGrantId: remote.shareGrantId!,
          grantVersion: remote.grantVersion!
        };
        if (remote.state === "issued_terminal")
          await projectSharePolicyRepository!.reconcileTerminalIssue({
            ...exact,
            grantLifecycle: remote.grantLifecycle ?? ""
          });
        else await projectSharePolicyRepository!.reconcileActivatedIssue(exact);
        activated++;
      }
      return {
        processed: page.issues.length,
        activated,
        pending,
        hasMore: page.hasMore,
        nextCursor: page.hasMore
          ? encodePolicyCursor(cursorBinding, page.nextCursor)
          : null
      };
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/fence-unpublished",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid(),
          sessionId: z.uuid()
        })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "share_grant_management"
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== (await teamPrincipal(body.teamBackendId))
      )
        denied("Team principal binding changed", 409);
      if (!projectSharePolicyRepository)
        denied("Project policy issue custody unavailable", 503);
      const moveFence = await projectSharePolicyRepository!.beginMoveFence({
        ownerUserId: authority.actor.id,
        projectId,
        sessionId: body.sessionId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId
      });
      const page = await projectSharePolicyRepository!.listUnsettledIssues({
        ownerUserId: authority.actor.id,
        projectId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId,
        sessionId: body.sessionId
      });
      if (page.hasMore)
        denied("Conversation has more policy issues requiring review", 409);
      const offers = await projectSharePolicyRepository!.listOpenExplicitOffers(
        {
          ownerUserId: authority.actor.id,
          projectId,
          sessionId: body.sessionId,
          teamBackendId: body.teamBackendId,
          workspaceProjectId: body.workspaceProjectId
        }
      );
      for (const offerId of offers) {
        const offer = await projectSharePolicyRepository!.readExplicitOffer({
          ownerUserId: authority.actor.id,
          projectId,
          offerId,
          teamBackendId: body.teamBackendId,
          historical: true
        });
        const fenced = await fenceExplicitRemote(
          body.teamBackendId,
          body.workspaceProjectId,
          offer
        );
        if (fenced.state === "activated") {
          const remote = await readExplicitRemote(
            body.teamBackendId,
            body.workspaceProjectId,
            offer
          );
          if (
            remote.state !== "activated" ||
            remote.sourceRevision !== offer.sourceRevision ||
            !remote.pendingShareId ||
            !remote.shareGrantId ||
            !remote.grantVersion ||
            remote.shareGrantId !== fenced.shareGrantId ||
            remote.grantVersion !== fenced.grantVersion
          )
            denied("Exact manual grant activation needs reconciliation", 409);
          const alreadyBound =
            await projectSharePolicyRepository!.hasExactGrantBinding({
              ownerUserId: authority.actor.id,
              projectId,
              sessionId: body.sessionId,
              teamBackendId: body.teamBackendId,
              workspaceProjectId: body.workspaceProjectId,
              shareGrantId: remote.shareGrantId!,
              grantVersion: remote.grantVersion!
            });
          await projectSharePolicyRepository!.settleExplicitOffer({
            ownerUserId: authority.actor.id,
            projectId,
            offerId,
            teamBackendId: body.teamBackendId,
            workspaceProjectId: body.workspaceProjectId,
            mutationId: offer.mutationId,
            pendingShareId: remote.pendingShareId!,
            shareGrantId: remote.shareGrantId!,
            grantVersion: remote.grantVersion!,
            teamId: remote.teamId,
            teamWorkspaceId: remote.workspaceId,
            state: "activated"
          });
          if (!alreadyBound) return { state: "activation_race" as const };
          continue;
        }
        await projectSharePolicyRepository!.blockExplicitOffer({
          ownerUserId: authority.actor.id,
          projectId,
          offerId,
          teamBackendId: body.teamBackendId,
          workspaceProjectId: body.workspaceProjectId,
          mutationId: offer.mutationId
        });
      }
      const policy = projectSharePolicyReviewSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/status`
        )
      );
      if (policy.projectId !== body.workspaceProjectId)
        denied("Team Project policy issue cannot be fenced", 409);
      const backend = upstreamBackendById(
        readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
        body.teamBackendId
      );
      if (!backend) denied("Team backend is not enrolled", 424);
      const authorization = context.localEdge.resolveUpstreamAuthorization(
        backend!
      );
      if (!authorization) denied("Team upstream credential unavailable", 424);
      const result = await fetchBoundedJson(
        context.localEdge.fetch,
        safeUpstreamProxyUrl(
          backend!,
          `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/exclusions`
        ),
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: authorization!
          },
          body: JSON.stringify({
            sessionId: body.sessionId,
            expectedPolicyVersion: policy.policyVersion
          })
        },
        { timeoutMs: 15_000, maxBytes: 8_000 }
      );
      if (!result.response.ok)
        denied("Team policy issue fence was not acknowledged", 424);
      const ack = z
        .object({
          blocked: z.literal(true),
          withdrawalRequired: z.boolean(),
          withdrawalTarget: z
            .object({
              shareGrantId: z.uuid(),
              grantVersion: z.number().int().positive()
            })
            .strict()
            .nullable()
        })
        .strict()
        .parse(result.payload);
      if (ack.withdrawalRequired) {
        if (
          !ack.withdrawalTarget ||
          !(await projectSharePolicyRepository!.hasExactGrantBinding({
            ownerUserId: authority.actor.id,
            projectId,
            sessionId: body.sessionId,
            teamBackendId: body.teamBackendId,
            workspaceProjectId: body.workspaceProjectId,
            shareGrantId: ack.withdrawalTarget.shareGrantId,
            grantVersion: ack.withdrawalTarget.grantVersion
          }))
        )
          return { state: "activation_race" as const };
      }
      for (const issue of page.issues) {
        if (
          issue.teamBackendId !== body.teamBackendId ||
          issue.workspaceProjectId !== body.workspaceProjectId
        )
          denied("Owner-local policy issue scope changed", 409);
        await projectSharePolicyRepository!.freezeUnpublishedIssue({
          ownerUserId: authority.actor.id,
          projectId,
          issueId: issue.issueId,
          sessionId: issue.sessionId,
          teamBackendId: body.teamBackendId,
          workspaceProjectId: body.workspaceProjectId,
          mappingRevision: issue.mappingRevision
        });
      }
      await projectSharePolicyRepository!.acknowledgeMoveFence({
        ownerUserId: authority.actor.id,
        projectId,
        sessionId: body.sessionId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId,
        fenceId: moveFence.fenceId,
        mappingRevision: moveFence.mappingRevision
      });
      return {
        state: page.issues.length ? ("frozen" as const) : ("settled" as const),
        fenceId: moveFence.fenceId
      };
    }
  );
  app.get(
    "/v1/local-edge/projects/:projectId/project-share-policy/fence-unpublished/current",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const query = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid(),
          sessionId: z.uuid()
        })
        .strict()
        .parse(request.query);
      const authority = await authenticate(
        request,
        query.teamBackendId,
        "share_grant_management",
        false
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== query.teamBackendId ||
        link.workspaceProjectId !== query.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      if (!projectSharePolicyRepository)
        denied("Project policy move fence custody unavailable", 503);
      return projectSharePolicyRepository!.currentMoveFence({
        ownerUserId: authority.actor.id,
        projectId,
        sessionId: query.sessionId,
        teamBackendId: query.teamBackendId,
        workspaceProjectId: query.workspaceProjectId
      });
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/fence-unpublished/release",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid(),
          sessionId: z.uuid(),
          fenceId: z.uuid()
        })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "share_grant_management"
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      if (!projectSharePolicyRepository)
        denied("Project policy move fence custody unavailable", 503);
      await projectSharePolicyRepository!.releaseMoveFence({
        ownerUserId: authority.actor.id,
        projectId,
        sessionId: body.sessionId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId,
        fenceId: body.fenceId
      });
      return { state: "released" as const };
    }
  );
  const policyConsumeBody = z
    .object({
      teamBackendId: z.string().trim().min(1).max(160),
      workspaceProjectId: z.uuid(),
      actionGrant: z.object({ id: z.uuid() }).strict(),
      intent: collaborationActionGrantIntentSchema,
      payload: z.union([
        projectSharePolicyEnableSchema,
        projectSharePolicyRevokeSchema
      ])
    })
    .strict();
  const policyAttemptStartBody = policyConsumeBody.extend({
    clientRequestId: z.uuid()
  });
  const policyPayloadHash = (
    payload: z.infer<typeof policyConsumeBody>["payload"]
  ) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/attempts/start",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 64 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = policyAttemptStartBody.parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "share_grant_management"
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      const principal = await teamPrincipal(body.teamBackendId);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== principal
      )
        denied("Team principal binding changed", 409);
      const intent = body.intent;
      if (
        intent.intent !== "collaboration.project_share_policy_enable" &&
        intent.intent !== "collaboration.project_share_policy_revoke"
      )
        denied("Exact Project policy Action Grant intent required", 403);
      const policyIntent = intent as Extract<
        typeof intent,
        {
          intent:
            | "collaboration.project_share_policy_enable"
            | "collaboration.project_share_policy_revoke";
        }
      >;
      const action =
        policyIntent.intent === "collaboration.project_share_policy_enable"
          ? "enable"
          : "revoke";
      if (
        policyIntent.commandRequestId !== body.clientRequestId ||
        policyIntent.projectId !== body.workspaceProjectId ||
        body.payload.authority.referenceId !== body.actionGrant.id ||
        policyIntent.expectedPolicyVersion !==
          body.payload.expectedPolicyVersion ||
        (action === "enable" &&
          (!("manifestId" in policyIntent) ||
            !("manifestId" in body.payload) ||
            policyIntent.manifestId !== body.payload.manifestId ||
            policyIntent.manifestHash !== body.payload.manifestHash)) ||
        (action === "revoke" && "manifestId" in body.payload)
      )
        denied("Exact Project policy action attempt changed", 409);
      const device = z
        .object({ credential: z.object({ id: z.uuid() }).passthrough() })
        .passthrough()
        .parse(
          await requestTeam(
            body.teamBackendId,
            "/v1/local-edge/device-credentials/status"
          )
        );
      if (!projectSharePolicyRepository)
        denied("Project policy custody unavailable", 503);
      const result = await projectSharePolicyRepository!.beginAttempt({
        ownerUserId: authority.actor.id,
        projectId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId,
        action,
        clientRequestId: body.clientRequestId,
        actionGrantId: body.actionGrant.id,
        teamId: policyIntent.teamId,
        teamPrincipalUserId: principal,
        deviceCredentialId: device.credential.id,
        expectedPolicyVersion: body.payload.expectedPolicyVersion,
        payloadHash: policyPayloadHash(body.payload),
        ...(action === "enable" && "manifestId" in body.payload
          ? {
              manifestId: body.payload.manifestId,
              manifestHash: body.payload.manifestHash,
              entries: body.payload.currentEntries
            }
          : {})
      });
      return { attemptId: result.attemptId, state: "pending" as const };
    }
  );
  app.get(
    "/v1/local-edge/projects/:projectId/project-share-policy/attempts/pending",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const { actor } = await authenticateLocal(request, false);
      if (!projectSharePolicyRepository)
        denied("Project policy custody unavailable", 503);
      const link = await repo().getLink(actor.id, projectId);
      if (!link) return { attempts: [] };
      const authority = await authenticate(
        request,
        link.teamBackendId,
        "share_grant_management",
        false
      );
      if (authority.actor.id !== actor.id)
        denied("Project policy owner changed", 409);
      const principal = await teamPrincipal(link.teamBackendId);
      if (
        (await repo().principalBinding(actor.id, link.teamBackendId)) !==
        principal
      )
        denied("Team principal binding changed", 409);
      const status = projectSharePolicyReviewSchema.parse(
        await requestTeam(
          link.teamBackendId,
          `/v1/workspace-projects/${encodeURIComponent(link.workspaceProjectId)}/share-policy/status`
        )
      );
      const device = z
        .object({ credential: z.object({ id: z.uuid() }).passthrough() })
        .passthrough()
        .parse(
          await requestTeam(
            link.teamBackendId,
            "/v1/local-edge/device-credentials/status"
          )
        );
      return {
        attempts: await projectSharePolicyRepository!.pendingAttempts({
          ownerUserId: actor.id,
          projectId,
          currentScope: {
            teamBackendId: link.teamBackendId,
            workspaceProjectId: link.workspaceProjectId,
            teamId: status.teamId,
            teamPrincipalUserId: principal,
            deviceCredentialId: device.credential.id
          }
        })
      };
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/consume",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 64 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = policyConsumeBody.parse(request.body);
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
        denied("Exact shared Project link unavailable", 409);
      const policy = projectSharePolicyReviewSchema.parse(
        await requestTeam(
          body.teamBackendId,
          `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/status`
        )
      );
      const enabling =
        body.intent.intent === "collaboration.project_share_policy_enable";
      const revoking =
        body.intent.intent === "collaboration.project_share_policy_revoke";
      if (!enabling && !revoking)
        denied("Project policy Action Grant intent required", 403);
      const intent = body.intent as Extract<
        typeof body.intent,
        {
          intent:
            | "collaboration.project_share_policy_enable"
            | "collaboration.project_share_policy_revoke";
        }
      >;
      if (
        policy.projectId !== body.workspaceProjectId ||
        policy.teamId !== intent.teamId ||
        intent.projectId !== body.workspaceProjectId ||
        intent.expectedPolicyVersion !== body.payload.expectedPolicyVersion ||
        body.payload.authority.referenceId !== body.actionGrant.id ||
        (enabling &&
          (!("manifestId" in body.payload) ||
            !("manifestId" in intent) ||
            intent.manifestId !== body.payload.manifestId ||
            intent.manifestHash !== body.payload.manifestHash)) ||
        (revoking && "manifestId" in body.payload)
      )
        denied("Project policy grant intent does not match exact effect", 409);
      if (!projectSharePolicyRepository)
        denied("Project policy attempt custody unavailable", 503);
      const pendingAttempts =
        await projectSharePolicyRepository!.pendingAttempts({
          ownerUserId: authority.actor.id,
          projectId
        });
      const attempt = pendingAttempts.find(
        (row) =>
          row.clientRequestId === intent.commandRequestId &&
          row.actionGrantId === body.actionGrant.id &&
          row.teamBackendId === body.teamBackendId &&
          row.workspaceProjectId === body.workspaceProjectId &&
          row.teamId === intent.teamId &&
          row.action === (enabling ? "enable" : "revoke") &&
          row.expectedPolicyVersion === body.payload.expectedPolicyVersion &&
          row.payloadHash === policyPayloadHash(body.payload) &&
          (enabling
            ? row.manifestId ===
                (body.payload as z.infer<typeof projectSharePolicyEnableSchema>)
                  .manifestId &&
              row.manifestHash ===
                (body.payload as z.infer<typeof projectSharePolicyEnableSchema>)
                  .manifestHash
            : !row.manifestId && !row.manifestHash)
      );
      if (!attempt)
        denied(
          "Exact Project policy action attempt was not durably prepared",
          409
        );
      const backend = upstreamBackendById(
        readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
        body.teamBackendId
      );
      if (!backend) denied("Team backend is not enrolled", 424);
      const authorization = context.localEdge.resolveUpstreamAuthorization(
        backend!
      );
      if (!authorization) denied("Team upstream credential unavailable", 424);
      const deviceStatus = await requestTeam(
        body.teamBackendId,
        "/v1/local-edge/device-credentials/status"
      );
      const remote = z
        .object({
          user: z.object({ id: z.uuid() }).passthrough(),
          credential: z.object({ id: z.uuid() }).passthrough()
        })
        .passthrough()
        .parse(deviceStatus);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== remote.user.id
      )
        denied("Team principal binding changed", 409);
      if (
        attempt!.teamPrincipalUserId !== remote.user.id ||
        attempt!.deviceCredentialId !== remote.credential.id
      )
        denied("Project policy attempt device or principal changed", 409);
      await projectSharePolicyRepository!.assertAttemptCurrent({
        ownerUserId: authority.actor.id,
        projectId,
        attemptId: attempt!.attemptId,
        teamBackendId: body.teamBackendId,
        workspaceProjectId: body.workspaceProjectId,
        teamId: intent.teamId,
        teamPrincipalUserId: remote.user.id,
        deviceCredentialId: remote.credential.id
      });
      const secret =
        await context.collaboration.actionGrantControl?.resolveSecret({
          reference: body.actionGrant,
          intent: body.intent,
          context: {
            backend: backend!,
            localOwnerUserId: authority.actor.id,
            principalUserId: remote.user.id,
            upstreamDeviceCredentialId: remote.credential.id,
            upstreamDeviceAuthorization: authorization!,
            operationFamilies: new Set(["share_grant_management"])
          }
        });
      if (!secret)
        denied("Approved Project policy Action Grant unavailable", 403);
      const path = `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/${enabling ? "enable" : "revoke"}`;
      const result = await fetchBoundedJson(
        context.localEdge.fetch,
        safeUpstreamProxyUrl(backend!, path),
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: authorization!,
            "x-koed-action-grant": secret!
          },
          body: JSON.stringify(body.payload)
        },
        { timeoutMs: 30_000, maxBytes: 64_000 }
      );
      if (!result.response.ok)
        denied(
          result.response.status === 409
            ? "Project policy changed before approval consumption"
            : "Team Project policy could not be updated",
          result.response.status === 409 ? 409 : 424
        );
      return result.payload;
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/execution-receipts/read",
    { preHandler: context.rateLimit.memoryRead, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const body = z
        .object({
          teamBackendId: z.string().trim().min(1).max(160),
          workspaceProjectId: z.uuid(),
          receipt: projectSharePolicyReceiptReadSchema
        })
        .strict()
        .parse(request.body);
      const authority = await authenticate(
        request,
        body.teamBackendId,
        "share_grant_management",
        false
      );
      const link = await repo().getLink(authority.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== body.teamBackendId ||
        link.workspaceProjectId !== body.workspaceProjectId
      )
        denied("Exact shared Project link unavailable", 409);
      if (
        (await repo().principalBinding(
          authority.actor.id,
          body.teamBackendId
        )) !== (await teamPrincipal(body.teamBackendId))
      )
        denied("Team principal binding changed", 409);
      const backend = upstreamBackendById(
        readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
        body.teamBackendId
      );
      if (!backend) denied("Team backend is not enrolled", 424);
      const authorization = context.localEdge.resolveUpstreamAuthorization(
        backend!
      );
      if (!authorization) denied("Team upstream credential unavailable", 424);
      const result = await fetchBoundedJson(
        context.localEdge.fetch,
        safeUpstreamProxyUrl(
          backend!,
          `/v1/workspace-projects/${encodeURIComponent(body.workspaceProjectId)}/share-policy/execution-receipts/read`
        ),
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: authorization!
          },
          body: JSON.stringify(body.receipt)
        },
        { timeoutMs: 15_000, maxBytes: 64_000 }
      );
      if (!result.response.ok)
        denied("Exact Project policy execution receipt unavailable", 424);
      return z
        .object({
          executed: z.boolean(),
          receipt: z
            .object({
              statusCode: z.number().int(),
              body: z.unknown()
            })
            .strict()
            .nullable(),
          terminalState: z.enum(["denied", "revoked", "expired"]).nullable(),
          serverTime: z.string().datetime({ offset: true })
        })
        .strict()
        .parse(result.payload);
    }
  );
  app.post(
    "/v1/local-edge/projects/:projectId/project-share-policy/attempts/finalize",
    { preHandler: context.rateLimit.memoryWrite, bodyLimit: 8 * 1024 },
    async (request) => {
      const { projectId } = idParams.parse(request.params);
      const { attemptId } = z
        .object({ attemptId: z.uuid() })
        .strict()
        .parse(request.body);
      const local = await authenticateLocal(request, true);
      if (!projectSharePolicyRepository)
        denied("Project policy custody unavailable", 503);
      const attempts = await projectSharePolicyRepository!.pendingAttempts({
        ownerUserId: local.actor.id,
        projectId
      });
      const attempt = attempts.find((row) => row.attemptId === attemptId);
      if (!attempt)
        denied("Exact pending Project policy attempt unavailable", 409);
      const authority = await authenticate(
        request,
        attempt!.teamBackendId,
        "share_grant_management"
      );
      if (authority.actor.id !== local.actor.id)
        denied("Project policy owner changed", 409);
      const link = await repo().getLink(local.actor.id, projectId);
      if (
        !link ||
        link.teamBackendId !== attempt!.teamBackendId ||
        link.workspaceProjectId !== attempt!.workspaceProjectId
      )
        denied("Exact shared Project link changed", 409);
      if (
        (await repo().principalBinding(
          local.actor.id,
          attempt!.teamBackendId
        )) !== attempt!.teamPrincipalUserId ||
        (await teamPrincipal(attempt!.teamBackendId)) !==
          attempt!.teamPrincipalUserId
      )
        denied("Team principal binding changed", 409);
      const device = z
        .object({ credential: z.object({ id: z.uuid() }).passthrough() })
        .passthrough()
        .parse(
          await requestTeam(
            attempt!.teamBackendId,
            "/v1/local-edge/device-credentials/status"
          )
        );
      if (device.credential.id !== attempt!.deviceCredentialId)
        denied("Team device credential changed", 409);
      await projectSharePolicyRepository!.assertAttemptCurrent({
        ownerUserId: local.actor.id,
        projectId,
        attemptId,
        teamBackendId: attempt!.teamBackendId,
        workspaceProjectId: attempt!.workspaceProjectId,
        teamId: attempt!.teamId,
        teamPrincipalUserId: attempt!.teamPrincipalUserId,
        deviceCredentialId: attempt!.deviceCredentialId
      });
      const backend = upstreamBackendById(
        readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
        attempt!.teamBackendId
      );
      if (!backend) denied("Team backend is not enrolled", 424);
      const authorization = context.localEdge.resolveUpstreamAuthorization(
        backend!
      );
      if (!authorization) denied("Team upstream credential unavailable", 424);
      const result = await fetchBoundedJson(
        context.localEdge.fetch,
        safeUpstreamProxyUrl(
          backend!,
          `/v1/workspace-projects/${encodeURIComponent(attempt!.workspaceProjectId)}/share-policy/execution-receipts/read`
        ),
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: authorization!
          },
          body: JSON.stringify({
            action: attempt!.action,
            clientRequestId: attempt!.clientRequestId,
            actionGrantId: attempt!.actionGrantId,
            teamId: attempt!.teamId,
            expectedPolicyVersion: attempt!.expectedPolicyVersion,
            ...(attempt!.action === "enable"
              ? {
                  manifestId: attempt!.manifestId,
                  manifestHash: attempt!.manifestHash
                }
              : {})
          })
        },
        { timeoutMs: 15_000, maxBytes: 64_000 }
      );
      if (!result.response.ok)
        denied("Exact Project policy execution receipt unavailable", 424);
      const receipt = z
        .object({
          executed: z.boolean(),
          receipt: z
            .object({
              statusCode: z.number().int(),
              body: z
                .object({
                  policyId: z.uuid(),
                  version: z.number().int().positive()
                })
                .passthrough()
            })
            .strict()
            .nullable(),
          terminalState: z.enum(["denied", "revoked", "expired"]).nullable(),
          serverTime: z.string().datetime({ offset: true })
        })
        .strict()
        .parse(result.payload);
      if (!receipt.executed || !receipt.receipt) {
        if (receipt.terminalState) {
          await projectSharePolicyRepository!.terminalAttempt({
            ownerUserId: local.actor.id,
            projectId,
            attemptId
          });
          return { state: "terminal" as const, reason: receipt.terminalState };
        }
        return { state: "unknown" as const };
      }
      if (
        receipt.receipt.statusCode !== 200 ||
        receipt.receipt.body.version !== attempt!.expectedPolicyVersion + 1
      )
        denied("Project policy receipt did not confirm exact effect", 409);
      await projectSharePolicyRepository!.finalizeAttempt({
        ownerUserId: local.actor.id,
        projectId,
        attemptId,
        action: attempt!.action,
        expectedPolicyVersion: attempt!.expectedPolicyVersion,
        deviceCredentialId: attempt!.deviceCredentialId,
        teamBackendId: attempt!.teamBackendId,
        workspaceProjectId: attempt!.workspaceProjectId
      });
      return {
        state: "finalized" as const,
        action: attempt!.action,
        version: receipt.receipt.body.version
      };
    }
  );
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
