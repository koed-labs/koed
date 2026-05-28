import { readFile, writeFile } from "node:fs/promises";
import { workerJsonCases } from "./cases.js";
import {
  scoreWorkerJsonRun,
  summarizeWorkerJsonBenchmark,
  type WorkerJsonRunInput
} from "./benchmark.js";

const usage = [
  "Usage:",
  "  pnpm --filter @koed/evals eval:workers -- --list-cases",
  "  pnpm --filter @koed/evals eval:workers -- --score <runs.json> [--out <report.json>]",
  "",
  "The score input is a JSON array of run records:",
  '[{"caseId":"memory-found-project-decision","runIndex":0,"worker":"memory_answer","output":{"schema_version":"memory-answer-v1","memory_status":"found","relevant_memory_found":true,"answer_markdown":"...","relevance_explanation":"...","evidence":[],"missing":[],"missing_evidence":[]}}]'
].join("\n");

const args = process.argv.slice(2);

const optionValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const listCases = (): void => {
  console.log(JSON.stringify(workerJsonCases, null, 2));
};

const scoreRuns = async (
  inputPath: string,
  outputPath?: string
): Promise<void> => {
  const parsed = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Expected score input to be a JSON array");
  }

  const caseById = new Map(workerJsonCases.map((item) => [item.id, item]));
  const scored = parsed.map((run) => {
    const input = run as WorkerJsonRunInput;
    const benchmarkCase = caseById.get(input.caseId);
    if (!benchmarkCase) {
      throw new Error(`Unknown worker-json benchmark case: ${input.caseId}`);
    }
    if (benchmarkCase.worker !== input.worker) {
      throw new Error(
        `Worker mismatch for ${input.caseId}: expected ${benchmarkCase.worker}, got ${input.worker}`
      );
    }
    return scoreWorkerJsonRun(benchmarkCase, input);
  });
  const report = JSON.stringify(summarizeWorkerJsonBenchmark(scored), null, 2);

  if (outputPath) {
    await writeFile(outputPath, `${report}\n`);
    return;
  }
  console.log(report);
};

if (args.includes("--help") || args.length === 0) {
  console.log(usage);
} else if (args.includes("--list-cases")) {
  listCases();
} else if (args.includes("--score")) {
  const inputPath = optionValue("--score");
  if (!inputPath) {
    throw new Error("--score requires an input JSON path");
  }
  await scoreRuns(inputPath, optionValue("--out"));
} else {
  throw new Error(`Unknown worker-json benchmark command.\n${usage}`);
}
