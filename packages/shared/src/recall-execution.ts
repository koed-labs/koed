import { z } from "zod";

const measurement = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const recallAllowanceSchema = z
  .object({
    limit: measurement.nullable(),
    consumed: measurement.nullable(),
    remaining: measurement.nullable()
  })
  .strict();
export const recallBudgetKindSchema = z.enum([
  "wall_time",
  "searches",
  "expansions",
  "attempts",
  "candidates",
  "evidence_items",
  "evidence_tokens",
  "prompt_tokens"
]);
export const recallOmissionReasonSchema = z.enum([
  "evidence_tokens",
  "evidence_items",
  "candidates",
  "prompt_tokens",
  "recovery_reserve"
]);
export const recallDeliveryOperationSchema = z
  .object({
    kind: z.enum(["search", "scan", "expand", "targeted_expand"]),
    attempt: measurement.nullable(),
    delivered: measurement.nullable(),
    omitted: measurement.nullable(),
    reasons: z.array(recallOmissionReasonSchema).max(5),
    recovered: z.boolean(),
    failed: z.boolean()
  })
  .strict();
/** Runtime-owned measurements for one execution, including its synthesis retries.
 * No source bodies, selectors, query text, or provider billing estimates belong here. */
export const recallExecutionSchema = z
  .object({
    version: z.literal(1),
    budgets: z
      .object({
        evidenceWorkingSet: recallAllowanceSchema,
        finalEvidenceBundle: recallAllowanceSchema,
        cumulativePrompt: recallAllowanceSchema,
        searches: recallAllowanceSchema,
        expansions: recallAllowanceSchema,
        attempts: recallAllowanceSchema,
        exhausted: z.array(recallBudgetKindSchema).max(8)
      })
      .strict()
      .nullable(),
    delivery: z
      .object({
        operations: z.array(recallDeliveryOperationSchema).max(100),
        truncated: z.boolean(),
        finalSelected: measurement.nullable()
      })
      .strict()
      .nullable()
  })
  .strict();
export type RecallExecution = z.infer<typeof recallExecutionSchema>;
export type RecallAllowance = z.infer<typeof recallAllowanceSchema>;
export type RecallDeliveryOperation = z.infer<
  typeof recallDeliveryOperationSchema
>;

/** Identity-only projection of the retained selection. Names are owner-authorized
 * current labels; they do not change the accepted set or imply contribution. */
export const recallScopeSchema = z
  .object({
    kind: z.enum([
      "projects",
      "folder",
      "repository",
      "global",
      "session",
      "unknown"
    ]),
    provenance: z.enum(["accepted", "legacy", "unavailable"]),
    projects: z.array(
      z
        .object({
          projectId: z.string(),
          projectName: z.string().nullable()
        })
        .strict()
    ),
    label: z.string().nullable()
  })
  .strict();
export type RecallScope = z.infer<typeof recallScopeSchema>;
