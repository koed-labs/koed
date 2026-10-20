import type { FastifyInstance } from "fastify";
import type { WorkItemRepository } from "@koed/db";
import {
  WorkItemConflictError,
  WorkItemCursorError,
  WorkItemTransitionError,
  WorkItemUnavailableError
} from "@koed/db";
import {
  createWorkItemSchema,
  patchWorkItemSchema,
  workItemSchema
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";

const projectParams = z.object({ id: z.uuid() });
const itemParams = z.object({ id: z.uuid() });
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    cursor: z.string().min(1).max(1000).optional()
  })
  .strict();

export function registerWorkItemRoutes(
  app: FastifyInstance,
  input: {
    repository: WorkItemRepository | null;
    auth: ApiRouteContext["auth"];
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  }
) {
  const requireRepository = () => {
    if (!input.repository)
      throw Object.assign(new Error("Work Items are unavailable"), {
        statusCode: 503
      });
    return input.repository;
  };
  const authenticate = (
    request: Parameters<
      typeof input.auth.authenticateSessionOrDeviceCredential
    >[0],
    write: boolean
  ) =>
    input.auth.authenticateSessionOrDeviceCredential(
      request,
      write ? "personal_collaboration_write" : "personal_collaboration_read",
      { apiTokenError: "API Tokens cannot authorize Work Item operations" }
    );
  const handle = (error: unknown) => {
    if (error instanceof WorkItemConflictError)
      return {
        statusCode: 409,
        current: error.current,
        message: error.message
      };
    if (error instanceof WorkItemUnavailableError)
      return { statusCode: 404, message: error.message };
    if (error instanceof WorkItemTransitionError)
      return { statusCode: 409, message: error.message };
    if (error instanceof WorkItemCursorError)
      return { statusCode: 400, message: error.message };
    throw error;
  };
  app.get(
    "/v1/projects/:id/work-items",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, false);
      const { id } = projectParams.parse(request.params);
      const parsed = listQuery.safeParse(request.query);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ message: "Invalid Work Item page query" });
      try {
        return await requireRepository().list(user.id, id, parsed.data);
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.post(
    "/v1/projects/:id/work-items",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const { id } = projectParams.parse(request.params);
      const body = createWorkItemSchema.parse(request.body);
      if (body.origin !== "manual" || body.originRef != null) {
        return reply
          .code(400)
          .send({ message: "Interactive creation requires a manual origin" });
      }
      try {
        return reply
          .code(201)
          .send(
            workItemSchema.parse(
              await requireRepository().create(user.id, id, body)
            )
          );
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.patch(
    "/v1/work-items/:id",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const { id } = itemParams.parse(request.params);
      const body = patchWorkItemSchema.parse(request.body);
      try {
        return workItemSchema.parse(
          await requireRepository().patch(user.id, id, body)
        );
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.delete(
    "/v1/work-items/:id",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const { id } = itemParams.parse(request.params);
      try {
        await requireRepository().deleteTodo(user.id, id);
        return reply.code(204).send();
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
}
