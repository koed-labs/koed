import { createHash, randomUUID } from "node:crypto";
import { codexIdePromptUserText, countTokensForModel } from "@koed/core";
import {
  MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT,
  MEMORY_RETRIEVAL_HINT_MAX_COUNT,
  MEMORY_RETRIEVAL_HINT_MAX_LENGTH,
  MEMORY_RETRIEVAL_SEMANTIC_HINT_MAX_COUNT,
  EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM,
  EMBEDDING_RETRIEVAL_QUERY_TRANSFORM,
  resolveSupportedEmbeddingModelConfig
} from "@koed/shared";
import { z } from "zod";
import {
  CodexAppServerThreadSession,
  CodexAppServerTurnError,
  resolveCodexAppServerBinary,
  type CodexAppServerDynamicToolCall,
  type CodexAppServerDynamicToolResponse,
  type CodexAppServerDynamicToolSpec,
  type CodexAppServerRawEvent,
  type CodexAppServerProcessMetrics,
  type CodexThreadTokenUsage
} from "./codex-app-server-runner.js";
import {
  loadPrompt,
  renderLoadedPrompt,
  type LoadedPrompt
} from "./prompt-loader.js";

const CODEX_ANSWER_PROVIDER = "codex";
const DEFAULT_ANSWER_TIMEOUT_MS = 120_000;
export const MEMORY_ANSWER_PROMPT_VERSION = "memory-answer-codex-worker-v4";
export const MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION = "memory-answer-v1";
const MEMORY_ANSWER_DYNAMIC_TOOL_NAMESPACE = "koed_memory";

const koedMemoryAnswerAppServerBaseInstructions = loadPrompt(
  "app-server-memory-answer-base"
).body;

const koedMemoryAnswerAppServerDeveloperInstructions = loadPrompt(
  "app-server-memory-answer-developer"
).body;

export interface MemoryAnswerWorkerConfig {
  provider: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxAttempts: number;
  maxSearches: number;
  maxExpansions: number;
  maxCandidates: number;
  maxEvidenceItems: number;
  maxEvidenceTokens: number;
  maxPromptTokens: number;
  appServerBinary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface MemoryAnswerWorkerStatus {
  provider: string;
  promptVersion: string;
  jobId: string;
  model: string | null;
  promptTokenEstimate?: number;
  tokenizerEncoding?: string;
  tokenizerModelMatched?: boolean;
  searchCount?: number;
  expandCount?: number;
  candidateCount?: number;
  evidenceTokenEstimate?: number;
  memoryStatus?: "found" | "not_found" | "insufficient" | "pending_summary";
  tokenUsage?: CodexThreadTokenUsage;
  appServerThreadId?: string;
  appServerTurnId?: string;
  appServerEvents?: CodexAppServerRawEvent[];
  appServerExecutions?: MemoryAnswerAppServerExecution[];
  usedFallback: boolean;
  skippedReason?: string;
  errorMessage?: string;
}

export interface MemoryAnswerAppServerExecution {
  answerJobId?: string;
  attemptIndex?: number;
  status?: "succeeded" | "failed";
  errorMessage?: string;
  model: string;
  tokenUsage?: CodexThreadTokenUsage;
  primaryThreadId?: string;
  threadId?: string;
  turnId?: string;
  replacementThreadReason?: string;
  rawEvents?: CodexAppServerRawEvent[];
  processMetrics?: CodexAppServerProcessMetrics;
}

export type MemoryAnswerResponseDetail =
  | "answer_only"
  | "with_citations"
  | "with_evidence"
  /** Process-internal form used for encrypted question-history persistence. */
  | "internal";

export interface MemoryAnswerRetrievalHints {
  lexical?: string[];
  exact?: string[];
  semantic?: string[];
  entities?: string[];
  temporalIntent?: string;
}

/** Direct-call-only controls for isolated Retrieval Arena runs. */
export interface MemoryAnswerEvaluationController {
  scriptedFirstPass?: boolean;
  exactAnchorChecks?: boolean;
  lcmExpansion?: boolean;
  followUpSearch?: boolean;
  fusion?: boolean;
  retrievalVariant?:
    | "production"
    | "empty_lexical_anchors"
    | "qwen_dense_single_shot"
    | "rewrite_one_dense";
}

interface ResolvedMemoryAnswerEvaluationController {
  scriptedFirstPass: boolean;
  exactAnchorChecks: boolean;
  lcmExpansion: boolean;
  followUpSearch: boolean;
  fusion: boolean;
  retrievalVariant: NonNullable<
    MemoryAnswerEvaluationController["retrievalVariant"]
  >;
}

const resolveMemoryAnswerEvaluationController = (
  controller?: MemoryAnswerEvaluationController
): ResolvedMemoryAnswerEvaluationController => ({
  scriptedFirstPass: controller?.scriptedFirstPass ?? true,
  exactAnchorChecks: controller?.exactAnchorChecks ?? true,
  lcmExpansion: controller?.lcmExpansion ?? true,
  followUpSearch: controller?.followUpSearch ?? true,
  fusion: controller?.fusion ?? true,
  retrievalVariant: controller?.retrievalVariant ?? "production"
});

const isDefaultMemoryAnswerEvaluation = (
  controller: ResolvedMemoryAnswerEvaluationController
): boolean =>
  controller.scriptedFirstPass &&
  controller.exactAnchorChecks &&
  controller.lcmExpansion &&
  controller.followUpSearch &&
  controller.fusion &&
  controller.retrievalVariant === "production";

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
  /** Opaque server-issued contract forwarded only by the retrieval client. */
  authorizationBoundary?: string;
  [key: string]: unknown;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

const booleanLikeSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return value;
}, z.boolean());

const memoryAnswerEvidenceSchema = z
  .object({
    evidence_index: z.number().int().nonnegative().optional(),
    source_type: z.string().min(1).optional(),
    source_id: z.string().min(1).optional(),
    source_chunk_index: z.number().int().nonnegative().optional(),
    node_id: z.string().min(1).optional(),
    visibility: z.string().min(1).optional(),
    relevance: z.string().min(1).optional(),
    support: z.string().min(1).optional()
  })
  .passthrough()
  .refine(
    (selection) =>
      selection.evidence_index !== undefined ||
      (selection.source_type !== undefined &&
        selection.source_id !== undefined &&
        selection.source_chunk_index !== undefined),
    {
      message:
        "Evidence selection requires evidence_index or source_type, source_id, and source_chunk_index"
    }
  );

const structuredMemoryAnswerSchema = z
  .object({
    schema_version: z.literal(MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION),
    memory_status: memoryAnswerStatusSchema,
    relevant_memory_found: booleanLikeSchema,
    answer_markdown: z.string(),
    relevance_explanation: z.string(),
    evidence: z.array(memoryAnswerEvidenceSchema).default([]),
    missing: z.array(z.string()).default([]),
    missing_evidence: z.array(z.string()).default([])
  })
  .passthrough()
  .superRefine((answer, context) => {
    const hasEvidence = answer.evidence.length > 0;
    const contradiction = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (
      answer.memory_status === "found" &&
      (!answer.relevant_memory_found || !hasEvidence)
    ) {
      contradiction(
        "found requires relevant_memory_found=true and selected evidence"
      );
    }
    if (
      answer.memory_status === "not_found" &&
      (answer.relevant_memory_found || hasEvidence)
    ) {
      contradiction(
        "not_found requires relevant_memory_found=false and no selected evidence"
      );
    }
    if (
      answer.memory_status === "insufficient" &&
      (answer.relevant_memory_found || hasEvidence)
    ) {
      contradiction(
        "insufficient requires relevant_memory_found=false and no selected evidence"
      );
    }
  });

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

  if (responseDetail === "internal") {
    return { ...payload, retrieval: retrievalSummary };
  }

  if (responseDetail === "with_evidence") {
    const publicWorker: MemoryAnswerWorkerStatus = {
      provider: payload.localMemoryWorker.provider,
      promptVersion: payload.localMemoryWorker.promptVersion,
      jobId: payload.localMemoryWorker.jobId,
      model: payload.localMemoryWorker.model,
      memoryStatus: payload.localMemoryWorker.memoryStatus,
      usedFallback: payload.localMemoryWorker.usedFallback,
      skippedReason: payload.localMemoryWorker.skippedReason
    };
    return {
      markdown: payload.markdown,
      structuredAnswer: payload.structuredAnswer,
      evidence: evidenceItems(payload),
      citations: citationsFromPayload(payload),
      localMemoryWorker: publicWorker,
      retrieval: retrievalSummary
    };
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

type CodexAnswerResult = {
  text: string;
  model: string;
  tokenUsage?: CodexThreadTokenUsage;
  primaryThreadId?: string;
  threadId?: string;
  turnId?: string;
  rawEvents?: CodexAppServerRawEvent[];
  processMetrics?: CodexAppServerProcessMetrics;
};

export interface MemoryAnswerRetrievalClient {
  search(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  expand(
    nodeId: string,
    input?: {
      searchDomain?: string;
      sessionId?: string;
      projectId?: string;
      teamWorkspaceId?: string;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
      authorizationBoundary?: string;
    }
  ): Promise<Record<string, unknown>>;
}

const retrievalClientForAuthorizationBoundary = (
  client: MemoryAnswerRetrievalClient,
  authorizationBoundary: string | undefined
): MemoryAnswerRetrievalClient => {
  if (!authorizationBoundary) return client;
  return {
    search: (input) =>
      client.search({
        ...input,
        authorization_boundary: authorizationBoundary
      }),
    expand: (nodeId, input = {}) =>
      client.expand(nodeId, { ...input, authorizationBoundary })
  };
};

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

const parsePositiveInteger = (
  value: unknown,
  fallback: number,
  options: { min?: number; max?: number } = {}
): number => {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(typeof value === "string" ? value : "", 10);
  const finite = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(
    options.max ?? Number.MAX_SAFE_INTEGER,
    Math.max(options.min ?? 1, finite)
  );
};

export const resolveMemoryAnswerWorkerConfig = (
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<
    Pick<
      MemoryAnswerWorkerConfig,
      "provider" | "model" | "reasoningEffort" | "timeoutMs" | "maxAttempts"
    >
  > = {}
): MemoryAnswerWorkerConfig => {
  return {
    provider:
      overrides.provider ??
      resolveEnvValue(env, "MEMORY_ANSWER_PROVIDER")?.toLowerCase() ??
      CODEX_ANSWER_PROVIDER,
    model:
      overrides.model ??
      resolveEnvValue(env, "MEMORY_ANSWER_MODEL") ??
      "gpt-5.6-luna",
    reasoningEffort:
      overrides.reasoningEffort ??
      resolveEnvValue(env, "MEMORY_ANSWER_REASONING_EFFORT") ??
      "low",
    timeoutMs: parsePositiveInteger(
      overrides.timeoutMs ?? resolveEnvValue(env, "MEMORY_ANSWER_TIMEOUT_MS"),
      DEFAULT_ANSWER_TIMEOUT_MS,
      { min: 1000, max: 600000 }
    ),
    maxAttempts: parsePositiveInteger(
      overrides.maxAttempts ??
        resolveEnvValue(env, "MEMORY_ANSWER_MAX_ATTEMPTS"),
      2,
      { min: 1, max: 25 }
    ),
    maxSearches: parsePositiveInteger(
      resolveEnvValue(env, "MEMORY_ANSWER_MAX_SEARCHES"),
      6,
      { min: 1, max: 50 }
    ),
    maxExpansions: Math.min(
      50,
      Math.max(0, integerEnv(env, "MEMORY_ANSWER_MAX_EXPANSIONS", 5))
    ),
    maxCandidates: parsePositiveInteger(
      resolveEnvValue(env, "MEMORY_ANSWER_MAX_CANDIDATES"),
      50,
      { min: 1, max: 200 }
    ),
    maxEvidenceItems: parsePositiveInteger(
      resolveEnvValue(env, "MEMORY_ANSWER_MAX_EVIDENCE_ITEMS"),
      50,
      { min: 1, max: 200 }
    ),
    maxEvidenceTokens: parsePositiveInteger(
      resolveEnvValue(env, "MEMORY_ANSWER_MAX_EVIDENCE_TOKENS"),
      12_000,
      { min: 256, max: 100_000 }
    ),
    maxPromptTokens: parsePositiveInteger(
      resolveEnvValue(env, "MEMORY_ANSWER_MAX_PROMPT_TOKENS"),
      24_000,
      { min: 512, max: 200_000 }
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

interface ToolSearchRecord {
  query: string;
  retrievalScope: string;
  searchDomain: string;
  retrievalStage?: string;
  sessionId?: string;
  projectId?: string;
  teamWorkspaceId?: string;
  recentDays?: number;
  sourceAfter?: string;
  sourceBefore?: string;
  limit: number;
  hitCount: number;
  phase?: "first_pass" | "worker";
  durationMs?: number;
  errorClass?: string;
}

interface ToolExpansionRecord {
  nodeId: string;
  phase: "worker";
  durationMs: number;
  sourceItemCount: number;
  errorClass?: string;
}

interface MemoryAnswerBudgetLedger {
  startedAt: number;
  deadlineAt: number;
  searchAttempts: number;
  expansionAttempts: number;
  workerAttempts: number;
  evidenceTokenEstimate: number;
  promptTokenEstimateConsumed: number;
  budgetExhaustions: MemoryAnswerBudgetKind[];
}

type MemoryAnswerBudgetKind =
  | "wall_time"
  | "searches"
  | "expansions"
  | "attempts"
  | "candidates"
  | "evidence_items"
  | "evidence_tokens"
  | "prompt_tokens";

const markBudgetExhausted = (
  ledger: MemoryAnswerBudgetLedger,
  kind: MemoryAnswerBudgetKind
): void => {
  if (!ledger.budgetExhaustions.includes(kind)) {
    ledger.budgetExhaustions.push(kind);
  }
};

const markBudgetExhaustionFromError = (
  ledger: MemoryAnswerBudgetLedger,
  error: unknown
): void => {
  if (/wall-time budget/i.test(errorMessage(error))) {
    markBudgetExhausted(ledger, "wall_time");
  }
};

interface MemoryAnswerToolState {
  query: string;
  retrievalScope: string;
  searchDomain: string;
  sessionId?: string;
  projectId?: string;
  teamWorkspaceId?: string;
  recentDays?: number;
  sourceAfter?: string;
  sourceBefore?: string;
  limit: number;
  evidence: unknown[];
  citations: unknown[];
  retrievals: unknown[];
  searches: ToolSearchRecord[];
  expansions: unknown[];
  expansionRecords: ToolExpansionRecord[];
  errors: string[];
  retrievalHints?: MemoryAnswerRetrievalHints;
  servedCachedScan: boolean;
  ledger: MemoryAnswerBudgetLedger;
  evaluation: ResolvedMemoryAnswerEvaluationController;
}

interface MemoryAnswerAttemptRun {
  result: CodexAnswerResult;
  state: MemoryAnswerToolState;
}

interface ValidatedMemoryAnswerRun {
  markdown: string;
  structuredAnswer: StructuredMemoryAnswer;
  curatedEvidence: unknown[];
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

const assertMemoryAnswerEvaluationPayload = (
  payload: MemoryAnswerPayload,
  evaluation: ResolvedMemoryAnswerEvaluationController
): void => {
  if (evaluation.retrievalVariant === "production") return;
  const retrievalValue = retrievalFromPayload(payload);
  const retrieval =
    retrievalValue &&
    typeof retrievalValue === "object" &&
    !Array.isArray(retrievalValue)
      ? (retrievalValue as Record<string, unknown>)
      : {};
  if (evaluation.retrievalVariant === "empty_lexical_anchors") {
    if (
      retrieval.evaluationComposition !==
      "valid_structured_summaries_empty_lexical_anchors"
    ) {
      throw new Error(
        "empty_lexical_anchors requires an attested isolated pre-retrieval composition"
      );
    }
    const hasNonEmptyAnchors = evidenceItems(payload).some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return false;
      const record = item as Record<string, unknown>;
      const anchors = record.lexicalAnchors ?? record.lexical_anchors;
      return Array.isArray(anchors) && anchors.length > 0;
    });
    if (hasNonEmptyAnchors) {
      throw new Error(
        "empty_lexical_anchors received evidence containing lexical anchors"
      );
    }
    return;
  }
  if (
    evaluation.scriptedFirstPass ||
    evaluation.followUpSearch ||
    evaluation.lcmExpansion ||
    evaluation.fusion
  ) {
    throw new Error(
      `${evaluation.retrievalVariant} requires single-shot retrieval with first pass, follow-up, expansion, and fusion disabled`
    );
  }
  if (
    retrieval.mode !== "retrieval_arena_dense_single_shot" ||
    retrieval.model !==
      resolveSupportedEmbeddingModelConfig("qwen3-0.6b").key ||
    retrieval.dimensions !==
      resolveSupportedEmbeddingModelConfig("qwen3-0.6b").dimensions ||
    retrieval.embeddingQueryTransform !== EMBEDDING_RETRIEVAL_QUERY_TRANSFORM ||
    retrieval.embeddingDocumentTransform !==
      EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM
  ) {
    throw new Error(
      `${evaluation.retrievalVariant} requires a service-verified qwen3-0.6b/1024 dense pre-retrieval artifact`
    );
  }
  const expectedTransform =
    evaluation.retrievalVariant === "rewrite_one_dense"
      ? "one_rewrite"
      : "none";
  if (retrieval.queryTransform !== expectedTransform) {
    throw new Error(
      `${evaluation.retrievalVariant} requires queryTransform=${expectedTransform}`
    );
  }
};

const citationsFromPayload = (payload: MemoryAnswerPayload): unknown[] =>
  Array.isArray(payload.citations) ? payload.citations : [];

const hitsFromSearch = (result: Record<string, unknown>): unknown[] => {
  if (Array.isArray(result.hits)) return result.hits;
  if (Array.isArray(result.evidence)) return result.evidence;
  const bundle = recordFromUnknown(result.evidenceBundle);
  return Array.isArray(bundle.evidence) ? bundle.evidence : [];
};

const citationsFromHits = (hits: unknown[]): unknown[] =>
  hits.flatMap((hit) =>
    hit &&
    typeof hit === "object" &&
    "citation" in hit &&
    (hit as Record<string, unknown>).citation
      ? (() => {
          const record = hit as Record<string, unknown>;
          return [
            {
              ...(sanitizeTeamIdentityMetadata(record.citation) as Record<
                string,
                unknown
              >),
              ...candidateLineage(record)
            }
          ];
        })()
      : []
  );

const unsafeCanonicalTeamIdentityKeys = new Set([
  "teamId",
  "team_id",
  "teamWorkspaceId",
  "team_workspace_id",
  "workspaceId",
  "workspace_id",
  "ownerUserId",
  "owner_user_id",
  "shareGrantId",
  "share_grant_id",
  "grantId",
  "grant_id",
  "representationId",
  "representation_id",
  "logicalMemoryId",
  "logical_memory_id",
  "consentId",
  "consent_id"
]);

const sanitizeTeamIdentityMetadata = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value !== "object" || depth >= 8) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTeamIdentityMetadata(entry, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !unsafeCanonicalTeamIdentityKeys.has(key))
      .map(([key, entry]) => [
        key,
        sanitizeTeamIdentityMetadata(entry, depth + 1)
      ])
  );
};

const unsafeProvenanceContentKeys = new Set([
  "text",
  "content",
  "body",
  "raw",
  "rawBody",
  "raw_body",
  "payload",
  "summaryText",
  "summary_text"
]);

const sanitizeProvenanceMetadata = (value: unknown, depth = 0): unknown => {
  const identitySafe = sanitizeTeamIdentityMetadata(value, depth);
  if (identitySafe === null || typeof identitySafe !== "object" || depth >= 8) {
    return identitySafe;
  }
  if (Array.isArray(identitySafe)) {
    return identitySafe.map((entry) =>
      sanitizeProvenanceMetadata(entry, depth + 1)
    );
  }
  return Object.fromEntries(
    Object.entries(identitySafe as Record<string, unknown>)
      .filter(([key]) => !unsafeProvenanceContentKeys.has(key))
      .map(([key, entry]) => [
        key,
        sanitizeProvenanceMetadata(entry, depth + 1)
      ])
  );
};

const unsafeRetrievalEvidenceKeys = new Set([
  "hits",
  "evidence",
  "candidates",
  "sourceItems",
  "source_items",
  "summaryText",
  "summary_text",
  ...unsafeProvenanceContentKeys
]);

const sanitizeRetrievalDiagnostic = (value: unknown, depth = 0): unknown => {
  const identitySafe = sanitizeTeamIdentityMetadata(value, depth);
  if (identitySafe === null || typeof identitySafe !== "object" || depth >= 8) {
    return identitySafe;
  }
  if (Array.isArray(identitySafe)) {
    return identitySafe.map((entry) =>
      sanitizeRetrievalDiagnostic(entry, depth + 1)
    );
  }
  return Object.fromEntries(
    Object.entries(identitySafe as Record<string, unknown>)
      .filter(([key]) => !unsafeRetrievalEvidenceKeys.has(key))
      .map(([key, entry]) => [
        key,
        sanitizeRetrievalDiagnostic(entry, depth + 1)
      ])
  );
};

const scalarField = (
  record: Record<string, unknown>,
  names: string[]
): string | number | undefined => {
  for (const name of names) {
    const value = record[name];
    if (
      (typeof value === "string" && value.trim()) ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value as string | number;
    }
  }
  return undefined;
};

const candidateLineage = (
  input: Record<string, unknown>
): Record<string, unknown> => {
  const record = sanitizeTeamIdentityMetadata(input) as Record<string, unknown>;
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : {};
  const provenance = sanitizeProvenanceMetadata(
    record.provenance ?? record.sourceProvenance ?? record.source_provenance
  );
  const grantProvenance = sanitizeProvenanceMetadata(
    record.grantProvenance ?? record.grant_provenance
  );
  const visibilityProvenance = sanitizeProvenanceMetadata(
    record.visibilityProvenance ?? record.visibility_provenance
  );
  const generationProvenance = sanitizeProvenanceMetadata(
    record.generationProvenance ??
      record.generation_provenance ??
      record.generation
  );
  const createdAt = scalarField(record, ["createdAt", "created_at"]);
  const occurredAt = scalarField(record, [
    "occurredAt",
    "occurred_at",
    "sourceTime",
    "source_time"
  ]);
  const capturedAt = scalarField(record, ["capturedAt", "captured_at"]);
  const sourceRevision =
    scalarField(record, ["sourceRevision", "source_revision"]) ??
    scalarField(payload, ["sourceRevision", "source_revision"]);
  const sourceGeneration =
    scalarField(record, [
      "sourceGeneration",
      "source_generation",
      "sourceGenerationId",
      "source_generation_id",
      "generationId",
      "generation_id"
    ]) ??
    scalarField(payload, [
      "sourceGeneration",
      "source_generation",
      "sourceGenerationId",
      "source_generation_id",
      "generationId",
      "generation_id"
    ]);
  const freshness =
    scalarField(record, ["freshness"]) ?? scalarField(payload, ["freshness"]);
  const representation =
    scalarField(record, ["representation"]) ??
    scalarField(payload, ["representation"]);
  const provenanceId = scalarField(record, [
    "provenanceId",
    "provenance_id",
    "sourceProvenanceId",
    "source_provenance_id",
    "pseudonymousGrantId",
    "pseudonymous_grant_id"
  ]);
  return {
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    ...(capturedAt !== undefined ? { capturedAt } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    ...(sourceGeneration !== undefined ? { sourceGeneration } : {}),
    ...(freshness !== undefined ? { freshness } : {}),
    ...(representation !== undefined ? { representation } : {}),
    ...(provenanceId !== undefined ? { provenanceId } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    ...(grantProvenance !== undefined ? { grantProvenance } : {}),
    ...(visibilityProvenance !== undefined ? { visibilityProvenance } : {}),
    ...(generationProvenance !== undefined ? { generationProvenance } : {})
  };
};

export const evidenceFromExpansion = (
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
    const canonicalSourceIdentity = recordFromUnknown(
      record.canonicalSourceIdentity ?? record.canonical_source_identity
    );
    const text =
      typeof record.text === "string"
        ? codexIdePromptUserText(record.text).trim()
        : "";
    if (!text) {
      return [];
    }
    const explicitSourceId = stringField(record, [
      "sourceId",
      "source_id",
      "id",
      "memoryEventId",
      "memory_event_id",
      "messageId",
      "message_id"
    ]);
    const sourceChunkIndex = Number.isInteger(
      record.sourceChunkIndex ??
        record.source_chunk_index ??
        record.chunkIndex ??
        record.chunk_index ??
        record.position
    )
      ? Number(
          record.sourceChunkIndex ??
            record.source_chunk_index ??
            record.chunkIndex ??
            record.chunk_index ??
            record.position
        )
      : index;
    const canonicalSourceType = stringField(canonicalSourceIdentity, [
      "sourceType",
      "source_type"
    ]);
    const sourceType =
      canonicalSourceType ??
      (typeof record.kind === "string" && record.kind.trim()
        ? record.kind
        : "memory_event");
    const sourceId =
      stringField(canonicalSourceIdentity, ["sourceId", "source_id"]) ??
      explicitSourceId ??
      `${nodeId ?? "expanded"}:${sourceType}:${sourceChunkIndex}:${index}`;
    const canonicalChunkValue = scalarField(canonicalSourceIdentity, [
      "sourceChunkIndex",
      "source_chunk_index"
    ]);
    const canonicalChunkIndex = Number.isInteger(canonicalChunkValue)
      ? Number(canonicalChunkValue)
      : sourceChunkIndex;
    const expandedEvidenceId = `${nodeId ?? "expanded"}:source:${sourceId}:${sourceChunkIndex}`;
    const supportingContext = Array.isArray(record.supportingContext)
      ? record.supportingContext
      : undefined;
    const candidateSourceLineage = candidateLineage(record);
    const expansionOccurredAt =
      candidateSourceLineage.occurredAt ??
      scalarField(record, ["createdAt", "created_at"]);
    const lineage = {
      ...candidateSourceLineage,
      ...(expansionOccurredAt !== undefined
        ? { occurredAt: expansionOccurredAt }
        : {})
    };
    return [
      {
        nodeId: expandedEvidenceId,
        sourceType,
        sourceId,
        sourceChunkIndex: canonicalChunkIndex,
        canonicalSourceIdentity: {
          sourceType,
          sourceId,
          sourceChunkIndex: canonicalChunkIndex
        },
        sourcePosition: index,
        expandedFromNodeId: nodeId,
        parentNodeIds: nodeId ? [nodeId] : [],
        corroborationGroupId: canonicalSourceType
          ? `canonical:${sourceType}:${sourceId}`
          : (nodeId ?? sourceId),
        retrievalStage: "expanded_source",
        visibility,
        summaryText: text,
        ...lineage,
        ...(supportingContext ? { supportingContext } : {}),
        score: 1,
        citation: {
          nodeId: expandedEvidenceId,
          sourceType,
          sourceId,
          sourceChunkIndex: canonicalChunkIndex,
          canonicalSourceIdentity: {
            sourceType,
            sourceId,
            sourceChunkIndex: canonicalChunkIndex
          },
          sourcePosition: index,
          expandedFromNodeId: nodeId,
          ...lineage,
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
  const canonical = recordFromUnknown(
    record.canonicalSourceIdentity ?? record.canonical_source_identity
  );
  const stringPart = (value: unknown): string =>
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? String(value)
      : "";
  const sourceType = stringPart(
    canonical.sourceType ??
      canonical.source_type ??
      record.sourceType ??
      record.source_type
  );
  const sourceId = stringPart(
    canonical.sourceId ??
      canonical.source_id ??
      record.sourceId ??
      record.source_id ??
      record.nodeId ??
      record.node_id ??
      record.expandedFromNodeId ??
      record.sourcePosition
  );
  const chunkIndex = stringPart(
    canonical.sourceChunkIndex ??
      canonical.source_chunk_index ??
      record.sourceChunkIndex ??
      record.source_chunk_index ??
      record.chunkIndex ??
      record.chunk_index ??
      0
  );
  return [sourceType || "unknown", sourceId, chunkIndex]
    .map(stringPart)
    .join(":");
};

const normalizeCandidateIdentity = (
  item: unknown,
  index: number,
  stage: string
): Record<string, unknown> => {
  const record = sanitizeTeamIdentityMetadata(
    recordFromUnknown(item)
  ) as Record<string, unknown>;
  const nodeId = stringField(record, ["nodeId", "node_id"]);
  const sourceType =
    stringField(record, ["sourceType", "source_type"]) ??
    (nodeId ? "memory_node" : stage);
  const sourcePosition =
    typeof record.sourcePosition === "number"
      ? record.sourcePosition
      : typeof record.source_position === "number"
        ? record.source_position
        : index;
  const chunkValue =
    record.sourceChunkIndex ??
    record.source_chunk_index ??
    record.chunkIndex ??
    record.chunk_index;
  const sourceChunkIndex = Number.isInteger(chunkValue)
    ? Number(chunkValue)
    : sourcePosition;
  const sourceId =
    stringField(record, ["sourceId", "source_id"]) ??
    nodeId ??
    `anonymous:${createHash("sha256")
      .update(JSON.stringify(boundedUnknown(record)))
      .digest("hex")
      .slice(0, 24)}`;
  return {
    ...record,
    ...candidateLineage(record),
    sourceType,
    sourceId,
    sourceChunkIndex,
    sourcePosition
  };
};

const candidateContributions = (item: unknown): unknown[] => {
  const record = recordFromUnknown(item);
  return Array.isArray(record.retrievalContributions)
    ? record.retrievalContributions
    : [];
};

export const mergeMemoryAnswerCandidateLists = (
  existing: unknown[],
  lists: Array<{ query: string; stage: string; hits: unknown[] }>
): unknown[] => {
  const ledger = new Map<string, Record<string, unknown>>();
  for (const [index, item] of existing.entries()) {
    const normalized = normalizeCandidateIdentity(item, index, "existing");
    ledger.set(sourceKey(normalized), normalized);
  }
  for (const list of lists) {
    list.hits.forEach((item, index) => {
      const normalized = normalizeCandidateIdentity(item, index, list.stage);
      const key = sourceKey(normalized);
      const current = ledger.get(key);
      const contribution = {
        query: list.query,
        stage: list.stage,
        rank: index + 1,
        score: normalized.score
      };
      const contributions = [...candidateContributions(current), contribution];
      ledger.set(key, {
        ...(current ?? {}),
        ...normalized,
        retrievalContributions: contributions,
        fusedScore: contributions.reduce<number>((sum, entry) => {
          const rank = recordFromUnknown(entry).rank;
          return sum + 1 / (60 + (typeof rank === "number" ? rank : 1));
        }, 0)
      });
    });
  }
  return [...ledger.values()].sort(
    (left, right) =>
      Number(right.fusedScore ?? 0) - Number(left.fusedScore ?? 0)
  );
};

const combineMemoryAnswerCandidateLists = (
  existing: unknown[],
  lists: Array<{ query: string; stage: string; hits: unknown[] }>,
  fusion: boolean
): unknown[] => {
  if (fusion) return mergeMemoryAnswerCandidateLists(existing, lists);
  return [
    ...existing.map((item, index) =>
      normalizeCandidateIdentity(item, index, "existing")
    ),
    ...lists.flatMap((list) =>
      list.hits.map((item, index) =>
        normalizeCandidateIdentity(item, index, list.stage)
      )
    )
  ];
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
  const selectedChunkIndex =
    selectionRecord.source_chunk_index ?? selectionRecord.sourceChunkIndex;
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
  const candidateChunkIndex =
    candidateRecord.sourceChunkIndex ??
    candidateRecord.source_chunk_index ??
    candidateRecord.chunkIndex ??
    candidateRecord.chunk_index;
  const candidateVisibility = stringField(candidateRecord, ["visibility"]);
  if (
    !selectedSourceId ||
    !selectedSourceType ||
    !Number.isInteger(selectedChunkIndex)
  ) {
    return false;
  }
  if (
    candidateSourceId !== selectedSourceId ||
    candidateSourceType !== selectedSourceType ||
    candidateChunkIndex !== selectedChunkIndex
  ) {
    return false;
  }
  if (selectedNodeId && candidateNodeId !== selectedNodeId) return false;
  if (
    selectedVisibility &&
    candidateVisibility &&
    candidateVisibility !== selectedVisibility
  ) {
    return false;
  }
  return true;
};

export const resolveMemoryAnswerSearchDomain = (
  requested: "global" | "project" | "session" | undefined,
  args: Record<string, unknown>,
  options: {
    searchDomain: string;
    sessionId?: string;
    projectId?: string;
  }
): {
  searchDomain: string;
  sessionId?: string;
  projectId?: string;
} => {
  const boundary = options.searchDomain;
  const searchDomain = requested ?? boundary;
  if (boundary === "session") {
    return { searchDomain: "session", sessionId: options.sessionId };
  }
  if (boundary === "project") {
    return { searchDomain: "project", projectId: options.projectId };
  }
  if (searchDomain === "session") {
    const sessionId = options.sessionId;
    return sessionId
      ? { searchDomain: "session", sessionId }
      : {
          searchDomain: options.searchDomain,
          sessionId: options.sessionId,
          projectId: options.projectId
        };
  }
  if (searchDomain === "project") {
    const projectId = options.projectId;
    return projectId
      ? { searchDomain: "project", projectId }
      : {
          searchDomain: options.searchDomain,
          sessionId: options.sessionId,
          projectId: options.projectId
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

const boundedUnknown = (
  value: unknown,
  options: {
    maxStringLength?: number;
    maxArrayLength?: number;
    depth?: number;
  } = {}
): unknown => {
  const maxStringLength = options.maxStringLength ?? 4_096;
  const maxArrayLength = options.maxArrayLength ?? 50;
  const depth = options.depth ?? 0;
  if (typeof value === "string") return value.slice(0, maxStringLength);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return "[bounded]";
  if (Array.isArray(value)) {
    return value.slice(0, maxArrayLength).map((entry) =>
      boundedUnknown(entry, {
        maxStringLength,
        maxArrayLength,
        depth: depth + 1
      })
    );
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, entry]) => [
        key,
        boundedUnknown(entry, {
          maxStringLength,
          maxArrayLength,
          depth: depth + 1
        })
      ])
  );
};

const boundEvidence = (
  evidence: unknown[],
  config: MemoryAnswerWorkerConfig
): {
  evidence: unknown[];
  tokenEstimate: number;
  exhausted: MemoryAnswerBudgetKind[];
} => {
  const bounded: unknown[] = [];
  let tokenEstimate = 0;
  const exhausted: MemoryAnswerBudgetKind[] = [];
  if (evidence.length > config.maxCandidates) exhausted.push("candidates");
  if (evidence.length > config.maxEvidenceItems)
    exhausted.push("evidence_items");
  for (const candidate of evidence.slice(
    0,
    Math.min(config.maxCandidates, config.maxEvidenceItems)
  )) {
    const safeCandidate = boundedUnknown(candidate, {
      maxStringLength: 4_096,
      maxArrayLength: 30
    });
    const record = recordFromUnknown(safeCandidate);
    const summaryText = stringField(record, [
      "summaryText",
      "summary_text",
      "text",
      "content",
      "body"
    ]);
    const lexicalAnchors = Array.isArray(
      record.lexicalAnchors ?? record.lexical_anchors
    )
      ? (record.lexicalAnchors ?? record.lexical_anchors)
      : undefined;
    const supportingContext = Array.isArray(record.supportingContext)
      ? record.supportingContext
      : undefined;
    const budgetContent =
      summaryText || lexicalAnchors || supportingContext
        ? { summaryText, lexicalAnchors, supportingContext }
        : safeCandidate;
    const tokens = countTokensForModel(JSON.stringify(budgetContent), {
      model: config.model
    }).tokens;
    if (tokenEstimate + tokens > config.maxEvidenceTokens) {
      if (!exhausted.includes("evidence_tokens")) {
        exhausted.push("evidence_tokens");
      }
      continue;
    }
    bounded.push(safeCandidate);
    tokenEstimate += tokens;
  }
  return { evidence: bounded, tokenEstimate, exhausted };
};

const recordEvidenceBudgetExhaustions = (
  ledger: MemoryAnswerBudgetLedger,
  bounded: ReturnType<typeof boundEvidence>
): void => {
  for (const kind of bounded.exhausted) markBudgetExhausted(ledger, kind);
};

const remainingRequestTime = (state: MemoryAnswerToolState): number =>
  Math.max(0, state.ledger.deadlineAt - Date.now());

const withinRequestDeadline = async <T>(
  state: MemoryAnswerToolState,
  operation: () => Promise<T>
): Promise<T> => {
  const remaining = remainingRequestTime(state);
  if (remaining <= 0)
    throw new Error("Memory answer wall-time budget exhausted");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Memory answer wall-time budget exhausted")),
          remaining
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const indexedEvidenceObservation = (evidence: unknown[], items: unknown[]) =>
  items.map((item) => ({
    evidence_index: evidence.findIndex(
      (candidate) => sourceKey(candidate) === sourceKey(item)
    ),
    item
  }));

export const evidenceSelectedByAnswer = (
  evidence: unknown[],
  structuredAnswer: StructuredMemoryAnswer
): unknown[] => {
  const selectedIndexes = structuredAnswer.evidence
    .map((item) => item.evidence_index)
    .filter((index): index is number => typeof index === "number");
  const selectedByIndex = selectedIndexes
    .map((index) => evidence[index])
    .filter((item): item is unknown => item !== undefined);
  const selectedByIdentity = structuredAnswer.evidence
    .filter((selection) => selection.evidence_index === undefined)
    .flatMap((selection) =>
      evidence.filter((candidate) =>
        evidenceMatchesSelection(candidate, selection)
      )
    );
  const selected = appendEvidence(selectedByIndex, selectedByIdentity);
  const expandedParentIds = new Set(
    selected
      .map((item) =>
        stringField(recordFromUnknown(item), [
          "expandedFromNodeId",
          "expanded_from_node_id"
        ])
      )
      .filter((value): value is string => Boolean(value))
  );
  return selected.filter((item) => {
    const record = recordFromUnknown(item);
    const nodeId = stringField(record, ["nodeId", "node_id"]);
    return !(
      nodeId &&
      expandedParentIds.has(nodeId) &&
      !stringField(record, ["expandedFromNodeId", "expanded_from_node_id"])
    );
  });
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
  "curated_memory_search",
  "fresh_pending_search",
  "raw_fallback_search"
]);

const availableCandidateStages = (retrievals: unknown[]): Set<string> => {
  const stagesWithCandidates = new Set<string>();
  for (const retrieval of retrievals) {
    const record =
      retrieval && typeof retrieval === "object" && !Array.isArray(retrieval)
        ? (retrieval as Record<string, unknown>)
        : {};
    const stages = Array.isArray(record.stages) ? record.stages : [];
    for (const stage of stages) {
      const stageRecord =
        stage && typeof stage === "object" && !Array.isArray(stage)
          ? (stage as Record<string, unknown>)
          : {};
      const name = stageRecord.name;
      const available = stageRecord.countAboveThreshold;
      if (
        typeof name === "string" &&
        semanticSearchStages.has(name) &&
        typeof available === "number" &&
        available > 0
      ) {
        stagesWithCandidates.add(name);
      }
    }
  }
  return stagesWithCandidates;
};

const inspectedSearchStages = (searches: ToolSearchRecord[]): Set<string> =>
  new Set(
    searches
      .map((search) => search.retrievalStage)
      .filter((stage): stage is string =>
        Boolean(stage && stage !== "score_scan")
      )
  );

const hasInspectedEvidenceStage = (searches: ToolSearchRecord[]): boolean =>
  [...inspectedSearchStages(searches)].length > 0;

const uninspectedAvailableCandidateStages = (
  retrievals: unknown[],
  searches: ToolSearchRecord[]
): string[] => {
  const inspected = inspectedSearchStages(searches);
  return [...availableCandidateStages(retrievals)].filter(
    (stage) => !inspected.has(stage)
  );
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

export const parseStructuredMemoryAnswer = (
  value: unknown
): StructuredMemoryAnswer => structuredMemoryAnswerSchema.parse(value);

const toolStateSummary = (
  state: MemoryAnswerToolState,
  config: MemoryAnswerWorkerConfig
) => ({
  evidenceCount: state.evidence.length,
  citationCount: state.citations.length,
  retrievalCount: state.retrievals.length,
  searchCount: state.ledger.searchAttempts,
  expansionCount: state.ledger.expansionAttempts,
  candidateCount: state.evidence.length,
  evidenceTokenEstimate: state.ledger.evidenceTokenEstimate,
  errorCount: state.errors.length,
  remainingBudgets: {
    searches: Math.max(0, config.maxSearches - state.ledger.searchAttempts),
    expansions: Math.max(
      0,
      config.maxExpansions - state.ledger.expansionAttempts
    )
  },
  retrievalCoverage: {
    scanPositiveStages: [...availableCandidateStages(state.retrievals)],
    inspectedStages: [...inspectedSearchStages(state.searches)],
    uninspectedScanPositiveStages: uninspectedAvailableCandidateStages(
      state.retrievals,
      state.searches
    )
  },
  recentSearches: state.searches.slice(-5),
  recentErrors: state.errors.slice(-5),
  firstPassErrors: state.errors.slice(0, 10)
});

const recordFromUnknown = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringArg = (
  record: Record<string, unknown>,
  name: string
): string | undefined => {
  const value = record[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const stringArrayArg = (
  record: Record<string, unknown>,
  name: string
): string[] | undefined => {
  const value = record[name];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0
  );
  return strings.length > 0 ? strings : undefined;
};

const boundedStringArrayArg = (
  record: Record<string, unknown>,
  name: string,
  maxCount: number
): string[] | undefined => {
  const values = stringArrayArg(record, name);
  if (!values) return undefined;
  const bounded = [
    ...new Set(
      values.map((value) =>
        value.trim().slice(0, MEMORY_RETRIEVAL_HINT_MAX_LENGTH)
      )
    )
  ].slice(0, maxCount);
  return bounded.length > 0 ? bounded : undefined;
};

const searchDomainArg = (
  record: Record<string, unknown>
): "global" | "project" | "session" | undefined => {
  const value = record.search_domain ?? record.searchDomain;
  return value === "global" || value === "project" || value === "session"
    ? value
    : undefined;
};

const dynamicToolSpecs = (): CodexAppServerDynamicToolSpec[] => [
  {
    namespace: MEMORY_ANSWER_DYNAMIC_TOOL_NAMESPACE,
    name: "scan",
    description:
      "Inspect Koed memory retrieval availability for the question without returning evidence bodies. Use this first to decide which retrieval stages are worth searching.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        search_domain: {
          type: "string",
          enum: ["project", "session", "global"]
        },
        project_id: { type: "string" },
        session_id: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    namespace: MEMORY_ANSWER_DYNAMIC_TOOL_NAMESPACE,
    name: "search",
    description:
      "Search one Koed memory retrieval stage and return full candidate evidence bodies. Refine query semantically and pass only exact_hints that should anchor this search. Choose stages deliberately and inspect candidates before answering.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        stage: {
          type: "string",
          enum: [
            "rollup_search",
            "leaf_search",
            "scoped_leaf_search",
            "curated_memory_search",
            "fresh_pending_search",
            "raw_fallback_search"
          ]
        },
        search_domain: {
          type: "string",
          enum: ["project", "session", "global"]
        },
        project_id: { type: "string" },
        session_id: { type: "string" },
        parent_node_ids: { type: "array", items: { type: "string" } },
        exact_hints: {
          type: "array",
          description:
            "Narrow lexical or exact anchors for this follow-up search. Duplicate values are ignored and caller hints remain the fallback when omitted.",
          items: {
            type: "string",
            maxLength: MEMORY_RETRIEVAL_HINT_MAX_LENGTH
          },
          maxItems: MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT
        },
        limit: { type: "integer", minimum: 1, maximum: 50 }
      },
      required: ["stage"],
      additionalProperties: false
    }
  },
  {
    namespace: MEMORY_ANSWER_DYNAMIC_TOOL_NAMESPACE,
    name: "expand",
    description:
      "Expand a relevant Koed LCM node into its underlying source items when summaries are promising but insufficient.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        search_domain: {
          type: "string",
          enum: ["project", "session", "global"]
        },
        project_id: { type: "string" },
        session_id: { type: "string" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  }
];

const dynamicToolResult = (
  value: unknown,
  success = true
): CodexAppServerDynamicToolResponse => ({
  success,
  text: JSON.stringify(value)
});

const createMemoryAnswerDynamicToolHandler = (
  state: MemoryAnswerToolState,
  options: {
    config: MemoryAnswerWorkerConfig;
    client: MemoryAnswerRetrievalClient;
    retrievalScope: string;
    searchDomain: string;
    sessionId?: string;
    projectId?: string;
    teamWorkspaceId?: string;
    recentDays?: number;
    sourceAfter?: string;
    sourceBefore?: string;
    limit: number;
  }
): ((
  call: CodexAppServerDynamicToolCall
) => Promise<CodexAppServerDynamicToolResponse>) => {
  const normalizeDomain = (args: Record<string, unknown>) =>
    resolveMemoryAnswerSearchDomain(searchDomainArg(args), args, options);

  return async (call) => {
    if (call.namespace !== MEMORY_ANSWER_DYNAMIC_TOOL_NAMESPACE) {
      return dynamicToolResult(
        {
          error: `Unsupported dynamic tool namespace: ${call.namespace ?? "(none)"}`
        },
        false
      );
    }
    const args = recordFromUnknown(call.arguments);
    if (call.tool === "scan") {
      if (!state.evaluation.followUpSearch) {
        return dynamicToolResult({
          kind: "evaluation_ablation",
          operation: "scan",
          message: "Follow-up retrieval is disabled for this evaluation arm."
        });
      }
      const existingScan = state.retrievals.find((retrieval) =>
        Array.isArray(recordFromUnknown(retrieval).stages)
      );
      if (existingScan && !state.servedCachedScan) {
        state.servedCachedScan = true;
        return dynamicToolResult({
          kind: "scan_result",
          query: (stringArg(args, "query") ?? state.query).slice(0, 512),
          retrieval: existingScan,
          cachedFromFirstPass: true,
          state: toolStateSummary(state, options.config)
        });
      }
      if (state.ledger.searchAttempts >= options.config.maxSearches) {
        const message = "Search budget exhausted.";
        markBudgetExhausted(state.ledger, "searches");
        state.errors.push(message);
        return dynamicToolResult({ kind: "validation_error", message }, false);
      }
      const searchQuery = (stringArg(args, "query") ?? state.query).slice(
        0,
        512
      );
      const { searchDomain, sessionId, projectId } = normalizeDomain(args);
      const started = Date.now();
      state.ledger.searchAttempts += 1;
      try {
        const scanResult = await withinRequestDeadline(state, () =>
          options.client.search({
            query: searchQuery,
            retrieval_scope: options.retrievalScope,
            search_domain: searchDomain,
            session_id: sessionId,
            project_id: projectId,
            team_workspace_id: options.teamWorkspaceId,
            recent_days: options.recentDays,
            source_after: options.sourceAfter,
            source_before: options.sourceBefore,
            exact_hints: candidateExactHints(
              state.retrievalHints,
              state.evaluation.exactAnchorChecks
            ),
            retrieval_stage: "score_scan",
            limit: 1
          })
        );
        state.retrievals.push(
          sanitizeRetrievalDiagnostic(scanResult.retrieval ?? scanResult)
        );
        const retrievalFailure = semanticRetrievalFailure(scanResult);
        if (retrievalFailure) {
          state.errors.push(`Scan incomplete: ${retrievalFailure}`);
        }
        state.searches.push({
          query: searchQuery,
          retrievalScope: options.retrievalScope,
          searchDomain,
          retrievalStage: "score_scan",
          sessionId,
          projectId,
          teamWorkspaceId: options.teamWorkspaceId,
          recentDays: options.recentDays,
          sourceAfter: options.sourceAfter,
          sourceBefore: options.sourceBefore,
          limit: 1,
          hitCount: 0,
          phase: "worker",
          durationMs: Date.now() - started
        });
        return dynamicToolResult({
          kind: "scan_result",
          query: searchQuery,
          retrieval: scanResult.retrieval ?? scanResult,
          state: toolStateSummary(state, options.config)
        });
      } catch (error) {
        markBudgetExhaustionFromError(state.ledger, error);
        const message = `Scan failed: ${error instanceof Error ? error.message : String(error)}`;
        state.errors.push(message);
        state.searches.push({
          query: searchQuery,
          retrievalScope: options.retrievalScope,
          searchDomain,
          retrievalStage: "score_scan",
          sessionId,
          projectId,
          teamWorkspaceId: options.teamWorkspaceId,
          recentDays: options.recentDays,
          sourceAfter: options.sourceAfter,
          sourceBefore: options.sourceBefore,
          limit: 1,
          hitCount: 0,
          phase: "worker",
          durationMs: Date.now() - started,
          errorClass: error instanceof Error ? error.name : "Error"
        });
        return dynamicToolResult(
          { kind: "scan_error", query: searchQuery, message },
          false
        );
      }
    }

    if (call.tool === "search") {
      if (!state.evaluation.followUpSearch) {
        return dynamicToolResult({
          kind: "evaluation_ablation",
          operation: "search",
          message: "Follow-up retrieval is disabled for this evaluation arm."
        });
      }
      if (state.ledger.searchAttempts >= options.config.maxSearches) {
        const message = "Search budget exhausted.";
        markBudgetExhausted(state.ledger, "searches");
        state.errors.push(message);
        return dynamicToolResult({ kind: "validation_error", message }, false);
      }
      const stage = stringArg(args, "stage");
      if (!stage) {
        const message = "Search requires a retrieval stage.";
        state.errors.push(message);
        return dynamicToolResult({ kind: "validation_error", message }, false);
      }
      const searchQuery = (stringArg(args, "query") ?? state.query).slice(
        0,
        512
      );
      const refinedExactHints = boundedStringArrayArg(
        args,
        "exact_hints",
        MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT
      );
      const { searchDomain, sessionId, projectId } = normalizeDomain(args);
      const limit = clampLimit(args.limit, options.limit);
      const started = Date.now();
      state.ledger.searchAttempts += 1;
      try {
        const searchResult = await withinRequestDeadline(state, () =>
          options.client.search({
            query: searchQuery,
            retrieval_scope: options.retrievalScope,
            search_domain: searchDomain,
            session_id: sessionId,
            project_id: projectId,
            team_workspace_id: options.teamWorkspaceId,
            recent_days: options.recentDays,
            source_after: options.sourceAfter,
            source_before: options.sourceBefore,
            exact_hints: state.evaluation.exactAnchorChecks
              ? (refinedExactHints ??
                candidateExactHints(state.retrievalHints, true))
              : undefined,
            retrieval_stage: stage,
            parent_node_ids: stringArrayArg(args, "parent_node_ids"),
            strict_limit: true,
            limit
          })
        );
        const hits = hitsFromSearch(searchResult);
        const bounded = boundEvidence(
          combineMemoryAnswerCandidateLists(
            state.evidence,
            [{ query: searchQuery, stage, hits }],
            state.evaluation.fusion
          ),
          options.config
        );
        recordEvidenceBudgetExhaustions(state.ledger, bounded);
        state.evidence = bounded.evidence;
        state.ledger.evidenceTokenEstimate = bounded.tokenEstimate;
        state.citations = appendEvidence(
          state.citations,
          citationsFromHits(hits)
        );
        state.retrievals.push(
          sanitizeRetrievalDiagnostic(searchResult.retrieval ?? searchResult)
        );
        const retrievalFailure = semanticRetrievalFailure(searchResult);
        if (retrievalFailure) {
          state.errors.push(`Search ${stage} incomplete: ${retrievalFailure}`);
        }
        state.searches.push({
          query: searchQuery,
          retrievalScope: options.retrievalScope,
          searchDomain,
          retrievalStage: stage,
          sessionId,
          projectId,
          teamWorkspaceId: options.teamWorkspaceId,
          recentDays: options.recentDays,
          sourceAfter: options.sourceAfter,
          sourceBefore: options.sourceBefore,
          limit,
          hitCount: hits.length,
          phase: "worker",
          durationMs: Date.now() - started
        });
        return dynamicToolResult({
          kind: "search_result",
          query: searchQuery,
          stage,
          hits: indexedEvidenceObservation(state.evidence, hits),
          retrieval: boundedUnknown(searchResult.retrieval ?? searchResult),
          state: toolStateSummary(state, options.config)
        });
      } catch (error) {
        markBudgetExhaustionFromError(state.ledger, error);
        const message = `Search failed: ${error instanceof Error ? error.message : String(error)}`;
        state.errors.push(message);
        state.searches.push({
          query: searchQuery,
          retrievalScope: options.retrievalScope,
          searchDomain,
          retrievalStage: stage,
          sessionId,
          projectId,
          teamWorkspaceId: options.teamWorkspaceId,
          recentDays: options.recentDays,
          sourceAfter: options.sourceAfter,
          sourceBefore: options.sourceBefore,
          limit,
          hitCount: 0,
          phase: "worker",
          durationMs: Date.now() - started,
          errorClass: error instanceof Error ? error.name : "Error"
        });
        return dynamicToolResult(
          { kind: "search_error", query: searchQuery, stage, message },
          false
        );
      }
    }

    if (call.tool === "expand") {
      if (!state.evaluation.lcmExpansion) {
        return dynamicToolResult({
          kind: "evaluation_ablation",
          operation: "expand",
          message: "LCM expansion is disabled for this evaluation arm."
        });
      }
      if (state.ledger.expansionAttempts >= options.config.maxExpansions) {
        const message = "Expand budget exhausted.";
        markBudgetExhausted(state.ledger, "expansions");
        state.errors.push(message);
        return dynamicToolResult({ kind: "validation_error", message }, false);
      }
      const nodeId = stringArg(args, "nodeId") ?? stringArg(args, "node_id");
      if (!nodeId) {
        const message = "Expand requires nodeId.";
        state.errors.push(message);
        return dynamicToolResult({ kind: "validation_error", message }, false);
      }
      const { searchDomain, sessionId, projectId } = normalizeDomain(args);
      const started = Date.now();
      state.ledger.expansionAttempts += 1;
      try {
        const expanded = await withinRequestDeadline(state, () =>
          options.client.expand(nodeId, {
            searchDomain,
            sessionId,
            projectId,
            teamWorkspaceId: options.teamWorkspaceId,
            recentDays: options.recentDays,
            sourceAfter: options.sourceAfter,
            sourceBefore: options.sourceBefore
          })
        );
        const expandedEvidence = evidenceFromExpansion(expanded);
        const bounded = boundEvidence(
          appendEvidence(state.evidence, expandedEvidence),
          options.config
        );
        recordEvidenceBudgetExhaustions(state.ledger, bounded);
        state.evidence = bounded.evidence;
        state.ledger.evidenceTokenEstimate = bounded.tokenEstimate;
        state.citations = appendEvidence(
          state.citations,
          citationsFromHits(expandedEvidence)
        );
        const admittedExpandedEvidence = expandedEvidence.filter((item) =>
          state.evidence.some(
            (candidate) => sourceKey(candidate) === sourceKey(item)
          )
        );
        const expansionRecord: ToolExpansionRecord = {
          nodeId,
          phase: "worker",
          durationMs: Date.now() - started,
          sourceItemCount: admittedExpandedEvidence.length
        };
        state.expansionRecords.push(expansionRecord);
        state.expansions.push(expansionRecord);
        return dynamicToolResult({
          kind: "expand_result",
          nodeId,
          expandedEvidence: indexedEvidenceObservation(
            state.evidence,
            admittedExpandedEvidence
          ),
          state: toolStateSummary(state, options.config)
        });
      } catch (error) {
        markBudgetExhaustionFromError(state.ledger, error);
        const message = `Expand failed: ${error instanceof Error ? error.message : String(error)}`;
        state.errors.push(message);
        state.expansionRecords.push({
          nodeId,
          phase: "worker",
          durationMs: Date.now() - started,
          sourceItemCount: 0,
          errorClass: error instanceof Error ? error.name : "Error"
        });
        return dynamicToolResult(
          { kind: "expand_error", nodeId, message },
          false
        );
      }
    }

    return dynamicToolResult(
      { error: `Unsupported dynamic tool: ${call.tool}` },
      false
    );
  };
};

const buildDynamicMemoryAnswerPrompt = (
  state: MemoryAnswerToolState,
  config: MemoryAnswerWorkerConfig,
  promptTemplate: LoadedPrompt,
  promptTokenLimit: number
): {
  prompt: string;
  promptTokens: ReturnType<typeof countTokensForModel>;
} => {
  const requiredJsonSchema = JSON.stringify(
    {
      schema_version: MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
      memory_status: "found | not_found | insufficient | pending_summary",
      relevant_memory_found:
        "true only when at least one inspected memory candidate is genuinely relevant",
      answer_markdown: "Concise markdown answer for the main agent.",
      relevance_explanation:
        "Short explanation of why selected evidence is relevant, including recency/conflict reasoning when evidence differs over time, or why no relevant memory was found.",
      evidence: [
        {
          evidence_index: 0,
          source_type: "memory_event",
          source_id: "exact source id",
          source_chunk_index: 0,
          node_id: "optional node id",
          visibility: "personal",
          relevance:
            "why this evidence supports the answer, including timing if relevant",
          support: "short quote or paraphrase from evidence"
        }
      ],
      missing: ["what is missing when status is insufficient or not_found"],
      missing_evidence: ["what would be needed if insufficient"]
    },
    null,
    2
  );

  const optionalDefaults = [
    state.projectId ? `Default project_id: ${state.projectId}` : "",
    state.sessionId ? `Default session_id: ${state.sessionId}` : "",
    state.recentDays ? `Default recent_days: ${state.recentDays}` : "",
    state.sourceAfter ? `Default source_after: ${state.sourceAfter}` : "",
    state.sourceBefore ? `Default source_before: ${state.sourceBefore}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const render = (): string => {
    const firstPassContext = boundedUnknown(
      {
        evidence: state.evidence,
        citations: state.citations,
        retrievals: state.retrievals,
        retrievalHints: state.retrievalHints,
        evaluationController: isDefaultMemoryAnswerEvaluation(state.evaluation)
          ? undefined
          : state.evaluation,
        orderedErrors: state.errors.slice(0, 20),
        searchHistory: state.searches,
        retrievalCoverage: {
          scanPositiveStages: [...availableCandidateStages(state.retrievals)],
          inspectedStages: [...inspectedSearchStages(state.searches)],
          uninspectedScanPositiveStages: uninspectedAvailableCandidateStages(
            state.retrievals,
            state.searches
          )
        },
        consumedBudgets: {
          searches: state.ledger.searchAttempts,
          expansions: state.ledger.expansionAttempts,
          candidates: state.evidence.length,
          evidenceTokens: state.ledger.evidenceTokenEstimate
        },
        remainingBudgets: {
          searches: Math.max(
            0,
            config.maxSearches - state.ledger.searchAttempts
          ),
          expansions: Math.max(
            0,
            config.maxExpansions - state.ledger.expansionAttempts
          )
        }
      },
      {
        maxStringLength: 2_048,
        maxArrayLength: Math.max(10, config.maxCandidates)
      }
    );
    const initialEvidenceSection = [
      state.evidence.length > 0
        ? "Initial evidence and first-pass diagnostics JSON:"
        : state.evaluation.scriptedFirstPass
          ? "The scripted first pass found no initial evidence. Retrieval errors and diagnostics still follow; use follow-up semantic searches only when budget remains."
          : "No scripted first pass ran. Start without scripted evidence and use only the enabled worker retrieval tools within the shared budget.",
      JSON.stringify(firstPassContext, null, 2)
    ].join("\n");
    return renderLoadedPrompt(promptTemplate, {
      search_domain: state.searchDomain,
      first_pass_guidance: state.evaluation.scriptedFirstPass
        ? "The scripted first pass already consumed part of the shared search budget. Use remaining searches only to fill a concrete evidence gap."
        : "No scripted first pass ran. Begin with no scripted evidence and account for every retrieval call against the shared search budget.",
      required_json_schema: requiredJsonSchema,
      question: state.query,
      retrieval_scope: state.retrievalScope,
      default_search_domain: state.searchDomain,
      optional_defaults: optionalDefaults,
      limit: state.limit,
      max_searches: config.maxSearches,
      max_expansions: config.maxExpansions,
      initial_evidence_section: initialEvidenceSection
    }).text;
  };

  let prompt = render();
  let promptTokenEstimate = countTokensForModel(prompt, {
    model: config.model
  });
  while (
    promptTokenEstimate.tokens > promptTokenLimit &&
    state.evidence.length > 0
  ) {
    markBudgetExhausted(state.ledger, "prompt_tokens");
    state.evidence.pop();
    const bounded = boundEvidence(state.evidence, config);
    state.evidence = bounded.evidence;
    state.ledger.evidenceTokenEstimate = bounded.tokenEstimate;
    prompt = render();
    promptTokenEstimate = countTokensForModel(prompt, { model: config.model });
  }
  if (promptTokenEstimate.tokens > promptTokenLimit) {
    throw new Error(
      `Memory answer prompt-token budget exhausted (${promptTokenEstimate.tokens} > ${promptTokenLimit} remaining)`
    );
  }
  return { prompt, promptTokens: promptTokenEstimate };
};

const runCodexWithRetries = async (
  config: MemoryAnswerWorkerConfig,
  runner: (timeoutMs: number) => Promise<MemoryAnswerAttemptRun>,
  validate: (run: MemoryAnswerAttemptRun) => ValidatedMemoryAnswerRun,
  attempts: MemoryAnswerAppServerExecution[],
  answerJobId?: string,
  canStartAttempt: () => boolean = () => true
): Promise<{
  run: MemoryAnswerAttemptRun;
  validated: ValidatedMemoryAnswerRun;
}> => {
  let lastErrorMessage: string | undefined;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    if (attempt > 1 && !canStartAttempt()) {
      break;
    }
    let run: MemoryAnswerAttemptRun | undefined;
    try {
      run = await runner(config.timeoutMs);
      const result = run.result;
      if (result.text.trim().length === 0) {
        throw new Error("Codex memory answer produced empty output");
      }
      const validated = validate(run);
      attempts.push({
        answerJobId,
        attemptIndex: attempt,
        status: "succeeded",
        model: result.model,
        tokenUsage: result.tokenUsage,
        primaryThreadId: result.primaryThreadId ?? result.threadId,
        threadId: result.threadId,
        turnId: result.turnId,
        rawEvents: result.rawEvents,
        processMetrics: result.processMetrics
      });
      return { run, validated };
    } catch (error) {
      lastErrorMessage = errorMessage(error);
      if (run) {
        attempts.push({
          answerJobId,
          attemptIndex: attempt,
          status: "failed",
          errorMessage: errorMessage(error),
          model: run.result.model,
          tokenUsage: run.result.tokenUsage,
          primaryThreadId: run.result.primaryThreadId ?? run.result.threadId,
          threadId: run.result.threadId,
          turnId: run.result.turnId,
          rawEvents: run.result.rawEvents,
          processMetrics: run.result.processMetrics
        });
      } else if (error instanceof CodexAppServerTurnError) {
        attempts.push({
          answerJobId,
          attemptIndex: attempt,
          status: "failed",
          errorMessage: error.message,
          model: error.model,
          tokenUsage: error.tokenUsage,
          primaryThreadId: error.threadId,
          threadId: error.threadId,
          turnId: error.turnId,
          rawEvents: error.rawEvents,
          processMetrics: error.processMetrics
        });
      } else {
        const processMetrics =
          error &&
          typeof error === "object" &&
          "codexAppServerProcessMetrics" in error
            ? (
                error as {
                  codexAppServerProcessMetrics?: CodexAppServerProcessMetrics;
                }
              ).codexAppServerProcessMetrics
            : undefined;
        attempts.push({
          answerJobId,
          attemptIndex: attempt,
          status: "failed",
          errorMessage: errorMessage(error),
          model: config.model,
          processMetrics
        });
      }
      // Retry with a longer timeout, then let the caller preserve fallback evidence.
    }
  }

  const message = lastErrorMessage
    ? `Codex memory answer failed after retry attempts: ${lastErrorMessage}`
    : "Codex memory answer failed after retry attempts";
  throw Object.assign(new Error(message), {
    appServerExecutions: attempts
  });
};

const appServerExecutionsFromError = (
  error: unknown
): MemoryAnswerAppServerExecution[] | undefined => {
  if (
    error &&
    typeof error === "object" &&
    "appServerExecutions" in error &&
    Array.isArray(
      (error as { appServerExecutions?: unknown }).appServerExecutions
    )
  ) {
    return (error as { appServerExecutions: MemoryAnswerAppServerExecution[] })
      .appServerExecutions;
  }
  return undefined;
};

const failureStateFromError = (
  error: unknown
): MemoryAnswerToolState | undefined => {
  if (
    error &&
    typeof error === "object" &&
    "memoryAnswerFailureState" in error
  ) {
    return (error as { memoryAnswerFailureState?: MemoryAnswerToolState })
      .memoryAnswerFailureState;
  }
  return undefined;
};

const promptTokensFromError = (
  error: unknown
): ReturnType<typeof countTokensForModel> | undefined => {
  if (error && typeof error === "object" && "promptTokens" in error) {
    return (error as { promptTokens?: ReturnType<typeof countTokensForModel> })
      .promptTokens;
  }
  return undefined;
};

const traceErrorClass = (message: string | undefined): string | undefined => {
  if (!message) return undefined;
  if (/time.?out|wall-time budget/i.test(message)) return "TimeoutError";
  if (/budget/i.test(message)) return "BudgetExhaustedError";
  if (
    /zod|schema|json|validation|resolvable supporting evidence/i.test(message)
  )
    return "ValidationError";
  return "CodexAppServerError";
};

const evidenceIdentity = (item: unknown): Record<string, unknown> => {
  const record = sanitizeTeamIdentityMetadata(
    recordFromUnknown(item)
  ) as Record<string, unknown>;
  return {
    sourceType: stringField(record, ["sourceType", "source_type"]),
    sourceId: stringField(record, ["sourceId", "source_id"]),
    sourceChunkIndex:
      record.sourceChunkIndex ??
      record.source_chunk_index ??
      record.chunkIndex ??
      record.chunk_index,
    nodeId: stringField(record, ["nodeId", "node_id"]),
    expandedFromNodeId: stringField(record, [
      "expandedFromNodeId",
      "expanded_from_node_id"
    ]),
    sourcePosition: record.sourcePosition ?? record.source_position,
    retrievalStage: stringField(record, ["retrievalStage", "retrieval_stage"]),
    visibility: stringField(record, ["visibility"]),
    provenanceId: stringField(record, [
      "provenanceId",
      "provenance_id",
      "sourceProvenanceId",
      "source_provenance_id"
    ]),
    corroborationGroupId: stringField(record, [
      "corroborationGroupId",
      "corroboration_group_id"
    ]),
    ...candidateLineage(record)
  };
};

const MAX_MEMORY_ANSWER_TRACE_BYTES = 32_768;

export const boundMemoryAnswerTrace = (
  value: Record<string, unknown>
): Record<string, unknown> => {
  const bounded = boundedUnknown(sanitizeTeamIdentityMetadata(value), {
    maxStringLength: 256,
    maxArrayLength: 50
  });
  const trace = recordFromUnknown(bounded);
  const byteLength = () => Buffer.byteLength(JSON.stringify(trace), "utf8");
  const popArray = (record: Record<string, unknown>, key: string): boolean => {
    const array = record[key];
    if (!Array.isArray(array) || array.length === 0) return false;
    array.pop();
    return true;
  };
  const shrinkTargets: Array<[Record<string, unknown>, string]> = [
    [trace, "candidateIdentities"],
    [trace, "selectedIdentities"],
    [trace, "orderedErrors"],
    [trace, "attempts"]
  ];
  while (byteLength() > MAX_MEMORY_ANSWER_TRACE_BYTES) {
    const target = shrinkTargets.find(([record, key]) => {
      const array = record[key];
      return Array.isArray(array) && array.length > 0;
    });
    if (!target || !popArray(...target)) break;
  }
  if (byteLength() > MAX_MEMORY_ANSWER_TRACE_BYTES) {
    trace.retrievalHints = { truncated: true };
  }
  if (byteLength() > MAX_MEMORY_ANSWER_TRACE_BYTES) {
    trace.effectiveBoundary = { truncated: true };
  }
  if (byteLength() <= MAX_MEMORY_ANSWER_TRACE_BYTES) return trace;

  const minimal = {
    version: trace.version,
    truncated: true,
    budgets: boundedUnknown(trace.budgets, {
      maxStringLength: 64,
      maxArrayLength: 16
    }),
    modelMetadata: boundedUnknown(trace.modelMetadata, {
      maxStringLength: 128,
      maxArrayLength: 8
    })
  };
  return Buffer.byteLength(JSON.stringify(minimal), "utf8") <=
    MAX_MEMORY_ANSWER_TRACE_BYTES
    ? minimal
    : { version: 2, truncated: true };
};

const memoryAnswerTrace = (options: {
  config: MemoryAnswerWorkerConfig;
  state: MemoryAnswerToolState;
  retrievalHints?: MemoryAnswerRetrievalHints;
  selectedEvidence?: unknown[];
  attempts: MemoryAnswerAppServerExecution[];
  model?: string | null;
  promptTokens?: ReturnType<typeof countTokensForModel>;
  boundary: Record<string, unknown>;
}): Record<string, unknown> => {
  const trace: Record<string, unknown> = {
    version: 2,
    ...(!isDefaultMemoryAnswerEvaluation(options.state.evaluation)
      ? { evaluationController: options.state.evaluation }
      : {}),
    retrievalHints: options.retrievalHints,
    effectiveBoundary: boundedUnknown(options.boundary, {
      maxStringLength: 512,
      maxArrayLength: 20
    }),
    orderedErrors: [
      ...options.state.searches.flatMap((search, index) =>
        search.errorClass
          ? [
              {
                order: index,
                phase: search.phase,
                operation: "search",
                stage: search.retrievalStage,
                errorClass: search.errorClass
              }
            ]
          : []
      ),
      ...options.state.expansionRecords.flatMap((expansion, index) =>
        expansion.errorClass
          ? [
              {
                order: options.state.searches.length + index,
                phase: expansion.phase,
                operation: "expand",
                errorClass: expansion.errorClass,
                nodeId: expansion.nodeId.slice(0, 256)
              }
            ]
          : []
      )
    ].slice(0, 50),
    attempts: options.attempts
      .slice(0, options.config.maxAttempts)
      .map((attempt) => ({
        attemptIndex: attempt.attemptIndex,
        status: attempt.status,
        errorClass: traceErrorClass(attempt.errorMessage),
        model: attempt.model.slice(0, 128),
        tokenUsage: boundedUnknown(attempt.tokenUsage, {
          maxStringLength: 64,
          maxArrayLength: 10
        })
      })),
    selectedIdentities: (options.selectedEvidence ?? [])
      .slice(0, options.config.maxCandidates)
      .map(evidenceIdentity),
    candidateIdentities: options.state.evidence
      .slice(0, options.config.maxCandidates)
      .map(evidenceIdentity),
    budgets: {
      configured: {
        wallTimeMs: options.config.timeoutMs,
        searches: options.config.maxSearches,
        expansions: options.config.maxExpansions,
        candidates: options.config.maxCandidates,
        evidenceItems: options.config.maxEvidenceItems,
        evidenceTokens: options.config.maxEvidenceTokens,
        promptTokens: options.config.maxPromptTokens,
        attempts: options.config.maxAttempts
      },
      consumed: {
        wallTimeMs: Math.min(
          options.config.timeoutMs,
          Math.max(0, Date.now() - options.state.ledger.startedAt)
        ),
        searches: options.state.ledger.searchAttempts,
        expansions: options.state.ledger.expansionAttempts,
        candidates: options.state.evidence.length,
        evidenceItems: options.state.evidence.length,
        evidenceTokens: options.state.ledger.evidenceTokenEstimate,
        promptTokens: options.state.ledger.promptTokenEstimateConsumed,
        attempts: options.state.ledger.workerAttempts
      },
      remaining: {
        wallTimeMs: remainingRequestTime(options.state),
        searches: Math.max(
          0,
          options.config.maxSearches - options.state.ledger.searchAttempts
        ),
        expansions: Math.max(
          0,
          options.config.maxExpansions - options.state.ledger.expansionAttempts
        ),
        candidates: Math.max(
          0,
          options.config.maxCandidates - options.state.evidence.length
        ),
        evidenceItems: Math.max(
          0,
          options.config.maxEvidenceItems - options.state.evidence.length
        ),
        evidenceTokens: Math.max(
          0,
          options.config.maxEvidenceTokens -
            options.state.ledger.evidenceTokenEstimate
        ),
        promptTokens: Math.max(
          0,
          options.config.maxPromptTokens -
            options.state.ledger.promptTokenEstimateConsumed
        ),
        attempts: Math.max(
          0,
          options.config.maxAttempts - options.state.ledger.workerAttempts
        )
      },
      exhausted: options.state.ledger.budgetExhaustions.slice(0, 16)
    },
    modelMetadata: {
      provider: options.config.provider,
      configuredModel: options.config.model.slice(0, 128),
      responseModel: options.model?.slice(0, 128),
      reasoningEffort: options.config.reasoningEffort.slice(0, 64),
      promptTokenEstimate: options.promptTokens?.tokens,
      tokenizerEncoding: options.promptTokens?.encoding,
      tokenizerModelMatched: options.promptTokens?.exactModelMatch
    }
  };
  return boundMemoryAnswerTrace(trace);
};

const primaryThreadIdFromExecutions = (
  executions: MemoryAnswerAppServerExecution[]
): string | undefined =>
  executions.find((execution) => execution.primaryThreadId)?.primaryThreadId ??
  executions.find((execution) => execution.threadId)?.threadId;

const normalizeExecutionPrimaryThreadIds = (
  executions: MemoryAnswerAppServerExecution[]
): string | undefined => {
  const primaryThreadId = primaryThreadIdFromExecutions(executions);
  if (!primaryThreadId) {
    return undefined;
  }
  for (const execution of executions) {
    execution.primaryThreadId ??= primaryThreadId;
  }
  return primaryThreadId;
};

export const normalizeMemoryAnswerRetrievalHints = (
  hints?: MemoryAnswerRetrievalHints
): MemoryAnswerRetrievalHints | undefined => {
  if (!hints) {
    return undefined;
  }
  const strings = (values: string[] | undefined, max: number) =>
    [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
      .slice(0, max)
      .map((value) => value.slice(0, MEMORY_RETRIEVAL_HINT_MAX_LENGTH));
  const normalized: MemoryAnswerRetrievalHints = {
    lexical: strings(hints.lexical, MEMORY_RETRIEVAL_HINT_MAX_COUNT),
    exact: strings(hints.exact, MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT),
    semantic: strings(hints.semantic, MEMORY_RETRIEVAL_SEMANTIC_HINT_MAX_COUNT),
    entities: strings(hints.entities, MEMORY_RETRIEVAL_HINT_MAX_COUNT),
    temporalIntent: hints.temporalIntent
      ?.trim()
      .slice(0, MEMORY_RETRIEVAL_HINT_MAX_LENGTH)
  };
  return Object.values(normalized).some((value) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value)
  )
    ? normalized
    : undefined;
};

type FirstPassQueryClass =
  | "caller_question"
  | "semantic_reformulation"
  | "lexical_exact_seed"
  | "entity_temporal_seed";

interface FirstPassQuery {
  query: string;
  hintClass: FirstPassQueryClass;
}

const firstPassQueries = (
  question: string,
  hints?: MemoryAnswerRetrievalHints
): FirstPassQuery[] => {
  const queues: FirstPassQuery[][] = [
    [{ query: question, hintClass: "caller_question" }],
    (hints?.semantic ?? []).map((query) => ({
      query,
      hintClass: "semantic_reformulation"
    })),
    [...(hints?.exact ?? []), ...(hints?.lexical ?? [])].map((query) => ({
      query,
      hintClass: "lexical_exact_seed"
    })),
    [
      ...(hints?.entities ?? []),
      ...(hints?.temporalIntent ? [hints.temporalIntent] : [])
    ].map((query) => ({ query, hintClass: "entity_temporal_seed" }))
  ];
  const scheduled: FirstPassQuery[] = [];
  const seen = new Set<string>();
  for (
    let round = 0;
    queues.some((queue) => round < queue.length);
    round += 1
  ) {
    for (const queue of queues) {
      const candidate = queue[round];
      const query = candidate?.query.trim();
      if (!candidate || !query || seen.has(query)) continue;
      seen.add(query);
      scheduled.push({ ...candidate, query });
    }
  }
  return scheduled;
};

const candidateExactHints = (
  hints: MemoryAnswerRetrievalHints | undefined,
  enabled: boolean
): string[] | undefined => {
  if (!enabled) return undefined;
  const combined = [...(hints?.exact ?? []), ...(hints?.lexical ?? [])]
    .filter((hint, index, values) => values.indexOf(hint) === index)
    .slice(0, MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT);
  return combined.length > 0 ? combined : undefined;
};

const retrievalDiagnosticFromSearchResult = (
  value: unknown
): Record<string, unknown> => {
  const record = recordFromUnknown(value);
  const direct = recordFromUnknown(record.retrieval);
  if (Object.keys(direct).length > 0) return direct;
  const bundled = recordFromUnknown(
    recordFromUnknown(record.evidenceBundle).retrieval
  );
  return Object.keys(bundled).length > 0 ? bundled : record;
};

const semanticRetrievalFailure = (value: unknown): string | undefined => {
  const retrieval = retrievalDiagnosticFromSearchResult(value);
  if (
    retrieval.semanticRetrievalComplete === false ||
    retrieval.semantic_retrieval_complete === false ||
    retrieval.retrievalMode === "embedding_unavailable" ||
    retrieval.retrieval_mode === "embedding_unavailable"
  ) {
    return (
      stringField(retrieval, [
        "semanticRetrievalError",
        "semantic_retrieval_error",
        "embeddingError",
        "embedding_error"
      ]) ?? "semantic retrieval was unavailable"
    );
  }
  return undefined;
};

export const runScriptedMemoryAnswerFirstPass = async (options: {
  client: MemoryAnswerRetrievalClient;
  query: string;
  retrievalHints?: MemoryAnswerRetrievalHints;
  retrievalScope: string;
  searchDomain: string;
  sessionId?: string;
  projectId?: string;
  teamWorkspaceId?: string;
  recentDays?: number;
  sourceAfter?: string;
  sourceBefore?: string;
  limit: number;
  maxSearches: number;
  deadlineAt?: number;
  exactAnchorChecks?: boolean;
  fusion?: boolean;
}): Promise<{
  evidence: unknown[];
  citations: unknown[];
  retrievals: unknown[];
  searches: ToolSearchRecord[];
  errors: string[];
  skippedQueries: Array<{
    query: string;
    hintClass: FirstPassQueryClass;
    reason: "search_budget";
  }>;
}> => {
  const common = {
    retrieval_scope: options.retrievalScope,
    search_domain: options.searchDomain,
    session_id: options.sessionId,
    project_id: options.projectId,
    team_workspace_id: options.teamWorkspaceId,
    recent_days: options.recentDays,
    source_after: options.sourceAfter,
    source_before: options.sourceBefore,
    exact_hints: candidateExactHints(
      options.retrievalHints,
      options.exactAnchorChecks !== false
    )
  };
  const beforeDeadline = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (!options.deadlineAt) return operation();
    const remaining = options.deadlineAt - Date.now();
    if (remaining <= 0)
      throw new Error("Memory answer wall-time budget exhausted");
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Memory answer wall-time budget exhausted")),
            remaining
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const queries = firstPassQueries(options.query, options.retrievalHints);
  const followUpReserve = options.maxSearches > 1 ? 1 : 0;
  const firstPassCallBudget = Math.max(
    1,
    options.maxSearches - followUpReserve
  );
  // Scans are allocated in deterministic rounds across hint classes. With the
  // default five-call first-pass budget this admits caller, semantic, and
  // lexical/exact-seeded queries while retaining two calls for routed search.
  const scanCount = Math.min(
    queries.length,
    Math.max(1, Math.ceil(firstPassCallBudget / 2))
  );
  const scanQueries = queries.slice(0, scanCount);
  const skippedQueries = queries.slice(scanCount).map((candidate) => ({
    ...candidate,
    reason: "search_budget" as const
  }));
  const scans = await Promise.all(
    scanQueries.map(async ({ query }) => {
      const started = Date.now();
      try {
        const result = await beforeDeadline(() =>
          options.client.search({
            query,
            ...common,
            retrieval_stage: "score_scan",
            limit: options.limit
          })
        );
        const hits = hitsFromSearch(result);
        const retrievalFailure = semanticRetrievalFailure(result);
        return {
          query,
          hits,
          retrieval: retrievalDiagnosticFromSearchResult(result),
          record: {
            query,
            retrievalScope: options.retrievalScope,
            searchDomain: options.searchDomain,
            retrievalStage: "score_scan",
            sessionId: options.sessionId,
            projectId: options.projectId,
            teamWorkspaceId: options.teamWorkspaceId,
            recentDays: options.recentDays,
            sourceAfter: options.sourceAfter,
            sourceBefore: options.sourceBefore,
            limit: options.limit,
            hitCount: hits.length,
            phase: "first_pass" as const,
            durationMs: Date.now() - started
          },
          error: retrievalFailure
            ? `First-pass semantic retrieval incomplete for query: ${retrievalFailure}`
            : undefined
        };
      } catch (error) {
        return {
          query,
          hits: [],
          retrieval: undefined,
          record: {
            query,
            retrievalScope: options.retrievalScope,
            searchDomain: options.searchDomain,
            retrievalStage: "score_scan",
            sessionId: options.sessionId,
            projectId: options.projectId,
            teamWorkspaceId: options.teamWorkspaceId,
            recentDays: options.recentDays,
            sourceAfter: options.sourceAfter,
            sourceBefore: options.sourceBefore,
            limit: 1,
            hitCount: 0,
            phase: "first_pass" as const,
            durationMs: Date.now() - started,
            errorClass: error instanceof Error ? error.name : "Error"
          },
          error: `First-pass scan failed for query: ${errorMessage(error)}`
        };
      }
    })
  );
  const routes = scans.map((scan) => ({
    query: scan.query,
    available: Array.isArray(recordFromUnknown(scan.retrieval).stages)
      ? (recordFromUnknown(scan.retrieval).stages as unknown[])
          .map(recordFromUnknown)
          .filter(
            (stage) =>
              typeof stage.name === "string" &&
              semanticSearchStages.has(stage.name) &&
              Number(stage.countAboveThreshold ?? 0) > 0
          )
      : []
  }));
  const searchBudget = Math.max(0, firstPassCallBudget - scans.length);
  const routedTasks = [
    ...routes.flatMap((route) =>
      route.available.slice(0, 1).map((detail) => ({
        stage: String(detail.name),
        query: route.query,
        detail
      }))
    ),
    ...routes.flatMap((route) =>
      route.available.slice(1).map((detail) => ({
        stage: String(detail.name),
        query: route.query,
        detail
      }))
    )
  ];
  const scheduledStages = new Set<string>();
  const distinctStageTasks = routedTasks.filter((task) => {
    if (scheduledStages.has(task.stage)) return false;
    scheduledStages.add(task.stage);
    return true;
  });
  const repeatedStageTasks = routedTasks.filter(
    (task) =>
      distinctStageTasks.findIndex(
        (scheduled) =>
          scheduled.stage === task.stage && scheduled.query === task.query
      ) === -1
  );
  // Cover every distinct scan-positive retrieval stage before spending the
  // remaining first-pass budget on query variants for an already routed stage.
  const tasks = [...distinctStageTasks, ...repeatedStageTasks].slice(
    0,
    searchBudget
  );
  const results = await Promise.all(
    tasks.map(async (task) => {
      const started = Date.now();
      const maxAllowed = Number(task.detail.maxAllowed ?? options.limit);
      const count = Number(task.detail.countAboveThreshold ?? options.limit);
      const limit = Math.max(
        1,
        Math.min(options.limit, maxAllowed || options.limit, count || 1)
      );
      try {
        const result = await beforeDeadline(() =>
          options.client.search({
            query: task.query,
            ...common,
            retrieval_stage: task.stage,
            strict_limit: true,
            limit
          })
        );
        const hits = hitsFromSearch(result);
        const retrievalFailure = semanticRetrievalFailure(result);
        return {
          task,
          result,
          hits,
          record: {
            query: task.query,
            retrievalScope: options.retrievalScope,
            searchDomain: options.searchDomain,
            retrievalStage: task.stage,
            sessionId: options.sessionId,
            projectId: options.projectId,
            teamWorkspaceId: options.teamWorkspaceId,
            recentDays: options.recentDays,
            sourceAfter: options.sourceAfter,
            sourceBefore: options.sourceBefore,
            limit,
            hitCount: hits.length,
            phase: "first_pass" as const,
            durationMs: Date.now() - started
          },
          error: retrievalFailure
            ? `First-pass ${task.stage} incomplete: ${retrievalFailure}`
            : undefined
        };
      } catch (error) {
        return {
          task,
          result: undefined,
          hits: [],
          record: {
            query: task.query,
            retrievalScope: options.retrievalScope,
            searchDomain: options.searchDomain,
            retrievalStage: task.stage,
            sessionId: options.sessionId,
            projectId: options.projectId,
            teamWorkspaceId: options.teamWorkspaceId,
            recentDays: options.recentDays,
            sourceAfter: options.sourceAfter,
            sourceBefore: options.sourceBefore,
            limit,
            hitCount: 0,
            phase: "first_pass" as const,
            durationMs: Date.now() - started,
            errorClass: error instanceof Error ? error.name : "Error"
          },
          error: `First-pass ${task.stage} failed: ${errorMessage(error)}`
        };
      }
    })
  );
  const exactChecks =
    options.exactAnchorChecks === false
      ? []
      : [
          ...(options.retrievalHints?.exact ?? []),
          ...(options.retrievalHints?.lexical ?? [])
        ];
  const evidence = combineMemoryAnswerCandidateLists(
    [],
    [
      ...scans.map((scan) => ({
        query: scan.query,
        stage: "score_scan",
        hits: scan.hits
      })),
      ...results.map((result) => ({
        query: result.task.query,
        stage: result.task.stage,
        hits: result.hits
      }))
    ],
    options.fusion !== false
  ).map((candidate) => {
    const record = recordFromUnknown(candidate);
    const lexicalAnchors = record.lexicalAnchors ?? record.lexical_anchors;
    const searchable = [
      typeof record.summaryText === "string" ? record.summaryText : "",
      ...(Array.isArray(lexicalAnchors)
        ? lexicalAnchors.filter(
            (anchor): anchor is string => typeof anchor === "string"
          )
        : [])
    ].join("\n");
    const exactAnchorMatches = exactChecks.filter((hint) =>
      searchable.includes(hint)
    );
    return exactAnchorMatches.length > 0
      ? { ...record, exactAnchorMatches }
      : record;
  });
  return {
    evidence,
    citations: appendEvidence([], citationsFromHits(evidence)),
    retrievals: [
      ...scans.flatMap((scan) =>
        scan.retrieval ? [sanitizeRetrievalDiagnostic(scan.retrieval)] : []
      ),
      ...results.flatMap((result) =>
        result.result
          ? [
              sanitizeRetrievalDiagnostic(
                retrievalDiagnosticFromSearchResult(result.result)
              )
            ]
          : []
      )
    ],
    searches: [
      ...scans.map((scan) => scan.record),
      ...results.map((result) => result.record)
    ],
    errors: [
      ...scans.flatMap((scan) => (scan.error ? [scan.error] : [])),
      ...results.flatMap((result) => (result.error ? [result.error] : []))
    ],
    skippedQueries
  };
};

const runDynamicToolMemoryAnswer = async (
  payload: MemoryAnswerPayload,
  options: {
    jobId: string;
    config: MemoryAnswerWorkerConfig;
    client: MemoryAnswerRetrievalClient;
    retrievalScope: string;
    searchDomain: string;
    sessionId?: string;
    projectId?: string;
    teamWorkspaceId?: string;
    recentDays?: number;
    sourceAfter?: string;
    sourceBefore?: string;
    limit: number;
    retrievalHints?: MemoryAnswerRetrievalHints;
    evaluation: ResolvedMemoryAnswerEvaluationController;
    promptTemplate: LoadedPrompt;
    signal?: AbortSignal;
    captureProcessMetrics?: boolean;
  }
): Promise<{
  markdown: string;
  structuredAnswer: StructuredMemoryAnswer;
  model: string;
  promptTokens: ReturnType<typeof countTokensForModel>;
  searchCount: number;
  expandCount: number;
  memoryStatus: MemoryAnswerStatus;
  tokenUsage?: CodexThreadTokenUsage;
  threadId?: string;
  turnId?: string;
  rawEvents?: CodexAppServerRawEvent[];
  appServerExecutions: MemoryAnswerAppServerExecution[];
  evidence: unknown[];
  candidates: unknown[];
  citations: unknown[];
  searches: ToolSearchRecord[];
  retrievals: unknown[];
  expansions: unknown[];
  errors: string[];
  expansionRecords: ToolExpansionRecord[];
  budgetLedger: MemoryAnswerBudgetLedger;
}> => {
  const ledger: MemoryAnswerBudgetLedger = {
    startedAt: Date.now(),
    deadlineAt: Date.now() + options.config.timeoutMs,
    searchAttempts: 0,
    expansionAttempts: 0,
    workerAttempts: 0,
    evidenceTokenEstimate: 0,
    promptTokenEstimateConsumed: 0,
    budgetExhaustions: []
  };
  const firstPass = options.evaluation.scriptedFirstPass
    ? await runScriptedMemoryAnswerFirstPass({
        client: options.client,
        query: queryFromPayload(payload),
        retrievalHints: options.retrievalHints,
        retrievalScope: options.retrievalScope,
        searchDomain: options.searchDomain,
        sessionId: options.sessionId,
        projectId: options.projectId,
        teamWorkspaceId: options.teamWorkspaceId,
        recentDays: options.recentDays,
        sourceAfter: options.sourceAfter,
        sourceBefore: options.sourceBefore,
        limit: options.limit,
        maxSearches: options.config.maxSearches,
        deadlineAt: ledger.deadlineAt,
        exactAnchorChecks: options.evaluation.exactAnchorChecks,
        fusion: options.evaluation.fusion
      })
    : {
        evidence: [],
        citations: [],
        retrievals: [],
        searches: [],
        errors: [],
        skippedQueries: []
      };
  ledger.searchAttempts = firstPass.searches.length;
  const initialBoundedEvidence = boundEvidence(
    combineMemoryAnswerCandidateLists(
      evidenceItems(payload),
      [
        {
          query: queryFromPayload(payload),
          stage: "first_pass",
          hits: firstPass.evidence
        }
      ],
      options.evaluation.fusion
    ),
    options.config
  );
  ledger.evidenceTokenEstimate = initialBoundedEvidence.tokenEstimate;
  recordEvidenceBudgetExhaustions(ledger, initialBoundedEvidence);
  const state: MemoryAnswerToolState = {
    query: queryFromPayload(payload),
    retrievalScope: options.retrievalScope,
    searchDomain: options.searchDomain,
    sessionId: options.sessionId,
    projectId: options.projectId,
    teamWorkspaceId: options.teamWorkspaceId,
    recentDays: options.recentDays,
    sourceAfter: options.sourceAfter,
    sourceBefore: options.sourceBefore,
    limit: options.limit,
    evidence: initialBoundedEvidence.evidence,
    citations: appendEvidence(
      citationsFromPayload(payload),
      firstPass.citations
    ),
    retrievals: [
      sanitizeRetrievalDiagnostic(retrievalFromPayload(payload)),
      ...firstPass.retrievals
    ].filter(Boolean),
    searches: [...firstPass.searches],
    expansions: [],
    expansionRecords: [],
    errors: [
      ...firstPass.errors,
      ...(semanticRetrievalFailure(retrievalFromPayload(payload))
        ? [
            `Initial semantic retrieval incomplete: ${semanticRetrievalFailure(
              retrievalFromPayload(payload)
            )}`
          ]
        : [])
    ],
    retrievalHints: options.retrievalHints,
    servedCachedScan: false,
    ledger,
    evaluation: options.evaluation
  };
  let promptTokens = countTokensForModel("", { model: options.config.model });
  const appServerExecutions: MemoryAnswerAppServerExecution[] = [];

  const runner = async (): Promise<MemoryAnswerAttemptRun> => {
    if (options.signal?.aborted) {
      throw new Error("Memory answer request was cancelled");
    }
    const remaining = remainingRequestTime(state);
    if (remaining <= 0) {
      markBudgetExhausted(state.ledger, "wall_time");
      throw new Error("Memory answer wall-time budget exhausted");
    }
    if (state.ledger.workerAttempts >= options.config.maxAttempts) {
      markBudgetExhausted(state.ledger, "attempts");
      throw new Error("Memory answer attempt budget exhausted");
    }
    const remainingPromptTokens = Math.max(
      0,
      options.config.maxPromptTokens - state.ledger.promptTokenEstimateConsumed
    );
    if (remainingPromptTokens <= 0) {
      markBudgetExhausted(state.ledger, "prompt_tokens");
      throw new Error("Memory answer prompt-token budget exhausted");
    }
    state.servedCachedScan = false;
    let prompt: string;
    try {
      const built = buildDynamicMemoryAnswerPrompt(
        state,
        options.config,
        options.promptTemplate,
        remainingPromptTokens
      );
      prompt = built.prompt;
      promptTokens = built.promptTokens;
    } catch (error) {
      markBudgetExhausted(state.ledger, "prompt_tokens");
      throw error;
    }
    state.ledger.workerAttempts += 1;
    state.ledger.promptTokenEstimateConsumed += promptTokens.tokens;
    const session = new CodexAppServerThreadSession({
      appServerBinary: options.config.appServerBinary,
      model: options.config.model,
      reasoningEffort: options.config.reasoningEffort,
      cwd: options.config.cwd,
      env: options.config.env,
      clientName: "koed-memory-answer-worker",
      baseInstructions: koedMemoryAnswerAppServerBaseInstructions,
      developerInstructions: koedMemoryAnswerAppServerDeveloperInstructions,
      dynamicTools: dynamicToolSpecs(),
      dynamicToolHandler: createMemoryAnswerDynamicToolHandler(state, options),
      captureProcessMetrics: options.captureProcessMetrics
    });
    const abort = () => session.close();
    options.signal?.addEventListener("abort", abort, { once: true });
    let result: Awaited<ReturnType<typeof session.runTurn>> | undefined;
    let failure: unknown;
    try {
      result = await session.runTurn(prompt, remaining);
    } catch (error) {
      failure = error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await session.closeAndWait();
    }
    const processMetrics = session.processMetrics();
    if (failure instanceof CodexAppServerTurnError)
      throw new CodexAppServerTurnError(failure.message, {
        model: failure.model,
        tokenUsage: failure.tokenUsage,
        threadId: failure.threadId,
        turnId: failure.turnId,
        rawEvents: failure.rawEvents,
        processMetrics
      });
    if (failure)
      throw Object.assign(
        failure instanceof Error ? failure : new Error(errorMessage(failure)),
        { codexAppServerProcessMetrics: processMetrics }
      );
    return {
      result: { ...result!, processMetrics },
      state
    };
  };

  const validate = (run: MemoryAnswerAttemptRun): ValidatedMemoryAnswerRun => {
    const { result, state } = run;
    const structuredAnswer = parseStructuredMemoryAnswer(
      JSON.parse(stripJsonFence(result.text))
    );
    const markdown = structuredAnswer.answer_markdown.trim();
    if (markdown.length === 0) {
      throw new Error("Codex memory answer produced empty output");
    }
    const admissionBudgets = new Set<MemoryAnswerBudgetKind>([
      "candidates",
      "evidence_items",
      "evidence_tokens"
    ]);
    const operationalBudgetExhausted = state.ledger.budgetExhaustions.some(
      (kind) => !admissionBudgets.has(kind)
    );
    const admissionPreventedReliableAnswer =
      state.ledger.budgetExhaustions.some((kind) =>
        admissionBudgets.has(kind)
      ) &&
      (state.evidence.length === 0 ||
        structuredAnswer.memory_status === "not_found");
    if (
      (operationalBudgetExhausted || admissionPreventedReliableAnswer) &&
      structuredAnswer.memory_status !== "insufficient"
    ) {
      throw new Error(
        `Memory answer budget exhausted: ${state.ledger.budgetExhaustions.join(", ")}`
      );
    }
    if (
      state.searches.length === 0 &&
      evidenceItems(payload).length === 0 &&
      structuredAnswer.memory_status !== "pending_summary"
    ) {
      throw new Error(
        "Memory answer worker returned without using Koed RAG tools"
      );
    }
    const curatedEvidence = evidenceSelectedByAnswer(
      state.evidence,
      structuredAnswer
    ).slice(
      0,
      Math.min(
        state.limit,
        options.config.maxCandidates,
        options.config.maxEvidenceItems
      )
    );
    if (
      structuredAnswer.memory_status === "insufficient" &&
      curatedEvidence.length === 0 &&
      state.errors.length === 0 &&
      state.ledger.budgetExhaustions.length === 0
    ) {
      throw new Error(
        "Memory answer worker returned insufficient after complete retrieval without selected partial evidence; use not_found when no inspected candidate is relevant"
      );
    }
    if (
      structuredAnswer.memory_status === "not_found" &&
      state.errors.length > 0
    ) {
      throw new Error(
        "Memory answer worker returned not_found after retrieval failures; use insufficient when retrieval was incomplete"
      );
    }
    if (
      structuredAnswer.memory_status === "not_found" &&
      retrievalsHaveAvailableCandidates(state.retrievals) &&
      !hasInspectedEvidenceStage(state.searches)
    ) {
      throw new Error(
        "Memory answer worker returned not_found after scan candidates without inspecting evidence"
      );
    }
    const uninspectedCandidateStages = uninspectedAvailableCandidateStages(
      state.retrievals,
      state.searches
    );
    if (
      structuredAnswer.memory_status === "not_found" &&
      uninspectedCandidateStages.length > 0 &&
      hasInspectedEvidenceStage(state.searches)
    ) {
      throw new Error(
        `Memory answer worker returned not_found before inspecting scan-positive stages: ${uninspectedCandidateStages.join(", ")}`
      );
    }
    if (
      structuredAnswer.memory_status === "found" &&
      curatedEvidence.length === 0
    ) {
      throw new Error(
        "Memory answer worker returned found without resolvable supporting evidence"
      );
    }
    return { markdown, structuredAnswer, curatedEvidence };
  };

  let retryResult: Awaited<ReturnType<typeof runCodexWithRetries>>;
  try {
    retryResult = await runCodexWithRetries(
      options.config,
      runner,
      validate,
      appServerExecutions,
      options.jobId,
      () => remainingRequestTime(state) > 0
    );
  } catch (error) {
    markBudgetExhaustionFromError(state.ledger, error);
    if (remainingRequestTime(state) <= 0) {
      markBudgetExhausted(state.ledger, "wall_time");
    }
    if (state.ledger.workerAttempts >= options.config.maxAttempts) {
      markBudgetExhausted(state.ledger, "attempts");
    }
    throw Object.assign(
      error instanceof Error ? error : new Error(errorMessage(error)),
      {
        memoryAnswerFailureState: state,
        promptTokens,
        appServerExecutions
      }
    );
  }
  const { run, validated } = retryResult;
  const { result } = run;
  const { markdown, structuredAnswer, curatedEvidence } = validated;
  const primaryThreadId =
    normalizeExecutionPrimaryThreadIds(appServerExecutions) ??
    result.primaryThreadId ??
    result.threadId;
  return {
    markdown,
    structuredAnswer,
    model: result.model,
    promptTokens,
    searchCount: state.ledger.searchAttempts,
    expandCount: state.ledger.expansionAttempts,
    memoryStatus: structuredAnswer.memory_status,
    tokenUsage: result.tokenUsage,
    threadId: primaryThreadId,
    turnId: result.turnId,
    rawEvents: result.rawEvents,
    appServerExecutions,
    evidence: curatedEvidence,
    candidates: state.evidence,
    citations: citationsFromHits(curatedEvidence),
    searches: state.searches,
    retrievals: state.retrievals,
    expansions: state.expansions,
    errors: state.errors,
    expansionRecords: state.expansionRecords,
    budgetLedger: state.ledger
  };
};

export const answerWithMemoryWorker = async (
  payload: MemoryAnswerPayload,
  options: {
    config?: MemoryAnswerWorkerConfig;
    client?: MemoryAnswerRetrievalClient;
    retrievalScope?: string;
    searchDomain?: string;
    sessionId?: string;
    projectId?: string;
    teamWorkspaceId?: string;
    recentDays?: number;
    sourceAfter?: string;
    sourceBefore?: string;
    limit?: number;
    responseDetail?: MemoryAnswerResponseDetail;
    signal?: AbortSignal;
    retrievalHints?: MemoryAnswerRetrievalHints;
    evaluationController?: MemoryAnswerEvaluationController;
    /** Direct-call Retrieval Arena telemetry; never exposed through API/MCP input. */
    captureProcessMetrics?: boolean;
  } = {}
): Promise<MemoryAnswerWorkerResponse> => {
  const config = options.config ?? resolveMemoryAnswerWorkerConfig();
  const promptTemplate = loadPrompt("memory-answer-worker", {
    env: config.env
  });
  const promptVersion = promptTemplate.version;
  const jobId = randomUUID();
  const responseDetail = options.responseDetail ?? "answer_only";
  const retrievalHints = normalizeMemoryAnswerRetrievalHints(
    options.retrievalHints
  );
  const evaluation = resolveMemoryAnswerEvaluationController(
    options.evaluationController
  );
  assertMemoryAnswerEvaluationPayload(payload, evaluation);
  const promptTokens = countTokensForModel(
    queryFromPayload(payload) +
      "\n" +
      JSON.stringify(retrievalFromPayload(payload) ?? {}),
    { model: config.model }
  );

  if (config.provider !== CODEX_ANSWER_PROVIDER) {
    return compactMemoryAnswerPayload(
      {
        ...payload,
        localMemoryWorker: {
          provider: config.provider,
          promptVersion,
          jobId,
          model: null,
          usedFallback: true,
          skippedReason: "disabled"
        }
      },
      responseDetail
    );
  }

  if (!options.client) {
    return compactMemoryAnswerPayload(
      {
        ...payload,
        localMemoryWorker: {
          provider: config.provider,
          promptVersion,
          jobId,
          model: null,
          usedFallback: true,
          skippedReason: "missing_retrieval_client"
        }
      },
      responseDetail
    );
  }

  try {
    const answer = await runDynamicToolMemoryAnswer(payload, {
      jobId,
      config,
      client: retrievalClientForAuthorizationBoundary(
        options.client,
        typeof payload.authorizationBoundary === "string"
          ? payload.authorizationBoundary
          : undefined
      ),
      retrievalScope: options.retrievalScope ?? "personal",
      searchDomain: options.searchDomain ?? "project",
      sessionId: options.sessionId,
      projectId: options.projectId,
      teamWorkspaceId: options.teamWorkspaceId,
      recentDays: options.recentDays,
      sourceAfter: options.sourceAfter,
      sourceBefore: options.sourceBefore,
      limit: options.limit ?? 10,
      retrievalHints,
      evaluation,
      promptTemplate,
      captureProcessMetrics: options.captureProcessMetrics,
      signal: options.signal
    });
    return compactMemoryAnswerPayload(
      {
        ...payload,
        markdown: answer.markdown,
        structuredAnswer: answer.structuredAnswer,
        evidence: answer.evidence,
        citations: answer.citations,
        evidenceBundle: {
          ...payload.evidenceBundle,
          query: queryFromPayload(payload),
          evidence: answer.evidence,
          retrieval: {
            mode:
              evaluation.retrievalVariant !== "production"
                ? `retrieval_arena_${evaluation.retrievalVariant}`
                : evaluation.scriptedFirstPass
                  ? "scripted_first_pass_with_worker_follow_up"
                  : "worker_directed_retrieval_without_scripted_first_pass",
            searches: answer.searches
              .slice(0, config.maxSearches)
              .map((search) => ({
                query: search.query.slice(0, 512),
                retrievalScope: search.retrievalScope,
                searchDomain: search.searchDomain,
                retrievalStage: search.retrievalStage,
                sessionId: search.sessionId,
                projectId: search.projectId,
                recentDays: search.recentDays,
                sourceAfter: search.sourceAfter,
                sourceBefore: search.sourceBefore,
                limit: search.limit,
                hitCount: search.hitCount,
                phase: search.phase,
                durationMs: search.durationMs,
                errorClass: search.errorClass
              })),
            retrievals: answer.retrievals
              .slice(0, config.maxSearches)
              .map(sanitizeRetrievalDiagnostic),
            expansions: answer.expansions
              .slice(0, config.maxExpansions)
              .map((expansion) => {
                const detail = recordFromUnknown(
                  recordFromUnknown(expansion).expanded ?? expansion
                );
                return {
                  nodeId: detail.nodeId,
                  visibility: detail.visibility,
                  sourceItemCount: Array.isArray(detail.sourceItems)
                    ? detail.sourceItems.length
                    : 0
                };
              }),
            trace: memoryAnswerTrace({
              config,
              state: {
                query: queryFromPayload(payload),
                retrievalScope: options.retrievalScope ?? "personal",
                searchDomain: options.searchDomain ?? "project",
                sessionId: options.sessionId,
                projectId: options.projectId,
                teamWorkspaceId: options.teamWorkspaceId,
                recentDays: options.recentDays,
                sourceAfter: options.sourceAfter,
                sourceBefore: options.sourceBefore,
                limit: options.limit ?? 10,
                evidence: answer.candidates,
                citations: answer.citations,
                retrievals: answer.retrievals,
                searches: answer.searches,
                expansions: answer.expansions,
                expansionRecords: answer.expansionRecords,
                errors: answer.errors,
                retrievalHints,
                servedCachedScan: false,
                ledger: answer.budgetLedger,
                evaluation
              },
              retrievalHints,
              selectedEvidence: answer.evidence,
              attempts: answer.appServerExecutions,
              model: answer.model,
              promptTokens: answer.promptTokens,
              boundary: {
                retrievalScope: options.retrievalScope ?? "personal",
                searchDomain: options.searchDomain ?? "project",
                sessionId: options.sessionId,
                projectId: options.projectId,
                teamWorkspaceId: options.teamWorkspaceId,
                recentDays: options.recentDays,
                sourceAfter: options.sourceAfter,
                sourceBefore: options.sourceBefore
              }
            })
          }
        },
        localMemoryWorker: {
          provider: config.provider,
          promptVersion,
          jobId,
          model: answer.model,
          promptTokenEstimate: answer.promptTokens.tokens,
          tokenizerEncoding: answer.promptTokens.encoding,
          tokenizerModelMatched: answer.promptTokens.exactModelMatch,
          searchCount: answer.searchCount,
          expandCount: answer.expandCount,
          candidateCount: answer.candidates.length,
          evidenceTokenEstimate: answer.budgetLedger.evidenceTokenEstimate,
          memoryStatus: answer.memoryStatus,
          tokenUsage: answer.tokenUsage,
          appServerThreadId: answer.threadId,
          appServerTurnId: answer.turnId,
          appServerEvents: answer.rawEvents,
          appServerExecutions: answer.appServerExecutions,
          usedFallback: false
        }
      },
      responseDetail
    );
  } catch (error) {
    const appServerExecutions = appServerExecutionsFromError(error);
    const failureState = failureStateFromError(error);
    const failurePromptTokens = promptTokensFromError(error) ?? promptTokens;
    const workerErrorMessage = errorMessage(error);
    const exhaustedBudgets = failureState?.ledger.budgetExhaustions ?? [];
    const retrievalIncomplete =
      (failureState?.errors.length ?? 0) > 0 || exhaustedBudgets.length > 0;
    const incompleteAnswer: StructuredMemoryAnswer | undefined =
      retrievalIncomplete
        ? {
            schema_version: MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
            memory_status: "insufficient",
            relevant_memory_found: false,
            answer_markdown:
              "Memory retrieval was incomplete, so there is not enough evidence to answer reliably.",
            relevance_explanation:
              exhaustedBudgets.length > 0
                ? `Memory Answer exhausted bounded resources (${exhaustedBudgets.slice(0, 8).join(", ")}) before the available memory could be judged completely.`
                : "One or more bounded retrieval operations failed before the available memory could be judged completely.",
            evidence: [],
            missing: [
              exhaustedBudgets.length > 0
                ? `unexhausted ${exhaustedBudgets.slice(0, 8).join(", ")} budget`
                : "complete memory retrieval"
            ],
            missing_evidence: [
              "relevant evidence from the failed retrieval stages"
            ]
          }
        : undefined;
    return compactMemoryAnswerPayload(
      {
        ...payload,
        markdown:
          incompleteAnswer?.answer_markdown ??
          "Memory answer worker failed before judging retrieved evidence.",
        ...(incompleteAnswer ? { structuredAnswer: incompleteAnswer } : {}),
        evidenceBundle: {
          ...payload.evidenceBundle,
          query: queryFromPayload(payload),
          evidence: [],
          retrieval: failureState
            ? {
                mode:
                  evaluation.retrievalVariant !== "production"
                    ? `retrieval_arena_${evaluation.retrievalVariant}_failed`
                    : evaluation.scriptedFirstPass
                      ? "scripted_first_pass_with_worker_follow_up_failed"
                      : "worker_directed_retrieval_without_scripted_first_pass_failed",
                searches: failureState.searches
                  .slice(0, config.maxSearches)
                  .map((search) => ({
                    query: search.query.slice(0, 512),
                    retrievalScope: search.retrievalScope,
                    searchDomain: search.searchDomain,
                    retrievalStage: search.retrievalStage,
                    sessionId: search.sessionId,
                    projectId: search.projectId,
                    recentDays: search.recentDays,
                    sourceAfter: search.sourceAfter,
                    sourceBefore: search.sourceBefore,
                    limit: search.limit,
                    hitCount: search.hitCount,
                    phase: search.phase,
                    durationMs: search.durationMs,
                    errorClass: search.errorClass
                  })),
                retrievals: failureState.retrievals
                  .slice(0, config.maxSearches)
                  .map(sanitizeRetrievalDiagnostic),
                trace: memoryAnswerTrace({
                  config,
                  state: failureState,
                  retrievalHints,
                  attempts: appServerExecutions ?? [],
                  model: null,
                  promptTokens: failurePromptTokens,
                  boundary: {
                    retrievalScope: options.retrievalScope ?? "personal",
                    searchDomain: options.searchDomain ?? "project",
                    sessionId: options.sessionId,
                    projectId: options.projectId,
                    teamWorkspaceId: options.teamWorkspaceId,
                    recentDays: options.recentDays,
                    sourceAfter: options.sourceAfter,
                    sourceBefore: options.sourceBefore
                  }
                })
              }
            : payload.evidenceBundle?.retrieval
        },
        localMemoryWorker: {
          provider: config.provider,
          promptVersion,
          jobId,
          model: null,
          promptTokenEstimate: failurePromptTokens.tokens,
          tokenizerEncoding: failurePromptTokens.encoding,
          tokenizerModelMatched: failurePromptTokens.exactModelMatch,
          searchCount: failureState?.ledger.searchAttempts,
          expandCount: failureState?.ledger.expansionAttempts,
          candidateCount: failureState?.evidence.length,
          evidenceTokenEstimate: failureState?.ledger.evidenceTokenEstimate,
          memoryStatus: incompleteAnswer?.memory_status,
          appServerExecutions,
          errorMessage: workerErrorMessage,
          usedFallback: true,
          skippedReason: "codex_failed"
        }
      },
      responseDetail
    );
  }
};
