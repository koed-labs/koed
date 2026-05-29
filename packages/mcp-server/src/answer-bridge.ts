#!/usr/bin/env node
import { createHash } from "node:crypto";
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
import {
  persistRawConversationItems,
  projectRawConversationItems
} from "./raw-conversation-items.js";

export const host = process.env.MEMORY_ANSWER_BRIDGE_HOST ?? "0.0.0.0";
export const DEFAULT_ANSWER_BRIDGE_PORT = 3210;
export const parseAnswerBridgePort = (value?: string): number | null => {
  const candidate = (value ?? String(DEFAULT_ANSWER_BRIDGE_PORT)).trim();
  if (!/^\d+$/.test(candidate)) {
    return null;
  }
  const parsed = Number.parseInt(candidate, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : null;
};
export const port =
  parseAnswerBridgePort(process.env.MEMORY_ANSWER_BRIDGE_PORT) ??
  DEFAULT_ANSWER_BRIDGE_PORT;
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
    retrieval_scope: z.literal("personal").optional(),
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
type MemoryQuestionStatus = "pending" | "answered" | "error";

interface MemoryQuestionRecord {
  id: string;
  attemptCount?: number | null;
  query: string;
  retrievalScope?: string | null;
  searchDomain?: "global" | "project" | "session" | string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  status?: MemoryQuestionStatus | string;
  response?: Record<string, unknown> | null;
  errorMessage?: string | null;
}

interface PendingQuestionAnswerServiceConfig {
  initialDelayMs: number;
  intervalMs: number;
  batchLimit: number;
  leaseSeconds: number;
  answerLimit: number;
}

interface PendingQuestionAnswerServiceHandle {
  stop(): void;
  trigger(reason?: string): Promise<{
    ran: boolean;
    skippedReason?: "already_running" | "stopped";
    processed?: number;
    error?: string;
  }>;
}

const answerLocalLeaseSeconds = () =>
  z.coerce
    .number()
    .int()
    .positive()
    .max(3600)
    .catch(300)
    .parse(process.env.MEMORY_QUESTION_ANSWER_LOCAL_LEASE_SECONDS);

const questionAnswerMaxAttempts = () =>
  z.coerce
    .number()
    .int()
    .positive()
    .max(25)
    .catch(3)
    .parse(process.env.MEMORY_QUESTION_ANSWER_MAX_ATTEMPTS);

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
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
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

const errorMessage = (error: unknown): string => {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
};

const errorStatus = (error: unknown): number => {
  if (error instanceof MemoryApiError && error.status) {
    return error.status;
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return 400;
  }
  return 500;
};

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

const questionFromResponse = (
  response: Record<string, unknown>
): MemoryQuestionRecord => {
  const question = response.question;
  if (
    question &&
    typeof question === "object" &&
    "id" in question &&
    typeof (question as { id: unknown }).id === "string" &&
    "query" in question &&
    typeof (question as { query: unknown }).query === "string"
  ) {
    return question as MemoryQuestionRecord;
  }
  throw new Error("Memory question response did not include question detail");
};

const questionsFromClaimResponse = (
  response: Record<string, unknown>
): MemoryQuestionRecord[] => {
  const questions = response.questions;
  if (!Array.isArray(questions)) {
    throw new Error("Memory question claim response did not include questions");
  }
  return questions.filter(
    (question): question is MemoryQuestionRecord =>
      Boolean(question) &&
      typeof question === "object" &&
      typeof (question as MemoryQuestionRecord).id === "string" &&
      typeof (question as MemoryQuestionRecord).query === "string"
  );
};

const releaseQuestionForRetry = async (
  client: MemoryApiClient,
  question: MemoryQuestionRecord,
  message: string,
  diagnostics: Partial<{
    response: MemoryAnswerWorkerResponse;
    retrieval: unknown;
    localMemoryWorker: MemoryAnswerWorkerResponse["localMemoryWorker"];
  }> = {}
) =>
  client.updateQuestion(question.id, {
    status: "pending",
    last_error_message: message,
    ...(question.attemptCount ? { attempt_count: question.attemptCount } : {}),
    ...(diagnostics.response
      ? { response: stripAppServerEvents(diagnostics.response) }
      : {}),
    ...(diagnostics.retrieval ? { retrieval: diagnostics.retrieval } : {}),
    ...(diagnostics.localMemoryWorker
      ? {
          local_memory_worker: stripAppServerEvents(
            diagnostics.localMemoryWorker
          )
        }
      : {})
  });

const updateQuestionWithError = async (
  client: MemoryApiClient,
  question: MemoryQuestionRecord,
  message: string,
  diagnostics: Partial<{
    response: MemoryAnswerWorkerResponse;
    retrieval: unknown;
    localMemoryWorker: MemoryAnswerWorkerResponse["localMemoryWorker"];
  }> = {}
) =>
  client.updateQuestion(question.id, {
    status: "error",
    error_message: message,
    ...(question.attemptCount ? { attempt_count: question.attemptCount } : {}),
    ...(diagnostics.response
      ? { response: stripAppServerEvents(diagnostics.response) }
      : {}),
    ...(diagnostics.retrieval ? { retrieval: diagnostics.retrieval } : {}),
    ...(diagnostics.localMemoryWorker
      ? {
          local_memory_worker: stripAppServerEvents(
            diagnostics.localMemoryWorker
          )
        }
      : {})
  });

const evidenceFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.evidenceBundle?.evidence ?? answer.evidence;

const citationsFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.citations;

const retrievalFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.evidenceBundle?.retrieval ?? answer.retrieval;

const stripAppServerEvents = <T>(value: T): T => {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripAppServerEvents) as T;
  }
  const { appServerEvents, ...rest } = value as Record<string, unknown>;
  void appServerEvents;
  return Object.fromEntries(
    Object.entries(rest).map(([key, entry]) => [
      key,
      stripAppServerEvents(entry)
    ])
  ) as T;
};

const isRetryableSynthesisFallback = (answer: MemoryAnswerWorkerResponse) =>
  answer.localMemoryWorker.usedFallback === true &&
  answer.localMemoryWorker.skippedReason === "codex_failed";

const retryableSynthesisFailureMessage =
  "Memory answer synthesis failed. Koed will retry shortly.";

const terminalSynthesisFailureMessage =
  "Memory answer synthesis failed after retries. Please try again.";

const hasQuestionAttemptsRemaining = (
  question: MemoryQuestionRecord
): boolean => (question.attemptCount ?? 0) < questionAnswerMaxAttempts();

const isRetryableBridgeError = (error: unknown): boolean => {
  if (error instanceof MemoryApiError) {
    return (
      error.status === undefined ||
      error.status === 408 ||
      error.status === 409 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  return true;
};

const normalizeSearchDomain = (
  value: MemoryQuestionRecord["searchDomain"]
): "global" | "project" | "session" =>
  value === "project" || value === "session" ? value : "global";

const normalizeRetrievalScope = (
  value: MemoryQuestionRecord["retrievalScope"],
  fallback: string
): string => (value === "personal" ? value : fallback);

const updateQuestionWithAnswer = async (
  client: MemoryApiClient,
  question: MemoryQuestionRecord,
  answer: MemoryAnswerWorkerResponse
) =>
  client.updateQuestion(question.id, {
    status: "answered",
    ...(question.attemptCount ? { attempt_count: question.attemptCount } : {}),
    answer_markdown:
      answer.markdown?.trim() || "No matching memory evidence found.",
    response: stripAppServerEvents(answer),
    evidence: evidenceFromAnswer(answer),
    citations: citationsFromAnswer(answer),
    retrieval: retrievalFromAnswer(answer),
    local_memory_worker: stripAppServerEvents(answer.localMemoryWorker)
  });

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const rawTextFromAppServerEvent = (event: {
  params?: unknown;
  result?: unknown;
}): string | undefined => {
  const value = event.params ?? event.result;
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  for (const key of ["delta", "text", "content", "message"]) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) {
      return field;
    }
  }
  const item =
    record.item &&
    typeof record.item === "object" &&
    !Array.isArray(record.item)
      ? (record.item as Record<string, unknown>)
      : {};
  for (const key of ["text", "content", "message"]) {
    const field = item[key];
    if (typeof field === "string" && field.trim()) {
      return field;
    }
  }
  return undefined;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const persistAnswerAppServerEvents = async (
  client: MemoryApiClient,
  question: MemoryQuestionRecord,
  answer: MemoryAnswerWorkerResponse
): Promise<void> => {
  const worker =
    answer.localMemoryWorker as MemoryAnswerWorkerResponse["localMemoryWorker"] & {
      appServerEvents?: Array<{
        method: string;
        params?: unknown;
        result?: unknown;
        observedAt?: string;
      }>;
      appServerThreadId?: string;
      appServerTurnId?: string;
    };
  const events = worker.appServerEvents ?? [];
  if (events.length === 0) {
    return;
  }
  const items = events.map((event, index) => {
    const sourceHash = hash({
      workflow: "memory_question",
      questionId: question.id,
      threadId: worker.appServerThreadId,
      turnId: worker.appServerTurnId,
      index,
      method: event.method,
      params: event.params,
      result: event.result
    });
    return {
      sourceKind: "codex",
      sourceAdapterVersion: "codex-app-server-v1",
      sourceTransport: "app_server",
      externalSessionId: worker.appServerThreadId,
      externalThreadId: worker.appServerThreadId,
      externalTurnId: worker.appServerTurnId,
      sourceRecordType: "app_server_notification",
      sourceEventType: event.method,
      sourceSequence: index,
      eventTime: event.observedAt,
      rawJson: event,
      rawText: rawTextFromAppServerEvent(event),
      sourceHash,
      idempotencyKey: sourceHash,
      projectionStatus: "raw_only",
      projectionVersion: "codex-app-server-v1",
      metadata: {
        workflow: "memory_question",
        questionId: question.id,
        searchDomain: question.searchDomain,
        workspaceId: question.workspaceId,
        sessionId: question.sessionId
      }
    };
  });
  const persisted = await persistRawConversationItems(
    client,
    items,
    `memory question ${question.id}`
  );
  const tokenUsage = worker.tokenUsage;
  const lastUsage = tokenUsage?.last;
  const tokenConversationItem = persisted.find((item) => {
    const record = asRecord(item);
    return record.sourceEventType === "thread/tokenUsage/updated";
  });
  const tokenConversationItemId =
    typeof tokenConversationItem?.id === "string"
      ? tokenConversationItem.id
      : undefined;
  if (lastUsage) {
    await client.recordTokenUsage({
      workflowType: "memory_question",
      workflowId: question.id,
      sessionId: question.sessionId ?? undefined,
      conversationItemId: tokenConversationItemId,
      sourceRuntime: "codex",
      sourceKind: "codex",
      sourceAdapterVersion: "codex-app-server-v1",
      model: worker.model ?? null,
      modelContextWindow: tokenUsage.modelContextWindow ?? null,
      inputTokens: lastUsage.inputTokens ?? null,
      cachedInputTokens: lastUsage.cachedInputTokens ?? null,
      outputTokens: lastUsage.outputTokens ?? null,
      reasoningOutputTokens: lastUsage.reasoningOutputTokens ?? null,
      totalTokens: lastUsage.totalTokens ?? null,
      usageScope: "last",
      metadata: {
        appServerThreadId: worker.appServerThreadId,
        appServerTurnId: worker.appServerTurnId,
        searchDomain: question.searchDomain
      },
      idempotencyKey: tokenConversationItemId
        ? `token:${tokenConversationItemId}:last`
        : `memory-question:${question.id}:token:last`
    });
  }
  await projectRawConversationItems(
    client,
    persisted,
    `memory question ${question.id}`
  );
};

export const answerClaimedMemoryQuestion = async (
  client: MemoryApiClient,
  question: MemoryQuestionRecord,
  options: {
    fallbackRetrievalScope?: string;
    limit?: number;
  } = {}
) => {
  const searchDomain = normalizeSearchDomain(question.searchDomain);
  const retrievalScope = normalizeRetrievalScope(
    question.retrievalScope,
    options.fallbackRetrievalScope ?? "personal"
  );
  try {
    const evidence = await client.answer({
      query: question.query,
      retrieval_scope: retrievalScope,
      search_domain: searchDomain,
      workspace_id: question.workspaceId ?? undefined,
      session_id: question.sessionId ?? undefined,
      limit: options.limit ?? 10
    });
    const answer = await answerWithMemoryWorker(evidence, {
      client,
      retrievalScope,
      searchDomain,
      workspaceId: question.workspaceId ?? undefined,
      sessionId: question.sessionId ?? undefined,
      limit: options.limit ?? 10,
      responseDetail: "with_evidence"
    });
    if (isRetryableSynthesisFallback(answer)) {
      const retryable = hasQuestionAttemptsRemaining(question);
      const message = retryable
        ? retryableSynthesisFailureMessage
        : terminalSynthesisFailureMessage;
      const diagnostics = {
        response: answer,
        retrieval: retrievalFromAnswer(answer),
        localMemoryWorker: answer.localMemoryWorker
      };
      const updated = await (retryable
        ? releaseQuestionForRetry(client, question, message, diagnostics)
        : updateQuestionWithError(client, question, message, diagnostics));
      return {
        ok: false,
        question: questionFromResponse(updated),
        error: message
      };
    }
    try {
      await persistAnswerAppServerEvents(client, question, answer);
    } catch (error) {
      console.warn(
        `[answer-bridge] Failed to persist app-server telemetry for question ${question.id}; preserving synthesized answer.`,
        error
      );
    }
    const updated = await updateQuestionWithAnswer(client, question, answer);
    return {
      ok: true,
      question: questionFromResponse(updated),
      answer
    };
  } catch (error) {
    const message = errorMessage(error);
    const retryable =
      hasQuestionAttemptsRemaining(question) && isRetryableBridgeError(error);
    const updated = await (
      retryable
        ? releaseQuestionForRetry(client, question, message)
        : updateQuestionWithError(client, question, message)
    ).catch(() => ({ question }));
    return {
      ok: false,
      question: questionFromResponse(updated),
      error: message
    };
  }
};

const positiveIntEnv = (
  name: string,
  fallback: number,
  options: { max?: number } = {}
): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return options.max ? Math.min(parsed, options.max) : parsed;
};

export const resolvePendingQuestionAnswerServiceConfig =
  (): PendingQuestionAnswerServiceConfig => ({
    initialDelayMs: positiveIntEnv(
      "MEMORY_QUESTION_BACKGROUND_INITIAL_DELAY_MS",
      3_000
    ),
    intervalMs: positiveIntEnv(
      "MEMORY_QUESTION_BACKGROUND_INTERVAL_MS",
      30_000
    ),
    batchLimit: positiveIntEnv("MEMORY_QUESTION_BACKGROUND_BATCH_LIMIT", 2, {
      max: 10
    }),
    leaseSeconds: positiveIntEnv(
      "MEMORY_QUESTION_BACKGROUND_LEASE_SECONDS",
      180,
      { max: 3600 }
    ),
    answerLimit: positiveIntEnv("MEMORY_QUESTION_BACKGROUND_ANSWER_LIMIT", 10, {
      max: 50
    })
  });

export const startPendingQuestionAnswerService = (
  client: MemoryApiClient,
  options: {
    fallbackRetrievalScope?: string;
    serviceConfig?: PendingQuestionAnswerServiceConfig;
  } = {}
): PendingQuestionAnswerServiceHandle => {
  const config =
    options.serviceConfig ?? resolvePendingQuestionAnswerServiceConfig();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;

  const schedule = (delayMs: number) => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void run("timer");
    }, delayMs);
  };

  const run = async (reason = "manual") => {
    void reason;
    if (stopped) {
      return { ran: false, skippedReason: "stopped" as const };
    }
    if (running) {
      return { ran: false, skippedReason: "already_running" as const };
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    running = true;
    try {
      const claimed = questionsFromClaimResponse(
        await client.claimPendingQuestions({
          limit: config.batchLimit,
          lease_seconds: config.leaseSeconds
        })
      );
      for (const question of claimed) {
        await answerClaimedMemoryQuestion(client, question, {
          fallbackRetrievalScope: options.fallbackRetrievalScope,
          limit: config.answerLimit
        });
      }
      return { ran: true, processed: claimed.length };
    } catch (error) {
      return { ran: true, error: errorMessage(error) };
    } finally {
      running = false;
      schedule(config.intervalMs);
    }
  };

  schedule(config.initialDelayMs);

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
    trigger: run
  };
};

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

  const claimed = questionsFromClaimResponse(
    await client.claimPendingQuestions({
      question_id: questionId,
      limit: 1,
      lease_seconds: answerLocalLeaseSeconds()
    })
  )[0];

  if (!claimed) {
    const existing = questionFromResponse(await client.getQuestion(questionId));
    if (existing.status === "error") {
      sendJson(request, response, 200, {
        ok: false,
        question: existing,
        error: existing.errorMessage ?? "Memory answer failed."
      });
      return;
    }
    sendJson(request, response, existing.status === "pending" ? 202 : 200, {
      ok: true,
      question: existing,
      pending: existing.status === "pending",
      answer: existing.response ?? undefined
    });
    return;
  }

  const result = await answerClaimedMemoryQuestion(client, claimed, {
    fallbackRetrievalScope: retrievalScope,
    limit: input.limit
  });
  sendJson(request, response, 200, result);
};

export const createAnswerBridgeServer = (options?: {
  startBackgroundService?: boolean;
}) => {
  const backgroundClientConfig = defaultConfig();
  const shouldStartBackgroundService =
    options?.startBackgroundService !== false &&
    backgroundClientConfig.apiToken &&
    process.env.MEMORY_QUESTION_BACKGROUND_ENABLED?.trim().toLowerCase() !==
      "false";
  let backgroundService: PendingQuestionAnswerServiceHandle | null = null;
  const server = http.createServer((request, response) => {
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
        sendJson(request, response, errorStatus(error), {
          error: errorMessage(error)
        });
      }
    })();
  });
  server.on("listening", () => {
    if (shouldStartBackgroundService && !backgroundService) {
      backgroundService = startPendingQuestionAnswerService(
        new MemoryApiClient(backgroundClientConfig)
      );
    }
  });
  server.on("close", () => {
    backgroundService?.stop();
    backgroundService = null;
  });
  return server;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configuredPort = parseAnswerBridgePort(
    process.env.MEMORY_ANSWER_BRIDGE_PORT
  );
  if (!configuredPort) {
    console.error(
      `Invalid MEMORY_ANSWER_BRIDGE_PORT "${process.env.MEMORY_ANSWER_BRIDGE_PORT}". Expected an integer from 1 to 65535.`
    );
    process.exit(1);
  }
  const server = createAnswerBridgeServer();
  server.listen(configuredPort, host, () => {
    console.error(
      `Koed memory answer bridge listening on http://${host}:${configuredPort}`
    );
  });
}
