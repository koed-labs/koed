import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  MemorySourceRepository,
  SharedMemoryRepository,
  WorkspaceProjectRepository
} from "@koed/db";
import {
  SharedMemoryAuthorizationError,
  WorkspaceProjectConflictError,
  WorkspaceProjectUnavailableError
} from "@koed/db";
import {
  workspaceProjectCopySchema,
  workspaceProjectCopyFitsTransport,
  workspaceProjectCreateSchema,
  workspaceProjectSourceCreateSchema,
  workspaceProjectSourcePatchSchema,
  workspaceProjectWorkItemCreateSchema,
  workspaceProjectHumanWorkItemPatchSchema,
  workspaceProjectDispatchReceiptSchema,
  workspaceProjectDispatchProgressSchema,
  workspaceProjectActivitySeenSchema,
  workspaceProjectActivityPageSchema,
  workspaceProjectRestoreRequestSchema,
  workspaceProjectRestoreResultSchema,
  workspaceProjectLifecycleReviewSchema,
  workspaceProjectRestorableListSchema,
  validateSharedMemoryCanonicalSourceItem,
  SharedMemoryConflictError
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import {
  teamAdminRequestHash,
  teamAdminScopeHash
} from "./action-grant-hash.js";

const projectParams = z.object({ projectId: z.uuid() }).strict();
const itemParams = z.object({ projectId: z.uuid(), itemId: z.uuid() }).strict();
const itemKeyParams = z.object({ projectId: z.uuid(), key: z.uuid() }).strict();
const textActionEffectParams = z
  .object({ projectId: z.uuid(), actionId: z.uuid() })
  .strict();
const memberParams = z
  .object({ projectId: z.uuid(), targetUserId: z.uuid() })
  .strict();
const contributionParams = z
  .object({
    projectId: z.uuid(),
    shareGrantId: z.uuid()
  })
  .strict();
const teamParams = z.object({ teamId: z.uuid() }).strict();
const shareTargetParams = z
  .object({ teamId: z.uuid(), workspaceId: z.uuid() })
  .strict();

export const registerWorkspaceProjectRoutes = (
  app: FastifyInstance,
  input: {
    repository: WorkspaceProjectRepository | null;
    requireRepository(): Pick<
      MemorySourceRepository,
      | "executeActionGrant"
      | "getTeamLeaveReview"
      | "listWorkspaceGrants"
      | "readGrantRepresentation"
    >;
    auth: ApiRouteContext["auth"];
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  }
) => {
  const repository = () => {
    if (!input.repository)
      throw Object.assign(new Error("Workspace Projects are unavailable"), {
        statusCode: 503
      });
    return input.repository;
  };
  const authenticate = (request: FastifyRequest, write: boolean) =>
    input.auth.authenticateSessionOrDeviceCredential(
      request,
      write ? "team_workspace_write" : "team_workspace_read",
      { apiTokenError: "Personal API Tokens cannot access Workspace Projects" }
    );
  const handle = (error: unknown) => {
    if (error instanceof WorkspaceProjectConflictError)
      return {
        statusCode: 409,
        message: error.message,
        current: error.current
      };
    if (error instanceof WorkspaceProjectUnavailableError)
      return { statusCode: 403, message: error.message };
    if (error instanceof SharedMemoryAuthorizationError)
      return { statusCode: 403, message: error.message };
    if (error instanceof SharedMemoryConflictError)
      return { statusCode: 409, message: error.message };
    throw error;
  };
  const actionGrant = async (
    request: FastifyRequest,
    actor: Awaited<ReturnType<typeof input.auth.authenticateDeviceCredential>>,
    action:
      | "workspace_project.leave"
      | "workspace_project.member_remove"
      | "workspace_project.delete"
      | "workspace_project.contribution_remove"
      | "project_source.team_metadata.delete",
    projectId: string,
    body: unknown,
    run: (
      repo: WorkspaceProjectRepository,
      sharedMemory: SharedMemoryRepository
    ) => Promise<unknown>
  ) => {
    if (!actor.credential.operationFamilies.includes("action_grant"))
      throw Object.assign(new Error("Action Grant credential required"), {
        statusCode: 403
      });
    const raw = request.headers["x-koed-action-grant"];
    const token = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!token)
      throw Object.assign(new Error("One-time Action Grant required"), {
        statusCode: 403
      });
    const review = await repository().getLifecycleReview(
      actor.user.id,
      projectId
    );
    if (!review)
      throw new WorkspaceProjectUnavailableError(
        "Current Project authority unavailable"
      );
    const requestPath = new URL(request.url, "http://koed.local").pathname;
    const result = await input.requireRepository().executeActionGrant({
      actionGrant: token,
      ownerUserId: actor.user.id,
      deviceCredentialId: actor.credential.id,
      upstreamBackendId: actor.credential.upstreamBackendId,
      teamId: review.project.teamId,
      operationFamily: "admin",
      action,
      targetId: projectId,
      scopeHash: teamAdminScopeHash({
        action,
        teamId: review.project.teamId,
        targetId: projectId
      }),
      requestHash: teamAdminRequestHash({
        method: "POST",
        path: requestPath,
        body
      }),
      approvedRequest: { method: "POST", path: requestPath, body },
      execute: async ({ workspaceProject, sharedMemory }) => ({
        statusCode: 200,
        body: await run(workspaceProject, sharedMemory)
      })
    });
    if (!result)
      throw Object.assign(new Error("Action Grant is invalid or consumed"), {
        statusCode: 403
      });
    return result.body;
  };

  app.post(
    "/v1/workspace-projects",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const body = workspaceProjectCreateSchema.parse(request.body);
      try {
        return reply.code(201).send(await repository().create(actor.id, body));
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/teams/:teamId/workspaces/:workspaceId/share-target",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { teamId, workspaceId } = shareTargetParams.parse(request.params);
      const { shareAttemptKey } = z
        .object({ shareAttemptKey: z.string().min(8).max(200).optional() })
        .strict()
        .parse(request.query);
      try {
        return await repository().shareTarget(
          actor.id,
          teamId,
          workspaceId,
          shareAttemptKey
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/teams/:teamId/workspaces/:workspaceId/share-attempt-cancellations",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { teamId, workspaceId } = shareTargetParams.parse(request.params);
      const { shareAttemptKey, expectedOwnerUserId } = z
        .object({
          shareAttemptKey: z.string().min(8).max(200),
          expectedOwnerUserId: z.uuid()
        })
        .strict()
        .parse(request.body);
      if (expectedOwnerUserId !== actor.id)
        throw Object.assign(new Error("Enrolled Team principal changed"), {
          statusCode: 403
        });
      try {
        return await repository().cancelShareAttempt(actor.id, {
          teamId,
          workspaceId,
          shareAttemptKey
        });
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/members",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      try {
        return await repository().members(actor.id, projectId);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/restorable",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      try {
        return workspaceProjectRestorableListSchema.parse(
          await repository().listRestorableProjects(actor.id)
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/lifecycle-review",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      const { targetUserId } = z
        .object({ targetUserId: z.uuid().optional() })
        .strict()
        .parse(request.query);
      try {
        const review = await repository().getLifecycleReview(
          actor.id,
          projectId,
          targetUserId
        );
        if (!review)
          throw new WorkspaceProjectUnavailableError(
            "Project lifecycle review unavailable"
          );
        return workspaceProjectLifecycleReviewSchema.parse(review);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/teams/:teamId/workspace-projects",
    { preHandler: input.readRateLimit },
    async (request) => {
      const actor = await authenticate(request, false);
      const { teamId } = teamParams.parse(request.params);
      return repository().list(actor.id, teamId);
    }
  );
  app.get(
    "/v1/teams/:teamId/workspace-project-leave-review",
    { preHandler: input.readRateLimit },
    async (request) => {
      const actor = await authenticate(request, false);
      const { teamId } = teamParams.parse(request.params);
      const review = await input
        .requireRepository()
        .getTeamLeaveReview({ userId: actor.id }, teamId);
      if (!review)
        throw new WorkspaceProjectUnavailableError(
          "Team leave review unavailable"
        );
      return review;
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      try {
        return await repository().get(actor.id, projectId);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/link-proof",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      try {
        return await repository().getOwnerLinkProof(actor.id, projectId);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/member-link-proof",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await input.auth.authenticateDeviceCredential(request);
      if (!actor.credential.operationFamilies.includes("team_workspace_read"))
        throw Object.assign(
          new Error("Team Workspace read credential required"),
          {
            statusCode: 403
          }
        );
      const { projectId } = projectParams.parse(request.params);
      try {
        return await repository().getMemberLinkProof(actor.user.id, projectId);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/tombstone-proof",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      try {
        return await repository().getOwnerTombstoneProof(actor.id, projectId);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/lifecycle",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      try {
        return await repository().lifecycle(actor.id, projectId);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/dispatch-check",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      const body = z
        .object({
          expectedProjectVersion: z.number().int().positive(),
          expectedMemberVersion: z.number().int().positive()
        })
        .strict()
        .parse(request.body);
      try {
        return await repository().assertDispatch(
          actor.id,
          projectId,
          body.expectedProjectVersion,
          body.expectedMemberVersion
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/join",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { projectId } = projectParams.parse(request.params);
      try {
        return await repository().join(actor.id, projectId);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/first-share-copy",
    { preHandler: input.writeRateLimit, bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { projectId } = projectParams.parse(request.params);
      const body = workspaceProjectCopySchema.parse(request.body);
      if (!workspaceProjectCopyFitsTransport(body))
        return reply.code(413).send({
          statusCode: 413,
          message: "Project copy exceeds the transport limit"
        });
      try {
        return await repository().copyFirstShare(actor.id, projectId, body);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/work-items",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      const query = z
        .object({
          offset: z.coerce.number().int().min(0).default(0),
          expectedProjectVersion: z.coerce.number().int().positive().optional()
        })
        .strict()
        .parse(request.query);
      try {
        return await repository().listWorkItems(actor.id, projectId, query);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/activity/seen",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      try {
        return workspaceProjectActivitySeenSchema.parse(
          await repository().activitySeen(actor.id, projectId)
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/activity",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      const query = z
        .object({
          after: z.string().min(1).max(500),
          limit: z.coerce.number().int().min(1).max(100).default(100)
        })
        .strict()
        .parse(request.query);
      try {
        return workspaceProjectActivityPageSchema.parse(
          await repository().activityPage(actor.id, projectId, query)
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.put(
    "/v1/workspace-projects/:projectId/activity/seen",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      const body = z
        .object({
          cursor: z.string().min(1).max(500),
          welcomeDelivered: z.boolean()
        })
        .strict()
        .parse(request.body);
      try {
        return workspaceProjectActivitySeenSchema.parse(
          await repository().acknowledgeActivity(
            actor.id,
            projectId,
            body.cursor,
            body.welcomeDelivered
          )
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/activity/summary",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      try {
        return await repository().activitySummary(actor.id, projectId);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/work-items/:itemId/dispatch-proof",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId, itemId } = itemParams.parse(request.params);
      const query = z
        .object({
          expectedProjectVersion: z.coerce.number().int().positive(),
          expectedMemberVersion: z.coerce.number().int().positive(),
          expectedWorkItemVersion: z.coerce.number().int().positive()
        })
        .strict()
        .parse(request.query);
      try {
        return await repository().dispatchProof(
          actor.id,
          projectId,
          itemId,
          query
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/work-items/:itemId/dispatch-authority",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId, itemId } = itemParams.parse(request.params);
      const { dispatchKey } = z
        .object({ dispatchKey: z.string().min(1).max(240) })
        .strict()
        .parse(request.query);
      try {
        return await repository().dispatchAuthority(
          actor.id,
          projectId,
          itemId,
          dispatchKey
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/work-items/:itemId/dispatch-status",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId, itemId } = itemParams.parse(request.params);
      const { dispatchKey } = z
        .object({ dispatchKey: z.string().min(1).max(240) })
        .strict()
        .parse(request.query);
      try {
        return await repository().dispatchStatus(
          actor.id,
          projectId,
          itemId,
          dispatchKey
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/work-items",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { projectId } = projectParams.parse(request.params);
      const body = workspaceProjectWorkItemCreateSchema.parse(request.body);
      if (
        (body.textActionId || body.textActionNonce) &&
        !request.headers.authorization?.trim().startsWith("Koed-Device ")
      )
        return reply
          .code(403)
          .send({ message: "Team device credential required" });
      try {
        return reply
          .code(201)
          .send(await repository().createWorkItem(actor.id, projectId, body));
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/work-items/text-action-effects/:actionId",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId, actionId } = textActionEffectParams.parse(
        request.params
      );
      try {
        const item = await repository().workItemTextActionEffect(
          actor.id,
          projectId,
          actionId
        );
        if (!item)
          return reply
            .code(404)
            .send({ message: "Text action effect not found" });
        return item;
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/work-items/by-idempotency/:key",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId, key } = itemKeyParams.parse(request.params);
      try {
        const item = await repository().workItemByIdempotencyKey(
          actor.id,
          projectId,
          key
        );
        if (!item)
          return reply.code(404).send({ message: "Work Item not found" });
        return item;
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/work-items/:itemId/proposal-proof",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId, itemId } = itemParams.parse(request.params);
      try {
        return await repository().workItemProposalProof(
          actor.id,
          projectId,
          itemId
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.patch(
    "/v1/workspace-projects/:projectId/work-items/:itemId",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { projectId, itemId } = itemParams.parse(request.params);
      const body = workspaceProjectHumanWorkItemPatchSchema.parse(request.body);
      try {
        return await repository().patchWorkItem(
          actor.id,
          projectId,
          itemId,
          body
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/work-items/:itemId/dispatch-receipt",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { projectId, itemId } = itemParams.parse(request.params);
      const body = workspaceProjectDispatchReceiptSchema.parse(request.body);
      try {
        return await repository().dispatchReceipt(
          actor.id,
          projectId,
          itemId,
          body
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.patch(
    "/v1/workspace-projects/:projectId/work-items/:itemId/dispatch-progress",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { projectId, itemId } = itemParams.parse(request.params);
      const body = workspaceProjectDispatchProgressSchema.parse(request.body);
      try {
        return await repository().dispatchProgress(
          actor.id,
          projectId,
          itemId,
          body
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/sources",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      const query = z
        .object({
          offset: z.coerce.number().int().min(0).default(0),
          expectedProjectVersion: z.coerce.number().int().positive().optional()
        })
        .strict()
        .parse(request.query);
      try {
        return await repository().listSources(actor.id, projectId, query);
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/share-grant-bindings",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { projectId } = projectParams.parse(request.params);
      const body = z
        .object({
          shareGrantId: z.uuid(),
          expectedGrantVersion: z.number().int().positive(),
          workspaceProjectSourceId: z.uuid().optional()
        })
        .strict()
        .parse(request.body);
      try {
        return reply
          .code(201)
          .send(
            await repository().bindShareGrant(
              actor.id,
              projectId,
              body.shareGrantId,
              body.expectedGrantVersion,
              body.workspaceProjectSourceId
            )
          );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/sources",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { projectId } = projectParams.parse(request.params);
      const body = workspaceProjectSourceCreateSchema.parse(request.body);
      try {
        return reply
          .code(201)
          .send(await repository().createSource(actor.id, projectId, body));
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.patch(
    "/v1/workspace-projects/:projectId/sources/:sourceId",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { projectId, sourceId } = z
        .object({ projectId: z.uuid(), sourceId: z.uuid() })
        .strict()
        .parse(request.params);
      const body = workspaceProjectSourcePatchSchema.parse(request.body);
      try {
        return await repository().patchSource(
          actor.id,
          projectId,
          sourceId,
          body
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/sources/:sourceId/delete",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await input.auth.authenticateDeviceCredential(request);
      const { projectId, sourceId } = z
        .object({ projectId: z.uuid(), sourceId: z.uuid() })
        .strict()
        .parse(request.params);
      const body = z
        .object({
          expectedProjectVersion: z.number().int().positive(),
          expectedSourceVersion: z.number().int().positive()
        })
        .strict()
        .parse(request.body);
      try {
        return await actionGrant(
          request,
          actor,
          "project_source.team_metadata.delete",
          projectId,
          body,
          (repo) =>
            repo.deleteSourceMetadata(actor.user.id, projectId, sourceId, body)
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/sources/:sourceId/uploader-proof",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId, sourceId } = z
        .object({ projectId: z.uuid(), sourceId: z.uuid() })
        .strict()
        .parse(request.params);
      try {
        return await repository().getSourceUploaderProof(
          actor.id,
          projectId,
          sourceId
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/contributions/:shareGrantId/remove",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await input.auth.authenticateDeviceCredential(request);
      const { projectId, shareGrantId } = contributionParams.parse(
        request.params
      );
      const body = z
        .object({
          mutationId: z.uuid(),
          expectedProjectVersion: z.number().int().positive(),
          expectedGrantVersion: z.number().int().positive()
        })
        .strict()
        .parse(request.body);
      try {
        return await actionGrant(
          request,
          actor,
          "workspace_project.contribution_remove",
          projectId,
          body,
          async (_projectRepository, sharedMemory) => ({
            grant: await sharedMemory.removeProjectContribution(
              { userId: actor.user.id },
              { projectId, shareGrantId, ...body }
            )
          })
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/contributions",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, false);
      const { projectId } = projectParams.parse(request.params);
      const { offset } = z
        .object({
          offset: z.coerce.number().int().min(0).max(10000).default(0)
        })
        .strict()
        .parse(request.query);
      try {
        const review = await repository().getLifecycleReview(
          actor.id,
          projectId
        );
        if (!review)
          throw new WorkspaceProjectUnavailableError(
            "Current Project authority unavailable"
          );
        const page = await input.requireRepository().listWorkspaceGrants(
          { userId: actor.id },
          {
            teamId: review.project.teamId,
            teamWorkspaceId: review.project.workspaceId,
            limit: 50,
            offset
          }
        );
        const attributions =
          await repository().getProjectContributionAttributions(
            actor.id,
            projectId,
            page.entries.map((entry) => entry.shareGrantId)
          );
        const byGrant = new Map(
          attributions.map((entry) => [entry.shareGrantId, entry])
        );
        const contributions = [];
        for (const entry of page.entries) {
          const attribution = byGrant.get(entry.shareGrantId);
          if (!attribution) continue;
          const preferred: ("lcm_rollups" | "lcm_leaves" | "memory_events")[] =
            entry.activeRepresentation === "lcm_rollups"
              ? ["lcm_rollups", "lcm_leaves"]
              : ["lcm_leaves", "lcm_rollups"];
          if (attribution.sourceKind === "personal_note")
            preferred.push("memory_events");
          let result = null;
          for (const representation of preferred) {
            result = await input
              .requireRepository()
              .readGrantRepresentation(
                { userId: actor.id },
                { shareGrantId: entry.shareGrantId, representation }
              );
            if (result) break;
          }
          if (
            !result ||
            result.grant.teamId !== review.project.teamId ||
            result.grant.teamWorkspaceId !== review.project.workspaceId
          )
            continue;
          const summaries = result.items.flatMap((item) => {
            const validated = validateSharedMemoryCanonicalSourceItem({
              representation: result.representation.representation,
              logicalMemoryId: result.grant.logicalMemoryId,
              sourceRevision: result.representation.sourceRevision,
              item
            });
            const noteContent =
              attribution.sourceKind === "personal_note" &&
              result.representation.representation === "memory_events" &&
              validated.itemType === "user_message" &&
              typeof validated.content.text === "string";
            return ((validated.itemType === "lcm_leaf" ||
              validated.itemType === "lcm_rollup") &&
              typeof validated.content.summaryText === "string") ||
              noteContent
              ? [
                  {
                    text: noteContent
                      ? (validated.content.text as string)
                      : (validated.content.summaryText as string),
                    title: noteContent
                      ? "Note contribution"
                      : typeof validated.content.title === "string"
                        ? validated.content.title
                        : "Project summary",
                    occurredAt: validated.occurredAt ?? result.grant.createdAt
                  }
                ]
              : [];
          });
          if (summaries.length)
            contributions.push({
              shareGrantId: entry.shareGrantId,
              title: summaries[0]!.title,
              contributorDisplayName: attribution.contributorDisplayName,
              groupName: attribution.groupName,
              noLongerInGroup: attribution.noLongerInGroup,
              summaries
            });
        }
        const current = await repository().getLifecycleReview(
          actor.id,
          projectId
        );
        if (!current || current.project.version !== review.project.version)
          throw new WorkspaceProjectUnavailableError(
            "Current Project authority changed"
          );
        return {
          contributions,
          nextOffset: page.hasMore ? offset + page.entries.length : null
        };
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/leave",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await input.auth.authenticateDeviceCredential(request);
      const { projectId } = projectParams.parse(request.params);
      const body = z
        .object({
          expectedProjectVersion: z.number().int().positive(),
          expectedMemberVersion: z.number().int().positive()
        })
        .strict()
        .parse(request.body);
      try {
        return await actionGrant(
          request,
          actor,
          "workspace_project.leave",
          projectId,
          body,
          (repo) => repo.leave(actor.user.id, projectId, body)
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/members/:targetUserId/remove",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await input.auth.authenticateDeviceCredential(request);
      const { projectId, targetUserId } = memberParams.parse(request.params);
      const body = z
        .object({
          expectedProjectVersion: z.number().int().positive(),
          expectedMemberVersion: z.number().int().positive()
        })
        .strict()
        .parse(request.body);
      try {
        return await actionGrant(
          request,
          actor,
          "workspace_project.member_remove",
          projectId,
          body,
          (repo) =>
            repo.removeMember(actor.user.id, projectId, targetUserId, body)
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/delete",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await input.auth.authenticateDeviceCredential(request);
      const { projectId } = projectParams.parse(request.params);
      const body = z
        .object({
          expectedProjectVersion: z.number().int().positive()
        })
        .strict()
        .parse(request.body);
      try {
        return await actionGrant(
          request,
          actor,
          "workspace_project.delete",
          projectId,
          body,
          (repo) =>
            repo.deleteProject(
              actor.user.id,
              projectId,
              body.expectedProjectVersion
            )
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/restore",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticate(request, true);
      const { projectId } = projectParams.parse(request.params);
      const body = workspaceProjectRestoreRequestSchema.parse(request.body);
      try {
        return workspaceProjectRestoreResultSchema.parse(
          await repository().restoreProject(
            actor.id,
            projectId,
            body.expectedProjectVersion
          )
        );
      } catch (error) {
        return reply.code(handle(error).statusCode).send(handle(error));
      }
    }
  );
};
