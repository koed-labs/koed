import { resolveMemoryAnswerWorkerConfig } from "./answer-worker.js";
import { resolveLcmSummaryServiceConfig } from "./lcm-summary-service.js";
import { resolveLcmSummaryWorkerConfig } from "./lcm-summary-worker.js";

export type RetrievalScope = "personal" | "personal+team";

export interface McpServerConfig {
  apiUrl: string;
  apiToken?: string;
}

export interface AccessCheckResult {
  ok: boolean;
  auth: "bearer_api_token";
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  currentTeam: {
    id: string;
    name: string;
    inviteCode: string | null;
    role?: string;
  } | null;
  canWritePersonal: boolean;
  canWriteTeam: boolean;
  enabledProviderConfigs: number;
  memoryMode?: "codex_subscription" | "server_synthesis";
  providerConfigRequired?: boolean;
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
  lowLevelMemoryToolsExposed: boolean;
  localMemoryAnswerWorker: {
    provider: string;
    model: string;
    reasoningEffort: string;
    planningMode: "planned" | "single_pass";
    maxSearches: number;
    maxExpansions: number;
    codexBinary: string;
  };
  localLcmSummaryWorker: {
    provider: string;
    model: string;
    reasoningEffort: string;
    concurrency: number;
    maxPromptTokens: number;
    codexBinary: string;
  };
  localLcmSummaryService: {
    enabled: boolean;
    initialDelayMs: number;
    pushDelayMs: number;
    intervalMs: number;
    batchLimit: number;
  };
  notes: string[];
}

export interface ToolExposureConfig {
  exposeLowLevelMemoryTools: boolean;
}

const configuredDefaultRetrievalScope = (
  env: NodeJS.ProcessEnv = process.env
): RetrievalScope => {
  const value = env.MEMORY_DEFAULT_RETRIEVAL_SCOPE?.trim().toLowerCase();
  return value === "personal+team" ? "personal+team" : "personal";
};

export const defaultTools = [
  "memory_access_check",
  "memory_answer",
  "memory_lcm_summarize_pending"
] as const;

export const lowLevelMemoryTools = ["memory_search", "memory_expand"] as const;

export const allTools = [...defaultTools, ...lowLevelMemoryTools] as const;

export type MemoryToolName = (typeof allTools)[number];

export const resolveToolExposureConfig = (
  env: NodeJS.ProcessEnv = process.env
): ToolExposureConfig => ({
  exposeLowLevelMemoryTools:
    env.MEMORY_EXPOSE_LOW_LEVEL_MEMORY_TOOLS?.trim().toLowerCase() === "true"
});

export const exposedTools = (
  config: ToolExposureConfig = resolveToolExposureConfig()
): MemoryToolName[] => [
  ...defaultTools,
  ...(config.exposeLowLevelMemoryTools ? lowLevelMemoryTools : [])
];

export const requiredTools = defaultTools;

export const normalizeApiUrl = (apiUrl: string): string =>
  apiUrl.replace(/\/+$/, "");

export const defaultConfig = (): McpServerConfig => ({
  apiUrl:
    process.env.MEMORY_API_URL ??
    process.env.CODEX_MEMORY_BASE_URL ??
    process.env.CODEX_MEMORY_API_URL ??
    "http://localhost:3000",
  apiToken: process.env.MEMORY_API_TOKEN ?? process.env.CODEX_MEMORY_API_TOKEN
});

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

  async answer(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/answer", input);
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

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    if (!this.config.apiToken) {
      throw new MemoryApiError(
        "Memory API token is not configured. Set MEMORY_API_TOKEN and MEMORY_API_URL before starting the MCP server.",
        { status: 401 }
      );
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new MemoryApiError(
        `Could not reach memory API at ${this.config.apiUrl}. Set MEMORY_API_URL to the backend URL and verify it is running.`,
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
): RetrievalScope =>
  configuredDefaultRetrievalScope(env) === "personal+team" && access.currentTeam
    ? "personal+team"
    : "personal";

export const memoryAccessCheck = async (
  client = new MemoryApiClient(),
  includeNotes = true
): Promise<MemoryAccessCheckResult> => {
  const access = await client.accessCheck();
  const answerWorker = resolveMemoryAnswerWorkerConfig();
  const lcmSummaryWorker = resolveLcmSummaryWorkerConfig();
  const lcmSummaryService = resolveLcmSummaryServiceConfig();
  const toolExposure = resolveToolExposureConfig();
  return {
    ...access,
    server: "@codex-memory/mcp-server",
    configuredApiUrl: client.config.apiUrl,
    hasApiToken: Boolean(client.config.apiToken),
    defaultAutomaticCaptureScope: "personal",
    defaultAnswerScope: defaultAnswerScope(access),
    mcpTransport: "stdio",
    codexCanCallTools: true,
    automaticDiscussionCapture: "not_via_mcp",
    captureFallback: "codex_lifecycle_hooks_transcript_path",
    exposedTools: exposedTools(toolExposure),
    lowLevelMemoryToolsExposed: toolExposure.exposeLowLevelMemoryTools,
    localMemoryAnswerWorker: {
      provider: answerWorker.provider,
      model: answerWorker.model,
      reasoningEffort: answerWorker.reasoningEffort,
      planningMode: answerWorker.planningMode,
      maxSearches: answerWorker.maxSearches,
      maxExpansions: answerWorker.maxExpansions,
      codexBinary: answerWorker.codexBinary
    },
    localLcmSummaryWorker: {
      provider: lcmSummaryWorker.provider,
      model: lcmSummaryWorker.model,
      reasoningEffort: lcmSummaryWorker.reasoningEffort,
      concurrency: lcmSummaryWorker.concurrency,
      maxPromptTokens: lcmSummaryWorker.maxPromptTokens,
      codexBinary: lcmSummaryWorker.codexBinary
    },
    localLcmSummaryService: lcmSummaryService,
    notes: includeNotes
      ? [
          "Store normal Codex/Codex CLI conversation context as personal memory through Codex hooks/transcript ingestion. The backend does not decide that a fact is important and create a separate extracted memory.",
          "MCP alone does not automatically observe the whole conversation; the main-agent MCP surface is for retrieval and local summarisation.",
          "Use memory_answer as the normal retrieval entry point. It defaults to search_domain=project for the current Codex workspace/cwd; use search_domain=session with a backend session_id for one conversation, or search_domain=global only for deliberate cross-project memory checks.",
          "Set MEMORY_DEFAULT_RETRIEVAL_SCOPE=personal+team to make this MCP read personal plus team memory when the authenticated user belongs to a team. The default is personal.",
          "retrieval_scope controls visibility (personal or personal+team). search_domain controls the search boundary (session, project, or global). Keep these choices independent.",
          "Low-level memory_search/memory_expand tools are hidden by default so the main agent delegates retrieval planning to the local memory-answer worker.",
          "Provider config is optional in codex_subscription mode. The backend retrieves cited evidence with local semantic embeddings; the local MCP memory-answer worker can plan follow-up searches/expansions and synthesize the final answer through the user's Codex CLI subscription.",
          "LCM summarisation is local-only: backend workers create pending LCM nodes, while the MCP background LCM summary service and memory_lcm_summarize_pending run Codex on the user's machine and submit summaries back for embedding.",
          "When answering from memory, cite whether each source is personal or team."
        ]
      : []
  };
};
