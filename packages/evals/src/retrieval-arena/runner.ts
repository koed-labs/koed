import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import { loadPrompt } from "@koed/mcp-server";
import { z } from "zod";
import type {
  ArenaArm,
  ArenaCostBasis,
  ArenaLayer,
  ArenaModelCallMetrics,
  ArenaResourceMetrics,
  ArenaRunResult,
  RankedEvidence,
  ProductArmOutput,
  ReproducibilityMetadata,
  RetrievalArmOutput
} from "./contracts.js";
import {
  RETRIEVAL_ARENA_SCHEMA_VERSION,
  arenaCostBasisSchema,
  arenaLayerSchema,
  arenaSplitSchema,
  stableHash
} from "./contracts.js";
import {
  RETRIEVAL_ARENA_DATASET_VERSION,
  retrievalArenaCases,
  retrievalArenaCorpus,
  retrievalArenaCorpusIdentity,
  retrievalArenaDatasetHash
} from "./cases.js";
import {
  ProviderUnavailableError,
  createRetrievalArenaArms,
  timedArmRun,
  type EmbeddingProvider,
  type ProductArmProvider,
  type QueryRewriteProvider
} from "./arms.js";
import { deterministicAnswerChecks, scoreRetrieval } from "./metrics.js";
import {
  judgeAnswer,
  retrievalArenaPromptTemplateContents,
  runFixedReader,
  type ArenaAppServerConfig,
  type ArenaPromptRunner
} from "./judge.js";

export interface RetrievalArenaRunOptions {
  arms?: ArenaArm[];
  embeddingProvider?: EmbeddingProvider;
  rewriteProvider?: QueryRewriteProvider;
  productProvider?: ProductArmProvider;
  readerConfig?: ArenaAppServerConfig;
  judgeConfig?: ArenaAppServerConfig;
  promptRunner?: ArenaPromptRunner;
  layers?: ArenaLayer[];
  splits?: Array<"development" | "validation" | "held_out">;
  caseIds?: string[];
  armIds?: string[];
  runs?: number;
  strictProviders?: boolean;
  runNumber?: number;
  costPerMillionInputTokensUsd?: number;
  costPerMillionOutputTokensUsd?: number;
  modelPricing?: Partial<
    Record<
      "reader" | "judge" | "rewrite" | "product",
      { input?: number; output?: number }
    >
  >;
  modelMetadata?: ReproducibilityMetadata["models"];
}

export interface ArenaLeaderboardEntry {
  armId: string;
  /** Number of case/run observations, not the variance sample count. */
  completedRuns: number;
  skippedRuns: number;
  failedRuns: number;
  meanNdcg: number | null;
  meanEvidenceGroupRecall: number | null;
  meanSemanticScore: number | null;
  meanCorrectness: number | null;
  meanCostUsd: number | null;
  meanWallTimeMs: number | null;
  /** Cases shared by every repeated-run sample used for dispersion. */
  repeatedRunCaseCount: number;
  /** Per-run means over repeatedRunCaseCount paired cases. */
  repeatedRunSampleCount: number;
  varianceSampleUnit: "paired_case_mean_per_run";
  standardDeviationNdcg: number | null;
  confidence95Ndcg: [number, number] | null;
  versusBm25: { wins: number; losses: number; ties: number } | null;
}

export interface PairedEstimate {
  pairedObservations: number;
  meanDifference: number | null;
  confidence95: [number, number] | null;
}

export interface ProductAblationComparison {
  productionArmId: "koed-production";
  ablationArmId: string;
  quality: PairedEstimate;
  correctness: PairedEstimate;
  costUsd: PairedEstimate;
  latencyMs: PairedEstimate;
}

export interface RetrievalArenaReport {
  benchmark: "retrieval-arena";
  metadata: ReproducibilityMetadata;
  results: ArenaRunResult[];
  leaderboards: Record<ArenaLayer, ArenaLeaderboardEntry[]>;
  productComparisons: ProductAblationComparison[];
}

const nullableNonnegativeNumber = z.number().finite().nonnegative().nullable();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const rankedEvidenceSchema = z
  .object({
    itemId: z.string().min(1),
    rank: z.number().int().positive(),
    score: z.number().finite().nullable(),
    text: z.string(),
    tokenCount: z.number().int().nonnegative(),
    sourceType: z.enum(["memory_event", "memory_node", "curated_memory"]),
    sourceChunkIndex: z.number().int().nonnegative()
  })
  .strict();
const modelCallSchema = z
  .object({
    model: z.string().min(1),
    latencyMs: z.number().finite().nonnegative(),
    inputTokens: nullableNonnegativeNumber,
    outputTokens: nullableNonnegativeNumber,
    costUsd: nullableNonnegativeNumber,
    costBasis: arenaCostBasisSchema,
    status: z.enum(["completed", "failed"]),
    error: z.string().optional()
  })
  .strict();
const rerankerCallSchema = z
  .object({
    model: z.string().nullable(),
    artifact: z.string().nullable(),
    artifactRevision: z.string().nullable(),
    artifactHash: z.string().nullable(),
    latencyMs: nullableNonnegativeNumber,
    calls: z.number().int().nonnegative(),
    inputTokens: nullableNonnegativeNumber,
    costUsd: nullableNonnegativeNumber,
    costBasis: arenaCostBasisSchema
  })
  .strict();
const peakMemorySchema = z
  .object({
    schemaVersion: z.literal("koed-retrieval-arena-peak-memory-v2"),
    aggregation: z.literal("stable_concurrent_plus_max_dynamic_child"),
    aggregatePeakRssBytes: z.number().int().positive(),
    stableAggregatePeakRssBytes: z.number().int().positive(),
    dynamicAiClientPeakRssBytes: z.number().int().positive(),
    components: z
      .array(
        z
          .object({
            role: z.enum([
              "api",
              "database",
              "embedding_service",
              "ai_client_model"
            ]),
            component: z.string().min(1),
            pid: z.number().int().positive(),
            peakRssBytes: z.number().int().positive(),
            provenance: z.string().min(1),
            measurement: z.enum([
              "proc_status_tree",
              "ps_rss",
              "powershell_working_set"
            ]),
            attemptIndex: z.number().int().positive().optional(),
            sampleCount: z.number().int().positive().optional(),
            samplingIntervalMs: z.number().int().positive().optional()
          })
          .strict()
      )
      .min(1)
  })
  .strict();
const resourceMetricsSchema = z
  .object({
    wallTimeMs: z.number().finite().nonnegative(),
    peakRssBytes: nullableNonnegativeNumber,
    peakMemory: peakMemorySchema.nullable().optional(),
    databaseReads: nullableNonnegativeNumber,
    hydrationCount: nullableNonnegativeNumber,
    hydrationBytes: nullableNonnegativeNumber,
    decryptCount: nullableNonnegativeNumber,
    decryptBytes: nullableNonnegativeNumber,
    embeddingCalls: nullableNonnegativeNumber,
    embeddingTokens: nullableNonnegativeNumber,
    rerankerCalls: nullableNonnegativeNumber,
    rerankerLatencyMs: nullableNonnegativeNumber,
    rerankerInputTokens: nullableNonnegativeNumber,
    rerankerCostUsd: nullableNonnegativeNumber,
    internalVectorStages: nullableNonnegativeNumber,
    apiRetrievalCalls: nullableNonnegativeNumber,
    searchCalls: nullableNonnegativeNumber,
    expansions: nullableNonnegativeNumber,
    candidateCount: nullableNonnegativeNumber,
    evidenceTokens: nullableNonnegativeNumber,
    inputTokens: nullableNonnegativeNumber,
    outputTokens: nullableNonnegativeNumber,
    rewriteInputTokens: nullableNonnegativeNumber,
    rewriteOutputTokens: nullableNonnegativeNumber,
    rewriteCostUsd: nullableNonnegativeNumber,
    costUsd: nullableNonnegativeNumber,
    costBasis: arenaCostBasisSchema
  })
  .strict();
const productProofSchema = z
  .object({
    kind: z.literal("live_product"),
    manifestHash: sha256Schema,
    seed: z.string().min(1),
    datasetHash: sha256Schema,
    corpusIdentity: sha256Schema,
    runtimeIdentity: z.string().min(1),
    caseStateHash: sha256Schema,
    caseCorpusHash: sha256Schema,
    configurationHash: sha256Schema,
    observedConfigurationHash: sha256Schema
  })
  .strict();
const pairedEstimateSchema = z
  .object({
    pairedObservations: z.number().int().nonnegative(),
    meanDifference: z.number().finite().nullable(),
    confidence95: z.tuple([z.number().finite(), z.number().finite()]).nullable()
  })
  .strict();
const leaderboardEntrySchema = z
  .object({
    armId: z.string().min(1),
    completedRuns: z.number().int().nonnegative(),
    skippedRuns: z.number().int().nonnegative(),
    failedRuns: z.number().int().nonnegative(),
    meanNdcg: z.number().finite().nullable(),
    meanEvidenceGroupRecall: z.number().finite().nullable(),
    meanSemanticScore: z.number().finite().nullable(),
    meanCorrectness: z.number().finite().nullable(),
    meanCostUsd: nullableNonnegativeNumber,
    meanWallTimeMs: nullableNonnegativeNumber,
    repeatedRunCaseCount: z.number().int().nonnegative(),
    repeatedRunSampleCount: z.number().int().nonnegative(),
    varianceSampleUnit: z.literal("paired_case_mean_per_run"),
    standardDeviationNdcg: nullableNonnegativeNumber,
    confidence95Ndcg: z
      .tuple([z.number().finite(), z.number().finite()])
      .nullable(),
    versusBm25: z
      .object({
        wins: z.number().int().nonnegative(),
        losses: z.number().int().nonnegative(),
        ties: z.number().int().nonnegative()
      })
      .strict()
      .nullable()
  })
  .strict();
const modelDescriptorSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    artifact: z.string().nullable(),
    artifactRevision: z.string().nullable(),
    artifactHash: z.string().nullable(),
    dimensions: z.number().int().positive().nullable(),
    tokenizer: z.string().nullable(),
    tokenizerRevision: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
    inputPricePerMillionTokensUsd: nullableNonnegativeNumber,
    outputPricePerMillionTokensUsd: nullableNonnegativeNumber,
    acceleration: z.string().nullable()
  })
  .strict();
const runResultSchema = z
  .object({
    caseId: z.string().min(1),
    split: arenaSplitSchema,
    layer: arenaLayerSchema,
    armId: z.string().min(1),
    runIndex: z.number().int().nonnegative(),
    status: z.enum(["completed", "skipped", "failed"]),
    skipReason: z.string().optional(),
    error: z.string().optional(),
    evidence: z.array(rankedEvidenceSchema).optional(),
    answer: z.string().optional(),
    answerStatus: z
      .enum(["found", "not_found", "insufficient", "pending_summary"])
      .optional(),
    deterministicChecks: z.record(z.string(), z.boolean()).optional(),
    semanticJudgment: z
      .object({
        status: z.enum(["judged", "error"]),
        passed: z.boolean(),
        score: z.number().finite().optional(),
        dimensions: z.record(z.string(), z.number().finite()).optional(),
        rationale: z.string().optional(),
        error: z.string().optional(),
        model: z.string().nullable().optional(),
        latencyMs: z.number().finite().nonnegative(),
        inputTokens: nullableNonnegativeNumber,
        outputTokens: nullableNonnegativeNumber
      })
      .strict()
      .optional(),
    retrievalMetrics: z
      .record(z.string(), z.number().finite().nullable())
      .optional(),
    resources: resourceMetricsSchema.optional(),
    answerResources: z
      .object({
        reader: modelCallSchema.optional(),
        judge: modelCallSchema.optional()
      })
      .strict()
      .optional(),
    rerankerResources: rerankerCallSchema.optional(),
    productProof: productProofSchema.optional(),
    qualityObservation: z
      .object({
        quality: z.number().finite(),
        correctness: z.number().finite(),
        costUsd: nullableNonnegativeNumber,
        latencyMs: z.number().finite().nonnegative()
      })
      .strict()
      .optional(),
    aggregateCost: z
      .object({
        retrievalAndSynthesisUsd: nullableNonnegativeNumber,
        readerUsd: nullableNonnegativeNumber,
        judgeUsd: nullableNonnegativeNumber,
        rerankerUsd: nullableNonnegativeNumber,
        totalUsd: nullableNonnegativeNumber,
        complete: z.boolean(),
        billingBasis: z
          .object({
            retrievalAndSynthesis: arenaCostBasisSchema,
            reader: arenaCostBasisSchema,
            judge: arenaCostBasisSchema,
            reranker: arenaCostBasisSchema,
            total: arenaCostBasisSchema
          })
          .strict()
      })
      .strict()
      .optional(),
    trace: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const retrievalArenaReportSchema = z
  .object({
    benchmark: z.literal("retrieval-arena"),
    metadata: z
      .object({
        schemaVersion: z.literal(RETRIEVAL_ARENA_SCHEMA_VERSION),
        generatedAt: z.iso.datetime(),
        koedCommit: z.string().min(1),
        workingTreeDirty: z.boolean(),
        trackedDiffHash: sha256Schema,
        untrackedSourceHash: sha256Schema,
        effectiveSourceTreeHash: sha256Schema,
        datasetVersion: z.string().min(1),
        datasetHash: sha256Schema,
        corpusIdentity: sha256Schema,
        selectedCorpusIdentity: sha256Schema,
        deterministicSeed: z
          .object({
            value: sha256Schema,
            derivation: z.literal("sha256_dataset_selection_configuration_run"),
            controls: z.tuple([
              z.literal("case_arm_order"),
              z.literal("run_index_assignment")
            ]),
            doesNotControl: z.tuple([
              z.literal("external_provider_sampling"),
              z.literal("live_service_state")
            ])
          })
          .strict(),
        datasetProvenance: z
          .object({ kind: z.literal("hand_authored"), generator: z.null() })
          .strict(),
        runNumber: z.number().int().positive(),
        nodeVersion: z.string().min(1),
        platform: z.string().min(1),
        architecture: z.string().min(1),
        cpu: z.string().min(1),
        totalMemoryBytes: z.number().int().positive(),
        acceleration: z.string().nullable(),
        models: z.record(z.string(), modelDescriptorSchema),
        prompts: z.record(z.string(), sha256Schema),
        retrievalConfiguration: z.record(z.string(), z.unknown()),
        productState: z
          .object({
            manifestHash: sha256Schema,
            seed: z.string().min(1),
            corpusIdentity: sha256Schema,
            runtimeIdentity: z.string().min(1)
          })
          .strict()
          .nullable(),
        costAccounting: z
          .object({
            currency: z.literal("USD"),
            apiEquivalentEstimate: z.literal("configured_token_prices"),
            providerReported: z.literal("provider_supplied_amount"),
            localNoCost: z.literal("local_execution_without_usage_charge"),
            unavailable: z.literal("applicable_but_not_measurable"),
            notApplicable: z.literal("component_not_used")
          })
          .strict()
      })
      .strict(),
    results: z.array(runResultSchema),
    leaderboards: z
      .object({
        retrieval_only: z.array(leaderboardEntrySchema),
        fixed_reader: z.array(leaderboardEntrySchema),
        product: z.array(leaderboardEntrySchema)
      })
      .strict(),
    productComparisons: z.array(
      z
        .object({
          productionArmId: z.literal("koed-production"),
          ablationArmId: z.string().min(1),
          quality: pairedEstimateSchema,
          correctness: pairedEstimateSchema,
          costUsd: pairedEstimateSchema,
          latencyMs: pairedEstimateSchema
        })
        .strict()
    )
  })
  .strict();

export const parseRetrievalArenaReport = (
  value: unknown
): RetrievalArenaReport =>
  retrievalArenaReportSchema.parse(value) as RetrievalArenaReport;

export const qualityLatencyMs = (
  layer: ArenaLayer,
  result: Pick<ArenaRunResult, "resources" | "answerResources">
): number =>
  (result.resources?.wallTimeMs ?? 0) +
  (layer === "product" ? 0 : (result.answerResources?.reader?.latencyMs ?? 0)) +
  (result.answerResources?.judge?.latencyMs ?? 0);

const mean = (values: number[]): number | null =>
  values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const promptHash = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

export const observedModelMatchesDescriptor = (
  descriptor: ReproducibilityMetadata["models"][string] | undefined,
  observedModel: string
): boolean => {
  if (!descriptor) return false;
  if (descriptor.model === observedModel) return true;
  if (
    descriptor.provider !== "codex-app-server" &&
    descriptor.provider !== "koed-runtime-memory-answer"
  ) {
    return false;
  }
  return (
    observedModel ===
    `codex-app-server:${descriptor.model}:${descriptor.reasoningEffort}`
  );
};

const deviation = (values: number[]): number | null => {
  if (values.length < 2) return null;
  const average = mean(values)!;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1)
  );
};

const critical95 = (sampleCount: number): number => {
  const byDegreesOfFreedom = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08,
    2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042
  ];
  return byDegreesOfFreedom[sampleCount - 2] ?? 1.96;
};

const estimate = (differences: number[]): PairedEstimate => {
  const average = mean(differences);
  const stddev = deviation(differences);
  const margin =
    average === null || stddev === null
      ? null
      : (critical95(differences.length) * stddev) /
        Math.sqrt(differences.length);
  return {
    pairedObservations: differences.length,
    meanDifference: average,
    confidence95:
      average === null || margin === null
        ? null
        : [average - margin, average + margin]
  };
};

const aggregateRunCost = (
  result: ArenaRunResult,
  layer: ArenaLayer
): NonNullable<ArenaRunResult["aggregateCost"]> => {
  const readerUsd = result.answerResources?.reader?.costUsd ?? null;
  const reportedRetrievalAndSynthesisUsd =
    result.resources?.costUsd ?? (layer === "product" ? readerUsd : null);
  const judgeUsd = result.answerResources?.judge?.costUsd ?? null;
  const rerankerUsd = result.rerankerResources?.costUsd ?? null;
  const retrievalAndSynthesis =
    result.resources?.costUsd !== null &&
    result.resources?.costUsd !== undefined
      ? result.resources.costBasis
      : layer === "product"
        ? (result.answerResources?.reader?.costBasis ?? "unavailable")
        : (result.resources?.costBasis ?? "unavailable");
  const retrievalAndSynthesisUsd =
    reportedRetrievalAndSynthesisUsd ??
    (retrievalAndSynthesis === "local_no_cost" ? 0 : null);
  const reader = result.answerResources?.reader
    ? (result.answerResources.reader.costBasis ?? "unavailable")
    : "not_applicable";
  const judge = result.answerResources?.judge
    ? (result.answerResources.judge.costBasis ?? "unavailable")
    : "not_applicable";
  const reranker = result.rerankerResources
    ? (result.rerankerResources.costBasis ?? "unavailable")
    : "not_applicable";
  const required = [retrievalAndSynthesisUsd];
  const requiredBases: ArenaCostBasis[] = [retrievalAndSynthesis];
  if (layer === "fixed_reader") {
    required.push(readerUsd, judgeUsd);
    requiredBases.push(reader, judge);
  }
  if (layer === "product") {
    required.push(judgeUsd);
    requiredBases.push(judge);
  }
  if (result.rerankerResources) {
    required.push(rerankerUsd);
    requiredBases.push(reranker);
  }
  const complete = required.every((value) => value !== null);
  const totalUsd = complete
    ? required.reduce<number>((sum, value) => sum + value!, 0)
    : null;
  return {
    retrievalAndSynthesisUsd,
    readerUsd,
    judgeUsd,
    rerankerUsd,
    totalUsd,
    complete,
    billingBasis: {
      retrievalAndSynthesis,
      reader,
      judge,
      reranker,
      total: !complete
        ? "unavailable"
        : requiredBases.includes("api_equivalent_estimate")
          ? "api_equivalent_estimate"
          : requiredBases.includes("provider_reported")
            ? "provider_reported"
            : "local_no_cost"
    }
  };
};

const pairedProductComparisons = (
  results: ArenaRunResult[]
): ProductAblationComparison[] => {
  const product = results.filter(
    (result) => result.layer === "product" && result.qualityObservation
  );
  const production = new Map(
    product
      .filter((result) => result.armId === "koed-production")
      .map((result) => [`${result.caseId}:${result.runIndex}`, result])
  );
  return [...new Set(product.map((result) => result.armId))]
    .filter((armId) => armId !== "koed-production")
    .map((ablationArmId) => {
      const pairs = product
        .filter((result) => result.armId === ablationArmId)
        .flatMap((ablation) => {
          const baseline = production.get(
            `${ablation.caseId}:${ablation.runIndex}`
          );
          return baseline ? [{ baseline, ablation }] : [];
        });
      const differences = (
        key: "quality" | "correctness" | "costUsd" | "latencyMs"
      ): number[] =>
        pairs.flatMap(({ baseline, ablation }) => {
          const left = baseline.qualityObservation![key];
          const right = ablation.qualityObservation![key];
          return left === null || right === null ? [] : [left - right];
        });
      return {
        productionArmId: "koed-production",
        ablationArmId,
        quality: estimate(differences("quality")),
        correctness: estimate(differences("correctness")),
        costUsd: estimate(differences("costUsd")),
        latencyMs: estimate(differences("latencyMs"))
      };
    });
};

const gitCommit = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim();
  } catch {
    return "unknown";
  }
};

const sha256 = (parts: Array<string | Buffer>): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
};

export const sourceReproducibility = (
  workingDirectory = process.cwd()
): Pick<
  ReproducibilityMetadata,
  | "workingTreeDirty"
  | "trackedDiffHash"
  | "untrackedSourceHash"
  | "effectiveSourceTreeHash"
> => {
  try {
    const repositoryRoot = execFileSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: workingDirectory, encoding: "utf8" }
    ).trim();
    const trackedDiff = execFileSync(
      "git",
      ["diff", "--binary", "--no-ext-diff", "HEAD", "--"],
      {
        cwd: repositoryRoot,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024
      }
    );
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: repositoryRoot, encoding: "buffer" }
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .filter((path) =>
        /(?:^|\/)(?:apps|packages|prompts|scripts|docs)\/|(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json)$/.test(
          path
        )
      )
      .sort();
    const untrackedParts: Array<string | Buffer> = [];
    for (const path of untracked) {
      untrackedParts.push(
        `${path}\0`,
        readFileSync(resolve(repositoryRoot, path)),
        "\0"
      );
    }
    const trackedDiffHash = sha256([trackedDiff]);
    const untrackedSourceHash = sha256(untrackedParts);
    return {
      workingTreeDirty: trackedDiff.length > 0 || untracked.length > 0,
      trackedDiffHash,
      untrackedSourceHash,
      effectiveSourceTreeHash: sha256([
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repositoryRoot,
          encoding: "utf8"
        }).trim(),
        "\0",
        trackedDiffHash,
        "\0",
        untrackedSourceHash
      ])
    };
  } catch {
    const unknownHash = sha256(["unknown"]);
    return {
      workingTreeDirty: true,
      trackedDiffHash: unknownHash,
      untrackedSourceHash: unknownHash,
      effectiveSourceTreeHash: unknownHash
    };
  }
};

const resources = (
  output: RetrievalArmOutput,
  wallTimeMs: number,
  peakRssBytes: number | null,
  peakMemory: ArenaResourceMetrics["peakMemory"],
  tokenRates: { input?: number; output?: number },
  rewriteRates: { input?: number; output?: number } = {},
  unpricedBasis: Extract<
    ArenaCostBasis,
    "local_no_cost" | "unavailable"
  > = "local_no_cost"
): ArenaResourceMetrics => {
  const rewriteInputTokens = output.metrics?.rewriteInputTokens ?? null;
  const rewriteOutputTokens = output.metrics?.rewriteOutputTokens ?? null;
  const inputTokens = output.metrics?.inputTokens ?? null;
  const outputTokens = output.metrics?.outputTokens ?? null;
  const rewriteCostUsd = callCost(
    rewriteInputTokens,
    rewriteOutputTokens,
    rewriteRates
  );
  const pricedCost = callCost(inputTokens, outputTokens, tokenRates);
  const providerCost = output.metrics?.costUsd;
  const costUsd = providerCost ?? pricedCost;
  const hasEstimatedCost = pricedCost !== null || rewriteCostUsd !== null;
  const costBasis: ArenaCostBasis =
    providerCost !== undefined && providerCost !== null
      ? "provider_reported"
      : hasEstimatedCost
        ? "api_equivalent_estimate"
        : unpricedBasis;
  return {
    wallTimeMs,
    peakRssBytes,
    peakMemory,
    databaseReads: output.metrics?.databaseReads ?? null,
    hydrationCount: output.metrics?.hydrationCount ?? null,
    hydrationBytes: output.metrics?.hydrationBytes ?? null,
    decryptCount: output.metrics?.decryptCount ?? null,
    decryptBytes: output.metrics?.decryptBytes ?? null,
    embeddingCalls: output.metrics?.embeddingCalls ?? null,
    embeddingTokens: output.metrics?.embeddingTokens ?? null,
    rerankerCalls:
      output.rerankerMetrics?.calls ?? output.metrics?.rerankerCalls ?? null,
    rerankerLatencyMs:
      output.rerankerMetrics?.latencyMs ??
      output.metrics?.rerankerLatencyMs ??
      null,
    rerankerInputTokens:
      output.rerankerMetrics?.inputTokens ??
      output.metrics?.rerankerInputTokens ??
      null,
    rerankerCostUsd:
      output.rerankerMetrics?.costUsd ??
      output.metrics?.rerankerCostUsd ??
      null,
    internalVectorStages: output.metrics?.internalVectorStages ?? null,
    apiRetrievalCalls:
      output.metrics?.apiRetrievalCalls ?? output.metrics?.searchCalls ?? null,
    searchCalls:
      output.metrics?.apiRetrievalCalls ?? output.metrics?.searchCalls ?? null,
    expansions: output.metrics?.expansions ?? null,
    candidateCount:
      output.metrics?.candidateCount ??
      (output.candidates === null
        ? null
        : (output.candidates?.length ?? output.evidence.length)),
    evidenceTokens: output.evidence.reduce(
      (sum, item) => sum + item.tokenCount,
      0
    ),
    inputTokens,
    outputTokens,
    rewriteInputTokens,
    rewriteOutputTokens,
    rewriteCostUsd,
    costUsd:
      costUsd === null && rewriteCostUsd === null
        ? null
        : (costUsd ?? 0) + (rewriteCostUsd ?? 0),
    costBasis
  };
};

function callCost(
  inputTokens: number | null,
  outputTokens: number | null,
  rates: { input?: number; output?: number }
): number | null {
  return inputTokens === null && outputTokens === null
    ? null
    : (inputTokens !== null && rates.input === undefined) ||
        (outputTokens !== null && rates.output === undefined)
      ? null
      : ((inputTokens ?? 0) * (rates.input ?? 0) +
          (outputTokens ?? 0) * (rates.output ?? 0)) /
        1_000_000;
}

const pricedModelCall = (
  metrics: ArenaModelCallMetrics,
  rates: { input?: number; output?: number }
): ArenaModelCallMetrics => {
  const estimated = callCost(metrics.inputTokens, metrics.outputTokens, rates);
  return {
    ...metrics,
    costUsd: metrics.costUsd ?? estimated,
    costBasis:
      metrics.costUsd !== null
        ? "provider_reported"
        : estimated !== null
          ? "api_equivalent_estimate"
          : "unavailable"
  };
};

const remainingConfig = (
  config: ArenaAppServerConfig,
  deadlineAt: number
): ArenaAppServerConfig => {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0)
    throw new Error("Retrieval Arena case deadline exhausted");
  return { ...config, timeoutMs: Math.min(config.timeoutMs, remainingMs) };
};

const failedResources = (error: unknown): ArenaResourceMetrics | undefined => {
  if (!error || typeof error !== "object" || !("arenaArmTiming" in error))
    return undefined;
  const timing = (
    error as {
      arenaArmTiming?: {
        wallTimeMs?: unknown;
        peakRssBytes?: unknown;
        peakMemory?: unknown;
      };
    }
  ).arenaArmTiming;
  if (
    typeof timing?.wallTimeMs !== "number" ||
    (typeof timing.peakRssBytes !== "number" && timing.peakRssBytes !== null)
  )
    return undefined;
  return {
    wallTimeMs: timing.wallTimeMs,
    peakRssBytes: timing.peakRssBytes,
    peakMemory:
      timing.peakMemory && typeof timing.peakMemory === "object"
        ? (timing.peakMemory as ArenaResourceMetrics["peakMemory"])
        : null,
    databaseReads: null,
    hydrationCount: null,
    hydrationBytes: null,
    decryptCount: null,
    decryptBytes: null,
    embeddingCalls: null,
    embeddingTokens: null,
    rerankerCalls: null,
    rerankerLatencyMs: null,
    rerankerInputTokens: null,
    rerankerCostUsd: null,
    internalVectorStages: null,
    apiRetrievalCalls: null,
    searchCalls: null,
    expansions: null,
    candidateCount: null,
    evidenceTokens: null,
    inputTokens: null,
    outputTokens: null,
    rewriteInputTokens: null,
    rewriteOutputTokens: null,
    rewriteCostUsd: null,
    costUsd: null,
    costBasis: "unavailable"
  };
};

const enforceOutputBudgets = (
  benchmarkCase: (typeof retrievalArenaCases)[number],
  output: RetrievalArmOutput
): RetrievalArmOutput => {
  const { budget } = benchmarkCase;
  const isProductOutput = "answer" in output;
  if (
    isProductOutput &&
    (output.metrics?.searchCalls === undefined ||
      output.metrics.expansions === undefined)
  ) {
    throw new Error(
      "product arm must report searchCalls and expansions for budget enforcement"
    );
  }
  if ((output.metrics?.searchCalls ?? 0) > budget.maxSearchCalls) {
    throw new Error("arm exceeded search-call budget");
  }
  if ((output.metrics?.expansions ?? 0) > budget.maxExpansions) {
    throw new Error("arm exceeded expansion budget");
  }
  const dedupe = (items: RankedEvidence[]): RankedEvidence[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.sourceType}:${item.itemId}:${item.sourceChunkIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const candidates =
    output.candidates === null
      ? null
      : dedupe(output.candidates ?? output.evidence)
          .slice(0, budget.maxCandidates)
          .map((item, index) => ({ ...item, rank: index + 1 }));
  const candidateKeys = candidates
    ? new Set(
        candidates.map(
          (item) => `${item.sourceType}:${item.itemId}:${item.sourceChunkIndex}`
        )
      )
    : null;
  const evidence: RankedEvidence[] = [];
  let evidenceTokens = 0;
  for (const item of dedupe(output.evidence)) {
    const key = `${item.sourceType}:${item.itemId}:${item.sourceChunkIndex}`;
    if (candidateKeys && !candidateKeys.has(key)) continue;
    if (evidence.length >= budget.maxEvidenceItems) break;
    if (evidenceTokens + item.tokenCount > budget.maxEvidenceTokens) continue;
    evidenceTokens += item.tokenCount;
    evidence.push({ ...item, rank: evidence.length + 1 });
  }
  return {
    ...output,
    candidates,
    evidence,
    metrics: {
      ...output.metrics,
      candidateCount:
        output.metrics?.candidateCount ??
        (candidates ? candidates.length : null),
      evidenceTokens
    }
  };
};

const missingJudgeResult = (
  benchmarkCase: (typeof retrievalArenaCases)[number],
  arm: ArenaArm,
  layer: ArenaLayer,
  runIndex: number,
  strict: boolean
): ArenaRunResult => ({
  caseId: benchmarkCase.id,
  split: benchmarkCase.split,
  layer,
  armId: arm.id,
  runIndex,
  status: strict ? "failed" : "skipped",
  ...(strict
    ? {
        error:
          "fixed-reader and product answer quality require a semantic judge provider"
      }
    : { skipReason: "semantic judge provider not configured" })
});

const summarizeLayer = (
  layer: ArenaLayer,
  results: ArenaRunResult[]
): ArenaLeaderboardEntry[] => {
  const layerResults = results.filter((result) => result.layer === layer);
  const armIds = [...new Set(layerResults.map((result) => result.armId))];
  const bm25ByCaseRun = new Map(
    layerResults
      .filter(
        (result) => result.armId === "bm25" && result.status === "completed"
      )
      .map((result) => [
        `${result.caseId}:${result.runIndex}`,
        result.retrievalMetrics?.ndcg ?? 0
      ])
  );
  return armIds
    .map((armId) => {
      const armResults = layerResults.filter(
        (result) => result.armId === armId
      );
      const completed = armResults.filter(
        (result) => result.status === "completed"
      );
      const ndcg = completed.flatMap((result) =>
        result.retrievalMetrics?.ndcg == null
          ? []
          : [result.retrievalMetrics.ndcg]
      );
      const answerObservations = armResults.flatMap((result) =>
        result.qualityObservation ? [result.qualityObservation] : []
      );
      const completedByRun = new Map<number, Map<string, number>>();
      for (const result of completed) {
        const value = result.retrievalMetrics?.ndcg;
        if (value == null) continue;
        const byCase =
          completedByRun.get(result.runIndex) ?? new Map<string, number>();
        byCase.set(result.caseId, value);
        completedByRun.set(result.runIndex, byCase);
      }
      const pairedCases = [...completedByRun.values()].reduce<Set<string>>(
        (shared, byCase) =>
          new Set([...shared].filter((caseId) => byCase.has(caseId))),
        new Set(completedByRun.values().next().value?.keys() ?? [])
      );
      const repeatedRunSamples = [...completedByRun.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([, byCase]) => {
          const values = [...pairedCases].map((caseId) => byCase.get(caseId)!);
          const sample = mean(values);
          return sample === null ? [] : [sample];
        });
      const stddev = deviation(repeatedRunSamples);
      const average = mean(ndcg);
      const repeatedRunAverage = mean(repeatedRunSamples);
      const margin =
        stddev === null || repeatedRunAverage === null
          ? null
          : (critical95(repeatedRunSamples.length) * stddev) /
            Math.sqrt(repeatedRunSamples.length);
      const comparisons = completed.flatMap((result) => {
        const baseline = bm25ByCaseRun.get(
          `${result.caseId}:${result.runIndex}`
        );
        const value = result.retrievalMetrics?.ndcg;
        return baseline === undefined || value == null
          ? []
          : [Math.sign(value - baseline)];
      });
      return {
        armId,
        completedRuns: completed.length,
        skippedRuns: armResults.filter((result) => result.status === "skipped")
          .length,
        failedRuns: armResults.filter((result) => result.status === "failed")
          .length,
        meanNdcg: average,
        meanEvidenceGroupRecall: mean(
          completed.flatMap((result) =>
            result.retrievalMetrics?.requiredEvidenceGroupRecall == null
              ? []
              : [result.retrievalMetrics.requiredEvidenceGroupRecall]
          )
        ),
        meanSemanticScore: mean(
          answerObservations.map((value) => value.quality)
        ),
        meanCorrectness: mean(
          answerObservations.map((value) => value.correctness)
        ),
        meanCostUsd: mean(
          armResults.flatMap((result) =>
            result.aggregateCost?.totalUsd == null
              ? []
              : [result.aggregateCost.totalUsd]
          )
        ),
        meanWallTimeMs: mean(
          completed.map((result) => result.resources?.wallTimeMs ?? 0)
        ),
        repeatedRunCaseCount: pairedCases.size,
        repeatedRunSampleCount: repeatedRunSamples.length,
        varianceSampleUnit: "paired_case_mean_per_run" as const,
        standardDeviationNdcg: stddev,
        confidence95Ndcg:
          repeatedRunAverage === null || margin === null
            ? null
            : ([
                Math.max(0, repeatedRunAverage - margin),
                Math.min(1, repeatedRunAverage + margin)
              ] as [number, number]),
        versusBm25:
          armId === "bm25" || comparisons.length === 0
            ? null
            : {
                wins: comparisons.filter((value) => value > 0).length,
                losses: comparisons.filter((value) => value < 0).length,
                ties: comparisons.filter((value) => value === 0).length
              }
      };
    })
    .sort(
      (left, right) =>
        (right.meanSemanticScore ?? right.meanNdcg ?? -1) -
          (left.meanSemanticScore ?? left.meanNdcg ?? -1) ||
        left.armId.localeCompare(right.armId)
    );
};

export const runRetrievalArena = async (
  options: RetrievalArenaRunOptions = {}
): Promise<RetrievalArenaReport> => {
  const layers = options.layers ?? ["retrieval_only"];
  const selectedCases = retrievalArenaCases.filter(
    (benchmarkCase) =>
      (!options.splits || options.splits.includes(benchmarkCase.split)) &&
      (!options.caseIds || options.caseIds.includes(benchmarkCase.id))
  );
  if (selectedCases.length === 0)
    throw new Error("no Retrieval Arena cases selected");
  const allArms =
    options.arms ??
    createRetrievalArenaArms({
      embeddingProvider: options.embeddingProvider,
      rewriteProvider: options.rewriteProvider,
      productProvider: options.productProvider
    });
  const arms = allArms.filter(
    (arm) => !options.armIds || options.armIds.includes(arm.id)
  );
  if (arms.length === 0) throw new Error("no Retrieval Arena arms selected");
  const results: ArenaRunResult[] = [];
  const runs = options.runs ?? 1;
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("Retrieval Arena runs must be a positive integer");
  }
  if (layers.includes("product") && runs < 3) {
    throw new Error(
      "product Retrieval Arena arms require at least 3 repeated runs for paired-case variance"
    );
  }
  const pricing = (role: "reader" | "judge" | "rewrite" | "product") => ({
    input:
      options.modelPricing?.[role]?.input ??
      options.costPerMillionInputTokensUsd,
    output:
      options.modelPricing?.[role]?.output ??
      options.costPerMillionOutputTokensUsd
  });

  for (const layer of layers) {
    const layerArms = arms.filter((arm) =>
      layer === "product"
        ? arm.layer === "product"
        : arm.layer === "retrieval_only"
    );
    for (const benchmarkCase of selectedCases) {
      for (const arm of layerArms) {
        for (let runIndex = 0; runIndex < runs; runIndex += 1) {
          const deadlineAt = Date.now() + benchmarkCase.budget.timeoutMs;
          let partialResult: ArenaRunResult | undefined;
          if (
            (layer === "fixed_reader" || layer === "product") &&
            !options.judgeConfig
          ) {
            results.push(
              missingJudgeResult(
                benchmarkCase,
                arm,
                layer,
                runIndex,
                options.strictProviders ?? false
              )
            );
            continue;
          }
          if (layer === "fixed_reader" && !options.readerConfig) {
            results.push({
              ...missingJudgeResult(
                benchmarkCase,
                arm,
                layer,
                runIndex,
                options.strictProviders ?? false
              ),
              skipReason: options.strictProviders
                ? undefined
                : "fixed reader provider not configured",
              error: options.strictProviders
                ? "fixed reader provider not configured"
                : undefined
            });
            continue;
          }
          try {
            const timed = await timedArmRun(arm, {
              benchmarkCase:
                arm.layer === "product"
                  ? benchmarkCase
                  : { ...benchmarkCase, corpus: retrievalArenaCorpus },
              runIndex,
              deadlineAt
            });
            const output = enforceOutputBudgets(benchmarkCase, timed.output);
            const base: ArenaRunResult = {
              caseId: benchmarkCase.id,
              split: benchmarkCase.split,
              layer,
              armId: arm.id,
              runIndex,
              status: "completed",
              evidence: output.evidence,
              retrievalMetrics: scoreRetrieval(
                benchmarkCase,
                output.evidence,
                output.candidates
              ),
              resources: resources(
                output,
                timed.wallTimeMs,
                timed.peakRssBytes,
                timed.peakMemory,
                arm.id === "one-rewrite-one-search"
                  ? pricing("rewrite")
                  : layer === "product"
                    ? pricing("product")
                    : {},
                pricing("rewrite"),
                layer === "product" || arm.modelRoles?.includes("rewrite")
                  ? "unavailable"
                  : "local_no_cost"
              ),
              trace: output.trace
            };
            if (output.rerankerMetrics) {
              base.rerankerResources = {
                ...output.rerankerMetrics,
                costUsd: output.rerankerMetrics.costUsd ?? 0,
                costBasis:
                  output.rerankerMetrics.costUsd === null
                    ? "local_no_cost"
                    : "provider_reported"
              };
            }
            if (layer === "retrieval_only") {
              base.aggregateCost = aggregateRunCost(base, layer);
            }
            if (
              layer === "product" &&
              base.resources?.peakMemory == null &&
              !options.strictProviders
            ) {
              throw new ProviderUnavailableError(
                "complete API, database, Embedding Service, and AI-client/model process telemetry"
              );
            }
            if (options.strictProviders) {
              const requiredResourceFields: Array<keyof ArenaResourceMetrics> =
                [
                  "wallTimeMs",
                  "peakRssBytes",
                  "apiRetrievalCalls",
                  "candidateCount",
                  "evidenceTokens"
                ];
              if (arm.modelRoles?.includes("embedding")) {
                requiredResourceFields.push(
                  "embeddingCalls",
                  "embeddingTokens"
                );
              }
              if (arm.modelRoles?.includes("reranker")) {
                requiredResourceFields.push(
                  "rerankerCalls",
                  "rerankerLatencyMs",
                  "rerankerInputTokens",
                  "rerankerCostUsd"
                );
              }
              if (arm.modelRoles?.includes("rewrite")) {
                requiredResourceFields.push(
                  "rewriteInputTokens",
                  "rewriteOutputTokens",
                  "rewriteCostUsd",
                  "costUsd"
                );
              }
              if (layer === "product") {
                requiredResourceFields.push(
                  "peakMemory",
                  "databaseReads",
                  "hydrationCount",
                  "hydrationBytes",
                  "decryptCount",
                  "decryptBytes",
                  "internalVectorStages",
                  "costUsd"
                );
              }
              const missing = requiredResourceFields.filter(
                (field) => base.resources?.[field] == null
              );
              if (missing.length > 0) {
                throw new Error(
                  `strict required arm cannot measure ${missing.join(", ")}`
                );
              }
            }
            partialResult = base;
            const readerRates =
              layer === "product" ? pricing("product") : pricing("reader");
            const judgeRates = pricing("judge");
            if (layer === "fixed_reader") {
              const readerStarted = performance.now();
              let reader: Awaited<ReturnType<typeof runFixedReader>>;
              try {
                reader = await runFixedReader(benchmarkCase, output.evidence, {
                  config: remainingConfig(options.readerConfig!, deadlineAt),
                  runner: options.promptRunner
                });
              } catch (error) {
                const observation =
                  error &&
                  typeof error === "object" &&
                  "arenaModelCallObservation" in error
                    ? (
                        error as {
                          arenaModelCallObservation?: {
                            model: string;
                            latencyMs: number;
                            inputTokens: number | null;
                            outputTokens: number | null;
                          };
                        }
                      ).arenaModelCallObservation
                    : undefined;
                base.answerResources = {
                  reader: pricedModelCall(
                    {
                      model: observation?.model ?? options.readerConfig!.model,
                      latencyMs:
                        observation?.latencyMs ??
                        Math.round(performance.now() - readerStarted),
                      inputTokens: observation?.inputTokens ?? null,
                      outputTokens: observation?.outputTokens ?? null,
                      costUsd: null,
                      status: "failed",
                      error:
                        error instanceof Error ? error.message : String(error)
                    },
                    readerRates
                  )
                };
                throw error;
              }
              base.answer = reader.answer;
              base.answerResources = {
                reader: pricedModelCall(
                  {
                    model: reader.model,
                    latencyMs: reader.latencyMs,
                    inputTokens: reader.inputTokens,
                    outputTokens: reader.outputTokens,
                    costUsd: null,
                    status: "completed"
                  },
                  readerRates
                )
              };
              base.answerStatus = reader.status;
              base.deterministicChecks = deterministicAnswerChecks(
                benchmarkCase,
                reader.answer,
                reader.status
              );
              try {
                base.semanticJudgment = await judgeAnswer(
                  {
                    benchmarkCase,
                    evidence: output.evidence,
                    answer: reader.answer,
                    status: reader.status
                  },
                  {
                    config: remainingConfig(options.judgeConfig!, deadlineAt),
                    runner: options.promptRunner
                  }
                );
              } catch (error) {
                base.semanticJudgment = {
                  status: "error",
                  passed: false,
                  error: error instanceof Error ? error.message : String(error),
                  latencyMs: 0,
                  inputTokens: null,
                  outputTokens: null,
                  model: options.judgeConfig!.model
                };
              }
              const judgment = base.semanticJudgment;
              base.answerResources.judge = pricedModelCall(
                {
                  model: judgment.model ?? options.judgeConfig!.model,
                  latencyMs: judgment.latencyMs,
                  inputTokens: judgment.inputTokens,
                  outputTokens: judgment.outputTokens,
                  costUsd: null,
                  status: judgment.status === "error" ? "failed" : "completed",
                  ...(judgment.error ? { error: judgment.error } : {})
                },
                judgeRates
              );
            } else if (layer === "product") {
              const product = output as ProductArmOutput;
              if (!product.productProof) {
                throw new Error(
                  "product reports require live seeded product-state and behavior proof metadata"
                );
              }
              if (
                product.productProof.configurationHash !==
                  product.productProof.observedConfigurationHash ||
                product.productProof.configurationHash !==
                  createHash("sha256")
                    .update(JSON.stringify(arm.configuration))
                    .digest("hex")
              ) {
                throw new Error(
                  "product behavior proof does not match the selected arm configuration"
                );
              }
              base.productProof = product.productProof;
              base.answer = product.answer;
              base.answerStatus = product.status;
              base.deterministicChecks = deterministicAnswerChecks(
                benchmarkCase,
                product.answer,
                product.status
              );
              base.answerResources = {
                reader: pricedModelCall(product.readerMetrics, readerRates)
              };
              try {
                base.semanticJudgment = await judgeAnswer(
                  {
                    benchmarkCase,
                    evidence: output.evidence,
                    answer: product.answer,
                    status: product.status
                  },
                  {
                    config: remainingConfig(options.judgeConfig!, deadlineAt),
                    runner: options.promptRunner
                  }
                );
              } catch (error) {
                base.semanticJudgment = {
                  status: "error",
                  passed: false,
                  error: error instanceof Error ? error.message : String(error),
                  latencyMs: 0,
                  inputTokens: null,
                  outputTokens: null,
                  model: options.judgeConfig!.model
                };
              }
              const judgment = base.semanticJudgment;
              base.answerResources.judge = pricedModelCall(
                {
                  model: judgment.model ?? options.judgeConfig!.model,
                  latencyMs: judgment.latencyMs,
                  inputTokens: judgment.inputTokens,
                  outputTokens: judgment.outputTokens,
                  costUsd: null,
                  status: judgment.status === "error" ? "failed" : "completed",
                  ...(judgment.error ? { error: judgment.error } : {})
                },
                judgeRates
              );
            }
            if (layer !== "retrieval_only") {
              const deterministicPassed = Object.values(
                base.deterministicChecks ?? {}
              ).every(Boolean);
              if (
                !deterministicPassed ||
                base.semanticJudgment?.passed !== true
              ) {
                base.status = "failed";
                base.error = !deterministicPassed
                  ? "mandatory deterministic answer or safety check failed"
                  : base.semanticJudgment?.status === "error"
                    ? `semantic judge error: ${base.semanticJudgment.error ?? "unknown error"}`
                    : "mandatory semantic judgment failed";
              }
              base.aggregateCost = aggregateRunCost(base, layer);
              base.qualityObservation = {
                quality:
                  deterministicPassed && base.semanticJudgment?.passed === true
                    ? (base.semanticJudgment.score ?? 0)
                    : 0,
                correctness:
                  deterministicPassed && base.semanticJudgment?.passed === true
                    ? 1
                    : 0,
                costUsd: base.aggregateCost.totalUsd,
                latencyMs: qualityLatencyMs(layer, base)
              };
            }
            results.push(base);
          } catch (error) {
            const unavailable = error instanceof ProviderUnavailableError;
            const failedReader =
              error &&
              typeof error === "object" &&
              "arenaReaderMetrics" in error
                ? (error as { arenaReaderMetrics?: ArenaModelCallMetrics })
                    .arenaReaderMetrics
                : undefined;
            results.push({
              ...(partialResult ?? {
                caseId: benchmarkCase.id,
                split: benchmarkCase.split,
                layer,
                armId: arm.id,
                runIndex
              }),
              status:
                unavailable && !options.strictProviders ? "skipped" : "failed",
              resources: partialResult?.resources ?? failedResources(error),
              answerResources:
                partialResult?.answerResources ??
                (failedReader
                  ? {
                      reader: pricedModelCall(failedReader, {
                        ...(layer === "product"
                          ? pricing("product")
                          : pricing("reader"))
                      })
                    }
                  : undefined),
              ...(unavailable && !options.strictProviders
                ? { skipReason: error.message }
                : {
                    error:
                      error instanceof Error ? error.message : String(error)
                  })
            });
          }
        }
      }
    }
  }

  const cpus = os.cpus();
  const promptTemplates = retrievalArenaPromptTemplateContents();
  const memoryAnswerBase = loadPrompt("ai-client-memory-answer-base", {
    env: process.env
  });
  const memoryAnswerDeveloper = loadPrompt(
    "ai-client-memory-answer-developer",
    { env: process.env }
  );
  const memoryAnswerWorker = loadPrompt("memory-answer-worker", {
    env: process.env
  });
  const metadata: ReproducibilityMetadata = {
    schemaVersion: RETRIEVAL_ARENA_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    koedCommit: gitCommit(),
    ...sourceReproducibility(),
    datasetVersion: RETRIEVAL_ARENA_DATASET_VERSION,
    datasetHash: retrievalArenaDatasetHash,
    corpusIdentity: retrievalArenaCorpusIdentity,
    selectedCorpusIdentity: stableHash(
      selectedCases.map(({ id, corpus }) => ({ id, corpus }))
    ),
    deterministicSeed: {
      value: stableHash({
        datasetHash: retrievalArenaDatasetHash,
        selectedCaseIds: selectedCases.map(({ id }) => id),
        layers,
        arms: arms.map(({ id, configuration }) => ({ id, configuration })),
        runs,
        runNumber: options.runNumber ?? 1
      }),
      derivation: "sha256_dataset_selection_configuration_run",
      controls: ["case_arm_order", "run_index_assignment"],
      doesNotControl: ["external_provider_sampling", "live_service_state"]
    },
    datasetProvenance: { kind: "hand_authored", generator: null },
    runNumber: options.runNumber ?? 1,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpu: cpus[0]?.model ?? "unknown",
    totalMemoryBytes: os.totalmem(),
    acceleration: process.env.KOED_EVAL_ACCELERATION?.trim() || null,
    models: {},
    prompts: {
      fixedReaderSha256: promptHash(promptTemplates.fixedReader),
      semanticJudgeSha256: promptHash(promptTemplates.semanticJudge),
      queryRewriteSha256: promptHash(promptTemplates.queryRewrite),
      memoryAnswerWorkerSha256: promptHash(memoryAnswerWorker.body),
      memoryAnswerAppServerBaseSha256: promptHash(memoryAnswerBase.body),
      memoryAnswerAppServerDeveloperSha256: promptHash(
        memoryAnswerDeveloper.body
      )
    },
    retrievalConfiguration: {
      sampleSemantics: {
        requestedRunsPerCase: runs,
        varianceSampleUnit: "paired_case_mean_per_run",
        confidenceInterval: "student-t-95pct-over-repeated-run-means",
        productMinimumRepeatedRuns: 3
      },
      arms: Object.fromEntries(arms.map((arm) => [arm.id, arm.configuration])),
      sharedBudgetsByCase: Object.fromEntries(
        selectedCases.map((benchmarkCase) => [
          benchmarkCase.id,
          benchmarkCase.budget
        ])
      )
    },
    productState: null,
    costAccounting: {
      currency: "USD",
      apiEquivalentEstimate: "configured_token_prices",
      providerReported: "provider_supplied_amount",
      localNoCost: "local_execution_without_usage_charge",
      unavailable: "applicable_but_not_measurable",
      notApplicable: "component_not_used"
    }
  };
  const productProofs = results.flatMap((result) =>
    result.productProof ? [result.productProof] : []
  );
  if (productProofs.length > 0) {
    const first = productProofs[0]!;
    const identities = new Set(
      productProofs.map((proof) =>
        JSON.stringify([
          proof.manifestHash,
          proof.seed,
          proof.datasetHash,
          proof.corpusIdentity,
          proof.runtimeIdentity
        ])
      )
    );
    if (
      identities.size !== 1 ||
      first.datasetHash !== retrievalArenaDatasetHash ||
      first.corpusIdentity !== retrievalArenaCorpusIdentity
    ) {
      throw new Error(
        "product results do not share one reproducible seeded corpus identity"
      );
    }
    metadata.productState = {
      manifestHash: first.manifestHash,
      seed: first.seed,
      corpusIdentity: first.corpusIdentity,
      runtimeIdentity: first.runtimeIdentity
    };
  }
  const activeArms = arms.filter((arm) =>
    layers.some((layer) =>
      layer === "product"
        ? arm.layer === "product"
        : arm.layer === "retrieval_only"
    )
  );
  const requiredModelRoles = new Set(
    activeArms.flatMap((arm) => arm.modelRoles ?? [])
  );
  if (layers.includes("fixed_reader")) requiredModelRoles.add("reader");
  if (layers.includes("fixed_reader") || layers.includes("product")) {
    requiredModelRoles.add("judge");
  }
  metadata.models = Object.fromEntries(
    [...requiredModelRoles].flatMap((role) => {
      const model = options.modelMetadata?.[role];
      return model ? [[role, model]] : [];
    })
  );
  if (
    options.strictProviders &&
    results.some(
      (result) => result.status === "completed" || result.qualityObservation
    )
  ) {
    if (!metadata.acceleration) {
      throw new Error(
        "strict Retrieval Arena reproducibility requires runtime acceleration metadata"
      );
    }
    for (const role of requiredModelRoles) {
      const model = metadata.models[role];
      if (!model) {
        throw new Error(
          `strict Retrieval Arena reproducibility requires ${role} model metadata`
        );
      }
      const missing: Array<[string, string | number | null]> = [
        ["artifact", model.artifact],
        ["artifactRevision", model.artifactRevision]
      ];
      if (role !== "reranker") {
        missing.push(
          ["artifactHash", model.artifactHash],
          ["tokenizer", model.tokenizer],
          ["tokenizerRevision", model.tokenizerRevision],
          ["acceleration", model.acceleration]
        );
      }
      if (role === "reranker") {
        missing.push(["artifactHash", model.artifactHash]);
      }
      if (role !== "embedding" && role !== "reranker") {
        missing.push(
          [
            "inputPricePerMillionTokensUsd",
            model.inputPricePerMillionTokensUsd
          ],
          [
            "outputPricePerMillionTokensUsd",
            model.outputPricePerMillionTokensUsd
          ]
        );
      }
      const missingNames = missing.flatMap(([name, value]) =>
        value === null ? [name] : []
      );
      if (missingNames.length > 0) {
        throw new Error(
          `strict Retrieval Arena reproducibility for ${role} requires ${missingNames.join(", ")}`
        );
      }
    }
    const rerankerModel = metadata.models.reranker;
    for (const result of results.filter(
      (item) => item.status === "completed" && item.rerankerResources
    )) {
      const actual = result.rerankerResources!;
      if (
        !rerankerModel ||
        actual.model !== rerankerModel.model ||
        actual.artifact !== rerankerModel.artifact ||
        actual.artifactRevision !== rerankerModel.artifactRevision ||
        actual.artifactHash !== rerankerModel.artifactHash
      ) {
        throw new Error(
          `strict Retrieval Arena reranker provenance mismatch for ${result.armId}: actual model/artifact/revision/hash must match pinned reranker metadata`
        );
      }
      const missingCallMetrics = [
        ["latencyMs", actual.latencyMs],
        ["inputTokens", actual.inputTokens],
        ["costUsd", actual.costUsd]
      ].flatMap(([name, value]) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? []
          : [name]
      );
      if (missingCallMetrics.length > 0) {
        throw new Error(
          `strict Retrieval Arena reranker call metrics require ${missingCallMetrics.join(", ")}`
        );
      }
    }
    for (const result of results.filter(
      (item) => item.status === "completed" || item.qualityObservation
    )) {
      if (
        result.qualityObservation &&
        result.aggregateCost &&
        !result.aggregateCost.complete
      ) {
        throw new Error(
          `strict Retrieval Arena aggregate cost is incomplete for ${result.armId}`
        );
      }
      const expectedReaderRole =
        result.layer === "product" ? "productWorker" : "reader";
      const reader = result.answerResources?.reader;
      if (
        reader &&
        !observedModelMatchesDescriptor(
          metadata.models[expectedReaderRole],
          reader.model
        )
      ) {
        throw new Error(
          `strict Retrieval Arena observed ${expectedReaderRole} model ${reader.model} does not match configured metadata`
        );
      }
      const assertCallCost = (
        call: ArenaModelCallMetrics | undefined,
        rates: { input?: number; output?: number },
        role: string
      ): void => {
        if (!call) return;
        const expected = callCost(call.inputTokens, call.outputTokens, rates);
        if (
          expected === null ||
          call.costUsd === null ||
          Math.abs(expected - call.costUsd) > 1e-12
        ) {
          throw new Error(
            `strict Retrieval Arena observed ${role} cost does not match tokens and pinned prices`
          );
        }
      };
      assertCallCost(
        reader,
        result.layer === "product" ? pricing("product") : pricing("reader"),
        expectedReaderRole
      );
      const judge = result.answerResources?.judge;
      if (
        judge &&
        !observedModelMatchesDescriptor(metadata.models.judge, judge.model)
      ) {
        throw new Error(
          `strict Retrieval Arena observed judge model ${judge.model} does not match configured metadata`
        );
      }
      assertCallCost(judge, pricing("judge"), "judge");
      const observedRewriteModel = result.trace?.rewriteModel;
      if (
        typeof observedRewriteModel === "string" &&
        !observedModelMatchesDescriptor(
          metadata.models.rewrite,
          observedRewriteModel
        )
      ) {
        throw new Error(
          `strict Retrieval Arena observed rewrite model ${observedRewriteModel} does not match configured metadata`
        );
      }
    }
  }
  return parseRetrievalArenaReport({
    benchmark: "retrieval-arena",
    metadata,
    results,
    leaderboards: {
      retrieval_only: summarizeLayer("retrieval_only", results),
      fixed_reader: summarizeLayer("fixed_reader", results),
      product: summarizeLayer("product", results)
    },
    productComparisons: pairedProductComparisons(results)
  });
};
