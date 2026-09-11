import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  acceptMemoryAnswerTaskSchema,
  claimMemoryAnswerTaskSchema,
  completeMemoryAnswerTaskSchema,
  failMemoryAnswerTaskSchema,
  heartbeatMemoryAnswerTaskSchema,
  memoryAnswerTaskParamsSchema
} from "./memory-answer-task-schemas.js";

export const registerMemoryAnswerTaskRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticateApiToken },
    rateLimit: { aiClientControl, memoryRead, memoryWrite }
  } = context;

  app.post(
    "/v1/memory/answer-tasks",
    { preHandler: memoryWrite },
    async (request) => {
      const user = await authenticateApiToken(request);
      const input = acceptMemoryAnswerTaskSchema.parse(request.body);
      const task = await requireRepository().acceptMemoryAnswerTask(
        { userId: user.id },
        {
          origin: input.origin,
          invocationKey: input.invocation_key,
          request: input.request,
          maxAttempts: input.max_attempts,
          maxQueued: input.max_queued
        }
      );
      return { task };
    }
  );

  app.get(
    "/v1/memory/answer-tasks/:taskId",
    { preHandler: memoryRead },
    async (request, reply) => {
      const user = await authenticateApiToken(request);
      const { taskId } = memoryAnswerTaskParamsSchema.parse(request.params);
      const task = await requireRepository().getMemoryAnswerTask(
        { userId: user.id },
        taskId
      );
      return task
        ? { task }
        : reply.code(404).send({ error: "Memory Answer task not found" });
    }
  );

  app.post(
    "/v1/memory/answer-tasks/claim",
    { preHandler: aiClientControl },
    async (request) => {
      const user = await authenticateApiToken(request);
      const input = claimMemoryAnswerTaskSchema.parse(request.body);
      return await requireRepository().claimMemoryAnswerTask(
        { userId: user.id },
        { leaseOwner: input.lease_owner, leaseMs: input.lease_ms }
      );
    }
  );

  app.post(
    "/v1/memory/answer-tasks/:taskId/heartbeat",
    { preHandler: aiClientControl },
    async (request, reply) => {
      const user = await authenticateApiToken(request);
      const { taskId } = memoryAnswerTaskParamsSchema.parse(request.params);
      const input = heartbeatMemoryAnswerTaskSchema.parse(request.body);
      const task = await requireRepository().heartbeatMemoryAnswerTask(
        { userId: user.id },
        {
          taskId,
          leaseOwner: input.lease_owner,
          fenceGeneration: input.fence_generation,
          leaseMs: input.lease_ms,
          madeProgress: input.made_progress,
          statusMessage: input.status_message
        }
      );
      return task
        ? { task }
        : reply.code(409).send({ error: "Memory Answer task lease is stale" });
    }
  );

  app.post(
    "/v1/memory/answer-tasks/:taskId/cancel",
    { preHandler: aiClientControl },
    async (request, reply) => {
      const user = await authenticateApiToken(request);
      const { taskId } = memoryAnswerTaskParamsSchema.parse(request.params);
      const task = await requireRepository().cancelMemoryAnswerTask(
        { userId: user.id },
        taskId
      );
      return task
        ? { task }
        : reply.code(404).send({ error: "Memory Answer task not found" });
    }
  );

  app.post(
    "/v1/memory/answer-tasks/:taskId/complete",
    { preHandler: aiClientControl },
    async (request, reply) => {
      const user = await authenticateApiToken(request);
      const { taskId } = memoryAnswerTaskParamsSchema.parse(request.params);
      const input = completeMemoryAnswerTaskSchema.parse(request.body);
      const task = await requireRepository().completeMemoryAnswerTask(
        { userId: user.id },
        {
          taskId,
          leaseOwner: input.lease_owner,
          fenceGeneration: input.fence_generation,
          questionId: input.question_id,
          result: input.result
        }
      );
      return task
        ? { task }
        : reply.code(409).send({ error: "Memory Answer task lease is stale" });
    }
  );

  app.post(
    "/v1/memory/answer-tasks/:taskId/fail",
    { preHandler: aiClientControl },
    async (request, reply) => {
      const user = await authenticateApiToken(request);
      const { taskId } = memoryAnswerTaskParamsSchema.parse(request.params);
      const input = failMemoryAnswerTaskSchema.parse(request.body);
      const task = await requireRepository().failMemoryAnswerTask(
        { userId: user.id },
        {
          taskId,
          leaseOwner: input.lease_owner,
          fenceGeneration: input.fence_generation,
          errorCode: input.error_code,
          errorMessage: input.error_message,
          retry: input.retry,
          retryDelayMs: input.retry_delay_ms
        }
      );
      return task
        ? { task }
        : reply.code(409).send({ error: "Memory Answer task lease is stale" });
    }
  );

  app.delete(
    "/v1/memory/answer-tasks/expired",
    { preHandler: aiClientControl },
    async (request) => {
      const user = await authenticateApiToken(request);
      return {
        deleted: await requireRepository().deleteExpiredMemoryAnswerTasks({
          userId: user.id
        })
      };
    }
  );
};
