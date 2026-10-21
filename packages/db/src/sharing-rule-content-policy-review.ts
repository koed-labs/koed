import type pg from "pg";
import {
  crossIdentitySyncDigest,
  privacyLabels,
  resolveSharingRuleContentPolicy,
  sharingRuleContentPolicyReviewInputSchema,
  sharingRuleContentPolicyReviewSchema,
  type PrivacyLabelPolicy
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import { readSharingRuleAmendmentAuthority } from "./sharing-rule-amendment-authority.js";
import { readSharingRuleContentPolicyState } from "./sharing-rule-content-policy.js";

/** Content approval binds current fidelity constraints without expanding them.
 * It can adopt new enclosing Privacy requirements only through this review. */
export const readSharingRuleContentPolicyReview = async (
  client: pg.PoolClient,
  actor: ActorContext,
  raw: unknown,
  resolveGlobalPolicy: (scope: {
    ownerUserId: string;
    teamId: string;
    teamWorkspaceId: string;
  }) => Promise<{ labels: PrivacyLabelPolicy; effectivePolicyHash: string }>,
  expiresAt = new Date(Date.now() + 5 * 60_000).toISOString(),
  lockPolicies = false
) => {
  const input = sharingRuleContentPolicyReviewInputSchema.parse(raw);
  const authority = await readSharingRuleAmendmentAuthority(
    client,
    actor,
    input,
    lockPolicies
  );
  if (!authority) return null;
  const { rule, team, workspace, members } = authority;
  const previous = readSharingRuleContentPolicyState(rule);
  const global = await resolveGlobalPolicy({
    ownerUserId: actor.userId,
    teamId: input.teamId,
    teamWorkspaceId: input.teamWorkspaceId
  });
  const proposed = resolveSharingRuleContentPolicy({
    globalLabels: global.labels,
    globalPolicyHash: global.effectivePolicyHash,
    labels: input.labels
  });
  // A global-only rule has no historical label snapshot. Current labels prove
  // its previous disclosure only while its original global hash still matches.
  const previousEffectiveLabels =
    previous.contentPolicyVersion > 0
      ? previous.approvedEffectiveLabels
      : rule.effective_privacy_policy_hash === global.effectivePolicyHash
        ? global.labels
        : null;
  const body = {
    ...input,
    selectorKind: rule.selector_kind,
    state: rule.state,
    maximumFidelity: rule.maximum_fidelity,
    includeCuratedMemory: rule.include_curated_memory,
    expectedAuthorityVersion: rule.authority_version,
    publisherFence: Number(rule.publisher_fence),
    teamPolicyVersion: team.version,
    teamPolicyHash: team.policy_hash,
    workspacePolicyVersion: workspace.version,
    workspacePolicyHash: workspace.policy_hash,
    effectivePrivacyPolicyHash: proposed.effectivePrivacyPolicyHash,
    policyBindingHash: crossIdentitySyncDigest({
      team,
      workspace,
      globalPolicyHash: global.effectivePolicyHash,
      requiredLabels: global.labels,
      previous,
      proposed
    }),
    memberBindingHash: crossIdentitySyncDigest(
      members.map((row) => row.binding)
    ),
    memberCount: members.length,
    previousLabels: previous.labels,
    previousEffectiveLabels,
    requiredLabels: global.labels,
    effectiveLabels: proposed.effectiveLabels,
    globalPolicyHash: global.effectivePolicyHash,
    previousGlobalPolicyHash:
      previous.approvedGlobalPolicyHash ?? rule.effective_privacy_policy_hash,
    expectedContentPolicyVersion: previous.contentPolicyVersion,
    disclosureIncrease:
      previousEffectiveLabels === null ||
      privacyLabels.some(
        (label) =>
          previousEffectiveLabels[label] && !proposed.effectiveLabels[label]
      ),
    teamName: rule.team_name,
    workspaceName: rule.workspace_name,
    expiresAt
  };
  return sharingRuleContentPolicyReviewSchema.parse({
    ...body,
    reviewHash: crossIdentitySyncDigest(body)
  });
};
