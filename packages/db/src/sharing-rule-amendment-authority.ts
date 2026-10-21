import type pg from "pg";
import {
  SharedMemoryConflictError,
  type SharedMemoryFidelityCeiling
} from "@koed/shared";
import type { ActorContext } from "./types.js";

type Policy = {
  policy_id: string;
  version: number;
  policy_hash: string;
  maximum_fidelity: SharedMemoryFidelityCeiling;
  include_curated_memory: boolean;
};

/** Server-read authority shared by detail and content-policy reviews.
 * Reading a snapshot never expands a member's owner policy. */
export const readSharingRuleAmendmentAuthority = async (
  client: pg.PoolClient,
  actor: ActorContext,
  input: {
    ruleId: string;
    teamId: string;
    teamWorkspaceId: string;
    maximumFidelity?: SharedMemoryFidelityCeiling;
    includeCuratedMemory?: boolean;
  },
  lockPolicies = false
) => {
  const rule = (
    await client.query<{
      selector_kind: "captured_session" | "repository" | "folder" | "project";
      state: "active" | "paused" | "stopped";
      maximum_fidelity: SharedMemoryFidelityCeiling;
      include_curated_memory: boolean;
      authority_version: number;
      effective_privacy_policy_hash: string;
      publisher_fence: string;
      team_name: string;
      workspace_name: string;
      content_privacy_labels: unknown;
      content_policy_version: number;
      approved_global_privacy_policy_hash: string | null;
      approved_effective_privacy_labels: unknown;
    }>(
      `select rule.selector_kind,rule.state,rule.maximum_fidelity,rule.include_curated_memory,
      rule.authority_version,rule.publisher_fence,rule.effective_privacy_policy_hash,
      rule.content_privacy_labels,rule.content_policy_version,rule.approved_global_privacy_policy_hash,
      rule.approved_effective_privacy_labels,team.name team_name,workspace.name workspace_name
    from team_memory_sharing_rules rule
    join users owner on owner.id=rule.owner_user_id and owner.disabled_at is null and owner.deleted_at is null
    join teams team on team.id=rule.team_id and team.lifecycle='active' and team.entitlement_status in ('active','grace')
    join team_workspaces workspace on workspace.id=rule.team_workspace_id and workspace.team_id=team.id
      and workspace.lifecycle='active' and workspace.archived_at is null
    join team_memberships membership on membership.team_id=team.id and membership.user_id=owner.id
      and membership.status='enabled' and membership.disabled_at is null
    join team_workspace_access_grants access on access.team_id=team.id and access.team_workspace_id=workspace.id
      and access.user_id=owner.id and access.access='write' and access.can_share_owned_memory and access.disabled_at is null
    where rule.id=$1 and rule.owner_user_id=$2 and rule.team_id=$3 and rule.team_workspace_id=$4`,
      [input.ruleId, actor.userId, input.teamId, input.teamWorkspaceId]
    )
  ).rows[0];
  if (!rule) return null;
  const team = (
    await client.query<Policy>(
      `select policy_id,version,policy_hash,maximum_fidelity,include_curated_memory from team_representation_policies where team_id=$1 and superseded_at is null${lockPolicies ? " for share" : ""}`,
      [input.teamId]
    )
  ).rows[0];
  const workspace = (
    await client.query<Policy>(
      `select policy_id,version,policy_hash,maximum_fidelity,include_curated_memory from workspace_representation_policies where team_id=$1 and team_workspace_id=$2 and superseded_at is null${lockPolicies ? " for share" : ""}`,
      [input.teamId, input.teamWorkspaceId]
    )
  ).rows[0];
  if (!team || !workspace)
    throw new SharedMemoryConflictError(
      "Current destination policies are unavailable"
    );
  const members = (
    await client.query<{ binding: unknown; owner_expansion: boolean }>(
      `select jsonb_build_object('memberId',member.id,'membershipVersion',member.membership_version,
      'state',member.state,'reasonId',reason.id,'consentId',consent.id,'consentVersion',consent.consent_version,
      'consentState',consent.state,'grantId',grant_row.id,'grantVersion',grant_row.grant_version,
      'ownerPolicyId',owner_policy.policy_id,'ownerPolicyVersion',owner_policy.version,
      'ownerPolicyHash',owner_policy.policy_hash) binding,
      (consent.state in ('active','paused') and consent.revoked_at is null
        and (consent.expires_at is null or consent.expires_at>now()) and (
          owner_policy.id is null
          or (case owner_policy.maximum_fidelity when 'memory_events' then false
            when 'lcm_leaves' then $3::text='memory_events'
            when 'lcm_rollups' then $3::text<>'lcm_rollups' else true end)
          or ($4::boolean and not owner_policy.include_curated_memory))) owner_expansion
    from team_memory_sharing_rule_members member
    left join team_memory_share_reasons reason on reason.membership_id=member.id and reason.rule_id=member.rule_id
    left join team_memory_share_grants grant_row on grant_row.id=reason.share_grant_id
    left join source_owner_representation_consents consent on consent.id=reason.consent_id
    left join source_owner_representation_policies owner_policy on owner_policy.logical_memory_id=member.logical_memory_id
      and owner_policy.source_owner_principal_id=grant_row.owner_principal_id and owner_policy.superseded_at is null
    where member.rule_id=$1 and member.owner_user_id=$2 and member.state='present' order by member.id`,
      [
        input.ruleId,
        actor.userId,
        input.maximumFidelity ?? rule.maximum_fidelity,
        input.includeCuratedMemory ?? rule.include_curated_memory
      ]
    )
  ).rows;
  return { rule, team, workspace, members };
};
