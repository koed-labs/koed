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

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const redactString = (value: string, redactions: string[]): string =>
  redactions.reduce(
    (current, redaction) =>
      current.replace(new RegExp(escapeRegExp(redaction), "gi"), "[REDACTED]"),
    value
  );

const redactValue = (value: unknown, redactions: string[]): unknown => {
  if (redactions.length === 0) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, redactions);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redactions));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, redactions)
      ])
    );
  }
  return value;
};

const reportRedactions = (cases: LcmSummaryBenchmarkCase[]): string[] => [
  ...new Set(
    cases.flatMap(
      (benchmarkCase) =>
        benchmarkCase.expected.forbiddenClaims
          ?.filter((claim) => claim.redactInReports === true)
          .flatMap((claim) => [claim.text, ...(claim.aliases ?? [])]) ?? []
    )
  )
];

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
  const summary = summarizeLcmSummaryBenchmark(scores, {
    threshold: options.threshold
  });
  const redactions = reportRedactions(cases);
  const redactedSummary = redactValue(
    summary,
    redactions
  ) as LcmSummaryBenchmarkSummary;
  return {
    benchmark: "lcm-summary-generation",
    generatedAt: new Date().toISOString(),
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    cases: cases.map((benchmarkCase) => benchmarkCase.id),
    runInputs: redactValue(
      runInputs,
      redactions
    ) as LcmSummaryBenchmarkRunInput[],
    ...redactedSummary
  };
};
