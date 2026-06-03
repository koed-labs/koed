#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { z } from "zod";
import {
  answerWithMemoryWorker,
  resolveManualMemoryAnswerWorkerConfig,
  resolveMemoryAnswerWorkerConfig,
  type ManualMemoryAnswerWorkerOverrides,
  type MemoryAnswerWorkerResponse
} from "./answer-worker.js";
import {
  checkCodexAppServerAvailability,
  listCodexAppServerModels,
  type CodexAppServerModelOption
} from "./codex-app-server-runner.js";
import {
  defaultAnswerScope,
  defaultConfig,
  localMemoryAgentSettingFor,
  type LocalMemoryAgentFlowKey,
  MemoryApiClient,
  MemoryApiError,
  workerOverridesFromLocalMemorySetting
} from "./index.js";
import { resolveLcmSummaryWorkerConfig } from "./lcm-summary-worker.js";
import {
  persistRawConversationItems,
  projectRawConversationItems
} from "./raw-conversation-items.js";
import { answerBridgeLogger } from "./logger.js";

export const host = process.env.MEMORY_ANSWER_BRIDGE_HOST ?? "0.0.0.0";
export const DEFAULT_ANSWER_BRIDGE_PORT = 3210;
export const DEFAULT_EXISTING_ANSWER_BRIDGE_PROBE_TIMEOUT_MS = 1_500;
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
const answerBridgeStartedAt = new Date().toISOString();

interface BridgeRequestContext {
  id: string;
  method?: string;
  path?: string;
  queryKeys: string[];
  startedAt: number;
}

const requestContexts = new WeakMap<
  http.IncomingMessage,
  BridgeRequestContext
>();

const requestIdPattern = /^[A-Za-z0-9._~:-]{1,128}$/;

const firstHeaderValue = (
  value: string | string[] | undefined
): string | undefined => (Array.isArray(value) ? value[0] : value);

const resolveRequestId = (request: http.IncomingMessage): string => {
  const candidate = firstHeaderValue(request.headers["x-request-id"]);
  return candidate && requestIdPattern.test(candidate)
    ? candidate
    : randomUUID();
};

const bridgeRequestContext = (
  request: http.IncomingMessage
): BridgeRequestContext => {
  const existing = requestContexts.get(request);
  if (existing) {
    return existing;
  }
  let path: string | undefined;
  let queryKeys: string[] = [];
  try {
    const parsed = new URL(request.url ?? "/", "http://koed.local");
    path = parsed.pathname;
    queryKeys = [...new Set([...parsed.searchParams.keys()])].sort();
  } catch {
    path = request.url?.split("?")[0] ?? request.url;
  }
  const context: BridgeRequestContext = {
    id: resolveRequestId(request),
    method: request.method,
    path,
    queryKeys,
    startedAt: Date.now()
  };
  requestContexts.set(request, context);
  return context;
};

const logBridgeResponse = (
  request: http.IncomingMessage,
  status: number
): void => {
  const context = bridgeRequestContext(request);
  const level =
    status >= 500
      ? "error"
      : status >= 400
        ? "warn"
        : status === 200
          ? "info"
          : "debug";
  answerBridgeLogger[level](
    {
      request: {
        id: context.id,
        method: context.method,
        path: context.path,
        ...(context.queryKeys.length > 0
          ? { query_keys: context.queryKeys }
          : {})
      },
      http: {
        duration_ms: Date.now() - context.startedAt
      },
      response: {
        status_code: status
      }
    },
    "memory answer bridge request completed"
  );
};

const healthProbeHost = (value: string): string => {
  if (value === "0.0.0.0" || value === "::") {
    return "127.0.0.1";
  }
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
};

export const answerBridgeHealthUrl = (
  bridgeHost: string,
  bridgePort: number
): string => `http://${healthProbeHost(bridgeHost)}:${bridgePort}/health`;

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
    limit: z.coerce.number().int().positive().max(50).default(10),
    local_memory_worker_config: z
      .object({
        provider: z.literal("codex").optional(),
        model: z.string().trim().min(1).optional(),
        reasoning_effort: z.string().trim().min(1).optional(),
        timeout_ms: z.coerce.number().int().min(1000).max(600000).optional(),
        max_attempts: z.coerce.number().int().min(1).max(25).optional()
      })
      .strict()
      .optional()
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

const localMemoryAgentSettingsUpdateSchema = z
  .object({
    provider: z.literal("codex").default("codex"),
    model: z.string().trim().min(1),
    reasoning_effort: z.string().trim().min(1),
    timeout_ms: z.coerce.number().int().min(1000).max(600000),
    max_attempts: z.coerce.number().int().min(1).max(25)
  })
  .strict();

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
  localMemoryWorkerConfig?: Record<string, unknown> | null;
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

interface AnswerBridgeShutdownOptions {
  clearTimeoutFn?: typeof clearTimeout;
  exit?: (code: number) => void;
  forceCloseDelayMs?: number;
  log?: typeof answerBridgeLogger;
  processLike?: {
    once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  };
  setTimeoutFn?: typeof setTimeout;
}

interface StandaloneAnswerBridgeOptions {
  createServer?: typeof createAnswerBridgeServer;
  exit?: (code: number) => void;
  existingBridgeProbeTimeoutMs?: number;
  fetchFn?: typeof fetch;
  host?: string;
  installShutdownHandlers?: typeof installAnswerBridgeShutdownHandlers;
  log?: typeof answerBridgeLogger;
  port?: number | null;
}

interface ExistingAnswerBridgeProbeResult {
  ok: boolean;
  healthUrl: string;
  payload?: Record<string, unknown>;
  error?: string;
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
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
    response.setHeader(
      "access-control-allow-headers",
      "authorization, content-type"
    );
    response.setHeader(
      "access-control-allow-methods",
      "GET, POST, PUT, OPTIONS"
    );
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
  logBridgeResponse(request, status);
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

const localMemoryAgentSettingsFlowKeyFromUrl = (
  url: string | undefined
): LocalMemoryAgentFlowKey | null => {
  if (!url) {
    return null;
  }
  const pathname = new URL(url, "http://localhost").pathname;
  const prefix = "/v1/memory/local-agent-settings/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const encodedFlowKey = pathname.slice(prefix.length);
  if (!encodedFlowKey || encodedFlowKey.includes("/")) {
    return null;
  }
  try {
    const flowKey = decodeURIComponent(encodedFlowKey);
    if (flowKey === "mcp_memory_answer" || flowKey === "lcm_summary") {
      return flowKey;
    }
  } catch {
    return null;
  }
  return null;
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
      ? { response: persistedAnswerResponse(diagnostics.response) }
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
      ? { response: persistedAnswerResponse(diagnostics.response) }
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

const itemCount = (value: unknown): number =>
  Array.isArray(value) ? value.length : 0;

const retrievalFromAnswer = (answer: MemoryAnswerWorkerResponse) =>
  answer.evidenceBundle?.retrieval ?? answer.retrieval;

const stripAppServerEvents = <T>(value: T): T => {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripAppServerEvents) as T;
  }
  const { appServerEvents, rawEvents, ...rest } = value as Record<
    string,
    unknown
  >;
  void appServerEvents;
  void rawEvents;
  return Object.fromEntries(
    Object.entries(rest).map(([key, entry]) => [
      key,
      stripAppServerEvents(entry)
    ])
  ) as T;
};

const persistedAnswerResponse = (
  answer: MemoryAnswerWorkerResponse
): MemoryAnswerWorkerResponse => {
  const compact: Record<string, unknown> = {
    markdown: answer.markdown,
    retrieval: answer.retrieval,
    localMemoryWorker: stripAppServerEvents(answer.localMemoryWorker)
  };
  if (answer.structuredAnswer !== undefined) {
    compact.structuredAnswer = answer.structuredAnswer;
  }
  if (answer.citations !== undefined) {
    compact.citations = answer.citations;
  }
  return compact as MemoryAnswerWorkerResponse;
};

const isRetryableSynthesisFallback = (answer: MemoryAnswerWorkerResponse) =>
  answer.localMemoryWorker.usedFallback === true &&
  answer.localMemoryWorker.skippedReason === "codex_failed";

const retryableSynthesisFailureMessage =
  "Memory answer synthesis failed. Koed will retry shortly.";

const terminalSynthesisFailureMessage =
  "Memory answer synthesis failed after retries. Please try again.";

const hasQuestionAttemptsRemaining = (
  question: MemoryQuestionRecord,
  maxAttempts = questionAnswerMaxAttempts()
): boolean => (question.attemptCount ?? 0) < maxAttempts;

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
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (typeof status === "number") {
    return (
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500
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

const workerOverridesFromConfig = (
  value: unknown
): ManualMemoryAnswerWorkerOverrides => {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    ...(typeof record.provider === "string"
      ? { provider: record.provider }
      : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.reasoningEffort === "string"
      ? { reasoningEffort: record.reasoningEffort }
      : typeof record.reasoning_effort === "string"
        ? { reasoningEffort: record.reasoning_effort }
        : {}),
    ...(typeof record.timeoutMs === "number"
      ? { timeoutMs: record.timeoutMs }
      : typeof record.timeout_ms === "number"
        ? { timeoutMs: record.timeout_ms }
        : {}),
    ...(typeof record.maxAttempts === "number"
      ? { maxAttempts: record.maxAttempts }
      : typeof record.max_attempts === "number"
        ? { maxAttempts: record.max_attempts }
        : {})
  };
};

const storedWorkerConfigFromInput = (
  input: z.infer<typeof requestSchema>["local_memory_worker_config"]
): Record<string, unknown> | undefined => {
  if (!input) {
    return undefined;
  }
  return {
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoning_effort
      ? { reasoning_effort: input.reasoning_effort }
      : {}),
    ...(input.timeout_ms ? { timeout_ms: input.timeout_ms } : {}),
    ...(input.max_attempts ? { max_attempts: input.max_attempts } : {})
  };
};

const publicMemoryAnswerConfig = (
  config: ReturnType<typeof resolveMemoryAnswerWorkerConfig>
) => ({
  provider: config.provider,
  model: config.model,
  reasoningEffort: config.reasoningEffort,
  timeoutMs: config.timeoutMs,
  maxAttempts: config.maxAttempts,
  maxSearches: config.maxSearches,
  maxExpansions: config.maxExpansions,
  appServerBinary: config.appServerBinary
});

const publicLcmSummaryConfig = (
  config: ReturnType<typeof resolveLcmSummaryWorkerConfig>
) => ({
  provider: config.provider,
  model: config.model,
  reasoningEffort: config.reasoningEffort,
  timeoutMs: config.timeoutMs,
  maxAttempts: config.maxAttempts,
  retryDelayMs: config.retryDelayMs,
  concurrency: config.concurrency,
  maxPromptTokens: config.maxPromptTokens,
  appServerBinary: config.appServerBinary
});

const publicModelOptions = (
  models: CodexAppServerModelOption[],
  fallbackModel: string
) => {
  const visible = models.filter((model) => !model.hidden);
  const options = visible.length > 0 ? visible : models;
  const mapped = options.map((model) => ({
    provider: "codex" as const,
    id: model.id,
    model: model.model,
    label: model.label,
    description: model.description ?? null,
    isDefault: model.isDefault,
    defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    supportedReasoningEfforts: model.supportedReasoningEfforts
  }));
  if (!mapped.some((option) => option.model === fallbackModel)) {
    mapped.push({
      provider: "codex" as const,
      id: fallbackModel,
      model: fallbackModel,
      label: fallbackModel,
      description: null,
      isDefault: mapped.length === 0,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: []
    });
  }
  return mapped;
};

export const localMemoryAgentSettings = async (
  env: NodeJS.ProcessEnv = process.env,
  client?: MemoryApiClient
) => {
  const storedSettings = client
    ? (await client.listLocalMemoryAgentSettings()).settings
    : [];
  const mcpMemoryAnswer = resolveMemoryAnswerWorkerConfig(
    env,
    workerOverridesFromLocalMemorySetting(
      localMemoryAgentSettingFor(storedSettings, "mcp_memory_answer")
    )
  );
  const manualMemoryAnswer = resolveManualMemoryAnswerWorkerConfig(env);
  const lcmSummary = resolveLcmSummaryWorkerConfig(
    env,
    workerOverridesFromLocalMemorySetting(
      localMemoryAgentSettingFor(storedSettings, "lcm_summary")
    )
  );
  const representativeCodexConfig = manualMemoryAnswer;
  let modelListError: string | null = null;
  const codexAvailability =
    representativeCodexConfig.provider === "codex"
      ? await checkCodexAppServerAvailability({
          appServerBinary: representativeCodexConfig.appServerBinary,
          model: representativeCodexConfig.model,
          cwd: representativeCodexConfig.cwd,
          env: representativeCodexConfig.env
        })
      : {
          available: false,
          error: `Unsupported local AI Client provider: ${representativeCodexConfig.provider}`
        };
  let modelOptions: ReturnType<typeof publicModelOptions>;
  if (codexAvailability.available) {
    try {
      modelOptions = publicModelOptions(
        await listCodexAppServerModels({
          appServerBinary: representativeCodexConfig.appServerBinary,
          model: representativeCodexConfig.model,
          cwd: representativeCodexConfig.cwd,
          env: representativeCodexConfig.env
        }),
        representativeCodexConfig.model
      );
    } catch (error) {
      modelListError = error instanceof Error ? error.message : String(error);
      modelOptions = publicModelOptions([], representativeCodexConfig.model);
    }
  } else {
    modelOptions = publicModelOptions([], representativeCodexConfig.model);
  }

  return {
    aiClients: [
      {
        id: "codex",
        label: "Codex",
        status: codexAvailability.available ? "ready" : "unavailable",
        error: codexAvailability.error ?? modelListError ?? null
      }
    ],
    modelOptions,
    modelListError,
    flows: {
      mcpMemoryAnswer: {
        ...publicMemoryAnswerConfig(mcpMemoryAnswer),
        source: localMemoryAgentSettingFor(storedSettings, "mcp_memory_answer")
          ? "db"
          : "env"
      },
      manualMemoryAnswer: {
        ...publicMemoryAnswerConfig(manualMemoryAnswer)
      },
      lcmSummary: {
        ...publicLcmSummaryConfig(lcmSummary),
        source: localMemoryAgentSettingFor(storedSettings, "lcm_summary")
          ? "db"
          : "env"
      }
    },
    precedence: {
      mcpMemoryAnswer: ["API user setting", "MEMORY_ANSWER_*", "code defaults"],
      manualMemoryAnswer: [
        "Explorer per-question selection",
        "MEMORY_MANUAL_ANSWER_*",
        "MEMORY_ANSWER_*",
        "code defaults"
      ],
      lcmSummary: ["API user setting", "MEMORY_LCM_SUMMARY_*", "code defaults"]
    }
  };
};

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
    response: persistedAnswerResponse(answer),
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
  const executions =
    worker.appServerExecutions && worker.appServerExecutions.length > 0
      ? worker.appServerExecutions
      : [
          {
            model: worker.model ?? "codex-app-server",
            tokenUsage: worker.tokenUsage,
            threadId: worker.appServerThreadId,
            turnId: worker.appServerTurnId,
            rawEvents: worker.appServerEvents
          }
        ];
  const eventEntries = executions.flatMap((execution, executionIndex) =>
    (execution.rawEvents ?? []).map((event, eventIndex) => ({
      execution,
      executionIndex,
      event,
      eventIndex,
      sourceSequence: executionIndex * 1000 + eventIndex
    }))
  );
  if (eventEntries.length === 0) {
    return;
  }
  const items = eventEntries.map((entry) => {
    const sourceHash = hash({
      workflow: "memory_question",
      questionId: question.id,
      threadId: entry.execution.threadId,
      turnId: entry.execution.turnId,
      executionIndex: entry.executionIndex,
      eventIndex: entry.eventIndex,
      method: entry.event.method,
      params: entry.event.params,
      result: entry.event.result
    });
    return {
      sourceKind: "codex",
      sourceAdapterVersion: "codex-app-server-v1",
      sourceTransport: "app_server",
      externalSessionId: entry.execution.threadId,
      externalThreadId: entry.execution.threadId,
      externalTurnId: entry.execution.turnId,
      sourceRecordType: "app_server_notification",
      sourceEventType: entry.event.method,
      sourceSequence: entry.sourceSequence,
      eventTime: entry.event.observedAt,
      rawJson: entry.event,
      rawText: rawTextFromAppServerEvent(entry.event),
      sourceHash,
      idempotencyKey: sourceHash,
      projectionStatus: "raw_only",
      projectionVersion: "codex-app-server-v1",
      metadata: {
        workflow: "memory_question",
        questionId: question.id,
        answerJobId: entry.execution.answerJobId,
        primaryAppServerThreadId: entry.execution.primaryThreadId,
        searchDomain: question.searchDomain,
        workspaceId: question.workspaceId,
        sessionId: question.sessionId,
        executionIndex: entry.executionIndex
      }
    };
  });
  const persisted = await persistRawConversationItems(
    client,
    items,
    `memory question ${question.id}`
  );
  for (const [executionIndex, execution] of executions.entries()) {
    const tokenUsage = execution.tokenUsage;
    const lastUsage = tokenUsage?.last;
    if (!lastUsage) {
      continue;
    }
    const tokenSourceSequence = eventEntries.find(
      (entry) =>
        entry.executionIndex === executionIndex &&
        entry.event.method === "thread/tokenUsage/updated"
    )?.sourceSequence;
    const tokenConversationItem = persisted.find((item) => {
      const record = asRecord(item);
      return (
        record.sourceEventType === "thread/tokenUsage/updated" &&
        (tokenSourceSequence === undefined ||
          typeof record.sourceSequence !== "number" ||
          record.sourceSequence === tokenSourceSequence)
      );
    });
    const tokenConversationItemId =
      typeof tokenConversationItem?.id === "string"
        ? tokenConversationItem.id
        : undefined;
    await client.recordTokenUsage({
      workflowType: "memory_question",
      workflowId: question.id,
      questionId: question.id,
      sessionId: question.sessionId ?? undefined,
      conversationItemId: tokenConversationItemId,
      sourceRuntime: "codex",
      sourceKind: "codex",
      sourceAdapterVersion: "codex-app-server-v1",
      usageSource: "app_server",
      usageAccuracy: "provider_reported",
      usageKind: "turn_delta",
      connectorClient: "codex",
      model: execution.model ?? worker.model ?? null,
      modelContextWindow: tokenUsage.modelContextWindow ?? null,
      inputTokens: lastUsage.inputTokens ?? null,
      cachedInputTokens: lastUsage.cachedInputTokens ?? null,
      outputTokens: lastUsage.outputTokens ?? null,
      reasoningOutputTokens: lastUsage.reasoningOutputTokens ?? null,
      totalTokens: lastUsage.totalTokens ?? null,
      usageScope: "last",
      metadata: {
        appServerThreadId:
          execution.primaryThreadId ?? worker.appServerThreadId,
        appServerTurnId: execution.turnId,
        answerJobId: execution.answerJobId,
        primaryAppServerThreadId: execution.primaryThreadId,
        executionThreadId: execution.threadId,
        executionTurnId: execution.turnId,
        searchDomain: question.searchDomain,
        attemptIndex: execution.attemptIndex,
        executionStatus: execution.status ?? "succeeded",
        replacementThreadReason: execution.replacementThreadReason,
        errorMessage: execution.errorMessage,
        executionIndex
      },
      idempotencyKey: tokenConversationItemId
        ? `token:${tokenConversationItemId}:last`
        : `memory-question:${question.id}:token:${executionIndex}:${execution.attemptIndex ?? 1}:last`
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
  answerBridgeLogger.info(
    {
      questionId: question.id,
      attemptCount: question.attemptCount ?? 0,
      searchDomain,
      retrievalScope,
      hasWorkspaceId: Boolean(question.workspaceId),
      hasSessionId: Boolean(question.sessionId),
      queryLength: question.query.length
    },
    "answering claimed memory question"
  );
  const workerConfig = resolveManualMemoryAnswerWorkerConfig(
    process.env,
    workerOverridesFromConfig(question.localMemoryWorkerConfig)
  );
  try {
    const evidence = {
      markdown: "",
      evidenceBundle: {
        query: question.query,
        instructions:
          "Use Koed memory RAG tools to gather and judge evidence before answering.",
        evidence: [],
        retrieval: { mode: "app_server_dynamic_tools" }
      }
    };
    const answer = await answerWithMemoryWorker(evidence, {
      config: workerConfig,
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
      answerBridgeLogger[retryable ? "warn" : "error"](
        {
          questionId: question.id,
          attemptCount: question.attemptCount ?? 0,
          maxAttempts: questionAnswerMaxAttempts(),
          retryable,
          skippedReason: answer.localMemoryWorker.skippedReason
        },
        retryable
          ? "memory question synthesis failed; released for retry"
          : "memory question synthesis failed permanently"
      );
      return {
        ok: false,
        question: questionFromResponse(updated),
        error: message
      };
    }
    try {
      await persistAnswerAppServerEvents(client, question, answer);
    } catch (error) {
      answerBridgeLogger.warn(
        {
          err: error,
          questionId: question.id
        },
        "failed to persist app-server telemetry; preserving synthesized answer"
      );
    }
    const updated = await updateQuestionWithAnswer(client, question, answer);
    answerBridgeLogger.info(
      {
        questionId: question.id,
        searchDomain,
        markdownLength: answer.markdown?.length ?? 0,
        evidenceCount: itemCount(evidenceFromAnswer(answer)),
        citationCount: itemCount(citationsFromAnswer(answer))
      },
      "answered memory question"
    );
    return {
      ok: true,
      question: questionFromResponse(updated),
      answer: stripAppServerEvents(answer)
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
    answerBridgeLogger[retryable ? "warn" : "error"](
      {
        err: error,
        questionId: question.id,
        attemptCount: question.attemptCount ?? 0,
        retryable
      },
      retryable
        ? "memory question failed; released for retry"
        : "memory question failed permanently"
    );
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
    if (stopped) {
      answerBridgeLogger.debug(
        { reason },
        "skipping memory question background run because service is stopped"
      );
      return { ran: false, skippedReason: "stopped" as const };
    }
    if (running) {
      answerBridgeLogger.debug(
        { reason },
        "skipping memory question background run because one is already active"
      );
      return { ran: false, skippedReason: "already_running" as const };
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    running = true;
    answerBridgeLogger.debug(
      {
        reason,
        batchLimit: config.batchLimit,
        leaseSeconds: config.leaseSeconds
      },
      "starting memory question background run"
    );
    try {
      const claimed = questionsFromClaimResponse(
        await client.claimPendingQuestions({
          limit: config.batchLimit,
          lease_seconds: config.leaseSeconds
        })
      );
      answerBridgeLogger.info(
        {
          reason,
          claimedCount: claimed.length
        },
        "claimed pending memory questions"
      );
      for (const question of claimed) {
        await answerClaimedMemoryQuestion(client, question, {
          fallbackRetrievalScope: options.fallbackRetrievalScope,
          limit: config.answerLimit
        });
      }
      return { ran: true, processed: claimed.length };
    } catch (error) {
      answerBridgeLogger.error(
        {
          err: error,
          reason
        },
        "memory question background run failed"
      );
      return { ran: true, error: errorMessage(error) };
    } finally {
      running = false;
      schedule(config.intervalMs);
    }
  };

  schedule(config.initialDelayMs);
  answerBridgeLogger.info(
    {
      initialDelayMs: config.initialDelayMs,
      intervalMs: config.intervalMs,
      batchLimit: config.batchLimit,
      leaseSeconds: config.leaseSeconds,
      answerLimit: config.answerLimit
    },
    "memory question background service started"
  );

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      answerBridgeLogger.info("memory question background service stopped");
    },
    trigger: run
  };
};

export const handleAnswerLocal = async (
  request: http.IncomingMessage,
  response: http.ServerResponse
) => {
  const requestContext = bridgeRequestContext(request);
  const token = bearerToken(request);
  if (!token) {
    answerBridgeLogger.warn(
      { requestId: requestContext.id },
      "memory answer bridge request missing bearer token"
    );
    sendJson(request, response, 401, { error: "Bearer API token required" });
    return;
  }

  const input = requestSchema.parse(await readJsonBody(request));
  answerBridgeLogger.debug(
    {
      requestId: requestContext.id,
      hasQuestionId: Boolean(input.question_id),
      searchDomain: input.search_domain,
      hasWorkspaceId: Boolean(input.workspace_id),
      hasSessionId: Boolean(input.session_id),
      queryLength: input.query.length,
      limit: input.limit
    },
    "received local memory answer request"
  );
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
        thread_name: input.thread_name,
        local_memory_worker_config: storedWorkerConfigFromInput(
          input.local_memory_worker_config
        )
      })
    );

  const claimed = questionsFromClaimResponse(
    await client.claimPendingQuestions({
      question_id: questionId,
      limit: 1,
      lease_seconds: answerLocalLeaseSeconds()
    })
  )[0];
  answerBridgeLogger.debug(
    {
      requestId: requestContext.id,
      questionId,
      claimed: Boolean(claimed)
    },
    "claimed local memory answer request question"
  );

  if (!claimed) {
    const existing = questionFromResponse(await client.getQuestion(questionId));
    answerBridgeLogger.info(
      {
        requestId: requestContext.id,
        questionId,
        status: existing.status
      },
      "local memory answer request returned existing question status"
    );
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
    const context = bridgeRequestContext(request);
    answerBridgeLogger.debug(
      {
        request: {
          id: context.id,
          method: context.method,
          path: context.path
        }
      },
      "memory answer bridge request received"
    );
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
            apiUrl: defaultConfig().apiUrl,
            pid: process.pid,
            startedAt: answerBridgeStartedAt,
            backgroundServiceRunning: Boolean(backgroundService)
          });
          return;
        }

        if (
          request.method === "GET" &&
          request.url === "/v1/memory/local-agent-settings"
        ) {
          const token = bearerToken(request);
          if (!token) {
            sendJson(request, response, 401, {
              error: "Bearer API token required"
            });
            return;
          }
          const client = new MemoryApiClient({
            ...defaultConfig(),
            apiToken: token
          });
          await client.accessCheck();
          sendJson(request, response, 200, {
            ok: true,
            ...(await localMemoryAgentSettings(process.env, client))
          });
          return;
        }

        const localAgentSettingsFlowKey =
          localMemoryAgentSettingsFlowKeyFromUrl(request.url);
        if (request.method === "PUT" && localAgentSettingsFlowKey) {
          const token = bearerToken(request);
          if (!token) {
            sendJson(request, response, 401, {
              error: "Bearer API token required"
            });
            return;
          }
          const input = localMemoryAgentSettingsUpdateSchema.parse(
            await readJsonBody(request)
          );
          const client = new MemoryApiClient({
            ...defaultConfig(),
            apiToken: token
          });
          const result = await client.upsertLocalMemoryAgentSetting(
            localAgentSettingsFlowKey,
            {
              provider: input.provider,
              model: input.model,
              reasoningEffort: input.reasoning_effort,
              timeoutMs: input.timeout_ms,
              maxAttempts: input.max_attempts
            }
          );
          sendJson(request, response, 200, { ok: true, ...result });
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
        answerBridgeLogger[errorStatus(error) >= 500 ? "error" : "warn"](
          {
            err: error,
            request: {
              id: context.id,
              method: context.method,
              path: context.path
            }
          },
          "memory answer bridge request failed"
        );
        sendJson(request, response, errorStatus(error), {
          error: errorMessage(error)
        });
      }
    })();
  });
  server.on("listening", () => {
    if (shouldStartBackgroundService && !backgroundService) {
      answerBridgeLogger.info(
        {
          apiUrl: backgroundClientConfig.apiUrl
        },
        "starting memory question background service"
      );
      backgroundService = startPendingQuestionAnswerService(
        new MemoryApiClient(backgroundClientConfig)
      );
    } else if (!shouldStartBackgroundService) {
      answerBridgeLogger.info(
        {
          hasApiToken: Boolean(backgroundClientConfig.apiToken),
          disabled:
            process.env.MEMORY_QUESTION_BACKGROUND_ENABLED?.trim().toLowerCase() ===
            "false"
        },
        "memory question background service not started"
      );
    }
  });
  server.on("close", () => {
    backgroundService?.stop();
    backgroundService = null;
    answerBridgeLogger.info("memory answer bridge closed");
  });
  return server;
};

export const installAnswerBridgeShutdownHandlers = (
  server: http.Server,
  options: AnswerBridgeShutdownOptions = {}
): void => {
  const processLike = options.processLike ?? process;
  const log = options.log ?? answerBridgeLogger;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const forceCloseDelayMs = options.forceCloseDelayMs ?? 5_000;
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals, exitCode: number) => {
    if (shuttingDown) {
      log.warn({ signal }, "memory answer bridge forced shutdown requested");
      server.closeAllConnections?.();
      exit(exitCode);
      return;
    }
    shuttingDown = true;
    log.info(
      {
        signal,
        forceCloseDelayMs
      },
      "memory answer bridge shutdown requested"
    );

    const forceCloseTimer = setTimeoutFn(() => {
      log.warn(
        {
          signal,
          forceCloseDelayMs
        },
        "memory answer bridge forcing open connections closed"
      );
      server.closeAllConnections?.();
      exit(exitCode);
    }, forceCloseDelayMs);
    forceCloseTimer.unref?.();

    server.close((error) => {
      clearTimeoutFn(forceCloseTimer);
      if (error) {
        log.error(
          {
            err: error,
            signal
          },
          "memory answer bridge shutdown failed"
        );
        exit(1);
        return;
      }
      log.info({ signal }, "memory answer bridge shutdown complete");
      exit(exitCode);
    });
    server.closeIdleConnections?.();
  };

  processLike.once("SIGINT", () => shutdown("SIGINT", 130));
  processLike.once("SIGTERM", () => shutdown("SIGTERM", 143));
};

export const probeExistingAnswerBridge = async (
  bridgeHost: string,
  bridgePort: number,
  fetchFn: typeof fetch = fetch,
  timeoutMs = DEFAULT_EXISTING_ANSWER_BRIDGE_PROBE_TIMEOUT_MS
): Promise<ExistingAnswerBridgeProbeResult> => {
  const healthUrl = answerBridgeHealthUrl(bridgeHost, bridgePort);
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchFn(healthUrl, {
      signal: abortController.signal
    });
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return {
      ok:
        response.ok &&
        payload.ok === true &&
        payload.service === "koed-memory-answer-bridge",
      healthUrl,
      payload
    };
  } catch (error) {
    return {
      ok: false,
      healthUrl,
      error: errorMessage(error)
    };
  } finally {
    clearTimeout(timeout);
  }
};

export const startStandaloneAnswerBridge = (
  options: StandaloneAnswerBridgeOptions = {}
): http.Server | null => {
  const log = options.log ?? answerBridgeLogger;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const configuredPort =
    options.port ??
    parseAnswerBridgePort(process.env.MEMORY_ANSWER_BRIDGE_PORT);
  if (!configuredPort) {
    log.error(
      {
        configuredPort: process.env.MEMORY_ANSWER_BRIDGE_PORT
      },
      "invalid MEMORY_ANSWER_BRIDGE_PORT; expected an integer from 1 to 65535"
    );
    exit(1);
    return null;
  }

  const bridgeHost = options.host ?? host;
  const createServer = options.createServer ?? createAnswerBridgeServer;
  const installShutdownHandlers =
    options.installShutdownHandlers ?? installAnswerBridgeShutdownHandlers;
  const server = createServer();
  installShutdownHandlers(server, {
    exit,
    log
  });
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") {
      log.error(
        {
          err: error,
          host: bridgeHost,
          port: configuredPort
        },
        "memory answer bridge failed"
      );
      exit(1);
      return;
    }

    void (async () => {
      const existing = await probeExistingAnswerBridge(
        bridgeHost,
        configuredPort,
        options.fetchFn,
        options.existingBridgeProbeTimeoutMs
      );
      if (existing.ok) {
        log.info(
          {
            host: bridgeHost,
            port: configuredPort,
            healthUrl: existing.healthUrl,
            apiUrl: existing.payload?.apiUrl
          },
          "memory answer bridge already running; using existing service"
        );
        exit(0);
        return;
      }

      log.error(
        {
          err: error,
          host: bridgeHost,
          port: configuredPort,
          healthUrl: existing.healthUrl,
          existingService: existing.payload?.service,
          probeError: existing.error
        },
        "memory answer bridge port already in use by an incompatible service"
      );
      exit(1);
    })();
  });
  server.listen(configuredPort, bridgeHost, () => {
    log.info(
      {
        host: bridgeHost,
        port: configuredPort,
        url: `http://${bridgeHost}:${configuredPort}`
      },
      "memory answer bridge listening"
    );
  });
  return server;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startStandaloneAnswerBridge();
}
