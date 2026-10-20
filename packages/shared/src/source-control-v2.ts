import { z } from "zod";

import {
  sourceControlOperationSchema,
  sourceControlResultSchema
} from "./source-control.js";

/** Merge is deliberately absent from the strict version-1 contract. */
export const SOURCE_CONTROL_MERGE_CONTRACT_VERSION = 2 as const;
const objectId = z.string().regex(/^[a-f0-9]{40,64}$/i);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = (length: number) => z.string().trim().min(1).max(length);
export const sourceControlMergeMethodSchema = z.enum([
  "merge",
  "squash",
  "rebase"
]);
export const sourceControlMergeOutcomeSchema = z.enum([
  "pending",
  "merged",
  "rejected",
  "unknown"
]);
export const sourceControlMergeCheckSchema = z
  .object({
    id: bounded(512),
    name: bounded(1024),
    source: z.enum(["check_run", "commit_status"]),
    state: z.enum(["success", "failure", "pending"]),
    required: z.boolean(),
    appId: z.number().int().nullable(),
    objectId
  })
  .strict();
export const sourceControlMergeReviewSchema = z
  .object({
    id: bounded(512),
    user: bounded(512),
    commitObjectId: objectId,
    state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]),
    submittedAt: z.iso.datetime({ offset: true })
  })
  .strict();
export const sourceControlMergeReadinessSchema = z
  .object({
    provider: z.literal("github"),
    accountLabel: bounded(512),
    host: bounded(253),
    apiOrigin: z.url(),
    repository: bounded(1024),
    remoteIdentityHash: digest,
    connectionId: z.uuid(),
    executionId: z.uuid(),
    executionGeneration: z.number().int().positive(),
    runnerDeploymentId: z.uuid(),
    runnerDeviceId: z.uuid(),
    credentialGeneration: z.number().int().positive(),
    policyVersion: z.number().int().positive(),
    policyDigest: digest,
    reviewRequestNumber: z.number().int().positive(),
    title: bounded(2048),
    targetBranch: bounded(1024),
    expectedHeadObjectId: objectId,
    mergeability: z.literal("mergeable"),
    reviewDecision: z.literal("approved"),
    requiredReviewCount: z.number().int().nonnegative(),
    approvedReviewCount: z.number().int().nonnegative(),
    reviews: z.array(sourceControlMergeReviewSchema).max(400),
    checks: z.array(sourceControlMergeCheckSchema).max(400),
    allowedMergeMethods: z.array(sourceControlMergeMethodSchema).min(1).max(3),
    mergeMethod: sourceControlMergeMethodSchema,
    protectionDigest: digest
  })
  .strict();
export type SourceControlMergeReadiness = z.infer<
  typeof sourceControlMergeReadinessSchema
>;

const binding = {
  contractVersion: z.literal(SOURCE_CONTROL_MERGE_CONTRACT_VERSION),
  executionId: z.uuid(),
  executionGeneration: z.number().int().positive(),
  remoteIdentityHash: digest
} as const;

export const sourceControlV2RequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...binding,
      kind: z.literal("review_request_merge_capability"),
      reviewRequestNumber: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      ...binding,
      kind: z.literal("review_request_merge_prepare"),
      reviewRequestNumber: z.number().int().positive(),
      mergeMethod: sourceControlMergeMethodSchema
    })
    .strict(),
  z
    .object({
      ...binding,
      kind: z.literal("review_request_merge"),
      operationId: z.uuid(),
      approvalProof: digest
    })
    .strict(),
  z
    .object({
      ...binding,
      kind: z.literal("review_request_merge_status"),
      operationId: z.uuid()
    })
    .strict()
]);
export type SourceControlV2Request = z.infer<
  typeof sourceControlV2RequestSchema
>;

export const sourceControlV2ResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("review_request_merge_capability"),
      available: z.boolean(),
      reason: z.enum([
        "ready",
        "provider_unavailable",
        "policy_unavailable",
        "readiness_unavailable"
      ]),
      allowedMergeMethods: z.array(sourceControlMergeMethodSchema).max(3),
      provider: z
        .enum(["github", "gitlab", "bitbucket", "azure_devops"])
        .nullable(),
      openUrl: z.url().nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal("review_request_merge_prepared"),
      operationId: z.uuid(),
      operationGeneration: z.number().int().positive(),
      idempotencyKey: bounded(160),
      readiness: sourceControlMergeReadinessSchema,
      readinessSnapshotDigest: digest,
      expiresAt: z.iso.datetime({ offset: true })
    })
    .strict(),
  z
    .object({
      kind: z.literal("review_request_merge_result"),
      operationId: z.uuid(),
      outcome: sourceControlMergeOutcomeSchema,
      providerOperationId: z.uuid().nullable(),
      mergeCommitObjectId: objectId.nullable()
    })
    .strict()
]);
export type SourceControlV2Result = z.infer<typeof sourceControlV2ResultSchema>;

export const sourceControlV2NegotiatedOperationSchema = z.union([
  sourceControlOperationSchema,
  sourceControlV2RequestSchema
]);
export const sourceControlV2NegotiatedResultSchema = z.union([
  sourceControlResultSchema,
  sourceControlV2ResultSchema
]);
