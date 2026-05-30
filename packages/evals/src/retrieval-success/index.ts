import { readFile, writeFile } from "node:fs/promises";
import { retrievalSuccessCases } from "./cases.js";
import {
  runDeterministicRetrievalSuccessBenchmark,
  scoreRetrievalSuccessRun,
  summarizeRetrievalSuccessBenchmark,
  type RetrievalSuccessRunInput
} from "./benchmark.js";

const usage = [
  "Usage:",
  "  pnpm --filter @koed/evals eval:retrieval-success -- --list-cases",
  "  pnpm --filter @koed/evals eval:retrieval-success -- --run-deterministic [--out <report.json>]",
  "  pnpm --filter @koed/evals eval:retrieval-success -- --score <runs.json> [--out <report.json>]",
  "",
  "The score input is a JSON array of run records:",
  '[{"caseId":"fresh-tail-story-detail","runIndex":0,"answer":{"memoryStatus":"found","answerMarkdown":"The keeper was Tamar."},"evidence":[{"sourceId":"fresh-story-lamp-keeper","retrievalStage":"fresh_pending_search"}],"searches":[{"retrievalStage":"score_scan"},{"retrievalStage":"fresh_pending_search"}]}]'
].join("\n");

const args = process.argv.slice(2);

const optionValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const emit = async (json: unknown, outputPath?: string): Promise<void> => {
  const serialized = `${JSON.stringify(json, null, 2)}\n`;
  if (outputPath) {
    await writeFile(outputPath, serialized);
    return;
  }
  console.log(serialized.trimEnd());
};

const listCases = async (outputPath?: string): Promise<void> => {
  await emit(
    retrievalSuccessCases.map((benchmarkCase) => ({
      id: benchmarkCase.id,
      prompt: benchmarkCase.prompt,
      runs: benchmarkCase.runs,
      boundaryProfile: benchmarkCase.boundaryProfile,
      seed: benchmarkCase.seed.map((item) => ({
        id: item.id,
        sourceType: item.sourceType,
        retrievalStage: item.retrievalStage,
        relevant: item.relevant,
        createdDaysAgo: item.createdDaysAgo,
        parentNodeIds: item.parentNodeIds,
        lcmDepth: item.lcmDepth,
        lcmSummaryStatus: item.lcmSummaryStatus,
        tags: item.tags
      })),
      expected: benchmarkCase.expected,
      notes: benchmarkCase.notes
    })),
    outputPath
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

  const caseById = new Map(
    retrievalSuccessCases.map((item) => [item.id, item])
  );
  const scored = parsed.map((run) => {
    const input = run as RetrievalSuccessRunInput;
    const benchmarkCase = caseById.get(input.caseId);
    if (!benchmarkCase) {
      throw new Error(
        `Unknown retrieval-success benchmark case: ${input.caseId}`
      );
    }
    return scoreRetrievalSuccessRun(benchmarkCase, input);
  });

  await emit(summarizeRetrievalSuccessBenchmark(scored), outputPath);
};

if (args.includes("--help") || args.length === 0) {
  console.log(usage);
} else if (args.includes("--list-cases")) {
  await listCases(optionValue("--out"));
} else if (args.includes("--run-deterministic")) {
  await emit(runDeterministicRetrievalSuccessBenchmark(), optionValue("--out"));
} else if (args.includes("--score")) {
  const inputPath = optionValue("--score");
  if (!inputPath) {
    throw new Error("--score requires an input JSON path");
  }
  await scoreRuns(inputPath, optionValue("--out"));
} else {
  throw new Error(`Unknown retrieval-success benchmark command.\n${usage}`);
}
