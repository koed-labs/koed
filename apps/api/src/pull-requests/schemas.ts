import { z } from "zod";
import {
  pullRequestOperationPayloadSchema,
  pullRequestReviewDraftSchema
} from "@koed/shared/pull-requests";

export const createOperationSchema = z
  .object({
    requestId: z.string().trim().min(1).max(240),
    target: z
      .object({ deviceId: z.uuid(), deploymentId: z.uuid() })
      .strict()
      .optional(),
    actionGrantId: z.uuid().optional(),
    commandRequestId: z.uuid().optional(),
    payload: pullRequestOperationPayloadSchema
  })
  .strict();
export const sourceControlApprovalIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("publish_review"),
      commandRequestId: z.uuid(),
      requestId: z.uuid(),
      reviewId: z.uuid(),
      frozenReviewId: z.uuid(),
      confirmationDigest: z.string().regex(/^[0-9a-f]{64}$/),
      expectedReviewRevision: z.number().int().positive(),
      targetDeviceId: z.uuid(),
      targetDeploymentId: z.uuid()
    })
    .strict(),
  z
    .object({
      kind: z.literal("push"),
      commandRequestId: z.uuid(),
      requestId: z.uuid(),
      reviewId: z.uuid(),
      proposalId: z.uuid(),
      confirmationDigest: z.string().regex(/^[0-9a-f]{64}$/),
      expectedReviewRevision: z.number().int().positive(),
      targetDeviceId: z.uuid(),
      targetDeploymentId: z.uuid()
    })
    .strict()
]);
export const sourceControlApprovalStateSchema = z
  .object({
    requestId: z.uuid(),
    command: z.enum(["await", "confirm", "cancel"]),
    decision: z.enum(["approve", "cancel"]).optional(),
    actionGrantId: z.uuid()
  })
  .strict();
export const createReviewSchema = z
  .object({
    requestId: z.string().trim().min(1).max(240),
    detailsOperationId: z.uuid(),
    agentId: z.uuid(),
    projectId: z.string().trim().min(1).max(240).nullable().optional()
  })
  .strict();
export const saveDraftSchema = z
  .object({
    expectedReviewRevision: z.number().int().positive(),
    expectedDraftRevision: z.number().int().nonnegative(),
    executionGeneration: z.number().int().positive().nullable(),
    accountId: z.string().trim().min(1).max(200),
    connectionGeneration: z.number().int().positive(),
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
    headSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
    event: pullRequestReviewDraftSchema.shape.event,
    body: z.string().max(65_536),
    findings: pullRequestReviewDraftSchema.shape.findings
  })
  .strict();
export const freezeDraftSchema = z
  .object({
    expectedReviewRevision: z.number().int().positive(),
    expectedDraftRevision: z.number().int().positive(),
    accountId: z.string().trim().min(1).max(200),
    connectionGeneration: z.number().int().positive(),
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
    headSha: z.string().regex(/^[0-9a-f]{40,64}$/iu)
  })
  .strict();
export const reviewParamsSchema = z.object({ reviewId: z.uuid() }).strict();
export const operationParamsSchema = z
  .object({ operationId: z.uuid() })
  .strict();
export const cancelOperationSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export const revisionSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export const refreshSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    detailsOperationId: z.uuid()
  })
  .strict();
export const runnerClaimSchema = z
  .object({
    runnerId: z.string().trim().min(1).max(160),
    limit: z.number().int().min(1).max(8).default(1),
    leaseMs: z.number().int().min(5_000).max(300_000)
  })
  .strict();
export const runnerLeaseSchema = z
  .object({ leaseToken: z.uuid(), runnerId: z.string().trim().min(1).max(160) })
  .strict();
export const runnerCompleteSchema = z
  .object({
    leaseToken: z.uuid(),
    runnerId: z.string().trim().min(1).max(160),
    result: z.record(z.string(), z.unknown())
  })
  .strict();
export const runnerFailSchema = z
  .object({
    leaseToken: z.uuid(),
    state: z.enum(["failed", "uncertain"]),
    runnerId: z.string().trim().min(1).max(160),
    errorCode: z.string().trim().min(1).max(120)
  })
  .strict();
