import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  type StructuredLcmSummary
} from "@koed/mcp-server";
import {
  lcmSummaryBenchmarkCases,
  type LcmSummaryBenchmarkCase,
  type LcmSummaryField
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

type LcmSummaryArrayField = Exclude<LcmSummaryField, "summary_text">;

const structuredFields: LcmSummaryArrayField[] = [
  "user_requests",
  "decisions",
  "facts",
  "files",
  "commands",
  "model_names",
  "tool_outcomes",
  "errors",
  "unresolved_questions",
  "provenance_hints"
];

const emptySummary = (): StructuredLcmSummary => ({
  schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  title: "Benchmark Summary",
  summary_text: "",
  user_requests: [],
  decisions: [],
  facts: [],
  files: [],
  commands: [],
  model_names: [],
  tool_outcomes: [],
  errors: [],
  unresolved_questions: [],
  provenance_hints: []
});

const addToField = (
  summary: StructuredLcmSummary,
  field: LcmSummaryField,
  value: string
): void => {
  if (field === "summary_text") {
    summary.summary_text = [summary.summary_text, value]
      .filter(Boolean)
      .join(" ");
    return;
  }
  summary[field].push(value);
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
    for (const field of claim.fields) {
      addToField(summary, field, textForMatch(claim));
    }
  }
  for (const field of benchmarkCase.expected.requiredNonEmptyFields ?? []) {
    if (field !== "summary_text" && summary[field].length === 0) {
      summary[field].push(`${benchmarkCase.id} ${field} detail`);
    }
  }
  const minFields = benchmarkCase.expected.minNonEmptyFields ?? 0;
  for (const field of structuredFields) {
    if (
      summary[field].length === 0 &&
      structuredFields.filter((candidate) => summary[candidate].length > 0)
        .length < minFields
    ) {
      summary[field].push(`${benchmarkCase.id} ${field} detail`);
    }
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
      fieldFitness: 0.9,
      conflictHandling: 0.9,
      compressionQuality: 0.9,
      provenanceUse: 0.9,
      safety: 1
    },
    issues: [],
    rationale: "The candidate summary is faithful and useful.",
    ...overrides
  });
