import {
  answerWithMemoryWorker,
  resolveMemoryAnswerWorkerConfig,
  type MemoryAnswerRetrievalClient,
  type MemoryAnswerWorkerConfig
} from "@koed/mcp-server";
import {
  EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM,
  EMBEDDING_RETRIEVAL_QUERY_TRANSFORM,
  formatEmbeddingRetrievalDocument,
  formatEmbeddingRetrievalQuery,
  resolveSupportedEmbeddingModelConfig
} from "@koed/shared";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  ArenaModelCallMetrics,
  ArenaProviderCase,
  ProductArmOutput,
  RankedEvidence,
  ProductRunProof,
  ProductStateManifest
} from "./contracts.js";
import { productStateManifestSchema, stableHash } from "./contracts.js";
import {
  RETRIEVAL_ARENA_DATASET_VERSION,
  retrievalArenaCorpusIdentity,
  retrievalArenaDatasetHash
} from "./cases.js";
import {
  type EmbeddingProvider,
  type QueryRewriteProvider,
  type ProductArmProvider
} from "./arms.js";
import {
  attestLiveProductState,
  type LiveProductStateReader
} from "./live-product-fixture.js";

interface KoedRuntimeTarget {
  baseUrl: string;
  authorization: string;
}

type NoLexicalAnchorsRuntime = KoedRuntimeTarget & {
  indexManifestPath: string;
};

export const noAnchorComposition =
  "retrieval-arena-structured-summary-v2:summary_text+empty_lexical_anchors";
const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const structuredSummarySchema = z
  .object({
    schema_version: z.literal("lcm-semantic-summary-v1"),
    title: z.string().trim().min(1).max(120),
    summary_text: z.string().trim().min(1),
    lexical_anchors: z.tuple([])
  })
  .strict();
const noAnchorIndexManifestSchema = z
  .object({
    schemaVersion: z.literal("retrieval-arena-no-anchor-index-v1"),
    runtimeBaseUrl: z.string().url(),
    embedding: z
      .object({
        model: z.string().min(1),
        dimensions: z.number().int().positive(),
        artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
        tokenizer: z.string().min(1),
        tokenizerRevision: z.string().min(1),
        generation: z.string().min(1),
        composition: z.literal(noAnchorComposition)
      })
      .strict(),
    indexIdentity: z
      .object({
        databaseName: z.string().min(1),
        schemaName: z.string().min(1),
        documentSetSha256: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict(),
    documents: z
      .array(
        z
          .object({
            sourceId: z.string().min(1),
            embeddingId: z.string().uuid(),
            sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
            vectorSha256: z.string().regex(/^[a-f0-9]{64}$/),
            structuredSummary: structuredSummarySchema,
            embeddingInput: z.string().min(1),
            embeddingInputSha256: z.string().regex(/^[a-f0-9]{64}$/),
            embeddingGeneration: z.string().min(1)
          })
          .strict()
      )
      .min(1)
  })
  .strict();

export const noAnchorEmbeddingInput = (summary: {
  title: string;
  summary_text: string;
}): string => summary.summary_text;

export const noAnchorEmbeddingGeneration = (): string => {
  const canonical = resolveSupportedEmbeddingModelConfig("qwen3-0.6b");
  return [
    `model=${canonical.key}`,
    `artifact-sha256=${canonical.defaultArtifactSha256}`,
    `tokenizer=${canonical.tokenizer}`,
    `tokenizer-revision=${canonical.tokenizerRevision}`,
    `document-transform=${EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM}`,
    `pooling=${canonical.pooling}`,
    `normalization=${canonical.normalization}`
  ].join("|");
};

export const verifyNoLexicalAnchorsIndexManifest = async (
  path: string,
  runtimeBaseUrl: string
): Promise<{ proofHash: string; generation: string }> => {
  const raw = await readFile(path, "utf8");
  const manifest = noAnchorIndexManifestSchema.parse(JSON.parse(raw));
  if (
    manifest.runtimeBaseUrl.replace(/\/$/, "") !==
    runtimeBaseUrl.replace(/\/$/, "")
  ) {
    throw new Error(
      "no-lexical-anchors index manifest targets another runtime"
    );
  }
  const canonical = resolveSupportedEmbeddingModelConfig("qwen3-0.6b");
  const expectedGeneration = noAnchorEmbeddingGeneration();
  if (
    manifest.embedding.model !== canonical.key ||
    manifest.embedding.dimensions !== canonical.dimensions ||
    manifest.embedding.artifactHash !== canonical.defaultArtifactSha256 ||
    manifest.embedding.tokenizer !== canonical.tokenizer ||
    manifest.embedding.tokenizerRevision !== canonical.tokenizerRevision ||
    manifest.embedding.generation !== expectedGeneration
  ) {
    throw new Error(
      "no-lexical-anchors index manifest has an unverified embedding generation"
    );
  }
  for (const document of manifest.documents) {
    const expectedInput = noAnchorEmbeddingInput(document.structuredSummary);
    if (
      document.embeddingInput !== expectedInput ||
      document.embeddingInputSha256 !== sha256(expectedInput) ||
      document.embeddingGeneration !== expectedGeneration
    ) {
      throw new Error(
        `no-lexical-anchors index manifest contains a stale or anchor-influenced embedding for ${document.sourceId}`
      );
    }
  }
  const declaredRuntimeRows = manifest.documents
    .map((document) => ({
      sourceId: document.sourceId,
      embeddingId: document.embeddingId,
      sourceHash: document.sourceHash,
      embeddingInputSha256: document.embeddingInputSha256,
      vectorSha256: document.vectorSha256
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  if (
    sha256(JSON.stringify(declaredRuntimeRows)) !==
    manifest.indexIdentity.documentSetSha256
  ) {
    throw new Error(
      "no-lexical-anchors manifest document-set proof is not bound to its declared rows/vectors"
    );
  }
  return { proofHash: sha256(raw), generation: expectedGeneration };
};

export const assertNoLexicalAnchorsInRuntimeResult = (
  payload: Record<string, unknown>,
  expectedIndexProofHash?: string
): void => {
  const evidenceBundle = payload.evidenceBundle;
  const hits = Array.isArray(payload.hits) ? (payload.hits as unknown[]) : [];
  const evidence = Array.isArray(payload.evidence)
    ? (payload.evidence as unknown[])
    : [];
  const values = [
    ...hits,
    ...evidence,
    ...(evidenceBundle &&
    typeof evidenceBundle === "object" &&
    Array.isArray((evidenceBundle as Record<string, unknown>).evidence)
      ? ((evidenceBundle as Record<string, unknown>).evidence as unknown[])
      : [])
  ];
  if (
    values.some((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      const record = value as Record<string, unknown>;
      const anchors = record.lexicalAnchors ?? record.lexical_anchors;
      return Array.isArray(anchors) && anchors.length > 0;
    })
  ) {
    throw new Error(
      "no-lexical-anchors runtime returned a later search result containing lexical anchors"
    );
  }
  if (expectedIndexProofHash) {
    const retrieval =
      evidenceBundle && typeof evidenceBundle === "object"
        ? (evidenceBundle as Record<string, unknown>).retrieval
        : undefined;
    if (
      !retrieval ||
      typeof retrieval !== "object" ||
      (retrieval as Record<string, unknown>).indexProofHash !==
        expectedIndexProofHash
    ) {
      throw new Error(
        "no-lexical-anchors runtime result was not produced by the proven isolated index"
      );
    }
  }
};

interface KoedRuntimeProductOptions extends KoedRuntimeTarget {
  productStateManifestPath: string;
  liveStateReader?: LiveProductStateReader;
  worker?: Partial<MemoryAnswerWorkerConfig>;
  noLexicalAnchorsRuntime?: NoLexicalAnchorsRuntime;
  embeddingProvider?: EmbeddingProvider;
  rewriteProvider?: QueryRewriteProvider;
}

const loadProductStateProof = async (
  path: string,
  benchmarkCase: ArenaProviderCase,
  configuration: Record<string, unknown>
): Promise<{
  manifest: ProductStateManifest;
  manifestHash: string;
  proof: ProductRunProof;
}> => {
  const raw = await readFile(path, "utf8");
  const manifest = productStateManifestSchema.parse(JSON.parse(raw));
  if (
    manifest.datasetVersion !== RETRIEVAL_ARENA_DATASET_VERSION ||
    manifest.datasetHash !== retrievalArenaDatasetHash ||
    manifest.corpusIdentity !== retrievalArenaCorpusIdentity
  ) {
    throw new Error(
      "product-state manifest does not match the selected Arena dataset"
    );
  }
  const entry = manifest.cases.find(
    (value) => value.caseId === benchmarkCase.id
  );
  const caseCorpusHash = stableHash(benchmarkCase.corpus);
  if (
    !entry ||
    entry.corpusHash !== caseCorpusHash ||
    stableHash([...entry.itemIds].sort()) !==
      stableHash(benchmarkCase.corpus.map((item) => item.id).sort())
  ) {
    throw new Error(
      `product-state manifest does not bind case ${benchmarkCase.id} to its exact corpus`
    );
  }
  return {
    manifest,
    manifestHash: sha256(raw),
    proof: {
      kind: "live_product",
      manifestHash: sha256(raw),
      seed: manifest.seed,
      datasetHash: manifest.datasetHash,
      corpusIdentity: manifest.corpusIdentity,
      runtimeIdentity: manifest.runtimeIdentity,
      caseStateHash: entry.stateHash,
      caseCorpusHash,
      configurationHash: stableHash(configuration),
      observedConfigurationHash: ""
    }
  };
};

const assertLiveProductProof = (
  payload: Record<string, unknown>,
  expected: ProductRunProof
): ProductRunProof => {
  const retrieval = recordFromUnknown(
    recordFromUnknown(payload.evidenceBundle).retrieval
  );
  const observed = recordFromUnknown(retrieval.productStateProof);
  const observedConfigurationHash = retrieval.observedConfigurationHash;
  const expectedFields: Array<[keyof ProductRunProof, unknown]> = [
    ["kind", observed.kind],
    ["manifestHash", observed.manifestHash],
    ["seed", observed.seed],
    ["datasetHash", observed.datasetHash],
    ["corpusIdentity", observed.corpusIdentity],
    ["runtimeIdentity", observed.runtimeIdentity],
    ["caseStateHash", observed.caseStateHash],
    ["caseCorpusHash", observed.caseCorpusHash]
  ];
  const mismatch = expectedFields.find(
    ([key, value]) => value !== expected[key]
  );
  if (mismatch || observedConfigurationHash !== expected.configurationHash) {
    throw new Error(
      "live product response did not prove the seeded state and observed ablation configuration"
    );
  }
  return { ...expected, observedConfigurationHash };
};

interface AppServerExecutionLike {
  status?: "succeeded" | "failed";
  model?: string;
  tokenUsage?: {
    total?: { inputTokens?: number; outputTokens?: number };
  };
  attemptIndex?: number;
  processMetrics?: {
    pid: number;
    peakRssBytes: number;
    measurement: "proc_status_tree" | "ps_rss" | "powershell_working_set";
    sampleCount: number;
    samplingIntervalMs: number;
  };
}

const aggregateExecutionTokens = (
  executions: AppServerExecutionLike[] | undefined,
  fallback: { inputTokens?: number; outputTokens?: number } | undefined
): { inputTokens: number | null; outputTokens: number | null } => {
  if (!executions?.length) {
    return {
      inputTokens: fallback?.inputTokens ?? null,
      outputTokens: fallback?.outputTokens ?? null
    };
  }
  const sum = (key: "inputTokens" | "outputTokens"): number | null => {
    const values = executions.map(
      (execution) => execution.tokenUsage?.total?.[key]
    );
    return values.every((value): value is number => typeof value === "number")
      ? values.reduce((total, value) => total + value, 0)
      : null;
  };
  return { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens") };
};

const dynamicAiClientProcesses = (
  executions: AppServerExecutionLike[] | undefined,
  model: string
): import("./process-telemetry.js").DynamicAiClientProcessTelemetry[] => {
  if (!executions?.length) return [];
  return executions.map((execution, index) => {
    const metrics = execution.processMetrics;
    if (!metrics)
      throw new Error(
        "Memory Answer worker execution is missing dynamic child-process telemetry"
      );
    return {
      role: "ai_client_model" as const,
      component: execution.model || model,
      pid: metrics.pid,
      peakRssBytes: metrics.peakRssBytes,
      provenance: `memory-answer-app-server-attempt:${execution.attemptIndex ?? index + 1}`,
      measurement: metrics.measurement,
      attemptIndex: execution.attemptIndex ?? index + 1,
      sampleCount: metrics.sampleCount,
      samplingIntervalMs: metrics.samplingIntervalMs
    };
  });
};

const cosineSimilarity = (left: number[], right: number[]): number => {
  if (left.length !== right.length || left.length === 0) {
    throw new Error("embedding dimensions do not match");
  }
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

const denseInitialPayload = async (
  benchmarkCase: ArenaProviderCase,
  query: string,
  provider: EmbeddingProvider,
  deadlineAt: number,
  variant: "qwen_dense_single_shot" | "rewrite_one_dense"
): Promise<Record<string, unknown>> => {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Retrieval Arena case deadline exhausted");
  }
  const vectors = await provider.embed(
    [
      formatEmbeddingRetrievalQuery(query),
      ...benchmarkCase.corpus.map((item) =>
        formatEmbeddingRetrievalDocument(item.text)
      )
    ],
    { signal: AbortSignal.timeout(remainingMs) }
  );
  if (vectors.length !== benchmarkCase.corpus.length + 1) {
    throw new Error("embedding provider returned an unexpected vector count");
  }
  const queryVector = vectors[0]!;
  const ranked = benchmarkCase.corpus
    .map((item, index) => ({
      item,
      score: cosineSimilarity(queryVector, vectors[index + 1]!)
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.item.id.localeCompare(right.item.id)
    )
    .slice(0, benchmarkCase.budget.maxCandidates);
  return {
    markdown: "",
    evidenceBundle: {
      query: benchmarkCase.question,
      evidence: ranked.map(({ item, score }) => ({
        sourceType: item.sourceType,
        sourceId: item.id,
        sourceChunkIndex: item.sourceChunkIndex,
        summaryText: item.text,
        score
      })),
      retrieval: {
        mode: "retrieval_arena_dense_single_shot",
        provider: provider.id,
        model: provider.model,
        queryTransform:
          variant === "rewrite_one_dense" ? "one_rewrite" : "none",
        embeddingQueryTransform: EMBEDDING_RETRIEVAL_QUERY_TRANSFORM,
        embeddingDocumentTransform: EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM,
        dimensions: provider.dimensions,
        candidateCount: ranked.length
      }
    }
  };
};

const post = async (
  options: KoedRuntimeTarget,
  path: string,
  body: unknown,
  deadlineAt: number
): Promise<Record<string, unknown>> => {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0)
    throw new Error("Retrieval Arena case deadline exhausted");
  const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      authorization: options.authorization,
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(remainingMs)
  });
  if (!response.ok) {
    throw new Error(`Koed runtime ${path} returned HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
};

const attestNoLexicalAnchorsRuntime = async (
  options: NoLexicalAnchorsRuntime,
  deadlineAt: number
): Promise<string> => {
  const proof = await verifyNoLexicalAnchorsIndexManifest(
    options.indexManifestPath,
    options.baseUrl
  );
  const remainingMs = deadlineAt - Date.now();
  const response = await fetch(
    `${options.baseUrl.replace(/\/$/, "")}/v1/memory/retrieval-capabilities`,
    {
      headers: { authorization: options.authorization },
      signal: AbortSignal.timeout(Math.max(1, remainingMs))
    }
  );
  if (!response.ok) {
    throw new Error(
      `no-lexical-anchors capability attestation returned HTTP ${response.status}`
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const retrieval = payload.retrieval as Record<string, unknown> | undefined;
  if (
    payload.capabilitySchemaVersion !== 1 ||
    retrieval?.composition !== noAnchorComposition ||
    retrieval.lexicalAnchors !== false ||
    retrieval.indexProofHash !== proof.proofHash ||
    retrieval.embeddingGeneration !== proof.generation
  ) {
    throw new Error(
      "no-lexical-anchors runtime did not attest the required isolated composition"
    );
  }
  return proof.proofHash;
};

class RuntimeRetrievalClient implements MemoryAnswerRetrievalClient {
  constructor(
    private readonly options: KoedRuntimeTarget,
    private readonly deadlineAt: number,
    private readonly noAnchorIndexProofHash?: string
  ) {}

  async search(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const result = await post(
      this.options,
      "/v1/memory/answer",
      input,
      this.deadlineAt
    );
    if (this.noAnchorIndexProofHash)
      assertNoLexicalAnchorsInRuntimeResult(
        result,
        this.noAnchorIndexProofHash
      );
    return result;
  }

  expand(
    nodeId: string,
    input: {
      searchDomain?: string;
      sessionId?: string;
      projectId?: string;
      teamWorkspaceId?: string;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
    } = {}
  ): Promise<Record<string, unknown>> {
    return post(
      this.options,
      `/v1/memory/nodes/${encodeURIComponent(nodeId)}/expand`,
      {
        search_domain: input.searchDomain,
        session_id: input.sessionId,
        project_id: input.projectId,
        team_workspace_id: input.teamWorkspaceId,
        recent_days: input.recentDays,
        source_after: input.sourceAfter,
        source_before: input.sourceBefore
      },
      this.deadlineAt
    );
  }
}

const textFromUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["summaryText", "summary_text", "text", "content"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
};

const mapEvidence = (
  benchmarkCase: ArenaProviderCase,
  values: unknown[]
): RankedEvidence[] => {
  const selected = new Set<string>();
  const result: RankedEvidence[] = [];
  for (const value of values) {
    const text = textFromUnknown(value);
    const record =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const identifiers = [
      record.itemId,
      record.sourceId,
      record.source_id,
      record.nodeId
    ].filter((item): item is string => typeof item === "string");
    const identifierMatches = benchmarkCase.corpus.filter((item) =>
      identifiers.includes(item.id)
    );
    const textMatches = benchmarkCase.corpus.filter(
      (item) =>
        text.length > 0 &&
        (text === item.text ||
          text.includes(item.text) ||
          item.text.includes(text))
    );
    const matches =
      identifierMatches.length > 0 ? identifierMatches : textMatches;
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match || selected.has(match.id)) continue;
    selected.add(match.id);
    const score =
      typeof record.score === "number" && Number.isFinite(record.score)
        ? record.score
        : null;
    result.push({
      itemId: match.id,
      rank: result.length + 1,
      score,
      text: text || match.text,
      tokenCount: match.tokenCount,
      sourceType: match.sourceType,
      sourceChunkIndex: match.sourceChunkIndex
    });
  }
  return result;
};

const candidateIdentities = (
  payload: Record<string, unknown>
): unknown[] | null => {
  const evidenceBundle = payload.evidenceBundle;
  if (!evidenceBundle || typeof evidenceBundle !== "object") return null;
  const retrieval = (evidenceBundle as Record<string, unknown>).retrieval;
  if (!retrieval || typeof retrieval !== "object") return null;
  const trace = (retrieval as Record<string, unknown>).trace;
  if (!trace || typeof trace !== "object") return null;
  const identities = (trace as Record<string, unknown>).candidateIdentities;
  return Array.isArray(identities) ? identities : null;
};

const completeCandidatePool = (
  benchmarkCase: ArenaProviderCase,
  payload: Record<string, unknown>,
  reportedCount: number | undefined
): RankedEvidence[] | null => {
  const identities = candidateIdentities(payload);
  if (!identities) return null;
  const mapped = mapEvidence(benchmarkCase, identities);
  if (mapped.length !== identities.length) return null;
  if (reportedCount !== undefined && mapped.length !== reportedCount)
    return null;
  return mapped;
};

export const runtimeRetrievalMeasurements = (
  payload: Record<string, unknown>
): {
  databaseReads: number | null;
  hydrationCount: number | null;
  hydrationBytes: number | null;
  decryptCount: number | null;
  decryptBytes: number | null;
  embeddingCalls: number | null;
  embeddingTokens: number | null;
  internalVectorStages: number | null;
} => {
  const bundle = recordFromUnknown(payload.evidenceBundle);
  const retrieval = recordFromUnknown(bundle.retrieval);
  const entries = Array.isArray(retrieval.retrievals)
    ? retrieval.retrievals.map(recordFromUnknown)
    : [];
  const measuredEntries = entries.filter(
    (entry) =>
      [
        "databaseReads",
        "hydrationCount",
        "hydrationBytes",
        "decryptCount",
        "decryptBytes",
        "embeddingCalls",
        "embeddingTokens"
      ].some((key) => key in entry) || Array.isArray(entry.stages)
  );
  const sum = (key: string): number | null => {
    const values = measuredEntries.map((entry) => entry[key]);
    return values.length > 0 &&
      values.every(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value)
      )
      ? values.reduce((total, value) => total + value, 0)
      : null;
  };
  const stageCounts = measuredEntries.map((entry) =>
    Array.isArray(entry.stages)
      ? entry.stages.filter((stage) => recordFromUnknown(stage).ran === true)
          .length
      : null
  );
  return {
    databaseReads: sum("databaseReads"),
    hydrationCount: sum("hydrationCount"),
    hydrationBytes: sum("hydrationBytes"),
    decryptCount: sum("decryptCount"),
    decryptBytes: sum("decryptBytes"),
    embeddingCalls: sum("embeddingCalls"),
    embeddingTokens: sum("embeddingTokens"),
    internalVectorStages:
      stageCounts.length > 0 &&
      stageCounts.every((value): value is number => value !== null)
        ? stageCounts.reduce((total, value) => total + value, 0)
        : null
  };
};

const recordFromUnknown = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const createKoedRuntimeProductProvider =
  (options: KoedRuntimeProductOptions): ProductArmProvider =>
  async (
    { benchmarkCase, deadlineAt },
    configuration
  ): Promise<ProductArmOutput> => {
    const {
      manifest: productStateManifest,
      manifestHash,
      proof: declaredProductProof
    } = await loadProductStateProof(
      options.productStateManifestPath,
      benchmarkCase,
      { ...configuration }
    );
    const expectedProductProof = options.liveStateReader
      ? await attestLiveProductState({
          manifest: productStateManifest,
          manifestHash,
          caseId: benchmarkCase.id,
          baseUrl: options.baseUrl,
          configurationHash: declaredProductProof.configurationHash,
          reader: options.liveStateReader
        })
      : declaredProductProof;
    const runtime: KoedRuntimeTarget = configuration.lexicalAnchors
      ? options
      : (options.noLexicalAnchorsRuntime ??
        (() => {
          throw new Error(
            "no-lexical-anchors requires an isolated runtime whose valid structured summaries were indexed with empty lexical anchor lists"
          );
        })());
    const noAnchorIndexProofHash = !configuration.lexicalAnchors
      ? await attestNoLexicalAnchorsRuntime(
          runtime as NoLexicalAnchorsRuntime,
          deadlineAt
        )
      : undefined;
    if (
      (configuration.denseSingleShot || configuration.rewriteOnly) &&
      !options.embeddingProvider
    ) {
      throw new Error(
        "dense product ablations require the configured Retrieval Arena embedding provider"
      );
    }
    const canonicalQwen = resolveSupportedEmbeddingModelConfig("qwen3-0.6b");
    if (
      (configuration.denseSingleShot || configuration.rewriteOnly) &&
      (options.embeddingProvider?.model !== canonicalQwen.key ||
        options.embeddingProvider.dimensions !== canonicalQwen.dimensions)
    ) {
      throw new Error(
        `Qwen dense product ablations require service-verified ${canonicalQwen.key} model and ${canonicalQwen.dimensions} dimensions`
      );
    }
    let retrievalQuery = benchmarkCase.question;
    let rewriteMetrics: Awaited<ReturnType<QueryRewriteProvider>> | undefined;
    if (configuration.rewriteOnly) {
      if (!options.rewriteProvider) {
        throw new Error(
          "rewrite-one-dense requires the configured Retrieval Arena rewrite provider"
        );
      }
      rewriteMetrics = await options.rewriteProvider(benchmarkCase.question, {
        deadlineAt
      });
      retrievalQuery = rewriteMetrics.query;
    }
    const {
      retrievalScope,
      searchDomain,
      projectId,
      sessionId,
      teamWorkspaceId
    } = benchmarkCase.productContext;
    const directDense =
      configuration.rewriteOnly || configuration.denseSingleShot;
    const directOneSearch = configuration.maxSearchCalls === 1 && !directDense;
    const initial = directDense
      ? await denseInitialPayload(
          benchmarkCase,
          retrievalQuery,
          options.embeddingProvider!,
          deadlineAt,
          configuration.rewriteOnly
            ? "rewrite_one_dense"
            : "qwen_dense_single_shot"
        )
      : directOneSearch
        ? await post(
            runtime,
            "/v1/memory/answer",
            {
              query: retrievalQuery,
              retrieval_scope: retrievalScope,
              search_domain: searchDomain,
              ...(projectId ? { project_id: projectId } : {}),
              ...(sessionId ? { session_id: sessionId } : {}),
              ...(teamWorkspaceId
                ? { team_workspace_id: teamWorkspaceId }
                : {}),
              strict_limit: true,
              limit: benchmarkCase.budget.maxCandidates
            },
            deadlineAt
          )
        : {
            markdown: "",
            evidenceBundle: {
              query: benchmarkCase.question,
              evidence: [],
              retrieval: { mode: "app_server_dynamic_tools" }
            }
          };
    if (!configuration.lexicalAnchors)
      assertNoLexicalAnchorsInRuntimeResult(
        initial,
        directOneSearch ? noAnchorIndexProofHash : undefined
      );
    const initialEvidenceBundle =
      initial.evidenceBundle && typeof initial.evidenceBundle === "object"
        ? (initial.evidenceBundle as Record<string, unknown>)
        : undefined;
    if (initialEvidenceBundle) {
      const initialRetrieval =
        initialEvidenceBundle.retrieval &&
        typeof initialEvidenceBundle.retrieval === "object"
          ? (initialEvidenceBundle.retrieval as Record<string, unknown>)
          : {};
      initial.evidenceBundle = {
        ...initialEvidenceBundle,
        query: benchmarkCase.question,
        retrieval: {
          ...initialRetrieval,
          ...(!configuration.lexicalAnchors
            ? {
                evaluationComposition: noAnchorComposition,
                indexProofHash: noAnchorIndexProofHash
              }
            : {})
        }
      };
    }
    const base = resolveMemoryAnswerWorkerConfig();
    const config: MemoryAnswerWorkerConfig = {
      ...base,
      ...options.worker,
      maxSearches: Math.min(
        configuration.maxSearchCalls ?? benchmarkCase.budget.maxSearchCalls,
        benchmarkCase.budget.maxSearchCalls
      ),
      maxExpansions: configuration.lcmExpansion
        ? benchmarkCase.budget.maxExpansions
        : 0,
      maxCandidates: benchmarkCase.budget.maxCandidates,
      maxEvidenceItems: benchmarkCase.budget.maxEvidenceItems,
      maxEvidenceTokens: benchmarkCase.budget.maxEvidenceTokens,
      timeoutMs: Math.min(
        options.worker?.timeoutMs ?? base.timeoutMs,
        Math.max(1, deadlineAt - Date.now())
      )
    };
    const readerStarted = performance.now();
    let answer: Awaited<ReturnType<typeof answerWithMemoryWorker>>;
    try {
      answer = await answerWithMemoryWorker(initial, {
        config,
        client: new RuntimeRetrievalClient(
          runtime,
          deadlineAt,
          noAnchorIndexProofHash
        ),
        retrievalScope,
        searchDomain,
        projectId,
        sessionId,
        teamWorkspaceId,
        limit: benchmarkCase.budget.maxCandidates,
        responseDetail: "internal",
        captureProcessMetrics: true,
        retrievalHints: configuration.callerHints
          ? benchmarkCase.retrievalHints
          : undefined,
        evaluationController: {
          scriptedFirstPass:
            configuration.scriptedFirstPass &&
            !directOneSearch &&
            !configuration.rewriteOnly &&
            !configuration.denseSingleShot,
          exactAnchorChecks: configuration.exactAnchorChecks,
          lcmExpansion:
            configuration.lcmExpansion &&
            !configuration.rewriteOnly &&
            !configuration.denseSingleShot,
          followUpSearch:
            configuration.followUpSearch &&
            !directOneSearch &&
            !configuration.rewriteOnly &&
            !configuration.denseSingleShot,
          fusion:
            configuration.fusion &&
            !configuration.rewriteOnly &&
            !configuration.denseSingleShot,
          retrievalVariant: !configuration.lexicalAnchors
            ? "empty_lexical_anchors"
            : configuration.rewriteOnly
              ? "rewrite_one_dense"
              : configuration.denseSingleShot
                ? "qwen_dense_single_shot"
                : "production"
        }
      });
    } catch (error) {
      const executions =
        error &&
        typeof error === "object" &&
        Array.isArray(
          (error as { appServerExecutions?: unknown }).appServerExecutions
        )
          ? (error as { appServerExecutions: AppServerExecutionLike[] })
              .appServerExecutions
          : undefined;
      const usage = aggregateExecutionTokens(executions, undefined);
      const readerMetrics: ArenaModelCallMetrics = {
        model: executions?.at(-1)?.model ?? config.model,
        latencyMs: Math.round(performance.now() - readerStarted),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: null,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      };
      if (error && typeof error === "object") {
        Object.assign(error, { arenaReaderMetrics: readerMetrics });
      }
      throw error;
    }
    const payload = answer as Record<string, unknown>;
    const finalProductProof = options.liveStateReader
      ? await attestLiveProductState({
          manifest: productStateManifest,
          manifestHash,
          caseId: benchmarkCase.id,
          baseUrl: options.baseUrl,
          configurationHash: declaredProductProof.configurationHash,
          reader: options.liveStateReader
        })
      : expectedProductProof;
    if (options.liveStateReader) {
      const evidenceBundle = recordFromUnknown(payload.evidenceBundle);
      payload.evidenceBundle = {
        ...evidenceBundle,
        retrieval: {
          ...recordFromUnknown(evidenceBundle.retrieval),
          productStateProof: {
            kind: finalProductProof.kind,
            manifestHash: finalProductProof.manifestHash,
            seed: finalProductProof.seed,
            datasetHash: finalProductProof.datasetHash,
            corpusIdentity: finalProductProof.corpusIdentity,
            runtimeIdentity: finalProductProof.runtimeIdentity,
            caseStateHash: finalProductProof.caseStateHash,
            caseCorpusHash: finalProductProof.caseCorpusHash
          },
          observedConfigurationHash: finalProductProof.observedConfigurationHash
        }
      };
    }
    const productProof = assertLiveProductProof(payload, finalProductProof);
    const evidenceValues = Array.isArray(payload.evidence)
      ? payload.evidence
      : [];
    const evidence = mapEvidence(benchmarkCase, evidenceValues);
    const reportedCandidateCount = answer.localMemoryWorker.candidateCount;
    const candidates = completeCandidatePool(
      benchmarkCase,
      payload,
      reportedCandidateCount
    );
    const totalUsage = answer.localMemoryWorker.tokenUsage?.total;
    const aggregateUsage = aggregateExecutionTokens(
      answer.localMemoryWorker.appServerExecutions,
      totalUsage
    );
    const dynamicProcesses = dynamicAiClientProcesses(
      answer.localMemoryWorker.appServerExecutions,
      answer.localMemoryWorker.model ?? config.model
    );
    const retrievalMeasurements = runtimeRetrievalMeasurements(payload);
    const readerMetrics: ArenaModelCallMetrics = {
      model: answer.localMemoryWorker.model ?? config.model,
      latencyMs: Math.round(performance.now() - readerStarted),
      inputTokens: aggregateUsage.inputTokens,
      outputTokens: aggregateUsage.outputTokens,
      costUsd: null,
      status: "completed"
    };
    return {
      answer: answer.markdown ?? "No answer returned by the Koed worker.",
      status: answer.localMemoryWorker.memoryStatus ?? "insufficient",
      evidence,
      candidates,
      readerMetrics,
      productProof,
      dynamicAiClientProcesses: dynamicProcesses,
      ...(rewriteMetrics ? { rewrittenQuery: rewriteMetrics.query } : {}),
      model: answer.localMemoryWorker.model ?? config.model,
      provider: "koed-runtime-memory-answer",
      metrics: {
        apiRetrievalCalls:
          (directDense ? 1 : directOneSearch ? 1 : 0) +
          (answer.localMemoryWorker.searchCount ?? 0),
        searchCalls:
          (directDense ? 1 : directOneSearch ? 1 : 0) +
          (answer.localMemoryWorker.searchCount ?? 0),
        ...retrievalMeasurements,
        expansions: answer.localMemoryWorker.expandCount ?? 0,
        candidateCount: reportedCandidateCount ?? null,
        inputTokens: aggregateUsage.inputTokens,
        outputTokens: aggregateUsage.outputTokens,
        rewriteInputTokens: rewriteMetrics?.inputTokens ?? null,
        rewriteOutputTokens: rewriteMetrics?.outputTokens ?? null
      },
      trace: {
        harness: "koed-runtime-memory-answer-v1",
        retrievalScope,
        searchDomain,
        workerPromptVersion: answer.localMemoryWorker.promptVersion,
        workerUsedFallback: answer.localMemoryWorker.usedFallback,
        workerSkippedReason: answer.localMemoryWorker.skippedReason ?? null,
        workerError: answer.localMemoryWorker.errorMessage ?? null,
        retrievalVariant: !configuration.lexicalAnchors
          ? "empty_lexical_anchors"
          : configuration.rewriteOnly
            ? "rewrite_one_dense"
            : configuration.denseSingleShot
              ? "qwen_dense_single_shot"
              : "production",
        rewriteModel: rewriteMetrics?.model
      }
    };
  };
