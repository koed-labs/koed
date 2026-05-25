import { randomUUID } from "node:crypto";
import type { KoedApiClient } from "./koed-client.js";

const SUMMARY_WORKER_ID = `pi-lcm:${randomUUID()}`;
const DEFAULT_SUMMARY_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PROMPT_TOKENS = 32_000;
const DEFAULT_BATCH_LIMIT = 2;
const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_PUSH_DELAY_MS = 10_000;
const DEFAULT_INTERVAL_MS = 1_800_000;
const DEFAULT_PI_MODEL_FAMILIES = [
  "gpt-5.4-mini",
  "gemini-3-flash",
  "claude-haiku-4.5"
] as const;
const PI_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);
const LCM_SUMMARY_PROMPT_VERSION = "lcm-local-summary-v2";

export const PI_LCM_SUMMARY_DEFAULTS = {
  enabled: true,
  batchLimit: DEFAULT_BATCH_LIMIT,
  initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
  pushDelayMs: DEFAULT_PUSH_DELAY_MS,
  intervalMs: DEFAULT_INTERVAL_MS,
  providerOrder: ["pi"] as const,
  piModelFamilies: [...DEFAULT_PI_MODEL_FAMILIES]
} as const;

interface LcmSourceItem {
  kind?: string;
  sourceTable?: string;
  sourceId?: string;
  nodeId?: string;
  visibility?: string;
  actor?: string;
  turnId?: string | null;
  createdAt?: string;
  text?: string;
  payload?: unknown;
  position?: number;
}

interface LcmSummaryNode {
  id: string;
  visibility: string;
  kind: "leaf" | "rollup";
  depth: number;
  summaryText: string;
  sourceItems: LcmSourceItem[];
  sourceTokenEstimate: number | null;
}

interface PiDiscoveredModel {
  provider: string;
  model: string;
  family: string;
  score: number;
}

interface LocalSummaryWorkerConfig {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  concurrency: number;
  maxPromptTokens: number;
  piModelFamilies: string[];
  model: string;
  reasoningEffort: string;
  cwd: string;
}

interface LcmSummaryResult {
  nodeId: string;
  kind: "leaf" | "rollup";
  depth: number;
  submitted: boolean;
  summaryModel?: string;
  promptTokenEstimate?: number;
  maxPromptTokenEstimate?: number;
  promptCallCount?: number;
  summaryTokenEstimate?: number;
  error?: string;
}

interface LcmSummaryRunResult {
  requestedLimit: number;
  processedCount: number;
  submittedCount: number;
  failedCount: number;
  results: LcmSummaryResult[];
}

interface PiLcmSummaryServiceConfig {
  enabled: boolean;
  batchLimit: number;
  initialDelayMs: number;
  pushDelayMs: number;
  intervalMs: number;
}

export interface PiLcmSummaryServiceHandle {
  stop(): void;
  nudge(cwd?: string): void;
  trigger(cwd?: string, limit?: number): Promise<LcmSummaryRunResult>;
  setCwd(cwd: string): void;
  snapshot(): {
    running: boolean;
    lastRunAt: string | null;
    lastError: string | null;
    lastResult: LcmSummaryRunResult | null;
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const objectPayload = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const normalizeForPrompt = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const itemAnchor = (item: LcmSourceItem): string =>
  [
    item.kind,
    item.sourceTable && item.sourceId
      ? `source:${item.sourceTable}:${item.sourceId}`
      : undefined,
    item.nodeId ? `node:${item.nodeId}` : undefined,
    item.turnId ? `turn:${item.turnId}` : undefined,
    item.createdAt ? `created:${item.createdAt}` : undefined,
    item.position === undefined ? undefined : `position:${item.position}`
  ]
    .filter(Boolean)
    .join(" ");

const itemText = (item: LcmSourceItem): string => {
  const label =
    item.kind === "lcm_child"
      ? "child summary"
      : item.actor
        ? item.actor
        : (item.kind ?? "source");
  const payload =
    item.payload === undefined
      ? ""
      : ` payload:${normalizeForPrompt(JSON.stringify(item.payload))}`;
  return `- [${itemAnchor(item)}] ${label}: ${normalizeForPrompt(
    item.text ?? ""
  )}${payload}`;
};

const buildLcmSummaryPrompt = (
  node: LcmSummaryNode,
  mode: "summary" | "partial" | "reduce" = "summary"
): string => {
  const isRollup =
    node.kind === "rollup" ||
    node.sourceItems.some((item) => item.kind === "lcm_child");
  const header =
    mode === "partial"
      ? [
          "You are a private local LCM summarisation worker running through the user's configured local AI client.",
          "Summarize this token-bounded shard of one larger LCM node.",
          "",
          "Requirements:",
          "- Preserve durable decisions, facts, implementation details, exact identifiers, and open threads from this shard.",
          "- Keep provenance hints such as node IDs, source spans, turn IDs, and chunk indexes when useful.",
          "- Do not add anything that is not supported by this shard.",
          "- Return only the shard summary text, with no preamble."
        ]
      : mode === "reduce"
        ? [
            "You are a private local LCM summarisation worker running through the user's configured local AI client.",
            "Combine these shard summaries into one coherent LCM summary.",
            "",
            "Requirements:",
            "- Preserve durable decisions, facts, implementation details, exact identifiers, and open threads.",
            "- Keep provenance hints such as node IDs, source spans, turn IDs, and chunk indexes when useful.",
            "- Do not add anything that is not supported by the shard summaries.",
            "- Return only the final summary text, with no preamble."
          ]
        : isRollup
          ? [
              "You are a private local LCM summarisation worker running through the user's configured local AI client.",
              "Roll up these child LCM summaries into a higher-level memory graph summary.",
              "",
              "Requirements:",
              "- Preserve durable decisions, facts, implementation details, exact identifiers, and open threads.",
              "- Keep provenance hints such as node IDs, source spans, and turn IDs when useful.",
              "- Do not add anything that is not supported by the child summaries.",
              "- Return only the summary text, with no preamble."
            ]
          : [
              "You are a private local LCM summarisation worker running through the user's configured local AI client.",
              "Summarize this captured memory span for a lossless context memory graph.",
              "",
              "Requirements:",
              "- Preserve concrete user requests, decisions, facts, filenames, commands, model names, tool outcomes, errors, and unresolved questions.",
              "- Mention source items in the same order they occurred when they affect meaning.",
              "- Do not invent details. If a source item is ambiguous, say so compactly.",
              "- Write a compact but information-dense summary for future agent retrieval.",
              "- Return only the summary text, with no preamble."
            ];

  const placeholderSection =
    mode === "summary"
      ? ["Existing deterministic placeholder summary:", node.summaryText, ""]
      : [
          "Existing deterministic placeholder summary:",
          "(omitted from this token-bounded prompt; exact source items or shard summaries below are authoritative)",
          ""
        ];

  return [
    ...header,
    "",
    ...placeholderSection,
    "Source items:",
    ...node.sourceItems.map((item) => itemText(item)),
    "",
    "Return only summary text."
  ].join("\n");
};

const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.trim().length / 4));

const chunkTextForBudget = (text: string, maxTokens: number): string[] => {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  if (estimateTokens(normalized) <= maxTokens) {
    return [normalized];
  }

  const chunks: string[] = [];
  const paragraphs = normalized.split(/\n{2,}/).flatMap((paragraph) =>
    paragraph.split(/(?<=[.!?])\s+/)
  );
  let current = "";

  for (const part of paragraphs) {
    const piece = part.trim();
    if (!piece) {
      continue;
    }
    const candidate = current ? `${current} ${piece}` : piece;
    if (estimateTokens(candidate) <= maxTokens) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (estimateTokens(piece) <= maxTokens) {
      current = piece;
      continue;
    }
    const maxChars = Math.max(256, maxTokens * 4);
    for (let index = 0; index < piece.length; index += maxChars) {
      chunks.push(piece.slice(index, index + maxChars).trim());
    }
  }

  if (current) {
    chunks.push(current);
  }
  return chunks.filter(Boolean);
};

const promptTokens = (
  prompt: string,
  _config: LocalSummaryWorkerConfig
): number => estimateTokens(prompt);

const chunkSourceItems = (
  node: LcmSummaryNode,
  config: LocalSummaryWorkerConfig,
  itemTextTokenBudget: number
): LcmSourceItem[] =>
  node.sourceItems.flatMap((item) => {
    const text = item.text ?? "";
    const chunks: string[] = chunkTextForBudget(text, itemTextTokenBudget);
    if (chunks.length <= 1) {
      return [{ ...item, text: chunks[0] ?? text }];
    }
    return chunks.map((chunk, index) => ({
      ...item,
      text: chunk,
      payload: {
        ...objectPayload(item.payload),
        sourceChunkIndex: index,
        sourceChunkCount: chunks.length
      }
    }));
  });

const nodeWithItems = (
  node: LcmSummaryNode,
  sourceItems: LcmSourceItem[]
): LcmSummaryNode => ({
  ...node,
  sourceItems
});

const buildTokenBoundedPrompts = (
  node: LcmSummaryNode,
  config: LocalSummaryWorkerConfig,
  mode: "partial" | "reduce"
): string[] => {
  const maxPromptTokens = config.maxPromptTokens;
  let itemTextTokenBudget = Math.max(256, Math.floor(maxPromptTokens * 0.45));

  while (itemTextTokenBudget >= 64) {
    const chunkedItems = chunkSourceItems(node, config, itemTextTokenBudget);
    if (chunkedItems.length === 0) {
      throw new Error(`LCM node ${node.id} has no source items to summarize`);
    }

    const prompts: string[] = [];
    let currentItems: LcmSourceItem[] = [];
    for (const item of chunkedItems) {
      const candidateItems = [...currentItems, item];
      const candidatePrompt = buildLcmSummaryPrompt(
        nodeWithItems(node, candidateItems),
        mode
      );
      if (
        currentItems.length > 0 &&
        promptTokens(candidatePrompt, config) > maxPromptTokens
      ) {
        prompts.push(buildLcmSummaryPrompt(nodeWithItems(node, currentItems), mode));
        currentItems = [item];
      } else {
        currentItems = candidateItems;
      }
    }

    if (currentItems.length > 0) {
      prompts.push(buildLcmSummaryPrompt(nodeWithItems(node, currentItems), mode));
    }

    if (
      prompts.length > 0 &&
      prompts.every((prompt) => promptTokens(prompt, config) <= maxPromptTokens)
    ) {
      return prompts;
    }

    itemTextTokenBudget = Math.max(64, Math.floor(itemTextTokenBudget / 2));
  }

  throw new Error(
    `LCM node ${node.id} cannot fit within ${maxPromptTokens} prompt tokens after token chunking`
  );
};

const buildSummaryPrompts = (
  node: LcmSummaryNode,
  config: LocalSummaryWorkerConfig
): string[] => {
  const prompt = buildLcmSummaryPrompt(node);
  if (promptTokens(prompt, config) <= config.maxPromptTokens) {
    return [prompt];
  }
  return buildTokenBoundedPrompts(node, config, "partial");
};

const normalizedFamily = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");

const piThinkingLevel = (reasoningEffort: string): string => {
  const normalized = reasoningEffort.trim().toLowerCase();
  if (PI_THINKING_LEVELS.has(normalized)) {
    return normalized;
  }
  if (normalized === "low") {
    return "minimal";
  }
  if (normalized === "high") {
    return "medium";
  }
  return "low";
};

const scorePiModelCandidate = (family: string, model: string): number => {
  const normalizedModel = normalizedFamily(model);
  const normalized = normalizedFamily(family);
  if (normalizedModel === normalized) {
    return 100;
  }
  if (normalizedModel.startsWith(`${normalized}-`)) {
    return 90;
  }
  if (normalizedModel.includes(normalized)) {
    return 80;
  }
  if (
    normalized === "gemini-3-flash" &&
    /gemini-3(?:-5)?-flash/.test(normalizedModel)
  ) {
    return 70;
  }
  return 0;
};

type PiSdkModel = {
  provider: string;
  id: string;
  name?: string;
};

const flattenAssistantContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
};

const lastAssistantText = (messages: unknown[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }
    const text = flattenAssistantContent(record.content);
    if (text) {
      return text;
    }
  }
  return "";
};

const createWorkerResourceLoader = async (systemPrompt: string) => {
  const { createExtensionRuntime } = await import(
    "@earendil-works/pi-coding-agent"
  );
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime()
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {}
  };
};

const discoverPiModelCandidates = async (
  config: LocalSummaryWorkerConfig,
  modelRegistry: { getAvailable(): Promise<PiSdkModel[]> }
): Promise<Array<PiDiscoveredModel & { sdkModel: PiSdkModel }>> => {
  const available = await modelRegistry.getAvailable();
  const discovered = config.piModelFamilies.flatMap((family, familyIndex) =>
    available
      .map((sdkModel) => ({
        sdkModel,
        provider: sdkModel.provider,
        model: sdkModel.id,
        family,
        familyIndex,
        score: Math.max(
          scorePiModelCandidate(family, sdkModel.id),
          sdkModel.name ? scorePiModelCandidate(family, sdkModel.name) : 0
        )
      }))
      .filter((candidate) => candidate.score > 0)
  );

  discovered.sort((left, right) => {
    if (left.familyIndex !== right.familyIndex) {
      return left.familyIndex - right.familyIndex;
    }
    return right.score - left.score;
  });

  return discovered.map(({ familyIndex: _familyIndex, ...candidate }) => candidate);
};

const withSessionTimeout = async <T>(
  timeoutMs: number,
  session: { abort(): Promise<void> },
  work: () => Promise<T>
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(async () => {
          try {
            await session.abort();
          } catch {
            // best effort only
          }
          reject(new Error(`Pi SDK LCM summary timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const runPiSummary = async (
  prompt: string,
  config: LocalSummaryWorkerConfig,
  timeoutMs: number,
  candidate: PiDiscoveredModel & { sdkModel: PiSdkModel }
): Promise<{ text: string; model: string }> => {
  const {
    AuthStorage,
    createAgentSession,
    getAgentDir,
    ModelRegistry,
    SessionManager,
    SettingsManager
  } = await import("@earendil-works/pi-coding-agent");

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const resourceLoader = await createWorkerResourceLoader(
    [
      "You are a private local LCM summarisation worker.",
      "Return only final summary text.",
      "No preamble. No markdown fences."
    ].join("\n")
  );
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 }
  });

  const { session } = await createAgentSession({
    cwd: config.cwd,
    agentDir: getAgentDir(),
    authStorage,
    modelRegistry,
    model: candidate.sdkModel as never,
    thinkingLevel: piThinkingLevel(config.reasoningEffort) as
      | "off"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh",
    noTools: "all",
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(config.cwd)
  });

  try {
    await withSessionTimeout(timeoutMs, session, () => session.prompt(prompt));
    const text = lastAssistantText(session.messages as unknown[]);
    if (!text) {
      throw new Error(
        `Pi SDK LCM summary produced empty output for ${candidate.provider}/${candidate.model}`
      );
    }
    return {
      text,
      model: `pi:${candidate.provider}/${candidate.model}:${piThinkingLevel(
        config.reasoningEffort
      )}`
    };
  } finally {
    session.dispose();
  }
};

const runLocalSummary = async (
  prompt: string,
  config: LocalSummaryWorkerConfig,
  timeoutMs: number
): Promise<{ text: string; model: string }> => {
  const { AuthStorage, ModelRegistry } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const candidates = await discoverPiModelCandidates(config, modelRegistry);
  if (candidates.length === 0) {
    throw new Error(
      `No suitable Pi compact model available. Tried families: ${config.piModelFamilies.join(", ")}`
    );
  }

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return await runPiSummary(prompt, config, timeoutMs, candidate);
    } catch (error) {
      failures.push(
        `${candidate.provider}/${candidate.model}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  throw new Error(`Pi LCM summary failed: ${failures.join("; ")}`);
};

const runPromptWithRetries = async (
  prompt: string,
  config: LocalSummaryWorkerConfig
): Promise<{ text: string; model: string }> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      return await runLocalSummary(prompt, config, config.timeoutMs * attempt);
    } catch (error) {
      lastError = error;
      if (attempt < config.maxAttempts && config.retryDelayMs > 0) {
        await sleep(config.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
};

const reduceShardSummaries = async (
  node: LcmSummaryNode,
  shardSummaries: Array<{ text: string; model: string }>,
  config: LocalSummaryWorkerConfig,
  stats: {
    promptTokenSum: number;
    maxPromptTokens: number;
    promptCallCount: number;
  }
): Promise<{ text: string; model: string }> => {
  if (shardSummaries.length === 1) {
    return shardSummaries[0]!;
  }

  const reduceNode: LcmSummaryNode = {
    ...node,
    sourceItems: shardSummaries.map((summary, index) => ({
      kind: "lcm_child",
      nodeId: `${node.id}:shard-${index}`,
      visibility: node.visibility,
      text: summary.text,
      payload: {
        shardIndex: index,
        shardCount: shardSummaries.length,
        sourceSummaryModel: summary.model
      },
      position: index
    }))
  };

  const reducePrompts = buildTokenBoundedPrompts(reduceNode, config, "reduce");
  const nextSummaries: Array<{ text: string; model: string }> = [];
  for (const prompt of reducePrompts) {
    const tokens = promptTokens(prompt, config);
    stats.promptTokenSum += tokens;
    stats.maxPromptTokens = Math.max(stats.maxPromptTokens, tokens);
    stats.promptCallCount += 1;
    nextSummaries.push(await runPromptWithRetries(prompt, config));
  }

  if (nextSummaries.length === shardSummaries.length) {
    throw new Error(
      `LCM node ${node.id} reduce step did not shrink ${shardSummaries.length} shard summaries`
    );
  }

  return reduceShardSummaries(node, nextSummaries, config, stats);
};

const summarizeNode = async (
  client: KoedApiClient,
  node: LcmSummaryNode,
  config: LocalSummaryWorkerConfig
): Promise<LcmSummaryResult> => {
  const stats = {
    promptTokenSum: 0,
    maxPromptTokens: 0,
    promptCallCount: 0
  };

  try {
    const prompts = buildSummaryPrompts(node, config);
    const shardSummaries: Array<{ text: string; model: string }> = [];
    for (const prompt of prompts) {
      const tokens = promptTokens(prompt, config);
      stats.promptTokenSum += tokens;
      stats.maxPromptTokens = Math.max(stats.maxPromptTokens, tokens);
      stats.promptCallCount += 1;
      shardSummaries.push(await runPromptWithRetries(prompt, config));
    }
    const result =
      prompts.length === 1
        ? shardSummaries[0]!
        : await reduceShardSummaries(node, shardSummaries, config, stats);
    const summaryText = result.text.trim();
    const summaryTokens = { tokens: estimateTokens(summaryText) };
    await client.submitLcmSummary(node.id, {
      workerId: SUMMARY_WORKER_ID,
      summaryText,
      summaryModel: result.model,
      summaryPromptVersion: LCM_SUMMARY_PROMPT_VERSION,
      summaryTokenEstimate: summaryTokens.tokens
    });
    return {
      nodeId: node.id,
      kind: node.kind,
      depth: node.depth,
      submitted: true,
      summaryModel: result.model,
      promptTokenEstimate: stats.promptTokenSum,
      maxPromptTokenEstimate: stats.maxPromptTokens,
      promptCallCount: stats.promptCallCount,
      summaryTokenEstimate: summaryTokens.tokens
    };
  } catch (error) {
    return {
      nodeId: node.id,
      kind: node.kind,
      depth: node.depth,
      submitted: false,
      promptTokenEstimate: stats.promptTokenSum,
      maxPromptTokenEstimate: stats.maxPromptTokens,
      promptCallCount: stats.promptCallCount,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index]!);
      }
    }
  );
  await Promise.all(runners);
  return results;
};

const workerConfig = (cwd: string): LocalSummaryWorkerConfig => ({
  timeoutMs: DEFAULT_SUMMARY_TIMEOUT_MS,
  maxAttempts: 2,
  retryDelayMs: 2_000,
  concurrency: 1,
  maxPromptTokens: DEFAULT_MAX_PROMPT_TOKENS,
  piModelFamilies: [...DEFAULT_PI_MODEL_FAMILIES],
  model: "gpt-5.4-mini",
  reasoningEffort: "medium",
  cwd
});

export const runPiLcmSummaryPass = async (
  client: KoedApiClient,
  cwd: string,
  limit: number
): Promise<LcmSummaryRunResult> => {
  const config = workerConfig(cwd);
  const results: LcmSummaryResult[] = [];

  while (results.length < limit) {
    const pending = (await client.listPendingLcmSummaries({
      limit: limit - results.length,
      workerId: SUMMARY_WORKER_ID
    })) as { nodes?: LcmSummaryNode[] };
    const nodes = pending.nodes ?? [];
    if (nodes.length === 0) {
      break;
    }

    const nextDepth = Math.min(...nodes.map((node) => node.depth));
    const depthNodes = nodes.filter((node) => node.depth === nextDepth);
    const depthResults = await runWithConcurrency(
      depthNodes,
      config.concurrency,
      (node) => summarizeNode(client, node, config)
    );
    results.push(...depthResults);
    if (depthResults.every((result) => !result.submitted)) {
      break;
    }
  }

  return {
    requestedLimit: limit,
    processedCount: results.length,
    submittedCount: results.filter((result) => result.submitted).length,
    failedCount: results.filter((result) => !result.submitted).length,
    results
  };
};

const DEFAULT_DRAIN_DELAY_MS = 5_000;
const DEFAULT_FAILURE_RETRY_BASE_MS = 60_000;
const DEFAULT_FAILURE_RETRY_MAX_MS = 900_000;

const aggregateRunResults = (
  requestedLimit: number,
  passes: LcmSummaryRunResult[]
): LcmSummaryRunResult => {
  const results = passes.flatMap((pass) => pass.results);
  return {
    requestedLimit,
    processedCount: results.length,
    submittedCount: results.filter((result) => result.submitted).length,
    failedCount: results.filter((result) => !result.submitted).length,
    results
  };
};

const failureRetryDelayMs = (
  intervalMs: number,
  consecutiveFailures: number
): number => {
  const exponentialDelay =
    DEFAULT_FAILURE_RETRY_BASE_MS *
    2 ** Math.max(0, consecutiveFailures - 1);
  return Math.min(
    intervalMs,
    DEFAULT_FAILURE_RETRY_MAX_MS,
    exponentialDelay
  );
};

export const startPiLcmSummaryService = (
  client: KoedApiClient,
  options: Partial<PiLcmSummaryServiceConfig> = {}
): PiLcmSummaryServiceHandle | null => {
  const config: PiLcmSummaryServiceConfig = {
    enabled: options.enabled ?? PI_LCM_SUMMARY_DEFAULTS.enabled,
    batchLimit: options.batchLimit ?? PI_LCM_SUMMARY_DEFAULTS.batchLimit,
    initialDelayMs: options.initialDelayMs ?? PI_LCM_SUMMARY_DEFAULTS.initialDelayMs,
    pushDelayMs: options.pushDelayMs ?? PI_LCM_SUMMARY_DEFAULTS.pushDelayMs,
    intervalMs: options.intervalMs ?? PI_LCM_SUMMARY_DEFAULTS.intervalMs
  };

  if (!config.enabled || !client.config.apiToken) {
    return null;
  }

  let cwd = process.cwd();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let pendingNudge = false;
  let consecutiveFailures = 0;
  let lastRunAt: string | null = null;
  let lastError: string | null = null;
  let lastResult: LcmSummaryRunResult | null = null;

  const schedule = (delayMs: number) => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void runScheduled();
    }, delayMs);
    timer.unref?.();
  };

  const executePass = async (
    limit = config.batchLimit
  ): Promise<LcmSummaryRunResult> => {
    lastRunAt = new Date().toISOString();
    try {
      lastResult = await runPiLcmSummaryPass(client, cwd, limit);
      lastError = null;
      return lastResult;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[koed] Pi LCM summary service failed: ${lastError}`);
      throw error;
    }
  };

  const finishRun = (
    result: LcmSummaryRunResult | null,
    error: unknown,
    terminalPass: LcmSummaryRunResult | null = result
  ): void => {
    const shouldRerunSoon = pendingNudge;
    pendingNudge = false;

    if (error) {
      consecutiveFailures += 1;
      schedule(
        shouldRerunSoon
          ? config.pushDelayMs
          : failureRetryDelayMs(config.intervalMs, consecutiveFailures)
      );
      return;
    }

    const stuck = Boolean(
      terminalPass &&
        terminalPass.processedCount > 0 &&
        terminalPass.submittedCount === 0 &&
        terminalPass.failedCount > 0
    );
    if (stuck) {
      consecutiveFailures += 1;
      lastError =
        terminalPass?.results.find((candidate) => candidate.error)?.error ??
        "Pi LCM summary service made no progress";
      schedule(
        shouldRerunSoon
          ? config.pushDelayMs
          : failureRetryDelayMs(config.intervalMs, consecutiveFailures)
      );
      return;
    }

    consecutiveFailures = 0;
    schedule(shouldRerunSoon ? config.pushDelayMs : config.intervalMs);
  };

  const emptyRunResult = (): LcmSummaryRunResult => ({
    requestedLimit: config.batchLimit,
    processedCount: 0,
    submittedCount: 0,
    failedCount: 0,
    results: []
  });

  const runUntilIdle = async (): Promise<{
    aggregate: LcmSummaryRunResult;
    terminalPass: LcmSummaryRunResult | null;
  }> => {
    const passes: LcmSummaryRunResult[] = [];
    let terminalPass: LcmSummaryRunResult | null = null;

    while (!stopped) {
      const pass = await executePass(config.batchLimit);
      passes.push(pass);
      terminalPass = pass;
      lastResult = aggregateRunResults(config.batchLimit, passes);

      const drained =
        pass.processedCount === 0 || pass.processedCount < config.batchLimit;
      const stuck = pass.processedCount > 0 && pass.submittedCount === 0;
      if (drained || stuck) {
        break;
      }

      await sleep(DEFAULT_DRAIN_DELAY_MS);
    }

    return {
      aggregate: lastResult ?? emptyRunResult(),
      terminalPass
    };
  };

  const runScheduled = async () => {
    if (running || stopped) {
      return;
    }

    running = true;
    let result: LcmSummaryRunResult | null = null;
    let terminalPass: LcmSummaryRunResult | null = null;
    let error: unknown;
    try {
      const scheduled = await runUntilIdle();
      result = scheduled.aggregate;
      terminalPass = scheduled.terminalPass;
    } catch (caughtError) {
      error = caughtError;
    } finally {
      running = false;
      finishRun(result, error, terminalPass);
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
    async trigger(nextCwd, limit) {
      if (nextCwd) {
        cwd = nextCwd;
      }
      if (stopped) {
        throw new Error("Pi LCM summary service is stopped");
      }
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (running) {
        throw new Error("Pi LCM summary service is already running");
      }

      running = true;
      let result: LcmSummaryRunResult | null = null;
      let error: unknown;
      try {
        result = await executePass(limit ?? config.batchLimit);
        return result;
      } catch (caughtError) {
        error = caughtError;
        throw caughtError;
      } finally {
        running = false;
        finishRun(result, error);
      }
    },
    setCwd(nextCwd) {
      cwd = nextCwd;
    },
    nudge(nextCwd) {
      if (nextCwd) {
        cwd = nextCwd;
      }
      if (stopped) {
        return;
      }
      if (running) {
        pendingNudge = true;
        return;
      }
      schedule(config.pushDelayMs);
    },
    snapshot() {
      return {
        running,
        lastRunAt,
        lastError,
        lastResult
      };
    }
  };
};
