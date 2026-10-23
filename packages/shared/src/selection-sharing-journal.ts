import { canonicalJsonDigest } from "./canonical-json-digest.js";
import {
  sharingRuleContentPolicyAppliedScopeSchema,
  sharingRuleApprovedAmendmentFields
} from "./sharing-rule-content-policy-contract.js";
import { z } from "zod";
import { personalSelectionConsumerPageSchema } from "./personal-selection-consumer-contract.js";
import {
  repositorySharingRuleCreationLocalIntentSchema,
  repositorySharingRuleCreationIntentSchema,
  sharingSelectionTargetSchema,
  sharingSelectionDescriptor,
  repositorySharingRuleMemberInventorySchema,
  sharingRulePublisherTakeoverAppliedScopeSchema
} from "./team-sharing-review-contract.js";
import { sharingRuleDetailAppliedScopeSchema } from "./sharing-rule-detail-contract.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const selectionSharingIdentitySchema = z
  .object({
    backendId: z.string().min(1).max(64),
    localOwnerUserId: z.uuid(),
    upstreamUserId: z.uuid()
  })
  .strict();
export const selectionSharingProposalSchema = z
  .object({
    generation: z.uuid(),
    snapshotVersion: z.uuid(),
    nextCursor: z.uuid().nullable(),
    changeCursor: z.uuid().nullable(),
    pageCount: z.number().int().safe().nonnegative(),
    planPage: z.number().int().safe().nonnegative(),
    missingAfter: z.uuid().nullable(),
    phase: z.enum(["enumerating", "inventory", "present", "missing", "commit"]),
    inventory: z
      .object({
        afterMembershipId: z.uuid().nullable(),
        page: repositorySharingRuleMemberInventorySchema.nullable(),
        afterBindingId: z.uuid().nullable(),
        unmatchedMembershipIds: z.array(z.uuid()).max(100),
        pendingMemberCount: z.number().int().safe().nonnegative(),
        scope: z
          .object({
            authorityVersion: z.number().int().safe().positive(),
            publisherFence: z.number().int().safe().positive()
          })
          .strict()
          .nullable()
      })
      .strict()
      .optional()
  })
  .strict();
/** A transferred scope retains the approved Team selector and receipt. Its local
 * target starts a new consumer history; no old completion token is fabricated. */
export const transferredSelectionSharingScopeSchema =
  repositorySharingRuleCreationIntentSchema
    .extend({
      review: z.object({ target: sharingSelectionTargetSchema }).strict(),
      publisherTakeover: sharingRulePublisherTakeoverAppliedScopeSchema
    })
    .strict()
    .superRefine((value, context) => {
      const approved = value.publisherTakeover.review.selectionScope;
      if (
        !approved ||
        canonicalJsonDigest(
          repositorySharingRuleCreationIntentSchema.strip().parse(value)
        ) !== canonicalJsonDigest(approved) ||
        canonicalJsonDigest(sharingSelectionDescriptor(value.review.target)) !==
          canonicalJsonDigest(approved.selector)
      )
        context.addIssue({
          code: "custom",
          message:
            "Transferred selection progress requires its unchanged approved selector scope"
        });
    });
export const selectionSharingProgressSchema = z
  .object({
    version: z.literal(1),
    identity: selectionSharingIdentitySchema,
    remoteDeviceId: z.uuid(),
    intent: z.union([
      repositorySharingRuleCreationLocalIntentSchema,
      transferredSelectionSharingScopeSchema
    ]),
    detailAmendment: sharingRuleDetailAppliedScopeSchema.optional(),
    contentPolicyAmendment:
      sharingRuleContentPolicyAppliedScopeSchema.optional(),
    currentGeneration: z.uuid().nullable(),
    changeCursor: z.uuid().nullable(),
    pendingMemberCount: z.number().int().safe().nonnegative().optional(),
    proposal: selectionSharingProposalSchema.nullable()
  })
  .strict()
  .superRefine((progress, context) => {
    for (const scope of [
      progress.detailAmendment,
      progress.contentPolicyAmendment
    ]) {
      if (
        scope &&
        (scope.result.ruleId !== progress.intent.ruleId ||
          scope.review.teamId !== progress.intent.teamId ||
          scope.review.teamWorkspaceId !== progress.intent.teamWorkspaceId ||
          scope.review.selectorKind !== progress.intent.review.target.kind)
      )
        context.addIssue({
          code: "custom",
          message: "Amendment scope does not belong to this selection rule"
        });
    }
    if (
      progress.detailAmendment &&
      progress.contentPolicyAmendment &&
      progress.detailAmendment.result.authorityVersion ===
        progress.contentPolicyAmendment.result.authorityVersion
    )
      context.addIssue({
        code: "custom",
        message: "Different amendments cannot share one authority version"
      });
  });
export const selectionSharingGoalSchema = z
  .object({
    source:
      personalSelectionConsumerPageSchema.shape.entries.element.shape.source,
    desired: z.enum(["present", "removed", "unresolved"]),
    snapshotVersion: z.uuid(),
    contextHash: hash
  })
  .strict();
export const selectionSharingAttemptSchema = z
  .object({
    mutationId: z.uuid(),
    deliveryEpoch: z.number().int().safe().nonnegative(),
    kind: z.enum(["admit", "context", "remove"]),
    sourceWorkMode: z.literal("retained").optional(),
    goalHash: hash,
    requestHash: hash,
    logicalMemoryId: z.uuid(),
    membershipId: z.uuid(),
    body: z.record(z.string(), z.json())
  })
  .strict()
  .refine(
    (attempt) =>
      attempt.sourceWorkMode === undefined || attempt.kind === "admit",
    { message: "Retained source work requires an admission" }
  );
export const selectionSharingSourceStateSchema = z
  .object({
    sourceKey: hash,
    current: selectionSharingGoalSchema.nullable(),
    proposed: selectionSharingGoalSchema.nullable(),
    currentGeneration: z.uuid().nullable(),
    proposedGeneration: z.uuid().nullable(),
    attempt: selectionSharingAttemptSchema.nullable(),
    remote: z
      .object({
        logicalMemoryId: z.uuid(),
        membershipId: z.uuid().nullable(),
        membershipVersion: z.number().int().safe().positive().nullable(),
        authorityVersion: z.number().int().safe().positive(),
        publisherFence: z.number().int().safe().positive(),
        pendingShareId: z.uuid().nullable()
      })
      .strict()
      .nullable()
  })
  .strict();
export type SelectionSharingProgress = z.infer<
  typeof selectionSharingProgressSchema
>;
export const selectionSharingEffectiveIntent = (
  progress: SelectionSharingProgress
) => ({
  ...progress.intent,
  ...sharingRuleApprovedAmendmentFields(progress)
});
export type SelectionSharingGoal = z.infer<typeof selectionSharingGoalSchema>;
export type SelectionSharingAttempt = z.infer<
  typeof selectionSharingAttemptSchema
>;
export type SelectionSharingSourceState = z.infer<
  typeof selectionSharingSourceStateSchema
>;
export type SelectionSharingIdentity = z.infer<
  typeof selectionSharingIdentitySchema
>;
