import { readFile, writeFile } from "node:fs/promises";
import { curatedMemoryIntakeCases } from "./cases.js";
import {
  runCuratedMemoryIntakeScorerSelfTest,
  scoreCuratedMemoryIntakeRun,
  summarizeCuratedMemoryIntakeBenchmark,
  type CuratedMemoryIntakeRunInput
} from "./benchmark.js";

const usage = [
  "Usage:",
  "  pnpm --filter @koed/evals eval:curated-memory-intake -- --list-cases",
  "  pnpm --filter @koed/evals eval:curated-memory-intake -- --self-test-scorer [--out <report.json>]",
  "  pnpm --filter @koed/evals eval:curated-memory-intake -- --score <runs.json> [--out <report.json>]",
  "",
  "The score input is a JSON array of run records:",
  '[{"caseId":"birthday-user-profile","runIndex":0,"calls":[{"toolName":"memory_intake_propose","arguments":{"proposed_claim":"The user birthday is 14 March.","proposed_topic":"Personal details","tags":["personal","birthday"],"sensitivity_hint":"normal","evidence_conversation_item_ids":["11111111-1111-4111-8111-111111111111"]}}],"intake":{"proposalStatus":"stored","assertionId":"assertion-1"},"recall":{"hits":[{"sourceType":"curated_memory","retrievalStage":"curated_memory_search","summaryText":"The user birthday is 14 March."}]}}]'
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
  await emit(curatedMemoryIntakeCases, outputPath);
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
    curatedMemoryIntakeCases.map((benchmarkCase) => [
      benchmarkCase.id,
      benchmarkCase
    ])
  );
  const scored = parsed.map((run) => {
    const input = run as CuratedMemoryIntakeRunInput;
    const benchmarkCase = caseById.get(input.caseId);
    if (!benchmarkCase) {
      throw new Error(
        `Unknown curated-memory-intake benchmark case: ${input.caseId}`
      );
    }
    return scoreCuratedMemoryIntakeRun(benchmarkCase, input);
  });

  await emit(summarizeCuratedMemoryIntakeBenchmark(scored), outputPath);
};

if (args.includes("--help") || args.length === 0) {
  console.log(usage);
} else if (args.includes("--list-cases")) {
  await listCases(optionValue("--out"));
} else if (args.includes("--self-test-scorer")) {
  await emit(runCuratedMemoryIntakeScorerSelfTest(), optionValue("--out"));
} else if (args.includes("--score")) {
  const inputPath = optionValue("--score");
  if (!inputPath) {
    throw new Error("--score requires an input JSON path");
  }
  await scoreRuns(inputPath, optionValue("--out"));
} else {
  throw new Error(`Unknown curated-memory-intake benchmark command.\n${usage}`);
}
