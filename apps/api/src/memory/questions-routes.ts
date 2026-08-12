import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  finalMemoryQuestionSchema,
  memoryQuestionParamsSchema,
  memoryQuestionsQuerySchema
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
          projectId: query.project_id,
          sessionId: query.session_id,
          limit: query.limit,
          offset: query.offset
        }
      );
      return { questions };
    }
  );

  app.post(
    "/v1/memory/questions/final",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const input = finalMemoryQuestionSchema.parse(request.body);
      const question = await repo.createFinalMemoryQuestion(
        { userId: user.id },
        input.status === "answered"
          ? {
              idempotencyKey: input.idempotency_key,
              status: input.status,
              query: input.query,
              origin: input.origin,
              retrievalScope: input.retrieval_scope,
              searchDomain: input.search_domain,
              projectId: input.project_id,
              projectName: input.project_name,
              projectPath: input.project_path,
              sessionId: input.session_id,
              threadId: input.thread_id,
              threadName: input.thread_name,
              attemptCount: input.attempt_count,
              answerMarkdown: input.answer_markdown,
              response: input.response,
              evidence: input.evidence,
              citations: input.citations,
              retrieval: input.retrieval,
              localMemoryWorker: input.local_memory_worker
            }
          : {
              idempotencyKey: input.idempotency_key,
              status: input.status,
              query: input.query,
              origin: input.origin,
              retrievalScope: input.retrieval_scope,
              searchDomain: input.search_domain,
              projectId: input.project_id,
              projectName: input.project_name,
              projectPath: input.project_path,
              sessionId: input.session_id,
              threadId: input.thread_id,
              threadName: input.thread_name,
              attemptCount: input.attempt_count,
              errorMessage: input.error_message,
              response: input.response,
              retrieval: input.retrieval,
              localMemoryWorker: input.local_memory_worker
            }
      );
      return { question };
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
};
