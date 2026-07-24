import { performance } from "node:perf_hooks";
import { parseStructuredLcmSummary } from "@koed/core";
import {
  buildLcmSummaryPrompt,
  resolveLcmSummaryWorkerConfig,
  runCodexAppServerLcmSummary,
  type CodexLcmSummaryRunner,
  type LcmSummaryWorkerConfig
} from "@koed/mcp-server";
import { runWithAttempts } from "./attempts.js";
import {
  scoreLcmSummaryRun,
  summarizeLcmSummaryBenchmark,
  type LcmSummaryBenchmarkRunInput,
  type LcmSummaryBenchmarkSummary
} from "./benchmark.js";
import {
  lcmSummaryBenchmarkCases,
  type LcmSummaryBenchmarkCase
} from "./cases.js";
import {
  lcmSummaryBenchmarkReportRedactions,
  redactLcmSummaryBenchmarkValue
} from "./redaction.js";

export interface LcmSummaryBenchmarkRunOptions {
  config?: LcmSummaryWorkerConfig;
  runner?: CodexLcmSummaryRunner;
  runs?: number;
  caseIds?: string[];
  threshold?: number;
  redactReport?: boolean;
}

export interface LcmSummaryBenchmarkReport extends LcmSummaryBenchmarkSummary {
  benchmark: "lcm-summary-generation";
  generatedAt: string;
  model: string;
  reasoningEffort: string;
  cases: string[];
  runInputs: LcmSummaryBenchmarkRunInput[];
}

const selectedCases = (
  caseIds: string[] | undefined
): LcmSummaryBenchmarkCase[] => {
  const selected = new Set(caseIds ?? []);
  const known = new Set(
    lcmSummaryBenchmarkCases.map((benchmarkCase) => benchmarkCase.id)
  );
  const unknown = [...selected].filter((caseId) => !known.has(caseId));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown LCM summary benchmark case id(s): ${unknown.join(", ")}`
    );
  }
  const cases =
    selected.size > 0
      ? lcmSummaryBenchmarkCases.filter((benchmarkCase) =>
          selected.has(benchmarkCase.id)
        )
      : lcmSummaryBenchmarkCases;
  if (cases.length === 0) {
    throw new Error("No LCM summary benchmark cases selected");
  }
  return cases;
};

export const runLcmSummaryBenchmarkCase = async (
  benchmarkCase: LcmSummaryBenchmarkCase,
  runIndex: number,
  options: {
    config: LcmSummaryWorkerConfig;
    runner?: CodexLcmSummaryRunner;
  }
): Promise<LcmSummaryBenchmarkRunInput> => {
  const runner = options.runner ?? runCodexAppServerLcmSummary;
  const prompt = buildLcmSummaryPrompt(benchmarkCase.node);
  const started = performance.now();
  let lastText = "";

  try {
    const result = await runWithAttempts(
      {
        maxAttempts: options.config.maxAttempts,
        retryDelayMs: options.config.retryDelayMs,
        timeoutMs: options.config.timeoutMs
      },
      async ({ timeoutMs }) => {
        const result = await runner(prompt, options.config, timeoutMs);
        lastText = result.text;
        parseStructuredLcmSummary(result.text);
        return result;
      }
    );
    return {
      caseId: benchmarkCase.id,
      runIndex,
      output: result.text,
      latencyMs: Math.round(performance.now() - started),
      model: result.model,
      tokenUsage: result.tokenUsage
    };
  } catch (error) {
    return {
      caseId: benchmarkCase.id,
      runIndex,
      output: lastText,
      latencyMs: Math.round(performance.now() - started),
      model: options.config.model,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

export const redactLcmSummaryBenchmarkReport = (
  report: LcmSummaryBenchmarkReport,
  cases: LcmSummaryBenchmarkCase[]
): LcmSummaryBenchmarkReport =>
  redactLcmSummaryBenchmarkValue(
    report,
    lcmSummaryBenchmarkReportRedactions(cases)
  ) as LcmSummaryBenchmarkReport;

export const runLcmSummaryBenchmark = async (
  options: LcmSummaryBenchmarkRunOptions = {}
): Promise<LcmSummaryBenchmarkReport> => {
  const config = options.config ?? resolveLcmSummaryWorkerConfig();
  const cases = selectedCases(options.caseIds);
  const runInputs: LcmSummaryBenchmarkRunInput[] = [];

  for (const benchmarkCase of cases) {
    const runs = options.runs ?? benchmarkCase.runs ?? 1;
    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      runInputs.push(
        await runLcmSummaryBenchmarkCase(benchmarkCase, runIndex, {
          config,
          runner: options.runner
        })
      );
    }
  }

  const caseById = new Map(
    lcmSummaryBenchmarkCases.map((benchmarkCase) => [
      benchmarkCase.id,
      benchmarkCase
    ])
  );
  const scores = runInputs.map((run) =>
    scoreLcmSummaryRun(caseById.get(run.caseId)!, run, {
      threshold: options.threshold
    })
  );
  const summary = summarizeLcmSummaryBenchmark(scores, {
    threshold: options.threshold
  });
  const report: LcmSummaryBenchmarkReport = {
    benchmark: "lcm-summary-generation",
    generatedAt: new Date().toISOString(),
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    cases: cases.map((benchmarkCase) => benchmarkCase.id),
    runInputs,
    ...summary
  };
  return options.redactReport === false
    ? report
    : redactLcmSummaryBenchmarkReport(report, cases);
};
