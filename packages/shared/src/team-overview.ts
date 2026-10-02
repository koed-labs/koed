import { z } from "zod";

export const teamOverviewSchemaVersion = "koed.team-overview/v1" as const;

export const teamOverviewSourceSchema = z.enum([
  "message_attention",
  "agent_request",
  "team_job_action",
  "team_job_outcome",
  "pull_request_action"
]);
export type TeamOverviewSource = z.infer<typeof teamOverviewSourceSchema>;

export const teamOverviewDestinationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("thread"),
      threadId: z.uuid(),
      rootMessageId: z.uuid().nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent_request"),
      requestId: z.uuid(),
      threadId: z.uuid(),
      rootMessageId: z.uuid().nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal("team_job"),
      publicationId: z.uuid(),
      jobId: z.uuid(),
      teamProjectId: z.uuid()
    })
    .strict(),
  z
    .object({
      kind: z.literal("pull_request_review"),
      reviewId: z.uuid(),
      repositoryId: z.string().min(1).max(256),
      number: z.number().int().positive()
    })
    .strict()
]);
export type TeamOverviewDestination = z.infer<
  typeof teamOverviewDestinationSchema
>;

export const teamOverviewItemSchema = z
  .object({
    sourceEventId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    source: teamOverviewSourceSchema,
    sourceId: z.string().min(1).max(160),
    sourceRevision: z.string().min(1).max(256),
    teamId: z.uuid(),
    teamName: z.string().min(1).max(256),
    kind: z.enum([
      "message",
      "agent_request",
      "job_action",
      "job_outcome",
      "pull_request_action"
    ]),
    priority: z.enum(["blocker", "attention"]),
    state: z.enum(["blocked", "recent"]),
    title: z.string().min(1).max(300),
    summary: z.string().max(1000).nullable(),
    updatedAt: z.iso.datetime({ offset: true }),
    unreadCount: z.number().int().nonnegative().optional(),
    destination: teamOverviewDestinationSchema
  })
  .strict();
export type TeamOverviewItem = z.infer<typeof teamOverviewItemSchema>;

export const teamOverviewOutcomeRefSchema = z
  .object({
    teamId: z.uuid(),
    sourceEventId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    sourceRevision: z.string().min(1).max(256)
  })
  .strict();
export type TeamOverviewOutcomeRef = z.infer<
  typeof teamOverviewOutcomeRefSchema
>;

export const teamOverviewTeamSchema = z
  .object({
    teamId: z.uuid(),
    name: z.string().min(1).max(256),
    badgeCount: z.number().int().nonnegative()
  })
  .strict();
export type TeamOverviewTeam = z.infer<typeof teamOverviewTeamSchema>;

export const teamOverviewCoverageSchema = z
  .object({
    source: teamOverviewSourceSchema,
    complete: z.boolean(),
    nextCursor: z.string().max(512).nullable()
  })
  .strict();

export const teamOverviewAccessSchema = z
  .object({
    accountScope: z.string().min(1).max(256),
    backendId: z.string().min(1).max(256).nullable()
  })
  .strict();

export const teamOverviewSnapshotSchema = z
  .object({
    schemaVersion: z.literal(teamOverviewSchemaVersion),
    access: teamOverviewAccessSchema,
    generatedAt: z.iso.datetime({ offset: true }),
    teams: z.array(teamOverviewTeamSchema),
    coverage: z.array(teamOverviewCoverageSchema),
    currentJobOutcomes: z.array(teamOverviewOutcomeRefSchema),
    attention: z.array(teamOverviewItemSchema),
    catchUp: z.array(teamOverviewItemSchema),
    cleared: z.array(teamOverviewItemSchema),
    nextCursor: z.string().max(512).nullable(),
    badgeCount: z.number().int().nonnegative()
  })
  .strict();
export type TeamOverviewSnapshot = z.infer<typeof teamOverviewSnapshotSchema>;

export const teamOverviewQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100)
  })
  .strict();

export const teamOverviewSourceMutationSchema = z
  .object({
    sourceRevision: z.string().min(1).max(256)
  })
  .strict();
export const teamOverviewMutationResultSchema = z
  .object({
    sourceEventId: z.string().min(1).max(160),
    sourceRevision: z.string().min(1).max(256),
    cleared: z.boolean(),
    seen: z.boolean()
  })
  .strict();

export const collaborationMentionUserIdsSchema = z
  .array(z.uuid())
  .max(40)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Mentioned users must be distinct"
  );
