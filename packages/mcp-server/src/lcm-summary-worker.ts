import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chunkTextForModel,
  countTokensForModel,
  LCM_LEXICAL_ANCHOR_MAX_COUNT,
  LCM_LEXICAL_ANCHOR_MAX_LENGTH,
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  lcmLexicalAnchorGroundingPayloads,
  parseStructuredLcmSummaryCandidate,
  validateLcmLexicalAnchors,
  type RejectedLcmLexicalAnchor,
  type StructuredLcmSummary
} from "@koed/core";
import {
  CodexAppServerTurnError,
  resolveCodexAppServerBinary,
  type CodexAppServerRawEvent,
  type CodexThreadTokenUsage
} from "./codex-app-server-runner.js";
import {
  aiClientExecutionIdentity,
  resolveClaudeCodeExecutable,
  resolvePiExecutable,
  runAiClientJsonTask,
  type AiClientProvider
} from "./ai-client-runner.js";
import {
  environmentForLocalAiClientInstance,
  resolveLocalAiClientInstance
} from "./ai-client-instance-registry.js";
import type { MemoryApiClient } from "./index.js";
import {
  persistRawConversationItems,
  projectRawConversationItems
} from "./raw-conversation-items.js";
import {
  lcmSummaryPromptIds,
  loadPrompt,
  type PromptId
} from "./prompt-loader.js";

const CODEX_SUMMARY_PROVIDER = "codex";
const DEFAULT_SUMMARY_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PROMPT_TOKENS = 48_000;
const lexicalAnchorGroundingPayloads = Symbol("lexicalAnchorGroundingPayloads");
export {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  parseStructuredLcmSummary,
  validateLcmLexicalAnchors,
  type StructuredLcmSummary
} from "@koed/core";

export interface LcmSummaryWorkerConfig {
  provider: AiClientProvider;
  aiClientInstanceId: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  concurrency: number;
  maxPromptTokens: number;
  executablePath: string;
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
  [lexicalAnchorGroundingPayloads]?: string[];
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

interface LcmSummaryClaim {
  claimId: string;
  claimToken: string;
  claimGeneration: number;
  workIdentity: string;
  inputRevisionHash: string;
  compatibilityContractHash: string;
  leaseExpiresAt: string;
  node: LcmSummaryNode;
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

export interface LcmSummaryNodeExecution {
  result: VersionedLcmSummaryPromptResult;
  promptResults: VersionedLcmSummaryPromptResult[];
  promptTokenEstimate: number;
  maxPromptTokenEstimate: number;
  promptCallCount: number;
}

export type LcmSummaryPromptResult = {
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

export type VersionedLcmSummaryPromptResult = LcmSummaryPromptResult & {
  promptVersion: string;
};

interface BuiltLcmSummaryPrompt {
  text: string;
  version: string;
  exactSourcePayloads: string[];
}

export type LcmSummaryRunner = (
  prompt: string,
  config: LcmSummaryWorkerConfig,
  timeoutMs: number
) => Promise<LcmSummaryPromptResult>;

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const LCM_SUMMARY_CLAIMANT_ID = `mcp-lcm:${os.hostname()}:${process.pid}:${randomUUID()}`;

const lcmSummaryCompatibilityContractHash = (
  config: LcmSummaryWorkerConfig
): string =>
  hash({
    protocol: "lcm-summary-claim/v1",
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    structuredSummarySchemaVersion: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
    prompts: Object.fromEntries(
      lcmSummaryPromptIds.map((promptId) => {
        const prompt = loadPrompt(promptId, { env: config.env });
        return [promptId, prompt.version];
      })
    )
  });

const pdsLcmSummaryContracts = (config: LcmSummaryWorkerConfig) => ({
  leaf: {
    artifactClass: "lcm_node/v1" as const,
    nodeKind: "leaf" as const,
    lcmAlgorithmVersion: "depth0-source-items-v1",
    summaryPromptVersion: loadPrompt("lcm-summary-leaf", {
      env: config.env
    }).version,
    summaryModel: config.model,
    structuredOutputSchema: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
    sourceSelectionPolicy: "depth0-source-items-v1"
  },
  rollup: {
    artifactClass: "lcm_node/v1" as const,
    nodeKind: "rollup" as const,
    lcmAlgorithmVersion: "depth1-child-rollup-v1",
    summaryPromptVersion: loadPrompt("lcm-summary-rollup", {
      env: config.env
    }).version,
    summaryModel: config.model,
    structuredOutputSchema: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
    sourceSelectionPolicy: "depth1-child-rollup-v1"
  }
});

const lcmSummaryClaimLeaseMs = (config: LcmSummaryWorkerConfig): number =>
  Math.min(
    3_600_000,
    Math.max(300_000, config.timeoutMs * config.maxAttempts * 4)
  );

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
      | "aiClientInstanceId"
      | "model"
      | "reasoningEffort"
      | "timeoutMs"
      | "maxAttempts"
      | "retryDelayMs"
      | "concurrency"
      | "maxPromptTokens"
      | "executablePath"
      | "cwd"
    >
  > = {}
): LcmSummaryWorkerConfig => {
  const provider =
    overrides.provider ??
    resolveEnvValue(env, "MEMORY_LCM_SUMMARY_PROVIDER")?.toLowerCase() ??
    CODEX_SUMMARY_PROVIDER;
  if (provider !== "codex" && provider !== "claude" && provider !== "pi") {
    throw new Error(`Unsupported LCM summary provider: ${provider}`);
  }
  if (
    provider === "pi" &&
    !overrides.model &&
    !resolveEnvValue(env, "MEMORY_LCM_SUMMARY_MODEL")
  ) {
    throw new Error(
      "Pi LCM summary provider requires a full provider/model ID"
    );
  }
  const aiClientInstanceId =
    overrides.aiClientInstanceId ??
    resolveEnvValue(env, "MEMORY_LCM_SUMMARY_AI_CLIENT_INSTANCE") ??
    `${provider}.default`;
  const instance = resolveLocalAiClientInstance({
    instanceId: aiClientInstanceId,
    driverId: provider,
    env
  });
  const instanceEnv = environmentForLocalAiClientInstance({
    instance,
    driverId: provider,
    env
  });
  return {
    provider,
    aiClientInstanceId,
    model:
      overrides.model ??
      resolveEnvValue(env, "MEMORY_LCM_SUMMARY_MODEL") ??
      (provider === "claude" ? "haiku" : "gpt-5.6-luna"),
    reasoningEffort:
      overrides.reasoningEffort ??
      resolveEnvValue(env, "MEMORY_LCM_SUMMARY_REASONING_EFFORT") ??
      "low",
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
    executablePath:
      overrides.executablePath ??
      instance?.executablePath ??
      (provider === "claude"
        ? resolveClaudeCodeExecutable(instanceEnv)
        : provider === "pi"
          ? resolvePiExecutable(instanceEnv)
          : resolveCodexAppServerBinary(instanceEnv, [
              "MEMORY_LCM_CODEX_BINARY"
            ])),
    cwd: overrides.cwd ?? process.cwd(),
    env: instanceEnv
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const lcmSummaryLockPath = (env: NodeJS.ProcessEnv): string =>
  resolveEnvValue(env, "MEMORY_LCM_SUMMARY_LOCK_PATH") ??
  path.join(
    resolveEnvValue(env, "KOED_HOME") ?? path.join(os.homedir(), ".koed"),
    "lcm-summary.lock"
  );

const lockOwnerIsAlive = (lockPath: string): boolean | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
    };
    if (
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0
    ) {
      return null;
    }
    try {
      process.kill(parsed.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
    }
  } catch {
    return null;
  }
};

export const lcmSummaryLockState = (
  env: NodeJS.ProcessEnv,
  staleMs: number
): { locked: boolean; stale: boolean } => {
  const lockPath = lcmSummaryLockPath(env);
  try {
    const stats = fs.statSync(lockPath);
    const stale =
      Date.now() - stats.mtimeMs > staleMs ||
      lockOwnerIsAlive(lockPath) === false;
    return { locked: !stale, stale };
  } catch {
    return { locked: false, stale: false };
  }
};

export const acquireLocalSummaryLock = (
  env: NodeJS.ProcessEnv,
  staleMs: number
): (() => void) | null => {
  const lockPath = lcmSummaryLockPath(env);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const stats = fs.statSync(lockPath);
    if (
      Date.now() - stats.mtimeMs > staleMs ||
      lockOwnerIsAlive(lockPath) === false
    ) {
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
  return `- [${itemAnchor(item)}] ${label}: ${item.text ?? ""}`;
};

const lcmSummaryJsonShape = () => ({
  schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  title: "Short human-readable conversation title.",
  summary_text:
    "Complete compact semantic summary for retrieval, parent summaries, and drill-down.",
  lexical_anchors: [
    "A small set of exact, high-value source substrings selected by the LLM."
  ]
});

const objectPayload = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

const itemGroundingPayloads = (item: LcmSourceItem): string[] => {
  const preserved = item[lexicalAnchorGroundingPayloads];
  if (preserved) {
    return preserved;
  }
  return lcmLexicalAnchorGroundingPayloads([item]);
};

const exactSourcePayloads = (node: LcmSummaryNode): string[] =>
  node.sourceItems.flatMap(itemGroundingPayloads);

const lexicalAnchorRepairPrompt = (
  sourcePayloads: string[],
  rejected: RejectedLcmLexicalAnchor[],
  config: LcmSummaryWorkerConfig
): string => {
  const rejectedCounts = rejected.reduce<Record<string, number>>(
    (counts, item) => ({
      ...counts,
      [item.reason]: (counts[item.reason] ?? 0) + 1
    }),
    {}
  );
  const base = [
    "Lexical anchor grounding repair. Return JSON only.",
    'Return exactly one object shaped as {"lexical_anchors":["..."]}.',
    "The valid primary summary and its valid anchors are retained separately. Supply replacements only; an empty list is valid.",
    `Choose replacements yourself. Each must be an exact contiguous case-sensitive substring of one SOURCE payload. Maximum ${LCM_LEXICAL_ANCHOR_MAX_COUNT} exact-deduplicated anchors of ${LCM_LEXICAL_ANCHOR_MAX_LENGTH} Unicode code points each.`,
    `Rejected anchor counts by reason: ${JSON.stringify(rejectedCounts)}.`,
    "Only choose from the exact complete SOURCE EXCERPTS below; do not join text across excerpt boundaries."
  ];
  const promptLines = [...base];
  let excerptCount = 0;

  for (const payload of sourcePayloads) {
    const chunks = chunkTextForModel(payload, {
      model: config.model,
      maxTokens: Math.max(1, Math.floor(config.maxPromptTokens / 3))
    });
    for (const chunk of chunks) {
      const candidate = [
        ...promptLines,
        `SOURCE EXCERPT ${excerptCount + 1}:`,
        chunk,
        `END SOURCE EXCERPT ${excerptCount + 1}`
      ];
      if (promptTokens(candidate.join("\n"), config) > config.maxPromptTokens) {
        break;
      }
      promptLines.splice(
        promptLines.length,
        0,
        ...candidate.slice(promptLines.length)
      );
      excerptCount += 1;
    }
  }

  const prompt = promptLines.join("\n");
  if (promptTokens(prompt, config) > config.maxPromptTokens) {
    throw new Error(
      `LCM lexical-anchor repair instructions cannot fit within ${config.maxPromptTokens} prompt tokens`
    );
  }
  return prompt;
};

const parseLexicalAnchorRepair = (text: string): string[] => {
  const parsed: unknown = JSON.parse(
    text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "")
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LCM lexical-anchor repair must be a JSON object");
  }
  const anchors = (parsed as Record<string, unknown>).lexical_anchors;
  if (
    !Array.isArray(anchors) ||
    anchors.length > LCM_LEXICAL_ANCHOR_MAX_COUNT ||
    anchors.some((anchor) => typeof anchor !== "string")
  ) {
    throw new Error("LCM lexical-anchor repair anchors are invalid");
  }
  return anchors as string[];
};

const buildVersionedLcmSummaryPrompt = (
  node: LcmSummaryNode,
  mode: "summary" | "partial" | "reduce" = "summary",
  env: NodeJS.ProcessEnv = process.env
): BuiltLcmSummaryPrompt => {
  const isRollup =
    node.kind === "rollup" ||
    node.sourceItems.some((item) => item.kind === "lcm_child");
  const promptId: PromptId =
    mode === "partial"
      ? "lcm-summary-partial"
      : mode === "reduce"
        ? "lcm-summary-reduce"
        : isRollup
          ? "lcm-summary-rollup"
          : "lcm-summary-leaf";

  const placeholderSection =
    mode === "summary"
      ? ["Existing deterministic placeholder summary:", node.summaryText, ""]
      : [
          "Existing deterministic placeholder summary:",
          "(omitted from this token-bounded prompt; exact source items or shard summaries below are authoritative)",
          ""
        ];

  const loadedPrompt = loadPrompt(promptId, { env });
  return {
    version: loadedPrompt.version,
    exactSourcePayloads: exactSourcePayloads(node),
    text: [
      loadedPrompt.body,
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
    ].join("\n")
  };
};

export const buildLcmSummaryPrompt = (
  node: LcmSummaryNode,
  mode: "summary" | "partial" | "reduce" = "summary",
  env: NodeJS.ProcessEnv = process.env
): string => buildVersionedLcmSummaryPrompt(node, mode, env).text;

const promptTokens = (prompt: string, config: LcmSummaryWorkerConfig): number =>
  countTokensForModel(prompt, { model: config.model }).tokens;

const chunkSourceItems = (
  node: LcmSummaryNode,
  config: LcmSummaryWorkerConfig,
  itemTextTokenBudget: number
): LcmSourceItem[] =>
  node.sourceItems.flatMap((item) => {
    const text = item.text ?? "";
    const groundingPayloads = itemGroundingPayloads(item);
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
      [lexicalAnchorGroundingPayloads]:
        item.kind === "lcm_child"
          ? groundingPayloads.filter((payload) =>
              chunk.includes(JSON.stringify(payload).slice(1, -1))
            )
          : [chunk],
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
): BuiltLcmSummaryPrompt[] => {
  const maxPromptTokens = config.maxPromptTokens;
  let itemTextTokenBudget = Math.max(256, Math.floor(maxPromptTokens * 0.45));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const expandedItems = chunkSourceItems(node, config, itemTextTokenBudget);
    const prompts: BuiltLcmSummaryPrompt[] = [];
    let currentItems: LcmSourceItem[] = [];
    let oversizedSinglePrompt = false;

    for (const item of expandedItems) {
      const candidateItems = [...currentItems, item];
      const candidatePrompt = buildVersionedLcmSummaryPrompt(
        nodeWithItems(node, candidateItems),
        mode,
        config.env
      );
      if (promptTokens(candidatePrompt.text, config) <= maxPromptTokens) {
        currentItems = candidateItems;
        continue;
      }

      if (currentItems.length > 0) {
        prompts.push(
          buildVersionedLcmSummaryPrompt(
            nodeWithItems(node, currentItems),
            mode,
            config.env
          )
        );
        currentItems = [item];
        const singlePrompt = buildVersionedLcmSummaryPrompt(
          nodeWithItems(node, currentItems),
          mode,
          config.env
        );
        if (promptTokens(singlePrompt.text, config) > maxPromptTokens) {
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
          buildVersionedLcmSummaryPrompt(
            nodeWithItems(node, currentItems),
            mode,
            config.env
          )
        );
      }
      if (
        prompts.length > 0 &&
        prompts.every(
          (prompt) => promptTokens(prompt.text, config) <= maxPromptTokens
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
): Array<{
  prompt: string;
  promptVersion: string;
  exactSourcePayloads: string[];
  mode: "summary" | "partial" | "reduce";
}> => {
  const prompt = buildVersionedLcmSummaryPrompt(node, "summary", config.env);
  if (promptTokens(prompt.text, config) <= config.maxPromptTokens) {
    return [
      {
        prompt: prompt.text,
        promptVersion: prompt.version,
        exactSourcePayloads: prompt.exactSourcePayloads,
        mode: "summary"
      }
    ];
  }
  return buildTokenBoundedPrompts(node, config, "partial").map((bounded) => ({
    prompt: bounded.text,
    promptVersion: bounded.version,
    exactSourcePayloads: bounded.exactSourcePayloads,
    mode: "partial"
  }));
};

export const runLcmSummary: LcmSummaryRunner = (
  prompt,
  config,
  timeoutMs
): Promise<LcmSummaryPromptResult> =>
  runAiClientJsonTask(
    prompt,
    {
      provider: config.provider,
      aiClientInstanceId: config.aiClientInstanceId,
      executablePath: config.executablePath,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      cwd: config.cwd,
      env: config.env,
      clientName: "koed-lcm-summary-worker",
      systemPrompt: loadPrompt("ai-client-lcm-summary-base", {
        env: config.env
      }).body
    },
    timeoutMs
  );

export const runLcmSummaryPromptWithRetries = async (
  prompt: string,
  promptVersion: string,
  sourcePayloads: string[],
  config: LcmSummaryWorkerConfig,
  runner: LcmSummaryRunner,
  promptResults?: VersionedLcmSummaryPromptResult[],
  onRepairCall?: (prompt: string) => void
): Promise<VersionedLcmSummaryPromptResult> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const result = await runner(prompt, config, config.timeoutMs * attempt);
      const candidate = parseStructuredLcmSummaryCandidate(result.text);
      const validation = validateLcmLexicalAnchors(
        candidate.lexical_anchors,
        sourcePayloads
      );
      let structuredSummary: StructuredLcmSummary = {
        ...candidate,
        lexical_anchors: validation.valid
      };

      if (validation.rejected.length > 0) {
        const repairPrompt = lexicalAnchorRepairPrompt(
          sourcePayloads,
          validation.rejected,
          config
        );
        onRepairCall?.(repairPrompt);
        try {
          const repairResult = await runner(
            repairPrompt,
            config,
            config.timeoutMs
          );
          const repairedAnchors = parseLexicalAnchorRepair(repairResult.text);
          const repairedValidation = validateLcmLexicalAnchors(
            repairedAnchors,
            sourcePayloads
          );
          structuredSummary = {
            ...structuredSummary,
            lexical_anchors: validateLcmLexicalAnchors(
              [
                ...structuredSummary.lexical_anchors,
                ...repairedValidation.valid
              ],
              sourcePayloads
            ).valid
          };
          promptResults?.push({
            ...repairResult,
            promptVersion,
            text: structuredSummary.summary_text,
            structuredSummary,
            attemptIndex: 1,
            status: "succeeded"
          });
        } catch (repairError) {
          if (
            repairError instanceof CodexAppServerTurnError &&
            repairError.tokenUsage?.last
          ) {
            promptResults?.push({
              text: "",
              model: repairError.model,
              promptVersion,
              tokenUsage: repairError.tokenUsage,
              threadId: repairError.threadId,
              turnId: repairError.turnId,
              rawEvents: repairError.rawEvents,
              attemptIndex: 1,
              status: "failed",
              errorMessage: repairError.message
            });
          }
        }
      }
      const succeeded = {
        ...result,
        promptVersion,
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
          promptVersion,
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
  result: VersionedLcmSummaryPromptResult,
  callIndex: number,
  config: LcmSummaryWorkerConfig
): Promise<void> => {
  const events = result.rawEvents ?? [];
  const identity = aiClientExecutionIdentity(
    config.provider,
    config.aiClientInstanceId
  );
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
      sourceKind: identity.sourceKind,
      sourceAdapterVersion: identity.sourceAdapterVersion,
      sourceTransport: identity.transport,
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
      projectionVersion: identity.sourceAdapterVersion,
      metadata: {
        workflow: "lcm_summary",
        nodeId: node.id,
        callIndex,
        kind: node.kind,
        depth: node.depth,
        attemptIndex: result.attemptIndex,
        executionStatus: result.status ?? "succeeded",
        errorMessage: result.errorMessage,
        promptVersion: result.promptVersion,
        provider: identity.provider,
        aiClientInstanceId: identity.aiClientInstanceId,
        transport: identity.transport
      }
    };
  });
  const persisted =
    items.length > 0
      ? await persistRawConversationItems(
          client,
          items,
          `LCM summary ${node.id}`
        )
      : [];
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
      sourceRuntime: identity.sourceRuntime,
      sourceKind: identity.sourceKind,
      sourceAdapterVersion: identity.sourceAdapterVersion,
      usageSource: identity.usageSource,
      usageAccuracy: "provider_reported",
      usageKind: "turn_delta",
      connectorClient: identity.connectorClient,
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
        errorMessage: result.errorMessage,
        promptVersion: result.promptVersion,
        provider: identity.provider,
        aiClientInstanceId: identity.aiClientInstanceId,
        transport: identity.transport
      },
      idempotencyKey: tokenConversationItemId
        ? `token:${tokenConversationItemId}:last`
        : `lcm-summary:${node.id}:${callIndex}:token:last`
    });
  }
  if (persisted.length > 0) {
    await projectRawConversationItems(
      client,
      persisted,
      `LCM summary ${node.id}`
    );
  }
};

const reduceShardSummaries = async (
  node: LcmSummaryNode,
  shardSummaries: VersionedLcmSummaryPromptResult[],
  config: LcmSummaryWorkerConfig,
  runner: LcmSummaryRunner,
  promptResults: VersionedLcmSummaryPromptResult[],
  stats: {
    promptTokenSum: number;
    maxPromptTokens: number;
    promptCallCount: number;
  },
  assertClaimActive: () => void
): Promise<VersionedLcmSummaryPromptResult> => {
  assertClaimActive();
  if (shardSummaries.length === 1) {
    return shardSummaries[0]!;
  }

  const reduceNode: LcmSummaryNode = {
    ...node,
    sourceItems: shardSummaries.map((summary, index) => ({
      kind: "lcm_child",
      nodeId: `${node.id}:shard-${index}`,
      visibility: node.visibility,
      text: JSON.stringify(summary.structuredSummary),
      payload: {
        shardIndex: index,
        shardCount: shardSummaries.length,
        sourceSummaryModel: summary.model
      },
      position: index
    }))
  };
  const reducePrompts = buildTokenBoundedPrompts(reduceNode, config, "reduce");
  const nextSummaries: VersionedLcmSummaryPromptResult[] = [];

  for (const prompt of reducePrompts) {
    assertClaimActive();
    const tokens = promptTokens(prompt.text, config);
    stats.promptTokenSum += tokens;
    stats.maxPromptTokens = Math.max(stats.maxPromptTokens, tokens);
    stats.promptCallCount += 1;
    const result = await runLcmSummaryPromptWithRetries(
      prompt.text,
      prompt.version,
      prompt.exactSourcePayloads,
      config,
      runner,
      promptResults,
      (repairPrompt) => {
        const tokens = promptTokens(repairPrompt, config);
        stats.promptTokenSum += tokens;
        stats.maxPromptTokens = Math.max(stats.maxPromptTokens, tokens);
        stats.promptCallCount += 1;
      }
    );
    assertClaimActive();
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
    stats,
    assertClaimActive
  );
};

const startLcmSummaryClaimHeartbeat = (
  client: MemoryApiClient,
  claim: LcmSummaryClaim,
  leaseMs: number
): { assertActive: () => void; stop: () => void } => {
  let failure: Error | null = null;
  let renewing = false;
  const intervalMs = Math.max(10_000, Math.min(30_000, leaseMs / 3));
  const timer = setInterval(() => {
    if (renewing || failure) return;
    renewing = true;
    void client
      .renewLcmSummaryClaim(claim.claimId, {
        claimToken: claim.claimToken,
        claimGeneration: claim.claimGeneration,
        leaseMs
      })
      .catch((error) => {
        failure =
          error instanceof Error
            ? error
            : new Error("LCM summary claim renewal failed");
      })
      .finally(() => {
        renewing = false;
      });
  }, intervalMs);
  timer.unref();

  return {
    assertActive: () => {
      if (failure) {
        throw new Error(`LCM summary claim lost: ${failure.message}`);
      }
    },
    stop: () => clearInterval(timer)
  };
};

export const executeLcmSummaryNode = async (
  node: LcmSummaryNode,
  config: LcmSummaryWorkerConfig,
  runner: LcmSummaryRunner,
  stats: {
    promptTokenSum: number;
    maxPromptTokens: number;
    promptCallCount: number;
  } = {
    promptTokenSum: 0,
    maxPromptTokens: 0,
    promptCallCount: 0
  },
  assertClaimActive: () => void = () => undefined
): Promise<LcmSummaryNodeExecution> => {
  const prompts = buildSummaryPrompts(node, config);
  const promptResults: VersionedLcmSummaryPromptResult[] = [];
  const shardSummaries: VersionedLcmSummaryPromptResult[] = [];
  for (const entry of prompts) {
    assertClaimActive();
    const tokens = promptTokens(entry.prompt, config);
    stats.promptTokenSum += tokens;
    stats.maxPromptTokens = Math.max(stats.maxPromptTokens, tokens);
    stats.promptCallCount += 1;
    const result = await runLcmSummaryPromptWithRetries(
      entry.prompt,
      entry.promptVersion,
      entry.exactSourcePayloads,
      config,
      runner,
      promptResults,
      (repairPrompt) => {
        const tokens = promptTokens(repairPrompt, config);
        stats.promptTokenSum += tokens;
        stats.maxPromptTokens = Math.max(stats.maxPromptTokens, tokens);
        stats.promptCallCount += 1;
      }
    );
    assertClaimActive();
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
          stats,
          assertClaimActive
        );
  assertClaimActive();
  return {
    result,
    promptResults,
    promptTokenEstimate: stats.promptTokenSum,
    maxPromptTokenEstimate: stats.maxPromptTokens,
    promptCallCount: stats.promptCallCount
  };
};

const summarizeNode = async (
  client: MemoryApiClient,
  claim: LcmSummaryClaim,
  config: LcmSummaryWorkerConfig,
  runner: LcmSummaryRunner
): Promise<LcmSummaryResult> => {
  const node = claim.node;
  const stats = {
    promptTokenSum: 0,
    maxPromptTokens: 0,
    promptCallCount: 0
  };
  const lease = startLcmSummaryClaimHeartbeat(
    client,
    claim,
    lcmSummaryClaimLeaseMs(config)
  );

  try {
    const execution = await executeLcmSummaryNode(
      node,
      config,
      runner,
      stats,
      lease.assertActive
    );
    const { result, promptResults } = execution;
    const summaryText = result.text.trim();
    const summaryTokens = countTokensForModel(summaryText, {
      model: config.model
    });
    for (const [index, promptResult] of promptResults.entries()) {
      try {
        await persistLcmAppServerEvents(
          client,
          node,
          promptResult,
          index,
          config
        );
      } catch (error) {
        console.warn(
          `[lcm-summary-worker] Failed to persist app-server telemetry for node ${node.id} shard ${index}; preserving generated summary.`,
          error
        );
      }
    }
    lease.assertActive();
    await client.submitLcmSummary(node.id, {
      summaryText,
      summaryModel: result.model,
      summaryPromptVersion: result.promptVersion,
      summaryTokenEstimate: summaryTokens.tokens,
      summaryStructuredJson: result.structuredSummary,
      summaryStructuredSchemaVersion: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      claimId: claim.claimId,
      claimToken: claim.claimToken,
      claimGeneration: claim.claimGeneration,
      inputRevisionHash: claim.inputRevisionHash,
      compatibilityContractHash: claim.compatibilityContractHash
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
  } finally {
    lease.stop();
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
    runner?: LcmSummaryRunner;
  } = {}
) => {
  const config = options.config ?? resolveLcmSummaryWorkerConfig();
  const runner = options.runner ?? runLcmSummary;
  const requestedLimit = options.limit ?? 10;
  for (const promptId of lcmSummaryPromptIds) {
    loadPrompt(promptId, { env: config.env });
  }
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
        executablePath: config.executablePath
      },
      results: []
    };
  }

  const results: LcmSummaryResult[] = [];
  const compatibilityContractHash = lcmSummaryCompatibilityContractHash(config);
  const leaseMs = lcmSummaryClaimLeaseMs(config);

  try {
    while (results.length < requestedLimit) {
      const claimed = (await client.claimLcmSummaries({
        limit: requestedLimit - results.length,
        claimantId: LCM_SUMMARY_CLAIMANT_ID,
        compatibilityContractHash,
        pdsContracts: pdsLcmSummaryContracts(config),
        leaseMs
      })) as { claims?: LcmSummaryClaim[] };
      const claims = claimed.claims ?? [];
      if (claims.length === 0) {
        break;
      }

      let submittedInBatch = false;
      const depths = [
        ...new Set(claims.map(({ node }) => node.depth).sort((a, b) => a - b))
      ];
      for (const depth of depths) {
        const depthClaims = claims.filter(({ node }) => node.depth === depth);
        const depthResults = await runWithConcurrency(
          depthClaims,
          config.concurrency,
          (claim) => summarizeNode(client, claim, config, runner)
        );
        results.push(...depthResults);
        submittedInBatch ||= depthResults.some((result) => result.submitted);
      }
      if (!submittedInBatch) {
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
        executablePath: config.executablePath
      },
      results
    };
  } finally {
    releaseLock();
  }
};
