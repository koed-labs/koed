import { LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION } from "@koed/core";
import { describe, expect, it } from "vitest";
import {
  scoreLcmSummaryRun,
  summarizeLcmSummaryBenchmark
} from "./benchmark.js";
import { lcmSummaryBenchmarkCases } from "./cases.js";
import { mustCase, passingOutput } from "./test-helpers.js";

const scoreOutput = (caseId: string, output: unknown) => {
  const benchmarkCase = mustCase(caseId);
  const normalizedOutput =
    typeof output === "object" && output !== null && !Array.isArray(output)
      ? { lexical_anchors: [], ...output }
      : output;
  return scoreLcmSummaryRun(benchmarkCase, {
    caseId,
    runIndex: 0,
    output: normalizedOutput
  });
};

describe("LCM summary generation benchmark cases", () => {
  it("contains the planned fixture set", () => {
    expect(lcmSummaryBenchmarkCases).toHaveLength(12);
    expect(
      lcmSummaryBenchmarkCases.map((benchmarkCase) => benchmarkCase.id)
    ).toEqual([
      "accepted-decision-ai-client-synthesis",
      "superseded-decision-typescript-hook",
      "error-then-fix-projection-status",
      "long-tool-output-one-durable-fact",
      "exact-identifiers-files-commands-env",
      "unresolved-team-memory-question",
      "rollup-child-summaries",
      "rollup-conflict-latest-wins",
      "noisy-lifecycle-items",
      "model-name-preservation",
      "provenance-source-anchor",
      "secret-like-value-redaction"
    ]);
  });
});

describe("LCM summary generation scoring", () => {
  it("passes known-good minimal summaries for every case", () => {
    for (const benchmarkCase of lcmSummaryBenchmarkCases) {
      const score = scoreOutput(benchmarkCase.id, passingOutput(benchmarkCase));
      expect(score.validJson, benchmarkCase.id).toBe(true);
      expect(score.criticalFailure, benchmarkCase.id).toBe(false);
      expect(score.passed, benchmarkCase.id).toBe(true);
    }
  });

  it("rejects invalid JSON and missing required schema fields", () => {
    expect(
      scoreOutput("accepted-decision-ai-client-synthesis", "not json").validJson
    ).toBe(false);
    expect(
      scoreOutput("accepted-decision-ai-client-synthesis", {
        schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
        summary_text: "Backend returns Evidence Bundles only."
      }).validJson
    ).toBe(false);
  });

  it("rejects legacy structured detail fields", () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const output = {
      ...passingOutput(benchmarkCase),
      decisions: ["Backend returns Evidence Bundles only."]
    };

    const score = scoreOutput(benchmarkCase.id, output);
    expect(score.validJson).toBe(false);
    expect(score.criticalFailure).toBe(true);
  });

  it("requires durable claims to appear in canonical summary_text", () => {
    const output = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Answer synthesis",
      summary_text: "Koed answer synthesis placement was discussed."
    };

    const score = scoreOutput("accepted-decision-ai-client-synthesis", output);
    expect(
      score.details.find(
        (detail) => detail.name === "required:backend-evidence-only"
      )
    ).toMatchObject({ score: 0, critical: true });
    expect(score.criticalFailure).toBe(true);
  });

  it("does not treat the title as a substitute for canonical summary_text", () => {
    const output = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title:
        "Backend returns Evidence Bundles only and Answer Synthesis remains in the connected AI Client",
      summary_text: "The architecture was discussed."
    };

    const score = scoreOutput("accepted-decision-ai-client-synthesis", output);
    expect(
      score.details.find(
        (detail) => detail.name === "required:backend-evidence-only"
      )
    ).toMatchObject({ score: 0 });
    expect(score.criticalFailure).toBe(true);
  });

  it("does not pass negated required claims through token overlap", () => {
    const output = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Answer synthesis",
      summary_text:
        "Backend no longer returns Evidence Bundles only. It is false that Answer Synthesis remains in the connected AI Client."
    };

    const score = scoreOutput("accepted-decision-ai-client-synthesis", output);
    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
  });

  it("accepts compact affirmative clauses in summary_text", () => {
    const output = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Answer synthesis",
      summary_text:
        "The backend returns Evidence Bundles only. Answer Synthesis is not in the backend; it remains in the connected AI Client."
    };

    const score = scoreOutput("accepted-decision-ai-client-synthesis", output);
    expect(score.criticalFailure).toBe(false);
    expect(score.passed).toBe(true);
  });

  it("fails critical forbidden claims in summary_text", () => {
    const benchmarkCase = mustCase("secret-like-value-redaction");
    const output = passingOutput(benchmarkCase);
    output.summary_text += " koed_live_secret_abc123";

    const score = scoreOutput(benchmarkCase.id, output);
    expect(
      score.details.find((detail) => detail.name === "forbidden:literal-token")
    ).toMatchObject({ score: 0, critical: true });
    expect(score.criticalFailure).toBe(true);
  });

  it("does not suppress a secret literal merely because it is negated", () => {
    const benchmarkCase = mustCase("secret-like-value-redaction");
    const output = passingOutput(benchmarkCase);
    output.summary_text += " Do not preserve koed_live_secret_abc123.";

    const score = scoreOutput(benchmarkCase.id, output);
    expect(score.criticalFailure).toBe(true);
  });

  it("preserves superseded context without accepting the old decision", () => {
    const output = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Diagnostic tools",
      summary_text:
        "Diagnostic low-level memory tools stay hidden unless explicitly enabled; the earlier proposal to enable them by default for all users was superseded."
    };

    const score = scoreOutput("rollup-conflict-latest-wins", output);
    expect(
      score.details.find(
        (detail) => detail.name === "forbidden:diagnostic-default"
      )
    ).toMatchObject({ score: 6 });
    expect(score.criticalFailure).toBe(false);
  });

  it("rejects a conflict summary that drops the explicit-enable condition", () => {
    const output = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Diagnostic tools",
      summary_text: "Diagnostic low-level memory tools are hidden."
    };

    const score = scoreOutput("rollup-conflict-latest-wins", output);
    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
  });

  it("allows an initial proposal when the later state supersedes it", () => {
    const output = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Diagnostic tools",
      summary_text:
        "The initial suggestion was that diagnostic low-level memory tools should be enabled by default for all users, but the later state superseded it and keeps the tools hidden unless explicitly enabled."
    };

    const score = scoreOutput("rollup-conflict-latest-wins", output);
    expect(score.criticalFailure).toBe(false);
    expect(score.passed).toBe(true);
  });

  it("rejects an active forbidden decision after superseded context", () => {
    const output = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Diagnostic tools",
      summary_text:
        "An earlier unrelated proposal was superseded. Diagnostic low-level memory tools are enabled by default for all users."
    };

    const score = scoreOutput("rollup-conflict-latest-wins", output);
    expect(score.criticalFailure).toBe(true);
  });

  it("keeps unresolved questions unresolved in summary_text", () => {
    const output = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Team memory scope",
      summary_text:
        "Whether Team memory is visible in Memory Answer by default remains unresolved, as does how Search Domain and Retrieval Scope should interact with it."
    };

    const score = scoreOutput("unresolved-team-memory-question", output);
    expect(score.criticalFailure).toBe(false);
    expect(score.passed).toBe(true);
  });

  it("preserves useful source anchors in canonical summary_text", () => {
    const output = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Source anchor",
      summary_text:
        "Expansion can trace the claim to source:memory_events:00000000-0000-4000-8000-000000300001."
    };

    const score = scoreOutput("provenance-source-anchor", output);
    expect(score.criticalFailure).toBe(false);
    expect(score.passed).toBe(true);
  });

  it("summarizes strict aggregate pass state", () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const first = scoreOutput(benchmarkCase.id, passingOutput(benchmarkCase));
    const second = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 1,
      output: "not json"
    });

    const summary = summarizeLcmSummaryBenchmark([first, second]);
    expect(summary.validJsonRate).toBe(0.5);
    expect(summary.criticalFailureCount).toBe(1);
    expect(summary.passed).toBe(false);
  });
});
