import { z } from "zod";

export const lcmPendingSummariesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(10)
});

export const nodeIdParamsSchema = z.object({ nodeId: z.string().uuid() });

export const sessionIdParamsSchema = z.object({
  sessionId: z.string().uuid()
});

export const pendingSessionTitlesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(25).default(5),
  min_user_events: z.coerce.number().int().positive().max(50).default(3)
});

export const submitSessionTitleSchema = z.object({
  title: z.string().trim().min(1).max(120),
  titleModel: z.string().min(1),
  titlePromptVersion: z.string().min(1)
});

export const submitLcmSummarySchema = z
  .object({
    summaryText: z.string().min(1),
    summaryModel: z.string().min(1),
    summaryPromptVersion: z.string().min(1),
    summaryTokenEstimate: z.coerce.number().int().nonnegative(),
    summaryStructuredJson: z.record(z.string(), z.unknown()).optional(),
    summaryStructuredSchemaVersion: z.string().min(1).optional()
  })
  .superRefine((value, context) => {
    if (
      Boolean(value.summaryStructuredJson) !==
      Boolean(value.summaryStructuredSchemaVersion)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "summaryStructuredJson and summaryStructuredSchemaVersion must be submitted together",
        path: ["summaryStructuredJson"]
      });
    }
  });
