import { readFile, writeFile } from "node:fs/promises";
import { toolChoiceCases } from "./cases.js";
import {
  scoreToolChoiceRun,
  summarizeToolChoiceBenchmark,
  type ToolChoiceRunInput
} from "./benchmark.js";

const usage = [
  "Usage:",
  "  pnpm --filter @koed/evals eval:tool-choice -- --list-cases",
  "  pnpm --filter @koed/evals eval:tool-choice -- --score <runs.json> [--out <report.json>]",
  "",
  "The score input is a JSON array of run records:",
  '[{"caseId":"project-prior-decision","runIndex":0,"calls":[{"toolName":"memory_answer","arguments":{"search_domain":"project","response_detail":"answer_only","include_evidence":false}}],"finalResponse":"..."}]'
].join("\n");

const args = process.argv.slice(2);

const optionValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const listCases = (): void => {
  console.log(
    JSON.stringify(
      toolChoiceCases.map((benchmarkCase) => ({
        id: benchmarkCase.id,
        prompt: benchmarkCase.prompt,
        runs: benchmarkCase.runs,
        expected: benchmarkCase.expected,
        fakeMemoryAnswer: benchmarkCase.fakeMemoryAnswer,
        notes: benchmarkCase.notes
      })),
      null,
      2
    )
  );
};

const scoreRuns = async (
  inputPath: string,
  outputPath?: string
): Promise<void> => {
  const parsed = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Expected score input to be a JSON array");
  }

  const caseById = new Map(toolChoiceCases.map((item) => [item.id, item]));
  const scored = parsed.map((run) => {
    const input = run as ToolChoiceRunInput;
    const benchmarkCase = caseById.get(input.caseId);
    if (!benchmarkCase) {
      throw new Error(`Unknown tool-choice benchmark case: ${input.caseId}`);
    }
    return scoreToolChoiceRun(benchmarkCase, input);
  });
  const summary = summarizeToolChoiceBenchmark(scored);
  const report = JSON.stringify(summary, null, 2);

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
  throw new Error(`Unknown tool-choice benchmark command.\n${usage}`);
}
