import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArenaResourceMetrics } from "./contracts.js";
import {
  parseRetrievalArenaReport,
  type RetrievalArenaReport
} from "./runner.js";

export const RETRIEVAL_SCALE_GENERATOR_VERSION = "koed-retrieval-scale-load-v1";
export const RETRIEVAL_SCALE_REPORT_VERSION = "koed-retrieval-scale-report-v1";

export const retrievalScaleProfileSchema = z
  .object({
    id: z.enum(["development-smoke", "realistic-launch"]),
    description: z.string().min(1),
    scope: z
      .object({
        users: z.number().int().positive(),
        teamWorkspaces: z.number().int().nonnegative(),
        projects: z.number().int().positive(),
        sessions: z.number().int().positive(),
        memoryEvents: z.number().int().positive(),
        memoryNodes: z.number().int().nonnegative(),
        curatedMemories: z.number().int().nonnegative(),
        embeddings: z.number().int().nonnegative()
      })
      .strict(),
    minimumMeasuredQueries: z.number().int().positive()
  })
  .strict();
export type RetrievalScaleProfile = z.infer<typeof retrievalScaleProfileSchema>;

export const retrievalScaleProfiles: Record<
  RetrievalScaleProfile["id"],
  RetrievalScaleProfile
> = {
  "development-smoke": {
    id: "development-smoke",
    description: "Fast local wiring and telemetry smoke; suitable for CI.",
    scope: {
      users: 4,
      teamWorkspaces: 2,
      projects: 20,
      sessions: 100,
      memoryEvents: 10_000,
      memoryNodes: 2_000,
      curatedMemories: 200,
      embeddings: 12_200
    },
    minimumMeasuredQueries: 3
  },
  "realistic-launch": {
    id: "realistic-launch",
    description:
      "Declared launch-capacity workload; run manually on launch hardware.",
    scope: {
      users: 250,
      teamWorkspaces: 50,
      projects: 2_000,
      sessions: 25_000,
      memoryEvents: 1_000_000,
      memoryNodes: 200_000,
      curatedMemories: 25_000,
      embeddings: 1_225_000
    },
    minimumMeasuredQueries: 15
  }
};

const scaleLoadKindSchema = z.enum([
  "memory_event",
  "memory_node",
  "curated_memory"
]);
export const retrievalScaleLoadRecordSchema = z
  .object({
    generatorVersion: z.literal(RETRIEVAL_SCALE_GENERATOR_VERSION),
    profileId: retrievalScaleProfileSchema.shape.id,
    seed: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    id: z.string().regex(/^[a-f0-9]{32}$/),
    kind: scaleLoadKindSchema,
    userOrdinal: z.number().int().nonnegative(),
    teamWorkspaceOrdinal: z.number().int().nonnegative().nullable(),
    projectOrdinal: z.number().int().nonnegative(),
    sessionOrdinal: z.number().int().nonnegative(),
    sourceMemoryEventOrdinal: z.number().int().nonnegative().nullable(),
    parentMemoryNodeOrdinal: z.number().int().nonnegative().nullable(),
    text: z.string().min(1)
  })
  .strict();
export type RetrievalScaleLoadRecord = z.infer<
  typeof retrievalScaleLoadRecordSchema
>;

const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const scaleLoadIdentity = (
  profile: RetrievalScaleProfile,
  seed: string
): string =>
  hash(
    JSON.stringify({
      generatorVersion: RETRIEVAL_SCALE_GENERATOR_VERSION,
      profile,
      seed
    })
  );

export function* generateRetrievalScaleLoad(
  profile: RetrievalScaleProfile,
  seed: string
): Generator<RetrievalScaleLoadRecord, void> {
  retrievalScaleProfileSchema.parse(profile);
  if (!seed.trim()) throw new Error("scale-load seed must not be empty");
  const counts: Array<[RetrievalScaleLoadRecord["kind"], number]> = [
    ["memory_event", profile.scope.memoryEvents],
    ["memory_node", profile.scope.memoryNodes],
    ["curated_memory", profile.scope.curatedMemories]
  ];
  let ordinal = 0;
  for (const [kind, count] of counts) {
    for (let kindOrdinal = 0; kindOrdinal < count; kindOrdinal += 1) {
      const userOrdinal = ordinal % profile.scope.users;
      const teamWorkspaceOrdinal =
        profile.scope.teamWorkspaces > 0 && ordinal % 5 === 0
          ? Math.floor(ordinal / 5) % profile.scope.teamWorkspaces
          : null;
      const projectOrdinal = ordinal % profile.scope.projects;
      const sessionOrdinal = ordinal % profile.scope.sessions;
      const id = hash(
        `${RETRIEVAL_SCALE_GENERATOR_VERSION}:${profile.id}:${seed}:${kind}:${kindOrdinal}`
      ).slice(0, 32);
      yield {
        generatorVersion: RETRIEVAL_SCALE_GENERATOR_VERSION,
        profileId: profile.id,
        seed,
        ordinal,
        id,
        kind,
        userOrdinal,
        teamWorkspaceOrdinal,
        projectOrdinal,
        sessionOrdinal,
        sourceMemoryEventOrdinal:
          kind === "memory_event"
            ? null
            : kindOrdinal % profile.scope.memoryEvents,
        parentMemoryNodeOrdinal:
          kind === "memory_node" && kindOrdinal > 0 && kindOrdinal % 4 !== 0
            ? Math.floor((kindOrdinal - 1) / 4)
            : null,
        text: `Synthetic scale load ${id} for project ${projectOrdinal}, session ${sessionOrdinal}. This record is generated background load and has no relevance judgment.`
      };
      ordinal += 1;
    }
  }
}

export const retrievalScaleScopeAttestationSchema = z
  .object({
    schemaVersion: z.literal("koed-retrieval-scale-scope-v1"),
    profileId: retrievalScaleProfileSchema.shape.id,
    generatorVersion: z.literal(RETRIEVAL_SCALE_GENERATOR_VERSION),
    seed: z.string().min(1),
    loadIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    runtimeIdentity: z.string().min(1),
    databaseIdentity: z.string().min(1),
    observedAt: z.iso.datetime(),
    observedScope: retrievalScaleProfileSchema.shape.scope
  })
  .strict();
export type RetrievalScaleScopeAttestation = z.infer<
  typeof retrievalScaleScopeAttestationSchema
>;

const distributionSchema = z
  .object({
    count: z.number().int().positive(),
    sum: z.number().finite().nonnegative(),
    mean: z.number().finite().nonnegative(),
    p50: z.number().finite().nonnegative(),
    p95: z.number().finite().nonnegative(),
    max: z.number().finite().nonnegative()
  })
  .strict();

const reportMetricKeys = [
  "wallTimeMs",
  "peakRssBytes",
  "databaseReads",
  "hydrationCount",
  "hydrationBytes",
  "decryptCount",
  "decryptBytes",
  "embeddingCalls",
  "embeddingTokens",
  "internalVectorStages",
  "apiRetrievalCalls",
  "candidateCount",
  "evidenceTokens",
  "inputTokens",
  "outputTokens",
  "costUsd"
] as const satisfies ReadonlyArray<keyof ArenaResourceMetrics>;
type ReportMetricKey = (typeof reportMetricKeys)[number];

export const retrievalScaleReportSchema = z
  .object({
    benchmark: z.literal("retrieval-scale"),
    schemaVersion: z.literal(RETRIEVAL_SCALE_REPORT_VERSION),
    generatedAt: z.iso.datetime(),
    profile: retrievalScaleProfileSchema,
    scopeAttestation: retrievalScaleScopeAttestationSchema,
    reproducibility: z
      .object({
        identity: z.string().regex(/^[a-f0-9]{64}$/),
        loadIdentity: z.string().regex(/^[a-f0-9]{64}$/),
        arenaEffectiveSourceTreeHash: z.string().regex(/^[a-f0-9]{64}$/),
        arenaDatasetHash: z.string().regex(/^[a-f0-9]{64}$/),
        arenaDeterministicSeed: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict(),
    qualityAssessment: z
      .object({
        measured: z.literal(false),
        reason: z.literal(
          "generated scale load has no relevance judgments; quality remains proven only by the hand-authored Retrieval Arena corpus"
        )
      })
      .strict(),
    measuredQueries: z.number().int().positive(),
    armIds: z.array(z.string().min(1)).min(1),
    resources: z.record(z.enum(reportMetricKeys), distributionSchema),
    processMemory: z
      .object({
        aggregation: z.literal("stable_concurrent_plus_max_dynamic_child"),
        peakRssBytes: distributionSchema,
        componentRoles: z.array(
          z.enum(["api", "database", "embedding_service", "ai_client_model"])
        )
      })
      .strict(),
    cost: z
      .object({
        currency: z.literal("USD"),
        complete: z.boolean(),
        totalUsd: z.number().finite().nonnegative().nullable(),
        accounting: z
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
    environment: z
      .object({
        koedCommit: z.string().min(1),
        workingTreeDirty: z.boolean(),
        nodeVersion: z.string().min(1),
        platform: z.string().min(1),
        architecture: z.string().min(1),
        cpu: z.string().min(1),
        totalMemoryBytes: z.number().int().positive(),
        acceleration: z.string().nullable(),
        models: z.record(z.string(), z.unknown())
      })
      .strict()
  })
  .strict();
export type RetrievalScaleReport = z.infer<typeof retrievalScaleReportSchema>;

const distribution = (values: number[]) => {
  if (values.length === 0) throw new Error("cannot summarize no observations");
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.ceil(fraction * sorted.length) - 1]!;
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    sum,
    mean: sum / sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1)!
  };
};

const assertScope = (
  profile: RetrievalScaleProfile,
  attestation: RetrievalScaleScopeAttestation
): void => {
  if (attestation.profileId !== profile.id)
    throw new Error(
      "scope attestation profile does not match requested profile"
    );
  if (attestation.loadIdentity !== scaleLoadIdentity(profile, attestation.seed))
    throw new Error("scope attestation load identity is invalid");
  for (const [key, expected] of Object.entries(profile.scope)) {
    const observed =
      attestation.observedScope[key as keyof typeof profile.scope];
    if (observed !== expected)
      throw new Error(
        `scope attestation ${key} mismatch: expected ${expected}, observed ${observed}`
      );
  }
};

export const buildRetrievalScaleReport = (options: {
  profile: RetrievalScaleProfile;
  scopeAttestation: RetrievalScaleScopeAttestation;
  arenaReport: RetrievalArenaReport | unknown;
  generatedAt?: string;
}): RetrievalScaleReport => {
  const profile = retrievalScaleProfileSchema.parse(options.profile);
  const scopeAttestation = retrievalScaleScopeAttestationSchema.parse(
    options.scopeAttestation
  );
  assertScope(profile, scopeAttestation);
  const arena = parseRetrievalArenaReport(options.arenaReport);
  if (!arena.metadata.productState)
    throw new Error("scale reports require a live product-state proof");
  if (
    arena.metadata.productState.runtimeIdentity !==
    scopeAttestation.runtimeIdentity
  )
    throw new Error(
      "scope attestation and Arena product proof target different runtimes"
    );
  const completed = arena.results.filter(
    (result) => result.layer === "product" && result.status === "completed"
  );
  if (completed.length < profile.minimumMeasuredQueries)
    throw new Error(
      `${profile.id} requires at least ${profile.minimumMeasuredQueries} completed product queries; observed ${completed.length}`
    );
  if (
    arena.results.some(
      (result) => result.layer === "product" && result.status !== "completed"
    )
  )
    throw new Error("scale reports reject skipped or failed product queries");

  const resources = Object.fromEntries(
    reportMetricKeys.map((key) => {
      const values = completed.map((result) => result.resources?.[key]);
      if (values.some((value) => typeof value !== "number"))
        throw new Error(
          `scale report requires measured ${key} for every query`
        );
      return [key, distribution(values as number[])];
    })
  ) as Record<ReportMetricKey, ReturnType<typeof distribution>>;
  const memories = completed.map((result) => result.resources?.peakMemory);
  if (
    memories.some(
      (memory) =>
        !memory ||
        memory.aggregation !== "stable_concurrent_plus_max_dynamic_child"
    )
  )
    throw new Error("scale report requires strict product process telemetry");
  const componentRoles = [
    ...new Set(
      memories.flatMap(
        (memory) => memory?.components.map((component) => component.role) ?? []
      )
    )
  ].sort();
  const requiredRoles = [
    "ai_client_model",
    "api",
    "database",
    "embedding_service"
  ];
  if (JSON.stringify(componentRoles) !== JSON.stringify(requiredRoles))
    throw new Error("scale report requires all participating process roles");

  const aggregateCosts = completed.map((result) => result.aggregateCost);
  const costComplete = aggregateCosts.every((cost) => cost?.complete === true);
  const totalUsd = costComplete
    ? aggregateCosts.reduce((total, cost) => total + cost!.totalUsd!, 0)
    : null;
  const identity = hash(
    JSON.stringify({
      schemaVersion: RETRIEVAL_SCALE_REPORT_VERSION,
      profile,
      scopeAttestation: { ...scopeAttestation, observedAt: null },
      arenaIdentity: {
        effectiveSourceTreeHash: arena.metadata.effectiveSourceTreeHash,
        datasetHash: arena.metadata.datasetHash,
        deterministicSeed: arena.metadata.deterministicSeed.value
      },
      observations: completed.map((result) => ({
        caseId: result.caseId,
        armId: result.armId,
        runIndex: result.runIndex,
        resources: result.resources,
        aggregateCost: result.aggregateCost
      }))
    })
  );
  return retrievalScaleReportSchema.parse({
    benchmark: "retrieval-scale",
    schemaVersion: RETRIEVAL_SCALE_REPORT_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    profile,
    scopeAttestation,
    reproducibility: {
      identity,
      loadIdentity: scopeAttestation.loadIdentity,
      arenaEffectiveSourceTreeHash: arena.metadata.effectiveSourceTreeHash,
      arenaDatasetHash: arena.metadata.datasetHash,
      arenaDeterministicSeed: arena.metadata.deterministicSeed.value
    },
    qualityAssessment: {
      measured: false,
      reason:
        "generated scale load has no relevance judgments; quality remains proven only by the hand-authored Retrieval Arena corpus"
    },
    measuredQueries: completed.length,
    armIds: [...new Set(completed.map((result) => result.armId))].sort(),
    resources,
    processMemory: {
      aggregation: "stable_concurrent_plus_max_dynamic_child",
      peakRssBytes: resources.peakRssBytes,
      componentRoles
    },
    cost: {
      currency: "USD",
      complete: costComplete,
      totalUsd,
      accounting: arena.metadata.costAccounting
    },
    environment: {
      koedCommit: arena.metadata.koedCommit,
      workingTreeDirty: arena.metadata.workingTreeDirty,
      nodeVersion: arena.metadata.nodeVersion,
      platform: arena.metadata.platform,
      architecture: arena.metadata.architecture,
      cpu: arena.metadata.cpu,
      totalMemoryBytes: arena.metadata.totalMemoryBytes,
      acceleration: arena.metadata.acceleration,
      models: arena.metadata.models
    }
  });
};

export const runRetrievalScaleBenchmark = async (options: {
  profile: RetrievalScaleProfile;
  seed: string;
  observeScope: () => Promise<RetrievalScaleScopeAttestation>;
  runArena: () => Promise<RetrievalArenaReport>;
  generatedAt?: string;
}): Promise<RetrievalScaleReport> => {
  const before = retrievalScaleScopeAttestationSchema.parse(
    await options.observeScope()
  );
  if (before.seed !== options.seed)
    throw new Error("observed scale scope uses a different seed");
  assertScope(options.profile, before);
  const arenaReport = await options.runArena();
  const after = retrievalScaleScopeAttestationSchema.parse(
    await options.observeScope()
  );
  const stableBefore = { ...before, observedAt: null };
  const stableAfter = { ...after, observedAt: null };
  if (JSON.stringify(stableBefore) !== JSON.stringify(stableAfter))
    throw new Error("scale scope changed while retrieval measurements ran");
  return buildRetrievalScaleReport({
    profile: options.profile,
    scopeAttestation: after,
    arenaReport,
    generatedAt: options.generatedAt
  });
};
