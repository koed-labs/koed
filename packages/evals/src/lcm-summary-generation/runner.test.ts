import { describe, expect, it } from "vitest";
import { resolveLcmSummaryWorkerConfig } from "@koed/mcp-server";
import { runLcmSummaryBenchmark } from "./runner.js";
import { mustCase, passingOutput } from "./test-helpers.js";

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
    expect("semanticJudge" in report).toBe(false);
  });

  it("retries transient summary runner failures before scoring", async () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    let calls = 0;
    const report = await runLcmSummaryBenchmark({
      caseIds: [benchmarkCase.id],
      runs: 1,
      config: resolveLcmSummaryWorkerConfig(process.env, {
        model: "codex-app-server:test",
        maxAttempts: 2,
        retryDelayMs: 0
      }),
      runner: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("stream disconnected before completion");
        }
        return {
          text: JSON.stringify(passingOutput(benchmarkCase)),
          model: "codex-app-server:test"
        };
      }
    });

    expect(calls).toBe(2);
    expect(report.passed).toBe(true);
    expect(report.runInputs[0]?.error).toBeUndefined();
  });

  it("retries invalid summary JSON before scoring", async () => {
    const benchmarkCase = mustCase("accepted-decision-ai-client-synthesis");
    let calls = 0;
    const report = await runLcmSummaryBenchmark({
      caseIds: [benchmarkCase.id],
      runs: 1,
      config: resolveLcmSummaryWorkerConfig(process.env, {
        model: "codex-app-server:test",
        maxAttempts: 2,
        retryDelayMs: 0
      }),
      runner: async () => {
        calls += 1;
        return {
          text:
            calls === 1
              ? "not json"
              : JSON.stringify(passingOutput(benchmarkCase)),
          model: "codex-app-server:test"
        };
      }
    });

    expect(calls).toBe(2);
    expect(report.passed).toBe(true);
    expect(report.runInputs[0]?.output).not.toBe("not json");
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
          summary_text: `${passingOutput(benchmarkCase).summary_text} koed_live_secret_abc123`
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
