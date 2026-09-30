import { z } from "zod";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const version = z.number().int().nonnegative();

export const teamAgentRequestStatusSchema = z.enum([
  "awaiting_owner",
  "accepted",
  "declined",
  "withdrawn",
  "unavailable"
]);
export type TeamAgentRequestStatus = z.infer<
  typeof teamAgentRequestStatusSchema
>;

export const teamAgentRequestJobStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
  "offline"
]);

export const teamAgentOfferSchema = z
  .object({
    teamId: uuid,
    agentId: uuid,
    ownerId: uuid,
    ownerName: z.string().trim().min(1).max(160),
    agentName: z.string().trim().min(1).max(128),
    description: z.string().trim().max(500),
    enabled: z.boolean(),
    version: version,
    canManage: z.boolean()
  })
  .strict();
export type TeamAgentOffer = z.infer<typeof teamAgentOfferSchema>;

export const teamAgentOfferPageSchema = z
  .object({
    teamId: uuid,
    items: z.array(teamAgentOfferSchema).max(100),
    nextCursor: z.string().max(512).nullable(),
    serverTime: timestamp
  })
  .strict();
export type TeamAgentOfferPage = z.infer<typeof teamAgentOfferPageSchema>;

export const teamAgentOffersResponseSchema = z
  .object({
    teamId: uuid,
    offers: z.array(teamAgentOfferSchema).max(100),
    serverTime: timestamp
  })
  .strict();
export type TeamAgentOffersResponse = z.infer<
  typeof teamAgentOffersResponseSchema
>;
export const teamAgentOfferResponseSchema = z
  .object({ offer: teamAgentOfferSchema })
  .strict();
export type TeamAgentOfferResponse = z.infer<
  typeof teamAgentOfferResponseSchema
>;

export const teamAgentRequestSchema = z
  .object({
    id: uuid,
    teamId: uuid,
    teamProjectId: uuid,
    channelId: uuid,
    requestMessageId: uuid,
    requesterId: uuid,
    requesterName: z.string().trim().min(1).max(160),
    ownerId: uuid,
    ownerName: z.string().trim().min(1).max(160),
    agentId: uuid,
    agentName: z.string().trim().min(1).max(128),
    status: teamAgentRequestStatusSchema,
    jobId: uuid.nullable(),
    jobStatus: teamAgentRequestJobStatusSchema.nullable(),
    outcomeMessageId: uuid.nullable(),
    version: version,
    createdAt: timestamp,
    updatedAt: timestamp,
    canWithdraw: z.boolean(),
    canReview: z.boolean()
  })
  .strict();
export type TeamAgentRequest = z.infer<typeof teamAgentRequestSchema>;
export const teamAgentRequestResponseSchema = z
  .object({ request: teamAgentRequestSchema })
  .strict();
export type TeamAgentRequestResponse = z.infer<
  typeof teamAgentRequestResponseSchema
>;

export const teamAgentRequestPageSchema = z
  .object({
    teamId: uuid,
    requests: z.array(teamAgentRequestSchema).max(100),
    nextCursor: z.string().max(512).nullable(),
    serverTime: timestamp
  })
  .strict();
export type TeamAgentRequestPage = z.infer<typeof teamAgentRequestPageSchema>;

export const teamAgentRequestInboxSchema = teamAgentRequestPageSchema;
export type TeamAgentRequestInbox = TeamAgentRequestPage;

export const teamAgentRequestReviewSchema = z
  .object({
    teamId: uuid,
    requestId: uuid,
    executionId: uuid.nullable(),
    privateGoal: z.string().max(12_000),
    version
  })
  .strict();
export type TeamAgentRequestReview = z.infer<
  typeof teamAgentRequestReviewSchema
>;
export const teamAgentRequestReviewResponseSchema = z
  .object({ review: teamAgentRequestReviewSchema })
  .strict();
export type TeamAgentRequestReviewResponse = z.infer<
  typeof teamAgentRequestReviewResponseSchema
>;

export const updateTeamAgentOfferInputSchema = z
  .object({
    expectedVersion: version,
    enabled: z.boolean(),
    description: z.string().trim().max(500)
  })
  .strict();
export type UpdateTeamAgentOfferInput = z.infer<
  typeof updateTeamAgentOfferInputSchema
>;

export const createTeamAgentRequestInputSchema = z
  .object({
    idempotencyKey: uuid,
    teamProjectId: uuid,
    channelId: uuid,
    agentId: uuid,
    requestText: z.string().trim().min(1).max(8_000)
  })
  .strict();
export type CreateTeamAgentRequestInput = z.infer<
  typeof createTeamAgentRequestInputSchema
>;

export const listTeamAgentRequestsQuerySchema = z
  .object({
    teamProjectId: uuid.optional(),
    channelId: uuid.optional(),
    status: teamAgentRequestStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(512).optional()
  })
  .strict();

export const updateTeamAgentRequestReviewInputSchema = z
  .object({
    expectedVersion: version,
    privateGoal: z.string().trim().min(1).max(12_000),
    executionId: uuid.nullable()
  })
  .strict();
export type UpdateTeamAgentRequestReviewInput = z.infer<
  typeof updateTeamAgentRequestReviewInputSchema
>;

export const decideTeamAgentRequestInputSchema = z
  .object({
    expectedVersion: version,
    decision: z.enum(["accept", "decline"])
  })
  .strict();
export type DecideTeamAgentRequestInput = z.infer<
  typeof decideTeamAgentRequestInputSchema
>;

export const withdrawTeamAgentRequestInputSchema = z
  .object({ expectedVersion: version })
  .strict();
export type WithdrawTeamAgentRequestInput = z.infer<
  typeof withdrawTeamAgentRequestInputSchema
>;

export const postTeamAgentRequestOutcomeInputSchema = z
  .object({
    expectedVersion: version,
    summary: z.string().trim().min(1).max(2_000)
  })
  .strict();
export type PostTeamAgentRequestOutcomeInput = z.infer<
  typeof postTeamAgentRequestOutcomeInputSchema
>;

export const teamAgentRequestInvalidationSchema = z
  .object({
    type: z.literal("team_agent_request_invalidated"),
    teamId: uuid,
    requestId: uuid.nullable(),
    channelId: uuid.nullable(),
    ownerId: uuid.nullable(),
    kind: z.enum(["request", "offers"])
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "request" && !value.requestId) {
      context.addIssue({
        code: "custom",
        path: ["requestId"],
        message: "Request invalidations require a request ID"
      });
    }
    if (value.kind === "offers" && value.requestId !== null) {
      context.addIssue({
        code: "custom",
        path: ["requestId"],
        message: "Offer invalidations do not identify a request"
      });
    }
  });
export type TeamAgentRequestInvalidation = z.infer<
  typeof teamAgentRequestInvalidationSchema
>;
