import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { countTokensForModel } from "@koed/core";

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
  codexBinary: string;
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
  usedFallback: boolean;
  skippedReason?: string;
}

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

export interface CompactMemoryAnswerPayload {
  markdown?: string;
  citations?: unknown[];
  localMemoryWorker?: MemoryAnswerWorkerStatus;
  retrieval: {
    evidenceCount: number;
    retrievalMode?: unknown;
  };
}

export type CodexAnswerRunner = (
  prompt: string,
  config: MemoryAnswerWorkerConfig,
  timeoutMs: number
) => Promise<{ text: string; model: string }>;

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
  const configuredBinary = resolveEnvValue(env, "MEMORY_ANSWER_CODEX_BINARY");
  const codexBinary =
    configuredBinary ?? (process.platform === "win32" ? "codex.cmd" : "codex");
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
    codexBinary,
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
): Promise<{ text: string; model: string }> => {
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
      const searchDomain = action.search_domain ?? options.searchDomain;
      const sessionId = action.session_id ?? options.sessionId;
      const workspaceId = action.workspace_id ?? options.workspaceId;
      const limit = clampLimit(action.limit, options.limit);
      const retrievalScope = options.retrievalScope;
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
    evidence: state.evidence,
    citations: state.citations,
    retrievals: state.retrievals,
    expansions: state.expansions
  };
};

export const runCodexMemoryAnswer: CodexAnswerRunner = (
  prompt,
  config,
  timeoutMs
) =>
  new Promise((resolve, reject) => {
    const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-answer-")
    );
    const outputFile = path.join(tempDirectory, "answer.md");
    const args = [
      "exec",
      "-m",
      config.model,
      "-c",
      `reasoning_effort="${config.reasoningEffort}"`,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "-C",
      config.cwd,
      "--output-last-message",
      outputFile,
      "-"
    ];
    const child = spawn(config.codexBinary, args, {
      cwd: config.cwd,
      env: config.env,
      stdio: ["pipe", "ignore", "ignore"],
      shell: process.platform === "win32",
      windowsHide: true
    });

    let settled = false;
    const cleanup = () => {
      try {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      cleanup();
      reject(new Error(`Codex memory answer timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        if (code !== 0) {
          throw new Error(
            `Codex memory answer exited with code ${code ?? "unknown"}`
          );
        }
        const text = fs.existsSync(outputFile)
          ? fs.readFileSync(outputFile, "utf8").trim()
          : "";
        if (text.length === 0) {
          throw new Error("Codex memory answer produced empty output");
        }
        resolve({
          text,
          model: `codex:${config.model}:${config.reasoningEffort}`
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        cleanup();
      }
    });

    child.stdin.end(prompt);
  });

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
  } = {}
): Promise<
  MemoryAnswerPayload & { localMemoryWorker: MemoryAnswerWorkerStatus }
> => {
  const config = options.config ?? resolveMemoryAnswerWorkerConfig();
  const promptVersion = MEMORY_ANSWER_PROMPT_VERSION;
  const fallbackMarkdown =
    typeof payload.markdown === "string" ? payload.markdown : "";

  if (config.provider !== CODEX_ANSWER_PROVIDER) {
    return {
      ...payload,
      localMemoryWorker: {
        provider: config.provider,
        promptVersion,
        model: null,
        planningMode: config.planningMode,
        usedFallback: true,
        skippedReason: "disabled"
      }
    };
  }

  if (
    config.planningMode !== "planned" &&
    evidenceItems(payload).length === 0
  ) {
    return {
      ...payload,
      localMemoryWorker: {
        provider: config.provider,
        promptVersion,
        model: null,
        planningMode: "single_pass",
        usedFallback: true,
        skippedReason: "no_evidence"
      }
    };
  }

  const runner = options.runner ?? runCodexMemoryAnswer;
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
      return {
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
          usedFallback: false
        }
      };
    } catch {
      const prompt = buildMemoryAnswerPrompt(payload);
      const promptTokens = countTokensForModel(prompt, { model: config.model });
      return {
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
      };
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
      return {
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
          usedFallback: false
        }
      };
    } catch {
      // Retry with a longer timeout, then preserve the evidence fallback.
    }
  }

  return {
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
  };
};

export const compactMemoryAnswerPayload = (
  answer: MemoryAnswerPayload & { localMemoryWorker?: MemoryAnswerWorkerStatus }
): CompactMemoryAnswerPayload => ({
  markdown: answer.markdown,
  citations: answer.citations,
  localMemoryWorker: answer.localMemoryWorker,
  retrieval: {
    evidenceCount: evidenceItems(answer).length,
    retrievalMode:
      answer.evidenceBundle?.retrieval &&
      typeof answer.evidenceBundle.retrieval === "object" &&
      "retrievalMode" in answer.evidenceBundle.retrieval
        ? (answer.evidenceBundle.retrieval as Record<string, unknown>)
            .retrievalMode
        : undefined
  }
});
