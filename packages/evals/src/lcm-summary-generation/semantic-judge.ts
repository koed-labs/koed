import { performance } from "node:perf_hooks";
import type { StructuredLcmSummary } from "@koed/core";
import {
  loadPrompt,
  renderPrompt,
  runCodexAppServerJsonTask,
  type CodexAppServerRunResult,
  type LcmSummaryNode
} from "@koed/mcp-server";
import { z } from "zod";
import { runWithAttempts } from "./attempts.js";
import type { LcmSummaryRunScore } from "./benchmark.js";
import {
  lcmSummaryBenchmarkCases,
  type LcmSummaryBenchmarkCase
} from "./cases.js";
import {
  lcmSummaryBenchmarkReportRedactions,
  redactLcmSummaryBenchmarkValue
} from "./redaction.js";
import type { LcmSummaryBenchmarkReport } from "./runner.js";

export const LCM_SUMMARY_SEMANTIC_JUDGE_SCHEMA_VERSION =
  "lcm-summary-semantic-judge-v2";

export const DEFAULT_SEMANTIC_JUDGE_THRESHOLD = 0.85;

export interface LcmSummarySemanticJudgeConfig {
  appServerBinary: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface LcmSummarySemanticJudgePromptResult {
  text: string;
  model: string;
  tokenUsage?: unknown;
}

export type LcmSummarySemanticJudgeRunner = (
  prompt: string,
  config: LcmSummarySemanticJudgeConfig,
  timeoutMs: number
) => Promise<LcmSummarySemanticJudgePromptResult>;

const judgeDimensionSchema = z.number().min(0).max(1);

const semanticJudgeSchema = z
  .object({
    schema_version: z.literal(LCM_SUMMARY_SEMANTIC_JUDGE_SCHEMA_VERSION),
    verdict: z.enum(["pass", "warn", "fail"]),
    score: z.number().min(0).max(1),
    dimensions: z
      .object({
        faithfulness: judgeDimensionSchema,
        durableCoverage: judgeDimensionSchema,
        semanticFocus: judgeDimensionSchema,
        conflictHandling: judgeDimensionSchema,
        compressionQuality: judgeDimensionSchema,
        provenanceUse: judgeDimensionSchema,
        safety: judgeDimensionSchema
      })
      .strict(),
    issues: z.array(
      z
        .object({
          severity: z.enum(["low", "medium", "high"]),
          category: z.string().min(1),
          note: z.string().min(1)
        })
        .strict()
    ),
    rationale: z.string().min(1)
  })
  .strict();

export type LcmSummarySemanticJudgeVerdict = z.infer<
  typeof semanticJudgeSchema
>["verdict"];
export type LcmSummarySemanticJudgeDimensions = z.infer<
  typeof semanticJudgeSchema
>["dimensions"];
export type LcmSummarySemanticJudgeIssue = z.infer<
  typeof semanticJudgeSchema
>["issues"][number];

export interface LcmSummarySemanticJudgeOutput {
  schema_version: typeof LCM_SUMMARY_SEMANTIC_JUDGE_SCHEMA_VERSION;
  verdict: LcmSummarySemanticJudgeVerdict;
  score: number;
  dimensions: LcmSummarySemanticJudgeDimensions;
  issues: LcmSummarySemanticJudgeIssue[];
  rationale: string;
}

export interface LcmSummarySemanticJudgeRunResult {
  caseId: string;
  runIndex: number;
  status: "judged" | "skipped" | "error";
  threshold: number;
  passed?: boolean;
  verdict?: LcmSummarySemanticJudgeVerdict;
  score?: number;
  dimensions?: LcmSummarySemanticJudgeDimensions;
  issues?: LcmSummarySemanticJudgeIssue[];
  rationale?: string;
  latencyMs?: number;
  model?: string;
  tokenUsage?: unknown;
  skippedReason?: "invalid_summary";
  error?: string;
}

export interface LcmSummarySemanticJudgeSummary {
  enabled: true;
  threshold: number;
  model: string;
  reasoningEffort: string;
  runs: LcmSummarySemanticJudgeRunResult[];
  averageScore: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  skippedCount: number;
  errorCount: number;
  advisoryPassRate: number;
}

export const parseLcmSummarySemanticJudgeOutput = (
  output: string
): LcmSummarySemanticJudgeOutput => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Invalid semantic judge JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
  return semanticJudgeSchema.parse(parsed);
};

const sourceNodeForPrompt = (node: LcmSummaryNode): unknown => ({
  id: node.id,
  visibility: node.visibility,
  kind: node.kind,
  depth: node.depth,
  summaryText: node.summaryText,
  sourceTokenEstimate: node.sourceTokenEstimate,
  sourceItems: node.sourceItems
});

export const buildLcmSummarySemanticJudgePrompt = (input: {
  benchmarkCase: LcmSummaryBenchmarkCase;
  summary: StructuredLcmSummary;
  deterministicScore: LcmSummaryRunScore;
  threshold: number;
}): string =>
  renderPrompt("eval-lcm-summary-semantic-judge", {
    threshold: input.threshold,
    required_json_shape: JSON.stringify({
      schema_version: LCM_SUMMARY_SEMANTIC_JUDGE_SCHEMA_VERSION,
      verdict: "pass",
      score: 0.92,
      dimensions: {
        faithfulness: 0.95,
        durableCoverage: 0.9,
        semanticFocus: 0.9,
        conflictHandling: 0.9,
        compressionQuality: 0.9,
        provenanceUse: 0.9,
        safety: 1
      },
      issues: [
        {
          severity: "low",
          category: "compressionQuality",
          note: "Brief issue description."
        }
      ],
      rationale: "One concise explanation of the judgment."
    }),
    benchmark_input_json: JSON.stringify(
      {
        caseId: input.benchmarkCase.id,
        caseName: input.benchmarkCase.name,
        caseNotes: input.benchmarkCase.notes,
        sourceNode: sourceNodeForPrompt(input.benchmarkCase.node),
        candidateSummary: input.summary,
        deterministicScore: {
          score: input.deterministicScore.score,
          maxScore: input.deterministicScore.maxScore,
          scoreRatio: input.deterministicScore.scoreRatio,
          criticalFailure: input.deterministicScore.criticalFailure,
          passed: input.deterministicScore.passed,
          details: input.deterministicScore.details
        }
      },
      null,
      2
    )
  });

const defaultSemanticJudgeRunner: LcmSummarySemanticJudgeRunner = async (
  prompt,
  config,
  timeoutMs
): Promise<CodexAppServerRunResult> =>
  runCodexAppServerJsonTask(
    prompt,
    {
      appServerBinary: config.appServerBinary,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      cwd: config.cwd,
      env: config.env,
      clientName: "koed-evaluation-worker",
      baseInstructions: loadPrompt("ai-client-eval-base").body
    },
    timeoutMs
  );

const hasHighSeverityIssue = (
  issues: LcmSummarySemanticJudgeIssue[]
): boolean => issues.some((issue) => issue.severity === "high");

export const judgeLcmSummaryRun = async (
  benchmarkCase: LcmSummaryBenchmarkCase,
  deterministicScore: LcmSummaryRunScore,
  options: {
    config: LcmSummarySemanticJudgeConfig;
    threshold?: number;
    runner?: LcmSummarySemanticJudgeRunner;
  }
): Promise<LcmSummarySemanticJudgeRunResult> => {
  const threshold = options.threshold ?? DEFAULT_SEMANTIC_JUDGE_THRESHOLD;
  if (!deterministicScore.validJson || !deterministicScore.parsedSummary) {
    return {
      caseId: deterministicScore.caseId,
      runIndex: deterministicScore.runIndex,
      status: "skipped",
      threshold,
      skippedReason: "invalid_summary",
      model: options.config.model
    };
  }

  const prompt = buildLcmSummarySemanticJudgePrompt({
    benchmarkCase,
    summary: deterministicScore.parsedSummary,
    deterministicScore,
    threshold
  });
  const runner = options.runner ?? defaultSemanticJudgeRunner;
  const started = performance.now();

  try {
    const { result, judgment } = await runWithAttempts(
      {
        maxAttempts: options.config.maxAttempts ?? 1,
        retryDelayMs: options.config.retryDelayMs ?? 0,
        timeoutMs: options.config.timeoutMs
      },
      async ({ timeoutMs }) => {
        const result = await runner(prompt, options.config, timeoutMs);
        return {
          result,
          judgment: parseLcmSummarySemanticJudgeOutput(result.text)
        };
      }
    );
    const passed =
      judgment.verdict === "pass" &&
      judgment.score >= threshold &&
      !hasHighSeverityIssue(judgment.issues);
    return {
      caseId: deterministicScore.caseId,
      runIndex: deterministicScore.runIndex,
      status: "judged",
      threshold,
      passed,
      verdict: judgment.verdict,
      score: judgment.score,
      dimensions: judgment.dimensions,
      issues: judgment.issues,
      rationale: judgment.rationale,
      latencyMs: Math.round(performance.now() - started),
      model: result.model,
      tokenUsage: result.tokenUsage
    };
  } catch (error) {
    return {
      caseId: deterministicScore.caseId,
      runIndex: deterministicScore.runIndex,
      status: "error",
      threshold,
      passed: false,
      latencyMs: Math.round(performance.now() - started),
      model: options.config.model,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

export const runLcmSummarySemanticJudgeReport = async (input: {
  report: LcmSummaryBenchmarkReport;
  config: LcmSummarySemanticJudgeConfig;
  threshold?: number;
  runner?: LcmSummarySemanticJudgeRunner;
  cases?: LcmSummaryBenchmarkCase[];
}): Promise<LcmSummarySemanticJudgeSummary> => {
  const caseById = new Map(
    (input.cases ?? lcmSummaryBenchmarkCases).map((benchmarkCase) => [
      benchmarkCase.id,
      benchmarkCase
    ])
  );
  const runs: LcmSummarySemanticJudgeRunResult[] = [];

  for (const score of input.report.runs) {
    const benchmarkCase = caseById.get(score.caseId);
    if (!benchmarkCase) {
      runs.push({
        caseId: score.caseId,
        runIndex: score.runIndex,
        status: "error",
        threshold: input.threshold ?? DEFAULT_SEMANTIC_JUDGE_THRESHOLD,
        passed: false,
        model: input.config.model,
        error: `Unknown LCM summary benchmark case id ${score.caseId}`
      });
      continue;
    }
    runs.push(
      await judgeLcmSummaryRun(benchmarkCase, score, {
        config: input.config,
        threshold: input.threshold,
        runner: input.runner
      })
    );
  }

  const summary = summarizeLcmSummarySemanticJudge({
    runs,
    threshold: input.threshold,
    model: input.config.model,
    reasoningEffort: input.config.reasoningEffort
  });
  const selectedCases = input.report.cases
    .map((caseId) => caseById.get(caseId))
    .filter((benchmarkCase): benchmarkCase is LcmSummaryBenchmarkCase =>
      Boolean(benchmarkCase)
    );
  return redactLcmSummaryBenchmarkValue(
    summary,
    lcmSummaryBenchmarkReportRedactions(selectedCases)
  ) as LcmSummarySemanticJudgeSummary;
};

export const summarizeLcmSummarySemanticJudge = (input: {
  runs: LcmSummarySemanticJudgeRunResult[];
  threshold?: number;
  model: string;
  reasoningEffort: string;
}): LcmSummarySemanticJudgeSummary => {
  const judgedRuns = input.runs.filter(
    (run) => run.status === "judged" && typeof run.score === "number"
  );
  const totalScore = judgedRuns.reduce((sum, run) => sum + (run.score ?? 0), 0);
  const passCount = input.runs.filter((run) => run.passed === true).length;
  const warnCount = input.runs.filter((run) => run.verdict === "warn").length;
  const failCount = input.runs.filter((run) => run.verdict === "fail").length;
  const skippedCount = input.runs.filter(
    (run) => run.status === "skipped"
  ).length;
  const errorCount = input.runs.filter((run) => run.status === "error").length;

  return {
    enabled: true,
    threshold: input.threshold ?? DEFAULT_SEMANTIC_JUDGE_THRESHOLD,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    runs: input.runs,
    averageScore: judgedRuns.length > 0 ? totalScore / judgedRuns.length : 0,
    passCount,
    warnCount,
    failCount,
    skippedCount,
    errorCount,
    advisoryPassRate:
      judgedRuns.length > 0
        ? judgedRuns.filter((run) => run.passed === true).length /
          judgedRuns.length
        : 0
  };
};
