import { countTokensForModel } from "@koed/core";
import {
  runCodexAppServerTurn,
  resolveCodexAppServerBinary,
  type CodexThreadTokenUsage
} from "./codex-app-server-runner.js";

const CODEX_ANSWER_PROVIDER = "codex";
const DEFAULT_ANSWER_TIMEOUT_MS = 120_000;
export const MEMORY_ANSWER_PROMPT_VERSION = "memory-answer-codex-worker-v1";

export interface MemoryAnswerWorkerConfig {
  provider: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxAttempts: number;
  planningMode: "planned" | "single_pass";
  maxSearches: number;
  maxExpansions: number;
  appServerBinary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface MemoryAnswerWorkerStatus {
  provider: string;
  promptVersion: string;
  model: string | null;
  planningMode?: "planned" | "single_pass";
  promptTokenEstimate?: number;
  tokenizerEncoding?: string;
  tokenizerModelMatched?: boolean;
  searchCount?: number;
  expandCount?: number;
  memoryStatus?: "found" | "not_found" | "insufficient" | "pending_summary";
  tokenUsage?: CodexThreadTokenUsage;
  usedFallback: boolean;
  skippedReason?: string;
}

export type MemoryAnswerResponseDetail =
  | "answer_only"
  | "with_citations"
  | "with_evidence";

export interface MemoryAnswerPayload {
  markdown?: string;
  evidence?: unknown[];
  citations?: unknown[];
  evidenceBundle?: {
    query?: string;
    instructions?: string;
    evidence?: unknown[];
    retrieval?: unknown;
  };
  [key: string]: unknown;
}

const CITATION_METADATA_KEYS = [
  "citations",
  "rawHitsCount",
  "lcmHitsCount",
  "expandedNodeIds",
  "visibilityLabels"
] as const;

export type MemoryAnswerWorkerResponse = Partial<MemoryAnswerPayload> & {
  markdown?: string;
  localMemoryWorker: MemoryAnswerWorkerStatus;
  retrieval: {
    evidenceCount: number;
    retrievalMode?: unknown;
  };
};

export const compactMemoryAnswerPayload = (
  payload: MemoryAnswerPayload & {
    localMemoryWorker: MemoryAnswerWorkerStatus;
  },
  responseDetail: MemoryAnswerResponseDetail = "answer_only"
): MemoryAnswerWorkerResponse => {
  const retrievalSummary =
    payload.retrieval &&
    typeof payload.retrieval === "object" &&
    "evidenceCount" in payload.retrieval
      ? (payload.retrieval as MemoryAnswerWorkerResponse["retrieval"])
      : {
          evidenceCount: evidenceItems(payload).length,
          retrievalMode:
            payload.evidenceBundle?.retrieval &&
            typeof payload.evidenceBundle.retrieval === "object" &&
            "retrievalMode" in payload.evidenceBundle.retrieval
              ? (payload.evidenceBundle.retrieval as Record<string, unknown>)
                  .retrievalMode
              : undefined
        };

  if (responseDetail === "with_evidence") {
    return { ...payload, retrieval: retrievalSummary };
  }

  const compact: Record<string, unknown> & {
    markdown?: string;
    localMemoryWorker: MemoryAnswerWorkerStatus;
  } = {
    markdown: payload.markdown,
    localMemoryWorker: payload.localMemoryWorker,
    retrieval: retrievalSummary
  };

  if (responseDetail === "with_citations") {
    for (const key of CITATION_METADATA_KEYS) {
      if (payload[key] !== undefined) {
        compact[key] = payload[key];
      }
    }
  }

  return compact as MemoryAnswerWorkerResponse;
};

export type CodexAnswerRunner = (
  prompt: string,
  config: MemoryAnswerWorkerConfig,
  timeoutMs: number
) => Promise<{
  text: string;
  model: string;
  tokenUsage?: CodexThreadTokenUsage;
}>;

export interface MemoryAnswerRetrievalClient {
  search(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  expand(nodeId: string): Promise<Record<string, unknown>>;
}

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

export const resolveMemoryAnswerWorkerConfig = (
  env: NodeJS.ProcessEnv = process.env
): MemoryAnswerWorkerConfig => {
  return {
    provider:
      resolveEnvValue(env, "MEMORY_ANSWER_PROVIDER")?.toLowerCase() ??
      CODEX_ANSWER_PROVIDER,
    model: resolveEnvValue(env, "MEMORY_ANSWER_MODEL") ?? "gpt-5.4-mini",
    reasoningEffort:
      resolveEnvValue(env, "MEMORY_ANSWER_REASONING_EFFORT") ?? "high",
    timeoutMs: integerEnv(
      env,
      "MEMORY_ANSWER_TIMEOUT_MS",
      DEFAULT_ANSWER_TIMEOUT_MS
    ),
    maxAttempts: Math.max(1, integerEnv(env, "MEMORY_ANSWER_MAX_ATTEMPTS", 2)),
    planningMode:
      resolveEnvValue(env, "MEMORY_ANSWER_PLANNING_MODE") === "single_pass"
        ? "single_pass"
        : "planned",
    maxSearches: Math.max(1, integerEnv(env, "MEMORY_ANSWER_MAX_SEARCHES", 3)),
    maxExpansions: Math.max(
      0,
      integerEnv(env, "MEMORY_ANSWER_MAX_EXPANSIONS", 3)
    ),
    appServerBinary: resolveCodexAppServerBinary(env, [
      "MEMORY_ANSWER_CODEX_BINARY"
    ]),
    cwd: process.cwd(),
    env
  };
};

const evidenceItems = (payload: MemoryAnswerPayload): unknown[] =>
  payload.evidenceBundle?.evidence ?? payload.evidence ?? [];

export const buildMemoryAnswerPrompt = (
  payload: MemoryAnswerPayload
): string => {
  const query =
    typeof payload.evidenceBundle?.query === "string"
      ? payload.evidenceBundle.query
      : "Answer the user's memory question.";
  const instructions =
    typeof payload.evidenceBundle?.instructions === "string"
      ? payload.evidenceBundle.instructions
      : "Use only the cited memory evidence. If it is insufficient, say what is missing.";

  return [
    "You are a private local memory-answer worker running under the user's Codex subscription.",
    "Answer the memory question using only the supplied evidence bundle.",
    "",
    "Requirements:",
    "- Do not use outside knowledge.",
    "- Cite claims with the evidence index and include personal/team visibility when available.",
    "- If the evidence is insufficient, say what is missing instead of guessing.",
    "- Return only concise markdown for the final answer.",
    "",
    `Question: ${query}`,
    "",
    "Backend instructions:",
    instructions,
    "",
    "Evidence bundle JSON:",
    JSON.stringify(
      {
        evidence: evidenceItems(payload),
        citations: payload.citations ?? [],
        retrieval: payload.evidenceBundle?.retrieval ?? payload.retrieval
      },
      null,
      2
    )
  ].join("\n");
};

type PlannedAnswerStatus =
  | "found"
  | "not_found"
  | "insufficient"
  | "pending_summary";

interface PlanningSearchRecord {
  query: string;
  retrievalScope: string;
  searchDomain: string;
  sessionId?: string;
  workspaceId?: string;
  limit: number;
  hitCount: number;
}

interface MemoryAnswerPlanningState {
  query: string;
  retrievalScope: string;
  searchDomain: string;
  sessionId?: string;
  workspaceId?: string;
  limit: number;
  evidence: unknown[];
  citations: unknown[];
  retrievals: unknown[];
  searches: PlanningSearchRecord[];
  expansions: unknown[];
  errors: string[];
}

interface ParsedPlannerAction {
  action: "search" | "expand" | "answer";
  query?: string;
  search_domain?: "global" | "project" | "session";
  session_id?: string;
  workspace_id?: string;
  limit?: number;
  nodeId?: string;
  memoryStatus?: PlannedAnswerStatus;
  markdown?: string;
}

const clampLimit = (limit: unknown, fallback: number): number => {
  const parsed =
    typeof limit === "number"
      ? limit
      : typeof limit === "string"
        ? Number.parseInt(limit, 10)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), 50)
    : fallback;
};

const queryFromPayload = (payload: MemoryAnswerPayload): string =>
  typeof payload.evidenceBundle?.query === "string"
    ? payload.evidenceBundle.query
    : "Answer the user's memory question.";

const retrievalFromPayload = (payload: MemoryAnswerPayload): unknown =>
  payload.evidenceBundle?.retrieval ?? payload.retrieval;

const citationsFromPayload = (payload: MemoryAnswerPayload): unknown[] =>
  Array.isArray(payload.citations) ? payload.citations : [];

const hitsFromSearch = (result: Record<string, unknown>): unknown[] =>
  Array.isArray(result.hits) ? result.hits : [];

const citationsFromHits = (hits: unknown[]): unknown[] =>
  hits.flatMap((hit) =>
    hit &&
    typeof hit === "object" &&
    "citation" in hit &&
    (hit as Record<string, unknown>).citation
      ? [(hit as Record<string, unknown>).citation]
      : []
  );

const sourceKey = (item: unknown): string => {
  if (!item || typeof item !== "object") {
    return JSON.stringify(item);
  }
  const record = item as Record<string, unknown>;
  const stringPart = (value: unknown): string =>
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? String(value)
      : "";
  return [
    record.sourceType,
    record.sourceId,
    record.nodeId,
    record.visibility,
    record.summaryText
  ]
    .map(stringPart)
    .join(":");
};

const appendEvidence = (
  existing: unknown[],
  incoming: unknown[]
): unknown[] => {
  const seen = new Set(existing.map(sourceKey));
  const merged = [...existing];
  for (const item of incoming) {
    const key = sourceKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
};

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

const parsePlannerAction = (text: string): ParsedPlannerAction => {
  const parsed = JSON.parse(stripJsonFence(text)) as Record<string, unknown>;
  const action = parsed.action;
  if (action !== "search" && action !== "expand" && action !== "answer") {
    throw new Error("Planner returned an unknown action");
  }
  return parsed as unknown as ParsedPlannerAction;
};

const summarizeForPrompt = (value: unknown): unknown => {
  const json = JSON.stringify(value);
  if (!json || json.length <= 12_000) {
    return value;
  }
  return {
    truncated: true,
    preview: json.slice(0, 12_000)
  };
};

export const buildPlannedMemoryAnswerPrompt = (
  state: MemoryAnswerPlanningState,
  config: MemoryAnswerWorkerConfig,
  options: { forceAnswer?: boolean } = {}
): string =>
  [
    "You are a private local memory/RAG planning worker running under the user's Codex subscription.",
    "Your job is to decide whether memory contains relevant evidence, gather more evidence when useful, and return a concise answer for the main agent.",
    "",
    "Available actions:",
    '- search: {"action":"search","query":"...","search_domain":"project|session|global","workspace_id":"...","session_id":"...","limit":10}',
    '- expand: {"action":"expand","nodeId":"..."}',
    '- answer: {"action":"answer","memoryStatus":"found|not_found|insufficient|pending_summary","markdown":"..."}',
    "",
    "Rules:",
    "- Return only one JSON object and no prose outside JSON.",
    "- Use only memory evidence supplied in this loop; do not use outside knowledge.",
    "- Default to project-scoped memory search unless the user or task clearly needs one conversation session or all projects.",
    "- Use search_domain=session only when a backend session_id is available.",
    "- Use search_domain=global only for deliberately cross-project/cross-session questions.",
    "- Treat semantic/vector retrieval hits as candidates, not proof of relevance.",
    "- Ignore irrelevant candidate hits silently; do not include them in the markdown answer.",
    "- If the evidence is good enough, answer now instead of searching again.",
    "- If the current evidence array is empty, search budget remains, and you are not forced to answer, your first action must be search.",
    "- If candidate hits exist but are clearly off-topic, use memoryStatus=not_found and say that no matching relevant memory evidence was found.",
    "- Only use memoryStatus=found when at least one candidate is genuinely relevant to the question.",
    "- If evidence is partial or summaries are pending, say that clearly with memoryStatus=insufficient or pending_summary.",
    "- The main agent may decide whether to tell the user about a not_found result, so keep not_found markdown concise.",
    `- Remaining search budget: ${Math.max(0, config.maxSearches - state.searches.length)}.`,
    `- Remaining expand budget: ${Math.max(0, config.maxExpansions - state.expansions.length)}.`,
    options.forceAnswer
      ? "- You must use the answer action now; do not search or expand."
      : "- Choose search or expand only if it is likely to materially improve the answer.",
    "",
    "Example no-evidence first step:",
    '{"action":"search","query":"the user question rewritten for memory retrieval","search_domain":"project","limit":10}',
    "",
    "Example final not-found answer:",
    '{"action":"answer","memoryStatus":"not_found","markdown":"No matching memory evidence found."}',
    "",
    `Question: ${state.query}`,
    `Default retrieval scope: ${state.retrievalScope}`,
    `Default search domain: ${state.searchDomain}`,
    state.workspaceId ? `Default workspace_id: ${state.workspaceId}` : "",
    state.sessionId ? `Default session_id: ${state.sessionId}` : "",
    `Default limit: ${state.limit}`,
    "",
    "Current memory state JSON:",
    JSON.stringify(
      summarizeForPrompt({
        evidence: state.evidence,
        citations: state.citations,
        retrievals: state.retrievals,
        searches: state.searches,
        expansions: state.expansions,
        errors: state.errors
      }),
      null,
      2
    )
  ].join("\n");

const runCodexWithRetries = async (
  prompt: string,
  config: MemoryAnswerWorkerConfig,
  runner: CodexAnswerRunner
): Promise<{
  text: string;
  model: string;
  tokenUsage?: CodexThreadTokenUsage;
}> => {
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const result = await runner(prompt, config, config.timeoutMs * attempt);
      if (result.text.trim().length === 0) {
        throw new Error("Codex memory answer produced empty output");
      }
      return result;
    } catch {
      // Retry with a longer timeout, then let the caller preserve fallback evidence.
    }
  }

  throw new Error("Codex memory answer failed after retry attempts");
};

const runPlannedMemoryAnswer = async (
  payload: MemoryAnswerPayload,
  options: {
    config: MemoryAnswerWorkerConfig;
    runner: CodexAnswerRunner;
    client: MemoryAnswerRetrievalClient;
    retrievalScope: string;
    searchDomain: string;
    sessionId?: string;
    workspaceId?: string;
    limit: number;
  }
): Promise<{
  markdown: string;
  model: string;
  promptTokens: ReturnType<typeof countTokensForModel>;
  searchCount: number;
  expandCount: number;
  memoryStatus: PlannedAnswerStatus;
  tokenUsage?: CodexThreadTokenUsage;
  evidence: unknown[];
  citations: unknown[];
  retrievals: unknown[];
  expansions: unknown[];
}> => {
  const state: MemoryAnswerPlanningState = {
    query: queryFromPayload(payload),
    retrievalScope: options.retrievalScope,
    searchDomain: options.searchDomain,
    sessionId: options.sessionId,
    workspaceId: options.workspaceId,
    limit: options.limit,
    evidence: evidenceItems(payload),
    citations: citationsFromPayload(payload),
    retrievals: [retrievalFromPayload(payload)].filter(Boolean),
    searches: [],
    expansions: [],
    errors: []
  };
  const runner = options.runner;
  let totalPromptTokens = 0;
  const maxSteps =
    options.config.maxSearches + options.config.maxExpansions + 1;

  for (let step = 0; step < maxSteps; step += 1) {
    const prompt = buildPlannedMemoryAnswerPrompt(state, options.config);
    const promptTokens = countTokensForModel(prompt, {
      model: options.config.model
    });
    totalPromptTokens += promptTokens.tokens;
    const result = await runCodexWithRetries(prompt, options.config, runner);
    let action: ParsedPlannerAction;
    try {
      action = parsePlannerAction(result.text);
    } catch (error) {
      state.errors.push(
        `Planner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
      break;
    }

    if (action.action === "answer") {
      return {
        markdown:
          action.markdown?.trim() || "No matching memory evidence found.",
        model: result.model,
        promptTokens: {
          tokens: totalPromptTokens,
          encoding: promptTokens.encoding,
          exactModelMatch: promptTokens.exactModelMatch,
          model: options.config.model,
          tokenizer: promptTokens.tokenizer
        },
        searchCount: state.searches.length,
        expandCount: state.expansions.length,
        memoryStatus: action.memoryStatus ?? "insufficient",
        tokenUsage: result.tokenUsage,
        evidence: state.evidence,
        citations: state.citations,
        retrievals: state.retrievals,
        expansions: state.expansions
      };
    }

    if (action.action === "search") {
      if (state.searches.length >= options.config.maxSearches) {
        state.errors.push("Search budget exhausted.");
        continue;
      }
      const searchQuery = action.query?.trim() || state.query;
      const retrievalScope = options.retrievalScope;
      const searchDomain = action.search_domain ?? options.searchDomain;
      const sessionId = action.session_id ?? options.sessionId;
      const workspaceId = action.workspace_id ?? options.workspaceId;
      const limit = clampLimit(action.limit, options.limit);
      const searchResult = await options.client.search({
        query: searchQuery,
        retrieval_scope: retrievalScope,
        search_domain: searchDomain,
        session_id: sessionId,
        workspace_id: workspaceId,
        limit
      });
      const hits = hitsFromSearch(searchResult);
      state.evidence = appendEvidence(state.evidence, hits);
      state.citations = appendEvidence(
        state.citations,
        citationsFromHits(hits)
      );
      state.retrievals.push(searchResult.retrieval ?? searchResult);
      state.searches.push({
        query: searchQuery,
        retrievalScope,
        searchDomain,
        sessionId,
        workspaceId,
        limit,
        hitCount: hits.length
      });
      continue;
    }

    if (action.action === "expand") {
      if (state.expansions.length >= options.config.maxExpansions) {
        state.errors.push("Expand budget exhausted.");
        continue;
      }
      if (!action.nodeId) {
        state.errors.push("Planner requested expand without nodeId.");
        continue;
      }
      const expanded = await options.client.expand(action.nodeId);
      state.expansions.push(expanded);
    }
  }

  const finalPrompt = buildPlannedMemoryAnswerPrompt(state, options.config, {
    forceAnswer: true
  });
  const finalPromptTokens = countTokensForModel(finalPrompt, {
    model: options.config.model
  });
  totalPromptTokens += finalPromptTokens.tokens;
  const finalResult = await runCodexWithRetries(
    finalPrompt,
    options.config,
    runner
  );
  const finalAction = parsePlannerAction(finalResult.text);
  if (finalAction.action !== "answer") {
    throw new Error("Planner did not return a final answer");
  }

  return {
    markdown:
      finalAction.markdown?.trim() || "No matching memory evidence found.",
    model: finalResult.model,
    promptTokens: {
      tokens: totalPromptTokens,
      encoding: finalPromptTokens.encoding,
      exactModelMatch: finalPromptTokens.exactModelMatch,
      model: options.config.model,
      tokenizer: finalPromptTokens.tokenizer
    },
    searchCount: state.searches.length,
    expandCount: state.expansions.length,
    memoryStatus: finalAction.memoryStatus ?? "insufficient",
    tokenUsage: finalResult.tokenUsage,
    evidence: state.evidence,
    citations: state.citations,
    retrievals: state.retrievals,
    expansions: state.expansions
  };
};

export const runCodexAppServerMemoryAnswer: CodexAnswerRunner = (
  prompt,
  config,
  timeoutMs
): Promise<{
  text: string;
  model: string;
  tokenUsage?: CodexThreadTokenUsage;
}> =>
  runCodexAppServerTurn(
    prompt,
    {
      appServerBinary: config.appServerBinary,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      cwd: config.cwd,
      env: config.env,
      clientName: "koed-memory-answer-worker",
      baseInstructions:
        "You are a private local Koed memory-answer worker running in Codex app-server mode. Return only the requested final answer.",
      developerInstructions: ""
    },
    timeoutMs
  );

export const answerWithMemoryWorker = async (
  payload: MemoryAnswerPayload,
  options: {
    config?: MemoryAnswerWorkerConfig;
    runner?: CodexAnswerRunner;
    client?: MemoryAnswerRetrievalClient;
    retrievalScope?: string;
    searchDomain?: string;
    sessionId?: string;
    workspaceId?: string;
    limit?: number;
    responseDetail?: MemoryAnswerResponseDetail;
  } = {}
): Promise<MemoryAnswerWorkerResponse> => {
  const config = options.config ?? resolveMemoryAnswerWorkerConfig();
  const promptVersion = MEMORY_ANSWER_PROMPT_VERSION;
  const responseDetail = options.responseDetail ?? "answer_only";
  const fallbackMarkdown =
    typeof payload.markdown === "string" ? payload.markdown : "";

  if (config.provider !== CODEX_ANSWER_PROVIDER) {
    return compactMemoryAnswerPayload(
      {
        ...payload,
        localMemoryWorker: {
          provider: config.provider,
          promptVersion,
          model: null,
          planningMode: config.planningMode,
          usedFallback: true,
          skippedReason: "disabled"
        }
      },
      responseDetail
    );
  }

  if (
    config.planningMode !== "planned" &&
    evidenceItems(payload).length === 0
  ) {
    return compactMemoryAnswerPayload(
      {
        ...payload,
        localMemoryWorker: {
          provider: config.provider,
          promptVersion,
          model: null,
          planningMode: "single_pass",
          usedFallback: true,
          skippedReason: "no_evidence"
        }
      },
      responseDetail
    );
  }

  const runner = options.runner ?? runCodexAppServerMemoryAnswer;
  if (config.planningMode === "planned" && options.client) {
    const fallbackMarkdown =
      typeof payload.markdown === "string" ? payload.markdown : "";
    try {
      const planned = await runPlannedMemoryAnswer(payload, {
        config,
        runner,
        client: options.client,
        retrievalScope: options.retrievalScope ?? "personal",
        searchDomain: options.searchDomain ?? "project",
        sessionId: options.sessionId,
        workspaceId: options.workspaceId,
        limit: options.limit ?? 10
      });
      return compactMemoryAnswerPayload(
        {
          ...payload,
          markdown: planned.markdown,
          evidence: planned.evidence,
          citations: planned.citations,
          evidenceBundle: {
            ...payload.evidenceBundle,
            query: queryFromPayload(payload),
            evidence: planned.evidence,
            retrieval: {
              mode: "planned_local_memory",
              retrievals: planned.retrievals,
              expansions: planned.expansions
            }
          },
          localMemoryWorker: {
            provider: config.provider,
            promptVersion,
            model: planned.model,
            planningMode: "planned",
            promptTokenEstimate: planned.promptTokens.tokens,
            tokenizerEncoding: planned.promptTokens.encoding,
            tokenizerModelMatched: planned.promptTokens.exactModelMatch,
            searchCount: planned.searchCount,
            expandCount: planned.expandCount,
            memoryStatus: planned.memoryStatus,
            tokenUsage: planned.tokenUsage,
            usedFallback: false
          }
        },
        responseDetail
      );
    } catch {
      const prompt = buildMemoryAnswerPrompt(payload);
      const promptTokens = countTokensForModel(prompt, { model: config.model });
      return compactMemoryAnswerPayload(
        {
          ...payload,
          markdown:
            fallbackMarkdown && evidenceItems(payload).length > 0
              ? fallbackMarkdown
              : "Memory answer worker failed before judging retrieved evidence.",
          localMemoryWorker: {
            provider: config.provider,
            promptVersion,
            model: null,
            planningMode: "planned",
            promptTokenEstimate: promptTokens.tokens,
            tokenizerEncoding: promptTokens.encoding,
            tokenizerModelMatched: promptTokens.exactModelMatch,
            usedFallback: true,
            skippedReason: "codex_failed"
          }
        },
        responseDetail
      );
    }
  }

  const prompt = buildMemoryAnswerPrompt(payload);
  const promptTokens = countTokensForModel(prompt, { model: config.model });
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const result = await runner(prompt, config, config.timeoutMs * attempt);
      const markdown = result.text.trim();
      if (markdown.length === 0) {
        throw new Error("Codex memory answer produced empty output");
      }
      return compactMemoryAnswerPayload(
        {
          ...payload,
          markdown,
          localMemoryWorker: {
            provider: config.provider,
            promptVersion,
            model: result.model,
            planningMode: "single_pass",
            promptTokenEstimate: promptTokens.tokens,
            tokenizerEncoding: promptTokens.encoding,
            tokenizerModelMatched: promptTokens.exactModelMatch,
            tokenUsage: result.tokenUsage,
            usedFallback: false
          }
        },
        responseDetail
      );
    } catch {
      // Retry with a longer timeout, then preserve the evidence fallback.
    }
  }

  return compactMemoryAnswerPayload(
    {
      ...payload,
      markdown: fallbackMarkdown,
      localMemoryWorker: {
        provider: config.provider,
        promptVersion,
        model: null,
        planningMode: "single_pass",
        promptTokenEstimate: promptTokens.tokens,
        tokenizerEncoding: promptTokens.encoding,
        tokenizerModelMatched: promptTokens.exactModelMatch,
        usedFallback: true,
        skippedReason: "codex_failed"
      }
    },
    responseDetail
  );
};
