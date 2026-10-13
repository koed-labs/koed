import type { FastifyInstance } from "fastify";
import type { MemorySourceRepository } from "@koed/db";
import type { MemoryAnswerTaskExecutionAuthority } from "@koed/shared";
import { memoryAnswerInputSchema } from "@koed/mcp-server/runtime-contracts";
import { finalMemoryQuestionSchema } from "./questions-schemas.js";
import {
  issueMemoryAnswerAuthorizationBoundary,
  memoryAnswerAuthorizationBoundarySecret
} from "./memory-answer-authorization-boundary.js";
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
    auth: { authenticateMemoryAnswerTask },
    rateLimit: { aiClientControl, memoryRead, memoryWrite }
  } = context;
  type TaskActor = Parameters<MemorySourceRepository["getMemoryAnswerTask"]>[0];
  type TeamAuthority = NonNullable<
    Awaited<
      ReturnType<MemorySourceRepository["getMemoryAnswerTaskTeamAuthority"]>
    >
  >;
  const executionAuthority = (
    actor: TaskActor,
    authority?: TeamAuthority | null
  ): MemoryAnswerTaskExecutionAuthority =>
    authority
      ? {
          scope: "team",
          teamWorkspaceId: authority.recallBoundary.teamWorkspaceId,
          authorizationBoundary: issueMemoryAnswerAuthorizationBoundary({
            secret: memoryAnswerAuthorizationBoundarySecret(
              context.config.apiTokenPepper
            ),
            subjectUserId: actor.userId,
            boundary: authority.recallBoundary
          })
        }
      : { scope: "personal" };
  const actorFor = (auth: {
    user: { id: string };
    allowTeam: boolean;
    allowPersonal: boolean;
  }): TaskActor => ({
    userId: auth.user.id,
    allowTeam:
      context.config.teamCollaborationEnabled !== false && auth.allowTeam,
    allowPersonal: auth.allowPersonal
  });

  app.post(
    "/v1/memory/answer-tasks",
    { preHandler: memoryWrite },
    async (request) => {
      const input = acceptMemoryAnswerTaskSchema.parse(request.body);
      const toolInput = memoryAnswerInputSchema.parse(input.request.input);
      const actor = actorFor(
        await authenticateMemoryAnswerTask(
          request,
          "read",
          Boolean(toolInput.team_workspace_id)
        )
      );
      const task = await requireRepository().acceptMemoryAnswerTask(actor, {
        origin: input.origin,
        invocationKey: input.invocation_key,
        request: { ...input.request, input: toolInput },
        teamWorkspaceId: toolInput.team_workspace_id,
        maxAttempts: input.max_attempts,
        maxQueued: input.max_queued
      });
      return { task };
    }
  );

  app.get(
    "/v1/memory/answer-tasks/:taskId",
    { preHandler: memoryRead },
    async (request, reply) => {
      const actor = actorFor(
        await authenticateMemoryAnswerTask(request, "read")
      );
      const { taskId } = memoryAnswerTaskParamsSchema.parse(request.params);
      const task = await requireRepository().getMemoryAnswerTask(actor, taskId);
      return task
        ? { task }
        : reply.code(404).send({ error: "Memory Answer task not found" });
    }
  );

  app.post(
    "/v1/memory/answer-tasks/claim",
    { preHandler: aiClientControl },
    async (request) => {
      const input = claimMemoryAnswerTaskSchema.parse(request.body);
      const actor = actorFor(
        await authenticateMemoryAnswerTask(
          request,
          "execution",
          input.scope_filter === "team"
        )
      );
      const batch = await requireRepository().claimMemoryAnswerTask(actor, {
        leaseOwner: input.lease_owner,
        leaseMs: input.lease_ms,
        allowTeam: input.scope_filter === "team" && actor.allowTeam,
        scopeFilter: input.scope_filter ?? "personal"
      });
      if (batch.task?.teamWorkspaceId && !batch.teamAuthority)
        throw Object.assign(new Error("Team task authority is unavailable"), {
          statusCode: 403
        });
      return {
        task: batch.task
          ? {
              ...batch.task,
              executionAuthority: executionAuthority(actor, batch.teamAuthority)
            }
          : null,
        reconciled: batch.reconciled
      };
    }
  );

  app.post(
    "/v1/memory/answer-tasks/:taskId/heartbeat",
    { preHandler: aiClientControl },
    async (request, reply) => {
      const actor = actorFor(
        await authenticateMemoryAnswerTask(request, "execution")
      );
      const { taskId } = memoryAnswerTaskParamsSchema.parse(request.params);
      const input = heartbeatMemoryAnswerTaskSchema.parse(request.body);
      const task = await requireRepository().heartbeatMemoryAnswerTask(actor, {
        taskId,
        leaseOwner: input.lease_owner,
        fenceGeneration: input.fence_generation,
        leaseMs: input.lease_ms,
        madeProgress: input.made_progress,
        statusMessage: input.status_message
      });
      if (!task)
        return reply
          .code(409)
          .send({ error: "Memory Answer task lease is stale" });
      const authority = task.teamWorkspaceId
        ? await requireRepository().getMemoryAnswerTaskTeamAuthority(
            actor,
            taskId
          )
        : null;
      if (task.teamWorkspaceId && !authority)
        throw Object.assign(new Error("Team task authority is unavailable"), {
          statusCode: 403
        });
      return { task, executionAuthority: executionAuthority(actor, authority) };
    }
  );

  app.post(
    "/v1/memory/answer-tasks/:taskId/cancel",
    { preHandler: aiClientControl },
    async (request, reply) => {
      const actor = actorFor(
        await authenticateMemoryAnswerTask(request, "read")
      );
      const { taskId } = memoryAnswerTaskParamsSchema.parse(request.params);
      const task = await requireRepository().cancelMemoryAnswerTask(
        actor,
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
      const actor = actorFor(
        await authenticateMemoryAnswerTask(request, "execution")
      );
      const { taskId } = memoryAnswerTaskParamsSchema.parse(request.params);
      const input = completeMemoryAnswerTaskSchema.parse(request.body);
      const question = finalMemoryQuestionSchema.parse(input.final_question);
      const commonQuestion = {
        idempotencyKey: question.idempotency_key,
        query: question.query,
        origin: question.origin,
        retrievalScope: question.retrieval_scope,
        teamWorkspaceId: question.team_workspace_id,
        searchDomain: question.search_domain,
        projectId: question.project_id,
        projectName: question.project_name,
        projectPath: question.project_path,
        sessionId: question.session_id,
        threadId: question.thread_id,
        threadName: question.thread_name,
        attemptCount: question.attempt_count,
        response: question.response,
        retrieval: question.retrieval,
        localMemoryWorker: question.local_memory_worker
      };
      const finalQuestion =
        question.status === "answered"
          ? {
              ...commonQuestion,
              status: "answered" as const,
              answerMarkdown: question.answer_markdown,
              evidence: question.evidence,
              citations: question.citations
            }
          : {
              ...commonQuestion,
              status: "error" as const,
              errorMessage: question.error_message
            };
      const task = await requireRepository().completeMemoryAnswerTask(actor, {
        taskId,
        leaseOwner: input.lease_owner,
        fenceGeneration: input.fence_generation,
        finalQuestion,
        result: input.result
      });
      return task
        ? { task }
        : reply.code(409).send({ error: "Memory Answer task lease is stale" });
    }
  );

  app.post(
    "/v1/memory/answer-tasks/:taskId/fail",
    { preHandler: aiClientControl },
    async (request, reply) => {
      const actor = actorFor(
        await authenticateMemoryAnswerTask(request, "execution")
      );
      const { taskId } = memoryAnswerTaskParamsSchema.parse(request.params);
      const input = failMemoryAnswerTaskSchema.parse(request.body);
      const task = await requireRepository().failMemoryAnswerTask(actor, {
        taskId,
        leaseOwner: input.lease_owner,
        fenceGeneration: input.fence_generation,
        errorCode: input.error_code,
        errorMessage: input.error_message,
        retry: input.retry,
        retryDelayMs: input.retry_delay_ms
      });
      return task
        ? { task }
        : reply.code(409).send({ error: "Memory Answer task lease is stale" });
    }
  );

  app.delete(
    "/v1/memory/answer-tasks/expired",
    { preHandler: aiClientControl },
    async (request) => {
      const actor = actorFor(
        await authenticateMemoryAnswerTask(request, "execution")
      );
      return {
        deleted: await requireRepository().deleteExpiredMemoryAnswerTasks(actor)
      };
    }
  );
};
