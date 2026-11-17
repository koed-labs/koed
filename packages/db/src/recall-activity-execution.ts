import {
  recallExecutionSchema,
  recallBudgetKindSchema,
  type RecallExecution,
  type RecallAllowance
} from "@koed-labs/shared";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

/** Historical traces retain configured limits and cumulative prompt accounting,
 * but their evidence counter sometimes includes final support. Do not relabel it
 * as a helper working set, or pre-admission search hits as delivered sources. */
export const projectRecallExecution = (
  retrieval: unknown
): RecallExecution | null => {
  const retained = object(retrieval);
  const current = recallExecutionSchema.safeParse(retained.activityExecution);
  if (current.success) return current.data;
  const trace = object(retained.trace);
  if (trace.version !== 2) return null;
  const budgets = object(trace.budgets);
  const configured = object(budgets.configured);
  const consumed = object(budgets.consumed);
  const remaining = object(budgets.remaining);
  if (!Object.keys(configured).length) return null;
  const allowance = (key: string, known = true): RecallAllowance => ({
    limit: count(configured[key]),
    consumed: known ? count(consumed[key]) : null,
    remaining: known ? count(remaining[key]) : null
  });
  return {
    version: 1,
    budgets: {
      evidenceWorkingSet: allowance("evidenceTokens", false),
      finalEvidenceBundle: allowance("evidenceTokens", false),
      cumulativePrompt: allowance("promptTokens"),
      searches: allowance("searches"),
      expansions: allowance("expansions"),
      attempts: allowance("attempts"),
      exhausted: Array.isArray(budgets.exhausted)
        ? [
            ...new Set(
              budgets.exhausted.flatMap((item) => {
                const parsed = recallBudgetKindSchema.safeParse(item);
                return parsed.success ? [parsed.data] : [];
              })
            )
          ]
        : []
    },
    delivery: null
  };
};
