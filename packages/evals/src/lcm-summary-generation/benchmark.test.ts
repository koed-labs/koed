import { describe, expect, it } from "vitest";
import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  resolveLcmSummaryWorkerConfig,
  type StructuredLcmSummary
} from "@koed/mcp-server";
import {
  scoreLcmSummaryRun,
  summarizeLcmSummaryBenchmark
} from "./benchmark.js";
import {
  lcmSummaryBenchmarkCases,
  type LcmSummaryBenchmarkCase,
  type LcmSummaryField
} from "./cases.js";
import {
  lcmSummaryOptionValue,
  parseLcmSummaryRunsOption,
  parseLcmSummaryThresholdOption
} from "./cli-options.js";
import { runLcmSummaryBenchmark } from "./runner.js";

const caseById = new Map(
  lcmSummaryBenchmarkCases.map((benchmarkCase) => [
    benchmarkCase.id,
    benchmarkCase
  ])
);

const mustCase = (id: string): LcmSummaryBenchmarkCase => {
  const benchmarkCase = caseById.get(id);
  if (!benchmarkCase) {
    throw new Error(`Missing LCM summary benchmark case ${id}`);
  }
  return benchmarkCase;
};

type LcmSummaryArrayField = Exclude<LcmSummaryField, "summary_text">;

const structuredFields: LcmSummaryArrayField[] = [
  "user_requests",
  "decisions",
  "facts",
  "files",
  "commands",
  "model_names",
  "tool_outcomes",
  "errors",
  "unresolved_questions",
  "provenance_hints"
];

const emptySummary = (): StructuredLcmSummary => ({
  schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  title: "Benchmark Summary",
  summary_text: "",
  user_requests: [],
  decisions: [],
  facts: [],
  files: [],
  commands: [],
  model_names: [],
  tool_outcomes: [],
  errors: [],
  unresolved_questions: [],
  provenance_hints: []
});

const addToField = (
  summary: StructuredLcmSummary,
  field: LcmSummaryField,
  value: string
): void => {
  if (field === "summary_text") {
    summary.summary_text = [summary.summary_text, value]
      .filter(Boolean)
      .join(" ");
    return;
  }
  summary[field].push(value);
};

const passingOutput = (
  benchmarkCase: LcmSummaryBenchmarkCase
): StructuredLcmSummary => {
  const summary = emptySummary();
  for (const claim of benchmarkCase.expected.requiredClaims) {
    for (const field of claim.fields) {
      addToField(summary, field, claim.text);
    }
  }
  for (const field of benchmarkCase.expected.requiredNonEmptyFields ?? []) {
    if (field !== "summary_text" && summary[field].length === 0) {
      summary[field].push(`${benchmarkCase.id} ${field} detail`);
    }
  }
  const minFields = benchmarkCase.expected.minNonEmptyFields ?? 0;
  for (const field of structuredFields) {
    if (
      summary[field].length === 0 &&
      structuredFields.filter((candidate) => summary[candidate].length > 0)
        .length < minFields
    ) {
      summary[field].push(`${benchmarkCase.id} ${field} detail`);
    }
  }
  if (!summary.summary_text) {
    summary.summary_text = benchmarkCase.expected.requiredClaims
      .map((claim) => claim.text)
      .join(" ");
  }
  return summary;
};

describe("LCM summary generation benchmark cases", () => {
  it("contains the planned initial fixture set", () => {
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
  it("passes known-good synthetic outputs for all cases", () => {
    for (const benchmarkCase of lcmSummaryBenchmarkCases) {
      const score = scoreLcmSummaryRun(benchmarkCase, {
        caseId: benchmarkCase.id,
        runIndex: 0,
        output: passingOutput(benchmarkCase)
      });
      expect(score.validJson, benchmarkCase.id).toBe(true);
      expect(score.criticalFailure, benchmarkCase.id).toBe(false);
      expect(score.passed, benchmarkCase.id).toBe(true);
    }
  });

  it("rejects invalid JSON", () => {
    const score = scoreLcmSummaryRun(
      mustCase("accepted-decision-ai-client-synthesis"),
      {
        caseId: "accepted-decision-ai-client-synthesis",
        runIndex: 0,
        output: "not json"
      }
    );

    expect(score.validJson).toBe(false);
    expect(score.passed).toBe(false);
  });

  it("rejects markdown-wrapped invalid output", () => {
    const score = scoreLcmSummaryRun(
      mustCase("accepted-decision-ai-client-synthesis"),
      {
        caseId: "accepted-decision-ai-client-synthesis",
        runIndex: 0,
        output: "```json\nnot json\n```"
      }
    );

    expect(score.validJson).toBe(false);
    expect(score.criticalFailure).toBe(true);
  });

  it("rejects missing required schema fields", () => {
    const score = scoreLcmSummaryRun(
      mustCase("accepted-decision-ai-client-synthesis"),
      {
        caseId: "accepted-decision-ai-client-synthesis",
        runIndex: 0,
        output: {
          schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
          summary_text: "backend returns Evidence Bundles only"
        }
      }
    );

    expect(score.validJson).toBe(false);
  });

  it("fails critical forbidden claims", () => {
    const benchmarkCase = mustCase("secret-like-value-redaction");
    const output = passingOutput(benchmarkCase);
    output.facts.push("koed_live_secret_abc123");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
    expect(
      score.details.find((detail) => detail.name === "forbidden:literal-token")
    ).toMatchObject({
      score: 0,
      critical: true
    });
  });

  it("does not pass negated critical required claims through token overlap", () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const output = passingOutput(benchmarkCase);
    output.decisions = [
      "Backend no longer returns Evidence Bundles only.",
      "It is false that Answer Synthesis remains in the connected AI Client."
    ];
    output.summary_text = output.decisions.join(" ");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(score.criticalFailure).toBe(true);
    expect(score.passed).toBe(false);
    expect(
      score.details.find(
        (detail) => detail.name === "required:backend-evidence-only"
      )
    ).toMatchObject({
      score: 0
    });
  });

  it("accepts explicit required-term variants without broad fuzzy matching", () => {
    const benchmarkCase = mustCase("long-tool-output-one-durable-fact");
    const output = passingOutput(benchmarkCase);
    output.facts = [
      "The smoke output explicitly labeled migration 0012_memory_nodes_backfill as the first migration that requires a fresh local reset in the MVP branch."
    ];

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(score.criticalFailure).toBe(false);
    expect(
      score.details.find((detail) => detail.name === "required:migration-reset")
    ).toMatchObject({
      score: 4
    });
  });

  it("fails wrong field placement for critical claims", () => {
    const benchmarkCase = mustCase("exact-identifiers-files-commands-env");
    const output = passingOutput(benchmarkCase);
    output.files = [];
    output.facts.push("docs/codex-integration.md");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(score.criticalFailure).toBe(true);
    expect(
      score.details.find((detail) => detail.name === "field:codex-doc")
    ).toMatchObject({
      score: 0
    });
  });

  it("summarizes strict aggregate pass state", () => {
    const firstCase = mustCase("accepted-decision-ai-client-synthesis");
    const first = scoreLcmSummaryRun(firstCase, {
      caseId: firstCase.id,
      runIndex: 0,
      output: passingOutput(firstCase)
    });
    const second = scoreLcmSummaryRun(firstCase, {
      caseId: firstCase.id,
      runIndex: 1,
      output: "not json"
    });

    const summary = summarizeLcmSummaryBenchmark([first, second]);
    expect(summary.validJsonRate).toBe(0.5);
    expect(summary.criticalFailureCount).toBe(1);
    expect(summary.passed).toBe(false);
  });

  it("weights non-critical forbidden claims below critical forbidden claims", () => {
    const benchmarkCase = mustCase("long-tool-output-one-durable-fact");
    const output = passingOutput(benchmarkCase);
    output.facts.push("checking table 001 ok");

    const score = scoreLcmSummaryRun(benchmarkCase, {
      caseId: benchmarkCase.id,
      runIndex: 0,
      output
    });

    expect(
      score.details.find(
        (detail) => detail.name === "forbidden:all-tables-important"
      )
    ).toMatchObject({
      score: 0,
      maxScore: 2,
      critical: false
    });
  });
});

describe("LCM summary generation live runner", () => {
  it("runs a selected case through an injected runner without invoking Codex", async () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const report = await runLcmSummaryBenchmark({
      caseIds: [benchmarkCase.id],
      runs: 1,
      config: resolveLcmSummaryWorkerConfig(process.env, {
        model: "codex-app-server:test"
      }),
      runner: async () => ({
        text: JSON.stringify(passingOutput(benchmarkCase)),
        model: "codex-app-server:test"
      })
    });

    expect(report.cases).toEqual([benchmarkCase.id]);
    expect(report.runInputs).toHaveLength(1);
    expect(report.passed).toBe(true);
  });

  it("rejects unknown selected case ids", async () => {
    await expect(
      runLcmSummaryBenchmark({
        caseIds: ["accepted-decision-ai-client-synthesis", "typo"],
        runs: 1,
        config: resolveLcmSummaryWorkerConfig(process.env, {
          model: "codex-app-server:test"
        }),
        runner: async () => ({
          text: JSON.stringify(
            passingOutput(mustCase("accepted-decision-ai-client-synthesis"))
          ),
          model: "codex-app-server:test"
        })
      })
    ).rejects.toThrow("Unknown LCM summary benchmark case id(s): typo");
  });

  it("redacts configured forbidden literals from reports without hiding failures", async () => {
    const benchmarkCase = mustCase("secret-like-value-redaction");
    const report = await runLcmSummaryBenchmark({
      caseIds: [benchmarkCase.id],
      runs: 1,
      config: resolveLcmSummaryWorkerConfig(process.env, {
        model: "codex-app-server:test"
      }),
      runner: async () => ({
        text: JSON.stringify({
          ...passingOutput(benchmarkCase),
          facts: ["koed_live_secret_abc123"]
        }),
        model: "codex-app-server:test"
      })
    });

    const serialized = JSON.stringify(report);
    expect(report.passed).toBe(false);
    expect(serialized).not.toContain("koed_live_secret_abc123");
    expect(serialized).toContain("[REDACTED]");
    expect(
      report.runs[0]?.details.find(
        (detail) => detail.name === "forbidden:literal-token"
      )
    ).toMatchObject({
      score: 0
    });
  });
});

describe("LCM summary generation CLI options", () => {
  it("requires values for value-taking flags", () => {
    expect(lcmSummaryOptionValue(["--case", "one"], "--case")).toBe("one");
    expect(() => lcmSummaryOptionValue(["--case"], "--case")).toThrow(
      "--case requires a value"
    );
    expect(() =>
      lcmSummaryOptionValue(["--case", "--runs", "1"], "--case")
    ).toThrow("--case requires a value");
  });

  it("validates runs", () => {
    expect(parseLcmSummaryRunsOption(undefined)).toBeUndefined();
    expect(parseLcmSummaryRunsOption("1")).toBe(1);
    expect(parseLcmSummaryRunsOption("3")).toBe(3);
    expect(() => parseLcmSummaryRunsOption("0")).toThrow("--runs");
    expect(() => parseLcmSummaryRunsOption("-1")).toThrow("--runs");
    expect(() => parseLcmSummaryRunsOption("1.5")).toThrow("--runs");
    expect(() => parseLcmSummaryRunsOption("nope")).toThrow("--runs");
  });

  it("validates threshold", () => {
    expect(parseLcmSummaryThresholdOption(undefined)).toBeUndefined();
    expect(parseLcmSummaryThresholdOption("0")).toBe(0);
    expect(parseLcmSummaryThresholdOption("0.9")).toBe(0.9);
    expect(parseLcmSummaryThresholdOption("1")).toBe(1);
    expect(() => parseLcmSummaryThresholdOption("-0.1")).toThrow("--threshold");
    expect(() => parseLcmSummaryThresholdOption("1.1")).toThrow("--threshold");
    expect(() => parseLcmSummaryThresholdOption("nope")).toThrow("--threshold");
  });
});
