import { countTokensForModel } from "@koed/core";
import { z } from "zod";
import {
  runCodexAppServerTurn,
  resolveCodexAppServerBinary,
  type CodexAppServerRawEvent,
  type CodexThreadTokenUsage
} from "./codex-app-server-runner.js";

const CODEX_ANSWER_PROVIDER = "codex";
const DEFAULT_ANSWER_TIMEOUT_MS = 120_000;
const DEFAULT_ANSWER_PROMPT_STATE_MAX_CHARS = 200_000;
export const MEMORY_ANSWER_PROMPT_VERSION = "memory-answer-codex-worker-v2";
export const MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION = "memory-answer-v1";

export interface MemoryAnswerWorkerConfig {
  provider: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxAttempts: number;
  planningMode: "planned" | "single_pass";
  maxSearches: number;
  maxExpansions: number;
  maxPromptStateChars: number;
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
  appServerThreadId?: string;
  appServerTurnId?: string;
  appServerEvents?: CodexAppServerRawEvent[];
  usedFallback: boolean;
  skippedReason?: string;
}

export type MemoryAnswerResponseDetail =
  | "answer_only"
  | "with_citations"
  | "with_evidence";

export interface MemoryAnswerPayload {
  markdown?: string;
  structuredAnswer?: StructuredMemoryAnswer;
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

const memoryAnswerStatusSchema = z.enum([
  "found",
  "not_found",
  "insufficient",
  "pending_summary"
]);

type MemoryAnswerStatus = z.infer<typeof memoryAnswerStatusSchema>;

const memoryAnswerEvidenceSchema = z
  .object({
    evidence_index: z.number().int().nonnegative().optional(),
    source_id: z.string().min(1).optional(),
    node_id: z.string().min(1).optional(),
    visibility: z.string().min(1).optional(),
    relevance: z.string().min(1).optional(),
    support: z.string().min(1).optional()
  })
  .passthrough();

const structuredMemoryAnswerSchema = z
  .object({
    schema_version: z.literal(MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION),
    memory_status: memoryAnswerStatusSchema,
    relevant_memory_found: z.boolean(),
    answer_markdown: z.string(),
    relevance_explanation: z.string(),
    evidence: z.array(memoryAnswerEvidenceSchema).default([]),
    missing: z.array(z.string()).default([]),
    missing_evidence: z.array(z.string()).default([])
  })
  .passthrough();

export type StructuredMemoryAnswer = z.infer<
  typeof structuredMemoryAnswerSchema
>;

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
  threadId?: string;
  turnId?: string;
  rawEvents?: CodexAppServerRawEvent[];
}>;

export interface MemoryAnswerRetrievalClient {
  answer?(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  search(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  expand(
    nodeId: string,
    input?: {
      searchDomain?: string;
      sessionId?: string;
      workspaceId?: string;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
    }
  ): Promise<Record<string, unknown>>;
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
    maxSearches: Math.max(1, integerEnv(env, "MEMORY_ANSWER_MAX_SEARCHES", 6)),
    maxExpansions: Math.max(
      0,
      integerEnv(env, "MEMORY_ANSWER_MAX_EXPANSIONS", 5)
    ),
    maxPromptStateChars: Math.max(
      12_000,
      integerEnv(
        env,
        "MEMORY_ANSWER_PROMPT_STATE_MAX_CHARS",
        DEFAULT_ANSWER_PROMPT_STATE_MAX_CHARS
      )
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
    "- Cite claims with the evidence index and include memory visibility when available.",
    "- If the evidence is insufficient, say what is missing instead of guessing.",
    "- Return only one JSON object and no prose outside JSON.",
    "- The answer_markdown field is the only place for user-facing markdown.",
    "- Use memory_status=found only when supplied evidence directly supports the answer.",
    "- Use memory_status=not_found when candidates are empty or irrelevant.",
    "- Use memory_status=insufficient when evidence is partial.",
    "- Use memory_status=pending_summary when relevant memory appears to need LCM summaries before a useful answer.",
    "- Include evidence entries only for genuinely supporting evidence.",
    "",
    "Required JSON shape:",
    JSON.stringify(
      {
        schema_version: MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
        memory_status: "found | not_found | insufficient | pending_summary",
        relevant_memory_found:
          "true only when at least one memory candidate is genuinely relevant",
        answer_markdown: "Concise markdown answer for the main agent.",
        relevance_explanation:
          "Short explanation of why the selected evidence is relevant, or why no relevant memory was found.",
        evidence: [
          {
            evidence_index: 0,
            source_id: "optional source/node id",
            visibility: "personal | team",
            relevance: "why this evidence supports the answer",
            support: "short quote or paraphrase from evidence"
          }
        ],
        missing: ["what is missing when status is insufficient or not_found"],
        missing_evidence: ["what would be needed if insufficient"]
      },
      null,
      2
    ),
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

type PlannedAnswerStatus = MemoryAnswerStatus;

interface PlanningSearchRecord {
  query: string;
  retrievalScope: string;
  searchDomain: string;
  retrievalStage?: string;
  sessionId?: string;
  workspaceId?: string;
  recentDays?: number;
  sourceAfter?: string;
  sourceBefore?: string;
  limit: number;
  hitCount: number;
}

interface MemoryAnswerPlanningState {
  query: string;
  retrievalScope: string;
  searchDomain: string;
  sessionId?: string;
  workspaceId?: string;
  recentDays?: number;
  sourceAfter?: string;
  sourceBefore?: string;
  limit: number;
  evidence: unknown[];
  citations: unknown[];
  retrievals: unknown[];
  searches: PlanningSearchRecord[];
  expansions: unknown[];
  errors: string[];
}

interface ParsedPlannerAction {
  action: "scan" | "search" | "expand" | "answer";
  query?: string;
  stage?: string;
  search_domain?: "global" | "project" | "session";
  session_id?: string;
  workspace_id?: string;
  limit?: number;
  nodeId?: string;
  parent_node_ids?: string[];
  memoryStatus?: PlannedAnswerStatus;
  markdown?: string;
  answer?: unknown;
  structuredAnswer?: StructuredMemoryAnswer;
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

const evidenceFromExpansion = (
  expanded: Record<string, unknown>
): unknown[] => {
  const detail =
    expanded.expanded &&
    typeof expanded.expanded === "object" &&
    !Array.isArray(expanded.expanded)
      ? (expanded.expanded as Record<string, unknown>)
      : expanded;
  const sourceItems = Array.isArray(detail.sourceItems)
    ? detail.sourceItems
    : [];
  const nodeId = typeof detail.nodeId === "string" ? detail.nodeId : undefined;
  const visibility =
    typeof detail.visibility === "string" ? detail.visibility : "personal";
  return sourceItems.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) {
      return [];
    }
    const sourceId =
      typeof record.sourceId === "string" ? record.sourceId : undefined;
    return [
      {
        nodeId: nodeId ?? sourceId ?? `expanded-${index}`,
        sourceType: record.kind === "message" ? "message" : "memory_event",
        sourceId,
        retrievalStage: "expanded_source",
        visibility,
        summaryText: text,
        score: 1,
        citation: {
          nodeId: nodeId ?? sourceId ?? `expanded-${index}`,
          sourceType: record.kind === "message" ? "message" : "memory_event",
          sourceId,
          retrievalStage: "expanded_source",
          visibility
        }
      }
    ];
  });
};

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

const stringField = (
  record: Record<string, unknown>,
  names: string[]
): string | undefined => {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
};

const evidenceMatchesSelection = (
  candidate: unknown,
  selection: unknown
): boolean => {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !selection ||
    typeof selection !== "object" ||
    Array.isArray(selection)
  ) {
    return false;
  }
  const candidateRecord = candidate as Record<string, unknown>;
  const selectionRecord = selection as Record<string, unknown>;
  const selectedNodeId = stringField(selectionRecord, ["node_id", "nodeId"]);
  const selectedSourceId = stringField(selectionRecord, [
    "source_id",
    "sourceId"
  ]);
  const selectedSourceType = stringField(selectionRecord, [
    "source_type",
    "sourceType"
  ]);
  const selectedVisibility = stringField(selectionRecord, ["visibility"]);
  const candidateNodeId = stringField(candidateRecord, ["nodeId", "node_id"]);
  const candidateSourceId = stringField(candidateRecord, [
    "sourceId",
    "source_id"
  ]);
  const candidateSourceType = stringField(candidateRecord, [
    "sourceType",
    "source_type"
  ]);
  const candidateVisibility = stringField(candidateRecord, ["visibility"]);
  if (selectedNodeId && candidateNodeId && candidateNodeId !== selectedNodeId) {
    return false;
  }
  if (
    selectedSourceId &&
    candidateSourceId &&
    candidateSourceId !== selectedSourceId
  ) {
    return false;
  }
  if (
    selectedSourceType &&
    candidateSourceType &&
    candidateSourceType !== selectedSourceType
  ) {
    return false;
  }
  if (
    selectedVisibility &&
    candidateVisibility &&
    candidateVisibility !== selectedVisibility
  ) {
    return false;
  }
  return Boolean(
    (selectedNodeId && candidateNodeId === selectedNodeId) ||
    (selectedSourceId && candidateSourceId === selectedSourceId)
  );
};

const plannerSearchDomain = (
  action: ParsedPlannerAction,
  options: {
    searchDomain: string;
    sessionId?: string;
    workspaceId?: string;
  }
): {
  searchDomain: string;
  sessionId?: string;
  workspaceId?: string;
} => {
  const requested = action.search_domain ?? options.searchDomain;
  if (requested === "session") {
    const sessionId = action.session_id ?? options.sessionId;
    return sessionId
      ? { searchDomain: "session", sessionId }
      : {
          searchDomain: options.searchDomain,
          sessionId: options.sessionId,
          workspaceId: options.workspaceId
        };
  }
  if (requested === "project") {
    const workspaceId = action.workspace_id ?? options.workspaceId;
    return workspaceId
      ? { searchDomain: "project", workspaceId }
      : {
          searchDomain: options.searchDomain,
          sessionId: options.sessionId,
          workspaceId: options.workspaceId
        };
  }
  return { searchDomain: "global" };
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

const evidenceSelectedByAnswer = (
  evidence: unknown[],
  structuredAnswer: StructuredMemoryAnswer
): unknown[] => {
  const selectedIndexes = structuredAnswer.evidence
    .map((item) => item.evidence_index)
    .filter((index): index is number => typeof index === "number");
  const selectedByIndex = selectedIndexes
    .map((index) => evidence[index])
    .filter((item): item is unknown => item !== undefined);
  const selectedByIdentity = structuredAnswer.evidence.flatMap((selection) =>
    evidence.filter((candidate) =>
      evidenceMatchesSelection(candidate, selection)
    )
  );
  return appendEvidence(selectedByIndex, selectedByIdentity);
};

const retrievalsHaveAvailableCandidates = (retrievals: unknown[]): boolean =>
  retrievals.some((retrieval) => {
    const record =
      retrieval && typeof retrieval === "object" && !Array.isArray(retrieval)
        ? (retrieval as Record<string, unknown>)
        : {};
    const stages = Array.isArray(record.stages) ? record.stages : [];
    return stages.some((stage) => {
      const stageRecord =
        stage && typeof stage === "object" && !Array.isArray(stage)
          ? (stage as Record<string, unknown>)
          : {};
      const available = stageRecord.countAboveThreshold;
      return typeof available === "number" && available > 0;
    });
  });

const semanticSearchStages = new Set([
  "rollup_search",
  "leaf_search",
  "scoped_leaf_search",
  "fresh_pending_search",
  "raw_fallback_search"
]);

const retrievalsHaveAvailableSemanticCandidates = (
  retrievals: unknown[]
): boolean =>
  retrievals.some((retrieval) => {
    const record =
      retrieval && typeof retrieval === "object" && !Array.isArray(retrieval)
        ? (retrieval as Record<string, unknown>)
        : {};
    const stages = Array.isArray(record.stages) ? record.stages : [];
    return stages.some((stage) => {
      const stageRecord =
        stage && typeof stage === "object" && !Array.isArray(stage)
          ? (stage as Record<string, unknown>)
          : {};
      const name = stageRecord.name;
      const available = stageRecord.countAboveThreshold;
      return (
        typeof name === "string" &&
        semanticSearchStages.has(name) &&
        typeof available === "number" &&
        available > 0
      );
    });
  });

const hasScoreScan = (searches: PlanningSearchRecord[]): boolean =>
  searches.some((search) => search.retrievalStage === "score_scan");

const inspectedSearchStages = (searches: PlanningSearchRecord[]): Set<string> =>
  new Set(
    searches
      .map((search) => search.retrievalStage)
      .filter((stage): stage is string =>
        Boolean(stage && stage !== "score_scan")
      )
  );

const hasInspectedSemanticStage = (searches: PlanningSearchRecord[]): boolean =>
  [...inspectedSearchStages(searches)].some((stage) =>
    semanticSearchStages.has(stage)
  );

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

const parseStructuredMemoryAnswer = (value: unknown): StructuredMemoryAnswer =>
  structuredMemoryAnswerSchema.parse(value);

const parsePlannerAction = (text: string): ParsedPlannerAction => {
  const parsed = JSON.parse(stripJsonFence(text)) as Record<string, unknown>;
  const action = parsed.action;
  if (
    action !== "scan" &&
    action !== "search" &&
    action !== "expand" &&
    action !== "answer"
  ) {
    throw new Error("Planner returned an unknown action");
  }
  if (action !== "answer") {
    return parsed as unknown as ParsedPlannerAction;
  }

  const answer =
    parsed.answer && typeof parsed.answer === "object"
      ? parsed.answer
      : {
          schema_version: MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
          memory_status: parsed.memoryStatus,
          relevant_memory_found: parsed.memoryStatus === "found",
          answer_markdown: parsed.markdown,
          relevance_explanation:
            parsed.memoryStatus === "found"
              ? "Legacy planner answer marked memory as found."
              : "Legacy planner answer did not provide relevant supporting memory.",
          evidence: [],
          missing: [],
          missing_evidence: []
        };
  const structuredAnswer = parseStructuredMemoryAnswer(answer);
  return {
    ...(parsed as unknown as ParsedPlannerAction),
    memoryStatus: structuredAnswer.memory_status,
    markdown: structuredAnswer.answer_markdown,
    structuredAnswer
  };
};

const summarizeForPrompt = (value: unknown, maxChars: number): unknown => {
  const json = JSON.stringify(value);
  if (!json || json.length <= maxChars) {
    return value;
  }
  return {
    truncated: true,
    maxChars,
    preview: json.slice(0, maxChars)
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
    '- scan: {"action":"scan","query":"...","search_domain":"project|session|global","workspace_id":"...","session_id":"..."}',
    '- search: {"action":"search","stage":"rollup_search|leaf_search|scoped_leaf_search|fresh_pending_search|raw_fallback_search|lexical_search","query":"...","search_domain":"project|session|global","workspace_id":"...","session_id":"...","parent_node_ids":["..."],"limit":4}',
    '- expand: {"action":"expand","nodeId":"..."}',
    `- answer: {"action":"answer","answer":{"schema_version":"${MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION}","memory_status":"found|not_found|insufficient|pending_summary","relevant_memory_found":true,"answer_markdown":"...","relevance_explanation":"...","evidence":[],"missing":[],"missing_evidence":[]}}`,
    "",
    "Rules:",
    "- Return only one JSON object and no prose outside JSON.",
    "- Use only memory evidence supplied in this loop; do not use outside knowledge.",
    `- Honor the requested default search domain (${state.searchDomain}) for follow-up searches unless the current evidence clearly shows that a different boundary is needed.`,
    "- Honor the initial source time window for follow-up searches. Do not broaden recent_days/source date bounds inside this worker.",
    "- Use search_domain=project only when a workspace_id is available.",
    "- Use search_domain=session only when a backend session_id is available.",
    "- Use search_domain=global only for deliberately cross-project/cross-session questions.",
    "- Start with scan unless the current memory state already contains a recent scan for this question.",
    "- The scan is routing metadata only. Do not answer from scan data.",
    "- Treat scores as directional signals, not proof of relevance.",
    "- Use semantic stages before lexical_search for normal memory questions, story/detail recall, and unknown-detail questions such as 'what was the name of X?'.",
    "- Treat lexical_search as a last-resort recovery tool for exact-text lookup after semantic stages fail, or when the user is explicitly asking whether a concrete quoted phrase, identifier, filename, error text, or named topic appeared.",
    "- If fresh_pending_search or raw_fallback_search has materially stronger signals than rollups/leaves, inspect the stronger stage first.",
    "- When searching a stage, request a limit no larger than that stage's countAboveThreshold from the latest scan and no larger than maxAllowed.",
    "- Treat semantic/vector retrieval hits as candidates, not proof of relevance.",
    "- Ignore irrelevant candidate hits silently; do not include them in the markdown answer.",
    "- If the evidence is good enough, answer now instead of searching again.",
    "- If the current evidence array is empty and no scan has been run, your first action must be scan.",
    "- If a scan found available candidates and no evidence has been inspected, your next action must be search.",
    "- Do not return not_found after inspecting only one candidate stage when the scan showed other available stages and search budget remains; try another materially different stage first.",
    "- For story/detail recall, if one stage is irrelevant, prefer trying leaf_search or raw_fallback_search before giving up.",
    "- If candidate hits exist but are clearly off-topic, use memory_status=not_found and say that no matching relevant memory evidence was found.",
    "- Only use memory_status=found when at least one candidate is genuinely relevant to the question.",
    "- If evidence is partial or summaries are pending, say that clearly with memory_status=insufficient or pending_summary.",
    "- The answer_markdown field is the only place for user-facing markdown.",
    "- Include evidence entries only for genuinely supporting evidence.",
    "- The main agent may decide whether to tell the user about a not_found result, so keep not_found markdown concise.",
    `- Remaining search budget: ${Math.max(0, config.maxSearches - state.searches.length)}.`,
    `- Remaining expand budget: ${Math.max(0, config.maxExpansions - state.expansions.length)}.`,
    options.forceAnswer
      ? "- You must use the answer action now; do not search or expand."
      : "- Choose search or expand only if it is likely to materially improve the answer.",
    "",
    "Example no-evidence first step:",
    JSON.stringify({
      action: "scan",
      query: "the user question rewritten for memory retrieval",
      search_domain: state.searchDomain,
      ...(state.searchDomain === "project" && state.workspaceId
        ? { workspace_id: state.workspaceId }
        : {}),
      ...(state.searchDomain === "session" && state.sessionId
        ? { session_id: state.sessionId }
        : {}),
      limit: 10
    }),
    "",
    "Example final not-found answer:",
    `{"action":"answer","answer":{"schema_version":"${MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION}","memory_status":"not_found","relevant_memory_found":false,"answer_markdown":"No matching memory evidence found.","relevance_explanation":"The supplied candidates do not directly answer the question.","evidence":[],"missing":["relevant memory evidence"],"missing_evidence":["relevant memory evidence"]}}`,
    "",
    `Question: ${state.query}`,
    `Default retrieval scope: ${state.retrievalScope}`,
    `Default search domain: ${state.searchDomain}`,
    state.workspaceId ? `Default workspace_id: ${state.workspaceId}` : "",
    state.sessionId ? `Default session_id: ${state.sessionId}` : "",
    state.recentDays ? `Default recent_days: ${state.recentDays}` : "",
    state.sourceAfter ? `Default source_after: ${state.sourceAfter}` : "",
    state.sourceBefore ? `Default source_before: ${state.sourceBefore}` : "",
    `Default limit: ${state.limit}`,
    "",
    "Current memory state JSON:",
    JSON.stringify(
      summarizeForPrompt(
        {
          evidence: state.evidence,
          citations: state.citations,
          retrievals: state.retrievals,
          searches: state.searches,
          expansions: state.expansions,
          errors: state.errors
        },
        config.maxPromptStateChars
      ),
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
  threadId?: string;
  turnId?: string;
  rawEvents?: CodexAppServerRawEvent[];
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
    recentDays?: number;
    sourceAfter?: string;
    sourceBefore?: string;
    limit: number;
  }
): Promise<{
  markdown: string;
  structuredAnswer: StructuredMemoryAnswer;
  model: string;
  promptTokens: ReturnType<typeof countTokensForModel>;
  searchCount: number;
  expandCount: number;
  memoryStatus: PlannedAnswerStatus;
  tokenUsage?: CodexThreadTokenUsage;
  threadId?: string;
  turnId?: string;
  rawEvents?: CodexAppServerRawEvent[];
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
    recentDays: options.recentDays,
    sourceAfter: options.sourceAfter,
    sourceBefore: options.sourceBefore,
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
      continue;
    }

    if (action.action === "answer") {
      if (
        state.evidence.length === 0 &&
        !hasScoreScan(state.searches) &&
        state.searches.length < options.config.maxSearches
      ) {
        state.errors.push(
          "No scan has been run yet. Call scan before answering."
        );
        continue;
      }
      if (
        state.evidence.length === 0 &&
        retrievalsHaveAvailableCandidates(state.retrievals) &&
        state.searches.length < options.config.maxSearches
      ) {
        state.errors.push(
          "A scan found available candidates, but no evidence has been inspected yet. Call search for a relevant stage before answering."
        );
        continue;
      }
      const structuredAnswer =
        action.structuredAnswer ??
        parseStructuredMemoryAnswer({
          schema_version: MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
          memory_status: action.memoryStatus ?? "insufficient",
          relevant_memory_found: action.memoryStatus === "found",
          answer_markdown:
            action.markdown?.trim() || "No matching memory evidence found.",
          evidence: [],
          relevance_explanation:
            "Planner returned a legacy answer without structured relevance metadata.",
          missing: [],
          missing_evidence: []
        });
      const curatedEvidence = evidenceSelectedByAnswer(
        state.evidence,
        structuredAnswer
      );
      if (
        structuredAnswer.memory_status === "found" &&
        curatedEvidence.length === 0 &&
        state.searches.length < options.config.maxSearches
      ) {
        state.errors.push(
          "The answer used memory_status=found but did not select any resolvable supporting evidence by evidence_index, node_id, or source_id. Select supporting evidence from the inspected candidates before answering found."
        );
        continue;
      }
      if (
        structuredAnswer.memory_status === "not_found" &&
        inspectedSearchStages(state.searches).size < 2 &&
        retrievalsHaveAvailableCandidates(state.retrievals) &&
        state.searches.length < options.config.maxSearches
      ) {
        state.errors.push(
          "Do not return not_found after inspecting only one candidate stage while other scan candidates remain. Try a different stage such as leaf_search or raw_fallback_search before answering not_found."
        );
        continue;
      }
      return {
        markdown:
          action.markdown?.trim() || "No matching memory evidence found.",
        structuredAnswer,
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
        memoryStatus: structuredAnswer.memory_status,
        tokenUsage: result.tokenUsage,
        threadId: result.threadId,
        turnId: result.turnId,
        rawEvents: result.rawEvents,
        evidence: curatedEvidence,
        citations: citationsFromHits(curatedEvidence),
        retrievals: state.retrievals,
        expansions: state.expansions
      };
    }

    if (action.action === "scan") {
      const searchQuery = action.query?.trim() || state.query;
      const retrievalScope = options.retrievalScope;
      const { searchDomain, sessionId, workspaceId } = plannerSearchDomain(
        action,
        options
      );
      let scanResult: Record<string, unknown>;
      try {
        scanResult = await options.client.search({
          query: searchQuery,
          retrieval_scope: retrievalScope,
          search_domain: searchDomain,
          session_id: sessionId,
          workspace_id: workspaceId,
          recent_days: options.recentDays,
          source_after: options.sourceAfter,
          source_before: options.sourceBefore,
          retrieval_stage: "score_scan",
          limit: 1
        });
      } catch (error) {
        state.errors.push(
          `Scan failed: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      state.retrievals.push(scanResult.retrieval ?? scanResult);
      state.searches.push({
        query: searchQuery,
        retrievalScope,
        searchDomain,
        retrievalStage: "score_scan",
        sessionId,
        workspaceId,
        recentDays: options.recentDays,
        sourceAfter: options.sourceAfter,
        sourceBefore: options.sourceBefore,
        limit: 1,
        hitCount: 0
      });
      continue;
    }

    if (action.action === "search") {
      if (state.searches.length >= options.config.maxSearches) {
        state.errors.push("Search budget exhausted.");
        continue;
      }
      const searchQuery = action.query?.trim() || state.query;
      const retrievalScope = options.retrievalScope;
      const { searchDomain, sessionId, workspaceId } = plannerSearchDomain(
        action,
        options
      );
      const limit = clampLimit(action.limit, options.limit);
      if (
        action.stage === "lexical_search" &&
        !hasInspectedSemanticStage(state.searches) &&
        retrievalsHaveAvailableSemanticCandidates(state.retrievals) &&
        state.searches.length < options.config.maxSearches
      ) {
        state.errors.push(
          "Use lexical_search as a last resort. A scan found semantic candidates, so inspect a semantic stage such as rollup_search, leaf_search, fresh_pending_search, or raw_fallback_search first."
        );
        continue;
      }
      let searchResult: Record<string, unknown>;
      try {
        searchResult = await options.client.search({
          query: searchQuery,
          retrieval_scope: retrievalScope,
          search_domain: searchDomain,
          session_id: sessionId,
          workspace_id: workspaceId,
          recent_days: options.recentDays,
          source_after: options.sourceAfter,
          source_before: options.sourceBefore,
          retrieval_stage: action.stage,
          parent_node_ids: action.parent_node_ids,
          strict_limit: Boolean(action.stage),
          limit
        });
      } catch (error) {
        state.errors.push(
          `Search failed: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
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
        retrievalStage: action.stage,
        sessionId,
        workspaceId,
        recentDays: options.recentDays,
        sourceAfter: options.sourceAfter,
        sourceBefore: options.sourceBefore,
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
      const { searchDomain, sessionId, workspaceId } = plannerSearchDomain(
        action,
        options
      );
      let expanded: Record<string, unknown>;
      try {
        expanded = await options.client.expand(action.nodeId, {
          searchDomain,
          sessionId,
          workspaceId,
          recentDays: options.recentDays,
          sourceAfter: options.sourceAfter,
          sourceBefore: options.sourceBefore
        });
      } catch (error) {
        state.errors.push(
          `Expand failed: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      const expandedEvidence = evidenceFromExpansion(expanded);
      state.evidence = appendEvidence(state.evidence, expandedEvidence);
      state.citations = appendEvidence(
        state.citations,
        citationsFromHits(expandedEvidence)
      );
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
  if (state.evidence.length === 0 && !hasScoreScan(state.searches)) {
    throw new Error("Planner attempted to answer before running a scan");
  }
  if (
    state.evidence.length === 0 &&
    retrievalsHaveAvailableCandidates(state.retrievals)
  ) {
    throw new Error(
      "Planner attempted to answer without inspecting evidence from available retrieval candidates"
    );
  }
  const finalStructuredAnswer =
    finalAction.structuredAnswer ??
    parseStructuredMemoryAnswer({
      schema_version: MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
      memory_status: finalAction.memoryStatus ?? "insufficient",
      relevant_memory_found: finalAction.memoryStatus === "found",
      answer_markdown:
        finalAction.markdown?.trim() || "No matching memory evidence found.",
      evidence: [],
      relevance_explanation:
        "Planner returned a legacy final answer without structured relevance metadata.",
      missing: [],
      missing_evidence: []
    });
  const finalCuratedEvidence = evidenceSelectedByAnswer(
    state.evidence,
    finalStructuredAnswer
  );
  if (
    finalStructuredAnswer.memory_status === "found" &&
    finalCuratedEvidence.length === 0
  ) {
    throw new Error(
      "Planner returned memory_status=found without resolvable supporting evidence"
    );
  }

  return {
    markdown:
      finalAction.markdown?.trim() || "No matching memory evidence found.",
    structuredAnswer: finalStructuredAnswer,
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
    memoryStatus: finalStructuredAnswer.memory_status,
    tokenUsage: finalResult.tokenUsage,
    threadId: finalResult.threadId,
    turnId: finalResult.turnId,
    rawEvents: finalResult.rawEvents,
    evidence: finalCuratedEvidence,
    citations: citationsFromHits(finalCuratedEvidence),
    retrievals: state.retrievals,
    expansions: state.expansions
  };
};

export const runCodexAppServerMemoryAnswer: CodexAnswerRunner = (
  prompt,
  config,
  timeoutMs
) =>
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
        "You are a private local Koed memory-answer worker running in Codex app-server mode. Return only the requested JSON object.",
      developerInstructions: ""
    },
    timeoutMs
  );

const retrieveInitialEvidenceForSinglePass = async (
  payload: MemoryAnswerPayload,
  options: {
    client?: MemoryAnswerRetrievalClient;
    retrievalScope?: string;
    searchDomain?: string;
    sessionId?: string;
    workspaceId?: string;
    recentDays?: number;
    sourceAfter?: string;
    sourceBefore?: string;
    limit?: number;
  }
): Promise<MemoryAnswerPayload> => {
  if (!options.client?.answer || evidenceItems(payload).length > 0) {
    return payload;
  }
  return options.client.answer({
    query: queryFromPayload(payload),
    retrieval_scope: options.retrievalScope ?? "personal",
    search_domain: options.searchDomain ?? "project",
    session_id: options.sessionId,
    workspace_id: options.workspaceId,
    recent_days: options.recentDays,
    source_after: options.sourceAfter,
    source_before: options.sourceBefore,
    limit: options.limit ?? 10
  });
};

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
    recentDays?: number;
    sourceAfter?: string;
    sourceBefore?: string;
    limit?: number;
    responseDetail?: MemoryAnswerResponseDetail;
  } = {}
): Promise<MemoryAnswerWorkerResponse> => {
  const config = options.config ?? resolveMemoryAnswerWorkerConfig();
  const promptVersion = MEMORY_ANSWER_PROMPT_VERSION;
  const responseDetail = options.responseDetail ?? "answer_only";

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

  const initialPayload =
    config.planningMode === "planned"
      ? payload
      : await retrieveInitialEvidenceForSinglePass(payload, {
          client: options.client,
          retrievalScope: options.retrievalScope,
          searchDomain: options.searchDomain,
          sessionId: options.sessionId,
          workspaceId: options.workspaceId,
          recentDays: options.recentDays,
          sourceAfter: options.sourceAfter,
          sourceBefore: options.sourceBefore,
          limit: options.limit
        });
  const fallbackMarkdown =
    typeof initialPayload.markdown === "string" ? initialPayload.markdown : "";

  if (
    config.planningMode !== "planned" &&
    evidenceItems(initialPayload).length === 0
  ) {
    return compactMemoryAnswerPayload(
      {
        ...initialPayload,
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
        recentDays: options.recentDays,
        sourceAfter: options.sourceAfter,
        sourceBefore: options.sourceBefore,
        limit: options.limit ?? 10
      });
      return compactMemoryAnswerPayload(
        {
          ...payload,
          markdown: planned.markdown,
          structuredAnswer: planned.structuredAnswer,
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
            appServerThreadId: planned.threadId,
            appServerTurnId: planned.turnId,
            appServerEvents: planned.rawEvents,
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

  const prompt = buildMemoryAnswerPrompt(initialPayload);
  const promptTokens = countTokensForModel(prompt, { model: config.model });
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const result = await runner(prompt, config, config.timeoutMs * attempt);
      const structuredAnswer = parseStructuredMemoryAnswer(
        JSON.parse(stripJsonFence(result.text))
      );
      const markdown = structuredAnswer.answer_markdown.trim();
      if (markdown.length === 0) {
        throw new Error("Codex memory answer produced empty output");
      }
      return compactMemoryAnswerPayload(
        {
          ...initialPayload,
          markdown,
          structuredAnswer,
          localMemoryWorker: {
            provider: config.provider,
            promptVersion,
            model: result.model,
            planningMode: "single_pass",
            promptTokenEstimate: promptTokens.tokens,
            tokenizerEncoding: promptTokens.encoding,
            tokenizerModelMatched: promptTokens.exactModelMatch,
            memoryStatus: structuredAnswer.memory_status,
            tokenUsage: result.tokenUsage,
            appServerThreadId: result.threadId,
            appServerTurnId: result.turnId,
            appServerEvents: result.rawEvents,
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
      ...initialPayload,
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
