import {
  retrievalSuccessCases,
  type RetrievalStage,
  type RetrievalSuccessCase
} from "./cases.js";

export interface RetrievalSuccessEvidence {
  sourceId?: string;
  nodeId?: string;
  sourceType?: string;
  retrievalStage?: RetrievalStage | string;
  summaryText?: string;
  relevance?: string;
}

export interface RetrievalSuccessSearchTrace {
  retrievalStage?: RetrievalStage | string;
  stage?: RetrievalStage | string;
  query?: string;
  limit?: number;
}

export interface RetrievalSuccessRunInput {
  caseId: string;
  runIndex: number;
  answer: {
    memoryStatus: "found" | "not_found" | "insufficient" | "pending_summary";
    answerMarkdown: string;
  };
  evidence: RetrievalSuccessEvidence[];
  searches?: RetrievalSuccessSearchTrace[];
  retrievals?: unknown[];
  notes?: string;
}

export interface RetrievalSuccessScoreDetail {
  name: string;
  score: number;
  maxScore: number;
  reason: string;
  actual?: unknown;
}

export interface RetrievalSuccessRunScore {
  caseId: string;
  runIndex: number;
  score: number;
  maxScore: number;
  answerCorrect: boolean;
  evidenceRelevant: boolean;
  irrelevantEvidenceLeaked: boolean;
  lexicalUsed: boolean;
  lexicalJustified: boolean;
  retrievalStagesUsed: RetrievalStage[];
  details: RetrievalSuccessScoreDetail[];
}

export interface RetrievalSuccessBenchmarkSummary {
  suite: "retrieval-success";
  boundaryProfile: "post-koe-166-defaults";
  runs: RetrievalSuccessRunScore[];
  totalScore: number;
  maxScore: number;
  averageScoreRatio: number;
  answerCorrectRate: number;
  evidenceRelevantRate: number;
  irrelevantEvidenceLeakRate: number;
  lexicalUseRate: number;
  unjustifiedLexicalUseRate: number;
}

const stageOrder: RetrievalStage[] = [
  "score_scan",
  "rollup_search",
  "scoped_leaf_search",
  "leaf_search",
  "fresh_pending_search",
  "raw_fallback_search",
  "lexical_search"
];

const stageSet = new Set<string>(stageOrder);

const normalize = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, " ").trim();

const sourceIdentity = (evidence: RetrievalSuccessEvidence): string | null =>
  evidence.sourceId ?? evidence.nodeId ?? null;

const evidenceIds = (run: RetrievalSuccessRunInput): Set<string> =>
  new Set(
    run.evidence
      .map((item) => sourceIdentity(item))
      .filter((id): id is string => typeof id === "string")
  );

const maybeStage = (value: unknown): RetrievalStage | null =>
  typeof value === "string" && stageSet.has(value)
    ? (value as RetrievalStage)
    : null;

const addStage = (stages: Set<RetrievalStage>, value: unknown): void => {
  const stage = maybeStage(value);
  if (stage) {
    stages.add(stage);
  }
};

const stageFromRecord = (
  record: Record<string, unknown>
): RetrievalStage | null =>
  maybeStage(record.retrievalStage) ??
  maybeStage(record.retrieval_stage) ??
  maybeStage(record.stage) ??
  maybeStage(record.name);

const countableSelectedStage = (
  stage: RetrievalStage,
  record: Record<string, unknown>
): boolean => {
  if (stage === "score_scan") {
    return record.ran !== false;
  }
  if (typeof record.used === "boolean") {
    return record.used;
  }
  if (typeof record.selectedCount === "number") {
    return record.selectedCount > 0;
  }
  if (typeof record.selected_count === "number") {
    return record.selected_count > 0;
  }
  return !(
    "ran" in record ||
    "used" in record ||
    "selectedCount" in record ||
    "selected_count" in record ||
    "candidateCount" in record ||
    "candidate_count" in record
  );
};

const collectStagesFromValue = (
  value: unknown,
  stages: Set<RetrievalStage>
): void => {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStagesFromValue(item, stages);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const stage = stageFromRecord(record);
  if (stage && countableSelectedStage(stage, record)) {
    stages.add(stage);
  }
  if (Array.isArray(record.stages)) {
    collectStagesFromValue(record.stages, stages);
  }
  if (Array.isArray(record.retrievals)) {
    collectStagesFromValue(record.retrievals, stages);
  }
};

export const retrievalStagesUsed = (
  run: RetrievalSuccessRunInput
): RetrievalStage[] => {
  const stages = new Set<RetrievalStage>();
  for (const search of run.searches ?? []) {
    const stage = maybeStage(search.retrievalStage ?? search.stage);
    if (stage === "score_scan") {
      addStage(stages, stage);
    }
  }
  for (const evidence of run.evidence) {
    addStage(stages, evidence.retrievalStage);
  }
  collectStagesFromValue(run.retrievals, stages);
  return stageOrder.filter((stage) => stages.has(stage));
};

const detail = (
  name: string,
  score: number,
  maxScore: number,
  reason: string,
  actual?: unknown
): RetrievalSuccessScoreDetail => ({
  name,
  score,
  maxScore,
  reason,
  actual
});

const scoreMemoryStatus = (
  benchmarkCase: RetrievalSuccessCase,
  run: RetrievalSuccessRunInput
): RetrievalSuccessScoreDetail =>
  detail(
    "memory_status",
    run.answer.memoryStatus === benchmarkCase.expected.memoryStatus ? 3 : 0,
    3,
    run.answer.memoryStatus === benchmarkCase.expected.memoryStatus
      ? "expected"
      : "unexpected",
    run.answer.memoryStatus
  );

const scoreAnswerSubstrings = (
  benchmarkCase: RetrievalSuccessCase,
  run: RetrievalSuccessRunInput
): RetrievalSuccessScoreDetail[] => {
  const answer = normalize(run.answer.answerMarkdown);
  return (benchmarkCase.expected.answerSubstrings ?? []).map((substring) => {
    const ok = answer.includes(normalize(substring));
    return detail(
      `answer_contains:${substring}`,
      ok ? 2 : 0,
      2,
      ok ? "present" : "missing"
    );
  });
};

const scoreRequiredEvidence = (
  benchmarkCase: RetrievalSuccessCase,
  run: RetrievalSuccessRunInput
): RetrievalSuccessScoreDetail[] => {
  const ids = evidenceIds(run);
  return (benchmarkCase.expected.requiredEvidenceIds ?? []).map((id) => {
    const ok = ids.has(id);
    return detail(
      `evidence_required:${id}`,
      ok ? 3 : 0,
      3,
      ok ? "selected" : "missing",
      [...ids]
    );
  });
};

const scoreForbiddenEvidence = (
  benchmarkCase: RetrievalSuccessCase,
  run: RetrievalSuccessRunInput
): RetrievalSuccessScoreDetail[] => {
  const ids = evidenceIds(run);
  return (benchmarkCase.expected.forbiddenEvidenceIds ?? []).map((id) => {
    const leaked = ids.has(id);
    return detail(
      `evidence_forbidden:${id}`,
      leaked ? 0 : 3,
      3,
      leaked ? "irrelevant evidence leaked" : "not selected",
      [...ids]
    );
  });
};

const scoreEvidenceLimit = (
  benchmarkCase: RetrievalSuccessCase,
  run: RetrievalSuccessRunInput
): RetrievalSuccessScoreDetail[] => {
  const maxEvidenceItems = benchmarkCase.expected.maxEvidenceItems;
  if (maxEvidenceItems === undefined) {
    return [];
  }
  const ok = run.evidence.length <= maxEvidenceItems;
  return [
    detail(
      "evidence_count_curated",
      ok ? 2 : 0,
      2,
      ok ? "curated evidence size" : "too many evidence items",
      run.evidence.length
    )
  ];
};

const scoreStages = (
  benchmarkCase: RetrievalSuccessCase,
  stages: RetrievalStage[]
): RetrievalSuccessScoreDetail[] => {
  const stageIds = new Set(stages);
  const details: RetrievalSuccessScoreDetail[] = [];
  for (const stage of benchmarkCase.expected.requiredStages ?? []) {
    const ok = stageIds.has(stage);
    details.push(
      detail(
        `stage_required:${stage}`,
        ok ? 2 : 0,
        2,
        ok ? "used" : "missing",
        stages
      )
    );
  }
  for (const stage of benchmarkCase.expected.forbiddenStages ?? []) {
    const used = stageIds.has(stage);
    details.push(
      detail(
        `stage_forbidden:${stage}`,
        used ? 0 : 2,
        2,
        used ? "forbidden stage used" : "not used",
        stages
      )
    );
  }
  return details;
};

const scoreLexical = (
  benchmarkCase: RetrievalSuccessCase,
  lexicalUsed: boolean
): RetrievalSuccessScoreDetail[] => {
  const lexical = benchmarkCase.expected.lexical;
  if (!lexical) {
    return [];
  }
  const ok =
    lexical.expectation === "required"
      ? lexicalUsed
      : lexical.expectation === "forbidden"
        ? !lexicalUsed
        : true;
  return [
    detail(
      "lexical_behavior",
      ok ? 3 : 0,
      3,
      ok ? lexical.reason : `violates lexical expectation: ${lexical.reason}`,
      { expected: lexical.expectation, lexicalUsed }
    )
  ];
};

const scoreTemporal = (
  benchmarkCase: RetrievalSuccessCase,
  run: RetrievalSuccessRunInput
): RetrievalSuccessScoreDetail[] => {
  const temporal = benchmarkCase.expected.temporal;
  if (!temporal) {
    return [];
  }
  const ids = evidenceIds(run);
  const inWindow = temporal.requiredInWindowIds.every((id) => ids.has(id));
  const outOfWindowLeak = temporal.forbiddenOutOfWindowIds.some((id) =>
    ids.has(id)
  );
  return [
    detail(
      "temporal_required_window",
      inWindow ? 2 : 0,
      2,
      inWindow ? "in-window evidence selected" : "in-window evidence missing",
      { recentDays: temporal.recentDays, evidenceIds: [...ids] }
    ),
    detail(
      "temporal_out_of_window_exclusion",
      outOfWindowLeak ? 0 : 2,
      2,
      outOfWindowLeak
        ? "out-of-window evidence leaked"
        : "out-of-window evidence excluded",
      { recentDays: temporal.recentDays, evidenceIds: [...ids] }
    )
  ];
};

export const scoreRetrievalSuccessRun = (
  benchmarkCase: RetrievalSuccessCase,
  run: RetrievalSuccessRunInput
): RetrievalSuccessRunScore => {
  const stages = retrievalStagesUsed(run);
  const lexicalUsed = stages.includes("lexical_search");
  const details = [
    scoreMemoryStatus(benchmarkCase, run),
    ...scoreAnswerSubstrings(benchmarkCase, run),
    ...scoreRequiredEvidence(benchmarkCase, run),
    ...scoreForbiddenEvidence(benchmarkCase, run),
    ...scoreEvidenceLimit(benchmarkCase, run),
    ...scoreStages(benchmarkCase, stages),
    ...scoreLexical(benchmarkCase, lexicalUsed),
    ...scoreTemporal(benchmarkCase, run)
  ];
  const score = details.reduce((sum, item) => sum + item.score, 0);
  const maxScore = details.reduce((sum, item) => sum + item.maxScore, 0);
  const required = benchmarkCase.expected.requiredEvidenceIds ?? [];
  const forbidden = benchmarkCase.expected.forbiddenEvidenceIds ?? [];
  const ids = evidenceIds(run);
  const answerDetails = details.filter((item) =>
    item.name.startsWith("answer_contains:")
  );
  const evidenceRelevant =
    required.every((id) => ids.has(id)) &&
    forbidden.every((id) => !ids.has(id));
  const lexicalExpectation = benchmarkCase.expected.lexical?.expectation;
  const lexicalJustified =
    lexicalExpectation === "required"
      ? lexicalUsed
      : lexicalExpectation === "forbidden"
        ? !lexicalUsed
        : true;

  return {
    caseId: benchmarkCase.id,
    runIndex: run.runIndex,
    score,
    maxScore,
    answerCorrect:
      run.answer.memoryStatus === benchmarkCase.expected.memoryStatus &&
      answerDetails.every((item) => item.score === item.maxScore),
    evidenceRelevant,
    irrelevantEvidenceLeaked: forbidden.some((id) => ids.has(id)),
    lexicalUsed,
    lexicalJustified,
    retrievalStagesUsed: stages,
    details
  };
};

export const summarizeRetrievalSuccessBenchmark = (
  runs: RetrievalSuccessRunScore[]
): RetrievalSuccessBenchmarkSummary => {
  const totalScore = runs.reduce((sum, run) => sum + run.score, 0);
  const maxScore = runs.reduce((sum, run) => sum + run.maxScore, 0);
  const count = runs.length || 1;
  return {
    suite: "retrieval-success",
    boundaryProfile: "post-koe-166-defaults",
    runs,
    totalScore,
    maxScore,
    averageScoreRatio: maxScore > 0 ? totalScore / maxScore : 0,
    answerCorrectRate: runs.filter((run) => run.answerCorrect).length / count,
    evidenceRelevantRate:
      runs.filter((run) => run.evidenceRelevant).length / count,
    irrelevantEvidenceLeakRate:
      runs.filter((run) => run.irrelevantEvidenceLeaked).length / count,
    lexicalUseRate: runs.filter((run) => run.lexicalUsed).length / count,
    unjustifiedLexicalUseRate:
      runs.filter((run) => run.lexicalUsed && !run.lexicalJustified).length /
      count
  };
};

export const idealRetrievalSuccessRun = (
  benchmarkCase: RetrievalSuccessCase,
  runIndex = 0
): RetrievalSuccessRunInput => {
  const requiredIds = benchmarkCase.expected.requiredEvidenceIds ?? [];
  const requiredSet = new Set(requiredIds);
  const stageSet = new Set(benchmarkCase.expected.requiredStages ?? []);
  const evidence = benchmarkCase.seed
    .filter((item) => requiredSet.has(item.id))
    .map(
      (item): RetrievalSuccessEvidence => ({
        sourceId: item.id,
        nodeId: item.sourceType === "memory_node" ? item.id : undefined,
        sourceType: item.sourceType,
        retrievalStage: item.retrievalStage,
        summaryText: item.text,
        relevance: "directly supports the benchmark answer"
      })
    );
  const answerMarkdown =
    benchmarkCase.expected.memoryStatus === "not_found"
      ? "No matching memory decision was found."
      : `Relevant memory found: ${(benchmarkCase.expected.answerSubstrings ?? []).join(" ")}`;
  return {
    caseId: benchmarkCase.id,
    runIndex,
    answer: {
      memoryStatus: benchmarkCase.expected.memoryStatus,
      answerMarkdown
    },
    evidence,
    searches: [...stageSet].map((stage) => ({
      retrievalStage: stage,
      query: benchmarkCase.prompt
    })),
    retrievals: [
      {
        stages: [...stageSet].map((stage) => ({
          name: stage,
          used: stage !== "score_scan",
          countAboveThreshold: stage === "score_scan" ? 0 : evidence.length,
          selectedCount: stage === "score_scan" ? 0 : evidence.length
        }))
      }
    ],
    notes: "Deterministic ideal baseline generated from benchmark expectations."
  };
};

export const runDeterministicRetrievalSuccessBenchmark =
  (): RetrievalSuccessBenchmarkSummary => {
    const scored = retrievalSuccessCases.flatMap((benchmarkCase) =>
      Array.from({ length: benchmarkCase.runs }, (_, runIndex) =>
        scoreRetrievalSuccessRun(
          benchmarkCase,
          idealRetrievalSuccessRun(benchmarkCase, runIndex)
        )
      )
    );
    return summarizeRetrievalSuccessBenchmark(scored);
  };
