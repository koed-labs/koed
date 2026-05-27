import { z } from "zod";

export const lcmPendingSummariesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(10)
});

export const nodeIdParamsSchema = z.object({ nodeId: z.string().uuid() });

export const submitLcmSummarySchema = z.object({
  summaryText: z.string().min(1),
  summaryModel: z.string().min(1),
  summaryPromptVersion: z.string().min(1),
  summaryTokenEstimate: z.coerce.number().int().nonnegative()
});
