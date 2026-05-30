import { getEncoding, type Tiktoken } from "js-tiktoken";
import { z } from "zod";

export type TokenizerEncoding = "o200k_base" | "cl100k_base";
export type TokenizerName = "js-tiktoken" | "heuristic";

export interface TokenCountOptions {
  model?: string;
  encoding?: TokenizerEncoding;
}

export interface TokenChunkOptions extends TokenCountOptions {
  maxTokens: number;
  overlapTokens?: number;
}

export interface TokenEncodingResolution {
  model: string;
  encoding: TokenizerEncoding;
  exactModelMatch: boolean;
}

export interface TokenCountResult extends TokenEncodingResolution {
  tokens: number;
  tokenizer: TokenizerName;
}

export const DEFAULT_CODEX_TOKEN_MODEL = "gpt-5.4-mini";

const explicitCodexModelEncodings = new Map<string, TokenizerEncoding>([
  ["gpt-5.5", "o200k_base"],
  ["gpt-5.4", "o200k_base"],
  ["gpt-5.4-mini", "o200k_base"],
  ["gpt-5.3-codex", "o200k_base"],
  ["gpt-5.3-codex-spark", "o200k_base"],
  ["gpt-5.2", "o200k_base"],
  ["gpt-5.2-codex", "o200k_base"],
  ["gpt-5.1", "o200k_base"],
  ["gpt-5.1-codex", "o200k_base"],
  ["gpt-5.1-codex-mini", "o200k_base"],
  ["gpt-5", "o200k_base"],
  ["gpt-5-codex", "o200k_base"],
  ["codex-mini-latest", "o200k_base"],
  ["gpt-4.1", "o200k_base"],
  ["gpt-4.1-mini", "o200k_base"],
  ["gpt-4.1-nano", "o200k_base"],
  ["gpt-4o", "o200k_base"],
  ["gpt-4o-mini", "o200k_base"],
  ["o1", "o200k_base"],
  ["o1-mini", "o200k_base"],
  ["o1-preview", "o200k_base"],
  ["o1-pro", "o200k_base"],
  ["o3", "o200k_base"],
  ["o3-mini", "o200k_base"],
  ["o3-pro", "o200k_base"],
  ["o4-mini", "o200k_base"],
  ["gpt-4", "cl100k_base"],
  ["gpt-4-turbo", "cl100k_base"],
  ["gpt-3.5-turbo", "cl100k_base"]
]);

const tokenizers = new Map<TokenizerEncoding, Tiktoken>();

const normalizeModel = (model?: string): string =>
  (model?.trim() || DEFAULT_CODEX_TOKEN_MODEL).toLowerCase();

const fallbackTokenCount = (text: string): number =>
  Math.ceil(text.trim().length / 4);

const tokenizerForEncoding = (encoding: TokenizerEncoding): Tiktoken => {
  const existing = tokenizers.get(encoding);
  if (existing) {
    return existing;
  }
  const tokenizer = getEncoding(encoding);
  tokenizers.set(encoding, tokenizer);
  return tokenizer;
};

export const resolveTokenEncodingForModel = (
  model?: string,
  encoding?: TokenizerEncoding
): TokenEncodingResolution => {
  const normalizedModel = normalizeModel(model);
  if (encoding) {
    return {
      model: normalizedModel,
      encoding,
      exactModelMatch: false
    };
  }

  const explicitEncoding = explicitCodexModelEncodings.get(normalizedModel);
  if (explicitEncoding) {
    return {
      model: normalizedModel,
      encoding: explicitEncoding,
      exactModelMatch: true
    };
  }

  if (
    normalizedModel.startsWith("gpt-5") ||
    normalizedModel.startsWith("gpt-4.1") ||
    normalizedModel.startsWith("gpt-4o") ||
    normalizedModel.startsWith("o1") ||
    normalizedModel.startsWith("o3") ||
    normalizedModel.startsWith("o4") ||
    normalizedModel.includes("codex")
  ) {
    return {
      model: normalizedModel,
      encoding: "o200k_base",
      exactModelMatch: false
    };
  }

  if (
    normalizedModel.startsWith("gpt-4") ||
    normalizedModel.startsWith("gpt-3.5")
  ) {
    return {
      model: normalizedModel,
      encoding: "cl100k_base",
      exactModelMatch: false
    };
  }

  return {
    model: normalizedModel,
    encoding: "o200k_base",
    exactModelMatch: false
  };
};

export const countTokensForModel = (
  text: string,
  options: TokenCountOptions = {}
): TokenCountResult => {
  const resolution = resolveTokenEncodingForModel(
    options.model,
    options.encoding
  );
  try {
    return {
      ...resolution,
      tokens: tokenizerForEncoding(resolution.encoding).encode(text).length,
      tokenizer: "js-tiktoken"
    };
  } catch {
    return {
      ...resolution,
      tokens: fallbackTokenCount(text),
      tokenizer: "heuristic"
    };
  }
};

export const chunkTextForModel = (
  text: string,
  options: TokenChunkOptions
): string[] => {
  const maxTokens = Math.floor(options.maxTokens);
  if (!Number.isFinite(maxTokens) || maxTokens < 1) {
    throw new Error("maxTokens must be a positive integer");
  }

  const normalizedText = text.trim();
  if (normalizedText.length === 0) {
    return [];
  }

  const resolution = resolveTokenEncodingForModel(
    options.model,
    options.encoding
  );
  const overlapTokens = Math.max(
    0,
    Math.min(Math.floor(options.overlapTokens ?? 0), maxTokens - 1)
  );
  const stride = maxTokens - overlapTokens;

  try {
    const tokenizer = tokenizerForEncoding(resolution.encoding);
    const tokens = tokenizer.encode(normalizedText);
    if (tokens.length <= maxTokens) {
      return [normalizedText];
    }

    const chunks: string[] = [];
    for (let start = 0; start < tokens.length; start += stride) {
      const end = Math.min(start + maxTokens, tokens.length);
      const chunk = tokenizer.decode(tokens.slice(start, end)).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
      if (end >= tokens.length) {
        break;
      }
    }
    return chunks;
  } catch {
    const words = normalizedText.split(/\s+/);
    const chunks: string[] = [];
    let current: string[] = [];

    for (const word of words) {
      const candidate = current.length > 0 ? [...current, word] : [word];
      if (
        current.length > 0 &&
        fallbackTokenCount(candidate.join(" ")) > maxTokens
      ) {
        chunks.push(current.join(" "));
        current = [word];
      } else {
        current = candidate;
      }
    }

    if (current.length > 0) {
      chunks.push(current.join(" "));
    }

    return chunks;
  }
};

export const memoryScopeSchema = z.literal("personal");
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export const memorySearchDomainSchema = z.enum([
  "global",
  "project",
  "session"
]);
export type MemorySearchDomain = z.infer<typeof memorySearchDomainSchema>;

export const memorySourceInputSchema = z.object({
  text: z.string().min(1),
  scope: memoryScopeSchema.default("personal"),
  project: z.string().optional(),
  thread: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
export type MemorySourceInput = z.infer<typeof memorySourceInputSchema>;

export interface EmbeddingRequest {
  input: string;
  model?: string;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
}

export interface RetrievalMetadata {
  retrievalMode:
    | "semantic_vector"
    | "semantic_vector_reranked"
    | "embedding_unavailable";
  vectorHitsCount: number;
  textHitsCount: number;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  vectorCandidateCount?: number;
  rerankedCount?: number;
  rerankerModel?: string | null;
  rerankingEnabled?: boolean;
  rerankingUnavailable?: boolean;
  rerankingError?: string;
  temporalFilter?: {
    recentDays?: number;
    sourceAfter?: string;
    sourceBefore?: string;
  };
  stages?: Array<{
    name: string;
    ran: boolean;
    used: boolean;
    candidateCount: number;
    selectedCount: number;
    durationMs: number;
    parallelGroup?: string;
    temporalFilterApplied?: boolean;
    reranked?: boolean;
    parentNodeIds?: string[];
    topScore?: number;
    scoreThreshold?: number;
    countAboveThreshold?: number;
    maxAllowed?: number;
    rejectedCount?: number;
    candidateIds?: string[];
    error?: string;
  }>;
}

export interface MemoryEngine {
  remember(input: MemorySourceInput): Promise<{ memoryId: string }>;
  answer(
    question: string,
    scope: MemoryScope
  ): Promise<{
    answer: string;
    citations: MemorySearchResult["citation"][];
    evidenceBundle: AnswerEvidenceBundle;
  }>;
}

export interface LcmNode {
  id: string;
  depth: 0 | 1;
  kind: "leaf" | "rollup";
  scope: MemoryScope;
  summaryText: string;
  sourceItemIds: string[];
}

export type Visibility = "personal";
export type MemoryActor =
  | "user"
  | "assistant"
  | "agent"
  | "subagent"
  | "tool"
  | "system";
export type MemoryEventType =
  | "captured"
  | "invalidated"
  | "summarized"
  | "embedded";

export interface RequesterContext {
  userId: string;
}

export interface PersonalEventInput {
  requesterContext: RequesterContext;
  workspaceId: string;
  sessionId?: string;
  turnId?: string;
  actor: MemoryActor;
  eventType: string;
  content: string;
  metadata?: Record<string, unknown>;
  visibility?: Visibility;
  sourceRuntime?: "codex" | "codex-cli";
  captureMethod?: "hook" | "mcp" | "web" | "api";
  codexTranscriptPath?: string;
  idempotencyKey?: string;
  sourceHash?: string;
  capturedAt?: string;
}

export interface SearchMemoryInput {
  requesterContext: RequesterContext;
  query: string;
  scope: MemoryScope;
  searchDomain?: MemorySearchDomain;
  sessionId?: string;
  workspaceId?: string;
  limit?: number;
  recentDays?: number;
  sourceAfter?: string;
  sourceBefore?: string;
  retrievalStage?:
    | "score_scan"
    | "rollup_search"
    | "scoped_leaf_search"
    | "leaf_search"
    | "fresh_pending_search"
    | "raw_fallback_search"
    | "lexical_search";
  parentNodeIds?: string[];
  strictLimit?: boolean;
}

export type AnswerMemoryInput = SearchMemoryInput;

export interface ScheduleCompactionInput {
  requesterContext: RequesterContext;
  visibility: Visibility;
}

export interface MemoryEventRecord {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  turnId: string | null;
  actor: MemoryActor;
  eventType: string;
  content: string;
  metadata: Record<string, unknown>;
  visibility: Visibility;
  ownerUserId: string | null;
  createdAt: string;
}

export interface MemorySearchResult {
  nodeId: string;
  sourceType?: "memory_node" | "memory_event" | "message";
  sourceId?: string;
  sourceChunkIndex?: number;
  sourceChunkCount?: number;
  retrievalStage?: string;
  parentNodeIds?: string[];
  visibility: Visibility;
  summaryText: string;
  lcmNodeSummaryStatus?: "pending" | "summarized";
  lcmNodeSummaryModel?: string | null;
  score: number;
  citation: {
    nodeId: string;
    sourceType?: "memory_node" | "memory_event" | "message";
    sourceId?: string;
    sourceChunkIndex?: number;
    sourceChunkCount?: number;
    retrievalStage?: string;
    parentNodeIds?: string[];
    visibility: Visibility;
  };
}

export interface AnswerEvidenceBundle {
  query: string;
  instructions: string;
  evidence: MemorySearchResult[];
  retrieval: RetrievalMetadata;
}

export interface ExpandedMemoryNode {
  nodeId: string;
  visibility: Visibility;
  sourceItems: LcmSourceItem[];
  sources: MemoryEventRecord[];
}

export interface LcmSourceItem {
  kind: "memory_event" | "message" | "tool_event" | "lcm_child";
  sourceTable?: "memory_events" | "messages" | "tool_events";
  sourceId?: string;
  nodeId?: string;
  visibility?: Visibility;
  actor?: MemoryActor;
  turnId?: string | null;
  createdAt?: string;
  text?: string;
  payload?: unknown;
  position: number;
}

export interface CompactionResult {
  leafNodeIds: string[];
  rollupNodeId: string | null;
}

export interface MemoryEngineRepository {
  createMemoryEvent(
    actor: RequesterContext,
    input: {
      workspaceId: string;
      sessionId?: string;
      turnId?: string;
      actor: MemoryActor;
      eventType: MemoryEventType;
      rawEventType: string;
      content: string;
      metadata?: Record<string, unknown>;
      visibility: Visibility;
      sourceRuntime?: "codex" | "codex-cli";
      captureMethod?: "hook" | "mcp" | "web" | "api";
      codexTranscriptPath?: string;
      idempotencyKey?: string;
      sourceHash?: string;
      capturedAt?: string;
    }
  ): Promise<MemoryEventRecord>;
  searchMemoryNodes(
    actor: RequesterContext,
    input: {
      scope: MemoryScope;
      query: string;
      searchDomain?: MemorySearchDomain;
      sessionId?: string;
      workspaceId?: string;
      limit?: number;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
      retrievalStage?: SearchMemoryInput["retrievalStage"];
      parentNodeIds?: string[];
      strictLimit?: boolean;
    }
  ): Promise<{
    results: MemorySearchResult[];
    metadata: RetrievalMetadata;
  }>;
  createLcmNodes(
    actor: RequesterContext,
    input: { visibility: Visibility }
  ): Promise<CompactionResult>;
  expandMemoryNode(
    nodeId: string,
    actor: RequesterContext,
    input?: {
      searchDomain?: MemorySearchDomain;
      sessionId?: string;
      workspaceId?: string;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
    }
  ): Promise<ExpandedMemoryNode>;
}

const withRepository = <T extends { repository: MemoryEngineRepository }>(
  input: T
): [MemoryEngineRepository, Omit<T, "repository">] => {
  const { repository, ...rest } = input;
  return [repository, rest];
};

export const capturePersonalEvent = async (
  input: PersonalEventInput & { repository: MemoryEngineRepository }
): Promise<MemoryEventRecord> => {
  const [repository, event] = withRepository(input);
  return repository.createMemoryEvent(event.requesterContext, {
    ...event,
    eventType: "captured",
    rawEventType: event.eventType,
    visibility: event.visibility ?? "personal",
    sourceRuntime: event.sourceRuntime,
    captureMethod: event.captureMethod,
    codexTranscriptPath: event.codexTranscriptPath,
    idempotencyKey: event.idempotencyKey,
    sourceHash: event.sourceHash,
    capturedAt: event.capturedAt
  });
};

export const searchMemory = async (
  input: SearchMemoryInput & { repository: MemoryEngineRepository }
): Promise<{ results: MemorySearchResult[]; metadata: RetrievalMetadata }> => {
  const [repository, search] = withRepository(input);
  return repository.searchMemoryNodes(search.requesterContext, search);
};

export const answerMemory = async (
  input: AnswerMemoryInput & { repository: MemoryEngineRepository }
): Promise<{
  answer: string;
  citations: MemorySearchResult["citation"][];
  evidenceBundle: AnswerEvidenceBundle;
}> => {
  const [repository, answer] = withRepository(input);
  const search = await repository.searchMemoryNodes(
    answer.requesterContext,
    answer
  );
  const results = search.results;
  const instructions =
    "Codex should synthesize the final answer using only the cited evidence in this bundle. Cite each claim with the provided personal visibility and source id. If evidence has lcmNodeSummaryStatus=pending, say that the relevant LCM summary is still pending and rely on the exact source text cautiously instead of pretending the rollup is complete. If the evidence is insufficient, say what is missing instead of guessing.";
  const answerText =
    results.length === 0
      ? "No matching memory found."
      : [
          "Evidence bundle returned for Codex synthesis.",
          instructions,
          "",
          ...results.map((result, index) => {
            const pending =
              result.lcmNodeSummaryStatus === "pending"
                ? " pending_lcm_summary"
                : "";
            return `[${index + 1}] (${result.visibility}${pending}) ${result.summaryText}`;
          })
        ].join("\n");

  return {
    answer: answerText,
    citations: results.map((result) => result.citation),
    evidenceBundle: {
      query: answer.query,
      instructions,
      evidence: results,
      retrieval: search.metadata
    }
  };
};

export const expandMemoryNode = async (
  nodeId: string,
  requesterContext: RequesterContext & {
    repository: MemoryEngineRepository;
    searchDomain?: MemorySearchDomain;
    sessionId?: string;
    workspaceId?: string;
    recentDays?: number;
    sourceAfter?: string;
    sourceBefore?: string;
  }
): Promise<ExpandedMemoryNode> => {
  const { repository, ...actor } = requesterContext;
  return repository.expandMemoryNode(nodeId, actor, {
    searchDomain: requesterContext.searchDomain,
    sessionId: requesterContext.sessionId,
    workspaceId: requesterContext.workspaceId,
    recentDays: requesterContext.recentDays,
    sourceAfter: requesterContext.sourceAfter,
    sourceBefore: requesterContext.sourceBefore
  });
};

export const scheduleCompaction = async (
  input: ScheduleCompactionInput & { repository: MemoryEngineRepository }
): Promise<CompactionResult> => {
  const [repository, compaction] = withRepository(input);
  return repository.createLcmNodes(compaction.requesterContext, compaction);
};

export const createMemoryEngine = (repository: MemoryEngineRepository) => ({
  capturePersonalEvent: (input: PersonalEventInput) =>
    capturePersonalEvent({ ...input, repository }),
  searchMemory: (input: SearchMemoryInput) =>
    searchMemory({ ...input, repository }),
  answerMemory: (input: AnswerMemoryInput) =>
    answerMemory({ ...input, repository }),
  expandMemoryNode: (
    nodeId: string,
    requesterContext: RequesterContext,
    input: {
      searchDomain?: MemorySearchDomain;
      sessionId?: string;
      workspaceId?: string;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
    } = {}
  ) => expandMemoryNode(nodeId, { ...requesterContext, ...input, repository }),
  scheduleCompaction: (input: ScheduleCompactionInput) =>
    scheduleCompaction({ ...input, repository })
});

export const estimateTokens = (
  text: string,
  options: TokenCountOptions = {}
): number => countTokensForModel(text, options).tokens;
