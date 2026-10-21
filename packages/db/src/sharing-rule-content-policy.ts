import type pg from "pg";
import {
  privacyLabelPolicySchema,
  privacyLabels,
  resolveSharingRuleContentPolicy,
  SharedMemoryConflictError,
  type PrivacyLabelPolicy
} from "@koed/shared";

type RuleContentPolicyState = {
  content_privacy_labels: unknown;
  content_policy_version: number;
  approved_global_privacy_policy_hash: string | null;
  approved_effective_privacy_labels: unknown;
  effective_privacy_policy_hash: string;
};

export const readSharingRuleContentPolicyState = (
  row: RuleContentPolicyState
) => {
  const labels = privacyLabelPolicySchema.safeParse(
    row?.content_privacy_labels
  );
  if (!row || !labels.success)
    throw new SharedMemoryConflictError(
      "Sharing rule content policy is unavailable"
    );
  const approvedLabels = privacyLabelPolicySchema.safeParse(
    row.approved_effective_privacy_labels
  );
  const version = row.content_policy_version;
  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    (version === 0 &&
      (privacyLabels.some((label) => labels.data[label]) ||
        row.approved_global_privacy_policy_hash !== null ||
        row.approved_effective_privacy_labels !== null)) ||
    (version > 0 &&
      (!approvedLabels.success ||
        !/^[a-f0-9]{64}$/.test(row.approved_global_privacy_policy_hash ?? "") ||
        privacyLabels.some(
          (label) => labels.data[label] && !approvedLabels.data[label]
        )))
  )
    throw new SharedMemoryConflictError(
      "Sharing rule content policy binding is invalid"
    );
  if (version > 0 && approvedLabels.success) {
    const approved = resolveSharingRuleContentPolicy({
      globalLabels: approvedLabels.data,
      globalPolicyHash: row.approved_global_privacy_policy_hash!,
      labels: labels.data
    });
    if (
      approved.effectivePrivacyPolicyHash !== row.effective_privacy_policy_hash
    )
      throw new SharedMemoryConflictError(
        "Sharing rule content policy receipt is invalid"
      );
  }
  return {
    labels: labels.data,
    contentPolicyVersion: version,
    approvedGlobalPolicyHash: row.approved_global_privacy_policy_hash,
    approvedEffectiveLabels: approvedLabels.success ? approvedLabels.data : null
  };
};

/** Resolve a whole policy for one owned sharing reason. Authority counters
 * fence processing separately; they are not part of content identity. */
export const resolveOwnedSharingRuleContentPolicy = async (
  client: Pick<pg.PoolClient, "query">,
  input: {
    ruleId: string;
    ownerUserId: string;
    teamId: string;
    teamWorkspaceId: string;
    lockRows?: boolean;
  },
  globalPolicy: { labels: PrivacyLabelPolicy; effectivePolicyHash: string }
) => {
  const row = (
    await client.query<RuleContentPolicyState>(
      `select content_privacy_labels,content_policy_version,
        approved_global_privacy_policy_hash,approved_effective_privacy_labels,
        effective_privacy_policy_hash
       from team_memory_sharing_rules
       where id=$1 and owner_user_id=$2 and team_id=$3 and team_workspace_id=$4
       ${input.lockRows ? "for share" : ""}`,
      [input.ruleId, input.ownerUserId, input.teamId, input.teamWorkspaceId]
    )
  ).rows[0];
  if (!row)
    throw new SharedMemoryConflictError(
      "Sharing rule content policy is unavailable"
    );
  const state = readSharingRuleContentPolicyState(row);
  // Resolve current enclosing requirements even after they drift. Callers must
  // compare this hash with the approved publication before permitting use.
  const current = resolveSharingRuleContentPolicy({
    globalLabels: globalPolicy.labels,
    globalPolicyHash: globalPolicy.effectivePolicyHash,
    labels: state.labels
  });
  return {
    labels: current.effectiveLabels,
    effectivePolicyHash: current.effectivePrivacyPolicyHash,
    ruleContentPolicy: {
      labels: current.labels,
      globalPolicyHash: current.globalPolicyHash
    }
  };
};
