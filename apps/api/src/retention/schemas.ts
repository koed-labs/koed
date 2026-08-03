import { z } from "zod";

const hashSchema = z.string().regex(/^[0-9A-Fa-f]{64}$/);
const reasonCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const optionalUuidSchema = z.uuid().nullable().optional();

export const retentionTeamParamsSchema = z
  .object({ teamId: z.uuid() })
  .strict();

export const retentionPolicyParamsSchema = z
  .object({ teamId: z.uuid(), policyId: z.uuid() })
  .strict();

export const retentionPolicyPreviewParamsSchema = z
  .object({ teamId: z.uuid(), policyId: z.uuid(), previewId: z.uuid() })
  .strict();

export const legalHoldParamsSchema = z.object({ holdId: z.uuid() }).strict();

export const retentionOwnerPrivateReplicaParamsSchema = z
  .object({ ownerPrivateReplicaId: z.uuid() })
  .strict();

export const rootTeamDeletionRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .optional()
  })
  .strict();

export const ownerPrivateReplicaPurgeRequestSchema =
  rootTeamDeletionRequestSchema;

export const userErasureRequestSchema = z
  .object({ confirmation: z.literal("erase_my_user") })
  .strict();

export const versionRetentionPolicySchema = z
  .object({
    retentionSeconds: z.number().int().nonnegative(),
    deletionGraceSeconds: z.number().int().nonnegative().optional(),
    backupRetentionSeconds: z.number().int().nonnegative().optional(),
    effectiveAt: z.coerce.date()
  })
  .strict();

export const previewRetentionPolicyShorteningSchema = z
  .object({
    policyVersion: z.number().int().positive(),
    graceSeconds: z.number().int().positive()
  })
  .strict();

export const confirmRetentionPolicyShorteningSchema = z
  .object({
    previewHash: hashSchema,
    expectedAffectedScopeCount: z.number().int().nonnegative()
  })
  .strict();

const teamHoldTargetSchema = z
  .object({
    scope: z.literal("team"),
    teamId: z.uuid()
  })
  .strict();

const workspaceHoldTargetSchema = z
  .object({
    scope: z.literal("workspace"),
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid()
  })
  .strict();

const threadHoldTargetSchema = z
  .object({
    scope: z.literal("thread"),
    teamId: z.uuid(),
    teamWorkspaceId: optionalUuidSchema,
    threadId: z.uuid()
  })
  .strict();

const grantRepresentationHoldTargetSchema = z
  .object({
    scope: z.literal("grant_representation"),
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid(),
    shareGrantId: z.uuid(),
    representationId: z.uuid(),
    representation: z.enum(["memory_events", "lcm_leaves", "lcm_rollups"]),
    sourceRevision: z.number().int().nonnegative(),
    logicalMemoryId: z.uuid()
  })
  .strict();

const messageRangeTargetSchema = z
  .object({
    scope: z.literal("team_message_range"),
    teamId: z.uuid(),
    teamWorkspaceId: optionalUuidSchema,
    threadId: z.uuid(),
    messageRangeStart: z.number().int().positive().nullable().optional(),
    messageRangeEnd: z.number().int().positive().nullable().optional(),
    messageTimeStart: z.coerce.date().nullable().optional(),
    messageTimeEnd: z.coerce.date().nullable().optional()
  })
  .strict();

export const teamLegalHoldTargetSchema = z.discriminatedUnion("scope", [
  teamHoldTargetSchema,
  workspaceHoldTargetSchema,
  threadHoldTargetSchema,
  grantRepresentationHoldTargetSchema,
  messageRangeTargetSchema
]);

export const placeLegalHoldSchema = z
  .object({
    target: teamLegalHoldTargetSchema,
    reasonCode: reasonCodeSchema,
    reasonHash: hashSchema
  })
  .strict();

export const confirmLegalHoldReleaseSchema = z
  .object({
    singleHolderReleaseException: z.boolean().optional()
  })
  .strict();
