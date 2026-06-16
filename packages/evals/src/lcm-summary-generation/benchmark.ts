import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  parseStructuredLcmSummary,
  type StructuredLcmSummary
} from "@koed/mcp-server";
import type {
  LcmSummaryBenchmarkCase,
  LcmSummaryField,
  LcmSummaryForbiddenClaim,
  LcmSummaryRequiredClaim,
  LcmSummaryTermMatch
} from "./cases.js";

export interface LcmSummaryBenchmarkRunInput {
  caseId: string;
  runIndex: number;
  output: unknown;
  latencyMs?: number;
  model?: string;
  tokenUsage?: unknown;
  error?: string;
}

export interface LcmSummaryScoreDetail {
  name: string;
  score: number;
  maxScore: number;
  reason: string;
  actual?: unknown;
  critical?: boolean;
}

export interface LcmSummaryRunScore {
  caseId: string;
  runIndex: number;
  score: number;
  maxScore: number;
  scoreRatio: number;
  validJson: boolean;
  criticalFailure: boolean;
  passed: boolean;
  details: LcmSummaryScoreDetail[];
  parsedSummary?: StructuredLcmSummary;
  latencyMs?: number;
  model?: string;
  tokenUsage?: unknown;
  error?: string;
}

export interface LcmSummaryBenchmarkSummary {
  runs: LcmSummaryRunScore[];
  totalScore: number;
  maxScore: number;
  averageScoreRatio: number;
  validJsonRate: number;
  criticalFailureCount: number;
  casePassRate: number;
  threshold: number;
  passed: boolean;
}

const DEFAULT_PASS_THRESHOLD = 0.9;

const normalized = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[`"'*_()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const includesPhrase = (haystack: string, phrase: string): boolean =>
  normalized(haystack).includes(normalized(phrase));

const includesAffirmativePhrase = (
  haystack: string,
  phrase: string
): boolean => {
  const normalizedHaystack = normalized(haystack);
  const normalizedPhrase = normalized(phrase);
  const index = normalizedHaystack.indexOf(normalizedPhrase);
  if (index < 0) {
    return false;
  }
  const before = normalizedHaystack.slice(Math.max(0, index - 50), index);
  return !/\b(no|not|never|false|incorrect|wrong)\b\s*(\w+\s+){0,5}$/.test(
    before
  );
};

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "or",
  "should",
  "the",
  "to",
  "under",
  "was",
  "were",
  "with"
]);

const stemToken = (token: string): string => {
  if (token.length > 5 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 6 && token.endsWith("ing")) {
    return token.slice(0, -3);
  }
  if (token.length > 5 && token.endsWith("ed")) {
    return token.slice(0, -2);
  }
  if (
    token.length > 4 &&
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("sis")
  ) {
    return token.slice(0, -1);
  }
  return token;
};

const significantTokens = (value: string): string[] => [
  ...new Set(
    normalized(value)
      .match(/[a-z0-9_.:-]+/g)
      ?.map(stemToken)
      .filter((token) => token.length > 1 && !stopWords.has(token)) ?? []
  )
];

const tokenCoverage = (haystack: string, phrase: string): number => {
  const expected = significantTokens(phrase);
  if (expected.length === 0) {
    return 0;
  }
  const actual = new Set(significantTokens(haystack));
  return expected.filter((token) => actual.has(token)).length / expected.length;
};

const negationCue =
  /\b(no longer|not|never|false that|false|incorrect|wrong|does not|do not|did not|cannot|can't|is not|are not|was not|were not)\b/;

const hasNegationBeforeTerm = (haystack: string, term: string): boolean => {
  const normalizedHaystack = normalized(haystack);
  const firstToken = significantTokens(term)
    .map((token) => normalizedHaystack.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (firstToken === undefined) {
    return false;
  }
  return negationCue.test(
    normalizedHaystack.slice(Math.max(0, firstToken - 80), firstToken)
  );
};

const containsTerm = (haystack: string, term: string): boolean => {
  if (includesAffirmativePhrase(haystack, term)) {
    return true;
  }
  if (hasNegationBeforeTerm(haystack, term)) {
    return false;
  }
  const expected = significantTokens(term);
  if (expected.length === 0) {
    return false;
  }
  const actual = new Set(significantTokens(haystack));
  return expected.every((token) => actual.has(token));
};

const containsFuzzyTerm = (haystack: string, term: string): boolean =>
  includesPhrase(haystack, term) || tokenCoverage(haystack, term) >= 0.8;

const parseOutput = (output: unknown): StructuredLcmSummary => {
  if (typeof output === "string") {
    return parseStructuredLcmSummary(output);
  }
  return parseStructuredLcmSummary(JSON.stringify(output));
};

const fieldValue = (
  summary: StructuredLcmSummary,
  field: LcmSummaryField
): string => {
  const value = summary[field];
  if (Array.isArray(value)) {
    return value.join("\n");
  }
  return typeof value === "string" ? value : "";
};

const allSummaryText = (summary: StructuredLcmSummary): string =>
  [
    summary.title,
    summary.summary_text,
    ...summary.user_requests,
    ...summary.decisions,
    ...summary.facts,
    ...summary.files,
    ...summary.commands,
    ...summary.model_names,
    ...summary.tool_outcomes,
    ...summary.errors,
    ...summary.unresolved_questions,
    ...summary.provenance_hints
  ].join("\n");

const localTextUnits = (text: string): string[] =>
  text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((unit) => unit.trim())
    .filter(Boolean);

const requiredMatchPresent = (
  text: string,
  match: LcmSummaryTermMatch
): boolean => {
  const exactPhrases = match.exactPhrases ?? [];
  const phraseGroups = match.phraseGroups ?? [];
  const allTerms = match.allTerms ?? [];
  const anyTermGroups = match.anyTermGroups ?? [];

  return (
    exactPhrases.every((phrase) => includesAffirmativePhrase(text, phrase)) &&
    phraseGroups.every((group) =>
      group.some((phrase) => includesAffirmativePhrase(text, phrase))
    ) &&
    allTerms.every((term) => containsTerm(text, term)) &&
    anyTermGroups.every((group) =>
      group.some((term) => containsTerm(text, term))
    )
  );
};

const containsForbiddenTerm = (haystack: string, term: string): boolean =>
  !hasNegationBeforeTerm(haystack, term) &&
  (includesPhrase(haystack, term) || containsFuzzyTerm(haystack, term));

const includesForbiddenPhrase = (haystack: string, phrase: string): boolean =>
  includesPhrase(haystack, phrase) && !hasNegationBeforeTerm(haystack, phrase);

const forbiddenMatchPresent = (
  text: string,
  claim: LcmSummaryForbiddenClaim
): boolean => {
  const match = claim.match;
  const exactPhrases = match.exactPhrases ?? [];
  const phraseGroups = match.phraseGroups ?? [];
  const allTerms = match.allTerms ?? [];
  const anyTermGroups = match.anyTermGroups ?? [];
  const containsExactForbiddenPhrase =
    claim.redactInReports === true ? includesPhrase : includesForbiddenPhrase;

  return (
    exactPhrases.every((phrase) =>
      containsExactForbiddenPhrase(text, phrase)
    ) &&
    phraseGroups.every((group) =>
      group.some((phrase) => includesForbiddenPhrase(text, phrase))
    ) &&
    allTerms.every((term) => containsForbiddenTerm(text, term)) &&
    anyTermGroups.every((group) =>
      group.some((term) => containsForbiddenTerm(text, term))
    )
  );
};

const forbiddenMatchingSpans = (
  text: string,
  claim: LcmSummaryForbiddenClaim
): string[] =>
  localTextUnits(text).filter((span) => forbiddenMatchPresent(span, claim));

const claimPresent = (text: string, claim: LcmSummaryRequiredClaim): boolean =>
  requiredMatchPresent(text, claim.match);

const forbiddenPresent = (
  summary: StructuredLcmSummary,
  claim: LcmSummaryForbiddenClaim
): boolean => {
  const text =
    claim.fields && claim.fields.length > 0
      ? claim.fields.map((field) => fieldValue(summary, field)).join("\n")
      : allSummaryText(summary);
  const spans = forbiddenMatchingSpans(text, claim);
  if (spans.length === 0) {
    return false;
  }
  return spans.some(
    (span) =>
      !(claim.allowedContextTerms ?? []).some((term) =>
        includesPhrase(span, term)
      )
  );
};

const nonEmptyStructuredFields = (
  summary: StructuredLcmSummary
): LcmSummaryField[] => {
  const fields: LcmSummaryField[] = [
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
  return fields.filter((field) => fieldValue(summary, field).trim().length > 0);
};

const schemaDetail = (): LcmSummaryScoreDetail => ({
  name: "schema",
  score: 10,
  maxScore: 10,
  reason: `valid ${LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION} JSON`
});

const requiredClaimDetails = (
  summary: StructuredLcmSummary,
  claim: LcmSummaryRequiredClaim
): LcmSummaryScoreDetail[] => {
  const text = allSummaryText(summary);
  const present = claimPresent(text, claim);
  const critical = claim.critical ?? true;
  const details: LcmSummaryScoreDetail[] = [
    {
      name: `required:${claim.id}`,
      score: present ? 4 : 0,
      maxScore: 4,
      reason: present ? "claim present" : "claim missing",
      actual: claim.label,
      critical
    }
  ];

  if (claim.fields.length > 0) {
    const placed = claim.fields.some((field) =>
      claimPresent(fieldValue(summary, field), claim)
    );
    details.push({
      name: `field:${claim.id}`,
      score: placed ? 2 : 0,
      maxScore: 2,
      reason: placed
        ? "claim present in an expected field"
        : "claim missing from expected fields",
      actual: Object.fromEntries(
        claim.fields.map((field) => [field, fieldValue(summary, field)])
      ),
      critical
    });
  }

  return details;
};

const forbiddenClaimDetail = (
  summary: StructuredLcmSummary,
  claim: LcmSummaryForbiddenClaim
): LcmSummaryScoreDetail => {
  const present = forbiddenPresent(summary, claim);
  const maxScore = claim.critical === true ? 6 : 2;
  return {
    name: `forbidden:${claim.id}`,
    score: present ? 0 : maxScore,
    maxScore,
    reason: present ? "forbidden claim present" : "forbidden claim absent",
    actual: claim.label,
    critical: claim.critical ?? false
  };
};

export const scoreLcmSummaryRun = (
  benchmarkCase: LcmSummaryBenchmarkCase,
  run: LcmSummaryBenchmarkRunInput,
  options: { threshold?: number } = {}
): LcmSummaryRunScore => {
  const threshold = options.threshold ?? DEFAULT_PASS_THRESHOLD;
  let summary: StructuredLcmSummary;
  try {
    summary = parseOutput(run.output);
  } catch (error) {
    return {
      caseId: run.caseId,
      runIndex: run.runIndex,
      score: 0,
      maxScore: 10,
      scoreRatio: 0,
      validJson: false,
      criticalFailure: true,
      passed: false,
      latencyMs: run.latencyMs,
      model: run.model,
      tokenUsage: run.tokenUsage,
      error: run.error,
      details: [
        {
          name: "schema",
          score: 0,
          maxScore: 10,
          reason: error instanceof Error ? error.message : String(error),
          critical: true
        }
      ]
    };
  }

  const details: LcmSummaryScoreDetail[] = [schemaDetail()];

  for (const claim of benchmarkCase.expected.requiredClaims) {
    details.push(...requiredClaimDetails(summary, claim));
  }
  for (const claim of benchmarkCase.expected.forbiddenClaims ?? []) {
    details.push(forbiddenClaimDetail(summary, claim));
  }
  for (const field of benchmarkCase.expected.requiredNonEmptyFields ?? []) {
    const value = fieldValue(summary, field);
    details.push({
      name: `non_empty:${field}`,
      score: value.trim().length > 0 ? 2 : 0,
      maxScore: 2,
      reason: value.trim().length > 0 ? "non-empty" : "empty",
      actual: value,
      critical: true
    });
  }

  const minFields = benchmarkCase.expected.minNonEmptyFields;
  if (minFields !== undefined) {
    const fields = nonEmptyStructuredFields(summary);
    details.push({
      name: "non_empty_field_count",
      score: fields.length >= minFields ? 3 : 0,
      maxScore: 3,
      reason:
        fields.length >= minFields
          ? "enough structured fields"
          : "too few structured fields",
      actual: fields,
      critical: true
    });
  }

  const maxSummaryTextChars = benchmarkCase.expected.maxSummaryTextChars;
  if (maxSummaryTextChars !== undefined) {
    details.push({
      name: "summary_text_length",
      score: summary.summary_text.length <= maxSummaryTextChars ? 2 : 0,
      maxScore: 2,
      reason:
        summary.summary_text.length <= maxSummaryTextChars
          ? "within compression limit"
          : "too verbose",
      actual: summary.summary_text.length
    });
  }

  const score = details.reduce((sum, detail) => sum + detail.score, 0);
  const maxScore = details.reduce((sum, detail) => sum + detail.maxScore, 0);
  const scoreRatio = maxScore > 0 ? score / maxScore : 0;
  const criticalFailure = details.some(
    (detail) => detail.critical && detail.score < detail.maxScore
  );

  return {
    caseId: benchmarkCase.id,
    runIndex: run.runIndex,
    score,
    maxScore,
    scoreRatio,
    validJson: true,
    criticalFailure,
    passed: !criticalFailure && scoreRatio >= threshold,
    details,
    parsedSummary: summary,
    latencyMs: run.latencyMs,
    model: run.model,
    tokenUsage: run.tokenUsage,
    error: run.error
  };
};

export const summarizeLcmSummaryBenchmark = (
  runs: LcmSummaryRunScore[],
  options: { threshold?: number } = {}
): LcmSummaryBenchmarkSummary => {
  const threshold = options.threshold ?? DEFAULT_PASS_THRESHOLD;
  const totalScore = runs.reduce((sum, run) => sum + run.score, 0);
  const maxScore = runs.reduce((sum, run) => sum + run.maxScore, 0);
  const averageScoreRatio = maxScore > 0 ? totalScore / maxScore : 0;
  const criticalFailureCount = runs.filter((run) => run.criticalFailure).length;
  const validJsonRate =
    runs.length > 0
      ? runs.filter((run) => run.validJson).length / runs.length
      : 0;
  const casePassRate =
    runs.length > 0 ? runs.filter((run) => run.passed).length / runs.length : 0;

  return {
    runs,
    totalScore,
    maxScore,
    averageScoreRatio,
    validJsonRate,
    criticalFailureCount,
    casePassRate,
    threshold,
    passed:
      runs.length > 0 &&
      validJsonRate === 1 &&
      criticalFailureCount === 0 &&
      casePassRate === 1 &&
      averageScoreRatio >= threshold
  };
};
