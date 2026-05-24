#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import http from "node:http";
import { z } from "zod";
import {
  answerWithMemoryWorker,
  type MemoryAnswerWorkerResponse
} from "./answer-worker.js";
import {
  defaultAnswerScope,
  defaultConfig,
  MemoryApiClient,
  MemoryApiError
} from "./index.js";

export const host = process.env.MEMORY_ANSWER_BRIDGE_HOST ?? "127.0.0.1";
export const port = Number.parseInt(
  process.env.MEMORY_ANSWER_BRIDGE_PORT ?? "3210",
  10
);
const allowedOrigins = new Set(
  (
    process.env.MEMORY_ANSWER_BRIDGE_CORS_ORIGINS ??
    "http://localhost:5173,http://localhost:5174,http://localhost:5176,http://localhost:5573,http://localhost:5574,http://localhost:5733,http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:5176,http://127.0.0.1:5573,http://127.0.0.1:5574,http://127.0.0.1:5733"
  )
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean)
);

const requestSchema = z
  .object({
    query: z.string().min(1),
    question_id: z.string().uuid().optional(),
    retrieval_scope: z.enum(["personal", "personal+team"]).optional(),
    search_domain: z.enum(["global", "project", "session"]).default("global"),
    workspace_id: z.string().min(1).optional(),
    project_name: z.string().min(1).optional(),
    project_path: z.string().min(1).optional(),
    session_id: z.string().uuid().optional(),
    thread_id: z.string().min(1).optional(),
    thread_name: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(50).default(10)
  })
  .superRefine((input, context) => {
    if (input.search_domain === "session" && !input.session_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["session_id"],
        message: "session_id is required when search_domain is session"
      });
    }
    if (input.search_domain === "project" && !input.workspace_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_id"],
        message: "workspace_id is required when search_domain is project"
      });
    }
  });

type JsonBody = Record<string, unknown>;

const applyCors = (
  request: http.IncomingMessage,
  response: http.ServerResponse
) => {
  const origin = request.headers.origin?.replace(/\/+$/, "");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
    response.setHeader(
      "access-control-allow-headers",
      "authorization, content-type"
    );
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  }
};

const sendJson = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  status: number,
  body: JsonBody
) => {
  applyCors(request, response);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const readJsonBody = async (
  request: http.IncomingMessage
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
};

const bearerToken = (request: http.IncomingMessage): string | null => {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token || null;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const questionIdFromResponse = (response: Record<string, unknown>) => {
  const question = response.question;
  if (
    question &&
    typeof question === "object" &&
    "id" in question &&
    typeof question.id === "string"
  ) {
    return question.id;
  }
  throw new Error("Memory question create response did not include an id");
};

const updateQuestionWithError = async (
  client: MemoryApiClient,
  questionId: string,
  message: string
) =>
  client.updateQuestion(questionId, {
    status: "error",
    error_message: message
  });

const evidenceFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.evidenceBundle?.evidence ?? answer.evidence;

const citationsFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.citations;

const retrievalFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.evidenceBundle?.retrieval ?? answer.retrieval;

export const handleAnswerLocal = async (
  request: http.IncomingMessage,
  response: http.ServerResponse
) => {
  const token = bearerToken(request);
  if (!token) {
    sendJson(request, response, 401, { error: "Bearer API token required" });
    return;
  }

  const input = requestSchema.parse(await readJsonBody(request));
  const client = new MemoryApiClient({
    ...defaultConfig(),
    apiToken: token
  });
  const retrievalScope =
    input.retrieval_scope ?? defaultAnswerScope(await client.accessCheck());

  const questionId =
    input.question_id ??
    questionIdFromResponse(
      await client.createQuestion({
        query: input.query,
        retrieval_scope: retrievalScope,
        search_domain: input.search_domain,
        workspace_id: input.workspace_id,
        project_name: input.project_name,
        project_path: input.project_path,
        session_id: input.session_id,
        thread_id: input.thread_id,
        thread_name: input.thread_name
      })
    );

  try {
    const evidence = await client.answer({
      query: input.query,
      retrieval_scope: retrievalScope,
      search_domain: input.search_domain,
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      limit: input.limit
    });
    const answer = await answerWithMemoryWorker(evidence, {
      client,
      retrievalScope,
      searchDomain: input.search_domain,
      workspaceId: input.workspace_id,
      sessionId: input.session_id,
      limit: input.limit,
      responseDetail: "with_evidence"
    });
    const updated = await client.updateQuestion(questionId, {
      status: "answered",
      answer_markdown:
        answer.markdown?.trim() || "No matching memory evidence found.",
      response: answer,
      evidence: evidenceFromAnswer(answer),
      citations: citationsFromAnswer(answer),
      retrieval: retrievalFromAnswer(answer),
      local_memory_worker: answer.localMemoryWorker
    });
    sendJson(request, response, 200, {
      ok: true,
      question: updated.question,
      answer
    });
  } catch (error) {
    const message = errorMessage(error);
    const updated = await updateQuestionWithError(client, questionId, message);
    sendJson(request, response, 200, {
      ok: false,
      question: updated.question,
      error: message
    });
  }
};

export const createAnswerBridgeServer = () =>
  http.createServer((request, response) => {
    void (async () => {
      try {
        if (request.method === "OPTIONS") {
          applyCors(request, response);
          response.writeHead(204);
          response.end();
          return;
        }

        if (request.method === "GET" && request.url === "/health") {
          sendJson(request, response, 200, {
            ok: true,
            service: "koed-memory-answer-bridge",
            apiUrl: defaultConfig().apiUrl
          });
          return;
        }

        if (
          request.method === "POST" &&
          request.url === "/v1/memory/answer-local"
        ) {
          await handleAnswerLocal(request, response);
          return;
        }

        sendJson(request, response, 404, { error: "Not found" });
      } catch (error) {
        const status =
          error instanceof MemoryApiError && error.status ? error.status : 500;
        sendJson(request, response, status, { error: errorMessage(error) });
      }
    })();
  });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createAnswerBridgeServer();
  server.listen(port, host, () => {
    console.error(
      `Koed memory answer bridge listening on http://${host}:${port}`
    );
  });
}
