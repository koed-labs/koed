import { z } from "zod";
import { canonicalJsonDigest as crossIdentitySyncDigest } from "./canonical-json-digest.js";
import {
  privacyLabelPolicySchema,
  privacyLabels,
  resolveEffectivePrivacyPolicy,
  PRIVACY_REPLACEMENT_CONTRACT_VERSION,
  type PrivacyLabelPolicy
} from "./privacy-filter-contract.js";
import {
  sharingRuleDetailReviewSchema,
  sharingRuleDetailApprovedFields,
  type SharingRuleDetailAppliedScope
} from "./sharing-rule-detail-contract.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().safe().nonnegative();

/** A rule adds redaction requirements; it cannot remove an enclosing policy's
 * requirements. Identity follows the policy content, while authority versions
 * separately fence work. Returning to an approved policy can therefore retain
 * its exact older publications without authorizing a newer source revision. */
export const resolveSharingRuleContentPolicy = (input: {
  globalLabels: PrivacyLabelPolicy;
  globalPolicyHash: string;
  labels: PrivacyLabelPolicy;
}) => {
  const globalLabels = privacyLabelPolicySchema.parse(input.globalLabels);
  const labels = privacyLabelPolicySchema.parse(input.labels);
  const globalPolicyHash = hash.parse(input.globalPolicyHash);
  const effectiveLabels = resolveEffectivePrivacyPolicy(globalLabels, labels);
  return {
    labels,
    effectiveLabels,
    globalPolicyHash,
    effectivePrivacyPolicyHash: privacyLabels.some((label) => labels[label])
      ? crossIdentitySyncDigest({
          kind: "sharing_rule_content_policy",
          replacementContractVersion: PRIVACY_REPLACEMENT_CONTRACT_VERSION,
          globalPolicyHash,
          labels,
          effectiveLabels
        })
      : globalPolicyHash
  };
};

export const sharingRuleContentPolicyReviewInputSchema = z
  .object({
    ruleId: z.uuid(),
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid(),
    labels: privacyLabelPolicySchema
  })
  .strict();

export const sharingRuleContentPolicyReviewSchema =
  sharingRuleDetailReviewSchema
    .omit({
      previousMaximumFidelity: true,
      previousIncludeCuratedMemory: true,
      ownerPolicyExpansionCount: true
    })
    .extend({
      labels: privacyLabelPolicySchema,
      previousLabels: privacyLabelPolicySchema,
      previousEffectiveLabels: privacyLabelPolicySchema.nullable(),
      requiredLabels: privacyLabelPolicySchema,
      effectiveLabels: privacyLabelPolicySchema,
      globalPolicyHash: hash,
      previousGlobalPolicyHash: hash,
      expectedContentPolicyVersion: version
    })
    .strict()
    .superRefine((review, context) => {
      const effective = resolveSharingRuleContentPolicy({
        globalLabels: review.requiredLabels,
        globalPolicyHash: review.globalPolicyHash,
        labels: review.labels
      });
      const previous = review.previousEffectiveLabels;
      const increase =
        previous === null ||
        privacyLabels.some(
          (label) => previous[label] && !effective.effectiveLabels[label]
        );
      if (
        crossIdentitySyncDigest(review.effectiveLabels) !==
          crossIdentitySyncDigest(effective.effectiveLabels) ||
        review.effectivePrivacyPolicyHash !==
          effective.effectivePrivacyPolicyHash ||
        review.disclosureIncrease !== increase
      )
        context.addIssue({
          code: "custom",
          message:
            "The reviewed content policy must retain every enclosing requirement and identify any increased disclosure"
        });
    });

export const sharingRuleContentPolicyIntentSchema = z
  .object({
    mutationId: z.uuid(),
    review: sharingRuleContentPolicyReviewSchema
  })
  .strict();

export const sharingRuleContentPolicyResultSchema = z
  .object({
    mutationId: z.uuid(),
    approvedAt: z.iso.datetime({ offset: true }),
    ruleId: z.uuid(),
    state: z.enum(["active", "paused", "stopped"]),
    authorityVersion: version.positive(),
    publisherFence: version.positive(),
    contentPolicyVersion: version.positive(),
    labels: privacyLabelPolicySchema,
    globalPolicyHash: hash,
    effectivePrivacyPolicyHash: hash,
    memberCount: version
  })
  .strict();

export const sharingRuleContentPolicyAppliedScopeSchema = z
  .object({
    approvedAt: z.iso.datetime({ offset: true }),
    review: sharingRuleContentPolicyReviewSchema,
    result: sharingRuleContentPolicyResultSchema
  })
  .strict()
  .superRefine(({ approvedAt, review, result }, context) => {
    if (
      result.approvedAt !== approvedAt ||
      result.ruleId !== review.ruleId ||
      result.state !== review.state ||
      result.authorityVersion !== review.expectedAuthorityVersion + 1 ||
      result.publisherFence !== review.publisherFence ||
      result.contentPolicyVersion !== review.expectedContentPolicyVersion + 1 ||
      result.memberCount !== review.memberCount ||
      result.globalPolicyHash !== review.globalPolicyHash ||
      result.effectivePrivacyPolicyHash !== review.effectivePrivacyPolicyHash ||
      crossIdentitySyncDigest(result.labels) !==
        crossIdentitySyncDigest(review.labels)
    )
      context.addIssue({
        code: "custom",
        message:
          "The content-policy receipt must match its exact reviewed rule, labels and authority"
      });
  });

export type SharingRuleContentPolicyReviewInput = z.infer<
  typeof sharingRuleContentPolicyReviewInputSchema
>;
export type SharingRuleContentPolicyReview = z.infer<
  typeof sharingRuleContentPolicyReviewSchema
>;
export type SharingRuleContentPolicyIntent = z.infer<
  typeof sharingRuleContentPolicyIntentSchema
>;
export type SharingRuleContentPolicyResult = z.infer<
  typeof sharingRuleContentPolicyResultSchema
>;
export type SharingRuleContentPolicyAppliedScope = z.infer<
  typeof sharingRuleContentPolicyAppliedScopeSchema
>;

/** The latest amendment supplies policy bindings. Only a detail amendment can
 * change fidelity; content approval never advances the fidelity approval time. */
export const sharingRuleApprovedAmendmentFields = (input: {
  detailAmendment?: SharingRuleDetailAppliedScope | null;
  contentPolicyAmendment?: SharingRuleContentPolicyAppliedScope | null;
}) => {
  const detail = input.detailAmendment;
  const content = input.contentPolicyAmendment;
  if (
    detail &&
    content &&
    detail.result.authorityVersion === content.result.authorityVersion
  )
    throw new TypeError(
      "Different rule amendments cannot share one authority version"
    );
  return {
    ...(detail ? sharingRuleDetailApprovedFields(detail) : {}),
    ...(content &&
    (!detail ||
      content.result.authorityVersion > detail.result.authorityVersion)
      ? {
          teamPolicyVersion: content.review.teamPolicyVersion,
          teamPolicyHash: content.review.teamPolicyHash,
          workspacePolicyVersion: content.review.workspacePolicyVersion,
          workspacePolicyHash: content.review.workspacePolicyHash,
          effectivePrivacyPolicyHash: content.result.effectivePrivacyPolicyHash
        }
      : {})
  };
};
