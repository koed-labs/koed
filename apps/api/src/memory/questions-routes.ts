import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  desktopAskCompleteSchema,
  desktopAskCreateSchema,
  desktopAskThreadCursorSchema,
  desktopAskThreadParamsSchema,
  desktopAskThreadsQuerySchema,
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
    auth: {
      authenticate,
      authenticateApiToken,
      authenticateSessionOrDeviceCredential
    },
    rateLimit: {
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit
    }
  } = context;

  const decodeAskCursor = (value: string | undefined) => {
    if (!value) return undefined;
    try {
      return desktopAskThreadCursorSchema.parse(
        JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
      );
    } catch {
      throw Object.assign(new Error("Invalid Desktop Ask cursor"), {
        statusCode: 400
      });
    }
  };

  const encodeAskCursor = (value: object | null): string | null =>
    value
      ? Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
      : null;

  app.get(
    "/v1/memory/ask/threads",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = desktopAskThreadsQuerySchema.parse(request.query);
      const page = await repo.listDesktopAskThreads(
        { userId: user.id },
        { cursor: decodeAskCursor(input.cursor), limit: input.limit }
      );
      return {
        threads: page.threads,
        next_cursor: encodeAskCursor(page.nextCursor)
      };
    }
  );

  app.get(
    "/v1/memory/ask/threads/:askThreadId",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = desktopAskThreadParamsSchema.parse(request.params);
      const questions = await repo.getDesktopAskThread(
        { userId: user.id },
        params.askThreadId
      );
      if (questions.length === 0) {
        return reply.code(404).send({ error: "Ask thread not found" });
      }
      return { questions };
    }
  );

  app.post(
    "/v1/memory/ask/questions",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = desktopAskCreateSchema.parse(request.body);
      const question = await repo.createPendingDesktopAsk(
        { userId: user.id },
        {
          askThreadId: input.ask_thread_id,
          idempotencyKey: input.idempotency_key,
          query: input.query
        }
      );
      return { question };
    }
  );

  app.post(
    "/v1/memory/ask/questions/recover-pending",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      return repo.recoverPendingDesktopAsks(
        { userId: user.id },
        {
          errorMessage:
            "This Ask was interrupted when the Local AI Runtime stopped. Try again."
        }
      );
    }
  );

  app.patch(
    "/v1/memory/ask/questions/:questionId",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = memoryQuestionParamsSchema.parse(request.params);
      const input = desktopAskCompleteSchema.parse(request.body);
      const question = await repo.completePendingDesktopAsk(
        { userId: user.id },
        input.status === "answered"
          ? {
              answerMarkdown: input.answer_markdown,
              attemptCount: input.attempt_count,
              citations: input.citations,
              evidence: input.evidence,
              localMemoryWorker: input.local_memory_worker,
              questionId: params.questionId,
              response: input.response,
              retrieval: input.retrieval,
              status: input.status
            }
          : {
              attemptCount: input.attempt_count,
              errorMessage: input.error_message,
              localMemoryWorker: input.local_memory_worker,
              questionId: params.questionId,
              response: input.response,
              retrieval: input.retrieval,
              status: input.status
            }
      );
      return { question };
    }
  );

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
      const input = finalMemoryQuestionSchema.parse(request.body);
      const user = input.team_workspace_id
        ? await authenticateSessionOrDeviceCredential(
            request,
            "team_workspace_read",
            {
              apiTokenError:
                "Session cookie or scoped device credential required for Team Workspace question history"
            }
          )
        : await authenticateApiToken(request);
      const question = await repo.createFinalMemoryQuestion(
        { userId: user.id },
        input.status === "answered"
          ? {
              idempotencyKey: input.idempotency_key,
              status: input.status,
              query: input.query,
              origin: input.origin,
              retrievalScope: input.retrieval_scope,
              teamWorkspaceId: input.team_workspace_id,
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
              teamWorkspaceId: input.team_workspace_id,
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
