import type { ArenaCase, RankedEvidence } from "./contracts.js";

export interface RetrievalMetrics {
  [key: string]: number | null;
  requiredEvidenceGroupRecall: number;
  gradedPrecision: number;
  gradedRecall: number;
  mrr: number;
  ndcg: number;
  candidatePoolRecall: number | null;
  selectedEvidenceRecall: number;
  forbiddenEvidenceRate: number;
  irrelevantEvidenceRate: number;
}

const gain = (grade: number): number => 2 ** grade - 1;

export const scoreRetrieval = (
  benchmarkCase: ArenaCase,
  evidence: RankedEvidence[],
  candidates: RankedEvidence[] | null = evidence
): RetrievalMetrics => {
  const qrels = new Map(benchmarkCase.qrels.map((qrel) => [qrel.itemId, qrel]));
  const relevant = benchmarkCase.qrels.filter(
    (qrel) => qrel.grade > 0 && !qrel.forbidden
  );
  const groups = new Set(
    relevant.flatMap((qrel) => (qrel.evidenceGroup ? [qrel.evidenceGroup] : []))
  );
  const selectedGroups = new Set(
    evidence.flatMap(({ itemId }) => {
      const qrel = qrels.get(itemId);
      return qrel?.grade && qrel.evidenceGroup ? [qrel.evidenceGroup] : [];
    })
  );
  const selectedGain = evidence.reduce(
    (sum, item) => sum + gain(qrels.get(item.itemId)?.grade ?? 0),
    0
  );
  const totalGain = relevant.reduce((sum, qrel) => sum + gain(qrel.grade), 0);
  const firstRelevant = evidence.findIndex(
    (item) => (qrels.get(item.itemId)?.grade ?? 0) > 0
  );
  const dcg = evidence.reduce(
    (sum, item, index) =>
      sum + gain(qrels.get(item.itemId)?.grade ?? 0) / Math.log2(index + 2),
    0
  );
  const ideal = [...relevant]
    .sort((left, right) => right.grade - left.grade)
    .slice(0, evidence.length)
    .reduce(
      (sum, qrel, index) => sum + gain(qrel.grade) / Math.log2(index + 2),
      0
    );
  const candidateIds = candidates
    ? new Set(candidates.map((item) => item.itemId))
    : null;
  const candidateRecalled = candidateIds
    ? relevant.filter((qrel) => candidateIds.has(qrel.itemId)).length
    : null;
  const forbidden = evidence.filter(
    (item) => qrels.get(item.itemId)?.forbidden
  ).length;
  const irrelevant = evidence.filter(
    (item) => (qrels.get(item.itemId)?.grade ?? 0) === 0
  ).length;
  return {
    requiredEvidenceGroupRecall:
      groups.size === 0 ? 1 : selectedGroups.size / groups.size,
    gradedPrecision:
      evidence.length === 0 ? 0 : selectedGain / (evidence.length * gain(3)),
    gradedRecall: totalGain === 0 ? 1 : selectedGain / totalGain,
    mrr: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    ndcg: ideal === 0 ? 0 : dcg / ideal,
    candidatePoolRecall:
      candidateRecalled === null
        ? null
        : relevant.length === 0
          ? 1
          : candidateRecalled / relevant.length,
    selectedEvidenceRecall: totalGain === 0 ? 1 : selectedGain / totalGain,
    forbiddenEvidenceRate:
      evidence.length === 0 ? 0 : forbidden / evidence.length,
    irrelevantEvidenceRate:
      evidence.length === 0 ? 0 : irrelevant / evidence.length
  };
};

export const deterministicAnswerChecks = (
  benchmarkCase: ArenaCase,
  answer: string,
  status: ArenaCase["answerChecks"]["status"]
): Record<string, boolean> => {
  const checks: Record<string, boolean> = {
    status: status === benchmarkCase.answerChecks.status,
    exactFacts: benchmarkCase.answerChecks.exactFacts.every((fact) =>
      answer.includes(fact)
    ),
    forbiddenFacts: benchmarkCase.answerChecks.forbiddenFacts.every(
      (fact) => !answer.includes(fact)
    )
  };
  if (benchmarkCase.answerChecks.requiredJsonKeys.length > 0) {
    try {
      const parsed = JSON.parse(answer) as Record<string, unknown>;
      checks.schema = benchmarkCase.answerChecks.requiredJsonKeys.every(
        (key) => key in parsed
      );
    } catch {
      checks.schema = false;
    }
  }
  return checks;
};
