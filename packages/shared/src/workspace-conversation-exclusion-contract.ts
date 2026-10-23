import { z } from "zod";

const uuid = z.string().uuid();
const version = z.number().int().positive();
const timestamp = z.string().datetime({ offset: true });

// This veto belongs to the owner/source/destination, independently of grants
// and selection rules. Its version survives removal and later reapplication.
export const workspaceConversationExclusionSchema = z
  .object({
    id: uuid,
    ownerUserId: uuid,
    logicalMemoryId: uuid,
    teamId: uuid,
    teamWorkspaceId: uuid,
    version,
    state: z.enum(["excluded", "restored"]),
    excludedAt: timestamp,
    restoredAt: timestamp.nullable(),
    updatedAt: timestamp
  })
  .strict()
  .refine(
    (value) => (value.state === "excluded") === (value.restoredAt === null),
    { message: "Restored state requires its restoration timestamp" }
  );

export const workspaceConversationExclusionReviewInputSchema = z
  .object({
    logicalMemoryId: uuid,
    teamId: uuid,
    teamWorkspaceId: uuid
  })
  .strict();

export const workspaceConversationExclusionScopeSchema =
  workspaceConversationExclusionReviewInputSchema
    .extend({
      ownerUserId: uuid,
      expectedExclusionVersion: z.number().int().nonnegative(),
      shareGrantId: uuid.nullable(),
      expectedGrantVersion: version.nullable()
    })
    .strict()
    .refine(
      (scope) =>
        (scope.shareGrantId === null) === (scope.expectedGrantVersion === null),
      { message: "A grant review requires its identity and version together" }
    );

export const workspaceConversationExclusionReviewSchema = z
  .object({
    scope: workspaceConversationExclusionScopeSchema,
    source: z
      .object({ logicalMemoryId: uuid, title: z.string().min(1) })
      .strict(),
    team: z.object({ id: uuid, name: z.string().min(1) }).strict(),
    workspace: z.object({ id: uuid, name: z.string().min(1) }).strict(),
    exclusion: workspaceConversationExclusionSchema.nullable()
  })
  .strict()
  .superRefine((review, context) => {
    const scope = review.scope;
    if (
      review.source.logicalMemoryId !== scope.logicalMemoryId ||
      review.team.id !== scope.teamId ||
      review.workspace.id !== scope.teamWorkspaceId ||
      (review.exclusion &&
        (review.exclusion.ownerUserId !== scope.ownerUserId ||
          review.exclusion.logicalMemoryId !== scope.logicalMemoryId ||
          review.exclusion.teamId !== scope.teamId ||
          review.exclusion.teamWorkspaceId !== scope.teamWorkspaceId ||
          review.exclusion.version !== scope.expectedExclusionVersion)) ||
      (!review.exclusion && scope.expectedExclusionVersion !== 0)
    )
      context.addIssue({
        code: "custom",
        message:
          "The exclusion review must describe its exact owned source and Workspace"
      });
  });

export const workspaceConversationExclusionIntentSchema = z
  .object({
    mutationId: uuid,
    scope: workspaceConversationExclusionScopeSchema
  })
  .strict();

export type WorkspaceConversationExclusion = z.infer<
  typeof workspaceConversationExclusionSchema
>;
export type WorkspaceConversationExclusionReviewInput = z.infer<
  typeof workspaceConversationExclusionReviewInputSchema
>;
export type WorkspaceConversationExclusionReview = z.infer<
  typeof workspaceConversationExclusionReviewSchema
>;
export type WorkspaceConversationExclusionIntent = z.infer<
  typeof workspaceConversationExclusionIntentSchema
>;

export const workspaceConversationRestorationRuleSchema = z
  .object({
    ruleId: uuid,
    selectorKind: z.enum([
      "captured_session",
      "repository",
      "folder",
      "project"
    ]),
    state: z.enum(["active", "paused", "stopped"]),
    authorityVersion: version,
    publisherFence: version,
    membershipId: uuid.nullable(),
    membershipVersion: version.nullable(),
    membershipState: z
      .enum(["present", "removed", "revoked", "unresolved"])
      .nullable(),
    eligible: z.boolean()
  })
  .strict();

export const workspaceConversationRestorationReviewSchema =
  workspaceConversationExclusionReviewSchema
    .safeExtend({
      rules: z.array(workspaceConversationRestorationRuleSchema),
      authorityHash: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: timestamp,
      reviewHash: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .superRefine((review, context) => {
      if (review.exclusion?.state !== "excluded")
        context.addIssue({
          code: "custom",
          message: "Restoration requires the current exclusion"
        });
    });

export const workspaceConversationRestorationIntentSchema = z
  .object({
    mutationId: uuid,
    scope: workspaceConversationExclusionScopeSchema,
    restoration: workspaceConversationRestorationReviewSchema
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      Object.entries(intent.scope).some(
        ([key, value]) =>
          intent.restoration.scope[key as keyof typeof intent.scope] !== value
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Restoration must bind the exact reviewed source and destination"
      });
  });

export type WorkspaceConversationRestorationReview = z.infer<
  typeof workspaceConversationRestorationReviewSchema
>;
export type WorkspaceConversationRestorationIntent = z.infer<
  typeof workspaceConversationRestorationIntentSchema
>;
