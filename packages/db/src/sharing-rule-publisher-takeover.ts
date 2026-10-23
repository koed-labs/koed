import type pg from "pg";
import {
  sharingRulePublisherTakeoverReviewInputSchema,
  sharingRulePublisherTakeoverReviewSchema,
  sharingRuleSourceIdentityHash,
  SharedMemoryConflictError,
  type RepositorySharingRuleCreationIntent,
  type SharingRulePublisherTakeoverReviewInput
} from "@koed/shared";
import { readSharingRulePublisher } from "./sharing-rule-publisher.js";
import {
  workspaceSourceIsNotExcludedSql,
  sharingRuleMemberSourceSql
} from "./shared-memory-publication-authority-sql.js";

type RuleRow = Record<string, unknown>;

/** The review names a ready existing member, rather than accepting a new source
 * or deriving an origin from a receiving Session UUID. Local source availability
 * must also be checked by the receiving device before requesting and using it. */
export const readPublisherTakeoverReview = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    receivingCredentialId: string;
    review: SharingRulePublisherTakeoverReviewInput;
    expiresAt?: string;
    lock?: "share" | "update";
    requireWorkspaceSharePermission(
      teamId: string,
      workspaceId: string
    ): Promise<void>;
    selectionScope(rule: RuleRow): Promise<RepositorySharingRuleCreationIntent>;
  }
) => {
  const request = sharingRulePublisherTakeoverReviewInputSchema.parse(
    input.review
  );
  const expiresAt =
    input.expiresAt ?? new Date(Date.now() + 5 * 60_000).toISOString();
  if (
    Date.parse(expiresAt) <= Date.now() ||
    Date.parse(expiresAt) > Date.now() + 5 * 60_000
  )
    throw new SharedMemoryConflictError(
      "Publisher review expired; refresh before confirming"
    );
  const selected = await client.query<RuleRow>(
    `select rule.*,team.name team_name,workspace.name workspace_name
       from team_memory_sharing_rules rule
       join users owner on owner.id=rule.owner_user_id and owner.disabled_at is null and owner.deleted_at is null
       join teams team on team.id=rule.team_id
       join team_workspaces workspace on workspace.id=rule.team_workspace_id and workspace.team_id=team.id
       where rule.id=$1 and rule.owner_user_id=$2 and rule.team_id=$3 and rule.team_workspace_id=$4
         and rule.state in ('active','paused') and rule.authority_version=$5 and rule.publisher_fence=$6
       for ${input.lock === "update" ? "update" : "share"} of rule`,
    [
      request.ruleId,
      input.ownerUserId,
      request.teamId,
      request.teamWorkspaceId,
      request.expectedAuthorityVersion,
      request.publisherFence
    ]
  );
  const rule = selected.rows[0];
  if (!rule)
    throw new SharedMemoryConflictError(
      "The sharing rule changed; refresh its publisher review"
    );
  await input.requireWorkspaceSharePermission(
    request.teamId,
    request.teamWorkspaceId
  );
  const currentPublisher = await readSharingRulePublisher(
    client,
    input.ownerUserId,
    String(rule.publisher_credential_id)
  );
  const receivingPublisher = await readSharingRulePublisher(
    client,
    input.ownerUserId,
    input.receivingCredentialId
  );
  if (
    !currentPublisher ||
    !receivingPublisher?.available ||
    currentPublisher.credentialId === receivingPublisher.credentialId
  )
    throw new SharedMemoryConflictError(
      "A different authorized receiving publisher is required"
    );
  const source = await client.query<{
    logical_memory_id: string;
    membership_id: string;
    membership_version: number;
    share_grant_id: string;
  }>(
    `select member.logical_memory_id,member.id membership_id,member.membership_version,reason.share_grant_id
       from team_memory_sharing_rule_members member
       join team_memory_sharing_rules rule on rule.id=member.rule_id and rule.owner_user_id=member.owner_user_id
       join logical_memories memory on memory.id=member.logical_memory_id and memory.owner_user_id=member.owner_user_id
       join team_memory_share_reasons reason on reason.rule_id=rule.id and reason.membership_id=member.id and reason.kind='rule'
       join team_memory_share_grants grant_row on grant_row.id=reason.share_grant_id
         and grant_row.owner_user_id=member.owner_user_id and grant_row.logical_memory_id=member.logical_memory_id
         and grant_row.team_id=rule.team_id and grant_row.team_workspace_id=rule.team_workspace_id
         and grant_row.lifecycle in ('active','unavailable') and grant_row.revoked_at is null
       join source_owner_representation_consents consent on consent.id=reason.consent_id
         and consent.logical_memory_id=memory.id and consent.team_id=rule.team_id and consent.team_workspace_id=rule.team_workspace_id
         and consent.source_owner_principal_id=memory.owner_principal_id
         and consent.mode='continuous' and consent.state in ('active','paused') and consent.revoked_at is null
         and (consent.expires_at is null or consent.expires_at>now())
       where rule.id=$1 and member.owner_user_id=$2 and member.portable_source_hash=$3 and member.state='present'
         and ${sharingRuleMemberSourceSql("rule", "member", "member.logical_memory_id")}
         and ${workspaceSourceIsNotExcludedSql({ ownerUserId: "$2", logicalMemoryId: "member.logical_memory_id", teamWorkspaceId: "rule.team_workspace_id" })}`,
    [
      request.ruleId,
      input.ownerUserId,
      sharingRuleSourceIdentityHash(input.ownerUserId, request.sourceIdentity)
    ]
  );
  if (source.rows.length !== 1)
    throw new SharedMemoryConflictError(
      "The verified Conversation is not an eligible member of this rule"
    );
  const member = source.rows[0]!;
  return sharingRulePublisherTakeoverReviewSchema.parse({
    ...request,
    selectorKind: rule.selector_kind,
    state: rule.state,
    maximumFidelity: rule.maximum_fidelity,
    includeCuratedMemory: rule.include_curated_memory,
    effectivePrivacyPolicyHash: rule.effective_privacy_policy_hash,
    teamName: rule.team_name,
    workspaceName: rule.workspace_name,
    currentPublisher,
    receivingPublisher,
    logicalMemoryId: member.logical_memory_id,
    membershipId: member.membership_id,
    shareGrantId: member.share_grant_id,
    membershipVersion: member.membership_version,
    selectionScope:
      rule.selector_kind === "captured_session"
        ? null
        : await input.selectionScope(rule),
    expiresAt
  });
};
