import { z } from "zod";

const instant = z.string().datetime({ offset: true });
export const RECALL_QUERY_MAX_LENGTH = 100_000;
const usageExpectation = z
  .object({
    jobId: z.string().uuid(),
    attempts: z.number().int().min(1).max(10_000),
    taskAttempts: z.number().int().min(1).max(10_000).optional()
  })
  .strict();
export const recallMemoryStatusSchema = z.enum([
  "found",
  "not_found",
  "insufficient",
  "pending_summary"
]);
// Caller text is self-reported and stored outside encrypted question content.
// Keep it to the characters of a product name or version label. The set is
// ASCII and listed in full so that the database applies exactly the same test
// when it reads a label back, whatever its locale.
export const RECALL_CALLER_LABEL_CHARACTERS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ._+/@()-";
export const RECALL_CALLER_NAME_MAX_LENGTH = 128;
export const RECALL_CALLER_VERSION_MAX_LENGTH = 64;
const callerLabelClass = `[${RECALL_CALLER_LABEL_CHARACTERS.replace(/[\\\]^-]/g, "\\$&")}]`;
const callerLabelPattern = new RegExp(`^${callerLabelClass}+$`);
const notCallerLabel = new RegExp(`[^${callerLabelClass.slice(1, -1)}]+`, "g");
/** Reduce reported client text to a storable label, or null when none remains. */
export const recallCallerLabel = (
  value: unknown,
  maxLength: number
): string | null => {
  if (typeof value !== "string") return null;
  const label = value
    .normalize("NFKC")
    .replace(notCallerLabel, " ")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  return label || null;
};
export const recallCallerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(RECALL_CALLER_NAME_MAX_LENGTH)
      .regex(callerLabelPattern),
    version: z
      .string()
      .trim()
      .min(1)
      .max(RECALL_CALLER_VERSION_MAX_LENGTH)
      .regex(callerLabelPattern)
      .nullable()
  })
  .strict();
export const recallQuestionMetadataSchema = z
  .object({
    version: z.literal(1),
    memoryStatus: recallMemoryStatusSchema.nullable(),
    caller: recallCallerSchema.nullable().optional(),
    usage: usageExpectation.optional(),
    timing: z
      .object({
        acceptedAt: instant,
        completedAt: instant,
        durationMs: z.number().int().nonnegative().max(604_800_000)
      })
      .strict()
      .refine(
        (value) =>
          Date.parse(value.completedAt) - Date.parse(value.acceptedAt) ===
          value.durationMs,
        {
          message:
            "Duration must match retained acceptance and completion boundaries"
        }
      )
      .optional()
  })
  .strict();
// Completion timing comes only from the task repository's retained boundaries.
export const recallQuestionReportedMetadataSchema = recallQuestionMetadataSchema
  .omit({ timing: true })
  .extend({
    usage: usageExpectation.omit({ taskAttempts: true }).optional()
  });
export type RecallQuestionMetadata = z.infer<
  typeof recallQuestionMetadataSchema
>;

export const recallActivityCursorSchema = z
  .object({
    recordedAt: instant,
    id: z.string().uuid()
  })
  .strict();

const recallActivityFiltersSchema = z
  .object({
    from: instant,
    to: instant,
    searchDomain: z.enum(["global", "project", "session"]).optional(),
    status: z.enum(["answered", "error"]).optional(),
    memoryStatus: z
      .enum([
        "found",
        "not_found",
        "insufficient",
        "pending_summary",
        "unknown"
      ])
      .optional(),
    callerName: z.string().max(128).optional(),
    minDurationMs: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(604_800_000)
      .optional(),
    maxDurationMs: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(604_800_000)
      .optional(),
    projectId: z.string().min(1).max(2048).optional(),
    sessionId: z.string().uuid().optional()
  })
  .strict();

export const recallActivityListInputSchema = recallActivityFiltersSchema
  .extend({
    cursor: recallActivityCursorSchema.optional(),
    hydrate: z.boolean().optional(),
    contentIds: z.array(z.string().uuid()).min(1).max(50).optional(),
    limit: z.number().int().min(1).max(50).default(50)
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.from) < Date.parse(value.to) &&
      (value.minDurationMs === undefined ||
        value.maxDurationMs === undefined ||
        value.minDurationMs <= value.maxDurationMs),
    {
      message: "The end of the recorded-time range must follow its start"
    }
  );

const count = z.number().int().nonnegative().nullable();
export const recallUsageTotalsSchema = z
  .object({
    coverage: z.enum(["recorded", "partial", "unavailable"]),
    inputTokens: count,
    cachedInputTokens: count,
    outputTokens: count,
    reasoningOutputTokens: count,
    totalTokens: count,
    recordedAttempts: z.number().int().nonnegative(),
    includesEstimates: z.boolean()
  })
  .strict();
export type RecallUsageTotals = z.infer<typeof recallUsageTotalsSchema>;

export const recallActivityQuestionSchema = z
  .object({
    id: z.string().uuid(),
    recordedAt: instant,
    updatedAt: instant,
    query: z.string().max(RECALL_QUERY_MAX_LENGTH).nullable(),
    queryTruncated: z.boolean().optional(),
    usage: recallUsageTotalsSchema,
    metadata: recallQuestionMetadataSchema.nullable(),
    searchDomain: z.enum(["global", "project", "session"]),
    status: z.enum(["answered", "error"]),
    projectId: z.string().nullable(),
    projectName: z.string().nullable(),
    sessionId: z.string().uuid().nullable()
  })
  .strict();

export const recallActivityPageSchema = z
  .object({
    questions: z.array(recallActivityQuestionSchema).max(50),
    nextCursor: recallActivityCursorSchema.nullable(),
    asOf: instant
  })
  .strict();

export type RecallActivityListInput = z.infer<
  typeof recallActivityListInputSchema
>;
export type RecallActivityQuestion = z.infer<
  typeof recallActivityQuestionSchema
>;
export type RecallActivityPage = z.infer<typeof recallActivityPageSchema>;

export const recallUsageAttemptSchema = z
  .object({
    id: z.string().uuid(),
    observedAt: instant,
    worker: z.string().max(100).nullable(),
    model: z.string().max(512).nullable(),
    accuracy: z.enum([
      "provider_reported",
      "provider_partial",
      "local_estimate"
    ]),
    status: z.enum(["succeeded", "failed", "unknown"]),
    inputTokens: count,
    cachedInputTokens: count,
    outputTokens: count,
    reasoningOutputTokens: count,
    totalTokens: count
  })
  .strict();
export const recallUsageSchema = recallUsageTotalsSchema
  .extend({
    provenance: z.enum(["linked", "historical_job", "unavailable"]),
    truncated: z.boolean(),
    ambiguous: z.boolean(),
    attempts: z.array(recallUsageAttemptSchema).max(200)
  })
  .strict();
export const recallActivityDetailInputSchema = z
  .object({ questionId: z.string().uuid() })
  .strict();
export const recallActivityDetailSchema = z
  .object({
    question: recallActivityQuestionSchema,
    answer: z.string().max(256_000).nullable(),
    memoryStatus: z
      .enum(["found", "not_found", "insufficient", "pending_summary"])
      .nullable(),
    worker: z.string().max(100).nullable(),
    model: z.string().max(512).nullable(),
    searchCount: count,
    expandCount: count,
    candidateCount: count,
    failure: z.string().max(1000).nullable(),
    evidence: z
      .array(
        z
          .object({
            title: z.string().max(512),
            text: z.string().max(16_000),
            sourceId: z.string().max(512).nullable()
          })
          .strict()
      )
      .max(100),
    citations: z
      .array(
        z
          .object({
            title: z.string().max(512),
            text: z.string().max(16_000),
            sourceId: z.string().max(512).nullable()
          })
          .strict()
      )
      .max(100),
    contentTruncated: z.boolean(),
    usage: recallUsageSchema
  })
  .strict();
export type RecallUsage = z.infer<typeof recallUsageSchema>;
export type RecallUsageAttempt = z.infer<typeof recallUsageAttemptSchema>;
export type RecallActivityDetail = z.infer<typeof recallActivityDetailSchema>;

export const recallActivityOverviewInputSchema = recallActivityFiltersSchema
  .extend({
    // Opt in so existing consumers keep their day/week/month response shape.
    bucket: z.literal("hour").optional(),
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine(
        (value) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: value });
            return true;
          } catch {
            return false;
          }
        },
        { message: "Choose a valid display timezone" }
      )
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.to) > Date.parse(value.from) &&
      Date.parse(value.to) - Date.parse(value.from) <= 3660 * 86_400_000 &&
      (value.bucket !== "hour" ||
        Date.parse(value.to) - Date.parse(value.from) <= 25 * 3_600_000) &&
      (value.minDurationMs === undefined ||
        value.maxDurationMs === undefined ||
        value.minDurationMs <= value.maxDurationMs),
    {
      message:
        "Choose a time range of up to ten years, or 25 hours for hourly buckets"
    }
  );
export const recallActivityOverviewSchema = z
  .object({
    filterOptions: z
      .object({
        projects: z.array(
          z
            .object({
              projectId: z.string(),
              projectName: z.string().nullable()
            })
            .strict()
        ),
        callerNames: z.array(z.string().max(RECALL_CALLER_NAME_MAX_LENGTH))
      })
      .strict()
      .optional(),
    asOf: instant,
    timezone: z.string(),
    bucket: z.enum(["hour", "day", "week", "month"]),
    tokens: recallUsageTotalsSchema,
    linkedQuestions: z.number().int().nonnegative(),
    tokenTimeline: z
      .array(
        z
          .object({
            start: instant,
            totalTokens: count,
            recordedAttempts: z.number().int().nonnegative(),
            partial: z.boolean()
          })
          .strict()
      )
      .max(400),
    recordedQuestions: z.number().int().nonnegative(),
    recordedErrors: z.number().int().nonnegative(),
    memoryResults: z
      .object({
        found: z.number().int().nonnegative(),
        not_found: z.number().int().nonnegative(),
        insufficient: z.number().int().nonnegative(),
        pending_summary: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
        foundPercentage: z.number().min(0).max(100).nullable()
      })
      .strict(),
    knownDurations: z.number().int().nonnegative(),
    medianDurationMs: z.number().nonnegative().nullable(),
    questions: z
      .array(
        z
          .object({
            start: instant,
            count: z.number().int().nonnegative(),
            errors: z.number().int().nonnegative(),
            found: z.number().int().nonnegative(),
            notFound: z.number().int().nonnegative(),
            insufficient: z.number().int().nonnegative(),
            pendingSummary: z.number().int().nonnegative(),
            unknown: z.number().int().nonnegative()
          })
          .strict()
      )
      .max(400)
  })
  .strict();
export type RecallActivityOverviewInput = z.infer<
  typeof recallActivityOverviewInputSchema
>;
export type RecallActivityOverview = z.infer<
  typeof recallActivityOverviewSchema
>;
