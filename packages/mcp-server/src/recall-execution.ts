import type {
  RecallExecution,
  RecallDeliveryOperation
} from "@koed-labs/shared";

/** Snapshot only at the execution owner. Limits and counters share one run's
 * ledger; attempts inside it are already included in cumulative consumption. */
export const recordRecallExecution = (
  config: {
    maxEvidenceTokens: number;
    maxPromptTokens: number;
    maxSearches: number;
    maxExpansions: number;
    maxAttempts: number;
  },
  ledger: {
    workingSetTokens: number | null;
    promptTokenEstimateConsumed: number;
    searchAttempts: number;
    expansionAttempts: number;
    workerAttempts: number;
    budgetExhaustions: NonNullable<RecallExecution["budgets"]>["exhausted"];
    deliveryOperations: RecallDeliveryOperation[];
    deliveryTruncated: boolean;
  },
  final: { tokens: number; count: number } | null
): RecallExecution => {
  const allowance = (limit: number, consumed: number | null) => ({
    limit,
    consumed,
    remaining: consumed === null ? null : Math.max(0, limit - consumed)
  });
  return {
    version: 1,
    budgets: {
      evidenceWorkingSet: allowance(
        config.maxEvidenceTokens,
        ledger.workingSetTokens
      ),
      finalEvidenceBundle: allowance(
        config.maxEvidenceTokens,
        final?.tokens ?? null
      ),
      cumulativePrompt: allowance(
        config.maxPromptTokens,
        ledger.promptTokenEstimateConsumed
      ),
      searches: allowance(config.maxSearches, ledger.searchAttempts),
      expansions: allowance(config.maxExpansions, ledger.expansionAttempts),
      attempts: allowance(config.maxAttempts, ledger.workerAttempts),
      exhausted: [...ledger.budgetExhaustions]
    },
    delivery: {
      operations: ledger.deliveryOperations,
      truncated: ledger.deliveryTruncated,
      finalSelected: final?.count ?? null
    }
  };
};
