import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  claimMemoryQuestionsSchema,
  memoryQuestionParamsSchema,
  memoryQuestionSchema,
  memoryQuestionsQuerySchema,
  updateMemoryQuestionSchema
} from "./questions-schemas.js";

export const registerQuestionRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit: {
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit
    }
  } = context;

  app.get(
    "/v1/memory/questions",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = memoryQuestionsQuerySchema.parse(request.query);
      const questions = await repo.listMemoryQuestions(
        { userId: user.id },
        {
          query: query.query,
          searchDomain: query.search_domain,
          status: query.status,
          workspaceId: query.workspace_id,
          sessionId: query.session_id,
          limit: query.limit,
          offset: query.offset
        }
      );
      return { questions };
    }
  );

  app.post(
    "/v1/memory/questions",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const input = memoryQuestionSchema.parse(request.body);
      const question = await repo.createMemoryQuestion(
        { userId: user.id },
        {
          query: input.query,
          retrievalScope: input.retrieval_scope,
          searchDomain: input.search_domain,
          workspaceId: input.workspace_id,
          projectName: input.project_name,
          projectPath: input.project_path,
          sessionId: input.session_id,
          threadId: input.thread_id,
          threadName: input.thread_name,
          localMemoryWorkerConfig: input.local_memory_worker_config
        }
      );
      return { question };
    }
  );

  app.post(
    "/v1/memory/questions/claim-pending",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const input = claimMemoryQuestionsSchema.parse(request.body);
      const questions = await repo.claimPendingMemoryQuestions(
        { userId: user.id },
        {
          questionId: input.question_id,
          limit: input.limit,
          leaseSeconds: input.lease_seconds
        }
      );
      return { questions };
    }
  );

  app.get(
    "/v1/memory/questions/:questionId",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = memoryQuestionParamsSchema.parse(request.params);
      const question = await repo.getMemoryQuestion(
        { userId: user.id },
        params.questionId
      );
      return question
        ? { question }
        : reply
            .status(404)
            .send({ error: "Question not found or not visible" });
    }
  );

  app.patch(
    "/v1/memory/questions/:questionId",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = memoryQuestionParamsSchema.parse(request.params);
      const input = updateMemoryQuestionSchema.parse(request.body);
      const question = await repo.updateMemoryQuestion(
        { userId: user.id },
        params.questionId,
        input.status === "answered"
          ? {
              status: input.status,
              answerMarkdown: input.answer_markdown,
              attemptCount: input.attempt_count,
              response: input.response,
              evidence: input.evidence,
              citations: input.citations,
              retrieval: input.retrieval,
              localMemoryWorker: input.local_memory_worker
            }
          : input.status === "error"
            ? {
                status: input.status,
                errorMessage: input.error_message,
                attemptCount: input.attempt_count,
                response: input.response,
                retrieval: input.retrieval,
                localMemoryWorker: input.local_memory_worker
              }
            : {
                status: input.status,
                lastErrorMessage: input.last_error_message,
                attemptCount: input.attempt_count,
                response: input.response,
                evidence: input.evidence,
                citations: input.citations,
                retrieval: input.retrieval,
                localMemoryWorker: input.local_memory_worker
              }
      );
      return question
        ? { question }
        : reply
            .status(404)
            .send({ error: "Question not found or not visible" });
    }
  );
};
