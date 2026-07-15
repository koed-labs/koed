import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  parseStructuredLcmSummary,
  type StructuredLcmSummary
} from "@koed/core";
import type {
  LcmSummaryBenchmarkCase,
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

const negationCue =
  /\b(no longer|not|never|false that|false|incorrect|wrong|does not|do not|did not|cannot|can't|is not|are not|was not|were not)\b\s*(\w+\s+){0,5}$/;

const hasNegationBeforeIndex = (
  normalizedHaystack: string,
  index: number,
  windowChars: number
): boolean =>
  negationCue.test(
    normalizedHaystack.slice(Math.max(0, index - windowChars), index)
  );

const includesAffirmativePhrase = (
  haystack: string,
  phrase: string
): boolean => {
  const normalizedHaystack = normalized(haystack);
  const normalizedPhrase = normalized(phrase);
  if (!normalizedPhrase) {
    return false;
  }
  let index = normalizedHaystack.indexOf(normalizedPhrase);
  while (index >= 0) {
    if (!hasNegationBeforeIndex(normalizedHaystack, index, 50)) {
      return true;
    }
    index = normalizedHaystack.indexOf(
      normalizedPhrase,
      index + normalizedPhrase.length
    );
  }
  return false;
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

const localTextUnits = (text: string): string[] =>
  text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((unit) => unit.trim())
    .filter(Boolean);

const termOccurrenceIndexes = (
  normalizedHaystack: string,
  term: string
): number[] => {
  const normalizedTerm = normalized(term);
  const indexes: number[] = [];
  if (normalizedTerm.length > 0) {
    let index = normalizedHaystack.indexOf(normalizedTerm);
    while (index >= 0) {
      indexes.push(index);
      index = normalizedHaystack.indexOf(
        normalizedTerm,
        index + normalizedTerm.length
      );
    }
    if (indexes.length > 0) {
      return indexes;
    }
  }

  const firstToken = significantTokens(term)[0];
  if (!firstToken) {
    return [];
  }
  let index = normalizedHaystack.indexOf(firstToken);
  while (index >= 0) {
    indexes.push(index);
    index = normalizedHaystack.indexOf(firstToken, index + firstToken.length);
  }
  return indexes;
};

const hasNegationBeforeTerm = (haystack: string, term: string): boolean => {
  const normalizedHaystack = normalized(haystack);
  const indexes = termOccurrenceIndexes(normalizedHaystack, term);
  if (indexes.length === 0) {
    return false;
  }
  return indexes.every((index) =>
    hasNegationBeforeIndex(normalizedHaystack, index, 80)
  );
};

const containsTerm = (haystack: string, term: string): boolean => {
  if (includesAffirmativePhrase(haystack, term)) {
    return true;
  }
  const expected = significantTokens(term);
  if (expected.length === 0) {
    return false;
  }
  return localTextUnits(haystack).some((unit) => {
    if (hasNegationBeforeTerm(unit, term)) {
      return false;
    }
    const actual = new Set(significantTokens(unit));
    return expected.every((token) => actual.has(token));
  });
};

const containsFuzzyTerm = (haystack: string, term: string): boolean =>
  includesPhrase(haystack, term) || tokenCoverage(haystack, term) >= 0.8;

const parseOutput = (output: unknown): StructuredLcmSummary => {
  if (typeof output === "string") {
    return parseStructuredLcmSummary(output);
  }
  return parseStructuredLcmSummary(JSON.stringify(output));
};

const structuredSummaryText = (summary: StructuredLcmSummary): string =>
  [summary.title, summary.summary_text].join("\n");

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

const containsForbiddenExactPhrase = (
  text: string,
  phrase: string,
  claim: LcmSummaryForbiddenClaim
): boolean =>
  claim.redactInReports === true
    ? includesPhrase(text, phrase)
    : includesForbiddenPhrase(text, phrase);

const forbiddenMatchPresent = (
  text: string,
  claim: LcmSummaryForbiddenClaim
): boolean => {
  const match = claim.match;
  const exactPhrases = match.exactPhrases ?? [];
  const phraseGroups = match.phraseGroups ?? [];
  const allTerms = match.allTerms ?? [];
  const anyTermGroups = match.anyTermGroups ?? [];

  return (
    (exactPhrases.length === 0 ||
      exactPhrases.some((phrase) =>
        containsForbiddenExactPhrase(text, phrase, claim)
      )) &&
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
  localTextUnits(text)
    .flatMap((unit) =>
      unit
        .split(/;|,(?=\s*(?:but|however|yet)\b)|\bbut\b|\bhowever\b/)
        .map((span) => span.trim())
        .filter(Boolean)
    )
    .filter((span) => forbiddenMatchPresent(span, claim));

const claimPresent = (text: string, claim: LcmSummaryRequiredClaim): boolean =>
  requiredMatchPresent(text, claim.match);

const forbiddenSpanAllowed = (
  span: string,
  claim: LcmSummaryForbiddenClaim
): boolean =>
  (claim.allowedContextTerms ?? []).some((term) => includesPhrase(span, term));

const forbiddenPresent = (
  summary: StructuredLcmSummary,
  claim: LcmSummaryForbiddenClaim
): boolean => {
  const text = structuredSummaryText(summary);
  const spans = forbiddenMatchingSpans(text, claim);
  if (spans.length === 0) {
    return false;
  }
  return spans.some((span) => !forbiddenSpanAllowed(span, claim));
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
  const text = summary.summary_text;
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
