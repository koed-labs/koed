import type { FastifyInstance } from "fastify";
import {
  PersonalWorkspaceProjectUnavailableError,
  type PersonalWorkspaceProjectRepository
} from "@koed/db";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateProjectOperation } from "./desktop-read-auth.js";

const paramsSchema = z.object({ projectId: z.uuid() }).strict();

// This owner-local read is intentionally separate from Team authority. Link,
// copy-back and invalidation mutations live behind the dual-credential local
// edge coordinator, which fetches current Team proof itself.
export const registerWorkspaceProjectLinkRoutes = (
  app: FastifyInstance,
  input: {
    repository: PersonalWorkspaceProjectRepository | null;
    auth: ApiRouteContext["auth"];
    deploymentProfile: string;
    koedHome: string;
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
  }
) => {
  app.get(
    "/v1/projects/:projectId/workspace-project-share-snapshot",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const actor = await authenticateProjectOperation(request, input, false);
      const { projectId } = paramsSchema.parse(request.params);
      if (!input.repository)
        return reply
          .code(503)
          .send({ message: "Personal Project state unavailable" });
      try {
        return await input.repository.shareSnapshot(actor.id, projectId);
      } catch (error) {
        if (error instanceof PersonalWorkspaceProjectUnavailableError)
          return reply.code(404).send({ message: error.message });
        throw error;
      }
    }
  );
  app.get(
    "/v1/projects/:projectId/workspace-project-link",
    { preHandler: input.readRateLimit },
    async (request) => {
      const actor = await authenticateProjectOperation(request, input, false);
      const { projectId } = paramsSchema.parse(request.params);
      if (!input.repository)
        throw Object.assign(new Error("Personal Project state unavailable"), {
          statusCode: 503
        });
      const link = await input.repository.getLink(actor.id, projectId);
      if (!link)
        throw Object.assign(new Error("Personal Project link unavailable"), {
          statusCode: 404
        });
      return link;
    }
  );
  app.get(
    "/v1/projects/:projectId/workspace-project-source-metadata/:sourceId",
    { preHandler: input.readRateLimit },
    async (request) => {
      const actor = await authenticateProjectOperation(request, input, false);
      const { projectId, sourceId } = z
        .object({ projectId: z.uuid(), sourceId: z.uuid() })
        .strict()
        .parse(request.params);
      const query = z
        .object({
          workspaceProjectId: z.uuid(),
          teamBackendId: z.string().min(1)
        })
        .strict()
        .parse(request.query);
      if (!input.repository)
        throw Object.assign(new Error("Personal Project state unavailable"), {
          statusCode: 503
        });
      const link = await input.repository.getLink(actor.id, projectId);
      if (
        !link ||
        link.workspaceProjectId !== query.workspaceProjectId ||
        link.teamBackendId !== query.teamBackendId
      )
        throw Object.assign(new Error("Personal Project link unavailable"), {
          statusCode: 404
        });
      const snapshot = await input.repository.shareSnapshot(
        actor.id,
        projectId
      );
      const source = snapshot.sources.find((item) => item.id === sourceId);
      if (!source)
        throw Object.assign(new Error("Personal Source unavailable"), {
          statusCode: 404
        });
      return source;
    }
  );
  app.get(
    "/v1/local-edge/workspace-projects/:workspaceProjectId/source-metadata/:sourceId",
    { preHandler: input.readRateLimit },
    async (request) => {
      const actor = await authenticateProjectOperation(request, input, false);
      const { workspaceProjectId, sourceId } = z
        .object({ workspaceProjectId: z.uuid(), sourceId: z.uuid() })
        .strict()
        .parse(request.params);
      const { teamBackendId } = z
        .object({ teamBackendId: z.string().min(1) })
        .strict()
        .parse(request.query);
      if (!input.repository)
        throw Object.assign(new Error("Personal Project state unavailable"), {
          statusCode: 503
        });
      const projectId = await input.repository.getLinkedPersonalProject(
        actor.id,
        teamBackendId,
        workspaceProjectId
      );
      if (!projectId)
        throw Object.assign(new Error("Personal Project link unavailable"), {
          statusCode: 404
        });
      const snapshot = await input.repository.shareSnapshot(
        actor.id,
        projectId
      );
      const source = snapshot.sources.find((item) => item.id === sourceId);
      if (!source)
        throw Object.assign(new Error("Personal Source unavailable"), {
          statusCode: 404
        });
      return source;
    }
  );
  app.get(
    "/v1/local-edge/workspace-projects/:workspaceProjectId/source-metadata",
    { preHandler: input.readRateLimit },
    async (request) => {
      const actor = await authenticateProjectOperation(request, input, false);
      const { workspaceProjectId } = z
        .object({ workspaceProjectId: z.uuid() })
        .strict()
        .parse(request.params);
      const { teamBackendId } = z
        .object({ teamBackendId: z.string().min(1) })
        .strict()
        .parse(request.query);
      if (!input.repository)
        throw Object.assign(new Error("Personal Project state unavailable"), {
          statusCode: 503
        });
      const projectId = await input.repository.getLinkedPersonalProject(
        actor.id,
        teamBackendId,
        workspaceProjectId
      );
      if (!projectId)
        throw Object.assign(new Error("Personal Project link unavailable"), {
          statusCode: 404
        });
      const snapshot = await input.repository.shareSnapshot(
        actor.id,
        projectId
      );
      return snapshot.sources;
    }
  );
};
