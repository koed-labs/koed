import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  type StructuredLcmSummary
} from "@koed/core";
import {
  lcmSummaryBenchmarkCases,
  type LcmSummaryBenchmarkCase
} from "./cases.js";
import { LCM_SUMMARY_SEMANTIC_JUDGE_SCHEMA_VERSION } from "./semantic-judge.js";

const caseById = new Map(
  lcmSummaryBenchmarkCases.map((benchmarkCase) => [
    benchmarkCase.id,
    benchmarkCase
  ])
);

export const mustCase = (id: string): LcmSummaryBenchmarkCase => {
  const benchmarkCase = caseById.get(id);
  if (!benchmarkCase) {
    throw new Error(`Missing LCM summary benchmark case ${id}`);
  }
  return benchmarkCase;
};

const emptySummary = (): StructuredLcmSummary => ({
  schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  title: "Benchmark Summary",
  summary_text: ""
});

const addToSummary = (summary: StructuredLcmSummary, value: string): void => {
  summary.summary_text = [summary.summary_text, value]
    .filter(Boolean)
    .join(" ");
};

const textForMatch = (
  claim: LcmSummaryBenchmarkCase["expected"]["requiredClaims"][number]
): string =>
  [
    ...(claim.match.exactPhrases ?? []),
    ...(claim.match.phraseGroups?.map((group) => group[0] ?? "") ?? []),
    ...(claim.match.allTerms ?? []),
    ...(claim.match.anyTermGroups?.map((group) => group[0] ?? "") ?? [])
  ]
    .filter(Boolean)
    .join(" ");

export const passingOutput = (
  benchmarkCase: LcmSummaryBenchmarkCase
): StructuredLcmSummary => {
  const summary = emptySummary();
  for (const claim of benchmarkCase.expected.requiredClaims) {
    addToSummary(summary, textForMatch(claim));
  }
  if (!summary.summary_text) {
    summary.summary_text = benchmarkCase.expected.requiredClaims
      .map((claim) => textForMatch(claim))
      .join(" ");
  }
  return summary;
};

export const passingJudgeOutput = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: LCM_SUMMARY_SEMANTIC_JUDGE_SCHEMA_VERSION,
    verdict: "pass",
    score: 0.94,
    dimensions: {
      faithfulness: 0.95,
      durableCoverage: 0.9,
      semanticFocus: 0.9,
      conflictHandling: 0.9,
      compressionQuality: 0.9,
      provenanceUse: 0.9,
      safety: 1
    },
    issues: [],
    rationale: "The candidate summary is faithful and useful.",
    ...overrides
  });
