import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLcmSummaryWorkerConfig } from "@koed/mcp-server";
import {
  lcmSummaryOptionValue,
  parseLcmSummaryRunsOption,
  parseLcmSummaryThresholdOption
} from "./cli-options.js";
import { lcmSummaryBenchmarkCases } from "./cases.js";
import {
  lcmSummaryBenchmarkReportRedactions,
  redactLcmSummaryBenchmarkValue
} from "./redaction.js";
import { runLcmSummaryBenchmark } from "./runner.js";
import { runLcmSummarySemanticJudgeReport } from "./semantic-judge.js";

const args = process.argv.slice(2);

const optionValue = (name: string): string | undefined =>
  lcmSummaryOptionValue(args, name);

const selectedCaseIds = optionValue("--case")
  ?.split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const runsOverride = parseLcmSummaryRunsOption(optionValue("--runs"));
const threshold = parseLcmSummaryThresholdOption(optionValue("--threshold"));
const semanticJudgeEnabled = args.includes("--semantic-judge");
const judgeThreshold = parseLcmSummaryThresholdOption(
  optionValue("--judge-threshold"),
  "--judge-threshold"
);
const model = optionValue("--model");
const reasoningEffort = optionValue("--reasoning-effort");
const judgeModel = optionValue("--judge-model");
const judgeReasoningEffort = optionValue("--judge-reasoning-effort");
const codexBinary = optionValue("--codex");
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "../../../..");
const outputOption = optionValue("--out");
const outputPath = outputOption
  ? resolve(repositoryRoot, outputOption)
  : join(
      repositoryRoot,
      "benchmarks",
      "lcm-summary-generation",
      "artifacts",
      `lcm-summary-generation-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.json`
    );

const config = resolveLcmSummaryWorkerConfig(process.env, {
  ...(model ? { model } : {}),
  ...(reasoningEffort ? { reasoningEffort } : {}),
  ...(codexBinary ? { executablePath: codexBinary } : {})
});

const report = await runLcmSummaryBenchmark({
  config,
  caseIds: selectedCaseIds,
  runs: runsOverride,
  threshold,
  redactReport: !semanticJudgeEnabled
});

const finalReport = semanticJudgeEnabled
  ? {
      ...report,
      semanticJudge: await runLcmSummarySemanticJudgeReport({
        report,
        config: {
          appServerBinary: config.executablePath,
          model: judgeModel ?? config.model,
          reasoningEffort: judgeReasoningEffort ?? config.reasoningEffort,
          timeoutMs: config.timeoutMs,
          maxAttempts: config.maxAttempts,
          retryDelayMs: config.retryDelayMs,
          cwd: config.cwd,
          env: config.env
        },
        ...(judgeThreshold === undefined ? {} : { threshold: judgeThreshold })
      })
    }
  : report;

const selectedCases =
  selectedCaseIds && selectedCaseIds.length > 0
    ? lcmSummaryBenchmarkCases.filter((benchmarkCase) =>
        selectedCaseIds.includes(benchmarkCase.id)
      )
    : lcmSummaryBenchmarkCases;
const serializableReport = redactLcmSummaryBenchmarkValue(
  finalReport,
  lcmSummaryBenchmarkReportRedactions(selectedCases)
);
const serialized = `${JSON.stringify(serializableReport, null, 2)}\n`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized);
console.error(`Wrote LCM summary generation benchmark report to ${outputPath}`);
console.log(serialized);

if (!report.passed) {
  process.exitCode = 1;
}
