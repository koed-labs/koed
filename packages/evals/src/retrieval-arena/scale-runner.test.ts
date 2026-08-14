import { describe, expect, it } from "vitest";
import { createBm25Arm } from "./arms.js";
import { runRetrievalArena } from "./runner.js";
import {
  buildRetrievalScaleReport,
  generateRetrievalScaleLoad,
  retrievalScaleProfiles,
  retrievalScaleReportSchema,
  runRetrievalScaleBenchmark,
  scaleLoadIdentity,
  type RetrievalScaleScopeAttestation
} from "./scale-runner.js";

const profile = retrievalScaleProfiles["development-smoke"];

const attestation = (): RetrievalScaleScopeAttestation => ({
  schemaVersion: "koed-retrieval-scale-scope-v1",
  profileId: profile.id,
  generatorVersion: "koed-retrieval-scale-load-v1",
  seed: "fixed-test-seed",
  loadIdentity: scaleLoadIdentity(profile, "fixed-test-seed"),
  runtimeIdentity: "isolated-runtime-test",
  databaseIdentity: "koed_scale_test:public",
  observedAt: "2026-08-12T00:00:00.000Z",
  observedScope: profile.scope
});

const measuredArenaReport = async () => {
  const report = await runRetrievalArena({
    arms: [createBm25Arm()],
    caseIds: ["dev-exact-anchor"]
  });
  const original = report.results[0]!;
  report.results = Array.from({ length: 3 }, (_, runIndex) => ({
    ...structuredClone(original),
    layer: "product" as const,
    runIndex,
    resources: {
      ...original.resources!,
      wallTimeMs: 100 + runIndex * 10,
      peakRssBytes: 1_000 + runIndex * 100,
      databaseReads: 4,
      hydrationCount: 3,
      hydrationBytes: 600,
      decryptCount: 2,
      decryptBytes: 400,
      embeddingCalls: 1,
      embeddingTokens: 12,
      internalVectorStages: 2,
      apiRetrievalCalls: 1,
      candidateCount: 10,
      evidenceTokens: 80,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0,
      costBasis: "local_no_cost" as const,
      peakMemory: {
        schemaVersion: "koed-retrieval-arena-peak-memory-v2" as const,
        aggregation: "stable_concurrent_plus_max_dynamic_child" as const,
        aggregatePeakRssBytes: 1_000 + runIndex * 100,
        stableAggregatePeakRssBytes: 800,
        dynamicAiClientPeakRssBytes: 200 + runIndex * 100,
        components: [
          ["api", 1],
          ["database", 2],
          ["embedding_service", 3],
          ["ai_client_model", 4]
        ].map(([role, pid]) => ({
          role: role as
            | "api"
            | "database"
            | "embedding_service"
            | "ai_client_model",
          component: String(role),
          pid: pid as number,
          peakRssBytes: 200,
          provenance: "test status",
          measurement: "proc_status_tree" as const,
          ...(role === "ai_client_model"
            ? { attemptIndex: 1, sampleCount: 2, samplingIntervalMs: 25 }
            : {})
        }))
      }
    }
  }));
  report.metadata.productState = {
    manifestHash: "a".repeat(64),
    seed: "arena-state-seed",
    corpusIdentity: report.metadata.corpusIdentity,
    runtimeIdentity: "isolated-runtime-test"
  };
  return report;
};

describe("retrieval scale load", () => {
  it("generates stable, explicitly non-quality background records", () => {
    const first = generateRetrievalScaleLoad(profile, "fixed-test-seed");
    const firstRecord = first.next();
    const secondRecord = first.next();
    if (firstRecord.done || secondRecord.done)
      throw new Error("development scale load ended unexpectedly");
    const records = [firstRecord.value, secondRecord.value];
    expect(records).toMatchObject([
      {
        profileId: "development-smoke",
        ordinal: 0,
        kind: "memory_event"
      },
      { profileId: "development-smoke", ordinal: 1, kind: "memory_event" }
    ]);
    expect(records[0]?.text).toContain("no relevance judgment");
    const repeated = generateRetrievalScaleLoad(profile, "fixed-test-seed");
    const repeatedRecord = repeated.next();
    if (repeatedRecord.done)
      throw new Error("repeated development scale load ended unexpectedly");
    expect(repeatedRecord.value).toEqual(records[0]);
    expect(retrievalScaleProfiles["realistic-launch"].scope).toMatchObject({
      memoryEvents: 1_000_000,
      memoryNodes: 200_000,
      curatedMemories: 25_000,
      embeddings: 1_225_000
    });
    const launch = generateRetrievalScaleLoad(
      retrievalScaleProfiles["realistic-launch"],
      "fixed-test-seed"
    );
    const coveredWorkspaces = new Set<number>();
    for (let index = 0; index < 250; index += 1) {
      const record = launch.next();
      if (record.done)
        throw new Error("realistic scale load ended unexpectedly");
      const workspace = record.value.teamWorkspaceOrdinal;
      if (workspace !== null) coveredWorkspaces.add(workspace);
    }
    expect(coveredWorkspaces.size).toBe(50);
  });
});

describe("retrieval scale report", () => {
  it("summarizes strict live product telemetry without claiming quality", async () => {
    const report = buildRetrievalScaleReport({
      profile,
      scopeAttestation: attestation(),
      arenaReport: await measuredArenaReport(),
      generatedAt: "2026-08-12T01:00:00.000Z"
    });

    expect(retrievalScaleReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      measuredQueries: 3,
      qualityAssessment: { measured: false },
      resources: {
        wallTimeMs: { count: 3, mean: 110, p50: 110, p95: 120 },
        hydrationBytes: { sum: 1_800 },
        databaseReads: { sum: 12 },
        embeddingTokens: { sum: 36 }
      },
      processMemory: {
        peakRssBytes: { max: 1_200 },
        componentRoles: [
          "ai_client_model",
          "api",
          "database",
          "embedding_service"
        ]
      }
    });
    const laterAttestation = {
      ...attestation(),
      observedAt: "2026-08-12T02:00:00.000Z"
    };
    const repeated = buildRetrievalScaleReport({
      profile,
      scopeAttestation: laterAttestation,
      arenaReport: await measuredArenaReport(),
      generatedAt: "2026-08-12T03:00:00.000Z"
    });
    expect(repeated.reproducibility.identity).toBe(
      report.reproducibility.identity
    );
  });

  it("rejects an unattested scope and incomplete product telemetry", async () => {
    const invalidScope = attestation();
    invalidScope.observedScope = { ...profile.scope, memoryEvents: 9_999 };
    expect(() =>
      buildRetrievalScaleReport({
        profile,
        scopeAttestation: invalidScope,
        arenaReport: {}
      })
    ).toThrow("memoryEvents mismatch");

    const arena = await measuredArenaReport();
    arena.results[0]!.resources!.hydrationBytes = null;
    expect(() =>
      buildRetrievalScaleReport({
        profile,
        scopeAttestation: attestation(),
        arenaReport: arena
      })
    ).toThrow("measured hydrationBytes");
  });

  it("rejects scope drift around the live Arena run", async () => {
    let observation = 0;
    await expect(
      runRetrievalScaleBenchmark({
        profile,
        seed: "fixed-test-seed",
        observeScope: async () => {
          observation += 1;
          return {
            ...attestation(),
            databaseIdentity:
              observation === 1 ? "koed_scale_test:public" : "changed:public"
          };
        },
        runArena: measuredArenaReport
      })
    ).rejects.toThrow("scope changed while retrieval measurements ran");
  });
});
