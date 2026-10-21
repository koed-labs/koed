import { z } from "zod";
import { sharedMemoryFidelityCeilings } from "./shared-memory-fidelity.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().safe().positive();

/** An amendment changes one rule's disclosure, independently of its lifecycle. */
export const sharingRuleDetailReviewInputSchema = z
  .object({
    ruleId: z.uuid(),
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid(),
    maximumFidelity: z.enum(sharedMemoryFidelityCeilings),
    includeCuratedMemory: z.boolean()
  })
  .strict();

export const sharingRuleDetailReviewSchema = sharingRuleDetailReviewInputSchema
  .extend({
    selectorKind: z.enum([
      "captured_session",
      "repository",
      "folder",
      "project"
    ]),
    state: z.enum(["active", "paused", "stopped"]),
    previousMaximumFidelity: z.enum(sharedMemoryFidelityCeilings),
    previousIncludeCuratedMemory: z.boolean(),
    expectedAuthorityVersion: version,
    publisherFence: version,
    teamPolicyVersion: version,
    teamPolicyHash: hash,
    workspacePolicyVersion: version,
    workspacePolicyHash: hash,
    effectivePrivacyPolicyHash: hash,
    policyBindingHash: hash,
    memberBindingHash: hash,
    memberCount: z.number().int().safe().nonnegative(),
    ownerPolicyExpansionCount: z.number().int().safe().nonnegative(),
    disclosureIncrease: z.boolean(),
    teamName: z.string().min(1).max(4096),
    workspaceName: z.string().min(1).max(4096),
    expiresAt: z.iso.datetime({ offset: true }),
    reviewHash: hash
  })
  .strict();

export const sharingRuleDetailIntentSchema = z
  .object({
    mutationId: z.uuid(),
    review: sharingRuleDetailReviewSchema
  })
  .strict();

export const sharingRuleDetailResultSchema = z
  .object({
    mutationId: z.uuid(),
    approvedAt: z.iso.datetime({ offset: true }),
    ruleId: z.uuid(),
    state: z.enum(["active", "paused", "stopped"]),
    authorityVersion: version,
    publisherFence: version,
    maximumFidelity: z.enum(sharedMemoryFidelityCeilings),
    includeCuratedMemory: z.boolean(),
    memberCount: z.number().int().safe().nonnegative()
  })
  .strict();

export type SharingRuleDetailReviewInput = z.infer<
  typeof sharingRuleDetailReviewInputSchema
>;
export type SharingRuleDetailReview = z.infer<
  typeof sharingRuleDetailReviewSchema
>;
export type SharingRuleDetailIntent = z.infer<
  typeof sharingRuleDetailIntentSchema
>;
export type SharingRuleDetailResult = z.infer<
  typeof sharingRuleDetailResultSchema
>;

/** Stored beside the original creation intent, rather than replacing its
 * approval evidence. Expiry applies to confirmation, not to an accepted scope. */
export const sharingRuleDetailAppliedScopeSchema = z
  .object({
    approvedAt: z.iso.datetime({ offset: true }),
    review: sharingRuleDetailReviewSchema,
    result: sharingRuleDetailResultSchema
  })
  .strict()
  .superRefine(({ review, result, approvedAt }, context) => {
    if (
      result.ruleId !== review.ruleId ||
      result.authorityVersion !== review.expectedAuthorityVersion + 1 ||
      result.publisherFence !== review.publisherFence ||
      result.maximumFidelity !== review.maximumFidelity ||
      result.includeCuratedMemory !== review.includeCuratedMemory ||
      result.memberCount !== review.memberCount ||
      result.state !== review.state ||
      result.approvedAt !== approvedAt
    ) {
      context.addIssue({
        code: "custom",
        message: "Accepted detail does not match its exact review"
      });
    }
  });
export type SharingRuleDetailAppliedScope = z.infer<
  typeof sharingRuleDetailAppliedScopeSchema
>;

/** Only these approved disclosure/policy fields may replace creation scope.
 * Selector, owner, destination and creation identity remain unchanged. */
export const sharingRuleDetailApprovedFields = (
  scope: SharingRuleDetailAppliedScope
) => ({
  maximumFidelity: scope.result.maximumFidelity,
  includeCuratedMemory: scope.result.includeCuratedMemory,
  teamPolicyVersion: scope.review.teamPolicyVersion,
  teamPolicyHash: scope.review.teamPolicyHash,
  workspacePolicyVersion: scope.review.workspacePolicyVersion,
  workspacePolicyHash: scope.review.workspacePolicyHash,
  effectivePrivacyPolicyHash: scope.review.effectivePrivacyPolicyHash
});
