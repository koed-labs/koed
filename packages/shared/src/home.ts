import { z } from "zod";

export const homeFeedSchemaVersion = "koed.home-feed/v1" as const;

export const homeSourceSchema = z.enum([
  "managed_runtime_item",
  "managed_execution",
  "personal_agent_job",
  "pull_request_review"
]);
export type HomeSource = z.infer<typeof homeSourceSchema>;

export const homeDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("execution"), executionId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("pull_request_review"),
      reviewId: z.uuid(),
      repositoryId: z.string().min(1).max(256),
      number: z.number().int().positive()
    })
    .strict()
]);
export type HomeDestination = z.infer<typeof homeDestinationSchema>;

export const homeItemKindSchema = z.enum([
  "question",
  "approval",
  "intervention",
  "job_review",
  "pull_request_review",
  "publication"
]);
export type HomeItemKind = z.infer<typeof homeItemKindSchema>;

export const homeItemSchema = z
  .object({
    /** Stable identity for the source event, suitable for a route path segment. */
    sourceEventId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    source: homeSourceSchema,
    sourceId: z.string().min(1).max(160),
    /** Producer revision; dismissal applies only to this exact revision. */
    sourceRevision: z.string().min(1).max(256),
    kind: homeItemKindSchema,
    state: z.enum(["blocked", "review", "ongoing", "recent"]),
    title: z.string().min(1).max(300),
    summary: z.string().max(1000).nullable(),
    updatedAt: z.iso.datetime({ offset: true }),
    destination: homeDestinationSchema
  })
  .strict();
export type HomeItem = z.infer<typeof homeItemSchema>;

export const homeSourceCoverageSchema = z
  .object({
    source: homeSourceSchema,
    complete: z.boolean(),
    nextCursor: z.string().max(512).nullable()
  })
  .strict();
export type HomeSourceCoverage = z.infer<typeof homeSourceCoverageSchema>;

export const homeSnapshotSchema = z
  .object({
    schemaVersion: z.literal(homeFeedSchemaVersion),
    /** Opaque, stable identifier for the authenticated owner scope. */
    accountScope: z.string().min(1).max(256),
    generatedAt: z.iso.datetime({ offset: true }),
    coverage: z.array(homeSourceCoverageSchema),
    needsYou: z.array(homeItemSchema),
    cleared: z.array(homeItemSchema),
    ongoing: z.array(homeItemSchema),
    recent: z.array(homeItemSchema),
    badgeCount: z.number().int().nonnegative()
  })
  .strict();
export type HomeSnapshot = z.infer<typeof homeSnapshotSchema>;

export const homeAccessSchema = z
  .object({
    /** Opaque stable owner and authority-deployment scope. */
    accountScope: z.string().min(1).max(256),
    backendId: z.string().min(1).max(256).nullable()
  })
  .strict();
export type HomeAccess = z.infer<typeof homeAccessSchema>;

export const homeReminderMutationSchema = z
  .object({ sourceRevision: z.string().min(1).max(256) })
  .strict();
export type HomeReminderMutation = z.infer<typeof homeReminderMutationSchema>;

export const homeReminderMutationResultSchema = z
  .object({
    sourceEventId: z.string().min(1).max(160),
    sourceRevision: z.string().min(1).max(256),
    cleared: z.boolean()
  })
  .strict();
export type HomeReminderMutationResult = z.infer<
  typeof homeReminderMutationResultSchema
>;
