import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  fetchBoundedJson,
  verifyDesktopLocalCredentialAuthorization,
  verifyLocalEdgeClientCredentialAuthorization
} from "@koed/shared";
import {
  workspaceProjectCopyManifestHash,
  type PersonalWorkspaceProjectRepository,
  type ProjectSourceRepository
} from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { workspaceProjectWorkItemSchema } from "@koed/shared/workspace-project-contract";
import {
  projectSourceUploadSchema,
  projectSourceSchema,
  projectSourceReadSchema
} from "@koed/shared";
import { createHash } from "node:crypto";
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
    shareAttemptKey: z.string().trim().min(8).max(200)
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
  requestSourceIngestion?: () => void
) => {
  const repo = () =>
    repository ?? denied("Personal Workspace Project state unavailable", 503);
  const authenticateLocal = async (request: FastifyRequest) => {
    if (!request.headers.authorization?.trim().startsWith("Koed-Desktop "))
      denied("Desktop local credential required");
    const actor = await authenticateProjectOperation(
      request,
      {
        auth: context.auth,
        deploymentProfile: context.config.deploymentProfile,
        koedHome: context.config.koedHome
      },
      true
    );
    const local = verifyDesktopLocalCredentialAuthorization(
      context.config.koedHome,
      request.headers.authorization,
      { ownerUserId: actor.id, operationFamily: "personal_collaboration_write" }
    );
    if (!local) denied("Enrolled local credential required");
    return { actor, local: local! };
  };
  const authenticate = async (
    request: FastifyRequest,
    backendId: string,
    family: "team_workspace_read" | "team_workspace_write"
  ) => {
    const { actor, local } = await authenticateLocal(request);
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
    const result = await repo().copyBackOwnedProject(
      ownerUserId,
      personalProjectId,
      {
        stageId: stage.id,
        workspaceProjectId,
        ownerTeamMemberId: stage.ownerTeamMemberId,
        workItems
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
      await repo().bindPrincipal(authority.actor.id, {
        teamBackendId: body.teamBackendId,
        teamPrincipalUserId: principal,
        localCredentialKeyId: authority.local.credentialKeyId,
        teamCredentialKeyId: authority.team.credentialKeyId
      });
      return repo().beginShare(authority.actor.id, projectId, body);
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
        workspaceId: proof.workspaceId,
        workspaceProjectId: proof.projectId
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
          )
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
        const result = await repo().copyBackOwnedProject(
          authority.actor.id,
          stage.personalProjectId,
          {
            stageId,
            workspaceProjectId: stage.workspaceProjectId,
            ownerTeamMemberId: stage.ownerTeamMemberId,
            workItems
          }
        );
        completed.push({ stageId, ...result });
      }
      return { completed };
    }
  );
};
