import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runLiveRetrievalSuccessBenchmark,
  type LiveRetrievalSuccessComparisonReport,
  type LiveRetrievalSuccessReport
} from "../retrieval-success/live-runner.js";

const usage = [
  "Usage:",
  "  pnpm --filter @koed/evals eval:memory-recall:live -- --database-url <postgres-url> [--tool-choice-runs 1] [--retrieval-runs 1] [--out report.json]",
  "",
  "Runs one professional recall benchmark report with two sections:",
  "  1. KOE-99 tool-choice live benchmark against a fake Koed MCP server.",
  "  2. KOE-167 retrieval-success live benchmark against a temporary DB and deterministic embedding service.",
  "",
  "Use --skip-tool-choice or --skip-retrieval only for local debugging."
].join("\n");

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface UnifiedMemoryRecallReport {
  suite: "memory-recall-live";
  generatedAt: string;
  toolChoice: unknown | null;
  retrievalSuccess:
    | LiveRetrievalSuccessReport
    | LiveRetrievalSuccessComparisonReport
    | null;
  combined: {
    totalScore: number;
    maxScore: number;
    averageScoreRatio: number;
  };
}

const args = process.argv.slice(2);

const optionValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const runCommand = (
  command: string,
  commandArgs: string[],
  options: { cwd: string; timeoutMs: number }
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode });
    });
  });

const parsePositiveInt = (name: string): number | undefined => {
  const value = optionValue(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const runToolChoiceLive = async (): Promise<unknown> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koed-memory-recall-"));
  const outputPath = path.join(root, "tool-choice-report.json");
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const toolChoiceRunner = path.resolve(
    currentDir,
    "../tool-choice/live-runner.js"
  );
  const commandArgs = [toolChoiceRunner, "--out", outputPath];
  const runs = parsePositiveInt("--tool-choice-runs");
  if (runs) {
    commandArgs.push("--runs", String(runs));
  }
  const selectedCase = optionValue("--tool-choice-case");
  if (selectedCase) {
    commandArgs.push("--case", selectedCase);
  }

  try {
    const result = await runCommand(process.execPath, commandArgs, {
      cwd: process.cwd(),
      timeoutMs: 30 * 60 * 1000
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `tool-choice live benchmark exited ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
      );
    }
    return JSON.parse(await readFile(outputPath, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const scoreTotals = (
  section: unknown
): { totalScore: number; maxScore: number } => {
  if (!section || typeof section !== "object") {
    return { totalScore: 0, maxScore: 0 };
  }
  const record = section as Record<string, unknown>;
  const summary =
    record.summary && typeof record.summary === "object"
      ? (record.summary as Record<string, unknown>)
      : record;
  const totalScore =
    typeof summary.totalScore === "number" ? summary.totalScore : 0;
  const maxScore = typeof summary.maxScore === "number" ? summary.maxScore : 0;
  return { totalScore, maxScore };
};

const runUnifiedBenchmark = async (): Promise<UnifiedMemoryRecallReport> => {
  const toolChoice = args.includes("--skip-tool-choice")
    ? null
    : await runToolChoiceLive();
  const retrievalSuccess = args.includes("--skip-retrieval")
    ? null
    : await runLiveRetrievalSuccessBenchmark({
        databaseUrl: optionValue("--database-url"),
        keepDatabase: args.includes("--keep-database"),
        runs: parsePositiveInt("--retrieval-runs"),
        caseIds: optionValue("--retrieval-case")
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      });

  const toolChoiceTotals = scoreTotals(toolChoice);
  const retrievalTotals = scoreTotals(retrievalSuccess);
  const totalScore = toolChoiceTotals.totalScore + retrievalTotals.totalScore;
  const maxScore = toolChoiceTotals.maxScore + retrievalTotals.maxScore;
  return {
    suite: "memory-recall-live",
    generatedAt: new Date().toISOString(),
    toolChoice,
    retrievalSuccess,
    combined: {
      totalScore,
      maxScore,
      averageScoreRatio: maxScore > 0 ? totalScore / maxScore : 0
    }
  };
};

const main = async (): Promise<void> => {
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  const report = await runUnifiedBenchmark();
  const outputPath = optionValue("--out");
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    await writeFile(outputPath, serialized);
  } else {
    console.log(serialized.trimEnd());
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
