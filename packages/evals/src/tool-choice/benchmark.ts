export type SearchDomain = "global" | "project" | "session";
export type ResponseDetail = "answer_only" | "with_citations" | "with_evidence";

export interface ToolChoiceCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ToolChoiceRunInput {
  caseId: string;
  runIndex: number;
  calls: ToolChoiceCall[];
  finalResponse: string;
  judge?: {
    naturalness?: "good" | "acceptable" | "poor";
    notes?: string;
  };
}

export interface ArgumentExpectation<T> {
  ideal: readonly T[];
  acceptable?: readonly T[];
}

export interface ToolChoiceCase {
  id: string;
  prompt: string;
  runs: number;
  expected: {
    shouldCallMemory: boolean;
    maxMemoryCalls?: number;
    searchDomain?: ArgumentExpectation<SearchDomain>;
    responseDetail?: ArgumentExpectation<ResponseDetail>;
    includeEvidence?: ArgumentExpectation<boolean>;
    limit?: ArgumentExpectation<number>;
  };
  fakeMemoryAnswer: {
    memoryStatus: "found" | "not_found";
    markdown: string;
  };
  notes?: string;
}

export interface ScoreDetail {
  name: string;
  score: number;
  maxScore: number;
  actual: unknown;
  reason: string;
}

export interface ToolChoiceRunScore {
  caseId: string;
  runIndex: number;
  score: number;
  maxScore: number;
  memoryCallCount: number;
  disclosureCount: number;
  details: ScoreDetail[];
}

export interface ToolChoiceBenchmarkSummary {
  runs: ToolChoiceRunScore[];
  totalScore: number;
  maxScore: number;
  averageScoreRatio: number;
  disclosureCount: number;
  memoryCallRate: number;
}

export const memoryToolDisclosurePattern =
  /\b(i (used|called|queried|checked)|using|called|queried|checked)\s+(the\s+)?(koed\s+)?memory\s+(tool|search|answer)\b/i;

const memoryCalls = (run: ToolChoiceRunInput): ToolChoiceCall[] =>
  run.calls.filter((call) => call.toolName === "memory_answer");

const countDisclosures = (text: string): number =>
  memoryToolDisclosurePattern.test(text) ? 1 : 0;

const argumentValue = (
  call: ToolChoiceCall | undefined,
  name: string
): unknown => call?.arguments[name];

const scoreArgument = <T>(
  name: string,
  actual: unknown,
  expectation: ArgumentExpectation<T>
): ScoreDetail => {
  if ((expectation.ideal as readonly unknown[]).includes(actual)) {
    return {
      name,
      score: 3,
      maxScore: 3,
      actual,
      reason: "ideal"
    };
  }
  if (
    (expectation.acceptable as readonly unknown[] | undefined)?.includes(actual)
  ) {
    return {
      name,
      score: 1,
      maxScore: 3,
      actual,
      reason: "acceptable"
    };
  }
  return {
    name,
    score: 0,
    maxScore: 3,
    actual,
    reason: "bad"
  };
};

const scoreSearchDomain = (
  firstCall: ToolChoiceCall | undefined,
  expectation: ArgumentExpectation<SearchDomain>
): ScoreDetail => {
  const actual = argumentValue(firstCall, "search_domain");
  if (
    actual === "session" &&
    typeof argumentValue(firstCall, "session_id") !== "string"
  ) {
    return {
      name: "search_domain",
      score: 0,
      maxScore: 3,
      actual,
      reason: "session_id missing for session scope"
    };
  }
  return scoreArgument("search_domain", actual, expectation);
};

export const scoreToolChoiceRun = (
  benchmarkCase: ToolChoiceCase,
  run: ToolChoiceRunInput
): ToolChoiceRunScore => {
  const calls = memoryCalls(run);
  const firstCall = calls[0];
  const details: ScoreDetail[] = [];

  if (!benchmarkCase.expected.shouldCallMemory) {
    details.push({
      name: "memory_call",
      score: calls.length === 0 ? 3 : 0,
      maxScore: 3,
      actual: calls.length,
      reason: calls.length === 0 ? "ideal" : "unexpected memory call"
    });
    return finishScore(benchmarkCase, run, calls.length, details);
  }

  details.push({
    name: "memory_call",
    score: firstCall ? 3 : -1,
    maxScore: 3,
    actual: calls.length,
    reason: firstCall ? "memory called" : "required memory call missing"
  });

  const maxMemoryCalls = benchmarkCase.expected.maxMemoryCalls ?? 1;
  details.push({
    name: "memory_call_count",
    score: firstCall && calls.length <= maxMemoryCalls ? 3 : 0,
    maxScore: 3,
    actual: calls.length,
    reason: !firstCall
      ? "required memory call missing"
      : calls.length <= maxMemoryCalls
        ? "within expected call count"
        : "repeated memory calls"
  });

  if (benchmarkCase.expected.searchDomain) {
    details.push(
      scoreSearchDomain(firstCall, benchmarkCase.expected.searchDomain)
    );
  }
  if (benchmarkCase.expected.responseDetail) {
    details.push(
      scoreArgument(
        "response_detail",
        argumentValue(firstCall, "response_detail"),
        benchmarkCase.expected.responseDetail
      )
    );
  }
  if (benchmarkCase.expected.includeEvidence) {
    details.push(
      scoreArgument(
        "include_evidence",
        argumentValue(firstCall, "include_evidence"),
        benchmarkCase.expected.includeEvidence
      )
    );
  }
  if (benchmarkCase.expected.limit) {
    details.push(
      scoreArgument(
        "limit",
        argumentValue(firstCall, "limit"),
        benchmarkCase.expected.limit
      )
    );
  }

  return finishScore(benchmarkCase, run, calls.length, details);
};

const finishScore = (
  benchmarkCase: ToolChoiceCase,
  run: ToolChoiceRunInput,
  memoryCallCount: number,
  details: ScoreDetail[]
): ToolChoiceRunScore => {
  const score = details.reduce((sum, detail) => sum + detail.score, 0);
  const maxScore = details.reduce((sum, detail) => sum + detail.maxScore, 0);
  return {
    caseId: benchmarkCase.id,
    runIndex: run.runIndex,
    score,
    maxScore,
    memoryCallCount,
    disclosureCount: countDisclosures(run.finalResponse),
    details
  };
};

export const summarizeToolChoiceBenchmark = (
  runs: ToolChoiceRunScore[]
): ToolChoiceBenchmarkSummary => {
  const totalScore = runs.reduce((sum, run) => sum + run.score, 0);
  const maxScore = runs.reduce((sum, run) => sum + run.maxScore, 0);
  const memoryCallRate =
    runs.length === 0
      ? 0
      : runs.filter((run) => run.memoryCallCount > 0).length / runs.length;
  return {
    runs,
    totalScore,
    maxScore,
    averageScoreRatio: maxScore === 0 ? 0 : totalScore / maxScore,
    disclosureCount: runs.reduce((sum, run) => sum + run.disclosureCount, 0),
    memoryCallRate
  };
};
