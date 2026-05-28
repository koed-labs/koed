import { resolveMemoryAnswerWorkerConfig } from "./answer-worker.js";
import type { LcmSummaryServiceHandle } from "./lcm-summary-service.js";
import { resolveLcmSummaryServiceConfig } from "./lcm-summary-service.js";
import {
  lcmSummaryLockState,
  resolveLcmSummaryWorkerConfig
} from "./lcm-summary-worker.js";

export type RetrievalScope = "personal";

export interface McpServerConfig {
  apiUrl: string;
  apiToken?: string;
  requestTimeoutMs?: number;
}

export interface AccessCheckResult {
  ok: boolean;
  auth: "bearer_api_token";
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  canWritePersonal: boolean;
  providerConfigSupported?: boolean;
  embeddingRetrieval?: {
    enabled: boolean;
    healthy: boolean;
    model: string | null;
    dimensions: number | null;
    error?: string;
  };
}

export interface MemoryAccessCheckResult extends AccessCheckResult {
  server: string;
  configuredApiUrl: string;
  hasApiToken: boolean;
  defaultAutomaticCaptureScope: "personal";
  defaultAnswerScope: RetrievalScope;
  mcpTransport: "stdio";
  codexCanCallTools: boolean;
  automaticDiscussionCapture: "not_via_mcp";
  captureFallback: "codex_lifecycle_hooks_transcript_path";
  exposedTools: MemoryToolName[];
  diagnosticMemoryToolsExposed: boolean;
  lowLevelMemoryToolsExposed: boolean;
  localMemoryAnswerWorker: {
    provider: string;
    model: string;
    reasoningEffort: string;
    planningMode: "planned" | "single_pass";
    maxSearches: number;
    maxExpansions: number;
    appServerBinary: string;
    defaultResponseDetail: "answer_only";
  };
  localLcmSummaryWorker: {
    provider: string;
    model: string;
    reasoningEffort: string;
    concurrency: number;
    maxPromptTokens: number;
    appServerBinary: string;
  };
  localLcmSummaryService: {
    initialDelayMs: number;
    pushDelayMs: number;
    intervalMs: number;
    batchLimit: number;
  };
  localLcmSummaryDiagnostics: {
    running: boolean;
    locked: boolean;
    pendingCount: number | null;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  };
  notes: string[];
}

export interface ToolExposureConfig {
  exposeDiagnosticMemoryTools: boolean;
  exposeLowLevelMemoryTools: boolean;
}

export const defaultTools = ["memory_answer"] as const;

export const memoryServerInstructions =
  "Koed memory retrieves and answers from the user's captured Codex history. Use Koed memory when the user asks about prior conversations, previous project decisions, remembered preferences, user-provided facts, earlier setup/debugging work, saved sessions, or whether something was discussed before. Default to project scope for project history, project decisions, setup choices, and repo-specific context. Use session scope for a specific saved conversation/thread, exact-session recap, or a question that names this session when a backend session_id is available. Use global scope only for cross-project, anywhere, broad personal-history, or not-sure-which-project questions. Make at most one memory_answer call per distinct topic unless the first result is clearly incomplete, the user asks for source detail, or the answer needs a different scope. Do not keep querying memory after a clear not-found result. Even if something seems familiar from current context, use Koed memory to verify prior decisions, exact recaps, or remembered preferences when the relevant detail may have been compacted, summarized, or omitted. Do not use Koed memory for public facts, current visible context, generic coding knowledge, or tasks answerable from files/messages already provided.";

export const memoryAnswerToolDescription =
  "Answer a question from Koed memory: captured Codex conversations, saved sessions, project history, prior decisions, remembered user preferences, user-provided facts, setup/debugging work, and past discussions. Call this tool for recall-style requests such as 'what did we decide', 'remind me', 'previously', 'ever discussed', 'do I usually', 'in that session', or 'look back'. Do not call it for public facts, current visible context, generic programming knowledge, or direct file-editing tasks. Use one concise query per distinct topic and do not repeat after a clear not-found answer. Default to search_domain=project for current workspace/project history; use search_domain=session for a known saved conversation/thread, and search_domain=global only for broad cross-project/personal-history recall. Defaults to response_detail=answer_only; use with_citations only when the user asks to verify sources, and with_evidence only for debugging or UI inspection.";

export const diagnosticMemoryTools = ["memory_access_check"] as const;

export const lowLevelMemoryTools = ["memory_search", "memory_expand"] as const;

export const allTools = [
  ...defaultTools,
  ...diagnosticMemoryTools,
  ...lowLevelMemoryTools
] as const;

export type MemoryToolName = (typeof allTools)[number];

export const resolveToolExposureConfig = (
  env: NodeJS.ProcessEnv = process.env
): ToolExposureConfig => ({
  exposeDiagnosticMemoryTools:
    env.MEMORY_EXPOSE_DIAGNOSTIC_MEMORY_TOOLS?.trim().toLowerCase() === "true",
  exposeLowLevelMemoryTools:
    env.MEMORY_EXPOSE_LOW_LEVEL_MEMORY_TOOLS?.trim().toLowerCase() === "true"
});

export const exposedTools = (
  config: ToolExposureConfig = resolveToolExposureConfig()
): MemoryToolName[] => [
  ...defaultTools,
  ...(config.exposeDiagnosticMemoryTools ? diagnosticMemoryTools : []),
  ...(config.exposeLowLevelMemoryTools ? lowLevelMemoryTools : [])
];

export const requiredTools = defaultTools;

export const normalizeApiUrl = (apiUrl: string): string =>
  apiUrl.replace(/\/+$/, "");

export const defaultConfig = (): McpServerConfig => ({
  apiUrl: process.env.MEMORY_API_URL ?? "http://localhost:3000",
  apiToken: process.env.MEMORY_API_TOKEN,
  requestTimeoutMs: positiveIntEnv("MEMORY_API_REQUEST_TIMEOUT_MS", 4_000)
});

const positiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export class MemoryApiError extends Error {
  readonly status?: number;
  readonly payload?: unknown;

  constructor(
    message: string,
    options: { status?: number; payload?: unknown } = {}
  ) {
    super(message);
    this.name = "MemoryApiError";
    this.status = options.status;
    this.payload = options.payload;
  }
}

export class MemoryApiClient {
  readonly config: McpServerConfig;

  constructor(config: McpServerConfig = defaultConfig()) {
    this.config = { ...config, apiUrl: normalizeApiUrl(config.apiUrl) };
  }

  async accessCheck(): Promise<AccessCheckResult> {
    return this.request<AccessCheckResult>("GET", "/v1/access/check");
  }

  async createSession(
    input: Record<string, unknown>
  ): Promise<{ session?: { id: string }; skipped?: boolean }> {
    return this.request("POST", "/v1/sessions", input);
  }

  async effectiveCapturePolicy(input: {
    projectId?: string;
    threadId?: string;
    sessionId?: string;
  }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (value) {
        params.set(key, value);
      }
    }
    const query = params.toString();
    return this.request(
      "GET",
      `/v1/capture-policy/effective${query ? `?${query}` : ""}`
    );
  }

  async capturePersonalEvent(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/capture-personal-event", input);
  }

  async createConversationItems(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/conversation-items", input);
  }

  async recordTokenUsage(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/token-usage", input);
  }

  async projectConversationItems(
    input: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/conversation-items/project", input);
  }

  async answer(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/answer", input);
  }

  async createQuestion(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/questions", input);
  }

  async getQuestion(questionId: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v1/memory/questions/${encodeURIComponent(questionId)}`
    );
  }

  async claimPendingQuestions(
    input: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/questions/claim-pending", input);
  }

  async updateQuestion(
    questionId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "PATCH",
      `/v1/memory/questions/${encodeURIComponent(questionId)}`,
      input
    );
  }

  async search(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/search", input);
  }

  async expand(nodeId: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v1/memory/nodes/${encodeURIComponent(nodeId)}/expand`
    );
  }

  async listPendingLcmSummaries(
    input: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (typeof input.limit === "string" || typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    const query = params.toString();
    return this.request(
      "GET",
      `/v1/memory/lcm/summaries/pending${query ? `?${query}` : ""}`
    );
  }

  async submitLcmSummary(
    nodeId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/memory/lcm/summaries/${encodeURIComponent(nodeId)}`,
      input
    );
  }

  async graphOverview(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/memory/graph/overview");
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown
  ): Promise<T> {
    if (!this.config.apiToken) {
      throw new MemoryApiError(
        "Memory API token is not configured. Set MEMORY_API_TOKEN and MEMORY_API_URL before starting the MCP server or Capture Hook.",
        { status: 401 }
      );
    }

    let response: Response;
    try {
      const signal =
        this.config.requestTimeoutMs && this.config.requestTimeoutMs > 0
          ? AbortSignal.timeout(this.config.requestTimeoutMs)
          : undefined;
      response = await fetch(`${this.config.apiUrl}${path}`, {
        method,
        signal,
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new MemoryApiError(
        timedOut
          ? `Memory API request to ${this.config.apiUrl}${path} timed out after ${this.config.requestTimeoutMs}ms.`
          : `Could not reach memory API at ${this.config.apiUrl}. Set MEMORY_API_URL to the backend URL and verify it is running.`,
        { payload: error instanceof Error ? error.message : String(error) }
      );
    }

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (!response.ok) {
      const setupHint =
        response.status === 401
          ? " Check MEMORY_API_TOKEN; /v1/* endpoints require a bearer API token, not a web session cookie."
          : response.status === 403
            ? " The authenticated user is not allowed to perform that memory operation."
            : "";
      const message = `${payload.error ?? `Memory API request failed with status ${response.status}.`}${setupHint}`;
      throw new MemoryApiError(message, {
        status: response.status,
        payload
      });
    }

    return payload as T;
  }
}

export const defaultAnswerScope = (
  access: AccessCheckResult,
  env: NodeJS.ProcessEnv = process.env
): RetrievalScope => {
  void access;
  void env;
  return "personal";
};

export const memoryAccessCheck = async (
  client = new MemoryApiClient(),
  includeNotes = true,
  options: { lcmSummaryService?: LcmSummaryServiceHandle | null } = {}
): Promise<MemoryAccessCheckResult> => {
  const access = await client.accessCheck();
  const answerWorker = resolveMemoryAnswerWorkerConfig();
  const lcmSummaryWorker = resolveLcmSummaryWorkerConfig();
  const lcmSummaryService = resolveLcmSummaryServiceConfig();
  const toolExposure = resolveToolExposureConfig();
  const lcmSnapshot = options.lcmSummaryService?.snapshot();
  const lock = lcmSummaryLockState(
    lcmSummaryWorker.env,
    Math.max(lcmSummaryWorker.timeoutMs * lcmSummaryWorker.maxAttempts, 60_000)
  );
  const pendingCount = await client
    .graphOverview()
    .then((overview) => {
      const diagnostics = (
        overview.overview as Record<string, unknown> | undefined
      )?.pendingLcmDiagnostics as Record<string, unknown> | undefined;
      const count = diagnostics?.pendingCount;
      return typeof count === "number" ? count : null;
    })
    .catch(() => null);
  return {
    ...access,
    server: "@koed/mcp-server",
    configuredApiUrl: client.config.apiUrl,
    hasApiToken: Boolean(client.config.apiToken),
    defaultAutomaticCaptureScope: "personal",
    defaultAnswerScope: defaultAnswerScope(access),
    mcpTransport: "stdio",
    codexCanCallTools: true,
    automaticDiscussionCapture: "not_via_mcp",
    captureFallback: "codex_lifecycle_hooks_transcript_path",
    exposedTools: exposedTools(toolExposure),
    diagnosticMemoryToolsExposed: toolExposure.exposeDiagnosticMemoryTools,
    lowLevelMemoryToolsExposed: toolExposure.exposeLowLevelMemoryTools,
    localMemoryAnswerWorker: {
      provider: answerWorker.provider,
      model: answerWorker.model,
      reasoningEffort: answerWorker.reasoningEffort,
      planningMode: answerWorker.planningMode,
      maxSearches: answerWorker.maxSearches,
      maxExpansions: answerWorker.maxExpansions,
      appServerBinary: answerWorker.appServerBinary,
      defaultResponseDetail: "answer_only"
    },
    localLcmSummaryWorker: {
      provider: lcmSummaryWorker.provider,
      model: lcmSummaryWorker.model,
      reasoningEffort: lcmSummaryWorker.reasoningEffort,
      concurrency: lcmSummaryWorker.concurrency,
      maxPromptTokens: lcmSummaryWorker.maxPromptTokens,
      appServerBinary: lcmSummaryWorker.appServerBinary
    },
    localLcmSummaryService: lcmSummaryService,
    localLcmSummaryDiagnostics: {
      running: lcmSnapshot?.running ?? false,
      locked: lock.locked || (lcmSnapshot?.running ?? false),
      pendingCount,
      lastRunAt: lcmSnapshot?.lastRunAt ?? null,
      lastSuccessAt: lcmSnapshot?.lastSuccessAt ?? null,
      lastError: lcmSnapshot?.lastError ?? null
    },
    notes: includeNotes
      ? [
          "Store normal Codex/Codex CLI conversation context as personal memory through Codex hooks/transcript ingestion. The backend does not decide that a fact is important and create a separate extracted memory.",
          "MCP alone does not automatically observe the whole conversation; the main-agent MCP surface is for retrieval and local summarisation.",
          "Use memory_answer as the normal retrieval entry point. It defaults to response_detail=answer_only and search_domain=project for the current Codex workspace/cwd; use response_detail=with_citations for source metadata, response_detail=with_evidence only for debugging/UI inspection, search_domain=session with a backend session_id for one conversation, or search_domain=global only for deliberate cross-project memory checks.",
          "MCP recall is personal-only in this build. search_domain controls the search boundary (session, project, or global).",
          "Low-level memory_search/memory_expand tools are hidden by default so the main agent delegates retrieval planning to the local memory-answer worker.",
          "Backend LLM provider configuration is unsupported in this build. The backend retrieves cited evidence with local semantic embeddings; the local MCP memory-answer worker can plan follow-up searches/expansions and synthesize the final answer through the user's Codex CLI subscription.",
          "LCM summarisation is local-only: backend workers create pending LCM nodes, while the MCP background LCM summary service runs Codex on the user's machine and submits summaries back for embedding.",
          "When answering from memory, cite each source."
        ]
      : []
  };
};
