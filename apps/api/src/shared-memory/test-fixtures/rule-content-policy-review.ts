import {
  noPrivacyLabelsPolicy,
  sharingRuleContentPolicyReviewSchema
} from "@koed/shared";

/** A valid pre-alpha request, used to prove that disabling editing happens
 * before approval, queue persistence, or remote delivery. */
export const contentPolicyReviewFixture = (ids: {
  ruleId: string;
  teamId: string;
  teamWorkspaceId: string;
}) => {
  const hash = "a".repeat(64);
  const labels = noPrivacyLabelsPolicy();
  return sharingRuleContentPolicyReviewSchema.parse({
    ...ids,
    selectorKind: "captured_session",
    state: "paused",
    maximumFidelity: "lcm_rollups",
    includeCuratedMemory: false,
    expectedAuthorityVersion: 1,
    publisherFence: 1,
    teamPolicyVersion: 1,
    teamPolicyHash: hash,
    workspacePolicyVersion: 1,
    workspacePolicyHash: hash,
    effectivePrivacyPolicyHash: hash,
    policyBindingHash: hash,
    memberBindingHash: hash,
    memberCount: 1,
    disclosureIncrease: false,
    teamName: "Trial Team",
    workspaceName: "Trial Workspace",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reviewHash: hash,
    labels,
    previousLabels: labels,
    previousEffectiveLabels: labels,
    requiredLabels: labels,
    effectiveLabels: labels,
    globalPolicyHash: hash,
    previousGlobalPolicyHash: hash,
    expectedContentPolicyVersion: 0
  });
};
