import { createHash } from "node:crypto";
import { z } from "zod";

export const RETRIEVAL_ARENA_SCHEMA_VERSION = "retrieval-arena-v2";

export const arenaCostBasisSchema = z.enum([
  "local_no_cost",
  "api_equivalent_estimate",
  "provider_reported",
  "not_applicable",
  "unavailable"
]);
export type ArenaCostBasis = z.infer<typeof arenaCostBasisSchema>;

export const arenaSplitSchema = z.enum([
  "development",
  "validation",
  "held_out"
]);
export type ArenaSplit = z.infer<typeof arenaSplitSchema>;

export const arenaLayerSchema = z.enum([
  "retrieval_only",
  "fixed_reader",
  "product"
]);
export type ArenaLayer = z.infer<typeof arenaLayerSchema>;

export const corpusItemSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    sourceType: z.enum(["memory_event", "memory_node", "curated_memory"]),
    sourceChunkIndex: z.number().int().nonnegative(),
    tokenCount: z.number().int().positive(),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
export type CorpusItem = z.infer<typeof corpusItemSchema>;

export const productCaseContextSchema = z
  .object({
    memoryClass: z.enum(["personal", "team_workspace"]),
    retrievalScope: z.enum(["personal", "shared"]),
    searchDomain: z.enum(["global", "project", "session"]),
    projectId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    teamWorkspaceId: z.string().uuid().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.searchDomain === "project" && !value.projectId)
      context.addIssue({ code: "custom", message: "projectId is required" });
    if (value.searchDomain === "session" && !value.sessionId)
      context.addIssue({ code: "custom", message: "sessionId is required" });
    if (value.memoryClass === "team_workspace") {
      if (value.retrievalScope !== "shared" || !value.teamWorkspaceId)
        context.addIssue({
          code: "custom",
          message:
            "Team Workspace cases require shared scope and teamWorkspaceId"
        });
    }
  });
export type ProductCaseContext = z.infer<typeof productCaseContextSchema>;

export const relevanceJudgmentSchema = z
  .object({
    itemId: z.string().min(1),
    grade: z.number().int().min(0).max(3),
    evidenceGroup: z.string().min(1).optional(),
    forbidden: z.boolean().default(false)
  })
  .strict();
export type RelevanceJudgment = z.infer<typeof relevanceJudgmentSchema>;

export const arenaBudgetSchema = z
  .object({
    maxCandidates: z.number().int().positive(),
    maxEvidenceItems: z.number().int().positive(),
    maxEvidenceTokens: z.number().int().positive(),
    maxSearchCalls: z.number().int().positive(),
    maxExpansions: z.number().int().nonnegative(),
    timeoutMs: z.number().int().positive()
  })
  .strict();
export type ArenaBudget = z.infer<typeof arenaBudgetSchema>;

export const deterministicAnswerChecksSchema = z
  .object({
    status: z.enum(["found", "not_found", "insufficient", "pending_summary"]),
    exactFacts: z.array(z.string().min(1)).default([]),
    forbiddenFacts: z.array(z.string().min(1)).default([]),
    requiredJsonKeys: z.array(z.string().min(1)).default([])
  })
  .strict();

export const arenaCaseSchema = z
  .object({
    id: z.string().min(1),
    split: arenaSplitSchema,
    question: z.string().min(1),
    retrievalHints: z
      .object({
        semantic: z.array(z.string().min(1)).min(1),
        exact: z.array(z.string().min(1)).min(1),
        lexical: z.array(z.string().min(1)).min(1)
      })
      .strict(),
    corpus: z.array(corpusItemSchema).min(1),
    qrels: z.array(relevanceJudgmentSchema).min(1),
    budget: arenaBudgetSchema,
    answerChecks: deterministicAnswerChecksSchema,
    referenceAnswer: z.string().min(1),
    productContext: productCaseContextSchema,
    tags: z.array(z.string().min(1)).min(1)
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set(value.corpus.map((item) => item.id));
    if (ids.size !== value.corpus.length) {
      context.addIssue({
        code: "custom",
        message: "corpus ids must be unique"
      });
    }
    for (const qrel of value.qrels) {
      if (!ids.has(qrel.itemId)) {
        context.addIssue({
          code: "custom",
          message: `qrel references missing corpus item ${qrel.itemId}`
        });
      }
    }
  });
export type ArenaCase = z.infer<typeof arenaCaseSchema>;

export interface RankedEvidence {
  itemId: string;
  rank: number;
  /** Provider score when one exists. Product evidence must not invent one. */
  score: number | null;
  text: string;
  tokenCount: number;
  sourceType: CorpusItem["sourceType"];
  sourceChunkIndex: number;
}

/** Provider-safe case input. Gold labels and reference answers are intentionally absent. */
export type ArenaProviderCase = Pick<
  ArenaCase,
  | "id"
  | "split"
  | "question"
  | "retrievalHints"
  | "corpus"
  | "budget"
  | "productContext"
>;

export const productStateManifestSchema = z
  .object({
    schemaVersion: z.literal("koed-retrieval-arena-product-state-v1"),
    seed: z.string().min(1),
    datasetVersion: z.string().min(1),
    datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
    corpusIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    runtimeIdentity: z.string().min(1),
    cases: z
      .array(
        z
          .object({
            caseId: z.string().min(1),
            corpusHash: z.string().regex(/^[a-f0-9]{64}$/),
            stateHash: z.string().regex(/^[a-f0-9]{64}$/),
            itemIds: z.array(z.string().min(1)).min(1),
            productContextHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            liveSources: z
              .array(
                z
                  .object({
                    itemId: z.string().min(1),
                    sourceType: z.enum([
                      "memory_event",
                      "memory_node",
                      "curated_memory"
                    ]),
                    sourceId: z.string().uuid()
                  })
                  .strict()
              )
              .min(1)
              .optional()
          })
          .strict()
      )
      .min(1)
  })
  .strict()
  .superRefine((value, context) => {
    const caseIds = new Set(value.cases.map((entry) => entry.caseId));
    if (caseIds.size !== value.cases.length)
      context.addIssue({ code: "custom", message: "case ids must be unique" });
    for (const entry of value.cases) {
      if (new Set(entry.itemIds).size !== entry.itemIds.length)
        context.addIssue({
          code: "custom",
          message: `item ids must be unique for ${entry.caseId}`
        });
      if (
        entry.liveSources &&
        (new Set(entry.liveSources.map((source) => source.itemId)).size !==
          entry.liveSources.length ||
          stableHash(
            entry.liveSources.map((source) => source.itemId).sort()
          ) !== stableHash([...entry.itemIds].sort()))
      )
        context.addIssue({
          code: "custom",
          message: `live sources must bind every item exactly once for ${entry.caseId}`
        });
    }
  });
export type ProductStateManifest = z.infer<typeof productStateManifestSchema>;

export interface ProductRunProof {
  kind: "live_product";
  manifestHash: string;
  seed: string;
  datasetHash: string;
  corpusIdentity: string;
  runtimeIdentity: string;
  caseStateHash: string;
  caseCorpusHash: string;
  configurationHash: string;
  observedConfigurationHash: string;
}

export interface ArenaResourceMetrics {
  wallTimeMs: number;
  /** Product arms use the aggregate participating-process peak, never eval-runner RSS. */
  peakRssBytes: number | null;
  peakMemory?:
    | import("./process-telemetry.js").ProductPeakMemoryTelemetry
    | null;
  databaseReads: number | null;
  hydrationCount: number | null;
  hydrationBytes: number | null;
  decryptCount: number | null;
  decryptBytes: number | null;
  embeddingCalls: number | null;
  embeddingTokens: number | null;
  rerankerCalls: number | null;
  rerankerLatencyMs: number | null;
  rerankerInputTokens: number | null;
  rerankerCostUsd: number | null;
  internalVectorStages: number | null;
  apiRetrievalCalls: number | null;
  /** @deprecated Use apiRetrievalCalls. */
  searchCalls: number | null;
  expansions: number | null;
  candidateCount: number | null;
  evidenceTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  rewriteInputTokens: number | null;
  rewriteOutputTokens: number | null;
  rewriteCostUsd: number | null;
  costUsd: number | null;
  costBasis: ArenaCostBasis;
}

export interface ArenaModelCallMetrics {
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costBasis?: ArenaCostBasis;
  status: "completed" | "failed";
  error?: string;
}

export interface ArenaRerankerCallMetrics {
  model: string | null;
  artifact: string | null;
  artifactRevision: string | null;
  artifactHash: string | null;
  latencyMs: number | null;
  calls: number;
  inputTokens: number | null;
  costUsd: number | null;
  costBasis?: ArenaCostBasis;
}

export interface RetrievalArmOutput {
  /** Ranked pool before evidence item/token budgets are applied. */
  /** Null means the provider did not expose a complete, ordered candidate pool. */
  candidates?: RankedEvidence[] | null;
  evidence: RankedEvidence[];
  rewrittenQuery?: string;
  model?: string;
  provider?: string;
  trace?: Record<string, unknown>;
  metrics?: Partial<ArenaResourceMetrics>;
  rerankerMetrics?: ArenaRerankerCallMetrics;
}

export interface ProductArmOutput extends RetrievalArmOutput {
  answer: string;
  status: ArenaCase["answerChecks"]["status"];
  readerMetrics: ArenaModelCallMetrics;
  /** Required proof that the configured behavior ran against the seeded live product state. */
  productProof: ProductRunProof;
  /** Actual sequential Codex app-server children measured by the worker. */
  dynamicAiClientProcesses?: import("./process-telemetry.js").DynamicAiClientProcessTelemetry[];
}

export interface ArenaArmContext {
  benchmarkCase: ArenaCase;
  runIndex: number;
  deadlineAt: number;
  signal?: AbortSignal;
}

export interface ProductArmContext {
  benchmarkCase: ArenaProviderCase;
  runIndex: number;
  deadlineAt: number;
  signal?: AbortSignal;
}

export interface ArenaArm {
  id: string;
  label: string;
  layer: "retrieval_only" | "product";
  providerRequirement?: string;
  modelRoles?: Array<
    "embedding" | "reranker" | "reader" | "judge" | "rewrite" | "productWorker"
  >;
  configuration: Record<string, unknown>;
  run(context: ArenaArmContext): Promise<RetrievalArmOutput | ProductArmOutput>;
}

export interface ReproducibilityMetadata {
  schemaVersion: typeof RETRIEVAL_ARENA_SCHEMA_VERSION;
  generatedAt: string;
  koedCommit: string;
  workingTreeDirty: boolean;
  trackedDiffHash: string;
  untrackedSourceHash: string;
  effectiveSourceTreeHash: string;
  datasetVersion: string;
  datasetHash: string;
  corpusIdentity: string;
  selectedCorpusIdentity: string;
  deterministicSeed: {
    value: string;
    derivation: "sha256_dataset_selection_configuration_run";
    controls: ["case_arm_order", "run_index_assignment"];
    doesNotControl: ["external_provider_sampling", "live_service_state"];
  };
  datasetProvenance: {
    kind: "hand_authored";
    generator: null;
  };
  runNumber: number;
  nodeVersion: string;
  platform: string;
  architecture: string;
  cpu: string;
  totalMemoryBytes: number;
  acceleration: string | null;
  models: Record<
    string,
    {
      provider: string;
      model: string;
      artifact: string | null;
      artifactRevision: string | null;
      artifactHash: string | null;
      dimensions: number | null;
      tokenizer: string | null;
      tokenizerRevision: string | null;
      reasoningEffort: string | null;
      inputPricePerMillionTokensUsd: number | null;
      outputPricePerMillionTokensUsd: number | null;
      acceleration: string | null;
    }
  >;
  prompts: Record<string, string>;
  retrievalConfiguration: Record<string, unknown>;
  productState: {
    manifestHash: string;
    seed: string;
    corpusIdentity: string;
    runtimeIdentity: string;
  } | null;
  costAccounting: {
    currency: "USD";
    apiEquivalentEstimate: "configured_token_prices";
    providerReported: "provider_supplied_amount";
    localNoCost: "local_execution_without_usage_charge";
    unavailable: "applicable_but_not_measurable";
    notApplicable: "component_not_used";
  };
}

export const externalDatasetManifestSchema = z
  .object({
    id: z.string().min(1),
    repository: z.string().url(),
    revision: z.string().min(1),
    license: z.string().min(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    transformationVersion: z.string().min(1),
    corpusHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type ExternalDatasetManifest = z.infer<
  typeof externalDatasetManifestSchema
>;

export type ArenaRunStatus = "completed" | "skipped" | "failed";

export interface ArenaRunResult {
  caseId: string;
  split: ArenaSplit;
  layer: ArenaLayer;
  armId: string;
  runIndex: number;
  status: ArenaRunStatus;
  skipReason?: string;
  error?: string;
  evidence?: RankedEvidence[];
  answer?: string;
  answerStatus?: ArenaCase["answerChecks"]["status"];
  deterministicChecks?: Record<string, boolean>;
  semanticJudgment?: {
    status: "judged" | "error";
    passed: boolean;
    score?: number;
    dimensions?: Record<string, number>;
    rationale?: string;
    error?: string;
    model?: string | null;
    latencyMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
  };
  retrievalMetrics?: Record<string, number | null>;
  resources?: ArenaResourceMetrics;
  answerResources?: {
    reader?: ArenaModelCallMetrics;
    judge?: ArenaModelCallMetrics;
  };
  rerankerResources?: ArenaRerankerCallMetrics;
  productProof?: ProductRunProof;
  qualityObservation?: {
    quality: number;
    correctness: number;
    costUsd: number | null;
    latencyMs: number;
  };
  aggregateCost?: {
    retrievalAndSynthesisUsd: number | null;
    readerUsd: number | null;
    judgeUsd: number | null;
    rerankerUsd: number | null;
    totalUsd: number | null;
    complete: boolean;
    billingBasis: {
      retrievalAndSynthesis: ArenaCostBasis;
      reader: ArenaCostBasis;
      judge: ArenaCostBasis;
      reranker: ArenaCostBasis;
      total: ArenaCostBasis;
    };
  };
  trace?: Record<string, unknown>;
}

export const stableHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
