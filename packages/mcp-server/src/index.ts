import {
  answerWithMemoryWorker,
  resolveMemoryAnswerWorkerConfig,
  type MemoryAnswerRetrievalClient,
  type MemoryAnswerEvaluationController,
  type MemoryAnswerWorkerConfig,
  type MemoryAnswerWorkerResponse
} from "./answer-worker.js";
import type { AiClientModelCapability } from "@koed/shared";
import type { LcmSummaryServiceHandle } from "./lcm-summary-service.js";
export {
  aiClientInstanceRegistryPath,
  environmentForLocalAiClientInstance,
  loadLocalAiClientInstanceRegistry,
  localAiClientInstanceConfigIdentity,
  resolveConfiguredLocalAiClientInstance,
  resolveLocalAiClientInstance
} from "./ai-client-instance-registry.js";
export type { LocalAiClientInstanceConfiguration } from "./ai-client-instance-registry.js";
export {
  publishAiClientCapabilities,
  startAiClientCapabilityPublisher
} from "./ai-client-capability-publisher.js";
export type {
  AiClientCapabilityPublication,
  AiClientCapabilityPublisherHandle
} from "./ai-client-capability-publisher.js";
export {
  aiClientDriverFor,
  aiClientDriverRegistry,
  aiClientTaskDriverFor,
  checkClaudeCodeAvailability,
  checkPiAvailability,
  listClaudeAgentSdkModels,
  listPiModels,
  resolveClaudeSdkExecutablePath,
  resolvePiExecutable,
  runClaudeAgentSdkTask,
  type AiClientDriver,
  type AiClientDriverDiscovery,
  type AiClientDriverDiscoveryInput
} from "./ai-client-runner.js";
export {
  checkCodexAppServerAvailability,
  destroyManagedCodexHome,
  prepareManagedCodexHome,
  reuseManagedCodexHome,
  runCodexAppServerJsonTask
} from "./codex-app-server-runner.js";
export { assertCodexConversationProtocolCompatibility } from "./codex-app-server-protocol-compatibility.js";
export type { CodexConversationProtocolCompatibility } from "./codex-app-server-protocol-compatibility.js";
export {
  adaptCodexTranscriptV1,
  codexTranscriptAdapterVersion,
  codexTranscriptItemKey,
  codexTranscriptRecordHash,
  type CodexTranscriptAdapterInput,
  type CodexTranscriptObservation,
  type CodexTranscriptRawItem
} from "./codex-transcript-adapter.js";
export type {
  CodexAppServerJsonTaskConfig,
  CodexAppServerProcessMetrics,
  CodexAppServerRunResult
} from "./codex-app-server-runner.js";
export {
  CodexManagedConversationIdentityError,
  CodexManagedConversationSession
} from "./codex-managed-conversation.js";
export type {
  CodexManagedConversationConfig,
  CodexManagedConversationSealedSource,
  CodexManagedConversationStartResult
} from "./codex-managed-conversation.js";
export {
  CLAUDE_MANAGED_CONVERSATION_PROVIDER,
  ClaudeManagedConversationCancelledError,
  ClaudeManagedConversationSession,
  createManagedClaudeSessionStore,
  destroyManagedClaudeHome,
  forkClaudeTranscript,
  prepareManagedClaudeHome,
  releaseManagedClaudeHomeLease,
  retainManagedClaudeHome,
  reuseManagedClaudeHome,
  resolveClaudeManagedConversationSource
} from "./claude-managed-conversation.js";
export {
  discoverClaudeHistoricalTranscriptSignals,
  processClaudeTranscriptSignal,
  registerClaudeHistoricalTranscriptSources,
  startClaudeTranscriptWatcher
} from "./claude-transcript-watcher.js";
export {
  importClaudeHistoricalSource,
  importSelectedClaudeHistory
} from "./claude-historical-import.js";
export {
  discoverPiTranscriptSignals,
  piSessionRoots,
  processPiTranscriptSignal,
  startPiTranscriptWatcher
} from "./pi-transcript-watcher.js";
export { parsePiSessionJournalBytes } from "./pi-session-parser.js";
export {
  importPiHistoricalSource,
  importSelectedPiHistory,
  registerPiHistoricalTranscriptSource
} from "./pi-historical-import.js";
export type {
  ClaudeTranscriptWatcherHandle,
  ClaudeWatcherState
} from "./claude-transcript-watcher.js";
export type {
  ClaudeManagedConversationConfig,
  ClaudeManagedConversationIdentity,
  ClaudeManagedConversationLocalSource,
  ClaudeManagedConversationResult,
  ClaudeManagedConversationStartResult,
  ForkedClaudeTranscript
} from "./claude-managed-conversation.js";
import { resolveLcmSummaryServiceConfig } from "./lcm-summary-service.js";
import {
  lcmSummaryLockState,
  resolveLcmSummaryWorkerConfig
} from "./lcm-summary-worker.js";
export type {
  SessionTitleTelemetry,
  SessionTitleTelemetryObserver
} from "./session-title-worker.js";
import { loadPrompt } from "./prompt-loader.js";
import { resolveCuratedMemoryReviewConfig } from "./curated-memory-review-worker.js";
export {
  CURATED_MEMORY_REVIEW_PROMPT_VERSION,
  buildCuratedMemoryReviewPrompt,
  curatedMemoryReviewDecisionSchema,
  resolveCuratedMemoryReviewConfig,
  reviewCuratedMemoryProposal,
  runCuratedMemoryReview
} from "./curated-memory-review-worker.js";
export type {
  CuratedMemoryReviewBundle,
  CuratedMemoryReviewConfig,
  CuratedMemoryReviewDecision,
  CuratedMemoryReviewResult
} from "./curated-memory-review-worker.js";
export {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  buildLcmSummaryPrompt,
  executeLcmSummaryNode,
  parseStructuredLcmSummary,
  runLcmSummary,
  runLcmSummaryPromptWithRetries,
  resolveLcmSummaryWorkerConfig
} from "./lcm-summary-worker.js";
export type {
  LcmSummaryRunner,
  LcmSummaryNodeExecution,
  LcmSummaryNode,
  LcmSummaryPromptResult,
  LcmSummaryWorkerConfig,
  StructuredLcmSummary,
  VersionedLcmSummaryPromptResult
} from "./lcm-summary-worker.js";

export type RetrievalScope = "personal";

export { answerWithMemoryWorker, resolveMemoryAnswerWorkerConfig };
export type {
  MemoryAnswerEvaluationController,
  MemoryAnswerRetrievalClient,
  MemoryAnswerWorkerConfig,
  MemoryAnswerWorkerResponse
};
export {
  PROMPT_OVERRIDE_DIR_ENV,
  loadPrompt,
  renderPrompt,
  renderPromptTemplate,
  type LoadedPrompt,
  type PromptId,
  type PromptLoadOptions
} from "./prompt-loader.js";

export interface McpServerConfig {
  apiUrl: string;
  apiToken?: string;
  requestTimeoutMs?: number;
}

export type LocalMemoryAgentFlowKey =
  | "mcp_memory_answer"
  | "manual_memory_answer"
  | "lcm_summary"
  | "curated_memory_review"
  | "session_title";

export interface LocalMemoryAgentSettingRecord {
  ownerUserId: string;
  flowKey: LocalMemoryAgentFlowKey;
  provider: string;
  aiClientInstanceId: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export const localMemoryAgentSettingFor = (
  settings: LocalMemoryAgentSettingRecord[],
  flowKey: LocalMemoryAgentFlowKey
): LocalMemoryAgentSettingRecord | undefined =>
  settings.find((setting) => setting.flowKey === flowKey);

export const workerOverridesFromLocalMemorySetting = (
  setting: LocalMemoryAgentSettingRecord | undefined
):
  | {
      provider: "codex" | "claude" | "pi";
      aiClientInstanceId: string;
      model: string;
      reasoningEffort: string;
      timeoutMs: number;
      maxAttempts: number;
    }
  | undefined =>
  setting
    ? setting.provider === "codex" ||
      setting.provider === "claude" ||
      setting.provider === "pi"
      ? {
          provider: setting.provider,
          aiClientInstanceId: setting.aiClientInstanceId,
          model: setting.model,
          reasoningEffort: setting.reasoningEffort,
          timeoutMs: setting.timeoutMs,
          maxAttempts: setting.maxAttempts
        }
      : (() => {
          throw new Error(
            `AI Client driver "${setting.provider}" is not available in this Koed build.`
          );
        })()
    : undefined;

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
  capturePath: "journaled_codex_transcript";
  exposedTools: MemoryToolName[];
  diagnosticMemoryToolsExposed: boolean;
  lowLevelMemoryToolsExposed: boolean;
  localMemoryAnswerWorker: {
    provider: string;
    model: string;
    reasoningEffort: string;
    timeoutMs: number;
    maxAttempts: number;
    maxSearches: number;
    maxExpansions: number;
    executablePath: string;
    defaultResponseDetail: "answer_only";
  };
  localLcmSummaryWorker: {
    provider: string;
    model: string;
    reasoningEffort: string;
    timeoutMs: number;
    maxAttempts: number;
    retryDelayMs: number;
    concurrency: number;
    maxPromptTokens: number;
    executablePath: string;
  };
  localLcmSummaryService: {
    initialDelayMs: number;
    pushDelayMs: number;
    intervalMs: number;
    batchLimit: number;
    titleBatchLimit: number;
    titleMinUserEvents: number;
  };
  localLcmSummaryDiagnostics: {
    running: boolean;
    locked: boolean;
    pendingCount: number | null;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  };
  localCuratedMemoryReviewWorker: {
    provider: string;
    model: string;
    reasoningEffort: string;
    timeoutMs: number;
    maxAttempts: number;
    maxPromptTokens: number;
    executablePath: string;
  };
  localCuratedMemoryReviewDiagnostics: {
    running: boolean;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    lastResult: unknown;
  };
  notes: string[];
}

export interface ToolExposureConfig {
  exposeDiagnosticMemoryTools: boolean;
  exposeLowLevelMemoryTools: boolean;
}

export interface BackendToolCapabilities {
  curatedMemoryIntakeAvailable: boolean;
}

export const unavailableBackendToolCapabilities: BackendToolCapabilities = {
  curatedMemoryIntakeAvailable: false
};

export const defaultTools = ["memory_answer"] as const;

export const capabilityGatedTools = ["memory_intake_propose"] as const;

const memoryServerInstructionsPrompt = loadPrompt("mcp-server-instructions");
const memoryAnswerToolDescriptionPrompt = loadPrompt(
  "memory-answer-tool-description"
);

export const memoryServerInstructions = memoryServerInstructionsPrompt.body;
export const memoryServerInstructionsVersion =
  memoryServerInstructionsPrompt.version;
export const memoryAnswerToolDescription =
  memoryAnswerToolDescriptionPrompt.body;
export const memoryAnswerToolDescriptionVersion =
  memoryAnswerToolDescriptionPrompt.version;
export const mcpRecallPolicyVersion = `${memoryServerInstructionsVersion}+${memoryAnswerToolDescriptionVersion}`;

export const memoryIntakeProposeToolDescription =
  "Propose durable Curated Memory when the user provides stable personal or project information such as preferences, corrections, decisions, plans, relationships, or other reusable context. Submit a concise candidate and real source evidence. When source IDs or a backend Captured Session ID are unavailable, include the exact supporting User statement in evidence_exact_quote so Koed can bind the proposal without guessing across sessions. An asynchronous local review agent receives the complete evidence, decides whether it is supported and durable, rewrites accepted assertions clearly, and handles duplicates or corrections. The proposal call returns immediately. Do not propose public facts, transient task state, guesses, agent-authored claims, or information without source evidence.";

export const diagnosticMemoryTools = ["memory_access_check"] as const;

export const lowLevelMemoryTools = ["memory_search", "memory_expand"] as const;

export const allTools = [
  ...defaultTools,
  ...capabilityGatedTools,
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
  config: ToolExposureConfig = resolveToolExposureConfig(),
  capabilities: BackendToolCapabilities = unavailableBackendToolCapabilities
): MemoryToolName[] => [
  ...defaultTools,
  ...(capabilities.curatedMemoryIntakeAvailable ? capabilityGatedTools : []),
  ...(config.exposeDiagnosticMemoryTools ? diagnosticMemoryTools : []),
  ...(config.exposeLowLevelMemoryTools ? lowLevelMemoryTools : [])
];

export const requiredTools = defaultTools;

export const backendToolCapabilitiesFrom = (
  payload: unknown
): BackendToolCapabilities => {
  if (!payload || typeof payload !== "object") {
    return unavailableBackendToolCapabilities;
  }
  const response = payload as {
    capabilitySchemaVersion?: unknown;
    capabilities?: unknown;
  };
  if (
    typeof response.capabilitySchemaVersion !== "number" ||
    response.capabilitySchemaVersion < 4 ||
    !response.capabilities ||
    typeof response.capabilities !== "object"
  ) {
    return unavailableBackendToolCapabilities;
  }
  const descriptor = (
    response.capabilities as Record<string, { availability?: unknown }>
  )["memory.curatedIntake"];
  return {
    curatedMemoryIntakeAvailable: descriptor?.availability === "available"
  };
};

export const normalizeApiUrl = (apiUrl: string): string =>
  apiUrl.replace(/\/+$/, "");

export const defaultConfig = (
  environment: NodeJS.ProcessEnv = process.env
): McpServerConfig => ({
  apiUrl: environment.MEMORY_API_URL ?? "http://localhost:3300",
  apiToken: environment.MEMORY_API_TOKEN,
  requestTimeoutMs: positiveIntEnv(
    environment,
    "MEMORY_API_REQUEST_TIMEOUT_MS",
    60_000
  )
});

const positiveIntEnv = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const parsed = Number.parseInt(environment[name] ?? "", 10);
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

  async capabilities(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/v1/capabilities");
  }

  async getEffectiveCapturePolicy(input: {
    projectId?: string;
    threadId?: string;
    sessionId?: string;
  }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (input.projectId) params.set("projectId", input.projectId);
    if (input.threadId) params.set("threadId", input.threadId);
    if (input.sessionId) params.set("sessionId", input.sessionId);
    return this.request(
      "GET",
      `/v1/capture-policy/effective?${params.toString()}`
    );
  }

  async createSession(
    input: Record<string, unknown>
  ): Promise<{ session?: { id: string }; skipped?: boolean }> {
    return this.request("POST", "/v1/sessions", input);
  }

  async ensureConversationSourceArtifact(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/conversation-source-artifacts", input);
  }

  async lookupConversationSourceArtifact(input: {
    sourceKind: "codex" | "claude-code" | "pi";
    externalSessionId: string;
    sourceComponentId?: string;
  }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      source_kind: input.sourceKind,
      external_session_id: input.externalSessionId,
      source_component_id: input.sourceComponentId ?? "main"
    });
    return this.request(
      "GET",
      `/v1/conversation-source-artifacts/lookup?${params.toString()}`
    );
  }

  async finalizeConversationSourceSet(
    sourceGenerationId: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/conversation-source-artifacts/generations/${encodeURIComponent(sourceGenerationId)}/finalize-source-set`,
      {}
    );
  }

  async getConversationSourceArtifactByGeneration(
    sourceGenerationId: string,
    sourceComponentId = "main"
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      source_component_id: sourceComponentId
    });
    return this.request(
      "GET",
      `/v1/conversation-source-artifacts/generations/${encodeURIComponent(sourceGenerationId)}?${params.toString()}`
    );
  }

  async listConversationSourceGenerationComponents(
    sourceGenerationId: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v1/conversation-source-artifacts/generations/${encodeURIComponent(sourceGenerationId)}/components`
    );
  }

  async appendConversationSourceSegment(
    artifactId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/conversation-source-artifacts/${encodeURIComponent(artifactId)}/segments`,
      input
    );
  }

  async finalizeConversationSourceArtifact(
    artifactId: string,
    input: { expectedProviderOffset: number; expectedProviderLine: number }
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/conversation-source-artifacts/${encodeURIComponent(artifactId)}/finalize`,
      input
    );
  }

  async createConversationSourceSuccessorGeneration(
    artifactId: string,
    input: {
      expectedParentClosureHash: string;
      sourceGenerationId: string;
      originKeyId: string;
    }
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/conversation-source-artifacts/${encodeURIComponent(artifactId)}/successor`,
      input
    );
  }

  async listConversationSourceSegments(
    artifactId: string,
    input: { afterOffset: number; limit?: number }
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      after_offset: String(input.afterOffset),
      limit: String(input.limit ?? 20)
    });
    return this.request(
      "GET",
      `/v1/conversation-source-artifacts/${encodeURIComponent(artifactId)}/segments?${params.toString()}`
    );
  }

  async getConversationSourceSegmentContent(
    artifactId: string,
    segmentId: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v1/conversation-source-artifacts/${encodeURIComponent(artifactId)}/segments/${encodeURIComponent(segmentId)}/content`
    );
  }

  async getConversationSourceCursor(
    artifactId: string,
    consumerKind: string
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ consumer_kind: consumerKind });
    return this.request(
      "GET",
      `/v1/conversation-source-artifacts/${encodeURIComponent(artifactId)}/cursor?${params.toString()}`
    );
  }

  async advanceConversationSourceCursor(
    artifactId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/conversation-source-artifacts/${encodeURIComponent(artifactId)}/cursor`,
      input
    );
  }

  async createHistoricalImportRun(): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/historical-imports", {});
  }

  async lookupHistoricalImportSource(
    artifactId: string
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ artifactId });
    return this.request(
      "GET",
      `/v1/historical-import-sources/lookup?${params.toString()}`
    );
  }

  async createHistoricalImportSource(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/historical-import-sources", input);
  }

  async historicalImportAdmission(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/historical-import-admission");
  }

  async transitionHistoricalImportRun(
    runId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "PATCH",
      `/v1/historical-imports/${encodeURIComponent(runId)}`,
      input
    );
  }

  async transitionHistoricalImportSource(
    sourceId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "PATCH",
      `/v1/historical-import-sources/${encodeURIComponent(sourceId)}`,
      input
    );
  }

  async ingestHistoricalImportBatch(
    sourceId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/historical-import-sources/${encodeURIComponent(sourceId)}/batches`,
      input
    );
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

  async findConversationItemByStableIdentity(input: {
    sessionId: string;
    canonicalStableItemId: string;
  }): Promise<{
    item: {
      id: string;
      externalTurnId: string | null;
      canonicalStableItemId: string | null;
    } | null;
  }> {
    const params = new URLSearchParams({
      session_id: input.sessionId,
      canonical_stable_item_id: input.canonicalStableItemId
    });
    return this.request(
      "GET",
      `/v1/memory/conversation-items/by-stable-identity?${params.toString()}`
    );
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

  async releaseConversationProjectionHold(input: {
    sessionId: string;
    externalTurnId: string;
  }): Promise<{ conversationItemIds: string[] }> {
    return this.request("POST", "/v1/memory/conversation-items/release", input);
  }

  async answer(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/answer", input);
  }

  async proposeCuratedMemory(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/curated/proposals", input);
  }

  async claimPendingCuratedMemoryReviews(
    input: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/memory/curated/proposals/claim-pending",
      input
    );
  }

  async submitCuratedMemoryReview(
    proposalId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "PATCH",
      `/v1/memory/curated/proposals/${encodeURIComponent(proposalId)}/review`,
      input
    );
  }

  async createFinalQuestion(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/questions/final", input);
  }

  async getQuestion(questionId: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v1/memory/questions/${encodeURIComponent(questionId)}`
    );
  }

  async listLocalMemoryAgentSettings(): Promise<{
    settings: LocalMemoryAgentSettingRecord[];
  }> {
    return this.request("GET", "/v1/memory/local-agent-settings");
  }

  async listAiClientInstances(): Promise<{
    instances: Array<{
      instanceId: string;
      driverId: string;
      enabled: boolean;
      configIdentityHash?: string | null;
    }>;
    capabilitySnapshots: Array<{
      instanceId: string;
      installationIdentityHash?: string;
      healthState: string;
      authenticationState: string;
      models: Array<Record<string, unknown>>;
      capabilities: Record<string, unknown>;
      expiresAt: string;
      stale: boolean;
    }>;
  }> {
    return this.request("GET", "/v1/memory/ai-client-instances");
  }

  async upsertAiClientInstance(
    instanceId: string,
    input: {
      driver_id: string;
      display_name: string;
      config_identity_hash?: string | null;
      enabled?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    return this.request(
      "PUT",
      `/v1/memory/ai-client-instances/${encodeURIComponent(instanceId)}`,
      input
    );
  }

  async recordAiClientCapabilitySnapshot(
    instanceId: string,
    input: {
      installation_identity_hash: string;
      client_version?: string | null;
      authentication_state: "authenticated" | "unauthenticated" | "unknown";
      health_state: "healthy" | "unavailable" | "incompatible" | "error";
      models: AiClientModelCapability[];
      capabilities: Record<string, unknown>;
      observed_at: string;
      expires_at: string;
    }
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/memory/ai-client-instances/${encodeURIComponent(instanceId)}/capability-snapshots`,
      input
    );
  }

  async deleteLocalMemoryAgentSetting(
    flowKey: LocalMemoryAgentFlowKey
  ): Promise<{ flow_key: LocalMemoryAgentFlowKey; reset: boolean }> {
    return this.request(
      "DELETE",
      `/v1/memory/local-agent-settings/${encodeURIComponent(flowKey)}`
    );
  }

  async upsertLocalMemoryAgentSetting(
    flowKey: LocalMemoryAgentFlowKey,
    input: {
      provider: "codex" | "claude" | "pi";
      aiClientInstanceId?: string;
      model: string;
      reasoningEffort: string;
      timeoutMs: number;
      maxAttempts: number;
    }
  ): Promise<{ setting: LocalMemoryAgentSettingRecord }> {
    return this.request(
      "PUT",
      `/v1/memory/local-agent-settings/${encodeURIComponent(flowKey)}`,
      {
        provider: input.provider,
        ai_client_instance_id:
          input.aiClientInstanceId ?? `${input.provider}.default`,
        model: input.model,
        reasoning_effort: input.reasoningEffort,
        timeout_ms: input.timeoutMs,
        max_attempts: input.maxAttempts
      }
    );
  }

  async search(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/search", input);
  }

  async expand(
    nodeId: string,
    input: {
      searchDomain?: string;
      sessionId?: string;
      projectId?: string;
      teamWorkspaceId?: string;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
      authorizationBoundary?: string;
    } = {}
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (input.searchDomain) {
      params.set("search_domain", input.searchDomain);
    }
    if (input.sessionId) {
      params.set("session_id", input.sessionId);
    }
    if (input.projectId) {
      params.set("project_id", input.projectId);
    }
    if (input.teamWorkspaceId) {
      params.set("team_workspace_id", input.teamWorkspaceId);
    }
    if (input.recentDays !== undefined) {
      params.set("recent_days", String(input.recentDays));
    }
    if (input.sourceAfter) {
      params.set("source_after", input.sourceAfter);
    }
    if (input.sourceBefore) {
      params.set("source_before", input.sourceBefore);
    }
    if (input.authorizationBoundary) {
      params.set("authorization_boundary", input.authorizationBoundary);
    }
    const query = params.toString();
    return this.request(
      "GET",
      `/v1/memory/nodes/${encodeURIComponent(nodeId)}/expand${query ? `?${query}` : ""}`
    );
  }

  async claimLcmSummaries(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/memory/lcm/summary-claims", input);
  }

  async renewLcmSummaryClaim(
    claimId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "PUT",
      `/v1/memory/lcm/summary-claims/${encodeURIComponent(claimId)}/renew`,
      input
    );
  }

  async listPendingSessionTitles(
    input: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (typeof input.limit === "string" || typeof input.limit === "number") {
      params.set("limit", String(input.limit));
    }
    if (
      typeof input.minUserEvents === "string" ||
      typeof input.minUserEvents === "number"
    ) {
      params.set("min_user_events", String(input.minUserEvents));
    }
    const query = params.toString();
    return this.request(
      "GET",
      `/v1/memory/session-titles/pending${query ? `?${query}` : ""}`
    );
  }

  async submitSessionTitle(
    sessionId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/memory/session-titles/${encodeURIComponent(sessionId)}`,
      input
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

  async teamMemorySearch(
    upstreamBackendId: string,
    input: Record<string, unknown>,
    authorization: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/local-edge/team-memory/search",
      {
        upstream_backend_id: upstreamBackendId,
        input
      },
      { authorization }
    );
  }

  async teamMemoryAnswer(
    upstreamBackendId: string,
    input: Record<string, unknown>,
    authorization: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/local-edge/team-memory/answer",
      {
        upstream_backend_id: upstreamBackendId,
        input
      },
      { authorization }
    );
  }

  async teamMemoryExpand(
    upstreamBackendId: string,
    nodeId: string,
    input: Record<string, unknown>,
    authorization: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/local-edge/team-memory/expand",
      {
        upstream_backend_id: upstreamBackendId,
        node_id: nodeId,
        input
      },
      { authorization }
    );
  }

  async createFinalTeamQuestion(
    upstreamBackendId: string,
    input: Record<string, unknown>,
    authorization: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      "/v1/local-edge/team-memory/questions/final",
      {
        upstream_backend_id: upstreamBackendId,
        input
      },
      { authorization }
    );
  }

  protected async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    options: { authorization?: string } = {}
  ): Promise<T> {
    const authorization =
      options.authorization ??
      (this.config.apiToken ? `Bearer ${this.config.apiToken}` : null);
    if (!authorization) {
      throw new MemoryApiError(
        "Memory API token is not configured. Start the Local AI Runtime through koed-server or configure the Capture Hook integration.",
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
          authorization,
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
  options: {
    lcmSummaryService?: LcmSummaryServiceHandle | null;
    curatedMemoryReviewService?: {
      snapshot(): Record<string, unknown>;
    } | null;
  } = {}
): Promise<MemoryAccessCheckResult> => {
  const access = await client.accessCheck();
  const answerWorker = resolveMemoryAnswerWorkerConfig();
  const lcmSummaryWorker = resolveLcmSummaryWorkerConfig();
  const lcmSummaryService = resolveLcmSummaryServiceConfig();
  const curatedMemoryReviewWorker = resolveCuratedMemoryReviewConfig();
  const toolExposure = resolveToolExposureConfig();
  const backendToolCapabilities = await client
    .capabilities()
    .then(backendToolCapabilitiesFrom)
    .catch(() => unavailableBackendToolCapabilities);
  const lcmSnapshot = options.lcmSummaryService?.snapshot();
  const curatedMemorySnapshot = options.curatedMemoryReviewService?.snapshot();
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
    capturePath: "journaled_codex_transcript",
    exposedTools: exposedTools(toolExposure, backendToolCapabilities),
    diagnosticMemoryToolsExposed: toolExposure.exposeDiagnosticMemoryTools,
    lowLevelMemoryToolsExposed: toolExposure.exposeLowLevelMemoryTools,
    localMemoryAnswerWorker: {
      provider: answerWorker.provider,
      model: answerWorker.model,
      reasoningEffort: answerWorker.reasoningEffort,
      timeoutMs: answerWorker.timeoutMs,
      maxAttempts: answerWorker.maxAttempts,
      maxSearches: answerWorker.maxSearches,
      maxExpansions: answerWorker.maxExpansions,
      executablePath: answerWorker.executablePath,
      defaultResponseDetail: "answer_only"
    },
    localLcmSummaryWorker: {
      provider: lcmSummaryWorker.provider,
      model: lcmSummaryWorker.model,
      reasoningEffort: lcmSummaryWorker.reasoningEffort,
      timeoutMs: lcmSummaryWorker.timeoutMs,
      maxAttempts: lcmSummaryWorker.maxAttempts,
      retryDelayMs: lcmSummaryWorker.retryDelayMs,
      concurrency: lcmSummaryWorker.concurrency,
      maxPromptTokens: lcmSummaryWorker.maxPromptTokens,
      executablePath: lcmSummaryWorker.executablePath
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
    localCuratedMemoryReviewWorker: {
      provider: curatedMemoryReviewWorker.provider,
      model: curatedMemoryReviewWorker.model,
      reasoningEffort: curatedMemoryReviewWorker.reasoningEffort,
      timeoutMs: curatedMemoryReviewWorker.timeoutMs,
      maxAttempts: curatedMemoryReviewWorker.maxAttempts,
      maxPromptTokens: curatedMemoryReviewWorker.maxPromptTokens,
      executablePath: curatedMemoryReviewWorker.executablePath
    },
    localCuratedMemoryReviewDiagnostics: {
      running: curatedMemorySnapshot?.running === true,
      lastRunAt:
        typeof curatedMemorySnapshot?.lastRunAt === "string"
          ? curatedMemorySnapshot.lastRunAt
          : null,
      lastSuccessAt:
        typeof curatedMemorySnapshot?.lastSuccessAt === "string"
          ? curatedMemorySnapshot.lastSuccessAt
          : null,
      lastError:
        typeof curatedMemorySnapshot?.lastError === "string"
          ? curatedMemorySnapshot.lastError
          : null,
      lastResult: curatedMemorySnapshot?.lastResult ?? null
    },
    notes: includeNotes
      ? [
          "Store normal AI Client conversation context as Personal Memory through provider transcript ingestion and content-free capture signals. The backend does not decide that a fact is important and create a separate extracted memory.",
          "MCP alone does not automatically observe the whole conversation; the main-agent MCP surface is for retrieval and local summarisation.",
          "Use memory_answer as the normal retrieval entry point. It defaults to response_detail=answer_only and search_domain=project for the current AI Client Project/cwd; use response_detail=with_citations for source metadata, response_detail=with_evidence only for debugging/UI inspection, search_domain=session with a backend session_id for one conversation, or search_domain=global only for deliberate cross-project memory checks.",
          "MCP recall is personal by default. When the current Project is linked to an enrolled Team Backend, project-scoped memory_answer can route Team Workspace recall through the local edge.",
          "Low-level memory_search/memory_expand tools are hidden by default so the main agent delegates retrieval work to the local memory-answer worker.",
          "Backend LLM provider configuration is unsupported in this build. The backend retrieves cited evidence with local semantic embeddings; the local MCP memory-answer worker can plan follow-up searches/expansions and synthesize the final answer through the explicitly assigned local AI Client instance.",
          "Local memory processing: backend workers create pending title and LCM summary work, while the MCP background service runs the explicitly assigned local AI Client instance and submits results back for storage and embedding.",
          "Curated Memory proposals are reviewed asynchronously by a separate local AI Client worker using complete source evidence; the proposing agent is not blocked and cannot directly write a canonical assertion.",
          "When answering from memory, cite each source."
        ]
      : []
  };
};
