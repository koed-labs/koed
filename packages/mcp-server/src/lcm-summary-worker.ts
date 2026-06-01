import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chunkTextForModel, countTokensForModel } from "@koed/core";
import { z } from "zod";
import {
  CodexAppServerTurnError,
  runCodexAppServerTurn,
  resolveCodexAppServerBinary,
  type CodexAppServerRawEvent,
  type CodexThreadTokenUsage
} from "./codex-app-server-runner.js";
import type { MemoryApiClient } from "./index.js";
import {
  persistRawConversationItems,
  projectRawConversationItems
} from "./raw-conversation-items.js";

const CODEX_SUMMARY_PROVIDER = "codex";
const DEFAULT_SUMMARY_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PROMPT_TOKENS = 48_000;
export const LCM_SUMMARY_PROMPT_VERSION = "lcm-codex-summary-json-v2";
export const LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION =
  "lcm-structured-summary-v1";

export interface LcmSummaryWorkerConfig {
  provider: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  concurrency: number;
  maxPromptTokens: number;
  appServerBinary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

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

export interface LcmSummaryNode {
  id: string;
  visibility: string;
  kind: "leaf" | "rollup";
  depth: number;
  summaryText: string;
  sourceItems: LcmSourceItem[];
  sourceTokenEstimate: number | null;
}

export interface LcmSummaryResult {
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

type LcmSummaryPromptResult = {
  text: string;
  structuredSummary?: StructuredLcmSummary;
  model: string;
  tokenUsage?: CodexThreadTokenUsage;
  threadId?: string;
  turnId?: string;
  rawEvents?: CodexAppServerRawEvent[];
  attemptIndex?: number;
  status?: "succeeded" | "failed";
  errorMessage?: string;
};

const structuredLcmSummarySchema = z
  .object({
    schema_version: z.literal(LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION),
    summary_text: z.string().min(1),
    user_requests: z.array(z.string()).default([]),
    decisions: z.array(z.string()).default([]),
    facts: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    model_names: z.array(z.string()).default([]),
    tool_outcomes: z.array(z.string()).default([]),
    errors: z.array(z.string()).default([]),
    unresolved_questions: z.array(z.string()).default([]),
    provenance_hints: z.array(z.string()).default([])
  })
  .passthrough();

export type StructuredLcmSummary = z.infer<typeof structuredLcmSummarySchema>;

export type CodexLcmSummaryRunner = (
  prompt: string,
  config: LcmSummaryWorkerConfig,
  timeoutMs: number
) => Promise<LcmSummaryPromptResult>;

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const resolveEnvValue = (
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined => {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
};

const integerEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const value = Number.parseInt(resolveEnvValue(env, name) ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
};

export const resolveLcmSummaryWorkerConfig = (
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<
    Pick<
      LcmSummaryWorkerConfig,
      | "provider"
      | "model"
      | "reasoningEffort"
      | "timeoutMs"
      | "maxAttempts"
      | "retryDelayMs"
      | "concurrency"
      | "maxPromptTokens"
      | "appServerBinary"
      | "cwd"
    >
  > = {}
): LcmSummaryWorkerConfig => {
  return {
    provider:
      overrides.provider ??
      resolveEnvValue(env, "MEMORY_LCM_SUMMARY_PROVIDER")?.toLowerCase() ??
      CODEX_SUMMARY_PROVIDER,
    model:
      overrides.model ??
      resolveEnvValue(env, "MEMORY_LCM_SUMMARY_MODEL") ??
      "gpt-5.4-mini",
    reasoningEffort:
      overrides.reasoningEffort ??
      resolveEnvValue(env, "MEMORY_LCM_SUMMARY_REASONING_EFFORT") ??
      "medium",
    timeoutMs:
      overrides.timeoutMs ??
      integerEnv(
        env,
        "MEMORY_LCM_SUMMARY_TIMEOUT_MS",
        DEFAULT_SUMMARY_TIMEOUT_MS
      ),
    maxAttempts: Math.max(
      1,
      overrides.maxAttempts ??
        integerEnv(env, "MEMORY_LCM_SUMMARY_MAX_ATTEMPTS", 2)
    ),
    retryDelayMs: Math.max(
      0,
      overrides.retryDelayMs ??
        integerEnv(env, "MEMORY_LCM_SUMMARY_RETRY_DELAY_MS", 2_000)
    ),
    concurrency: Math.max(
      1,
      overrides.concurrency ??
        integerEnv(env, "MEMORY_LCM_SUMMARY_CONCURRENCY", 1)
    ),
    maxPromptTokens: Math.max(
      1_000,
      overrides.maxPromptTokens ??
        integerEnv(
          env,
          "MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS",
          DEFAULT_MAX_PROMPT_TOKENS
        )
    ),
    appServerBinary:
      overrides.appServerBinary ??
      resolveCodexAppServerBinary(env, ["MEMORY_LCM_CODEX_BINARY"]),
    cwd: overrides.cwd ?? process.cwd(),
    env
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const lcmSummaryLockPath = (env: NodeJS.ProcessEnv): string =>
  resolveEnvValue(env, "MEMORY_LCM_SUMMARY_LOCK_PATH") ??
  path.join(os.homedir(), ".koed", "lcm-summary.lock");

export const lcmSummaryLockState = (
  env: NodeJS.ProcessEnv,
  staleMs: number
): { locked: boolean; stale: boolean } => {
  const lockPath = lcmSummaryLockPath(env);
  try {
    const stats = fs.statSync(lockPath);
    const stale = Date.now() - stats.mtimeMs > staleMs;
    return { locked: !stale, stale };
  } catch {
    return { locked: false, stale: false };
  }
};

const acquireLocalSummaryLock = (
  env: NodeJS.ProcessEnv,
  staleMs: number
): (() => void) | null => {
  const lockPath = lcmSummaryLockPath(env);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const stats = fs.statSync(lockPath);
    if (Date.now() - stats.mtimeMs > staleMs) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Missing lock is the normal path.
  }

  try {
    const handle = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(
      handle,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString()
      })
    );
    fs.closeSync(handle);
    return () => {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    };
  } catch {
    return null;
  }
};

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
  return `- [${itemAnchor(item)}] ${label}: ${normalizeForPrompt(
    item.text ?? ""
  )}`;
};

const lcmSummaryJsonShape = () => ({
  schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  summary_text: "Compact information-dense summary for retrieval.",
  user_requests: ["durable user request or preference"],
  decisions: ["decision and rationale when present"],
  facts: ["stable fact captured from the sources"],
  files: ["file path, package, service, or component when present"],
  commands: ["command or tool action when semantically important"],
  model_names: ["model name when present"],
  tool_outcomes: ["important tool result or observed outcome"],
  errors: ["error, failure, or regression when present"],
  unresolved_questions: ["open issue, blocker, or pending decision"],
  provenance_hints: ["node/source/turn/chunk ids that help trace claims"]
});

export const buildLcmSummaryPrompt = (
  node: LcmSummaryNode,
  mode: "summary" | "partial" | "reduce" = "summary"
): string => {
  const isRollup =
    node.kind === "rollup" ||
    node.sourceItems.some((item) => item.kind === "lcm_child");
  const header =
    mode === "partial"
      ? [
          "You are a private local LCM summarisation worker running under the user's Codex subscription.",
          "Summarize this token-bounded shard of one larger LCM node.",
          "",
          "Requirements:",
          "- Preserve durable decisions, facts, implementation details, exact identifiers, and open threads from this shard.",
          "- Keep provenance hints such as node IDs, source spans, turn IDs, and chunk indexes when useful.",
          "- Do not add anything that is not supported by this shard.",
          "- Return only one JSON object matching the required schema; no prose outside JSON."
        ]
      : mode === "reduce"
        ? [
            "You are a private local LCM summarisation worker running under the user's Codex subscription.",
            "Combine these shard summaries into one coherent LCM summary.",
            "",
            "Requirements:",
            "- Preserve durable decisions, facts, implementation details, exact identifiers, and open threads.",
            "- Keep provenance hints such as node IDs, source spans, turn IDs, and chunk indexes when useful.",
            "- Do not add anything that is not supported by the shard summaries.",
            "- Return only one JSON object matching the required schema; no prose outside JSON."
          ]
        : isRollup
          ? [
              "You are a private local LCM summarisation worker running under the user's Codex subscription.",
              "Roll up these child LCM summaries into a higher-level memory graph summary.",
              "",
              "Requirements:",
              "- Preserve durable decisions, facts, implementation details, exact identifiers, and open threads.",
              "- Keep provenance hints such as node IDs, source spans, and turn IDs when useful.",
              "- Do not add anything that is not supported by the child summaries.",
              "- Return only one JSON object matching the required schema; no prose outside JSON."
            ]
          : [
              "You are a private local LCM summarisation worker running under the user's Codex subscription.",
              "Summarize this captured memory span for a lossless context memory graph.",
              "",
              "Requirements:",
              "- Preserve concrete user requests, decisions, facts, filenames, commands, model names, tool outcomes, errors, and unresolved questions.",
              "- Mention source items in the same order they occurred when they affect meaning.",
              "- Do not invent details. If a source item is ambiguous, say so compactly.",
              "- Write a compact but information-dense summary for future agent retrieval.",
              "- Return only one JSON object matching the required schema; no prose outside JSON."
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
    `LCM node: ${node.id}`,
    `Kind: ${node.kind}`,
    `Depth: ${node.depth}`,
    `Visibility: ${node.visibility}`,
    `Source token estimate: ${node.sourceTokenEstimate ?? "unknown"}`,
    "",
    "Required JSON schema:",
    JSON.stringify(lcmSummaryJsonShape(), null, 2),
    "",
    ...placeholderSection,
    "Exact ordered source outline:",
    ...node.sourceItems.map(itemText)
  ].join("\n");
};

const promptTokens = (prompt: string, config: LcmSummaryWorkerConfig): number =>
  countTokensForModel(prompt, { model: config.model }).tokens;

const stripJsonFence = (text: string): string => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const unfenced = fenced ? (fenced[1] ?? "").trim() : trimmed;
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  return firstBrace >= 0 && lastBrace > firstBrace
    ? unfenced.slice(firstBrace, lastBrace + 1)
    : unfenced;
};

const parseStructuredLcmSummary = (text: string): StructuredLcmSummary =>
  structuredLcmSummarySchema.parse(JSON.parse(stripJsonFence(text)));

const objectPayload = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

const chunkSourceItems = (
  node: LcmSummaryNode,
  config: LcmSummaryWorkerConfig,
  itemTextTokenBudget: number
): LcmSourceItem[] =>
  node.sourceItems.flatMap((item) => {
    const text = item.text ?? "";
    const chunks = chunkTextForModel(text, {
      model: config.model,
      maxTokens: itemTextTokenBudget
    });
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
  config: LcmSummaryWorkerConfig,
  mode: "partial" | "reduce"
): string[] => {
  const maxPromptTokens = config.maxPromptTokens;
  let itemTextTokenBudget = Math.max(256, Math.floor(maxPromptTokens * 0.45));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const expandedItems = chunkSourceItems(node, config, itemTextTokenBudget);
    const prompts: string[] = [];
    let currentItems: LcmSourceItem[] = [];
    let oversizedSinglePrompt = false;

    for (const item of expandedItems) {
      const candidateItems = [...currentItems, item];
      const candidatePrompt = buildLcmSummaryPrompt(
        nodeWithItems(node, candidateItems),
        mode
      );
      if (promptTokens(candidatePrompt, config) <= maxPromptTokens) {
        currentItems = candidateItems;
        continue;
      }

      if (currentItems.length > 0) {
        prompts.push(
          buildLcmSummaryPrompt(nodeWithItems(node, currentItems), mode)
        );
        currentItems = [item];
        const singlePrompt = buildLcmSummaryPrompt(
          nodeWithItems(node, currentItems),
          mode
        );
        if (promptTokens(singlePrompt, config) > maxPromptTokens) {
          oversizedSinglePrompt = true;
          break;
        }
        continue;
      }

      oversizedSinglePrompt = true;
      break;
    }

    if (!oversizedSinglePrompt) {
      if (currentItems.length > 0) {
        prompts.push(
          buildLcmSummaryPrompt(nodeWithItems(node, currentItems), mode)
        );
      }
      if (
        prompts.length > 0 &&
        prompts.every(
          (prompt) => promptTokens(prompt, config) <= maxPromptTokens
        )
      ) {
        return prompts;
      }
    }

    itemTextTokenBudget = Math.max(64, Math.floor(itemTextTokenBudget / 2));
  }

  throw new Error(
    `LCM node ${node.id} cannot fit within ${maxPromptTokens} prompt tokens after token chunking`
  );
};

const buildSummaryPrompts = (
  node: LcmSummaryNode,
  config: LcmSummaryWorkerConfig
): Array<{ prompt: string; mode: "summary" | "partial" | "reduce" }> => {
  const prompt = buildLcmSummaryPrompt(node);
  if (promptTokens(prompt, config) <= config.maxPromptTokens) {
    return [{ prompt, mode: "summary" }];
  }
  return buildTokenBoundedPrompts(node, config, "partial").map((bounded) => ({
    prompt: bounded,
    mode: "partial"
  }));
};

export const runCodexAppServerLcmSummary: CodexLcmSummaryRunner = (
  prompt,
  config,
  timeoutMs
): Promise<LcmSummaryPromptResult> =>
  runCodexAppServerTurn(
    prompt,
    {
      appServerBinary: config.appServerBinary,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      cwd: config.cwd,
      env: config.env,
      clientName: "koed-lcm-summary-worker",
      baseInstructions:
        "You are a private local Koed LCM summary worker running in Codex app-server mode. Return only the requested JSON object.",
      developerInstructions: ""
    },
    timeoutMs
  );

const runPromptWithRetries = async (
  prompt: string,
  config: LcmSummaryWorkerConfig,
  runner: CodexLcmSummaryRunner,
  promptResults?: LcmSummaryPromptResult[]
): Promise<LcmSummaryPromptResult> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const result = await runner(prompt, config, config.timeoutMs * attempt);
      const structuredSummary = parseStructuredLcmSummary(result.text);
      const succeeded = {
        ...result,
        text: structuredSummary.summary_text.trim(),
        structuredSummary,
        attemptIndex: attempt,
        status: "succeeded" as const
      };
      promptResults?.push(succeeded);
      return succeeded;
    } catch (error) {
      lastError = error;
      if (error instanceof CodexAppServerTurnError && error.tokenUsage?.last) {
        promptResults?.push({
          text: "",
          model: error.model,
          tokenUsage: error.tokenUsage,
          threadId: error.threadId,
          turnId: error.turnId,
          rawEvents: error.rawEvents,
          attemptIndex: attempt,
          status: "failed",
          errorMessage: error.message
        });
      }
      if (attempt < config.maxAttempts && config.retryDelayMs > 0) {
        await sleep(config.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const rawTextFromAppServerEvent = (event: {
  params?: unknown;
  result?: unknown;
}): string | undefined => {
  const value = event.params ?? event.result;
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  const record = asRecord(value);
  for (const key of ["delta", "text", "content", "message"]) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) {
      return field;
    }
  }
  const item = asRecord(record.item);
  for (const key of ["text", "content", "message"]) {
    const field = item[key];
    if (typeof field === "string" && field.trim()) {
      return field;
    }
  }
  return undefined;
};

const persistLcmAppServerEvents = async (
  client: MemoryApiClient,
  node: LcmSummaryNode,
  result: LcmSummaryPromptResult,
  callIndex: number
): Promise<void> => {
  const events = result.rawEvents ?? [];
  if (events.length === 0) {
    return;
  }
  const items = events.map((event, index) => {
    const sourceHash = hash({
      workflow: "lcm_summary",
      nodeId: node.id,
      callIndex,
      threadId: result.threadId,
      turnId: result.turnId,
      index,
      method: event.method,
      params: event.params,
      result: event.result
    });
    return {
      sourceKind: "codex",
      sourceAdapterVersion: "codex-app-server-v1",
      sourceTransport: "app_server",
      externalSessionId: result.threadId,
      externalThreadId: result.threadId,
      externalTurnId: result.turnId,
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
        workflow: "lcm_summary",
        nodeId: node.id,
        callIndex,
        kind: node.kind,
        depth: node.depth,
        attemptIndex: result.attemptIndex,
        executionStatus: result.status ?? "succeeded",
        errorMessage: result.errorMessage
      }
    };
  });
  const persisted = await persistRawConversationItems(
    client,
    items,
    `LCM summary ${node.id}`
  );
  const tokenConversationItem = persisted.find((item) => {
    const record = asRecord(item);
    return record.sourceEventType === "thread/tokenUsage/updated";
  });
  const tokenConversationItemId =
    typeof tokenConversationItem?.id === "string"
      ? tokenConversationItem.id
      : undefined;
  const lastUsage = result.tokenUsage?.last;
  if (lastUsage) {
    await client.recordTokenUsage({
      workflowType: "lcm_summary",
      workflowId: node.id,
      lcmNodeId: node.id,
      conversationItemId: tokenConversationItemId,
      sourceRuntime: "codex",
      sourceKind: "codex",
      sourceAdapterVersion: "codex-app-server-v1",
      usageSource: "app_server",
      usageAccuracy: "provider_reported",
      usageKind: "turn_delta",
      connectorClient: "codex",
      model: result.model,
      modelContextWindow: result.tokenUsage?.modelContextWindow ?? null,
      inputTokens: lastUsage.inputTokens ?? null,
      cachedInputTokens: lastUsage.cachedInputTokens ?? null,
      outputTokens: lastUsage.outputTokens ?? null,
      reasoningOutputTokens: lastUsage.reasoningOutputTokens ?? null,
      totalTokens: lastUsage.totalTokens ?? null,
      usageScope: "last",
      metadata: {
        threadId: result.threadId,
        turnId: result.turnId,
        callIndex,
        kind: node.kind,
        depth: node.depth,
        attemptIndex: result.attemptIndex,
        executionStatus: result.status ?? "succeeded",
        errorMessage: result.errorMessage
      },
      idempotencyKey: tokenConversationItemId
        ? `token:${tokenConversationItemId}:last`
        : `lcm-summary:${node.id}:${callIndex}:token:last`
    });
  }
  await projectRawConversationItems(
    client,
    persisted,
    `LCM summary ${node.id}`
  );
};

const reduceShardSummaries = async (
  node: LcmSummaryNode,
  shardSummaries: LcmSummaryPromptResult[],
  config: LcmSummaryWorkerConfig,
  runner: CodexLcmSummaryRunner,
  promptResults: LcmSummaryPromptResult[],
  stats: {
    promptTokenSum: number;
    maxPromptTokens: number;
    promptCallCount: number;
  }
): Promise<LcmSummaryPromptResult> => {
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
  const nextSummaries: LcmSummaryPromptResult[] = [];

  for (const prompt of reducePrompts) {
    const tokens = promptTokens(prompt, config);
    stats.promptTokenSum += tokens;
    stats.maxPromptTokens = Math.max(stats.maxPromptTokens, tokens);
    stats.promptCallCount += 1;
    const result = await runPromptWithRetries(
      prompt,
      config,
      runner,
      promptResults
    );
    nextSummaries.push(result);
  }

  if (nextSummaries.length === shardSummaries.length) {
    throw new Error(
      `LCM node ${node.id} reduce step did not shrink ${shardSummaries.length} shard summaries`
    );
  }

  return reduceShardSummaries(
    node,
    nextSummaries,
    config,
    runner,
    promptResults,
    stats
  );
};

const summarizeNode = async (
  client: MemoryApiClient,
  node: LcmSummaryNode,
  config: LcmSummaryWorkerConfig,
  runner: CodexLcmSummaryRunner
): Promise<LcmSummaryResult> => {
  if (config.provider !== CODEX_SUMMARY_PROVIDER) {
    return {
      nodeId: node.id,
      kind: node.kind,
      depth: node.depth,
      submitted: false,
      error: `LCM summary provider is ${config.provider}`
    };
  }

  const stats = {
    promptTokenSum: 0,
    maxPromptTokens: 0,
    promptCallCount: 0
  };

  try {
    const prompts = buildSummaryPrompts(node, config);
    const promptResults: LcmSummaryPromptResult[] = [];
    const shardSummaries: LcmSummaryPromptResult[] = [];
    for (const entry of prompts) {
      const tokens = promptTokens(entry.prompt, config);
      stats.promptTokenSum += tokens;
      stats.maxPromptTokens = Math.max(stats.maxPromptTokens, tokens);
      stats.promptCallCount += 1;
      const result = await runPromptWithRetries(
        entry.prompt,
        config,
        runner,
        promptResults
      );
      shardSummaries.push(result);
    }
    const result =
      prompts.length === 1
        ? shardSummaries[0]!
        : await reduceShardSummaries(
            node,
            shardSummaries,
            config,
            runner,
            promptResults,
            stats
          );
    const summaryText = result.text.trim();
    const summaryTokens = countTokensForModel(summaryText, {
      model: config.model
    });
    for (const [index, promptResult] of promptResults.entries()) {
      try {
        await persistLcmAppServerEvents(client, node, promptResult, index);
      } catch (error) {
        console.warn(
          `[lcm-summary-worker] Failed to persist app-server telemetry for node ${node.id} shard ${index}; preserving generated summary.`,
          error
        );
      }
    }
    await client.submitLcmSummary(node.id, {
      summaryText,
      summaryModel: result.model,
      summaryPromptVersion: LCM_SUMMARY_PROMPT_VERSION,
      summaryTokenEstimate: summaryTokens.tokens,
      summaryStructuredJson: result.structuredSummary,
      summaryStructuredSchemaVersion: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
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

export const summarizePendingLcmNodes = async (
  client: MemoryApiClient,
  options: {
    limit?: number;
    config?: LcmSummaryWorkerConfig;
    runner?: CodexLcmSummaryRunner;
  } = {}
) => {
  const config = options.config ?? resolveLcmSummaryWorkerConfig();
  const runner = options.runner ?? runCodexAppServerLcmSummary;
  const requestedLimit = options.limit ?? 10;
  const releaseLock = acquireLocalSummaryLock(
    config.env,
    Math.max(config.timeoutMs * config.maxAttempts * requestedLimit, 1_800_000)
  );
  if (!releaseLock) {
    return {
      requestedLimit,
      processedCount: 0,
      submittedCount: 0,
      failedCount: 0,
      skippedReason: "already_running",
      localOnly: true,
      config: {
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: config.timeoutMs,
        maxAttempts: config.maxAttempts,
        retryDelayMs: config.retryDelayMs,
        concurrency: config.concurrency,
        maxPromptTokens: config.maxPromptTokens,
        appServerBinary: config.appServerBinary
      },
      results: []
    };
  }

  const results: LcmSummaryResult[] = [];

  try {
    while (results.length < requestedLimit) {
      const pending = (await client.listPendingLcmSummaries({
        limit: requestedLimit - results.length
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
        (node) => summarizeNode(client, node, config, runner)
      );
      results.push(...depthResults);
      if (depthResults.every((result) => !result.submitted)) {
        break;
      }
    }

    return {
      requestedLimit,
      processedCount: results.length,
      submittedCount: results.filter((result) => result.submitted).length,
      failedCount: results.filter((result) => !result.submitted).length,
      localOnly: true,
      config: {
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: config.timeoutMs,
        maxAttempts: config.maxAttempts,
        retryDelayMs: config.retryDelayMs,
        concurrency: config.concurrency,
        maxPromptTokens: config.maxPromptTokens,
        appServerBinary: config.appServerBinary
      },
      results
    };
  } finally {
    releaseLock();
  }
};
