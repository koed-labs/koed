import { describe, expect, it } from "vitest";
import { createBm25Arm } from "./arms.js";
import {
  parseRetrievalArenaReport,
  retrievalArenaReportSchema,
  runRetrievalArena
} from "./runner.js";
import {
  retrievalArenaCorpusIdentity,
  retrievalArenaDatasetHash
} from "./cases.js";

describe("Retrieval Arena report schema", () => {
  it("validates emitted reports and records universal corpus and seed semantics", async () => {
    const report = await runRetrievalArena({
      arms: [createBm25Arm()],
      caseIds: ["dev-exact-anchor"]
    });

    expect(() =>
      parseRetrievalArenaReport(JSON.parse(JSON.stringify(report)))
    ).not.toThrow();
    expect(report.metadata).toMatchObject({
      datasetHash: retrievalArenaDatasetHash,
      corpusIdentity: retrievalArenaCorpusIdentity,
      deterministicSeed: {
        derivation: "sha256_dataset_selection_configuration_run",
        controls: ["case_arm_order", "run_index_assignment"],
        doesNotControl: ["external_provider_sampling", "live_service_state"]
      }
    });
    expect(report.metadata.selectedCorpusIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(report.metadata.deterministicSeed.value).toMatch(/^[a-f0-9]{64}$/);
    expect(report.results[0]?.aggregateCost).toMatchObject({
      retrievalAndSynthesisUsd: 0,
      totalUsd: 0,
      complete: true,
      billingBasis: {
        retrievalAndSynthesis: "local_no_cost",
        reader: "not_applicable",
        judge: "not_applicable",
        reranker: "not_applicable",
        total: "local_no_cost"
      }
    });
  });

  it("rejects unknown nested report properties", async () => {
    const report = await runRetrievalArena({
      arms: [createBm25Arm()],
      caseIds: ["dev-exact-anchor"]
    });
    const invalid = structuredClone(report) as typeof report & {
      metadata: typeof report.metadata & { implicitSeed?: string };
    };
    invalid.metadata.implicitSeed = "not-part-of-the-contract";

    expect(retrievalArenaReportSchema.safeParse(invalid).success).toBe(false);
  });

  it("labels configured token-price costs as API-equivalent estimates", async () => {
    const arm = createBm25Arm();
    arm.id = "one-rewrite-one-search";
    const originalRun = arm.run;
    arm.run = async (context) => ({
      ...(await originalRun(context)),
      metrics: { inputTokens: 1_000, outputTokens: 500 }
    });
    const report = await runRetrievalArena({
      arms: [arm],
      caseIds: ["dev-exact-anchor"],
      costPerMillionInputTokensUsd: 2,
      costPerMillionOutputTokensUsd: 4
    });

    expect(report.results[0]?.resources).toMatchObject({
      costUsd: 0.004,
      costBasis: "api_equivalent_estimate"
    });
    expect(report.results[0]?.aggregateCost?.billingBasis.total).toBe(
      "api_equivalent_estimate"
    );
  });
});
