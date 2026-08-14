import { performance } from "node:perf_hooks";
import {
  DEFAULT_EMBEDDING_MODEL_KEY,
  EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM,
  EMBEDDING_RETRIEVAL_QUERY_TRANSFORM,
  formatEmbeddingRetrievalDocument,
  formatEmbeddingRetrievalQuery,
  resolveSupportedEmbeddingModelConfig
} from "@koed/shared";
import type {
  ArenaArm,
  ArenaArmContext,
  ArenaProviderCase,
  CorpusItem,
  ProductArmOutput,
  RankedEvidence,
  RetrievalArmOutput
} from "./contracts.js";
import {
  combineProductPeakMemoryTelemetry,
  resolveProductProcessInventory,
  startProductPeakMemorySampler,
  validateProductPeakMemoryTelemetry,
  type ProductPeakMemoryTelemetry
} from "./process-telemetry.js";

const tokenize = (text: string): string[] =>
  text.toLowerCase().match(/[a-z0-9][a-z0-9_.:/-]*/g) ?? [];

const applyEvidenceBudget = (
  ranked: Omit<RankedEvidence, "rank">[],
  context: ArenaArmContext
): RankedEvidence[] => {
  const selected: RankedEvidence[] = [];
  let tokens = 0;
  for (const candidate of ranked.slice(
    0,
    context.benchmarkCase.budget.maxCandidates
  )) {
    if (selected.length >= context.benchmarkCase.budget.maxEvidenceItems) break;
    if (
      tokens + candidate.tokenCount >
      context.benchmarkCase.budget.maxEvidenceTokens
    )
      continue;
    tokens += candidate.tokenCount;
    selected.push({ ...candidate, rank: selected.length + 1 });
  }
  return selected;
};

const rankCandidates = (
  ranked: Omit<RankedEvidence, "rank">[]
): RankedEvidence[] =>
  ranked.map((candidate, index) => ({ ...candidate, rank: index + 1 }));

const evidence = (
  item: CorpusItem,
  score: number
): Omit<RankedEvidence, "rank"> => ({
  itemId: item.id,
  score,
  text: item.text,
  tokenCount: item.tokenCount,
  sourceType: item.sourceType,
  sourceChunkIndex: item.sourceChunkIndex
});

export interface Bm25Options {
  k1?: number;
  b?: number;
}

export const bm25Rank = (
  query: string,
  corpus: CorpusItem[],
  options: Bm25Options = {}
): Array<{ item: CorpusItem; score: number }> => {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const documents = corpus.map((item) => tokenize(item.text));
  const averageLength =
    documents.reduce((sum, tokens) => sum + tokens.length, 0) /
    documents.length;
  const queryTerms = [...new Set(tokenize(query))];
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      documents.filter((tokens) => tokens.includes(term)).length
    );
  }
  return corpus
    .map((item, index) => {
      const tokens = documents[index]!;
      const frequencies = new Map<string, number>();
      tokens.forEach((token) =>
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
      );
      const score = queryTerms.reduce((sum, term) => {
        const frequency = frequencies.get(term) ?? 0;
        if (frequency === 0) return sum;
        const frequencyInCorpus = documentFrequency.get(term) ?? 0;
        const inverseDocumentFrequency = Math.log(
          1 +
            (corpus.length - frequencyInCorpus + 0.5) /
              (frequencyInCorpus + 0.5)
        );
        const denominator =
          frequency + k1 * (1 - b + b * (tokens.length / averageLength));
        return (
          sum +
          inverseDocumentFrequency * ((frequency * (k1 + 1)) / denominator)
        );
      }, 0);
      return { item, score };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.item.id.localeCompare(right.item.id)
    );
};

export const createBm25Arm = (options: Bm25Options = {}): ArenaArm => ({
  id: "bm25",
  label: "BM25 (pinned)",
  layer: "retrieval_only",
  configuration: {
    k1: options.k1 ?? 1.2,
    b: options.b ?? 0.75,
    tokenizer: "arena-ascii-v1"
  },
  run(context) {
    const ranked = bm25Rank(
      context.benchmarkCase.question,
      context.benchmarkCase.corpus,
      options
    );
    const candidates = rankCandidates(
      ranked.map(({ item, score }) => evidence(item, score))
    );
    return Promise.resolve({
      candidates,
      evidence: applyEvidenceBudget(candidates, context),
      metrics: { searchCalls: 1, candidateCount: ranked.length }
    });
  }
});

export interface EmbeddingProvider {
  id: string;
  model: string;
  dimensions?: number;
  reranker?: {
    model: string | null;
    artifact: string | null;
    artifactRevision: string | null;
    artifactHash: string | null;
  };
  embed(
    texts: string[],
    options?: {
      signal?: AbortSignal;
      onUsage?: (usage: { calls: number; tokens: number }) => void;
    }
  ): Promise<number[][]>;
  rerank?(
    query: string,
    documents: string[],
    options?: { signal?: AbortSignal }
  ): Promise<
    | number[]
    | {
        scores: number[];
        model: string | null;
        artifact: string | null;
        artifactRevision: string | null;
        artifactHash: string | null;
        latencyMs: number | null;
        inputTokens: number | null;
        costUsd: number | null;
      }
  >;
}

export class ProviderUnavailableError extends Error {
  constructor(readonly requirement: string) {
    super(`provider unavailable: ${requirement}`);
    this.name = "ProviderUnavailableError";
  }
}

const unavailableArm = (
  id: string,
  label: string,
  layer: "retrieval_only" | "product",
  requirement: string
): ArenaArm => ({
  id,
  label,
  layer,
  providerRequirement: requirement,
  configuration: {},
  run: () => Promise.reject(new ProviderUnavailableError(requirement))
});

interface EmbeddingResponse {
  model: string;
  dimensions: number;
  vectors: number[][];
  measuredTokens: number;
}

interface EmbeddingHealthResponse {
  status?: unknown;
  modelKey?: unknown;
  dimensions?: unknown;
  artifact?: unknown;
  artifactRevision?: unknown;
  artifactHash?: unknown;
  tokenizer?: unknown;
  tokenizerRevision?: unknown;
  acceleration?: unknown;
  batchLimit?: unknown;
  reranker?: {
    enabled?: unknown;
    loaded?: unknown;
    modelKey?: unknown;
    model?: unknown;
    artifact?: unknown;
    artifactRevision?: unknown;
    artifactHash?: unknown;
  };
}

export const resolveKoedEmbeddingServiceReproducibility = async (options: {
  baseUrl: string;
  token?: string;
  model?: string;
  strict?: boolean;
  requireReranker?: boolean;
}): Promise<{
  artifact: string | null;
  artifactRevision: string | null;
  artifactHash: string | null;
  dimensions: number | null;
  tokenizer: string | null;
  tokenizerRevision: string | null;
  acceleration: string | null;
  batchLimit: number;
  reranker: {
    model: string | null;
    artifact: string | null;
    artifactRevision: string | null;
    artifactHash: string | null;
  } | null;
}> => {
  const canonical = resolveSupportedEmbeddingModelConfig(
    options.model ?? DEFAULT_EMBEDDING_MODEL_KEY
  );
  const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/health`, {
    headers: options.token
      ? { "x-koed-embedding-token": options.token }
      : undefined
  });
  if (!response.ok) {
    throw new Error(
      `embedding service health returned ${response.status}: ${await response.text()}`
    );
  }
  const health = (await response.json()) as EmbeddingHealthResponse;
  if (
    health.status !== "ok" ||
    health.modelKey !== canonical.key ||
    health.dimensions !== canonical.dimensions
  ) {
    throw new Error(
      `embedding service health does not verify ${canonical.key}/${canonical.dimensions}`
    );
  }
  const metadata = {
    artifact: typeof health.artifact === "string" ? health.artifact : null,
    artifactRevision:
      typeof health.artifactRevision === "string"
        ? health.artifactRevision
        : null,
    artifactHash:
      typeof health.artifactHash === "string" ? health.artifactHash : null,
    dimensions: health.dimensions,
    tokenizer: typeof health.tokenizer === "string" ? health.tokenizer : null,
    tokenizerRevision:
      typeof health.tokenizerRevision === "string"
        ? health.tokenizerRevision
        : null,
    acceleration:
      typeof health.acceleration === "string" ? health.acceleration : null,
    batchLimit:
      Number.isInteger(health.batchLimit) && Number(health.batchLimit) > 0
        ? Number(health.batchLimit)
        : 0,
    reranker:
      health.reranker?.enabled === true
        ? {
            model:
              typeof health.reranker.modelKey === "string"
                ? health.reranker.modelKey
                : null,
            artifact:
              typeof health.reranker.artifact === "string"
                ? health.reranker.artifact
                : typeof health.reranker.model === "string"
                  ? health.reranker.model
                  : null,
            artifactRevision:
              typeof health.reranker.artifactRevision === "string"
                ? health.reranker.artifactRevision
                : null,
            artifactHash:
              typeof health.reranker.artifactHash === "string"
                ? health.reranker.artifactHash
                : null
          }
        : null
  };
  if (options.strict) {
    const missing = Object.entries(metadata)
      .filter(([key]) => key !== "reranker")
      .filter(([, value]) => value === null || value === 0)
      .map(([key]) => key);
    if (missing.length > 0) {
      throw new Error(
        `strict embedding reproducibility requires service-verified ${missing.join(", ")}; update the Embedding Service or provide a service configuration that exposes them`
      );
    }
    if (
      metadata.artifact !== canonical.artifact ||
      metadata.artifactRevision !== canonical.artifactRevision ||
      metadata.artifactHash !== canonical.defaultArtifactSha256 ||
      metadata.tokenizer !== canonical.tokenizer ||
      metadata.tokenizerRevision !== canonical.tokenizerRevision ||
      metadata.acceleration !== canonical.acceleration
    ) {
      throw new Error(
        "strict embedding reproducibility rejected metadata that differs from the canonical supported model"
      );
    }
    if (options.requireReranker) {
      if (!metadata.reranker || health.reranker?.loaded !== true) {
        throw new Error(
          "strict reranker reproducibility requires a loaded service reranker"
        );
      }
      const missingReranker = Object.entries(metadata.reranker)
        .filter(([, value]) => value === null)
        .map(([key]) => key);
      if (missingReranker.length > 0) {
        throw new Error(
          `strict reranker reproducibility requires service-verified ${missingReranker.join(", ")}`
        );
      }
      if (
        !/^[a-f0-9]{64}$/.test(metadata.reranker.artifactHash!) ||
        metadata.reranker.artifactRevision !==
          `sha256:${metadata.reranker.artifactHash}`
      ) {
        throw new Error(
          "strict reranker reproducibility requires an artifact revision proved by the loaded artifact SHA-256"
        );
      }
    }
  }
  return metadata;
};

const postJson = async <T>(
  url: string,
  token: string | undefined,
  body: unknown,
  signal?: AbortSignal
): Promise<T> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-koed-embedding-token": token } : {})
    },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok)
    throw new Error(
      `${url} returned ${response.status}: ${await response.text()}`
    );
  return (await response.json()) as T;
};

export const createKoedEmbeddingServiceProvider = (options: {
  baseUrl: string;
  token?: string;
  model?: string;
  id?: string;
  dimensions?: number;
  batchLimit?: number;
  reranker?: {
    model: string | null;
    artifact: string | null;
    artifactRevision: string | null;
    artifactHash: string | null;
  } | null;
}): EmbeddingProvider => {
  const configured = resolveSupportedEmbeddingModelConfig(
    options.model ?? DEFAULT_EMBEDDING_MODEL_KEY
  );
  const expectedDimensions = options.dimensions ?? configured.dimensions;
  const batchLimit = options.batchLimit ?? 16;
  if (!Number.isInteger(batchLimit) || batchLimit <= 0) {
    throw new Error(
      "embedding provider batch limit must be a positive integer"
    );
  }
  return {
    id: options.id ?? "koed-embedding-service",
    model: configured.key,
    dimensions: expectedDimensions,
    ...(options.reranker ? { reranker: options.reranker } : {}),
    async embed(texts, requestOptions) {
      const vectors: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += batchLimit) {
        const batch = texts.slice(offset, offset + batchLimit);
        const result = await postJson<EmbeddingResponse>(
          `${options.baseUrl.replace(/\/$/, "")}/embed`,
          options.token,
          { texts: batch },
          requestOptions?.signal
        );
        if (result.model !== configured.key) {
          throw new Error(
            `embedding service reported model ${result.model}; expected ${configured.key}`
          );
        }
        if (result.dimensions !== expectedDimensions) {
          throw new Error(
            `embedding service reported ${result.dimensions} dimensions; expected ${expectedDimensions}`
          );
        }
        if (
          result.vectors.length !== batch.length ||
          result.vectors.some((vector) => vector.length !== result.dimensions)
        ) {
          throw new Error(
            "embedding service vectors do not match the requested batch or reported dimensions"
          );
        }
        if (
          !Number.isInteger(result.measuredTokens) ||
          result.measuredTokens < 0
        ) {
          throw new Error(
            "embedding service did not report a valid measured token count"
          );
        }
        vectors.push(...result.vectors);
        requestOptions?.onUsage?.({ calls: 1, tokens: result.measuredTokens });
      }
      return vectors;
    },
    async rerank(query, documents, requestOptions) {
      const result = await postJson<{
        model?: unknown;
        artifact?: unknown;
        artifactRevision?: unknown;
        artifactHash?: unknown;
        latencyMs?: unknown;
        scores: number[];
        inputTokens?: unknown;
        costUsd?: unknown;
      }>(
        `${options.baseUrl.replace(/\/$/, "")}/rerank`,
        options.token,
        { query, documents },
        requestOptions?.signal
      );
      const model = typeof result.model === "string" ? result.model : null;
      if (options.reranker?.model && model !== options.reranker.model) {
        throw new Error(
          `reranker service reported model ${model ?? "unknown"}; expected ${options.reranker.model}`
        );
      }
      const artifact =
        typeof result.artifact === "string" ? result.artifact : null;
      const artifactRevision =
        typeof result.artifactRevision === "string"
          ? result.artifactRevision
          : null;
      const artifactHash =
        typeof result.artifactHash === "string" ? result.artifactHash : null;
      if (
        options.reranker?.artifact &&
        artifact !== options.reranker.artifact
      ) {
        throw new Error("reranker service reported a mismatched artifact");
      }
      if (
        options.reranker?.artifactRevision &&
        artifactRevision !== options.reranker.artifactRevision
      ) {
        throw new Error(
          "reranker service reported a mismatched artifact revision"
        );
      }
      if (
        options.reranker?.artifactHash &&
        artifactHash !== options.reranker.artifactHash
      ) {
        throw new Error("reranker service reported a mismatched artifact hash");
      }
      return {
        scores: result.scores,
        model,
        artifact,
        artifactRevision,
        artifactHash,
        latencyMs:
          typeof result.latencyMs === "number" ? result.latencyMs : null,
        inputTokens:
          typeof result.inputTokens === "number" ? result.inputTokens : null,
        costUsd: typeof result.costUsd === "number" ? result.costUsd : null
      };
    }
  };
};

const cosineSimilarity = (left: number[], right: number[]): number => {
  if (left.length !== right.length || left.length === 0)
    throw new Error("embedding dimensions do not match");
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! ** 2;
    rightMagnitude += right[index]! ** 2;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude) || 1);
};

const denseRank = async (
  context: ArenaArmContext,
  provider: EmbeddingProvider,
  query = context.benchmarkCase.question
): Promise<{
  ranked: Array<{ item: CorpusItem; score: number }>;
  embeddingCalls: number | null;
  embeddingTokens: number | null;
}> => {
  const qwen = provider.model === DEFAULT_EMBEDDING_MODEL_KEY;
  let embeddingCalls: number | null = null;
  let embeddingTokens: number | null = null;
  const vectors = await provider.embed(
    [
      qwen ? formatEmbeddingRetrievalQuery(query) : query,
      ...context.benchmarkCase.corpus.map((item) =>
        qwen ? formatEmbeddingRetrievalDocument(item.text) : item.text
      )
    ],
    {
      signal: context.signal,
      onUsage: (usage) => {
        embeddingCalls = (embeddingCalls ?? 0) + usage.calls;
        embeddingTokens = (embeddingTokens ?? 0) + usage.tokens;
      }
    }
  );
  if (vectors.length !== context.benchmarkCase.corpus.length + 1) {
    throw new Error(
      `embedding provider returned ${vectors.length} vectors; expected ${context.benchmarkCase.corpus.length + 1}`
    );
  }
  const queryVector = vectors[0]!;
  const ranked = context.benchmarkCase.corpus
    .map((item, index) => ({
      item,
      score: cosineSimilarity(queryVector, vectors[index + 1]!)
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.item.id.localeCompare(right.item.id)
    );
  return { ranked, embeddingCalls, embeddingTokens };
};

export const createDenseArm = (
  provider: EmbeddingProvider,
  options: { id?: string; label?: string } = {}
): ArenaArm => ({
  id: options.id ?? "qwen-0.6b-dense",
  label: options.label ?? "Qwen3 Embedding 0.6B dense",
  layer: "retrieval_only",
  modelRoles: ["embedding"],
  providerRequirement: provider.id,
  configuration: {
    model: provider.model,
    dimensions: provider.dimensions ?? "provider-reported",
    index: "isolated-eval",
    queryTransform: EMBEDDING_RETRIEVAL_QUERY_TRANSFORM,
    documentTransform: EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM
  },
  async run(context) {
    const { ranked, embeddingCalls, embeddingTokens } = await denseRank(
      context,
      provider
    );
    const candidates = rankCandidates(
      ranked.map(({ item, score }) => evidence(item, score))
    );
    return {
      candidates,
      evidence: applyEvidenceBudget(candidates, context),
      model: provider.model,
      provider: provider.id,
      metrics: {
        searchCalls: 1,
        candidateCount: ranked.length,
        embeddingCalls,
        embeddingTokens
      }
    };
  }
});

export const createRerankedArm = (provider: EmbeddingProvider): ArenaArm => ({
  id: "qwen-0.6b-reranked",
  label: "Qwen3 Embedding 0.6B plus reranker",
  layer: "retrieval_only",
  modelRoles: ["embedding", "reranker"],
  providerRequirement: `${provider.id}:reranker`,
  configuration: {
    denseModel: provider.model,
    reranker: provider.reranker ?? {
      model: null,
      artifact: null,
      artifactRevision: null,
      artifactHash: null
    },
    queryTransform: EMBEDDING_RETRIEVAL_QUERY_TRANSFORM,
    documentTransform: EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM,
    candidatePool: "maxCandidates",
    index: "isolated-eval"
  },
  async run(context) {
    if (!provider.rerank)
      throw new Error("embedding provider does not support reranking");
    const denseResult = await denseRank(context, provider);
    const dense = denseResult.ranked.slice(
      0,
      context.benchmarkCase.budget.maxCandidates
    );
    const rerankerStarted = performance.now();
    const rerankerResult = await provider.rerank(
      context.benchmarkCase.question,
      dense.map(({ item }) => item.text),
      { signal: context.signal }
    );
    const rerankerLatencyMs = Math.round(performance.now() - rerankerStarted);
    const scores = Array.isArray(rerankerResult)
      ? rerankerResult
      : rerankerResult.scores;
    if (scores.length !== dense.length)
      throw new Error("reranker returned an unexpected score count");
    const ranked = dense
      .map(({ item }, index) => ({ item, score: scores[index]! }))
      .sort(
        (left, right) =>
          right.score - left.score || left.item.id.localeCompare(right.item.id)
      );
    const candidates = rankCandidates(
      ranked.map(({ item, score }) => evidence(item, score))
    );
    return {
      candidates,
      evidence: applyEvidenceBudget(candidates, context),
      model: provider.model,
      provider: provider.id,
      rerankerMetrics: {
        model: Array.isArray(rerankerResult)
          ? (provider.reranker?.model ?? null)
          : rerankerResult.model,
        artifact: Array.isArray(rerankerResult)
          ? (provider.reranker?.artifact ?? null)
          : rerankerResult.artifact,
        artifactRevision: Array.isArray(rerankerResult)
          ? (provider.reranker?.artifactRevision ?? null)
          : rerankerResult.artifactRevision,
        artifactHash: Array.isArray(rerankerResult)
          ? (provider.reranker?.artifactHash ?? null)
          : rerankerResult.artifactHash,
        latencyMs: Array.isArray(rerankerResult)
          ? rerankerLatencyMs
          : rerankerResult.latencyMs,
        calls: 1,
        inputTokens: Array.isArray(rerankerResult)
          ? null
          : rerankerResult.inputTokens,
        costUsd: Array.isArray(rerankerResult) ? null : rerankerResult.costUsd
      },
      metrics: {
        searchCalls: 1,
        candidateCount: dense.length,
        embeddingCalls: denseResult.embeddingCalls,
        embeddingTokens: denseResult.embeddingTokens
      }
    };
  }
});

export const reciprocalRankFusion = (
  lists: Array<Array<{ item: CorpusItem; score: number }>>,
  constant = 60
): Array<{ item: CorpusItem; score: number }> => {
  const fused = new Map<string, { item: CorpusItem; score: number }>();
  for (const list of lists) {
    list.forEach(({ item }, index) => {
      const current = fused.get(item.id) ?? { item, score: 0 };
      current.score += 1 / (constant + index + 1);
      fused.set(item.id, current);
    });
  }
  return [...fused.values()].sort(
    (left, right) =>
      right.score - left.score || left.item.id.localeCompare(right.item.id)
  );
};

export const createHybridArm = (provider: EmbeddingProvider): ArenaArm => ({
  id: "bm25-qwen-0.6b-hybrid",
  label: "BM25 plus Qwen3 0.6B fixed hybrid",
  layer: "retrieval_only",
  modelRoles: ["embedding"],
  providerRequirement: provider.id,
  configuration: {
    fusion: "rrf",
    rrfConstant: 60,
    lexical: { k1: 1.2, b: 0.75 },
    denseModel: provider.model,
    queryTransform: EMBEDDING_RETRIEVAL_QUERY_TRANSFORM,
    documentTransform: EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM
  },
  async run(context) {
    const [denseResult, lexical] = await Promise.all([
      denseRank(context, provider),
      Promise.resolve(
        bm25Rank(context.benchmarkCase.question, context.benchmarkCase.corpus)
      )
    ]);
    const dense = denseResult.ranked;
    const ranked = reciprocalRankFusion([dense, lexical]);
    const candidates = rankCandidates(
      ranked.map(({ item, score }) => evidence(item, score))
    );
    return {
      candidates,
      evidence: applyEvidenceBudget(candidates, context),
      model: provider.model,
      provider: provider.id,
      metrics: {
        searchCalls: 2,
        candidateCount: ranked.length,
        embeddingCalls: denseResult.embeddingCalls,
        embeddingTokens: denseResult.embeddingTokens
      }
    };
  }
});

export type QueryRewriteProvider = (
  question: string,
  options?: { signal?: AbortSignal; deadlineAt?: number }
) => Promise<{
  query: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}>;

export const createRewriteDenseArm = (
  provider: EmbeddingProvider,
  rewrite: QueryRewriteProvider
): ArenaArm => ({
  id: "one-rewrite-one-search",
  label: "One local rewrite plus one Qwen search",
  layer: "retrieval_only",
  modelRoles: ["embedding", "rewrite"],
  providerRequirement: `${provider.id}:local-rewriter`,
  configuration: {
    rewrites: 1,
    searches: 1,
    denseModel: provider.model,
    queryTransform: EMBEDDING_RETRIEVAL_QUERY_TRANSFORM,
    documentTransform: EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM
  },
  async run(context) {
    const rewritten = await rewrite(context.benchmarkCase.question, {
      signal: context.signal,
      deadlineAt: context.deadlineAt
    });
    const denseResult = await denseRank(context, provider, rewritten.query);
    const ranked = denseResult.ranked;
    const candidates = rankCandidates(
      ranked.map(({ item, score }) => evidence(item, score))
    );
    return {
      candidates,
      evidence: applyEvidenceBudget(candidates, context),
      rewrittenQuery: rewritten.query,
      model: `${rewritten.model}+${provider.model}`,
      provider: provider.id,
      metrics: {
        searchCalls: 1,
        candidateCount: ranked.length,
        embeddingCalls: denseResult.embeddingCalls,
        embeddingTokens: denseResult.embeddingTokens,
        rewriteInputTokens: rewritten.inputTokens,
        rewriteOutputTokens: rewritten.outputTokens
      }
    };
  }
});

export interface ProductControllerConfig {
  callerHints: boolean;
  scriptedFirstPass: boolean;
  lexicalAnchors: boolean;
  exactAnchorChecks: boolean;
  lcmExpansion: boolean;
  followUpSearch: boolean;
  fusion: boolean;
  maxSearchCalls?: number;
  rewriteOnly?: boolean;
  denseSingleShot?: boolean;
}

export type ProductArmProvider = (
  context: {
    benchmarkCase: ArenaProviderCase;
    runIndex: number;
    deadlineAt: number;
  },
  configuration: ProductControllerConfig
) => Promise<ProductArmOutput>;

const providerSafeCase = (
  benchmarkCase: ArenaArmContext["benchmarkCase"]
): ArenaProviderCase =>
  structuredClone({
    id: benchmarkCase.id,
    split: benchmarkCase.split,
    question: benchmarkCase.question,
    retrievalHints: benchmarkCase.retrievalHints,
    corpus: benchmarkCase.corpus,
    budget: benchmarkCase.budget,
    productContext: benchmarkCase.productContext
  });

export const productionControllerConfiguration: ProductControllerConfig = {
  callerHints: true,
  scriptedFirstPass: true,
  lexicalAnchors: true,
  exactAnchorChecks: true,
  lcmExpansion: true,
  followUpSearch: true,
  fusion: true
};

export const productionControllerAblations: ReadonlyArray<{
  id: string;
  changes: Readonly<Partial<ProductControllerConfig>>;
}> = [
  { id: "no-caller-hints", changes: { callerHints: false } },
  { id: "no-scripted-first-pass", changes: { scriptedFirstPass: false } },
  { id: "no-lexical-anchors", changes: { lexicalAnchors: false } },
  { id: "no-exact-anchor-checks", changes: { exactAnchorChecks: false } },
  { id: "no-lcm-expansion", changes: { lcmExpansion: false } },
  { id: "no-follow-up-search", changes: { followUpSearch: false } },
  { id: "no-fusion", changes: { fusion: false } },
  {
    id: "one-api-retrieval-call",
    changes: {
      scriptedFirstPass: false,
      followUpSearch: false,
      fusion: false,
      maxSearchCalls: 1
    }
  },
  {
    id: "rewrite-one-dense",
    changes: {
      scriptedFirstPass: false,
      exactAnchorChecks: false,
      lcmExpansion: false,
      followUpSearch: false,
      fusion: false,
      maxSearchCalls: 1,
      rewriteOnly: true
    }
  },
  {
    id: "qwen-0.6b-single-shot",
    changes: {
      scriptedFirstPass: false,
      exactAnchorChecks: false,
      lcmExpansion: false,
      followUpSearch: false,
      fusion: false,
      maxSearchCalls: 1,
      denseSingleShot: true
    }
  }
];

export const productControllerConfigurations = (): Array<{
  id: string;
  configuration: ProductControllerConfig;
}> => [
  {
    id: "koed-production",
    configuration: structuredClone(productionControllerConfiguration)
  },
  ...productionControllerAblations.map(({ id, changes }) => ({
    id,
    configuration: {
      ...productionControllerConfiguration,
      ...changes
    }
  }))
];

export const createProductArms = (provider: ProductArmProvider): ArenaArm[] => {
  const arm = (
    id: string,
    configuration: ProductControllerConfig
  ): ArenaArm => ({
    id,
    label:
      id === "koed-production"
        ? "Production Koed Memory Answer"
        : `Koed ablation: ${id}`,
    layer: "product",
    modelRoles: [
      "embedding",
      "productWorker",
      ...(configuration.rewriteOnly ? (["rewrite"] as const) : [])
    ],
    providerRequirement: "koed-product-harness",
    configuration: { ...configuration },
    run: (context) =>
      provider(
        {
          benchmarkCase: providerSafeCase(context.benchmarkCase),
          runIndex: context.runIndex,
          deadlineAt: context.deadlineAt
        },
        structuredClone(configuration)
      )
  });
  return productControllerConfigurations().map(({ id, configuration }) =>
    arm(id, configuration)
  );
};

export const createRetrievalArenaArms = (
  options: {
    embeddingProvider?: EmbeddingProvider;
    rewriteProvider?: QueryRewriteProvider;
    productProvider?: ProductArmProvider;
  } = {}
): ArenaArm[] => {
  const embedding = options.embeddingProvider;
  const retrievalArms: ArenaArm[] = embedding
    ? [
        createDenseArm(embedding),
        createRerankedArm(embedding),
        createHybridArm(embedding),
        options.rewriteProvider
          ? createRewriteDenseArm(embedding, options.rewriteProvider)
          : unavailableArm(
              "one-rewrite-one-search",
              "One local rewrite plus one Qwen search",
              "retrieval_only",
              `${embedding.id}:local-rewriter`
            )
      ]
    : [
        unavailableArm(
          "qwen-0.6b-dense",
          "Qwen3 Embedding 0.6B dense",
          "retrieval_only",
          "koed-embedding-service"
        ),
        unavailableArm(
          "qwen-0.6b-reranked",
          "Qwen3 Embedding 0.6B plus reranker",
          "retrieval_only",
          "koed-embedding-service:reranker"
        ),
        unavailableArm(
          "bm25-qwen-0.6b-hybrid",
          "BM25 plus Qwen3 0.6B fixed hybrid",
          "retrieval_only",
          "koed-embedding-service"
        ),
        unavailableArm(
          "one-rewrite-one-search",
          "One local rewrite plus one Qwen search",
          "retrieval_only",
          "koed-embedding-service:local-rewriter"
        )
      ];
  const productArms = options.productProvider
    ? createProductArms(options.productProvider)
    : productControllerConfigurations().map(({ id }) =>
        unavailableArm(id, id, "product", "koed-product-harness")
      );
  return [createBm25Arm(), ...retrievalArms, ...productArms];
};

export const timedArmRun = async (
  arm: ArenaArm,
  context: ArenaArmContext
): Promise<{
  output: RetrievalArmOutput | ProductArmOutput;
  wallTimeMs: number;
  peakRssBytes: number | null;
  peakMemory: ProductPeakMemoryTelemetry | null;
}> => {
  const started = performance.now();
  const productInventory =
    arm.layer === "product" ? resolveProductProcessInventory() : null;
  const productSampler = productInventory
    ? startProductPeakMemorySampler(productInventory)
    : null;
  let telemetryError: Error | undefined;
  let peakRssBytes = arm.layer === "product" ? null : process.memoryUsage().rss;
  const sampler = setInterval(() => {
    try {
      if (productSampler) productSampler.sample();
      else if (peakRssBytes !== null)
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    } catch (error) {
      telemetryError =
        error instanceof Error ? error : new Error(String(error));
    }
  }, 10);
  sampler.unref();
  try {
    const timeoutMs = Math.max(0, context.deadlineAt - Date.now());
    if (timeoutMs <= 0)
      throw new Error("Retrieval Arena case deadline exhausted");
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const output = await Promise.race([
      arm.run({ ...context, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`arm exceeded timeout budget of ${timeoutMs}ms`));
          controller.abort(
            new Error("Retrieval Arena case deadline exhausted")
          );
        }, timeoutMs);
        timeout.unref();
      })
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
      controller.abort();
    });
    if (telemetryError) throw telemetryError;
    const peakMemory = productSampler
      ? combineProductPeakMemoryTelemetry(
          productSampler.finish(),
          (output as ProductArmOutput).dynamicAiClientProcesses ?? []
        )
      : arm.layer === "product"
        ? (output as ProductArmOutput).dynamicAiClientProcesses?.length
          ? null
          : output.metrics?.peakMemory
            ? validateProductPeakMemoryTelemetry(output.metrics.peakMemory)
            : null
        : null;
    if (peakRssBytes !== null)
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    else peakRssBytes = peakMemory?.aggregatePeakRssBytes ?? null;
    return {
      output,
      wallTimeMs: Math.round(performance.now() - started),
      peakRssBytes,
      peakMemory
    };
  } catch (error) {
    let peakMemory: ProductPeakMemoryTelemetry | null = null;
    try {
      productSampler?.finish();
      peakMemory = null;
    } catch (telemetryFailure) {
      telemetryError ??=
        telemetryFailure instanceof Error
          ? telemetryFailure
          : new Error(String(telemetryFailure));
    }
    if (peakRssBytes !== null)
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    else peakRssBytes = null;
    const reportedError = telemetryError ?? error;
    if (reportedError && typeof reportedError === "object") {
      Object.assign(reportedError, {
        arenaArmTiming: {
          wallTimeMs: Math.round(performance.now() - started),
          peakRssBytes,
          peakMemory
        }
      });
    }
    throw reportedError;
  } finally {
    clearInterval(sampler);
  }
};
