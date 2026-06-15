import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLcmSummaryWorkerConfig } from "@koed/mcp-server";
import { runLcmSummaryBenchmark } from "./runner.js";

const args = process.argv.slice(2);

const optionValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const selectedCaseIds = optionValue("--case")
  ?.split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const runsOverride = optionValue("--runs")
  ? Number.parseInt(optionValue("--runs")!, 10)
  : undefined;
const threshold = optionValue("--threshold")
  ? Number.parseFloat(optionValue("--threshold")!)
  : undefined;
const model =
  optionValue("--model") ??
  process.env.MEMORY_LCM_SUMMARY_MODEL ??
  "gpt-5.4-mini";
const reasoningEffort =
  optionValue("--reasoning-effort") ??
  process.env.MEMORY_LCM_SUMMARY_REASONING_EFFORT ??
  "medium";
const codexBinary =
  optionValue("--codex") ?? process.env.MEMORY_LCM_CODEX_BINARY;
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "../../../..");
const outputPath =
  optionValue("--out") ??
  join(
    repositoryRoot,
    "benchmarks",
    "lcm-summary-generation",
    "artifacts",
    `lcm-summary-generation-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`
  );

const config = resolveLcmSummaryWorkerConfig(process.env, {
  model,
  reasoningEffort,
  ...(codexBinary ? { appServerBinary: codexBinary } : {})
});

const report = await runLcmSummaryBenchmark({
  config,
  caseIds: selectedCaseIds,
  runs: Number.isFinite(runsOverride) ? runsOverride : undefined,
  threshold
});

const serialized = `${JSON.stringify(report, null, 2)}\n`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized);
console.error(`Wrote LCM summary generation benchmark report to ${outputPath}`);
console.log(serialized);

if (!report.passed) {
  process.exitCode = 1;
}
