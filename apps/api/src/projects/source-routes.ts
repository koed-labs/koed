import type { FastifyInstance } from "fastify";
import type { ProjectSourceRepository } from "@koed/db";
import {
  ProjectCapabilityError,
  ProjectConflictError,
  ProjectNotFoundError
} from "@koed/db";
import {
  createProjectSourceSchema,
  projectSourceSchema,
  projectSourcesSchema
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateProjectOperation } from "./desktop-read-auth.js";

const projectParams = z.object({ id: z.uuid() }).strict();
const sourceParams = z.object({ id: z.uuid(), sourceId: z.uuid() }).strict();

export function registerProjectSourceRoutes(
  app: FastifyInstance,
  input: {
    repository: ProjectSourceRepository | null;
    deploymentProfile: string;
    koedHome?: string;
    auth: ApiRouteContext["auth"];
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  }
) {
  const repo = () => {
    if (
      !input.repository ||
      !["developer", "local_personal"].includes(input.deploymentProfile)
    )
      throw Object.assign(new Error("Project Sources are unavailable"), {
        statusCode: 503
      });
    return input.repository;
  };
  const handle = (error: unknown) => {
    if (error instanceof ProjectNotFoundError)
      return { statusCode: 404, message: error.message };
    if (error instanceof ProjectConflictError)
      return { statusCode: 409, message: error.message };
    if (error instanceof ProjectCapabilityError)
      return {
        statusCode:
          error.message.includes("ingestion") || error.message.includes("retry")
            ? 503
            : 409,
        message: error.message
      };
    throw error;
  };
  app.get(
    "/v1/projects/:id/sources",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, false);
      const { id } = projectParams.parse(request.params);
      try {
        return projectSourcesSchema.parse({
          sources: await repo().list(user.id, id)
        });
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.post(
    "/v1/projects/:id/sources",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, true);
      const { id } = projectParams.parse(request.params);
      const parsed = createProjectSourceSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ message: "Invalid Project Source" });
      try {
        return reply
          .code(201)
          .send(
            projectSourceSchema.parse(
              await repo().create(user.id, id, parsed.data)
            )
          );
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.delete(
    "/v1/projects/:id/sources/:sourceId",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, true);
      const { id, sourceId } = sourceParams.parse(request.params);
      try {
        return projectSourceSchema.parse(
          await repo().remove(user.id, id, sourceId)
        );
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.post(
    "/v1/projects/:id/sources/:sourceId/retry",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, true);
      const { id, sourceId } = sourceParams.parse(request.params);
      try {
        return projectSourceSchema.parse(
          await repo().retry(user.id, id, sourceId)
        );
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
}
