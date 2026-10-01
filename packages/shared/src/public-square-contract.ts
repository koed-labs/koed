import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });
const uuid = z.uuid();
export const publicSquareLocalProjectIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .refine((value) => value.toLowerCase() !== "unassigned", {
    message: "A registered Project is required"
  });

export const publicSquareJobStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
  "offline"
]);
export type PublicSquareJobStatus = z.infer<typeof publicSquareJobStatusSchema>;

export const publicSquarePublicationSchema = z
  .object({
    id: uuid,
    jobId: uuid,
    agentId: uuid,
    agentName: z.string().trim().min(1).max(128),
    ownerId: uuid,
    ownerName: z.string().trim().min(1).max(160),
    projectId: uuid,
    projectName: z.string().trim().min(1).max(128),
    ownerExecutionId: uuid.nullable().default(null),
    status: publicSquareJobStatusSchema,
    lastKnownStatus: publicSquareJobStatusSchema.nullable(),
    phase: z.enum(["working", "checking"]).nullable().default(null),
    phaseObservedAt: timestamp.nullable().default(null),
    publishedAt: timestamp,
    startedAt: timestamp.nullable().default(null),
    updatedAt: timestamp,
    completedAt: timestamp.nullable(),
    lastSeenAt: timestamp.nullable(),
    waitingOn: z
      .object({
        userId: uuid,
        name: z.string().trim().min(1).max(160)
      })
      .strict()
      .nullable()
      .default(null),
    ownerLeftTeam: z.boolean(),
    sharedBrief: z.string().max(1000).nullable(),
    version: z.number().int().positive(),
    canEditBrief: z.boolean(),
    canRemoveRetainedBrief: z.boolean()
  })
  .strict();
export type PublicSquarePublication = z.infer<
  typeof publicSquarePublicationSchema
>;

export const publicSquareIdleAgentSchema = z
  .object({
    agentId: uuid,
    agentName: z.string().trim().min(1).max(128),
    ownerId: uuid,
    ownerName: z.string().trim().min(1).max(160)
  })
  .strict();
export type PublicSquareIdleAgent = z.infer<typeof publicSquareIdleAgentSchema>;

export const publicSquarePageSchema = z
  .object({
    teamId: uuid,
    items: z.array(publicSquarePublicationSchema).max(100),
    idleAgents: z.array(publicSquareIdleAgentSchema).default([]),
    nextCursor: z.string().max(512).nullable(),
    serverTime: timestamp
  })
  .strict();
export type PublicSquarePage = z.infer<typeof publicSquarePageSchema>;

export const personalAgentTeamBriefDraftSchema = z
  .object({
    publicationId: uuid,
    briefDraft: z.string().max(1000),
    version: z.number().int().nonnegative()
  })
  .strict();
export type PersonalAgentTeamBriefDraft = z.infer<
  typeof personalAgentTeamBriefDraftSchema
>;

export const teamProjectMemberConnectionSchema = z
  .object({
    teamId: uuid,
    teamProjectId: uuid,
    localProjectId: publicSquareLocalProjectIdSchema.nullable(),
    connectedAt: timestamp.nullable(),
    version: z.number().int().nonnegative()
  })
  .strict();
export type TeamProjectMemberConnection = z.infer<
  typeof teamProjectMemberConnectionSchema
>;

export const teamProjectMemberConnectionInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    localProjectId: publicSquareLocalProjectIdSchema.nullable()
  })
  .strict();

export const publicSquareBriefInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    brief: z.string().trim().min(1).max(1000).nullable()
  })
  .strict();

export const publicSquareListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(512).optional()
  })
  .strict();
