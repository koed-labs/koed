import { z } from "zod";
import { repositoryIdentitySchema } from "./repository-identity.js";
import { repositoryAssignmentSchema } from "./repository-assignment.js";

export const repositoryChangeInputSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["anchor_change", "capture_conflict"]),
    originatingDeviceId: z.string().min(1).max(160),
    checkoutId: z.string().min(1).max(160),
    originatingRevision: z.number().int().nonnegative().nullable(),
    previousIdentity: repositoryIdentitySchema.nullable(),
    targetIdentity: repositoryIdentitySchema
  })
  .strict()
  .refine(
    (input) =>
      input.targetIdentity.checkoutId === input.checkoutId &&
      input.targetIdentity.originatingDeviceId === input.originatingDeviceId,
    "Change target must belong to its originating checkout"
  );
export const repositoryChangeSchema = repositoryChangeInputSchema.safeExtend({
  revision: z.number().int().positive(),
  status: z.enum(["pending", "superseded", "dismissed", "applied"]),
  createdAt: z.string().datetime()
});
export const repositoryReviewOptionsSchema = z
  .object({
    includeOverrides: z.boolean().default(false),
    includeUnresolved: z.boolean().default(false)
  })
  .strict();
export const repositoryReviewSchema = z
  .object({
    id: z.string().uuid(),
    event: repositoryChangeSchema,
    options: repositoryReviewOptionsSchema,
    count: z.number().int().nonnegative().max(500),
    sessions: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string(),
            cwd: z.string().nullable(),
            assignment: repositoryAssignmentSchema
          })
          .strict()
      )
      .max(500),
    status: z.enum(["reviewed", "applied", "dismissed"])
  })
  .strict()
  .refine(
    (review) => review.count === review.sessions.length,
    "Review count must be exact"
  );
export type RepositoryChangeInput = z.infer<typeof repositoryChangeInputSchema>;
export type RepositoryChange = z.infer<typeof repositoryChangeSchema>;
export type RepositoryReviewOptions = z.infer<
  typeof repositoryReviewOptionsSchema
>;
export type RepositoryReview = z.infer<typeof repositoryReviewSchema>;
export const repositoryReviewActionSchema = z
  .object({
    action: z.literal("dismiss"),
    expectedRevision: z.number().int().positive()
  })
  .strict();

const localProjectId = z.string().regex(/^lp_[0-9a-f]{32}$/);
export const repositoryReviewCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list"), localProjectId }).strict(),
  z
    .object({
      operation: z.literal("preview"),
      localProjectId,
      eventId: z.string().uuid(),
      options: repositoryReviewOptionsSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("dismiss"),
      localProjectId,
      reviewId: z.string().uuid(),
      expectedRevision: z.number().int().positive()
    })
    .strict()
]);
export const repositoryReviewCommandResultSchema = z
  .object({
    events: z.array(repositoryChangeSchema).max(100).optional(),
    review: repositoryReviewSchema.optional()
  })
  .strict();
export type RepositoryReviewCommand = z.infer<
  typeof repositoryReviewCommandSchema
>;
export type RepositoryReviewCommandResult = z.infer<
  typeof repositoryReviewCommandResultSchema
>;
