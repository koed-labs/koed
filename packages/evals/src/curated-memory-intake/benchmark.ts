import { curatedMemoryIntakeCases } from "./cases.js";
import type { CuratedMemorySemanticAssessment } from "./semantic-judge.js";

export type CuratedMemorySensitivity =
  | "normal"
  | "sensitive"
  | "review_required";

export interface CuratedMemoryIntakeToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface CuratedMemoryIntakeResult {
  proposalId?: string | null;
  proposalStatus?:
    | "pending"
    | "stored"
    | "merged"
    | "superseded"
    | "conflicted"
    | "skipped";
  assertionId?: string | null;
  assertionText?: string | null;
  skippedReason?: string | null;
  review?: {
    outcome: "accepted" | "rejected";
    reasonCategory: string;
    promptTokens: number;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
  } | null;
}

export interface CuratedMemoryRecallHit {
  sourceId?: string;
  sourceType?: string;
  retrievalStage?: string;
  summaryText?: string;
}

export interface CuratedMemoryIntakeRunInput {
  caseId: string;
  runIndex: number;
  calls: CuratedMemoryIntakeToolCall[];
  intake?: CuratedMemoryIntakeResult | null;
  recall?: {
    hits: CuratedMemoryRecallHit[];
  } | null;
  semanticAssessment?: CuratedMemorySemanticAssessment | null;
  notes?: string;
}

export interface CuratedMemoryIntakeCase {
  id: string;
  sourceActor?: "user" | "agent";
  prompt: string;
  runs: number;
  expected: {
    shouldPropose: boolean;
    referenceClaim?: string;
    proposalTopic?: string;
    tags?: string[];
    minEvidenceItems?: number;
    sensitivity?: CuratedMemorySensitivity;
    allowedSensitivities?: CuratedMemorySensitivity[];
    recallQuery?: string;
  };
  notes?: string;
}

export interface CuratedMemoryIntakeScoreDetail {
  name: string;
  score: number;
  maxScore: number;
  reason: string;
  actual?: unknown;
}

export interface CuratedMemoryIntakeRunScore {
  caseId: string;
  runIndex: number;
  score: number;
  maxScore: number;
  proposed: boolean;
  accepted: boolean;
  recalled: boolean;
  review: CuratedMemoryIntakeResult["review"];
  semanticAssessment: CuratedMemorySemanticAssessment | null;
  details: CuratedMemoryIntakeScoreDetail[];
}

export interface CuratedMemoryIntakeBenchmarkSummary {
  suite: "curated-memory-intake";
  runs: CuratedMemoryIntakeRunScore[];
  totalScore: number;
  maxScore: number;
  averageScoreRatio: number;
  proposalDecisionAccuracy: number;
  proposalCallRate: number;
  acceptanceRate: number;
  recallSuccessRate: number;
  falseFactProposalRate: number;
  falseFactStorageRate: number;
  reviewedRunCount: number;
  reviewerDecisionAccuracy: number;
  averageReviewerLatencyMs: number;
  averageReviewerPromptTokens: number;
  averageReviewerInputTokens: number | null;
  averageReviewerOutputTokens: number | null;
  semanticallyJudgedRunCount: number;
  semanticJudgePassRate: number;
  averageSemanticJudgeLatencyMs: number;
  averageSemanticJudgeInputTokens: number | null;
  averageSemanticJudgeOutputTokens: number | null;
}

const intakeCalls = (
  run: CuratedMemoryIntakeRunInput
): CuratedMemoryIntakeToolCall[] =>
  run.calls.filter((call) => call.toolName === "memory_intake_propose");

const arrayStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const evidenceCount = (call: CuratedMemoryIntakeToolCall | undefined): number =>
  arrayStrings(call?.arguments.evidence_conversation_item_ids).length +
  arrayStrings(call?.arguments.evidence_memory_event_ids).length +
  (typeof call?.arguments.source_session_id === "string" ? 1 : 0) +
  (typeof call?.arguments.evidence_exact_quote === "string" ? 1 : 0);

const recallHasExpectedHit = (run: CuratedMemoryIntakeRunInput): boolean => {
  const hits = run.recall?.hits ?? [];
  if (hits.length === 0 || !run.intake?.assertionId) {
    return false;
  }
  return hits.some(
    (hit) =>
      hit.sourceType === "curated_memory" &&
      hit.retrievalStage === "curated_memory_search" &&
      hit.sourceId === run.intake?.assertionId
  );
};

const detail = (
  name: string,
  score: number,
  reason: string,
  actual?: unknown,
  maxScore = 1
): CuratedMemoryIntakeScoreDetail => ({
  name,
  score,
  maxScore,
  reason,
  actual
});

const scoreProposalQuality = (
  benchmarkCase: CuratedMemoryIntakeCase,
  call: CuratedMemoryIntakeToolCall | undefined
): CuratedMemoryIntakeScoreDetail => {
  if (!benchmarkCase.expected.shouldPropose) {
    return detail(
      "proposal_quality",
      call ? 0 : 1,
      call ? "unexpected proposal payload" : "no proposal payload generated"
    );
  }
  const claimOk =
    typeof call?.arguments.proposed_claim === "string" &&
    call.arguments.proposed_claim.trim().length > 0;
  const topicWellFormed =
    call?.arguments.proposed_topic === undefined ||
    (typeof call.arguments.proposed_topic === "string" &&
      call.arguments.proposed_topic.trim().length > 0);
  const tagsWellFormed =
    call?.arguments.tags === undefined ||
    (Array.isArray(call.arguments.tags) &&
      call.arguments.tags.every(
        (tag) => typeof tag === "string" && tag.trim().length > 0
      ));
  const evidenceOk =
    evidenceCount(call) >= (benchmarkCase.expected.minEvidenceItems ?? 1);
  const allowedSensitivities =
    benchmarkCase.expected.allowedSensitivities ??
    (benchmarkCase.expected.sensitivity
      ? [benchmarkCase.expected.sensitivity]
      : []);
  const sensitivityOk =
    allowedSensitivities.length === 0 ||
    allowedSensitivities.includes(
      call?.arguments.sensitivity_hint as CuratedMemorySensitivity
    );

  const ok =
    claimOk && topicWellFormed && tagsWellFormed && evidenceOk && sensitivityOk;
  return detail(
    "proposal_quality",
    ok ? 1 : 0,
    ok
      ? "proposal payload is structurally complete for semantic review"
      : "proposal payload is structurally incomplete",
    {
      claimOk,
      topicWellFormed,
      tagsWellFormed,
      evidenceOk,
      sensitivityOk,
      evidenceCount: evidenceCount(call)
    }
  );
};

export const scoreCuratedMemoryIntakeRun = (
  benchmarkCase: CuratedMemoryIntakeCase,
  run: CuratedMemoryIntakeRunInput
): CuratedMemoryIntakeRunScore => {
  const calls = intakeCalls(run);
  const firstCall = calls[0];
  const shouldPropose = benchmarkCase.expected.shouldPropose;
  const proposed = calls.length > 0;
  const proposalDecisionCorrect = shouldPropose
    ? calls.length === 1
    : calls.length === 0;
  const accepted = ["stored", "merged", "superseded", "conflicted"].includes(
    run.intake?.proposalStatus ?? ""
  );
  const recalled = recallHasExpectedHit(run);

  const details: CuratedMemoryIntakeScoreDetail[] = [
    detail(
      "proposal_decision",
      proposalDecisionCorrect ? 1 : 0,
      proposalDecisionCorrect
        ? "expected proposal decision"
        : shouldPropose
          ? calls.length === 0
            ? "missing proposal"
            : "duplicate proposals"
          : "unexpected proposal",
      calls.length
    ),
    scoreProposalQuality(benchmarkCase, firstCall)
  ];

  if (shouldPropose) {
    details.push(
      detail(
        "intake_acceptance",
        accepted ? 1 : 0,
        accepted
          ? "proposal accepted by async intake"
          : "proposal was not accepted",
        run.intake?.proposalStatus
      ),
      detail(
        "normal_recall",
        recalled ? 1 : 0,
        recalled
          ? "stored Curated Memory retrieved normally"
          : "stored Curated Memory not retrieved normally",
        run.recall?.hits
      ),
      detail(
        "semantic_quality",
        run.semanticAssessment?.passed ? 1 : 0,
        run.semanticAssessment?.passed
          ? "accepted Curated Memory passed independent semantic assessment"
          : run.semanticAssessment?.status === "error"
            ? "independent semantic assessment failed"
            : "accepted Curated Memory did not pass independent semantic assessment",
        run.semanticAssessment ?? null
      )
    );
  } else {
    details.push(
      detail(
        "intake_acceptance",
        !accepted ? 1 : 0,
        accepted ? "negative case was stored" : "negative case not stored",
        run.intake?.proposalStatus
      ),
      detail(
        "normal_recall",
        !recalled ? 1 : 0,
        recalled
          ? "negative case leaked into recall"
          : "negative case absent from recall",
        run.recall?.hits
      )
    );
    if (proposed || accepted) {
      details.push(
        detail(
          "false_fact_penalty",
          -1,
          accepted
            ? "normal or agent-originated message was stored as Curated Memory"
            : "normal or agent-originated message was proposed as Curated Memory",
          { proposed, accepted },
          0
        )
      );
    }
  }

  const score = details.reduce((sum, item) => sum + item.score, 0);
  const maxScore = details.reduce((sum, item) => sum + item.maxScore, 0);
  return {
    caseId: benchmarkCase.id,
    runIndex: run.runIndex,
    score,
    maxScore,
    proposed,
    accepted,
    recalled,
    review: run.intake?.review ?? null,
    semanticAssessment: run.semanticAssessment ?? null,
    details
  };
};

export const summarizeCuratedMemoryIntakeBenchmark = (
  runs: CuratedMemoryIntakeRunScore[]
): CuratedMemoryIntakeBenchmarkSummary => {
  const totalScore = runs.reduce((sum, run) => sum + run.score, 0);
  const maxScore = runs.reduce((sum, run) => sum + run.maxScore, 0);
  const positiveRuns = runs.filter((run) => {
    const benchmarkCase = curatedMemoryIntakeCases.find(
      (item) => item.id === run.caseId
    );
    return benchmarkCase?.expected.shouldPropose;
  });
  const negativeRuns = runs.filter((run) => {
    const benchmarkCase = curatedMemoryIntakeCases.find(
      (item) => item.id === run.caseId
    );
    return benchmarkCase && !benchmarkCase.expected.shouldPropose;
  });
  const reviewedRuns = runs.filter((run) => run.review);
  const semanticallyJudgedRuns = runs.filter(
    (run) => run.semanticAssessment?.status === "judged"
  );
  const average = (values: number[]): number =>
    values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  const averageNullable = (values: Array<number | null>): number | null => {
    const measured = values.filter((value): value is number => value !== null);
    return measured.length === 0 ? null : average(measured);
  };
  return {
    suite: "curated-memory-intake",
    runs,
    totalScore,
    maxScore,
    averageScoreRatio: maxScore === 0 ? 0 : totalScore / maxScore,
    proposalDecisionAccuracy:
      runs.length === 0
        ? 0
        : runs.filter(
            (run) =>
              run.details.find((item) => item.name === "proposal_decision")
                ?.score === 1
          ).length / runs.length,
    proposalCallRate:
      runs.length === 0
        ? 0
        : runs.filter((run) => run.proposed).length / runs.length,
    acceptanceRate:
      positiveRuns.length === 0
        ? 0
        : positiveRuns.filter((run) => run.accepted).length /
          positiveRuns.length,
    recallSuccessRate:
      positiveRuns.length === 0
        ? 0
        : positiveRuns.filter((run) => run.recalled).length /
          positiveRuns.length,
    falseFactProposalRate:
      negativeRuns.length === 0
        ? 0
        : negativeRuns.filter((run) => run.proposed).length /
          negativeRuns.length,
    falseFactStorageRate:
      negativeRuns.length === 0
        ? 0
        : negativeRuns.filter((run) => run.accepted).length /
          negativeRuns.length,
    reviewedRunCount: reviewedRuns.length,
    reviewerDecisionAccuracy:
      reviewedRuns.length === 0
        ? 0
        : reviewedRuns.filter((run) => {
            const benchmarkCase = curatedMemoryIntakeCases.find(
              (item) => item.id === run.caseId
            );
            return benchmarkCase?.expected.shouldPropose === run.accepted;
          }).length / reviewedRuns.length,
    averageReviewerLatencyMs: average(
      reviewedRuns.map((run) => run.review!.latencyMs)
    ),
    averageReviewerPromptTokens: average(
      reviewedRuns.map((run) => run.review!.promptTokens)
    ),
    averageReviewerInputTokens: averageNullable(
      reviewedRuns.map((run) => run.review!.inputTokens)
    ),
    averageReviewerOutputTokens: averageNullable(
      reviewedRuns.map((run) => run.review!.outputTokens)
    ),
    semanticallyJudgedRunCount: semanticallyJudgedRuns.length,
    semanticJudgePassRate:
      semanticallyJudgedRuns.length === 0
        ? 0
        : semanticallyJudgedRuns.filter((run) => run.semanticAssessment!.passed)
            .length / semanticallyJudgedRuns.length,
    averageSemanticJudgeLatencyMs: average(
      semanticallyJudgedRuns.map((run) => run.semanticAssessment!.latencyMs)
    ),
    averageSemanticJudgeInputTokens: averageNullable(
      semanticallyJudgedRuns.map((run) => run.semanticAssessment!.inputTokens)
    ),
    averageSemanticJudgeOutputTokens: averageNullable(
      semanticallyJudgedRuns.map((run) => run.semanticAssessment!.outputTokens)
    )
  };
};

export const idealCuratedMemoryIntakeRun = (
  benchmarkCase: CuratedMemoryIntakeCase,
  runIndex = 0
): CuratedMemoryIntakeRunInput => {
  if (!benchmarkCase.expected.shouldPropose) {
    return {
      caseId: benchmarkCase.id,
      runIndex,
      calls: [],
      intake: { proposalStatus: "skipped" },
      recall: { hits: [] }
    };
  }
  const claim = benchmarkCase.expected.referenceClaim ?? "";
  return {
    caseId: benchmarkCase.id,
    runIndex,
    calls: [
      {
        toolName: "memory_intake_propose",
        arguments: {
          proposed_claim: claim,
          proposed_topic: benchmarkCase.expected.proposalTopic,
          tags: benchmarkCase.expected.tags ?? [],
          sensitivity_hint: benchmarkCase.expected.sensitivity ?? "normal",
          evidence_conversation_item_ids: [
            "11111111-1111-4111-8111-111111111111"
          ],
          evidence_memory_event_ids: [],
          source_project_id: "eval://scorer-self-test"
        }
      }
    ],
    intake: {
      proposalId: "proposal-1",
      proposalStatus: "stored",
      assertionId: "assertion-1",
      assertionText: claim
    },
    semanticAssessment: {
      status: "judged",
      passed: true,
      verdict: "pass",
      dimensions: {
        faithfulness: true,
        qualification_preservation: true,
        durability: true,
        specificity: true,
        rewrite_quality: true
      },
      issues: [],
      rationale: "Ideal benchmark fixture.",
      latencyMs: 0,
      model: "fixture",
      inputTokens: 0,
      outputTokens: 0
    },
    recall: {
      hits: [
        {
          sourceType: "curated_memory",
          sourceId: "assertion-1",
          retrievalStage: "curated_memory_search",
          summaryText: claim
        }
      ]
    }
  };
};

export const runCuratedMemoryIntakeScorerSelfTest = () =>
  summarizeCuratedMemoryIntakeBenchmark(
    curatedMemoryIntakeCases.flatMap((benchmarkCase) =>
      Array.from({ length: benchmarkCase.runs }, (_, runIndex) =>
        scoreCuratedMemoryIntakeRun(
          benchmarkCase,
          idealCuratedMemoryIntakeRun(benchmarkCase, runIndex)
        )
      )
    )
  );
