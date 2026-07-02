import { describe, expect, it } from "vitest";
import { resolveLcmSummaryWorkerConfig } from "@koed/mcp-server";
import { runLcmSummaryBenchmark } from "./runner.js";
import {
  LCM_SUMMARY_SEMANTIC_JUDGE_SCHEMA_VERSION,
  parseLcmSummarySemanticJudgeOutput,
  runLcmSummarySemanticJudgeReport,
  summarizeLcmSummarySemanticJudge,
  type LcmSummarySemanticJudgePromptResult
} from "./semantic-judge.js";
import { mustCase, passingJudgeOutput, passingOutput } from "./test-helpers.js";

describe("LCM summary semantic judge", () => {
  it("parses strict semantic judge JSON", () => {
    const parsed = parseLcmSummarySemanticJudgeOutput(passingJudgeOutput());

    expect(parsed.schema_version).toBe(
      LCM_SUMMARY_SEMANTIC_JUDGE_SCHEMA_VERSION
    );
    expect(parsed.verdict).toBe("pass");
    expect(parsed.score).toBe(0.94);
  });

  it("rejects invalid semantic judge JSON", () => {
    expect(() => parseLcmSummarySemanticJudgeOutput("not json")).toThrow(
      "Invalid semantic judge JSON"
    );
  });

  it("rejects wrong semantic judge schema versions", () => {
    expect(() =>
      parseLcmSummarySemanticJudgeOutput(
        passingJudgeOutput({ schema_version: "wrong" })
      )
    ).toThrow();
  });

  it("rejects out-of-range semantic judge scores", () => {
    expect(() =>
      parseLcmSummarySemanticJudgeOutput(passingJudgeOutput({ score: 1.1 }))
    ).toThrow();
  });

  it("rejects unknown semantic judge verdicts", () => {
    expect(() =>
      parseLcmSummarySemanticJudgeOutput(
        passingJudgeOutput({ verdict: "maybe" })
      )
    ).toThrow();
  });

  it("summarizes aggregate semantic judge metrics", () => {
    const summary = summarizeLcmSummarySemanticJudge({
      model: "codex-app-server:test",
      reasoningEffort: "medium",
      threshold: 0.85,
      runs: [
        {
          caseId: "a",
          runIndex: 0,
          status: "judged",
          threshold: 0.85,
          verdict: "pass",
          score: 0.9,
          passed: true
        },
        {
          caseId: "b",
          runIndex: 0,
          status: "judged",
          threshold: 0.85,
          verdict: "warn",
          score: 0.7,
          passed: false
        },
        {
          caseId: "c",
          runIndex: 0,
          status: "judged",
          threshold: 0.85,
          verdict: "fail",
          score: 0.2,
          passed: false
        },
        {
          caseId: "d",
          runIndex: 0,
          status: "judged",
          threshold: 0.85,
          verdict: "pass",
          score: 0.8,
          passed: false
        },
        {
          caseId: "e",
          runIndex: 0,
          status: "skipped",
          threshold: 0.85,
          skippedReason: "invalid_summary"
        }
      ]
    });

    expect(summary.averageScore).toBeCloseTo(0.65);
    expect(summary.passCount).toBe(1);
    expect(summary.warnCount).toBe(1);
    expect(summary.failCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
    expect(summary.advisoryPassRate).toBeCloseTo(1 / 4);
  });

  it("adds advisory semantic judge results through an injected judge runner", async () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    const judgePrompts: string[] = [];
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
    const semanticJudge = await runLcmSummarySemanticJudgeReport({
      report,
      threshold: 0.85,
      config: {
        appServerBinary: "codex",
        model: "codex-app-server:test",
        reasoningEffort: "medium",
        timeoutMs: 1_000,
        cwd: process.cwd(),
        env: process.env
      },
      runner: async (prompt): Promise<LcmSummarySemanticJudgePromptResult> => {
        judgePrompts.push(prompt);
        return {
          text: passingJudgeOutput(),
          model: "codex-app-server:judge"
        };
      }
    });

    expect("semanticJudge" in report).toBe(false);
    expect(semanticJudge).toMatchObject({
      enabled: true,
      threshold: 0.85,
      model: "codex-app-server:test",
      passCount: 1,
      warnCount: 0,
      failCount: 0,
      advisoryPassRate: 1
    });
    expect(semanticJudge.runs[0]).toMatchObject({
      caseId: benchmarkCase.id,
      status: "judged",
      verdict: "pass",
      passed: true,
      model: "codex-app-server:judge"
    });
    expect(judgePrompts[0]).toContain("Judge the semantic quality");
  });

  it("retries transient semantic judge runner failures", async () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    let judgeCalls = 0;
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
    const semanticJudge = await runLcmSummarySemanticJudgeReport({
      report,
      config: {
        appServerBinary: "codex",
        model: "codex-app-server:test",
        reasoningEffort: "medium",
        timeoutMs: 1_000,
        maxAttempts: 2,
        retryDelayMs: 0,
        cwd: process.cwd(),
        env: process.env
      },
      runner: async (): Promise<LcmSummarySemanticJudgePromptResult> => {
        judgeCalls += 1;
        if (judgeCalls === 1) {
          throw new Error("stream disconnected before completion");
        }
        return {
          text: passingJudgeOutput(),
          model: "codex-app-server:judge"
        };
      }
    });

    expect(judgeCalls).toBe(2);
    expect(semanticJudge.errorCount).toBe(0);
    expect(semanticJudge.runs[0]).toMatchObject({
      status: "judged",
      verdict: "pass"
    });
  });

  it("retries invalid semantic judge JSON", async () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    let judgeCalls = 0;
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
    const semanticJudge = await runLcmSummarySemanticJudgeReport({
      report,
      config: {
        appServerBinary: "codex",
        model: "codex-app-server:test",
        reasoningEffort: "medium",
        timeoutMs: 1_000,
        maxAttempts: 2,
        retryDelayMs: 0,
        cwd: process.cwd(),
        env: process.env
      },
      runner: async (): Promise<LcmSummarySemanticJudgePromptResult> => {
        judgeCalls += 1;
        return {
          text: judgeCalls === 1 ? "not json" : passingJudgeOutput(),
          model: "codex-app-server:judge"
        };
      }
    });

    expect(judgeCalls).toBe(2);
    expect(semanticJudge.errorCount).toBe(0);
    expect(semanticJudge.runs[0]).toMatchObject({
      status: "judged",
      verdict: "pass"
    });
  });

  it("runs semantic judge calls sequentially", async () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    let activeJudgeCalls = 0;
    let maxActiveJudgeCalls = 0;
    const report = await runLcmSummaryBenchmark({
      caseIds: [benchmarkCase.id],
      runs: 2,
      config: resolveLcmSummaryWorkerConfig(process.env, {
        model: "codex-app-server:test"
      }),
      runner: async () => ({
        text: JSON.stringify(passingOutput(benchmarkCase)),
        model: "codex-app-server:test"
      })
    });
    const semanticJudge = await runLcmSummarySemanticJudgeReport({
      report,
      config: {
        appServerBinary: "codex",
        model: "codex-app-server:test",
        reasoningEffort: "medium",
        timeoutMs: 1_000,
        cwd: process.cwd(),
        env: process.env
      },
      runner: async (): Promise<LcmSummarySemanticJudgePromptResult> => {
        activeJudgeCalls += 1;
        maxActiveJudgeCalls = Math.max(maxActiveJudgeCalls, activeJudgeCalls);
        await Promise.resolve();
        activeJudgeCalls -= 1;
        return {
          text: passingJudgeOutput(),
          model: "codex-app-server:judge"
        };
      }
    });

    expect(semanticJudge.runs).toHaveLength(2);
    expect(maxActiveJudgeCalls).toBe(1);
  });

  it("skips semantic judging when deterministic output is invalid", async () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    let judgeCalls = 0;
    const report = await runLcmSummaryBenchmark({
      caseIds: [benchmarkCase.id],
      runs: 1,
      config: resolveLcmSummaryWorkerConfig(process.env, {
        model: "codex-app-server:test"
      }),
      runner: async () => ({
        text: "not json",
        model: "codex-app-server:test"
      })
    });
    const semanticJudge = await runLcmSummarySemanticJudgeReport({
      report,
      config: {
        appServerBinary: "codex",
        model: "codex-app-server:test",
        reasoningEffort: "medium",
        timeoutMs: 1_000,
        cwd: process.cwd(),
        env: process.env
      },
      runner: async () => {
        judgeCalls += 1;
        return {
          text: passingJudgeOutput(),
          model: "codex-app-server:judge"
        };
      }
    });

    expect(report.passed).toBe(false);
    expect(judgeCalls).toBe(0);
    expect(semanticJudge.runs[0]).toMatchObject({
      status: "skipped",
      skippedReason: "invalid_summary"
    });
  });

  it("redacts configured forbidden literals from semantic judge reports", async () => {
    const benchmarkCase = mustCase("secret-like-value-redaction");
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
    const semanticJudge = await runLcmSummarySemanticJudgeReport({
      report,
      config: {
        appServerBinary: "codex",
        model: "codex-app-server:test",
        reasoningEffort: "medium",
        timeoutMs: 1_000,
        cwd: process.cwd(),
        env: process.env
      },
      runner: async () => ({
        text: passingJudgeOutput({
          issues: [
            {
              severity: "high",
              category: "koed_live_secret_abc123",
              note: "The summary mentions koed_live_secret_abc123."
            }
          ],
          rationale: "The literal koed_live_secret_abc123 leaked."
        }),
        model: "codex-app-server:judge",
        tokenUsage: {
          koed_live_secret_abc123: "unexpected passthrough key"
        }
      })
    });

    const serialized = JSON.stringify(semanticJudge);
    expect(serialized).not.toContain("koed_live_secret_abc123");
    expect(serialized).toContain("[REDACTED]");
    expect(semanticJudge.runs[0]).toMatchObject({
      status: "judged",
      verdict: "pass",
      passed: false
    });
  });

  it("can judge unredacted raw reports before redacting judge output", async () => {
    const benchmarkCase = mustCase("secret-like-value-redaction");
    const report = await runLcmSummaryBenchmark({
      caseIds: [benchmarkCase.id],
      runs: 1,
      redactReport: false,
      config: resolveLcmSummaryWorkerConfig(process.env, {
        model: "codex-app-server:test"
      }),
      runner: async () => ({
        text: JSON.stringify({
          ...passingOutput(benchmarkCase),
          facts: ["The API Token was rotated.", "koed_live_secret_abc123"]
        }),
        model: "codex-app-server:test"
      })
    });
    let judgePrompt = "";
    const semanticJudge = await runLcmSummarySemanticJudgeReport({
      report,
      config: {
        appServerBinary: "codex",
        model: "codex-app-server:test",
        reasoningEffort: "medium",
        timeoutMs: 1_000,
        cwd: process.cwd(),
        env: process.env
      },
      runner: async (prompt) => {
        judgePrompt = prompt;
        return {
          text: passingJudgeOutput({
            issues: [
              {
                severity: "high",
                category: "koed_live_secret_abc123",
                note: "The summary mentions koed_live_secret_abc123."
              }
            ],
            rationale: "The literal koed_live_secret_abc123 leaked."
          }),
          model: "codex-app-server:judge"
        };
      }
    });

    expect(judgePrompt).toContain("koed_live_secret_abc123");
    expect(JSON.stringify(semanticJudge)).not.toContain(
      "koed_live_secret_abc123"
    );
    expect(semanticJudge.runs[0]).toMatchObject({
      status: "judged",
      passed: false
    });
  });
});
