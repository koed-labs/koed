import { z } from "zod";

const uuid = z.uuid();
const sha = z.string().regex(/^[0-9a-f]{40,64}$/iu);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const bounded = (max: number) => z.string().trim().min(1).max(max);

export const pullRequestRepositorySchema = z
  .object({
    id: bounded(120),
    owner: bounded(200),
    name: bounded(200),
    fullName: bounded(401)
  })
  .strict();
export type PullRequestRepository = z.infer<typeof pullRequestRepositorySchema>;

export const pullRequestAccountSchema = z
  .object({ id: bounded(200), login: bounded(200) })
  .strict();
export type PullRequestAccount = z.infer<typeof pullRequestAccountSchema>;

export const pullRequestReviewStatusSchema = z.enum([
  "starting",
  "active",
  "stale",
  "draft",
  "frozen",
  "published",
  "uncertain",
  "failed",
  "cancelled"
]);
export type PullRequestReviewStatus = z.infer<
  typeof pullRequestReviewStatusSchema
>;

export const pullRequestReviewSchema = z
  .object({
    id: uuid,
    ownerUserId: uuid,
    agentId: uuid,
    agentVersion: z.number().int().positive(),
    executionId: uuid.nullable(),
    projectId: z.string().trim().min(1).max(240).nullable(),
    targetDeviceId: bounded(240),
    targetDeploymentId: bounded(240),
    account: pullRequestAccountSchema,
    repository: pullRequestRepositorySchema,
    pullRequestNumber: z.number().int().positive(),
    expectedBaseSha: sha,
    expectedHeadSha: sha,
    connectionGeneration: z.number().int().positive(),
    workMode: z.enum(["review", "fix"]),
    reviewedBaseSha: sha.nullable(),
    reviewedHeadSha: sha.nullable(),
    reviewedExecutionGeneration: z.number().int().positive().nullable(),
    status: pullRequestReviewStatusSchema,
    revision: z.number().int().positive(),
    draftRevision: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime()
  })
  .strict();
export type PullRequestReviewRecord = z.infer<typeof pullRequestReviewSchema>;

export const pullRequestFindingSchema = z
  .object({
    path: bounded(4_096),
    line: z.number().int().positive().nullable(),
    side: z.enum(["LEFT", "RIGHT"]).nullable(),
    body: bounded(20_000)
  })
  .strict();
export type PullRequestFinding = z.infer<typeof pullRequestFindingSchema>;

export const pullRequestReviewDraftSchema = z
  .object({
    reviewId: uuid,
    revision: z.number().int().positive(),
    origin: z.enum(["agent", "owner"]),
    executionGeneration: z.number().int().positive().nullable(),
    accountId: bounded(200),
    baseSha: sha,
    headSha: sha,
    event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).nullable(),
    body: z.string().max(65_536),
    findings: z.array(pullRequestFindingSchema).max(100),
    updatedAt: z.iso.datetime()
  })
  .strict();
export type PullRequestReviewDraft = z.infer<
  typeof pullRequestReviewDraftSchema
>;

export const pullRequestFrozenReviewSchema = z
  .object({
    id: uuid,
    reviewId: uuid,
    draftRevision: z.number().int().positive(),
    accountId: bounded(200),
    connectionGeneration: z.number().int().positive(),
    baseSha: sha,
    headSha: sha,
    event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
    body: z.string().max(65_536),
    findings: z.array(pullRequestFindingSchema).max(100),
    digest,
    createdAt: z.iso.datetime()
  })
  .strict();
export type PullRequestFrozenReview = z.infer<
  typeof pullRequestFrozenReviewSchema
>;

export const pullRequestOperationKindSchema = z.enum([
  "connection_status",
  "accounts",
  "connect",
  "browser_sign_in",
  "disconnect",
  "repositories",
  "inbox",
  "pull_request_details",
  "prepare_checkout",
  "publish_review",
  "reconcile_review",
  "prepare_push",
  "push",
  "reconcile_push"
]);
export type PullRequestOperationKind = z.infer<
  typeof pullRequestOperationKindSchema
>;

const readSelection = z.object({
  account: pullRequestAccountSchema,
  connectionGeneration: z.number().int().positive()
});

export const pullRequestOperationPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("connection_status") }).strict(),
  z.object({ kind: z.literal("accounts") }).strict(),
  z.object({ kind: z.literal("connect"), login: bounded(200) }).strict(),
  z.object({ kind: z.literal("browser_sign_in") }).strict(),
  z
    .object({
      kind: z.literal("disconnect"),
      account: pullRequestAccountSchema,
      connectionGeneration: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      kind: z.literal("repositories"),
      ...readSelection.shape,
      cursor: z.string().max(2_000).nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal("inbox"),
      ...readSelection.shape,
      repository: pullRequestRepositorySchema.nullable(),
      cursor: z.string().max(2_000).nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal("pull_request_details"),
      ...readSelection.shape,
      repository: pullRequestRepositorySchema,
      pullRequestNumber: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      kind: z.literal("prepare_checkout"),
      reviewId: uuid,
      expectedRevision: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      kind: z.literal("publish_review"),
      reviewId: uuid,
      frozenReviewId: uuid,
      confirmationDigest: digest,
      expectedReviewRevision: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      kind: z.literal("reconcile_review"),
      reviewId: uuid,
      frozenReviewId: uuid,
      uncertainOperationId: uuid
    })
    .strict(),
  z
    .object({
      kind: z.literal("prepare_push"),
      reviewId: uuid,
      expectedRevision: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      kind: z.literal("push"),
      reviewId: uuid,
      pushProposalId: uuid,
      confirmationDigest: digest,
      expectedReviewRevision: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      kind: z.literal("reconcile_push"),
      reviewId: uuid,
      pushProposalId: uuid,
      uncertainOperationId: uuid
    })
    .strict()
]);
export type PullRequestOperationPayload = z.infer<
  typeof pullRequestOperationPayloadSchema
>;

export const pullRequestOperationResultSchema = z.record(
  z.string(),
  z.unknown()
);
export type PullRequestOperationResult = z.infer<
  typeof pullRequestOperationResultSchema
>;

export const pullRequestOperationStateSchema = z.enum([
  "pending",
  "claimed",
  "completed",
  "failed",
  "uncertain",
  "cancelled"
]);
export type PullRequestOperationState = z.infer<
  typeof pullRequestOperationStateSchema
>;

export const pullRequestOperationSchema = z
  .object({
    id: uuid,
    ownerUserId: uuid,
    reviewId: uuid.nullable(),
    targetDeviceId: bounded(240),
    targetDeploymentId: bounded(240),
    requestId: bounded(240),
    requestDigest: digest,
    payload: pullRequestOperationPayloadSchema,
    state: pullRequestOperationStateSchema,
    result: pullRequestOperationResultSchema.nullable(),
    errorCode: bounded(120).nullable(),
    revision: z.number().int().positive(),
    attempt: z.number().int().nonnegative(),
    leaseToken: uuid.nullable(),
    leaseExpiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable()
  })
  .strict();
export type PullRequestOperationRecord = z.infer<
  typeof pullRequestOperationSchema
>;

export const pullRequestOperationPageSchema = z
  .object({
    operations: z.array(pullRequestOperationSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable()
  })
  .strict();
export type PullRequestOperationPage = z.infer<
  typeof pullRequestOperationPageSchema
>;

// Only explicit, bounded review output is machine-readable. Ordinary prose is
// never inferred into findings or public GitHub content.
export const parsePullRequestReviewOutput = (
  text: string
): {
  body: string;
  findings: PullRequestFinding[];
  displayText: string;
} | null => {
  if (typeof text !== "string" || text.length > 512_000) return null;
  const blocks = [...text.matchAll(/^```json\s*\n([\s\S]*?)^```\s*$/gm)];
  const candidates: Array<{
    body: string;
    findings: PullRequestFinding[];
    block: string;
  }> = [];
  for (const block of blocks) {
    const content = block[1];
    if (!content || content.length > 256_000) continue;
    try {
      const parsed = z
        .object({
          koedReview: z
            .object({
              body: z.string().max(65_536),
              findings: z.array(pullRequestFindingSchema).max(100)
            })
            .strict()
        })
        .strict()
        .safeParse(JSON.parse(content));
      if (parsed.success)
        candidates.push({ ...parsed.data.koedReview, block: block[0] });
    } catch {
      /* Invalid output remains ordinary chat text. */
    }
  }
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  if (!candidate) return null;
  const visible = text.replace(candidate.block, "").trim();
  return {
    body: candidate.body,
    findings: candidate.findings,
    displayText: visible || candidate.body
  };
};
