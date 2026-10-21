import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  MemorySourceRepository,
  WorkspaceProjectRepository
} from "@koed/db";
import {
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
  workspaceProjectDispatchProgressSchema
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import {
  teamAdminRequestHash,
  teamAdminScopeHash
} from "./action-grant-hash.js";

const projectParams = z.object({ projectId: z.uuid() }).strict();
const itemParams = z.object({ projectId: z.uuid(), itemId: z.uuid() }).strict();
const memberParams = z
  .object({ projectId: z.uuid(), targetUserId: z.uuid() })
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
      "executeActionGrant" | "getTeamLeaveReview"
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
    throw error;
  };
  const actionGrant = async (
    request: FastifyRequest,
    actor: Awaited<ReturnType<typeof input.auth.authenticateDeviceCredential>>,
    action:
      | "workspace_project.leave"
      | "workspace_project.member_remove"
      | "workspace_project.delete"
      | "project_source.team_metadata.delete",
    projectId: string,
    body: unknown,
    run: (repo: WorkspaceProjectRepository) => Promise<unknown>
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
      execute: async ({ workspaceProject }) => ({
        statusCode: 200,
        body: await run(workspaceProject)
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
      try {
        return reply
          .code(201)
          .send(await repository().createWorkItem(actor.id, projectId, body));
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
};
