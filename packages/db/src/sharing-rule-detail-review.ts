import type pg from "pg";
import {
  crossIdentitySyncDigest,
  sharedMemoryCeilingAuthorizes,
  sharingRuleDetailReviewInputSchema,
  sharingRuleDetailReviewSchema,
  SharedMemoryConflictError
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import { readSharingRuleAmendmentAuthority } from "./sharing-rule-amendment-authority.js";

/** Review hashes contain only server-read authority. Private member identities
 * contribute to a digest; they are never returned as Team organization. */
export const readSharingRuleDetailReview = async (
  client: pg.PoolClient,
  actor: ActorContext,
  raw: unknown,
  resolvePrivacyHash: (scope: {
    ownerUserId: string;
    teamId: string;
    teamWorkspaceId: string;
  }) => Promise<string>,
  expiresAt = new Date(Date.now() + 5 * 60_000).toISOString(),
  lockPolicies = false
) => {
  const input = sharingRuleDetailReviewInputSchema.parse(raw);
  const authority = await readSharingRuleAmendmentAuthority(
    client,
    actor,
    input,
    lockPolicies
  );
  if (!authority) return null;
  const { rule, team, workspace, members } = authority;
  for (const policy of [team, workspace]) {
    if (
      !sharedMemoryCeilingAuthorizes(
        policy.maximum_fidelity,
        input.maximumFidelity
      ) ||
      (input.includeCuratedMemory && !policy.include_curated_memory)
    )
      throw new SharedMemoryConflictError(
        "The requested detail exceeds current destination policy"
      );
  }
  const effectivePrivacyPolicyHash = await resolvePrivacyHash({
    ownerUserId: actor.userId,
    teamId: input.teamId,
    teamWorkspaceId: input.teamWorkspaceId
  });
  if (rule.effective_privacy_policy_hash !== effectivePrivacyPolicyHash)
    throw new SharedMemoryConflictError(
      "The rule's content policy changed. Review its content policy before changing detail."
    );
  const body = {
    ...input,
    selectorKind: rule.selector_kind,
    state: rule.state,
    previousMaximumFidelity: rule.maximum_fidelity,
    previousIncludeCuratedMemory: rule.include_curated_memory,
    expectedAuthorityVersion: rule.authority_version,
    publisherFence: Number(rule.publisher_fence),
    teamPolicyVersion: team.version,
    teamPolicyHash: team.policy_hash,
    workspacePolicyVersion: workspace.version,
    workspacePolicyHash: workspace.policy_hash,
    effectivePrivacyPolicyHash,
    policyBindingHash: crossIdentitySyncDigest({
      team,
      workspace,
      effectivePrivacyPolicyHash
    }),
    memberBindingHash: crossIdentitySyncDigest(
      members.map((row) => row.binding)
    ),
    memberCount: members.length,
    ownerPolicyExpansionCount: members.filter(
      (row) => row.owner_expansion === true
    ).length,
    disclosureIncrease:
      !sharedMemoryCeilingAuthorizes(
        rule.maximum_fidelity,
        input.maximumFidelity
      ) ||
      (input.includeCuratedMemory && !rule.include_curated_memory) ||
      members.some((row) => row.owner_expansion === true),
    teamName: rule.team_name,
    workspaceName: rule.workspace_name,
    expiresAt
  };
  return sharingRuleDetailReviewSchema.parse({
    ...body,
    reviewHash: crossIdentitySyncDigest(body)
  });
};
