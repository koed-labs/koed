import { z } from "zod";

export const SOURCE_CONTROL_CONTRACT_VERSION = 1 as const;
export const SOURCE_CONTROL_POLICY_VERSION = 1 as const;

export const sourceControlProviderSchema = z.enum([
  "github",
  "gitlab",
  "bitbucket",
  "azure_devops"
]);
export type SourceControlProvider = z.infer<typeof sourceControlProviderSchema>;

export const sourceControlCapabilitySchema = z.enum([
  "repository_read",
  "branch_read",
  "fetch",
  "clone",
  "push",
  "review_request_read",
  "review_request_create",
  "checks_read",
  "comments_read",
  "comments_write",
  "reviews_write"
]);
export type SourceControlCapability = z.infer<
  typeof sourceControlCapabilitySchema
>;

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{40,64}$/i);
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
  );
const repositoryLocatorSchema = z
  .object({
    namespace: boundedText(512),
    repository: boundedText(256),
    project: boundedText(512).nullable().default(null)
  })
  .strict();

export const sourceControlRemoteSchema = z
  .object({
    remoteName: boundedText(128),
    provider: sourceControlProviderSchema,
    host: hostnameSchema,
    transport: z.enum(["https", "ssh"]),
    locator: repositoryLocatorSchema,
    remoteIdentityHash: z.string().regex(/^[a-f0-9]{64}$/),
    connectionId: z.uuid().nullable(),
    credentialGeneration: z.number().int().safe().positive().nullable(),
    connectionState: z.enum([
      "connected",
      "connection_required",
      "revoked",
      "unavailable"
    ]),
    capabilities: z.array(sourceControlCapabilitySchema).max(32)
  })
  .strict();
export type SourceControlRemote = z.infer<typeof sourceControlRemoteSchema>;

export const sourceControlBranchSchema = z
  .object({
    name: boundedText(1_024),
    objectId: objectIdSchema,
    default: z.boolean(),
    protected: z.boolean().nullable()
  })
  .strict();
export type SourceControlBranch = z.infer<typeof sourceControlBranchSchema>;

export const sourceControlReviewRequestStateSchema = z.enum([
  "open",
  "closed",
  "merged"
]);
export const sourceControlReviewRequestSchema = z
  .object({
    id: boundedText(512),
    number: z.number().int().safe().positive(),
    title: boundedText(2_048),
    state: sourceControlReviewRequestStateSchema,
    draft: z.boolean(),
    sourceBranch: boundedText(1_024),
    targetBranch: boundedText(1_024),
    headObjectId: objectIdSchema,
    author: boundedText(512),
    webUrl: z.url().refine((value) => new URL(value).protocol === "https:"),
    updatedAt: z.iso.datetime({ offset: true })
  })
  .strict();
export type SourceControlReviewRequest = z.infer<
  typeof sourceControlReviewRequestSchema
>;

export const sourceControlCheckSchema = z
  .object({
    id: boundedText(512),
    name: boundedText(1_024),
    state: z.enum(["queued", "running", "completed"]),
    conclusion: z
      .enum([
        "success",
        "failure",
        "neutral",
        "canceled",
        "skipped",
        "timed_out",
        "action_required"
      ])
      .nullable(),
    webUrl: z.url().nullable()
  })
  .strict();
export type SourceControlCheck = z.infer<typeof sourceControlCheckSchema>;

export const sourceControlCommentSchema = z
  .object({
    id: boundedText(512),
    author: boundedText(512),
    body: z.string().max(65_536),
    createdAt: z.iso.datetime({ offset: true }),
    webUrl: z.url().nullable()
  })
  .strict();
export type SourceControlComment = z.infer<typeof sourceControlCommentSchema>;

const requestBase = {
  contractVersion: z.literal(SOURCE_CONTROL_CONTRACT_VERSION),
  executionId: z.uuid(),
  executionGeneration: z.number().int().safe().positive(),
  remoteIdentityHash: z.string().regex(/^[a-f0-9]{64}$/)
} as const;
const executionRequestBase = {
  contractVersion: z.literal(SOURCE_CONTROL_CONTRACT_VERSION),
  executionId: z.uuid(),
  executionGeneration: z.number().int().safe().positive()
} as const;
const mutationBase = {
  ...requestBase,
  expectedHeadObjectId: objectIdSchema,
  credentialGeneration: z.number().int().safe().positive(),
  idempotencyKey: z
    .string()
    .trim()
    .min(16)
    .max(160)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
} as const;

export const sourceControlOperationSchema = z.discriminatedUnion("kind", [
  z.object({ ...executionRequestBase, kind: z.literal("remotes") }).strict(),
  z.object({ ...requestBase, kind: z.literal("inspect") }).strict(),
  z
    .object({
      ...requestBase,
      kind: z.literal("branches"),
      cursor: z.string().max(2_048).nullable().default(null)
    })
    .strict(),
  z
    .object({
      ...requestBase,
      kind: z.literal("review_requests"),
      state: z.enum(["open", "closed", "all"]).default("open"),
      cursor: z.string().max(2_048).nullable().default(null)
    })
    .strict(),
  z
    .object({
      ...requestBase,
      kind: z.literal("review_request"),
      number: z.number().int().safe().positive()
    })
    .strict(),
  z
    .object({
      ...requestBase,
      kind: z.literal("checks"),
      objectId: objectIdSchema
    })
    .strict(),
  z
    .object({
      ...requestBase,
      kind: z.literal("comments"),
      number: z.number().int().safe().positive(),
      cursor: z.string().max(2_048).nullable().default(null)
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      kind: z.literal("fetch"),
      remoteName: boundedText(128)
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      kind: z.literal("push"),
      remoteName: boundedText(128),
      targetBranch: boundedText(1_024),
      expectedRemoteObjectId: objectIdSchema.nullable()
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      kind: z.literal("fast_forward"),
      remoteName: boundedText(128),
      remoteBranch: boundedText(1_024),
      expectedRemoteObjectId: objectIdSchema
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      kind: z.literal("review_request_create"),
      title: boundedText(2_048),
      body: z.string().max(65_536),
      sourceBranch: boundedText(1_024),
      targetBranch: boundedText(1_024),
      draft: z.boolean()
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      kind: z.literal("comment_create"),
      number: z.number().int().safe().positive(),
      body: boundedText(65_536)
    })
    .strict(),
  z
    .object({
      ...mutationBase,
      kind: z.literal("review_create"),
      number: z.number().int().safe().positive(),
      decision: z.enum(["comment", "approve", "request_changes"]),
      body: boundedText(65_536)
    })
    .strict()
]);
export type SourceControlOperation = z.infer<
  typeof sourceControlOperationSchema
>;

export const sourceControlResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("remotes"),
      remotes: z.array(sourceControlRemoteSchema).max(32),
      headObjectId: objectIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspect"),
      remote: sourceControlRemoteSchema,
      defaultBranch: boundedText(1_024),
      defaultBranchObjectId: objectIdSchema,
      currentBranch: boundedText(1_024).nullable(),
      headObjectId: objectIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("branches"),
      branches: z.array(sourceControlBranchSchema).max(100),
      nextCursor: z.string().max(2_048).nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal("review_requests"),
      reviewRequests: z.array(sourceControlReviewRequestSchema).max(100),
      nextCursor: z.string().max(2_048).nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal("review_request"),
      reviewRequest: sourceControlReviewRequestSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("checks"),
      checks: z.array(sourceControlCheckSchema).max(200)
    })
    .strict(),
  z
    .object({
      kind: z.literal("comments"),
      comments: z.array(sourceControlCommentSchema).max(100),
      nextCursor: z.string().max(2_048).nullable()
    })
    .strict(),
  z
    .object({
      kind: z.enum([
        "fetch",
        "push",
        "fast_forward",
        "review_request_create",
        "comment_create",
        "review_create"
      ]),
      operationId: z.uuid(),
      status: z.literal("completed"),
      headObjectId: objectIdSchema,
      reviewRequest: sourceControlReviewRequestSchema.nullable().optional(),
      comment: sourceControlCommentSchema.nullable().optional()
    })
    .strict()
]);
export type SourceControlResult = z.infer<typeof sourceControlResultSchema>;

export const sourceControlConnectionSchema = z
  .object({
    id: z.uuid(),
    provider: sourceControlProviderSchema,
    host: hostnameSchema,
    apiOrigin: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }),
    accountLabel: boundedText(512),
    credentialReference: z
      .string()
      .regex(/^source-control:[A-Za-z0-9._-]{1,200}$/),
    credentialGeneration: z.number().int().safe().positive(),
    state: z.enum(["active", "revoked"]),
    capabilities: z.array(sourceControlCapabilitySchema).max(32)
  })
  .strict();
export type SourceControlConnection = z.infer<
  typeof sourceControlConnectionSchema
>;
