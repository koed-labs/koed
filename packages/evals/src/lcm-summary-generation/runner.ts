import { performance } from "node:perf_hooks";
import {
  buildLcmSummaryPrompt,
  resolveLcmSummaryWorkerConfig,
  runCodexAppServerLcmSummary,
  type CodexLcmSummaryRunner,
  type LcmSummaryWorkerConfig
} from "@koed/mcp-server";
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

export interface LcmSummaryBenchmarkRunOptions {
  config?: LcmSummaryWorkerConfig;
  runner?: CodexLcmSummaryRunner;
  runs?: number;
  caseIds?: string[];
  threshold?: number;
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
  try {
    const result = await runner(
      prompt,
      options.config,
      options.config.timeoutMs
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
      output: "",
      latencyMs: Math.round(performance.now() - started),
      model: options.config.model,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

export const runLcmSummaryBenchmark = async (
  options: LcmSummaryBenchmarkRunOptions = {}
): Promise<LcmSummaryBenchmarkReport> => {
  const config = options.config ?? resolveLcmSummaryWorkerConfig();
  const cases = selectedCases(options.caseIds);
  const runInputs: LcmSummaryBenchmarkRunInput[] = [];

  for (const benchmarkCase of cases) {
    const runs = options.runs ?? benchmarkCase.runs;
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
  return {
    benchmark: "lcm-summary-generation",
    generatedAt: new Date().toISOString(),
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    cases: cases.map((benchmarkCase) => benchmarkCase.id),
    runInputs,
    ...summarizeLcmSummaryBenchmark(scores, { threshold: options.threshold })
  };
};
