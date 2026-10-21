// SQL fragments accept only trusted, repository-owned expressions. Values from
// requests belong in query parameters. These helpers never decrypt source data.
export const cumulativeRepresentationAuthorizationSql = (
  representationSql: string,
  aliases: {
    grant?: string;
    consent?: string;
    ownerPolicy?: string;
    teamPolicy?: string;
    workspacePolicy?: string;
  } = {}
): string => {
  const grant = aliases.grant ?? "g";
  const consent = aliases.consent ?? "c";
  const owner = aliases.ownerPolicy ?? "op";
  const team = aliases.teamPolicy ?? "tp";
  const workspace = aliases.workspacePolicy ?? "wp";
  const ceilingAuthorizes = (alias: string) => `case ${alias}.maximum_fidelity
    when 'memory_events' then ${representationSql} in ('memory_events','lcm_leaves','lcm_rollups')
    when 'lcm_leaves' then ${representationSql} in ('lcm_leaves','lcm_rollups')
    when 'lcm_rollups' then ${representationSql}='lcm_rollups'
    else false end`;
  return `((${representationSql}='curated_assertions'
      and ${grant}.include_curated_memory
      and ${consent}.include_curated_memory
      and ${owner}.include_curated_memory
      and ${team}.include_curated_memory
      and ${workspace}.include_curated_memory)
    or (${representationSql}<>'curated_assertions'
      and ${ceilingAuthorizes(grant)}
      and ${ceilingAuthorizes(consent)}
      and ${ceilingAuthorizes(owner)}
      and ${ceilingAuthorizes(team)}
      and ${ceilingAuthorizes(workspace)}))`;
};

export const grantAuthorizesRepresentationSql = (
  representationSql: string,
  grant = "g"
): string => `((${representationSql}='curated_assertions'
    and ${grant}.include_curated_memory)
  or (${representationSql}<>'curated_assertions' and case ${grant}.maximum_fidelity
    when 'memory_events' then ${representationSql} in ('memory_events','lcm_leaves','lcm_rollups')
    when 'lcm_leaves' then ${representationSql} in ('lcm_leaves','lcm_rollups')
    when 'lcm_rollups' then ${representationSql}='lcm_rollups'
    else false end))`;

export const sharingRuleMemberSourceSql = (
  rule = "rule",
  member = "member",
  logicalMemoryId = "g.logical_memory_id"
): string => `(${member}.logical_memory_id=${logicalMemoryId} and (
  (${rule}.selector_kind='captured_session' and ${rule}.logical_memory_id=${logicalMemoryId})
  or (${rule}.selector_kind in ('repository','folder','project') and ${rule}.logical_memory_id is null
    and ${member}.selection_snapshot_version is not null
    and ${member}.source_context_hash is not null and ${member}.git_context_version is not null
    and (${rule}.selector_kind not in ('folder','project') or ${member}.folder_context_version is not null))
))`;

// A source must still be an acknowledged member of this exact rule. Pausing a
// rule retains its published members; removing a member ends only its reason.
export const sharingRuleMembershipSql = (
  rule = "rule",
  reason = "reason",
  grant = "g",
  membershipId = `${reason}.membership_id`
): string => `exists (
  select 1 from team_memory_sharing_rule_members member
   where member.id=${membershipId} and member.rule_id=${rule}.id
     and member.owner_user_id=${rule}.owner_user_id and member.state='present'
     and ${sharingRuleMemberSourceSql(rule, "member", `${grant}.logical_memory_id`)}
)`;

// This predicate binds access to an exact publication, including when a paused
// reason retains an older revision than another reason currently publishes.
export const sharingReasonAuthorizesRepresentationSql = (
  representation = "r",
  grant = "g"
): string => `exists (
  select 1 from team_memory_reason_publications publication
  join team_memory_share_reasons reason
    on reason.id=publication.reason_id
   and reason.share_grant_id=publication.share_grant_id
   and reason.consent_id=publication.consent_id
  join source_owner_representation_consents publication_consent
    on publication_consent.id=publication.consent_id
   and publication_consent.state in ('active','paused') and publication_consent.revoked_at is null
   and (publication_consent.expires_at is null or publication_consent.expires_at>now())
   and (publication_consent.maximum_authorized_source_revision is null
     or ${representation}.source_revision<=publication_consent.maximum_authorized_source_revision)
  left join team_memory_sharing_rules rule on rule.id=reason.rule_id
  where publication.representation_id=${representation}.id
    and publication.share_grant_id=${grant}.id
    and publication.consent_id=${representation}.consent_id
    and ${grantAuthorizesRepresentationSql(`${representation}.representation`, "publication_consent")}
    and (
      (reason.kind='direct' and reason.rule_id is null
        and publication.rule_version is null and publication.publisher_fence is null
        and ${grantAuthorizesRepresentationSql(`${representation}.representation`, grant)})
      or (reason.kind='rule' and rule.state in ('active','paused')
        and rule.owner_user_id=${grant}.owner_user_id
        and ${sharingRuleMembershipSql("rule", "reason", grant)}
        and rule.team_id=${grant}.team_id
        and rule.team_workspace_id=${grant}.team_workspace_id
        and publication.rule_version<=rule.authority_version
        and publication.publisher_fence<=rule.publisher_fence
        and rule.effective_privacy_policy_hash=${representation}.effective_privacy_policy_hash
        and ${grantAuthorizesRepresentationSql(`${representation}.representation`, "rule")})
    )
)`;

// A companion or lifecycle notification needs at least one exact, currently
// permitted publication. Keep this an EXISTS so overlapping reasons never
// multiply collaboration rows or consume pagination capacity.
export const publishedSharedMemoryAuthorizationSql = (scope: {
  shareGrantId: string;
  teamId: string;
  teamWorkspaceId: string;
  logicalMemoryId: string;
  representationId?: string;
  representation?: string;
}): string => `exists (
  select 1 from team_memory_publication_grant_records published_grant
  join team_memory_representations published_representation
    on published_representation.id=published_grant.publication_representation_id
   and published_representation.share_grant_id=published_grant.id
   and published_representation.team_id=published_grant.team_id
   and published_representation.team_workspace_id=published_grant.team_workspace_id
   and published_representation.logical_memory_id=published_grant.logical_memory_id
  join source_owner_representation_consents published_consent
    on published_consent.id=published_representation.consent_id
   and published_consent.logical_memory_id=published_grant.logical_memory_id
   and published_consent.source_owner_principal_id=published_grant.owner_principal_id
   and published_consent.team_id=published_grant.team_id
   and published_consent.team_workspace_id=published_grant.team_workspace_id
   and published_consent.state in ('active','paused')
   and published_consent.revoked_at is null
   and (published_consent.expires_at is null or published_consent.expires_at>now())
  join source_owner_representation_policies published_owner_policy
    on published_owner_policy.policy_id=published_grant.source_owner_policy_id
   and published_owner_policy.version=published_grant.source_owner_policy_version
   and published_owner_policy.logical_memory_id=published_grant.logical_memory_id
   and published_owner_policy.source_owner_principal_id=published_grant.owner_principal_id
   and ${retainedOwnerPolicyAuthorizationSql("published_owner_policy")}
  join team_representation_policies published_team_policy
    on published_team_policy.policy_id=published_grant.team_policy_id
   and published_team_policy.version=published_grant.team_policy_version
   and published_team_policy.team_id=published_grant.team_id
   and published_team_policy.superseded_at is null
  join workspace_representation_policies published_workspace_policy
    on published_workspace_policy.policy_id=published_grant.workspace_policy_id
   and published_workspace_policy.version=published_grant.workspace_policy_version
   and published_workspace_policy.team_id=published_grant.team_id
   and published_workspace_policy.team_workspace_id=published_grant.team_workspace_id
   and published_workspace_policy.superseded_at is null
  where published_representation.source_owner_policy_id=published_grant.source_owner_policy_id
    and published_representation.source_owner_policy_version=published_grant.source_owner_policy_version
    and published_representation.team_policy_id=published_grant.team_policy_id
    and published_representation.team_policy_version=published_grant.team_policy_version
    and published_representation.workspace_policy_id=published_grant.workspace_policy_id
    and published_representation.workspace_policy_version=published_grant.workspace_policy_version
    and published_representation.fidelity_policy_revision=published_grant.fidelity_policy_revision
    and published_representation.content_policy_version=published_grant.content_policy_version
    and published_representation.classifier_version=published_grant.classifier_version
    and published_representation.state in ('available','stale')
    and published_representation.invalidated_at is null
    and (published_representation.curated_expires_at is null or published_representation.curated_expires_at>now())
    and published_grant.id=${scope.shareGrantId}
    and published_grant.team_id=${scope.teamId}
    and published_grant.team_workspace_id=${scope.teamWorkspaceId}
    and published_grant.logical_memory_id=${scope.logicalMemoryId}
    and published_grant.lifecycle='active'
    and published_grant.revoked_at is null
    and published_grant.tombstoned_at is null
    and published_grant.purge_completed_at is null
    ${scope.representationId ? `and published_representation.id=${scope.representationId}` : ""}
    ${scope.representation ? `and published_representation.representation::text=(${scope.representation})::text` : ""}
    and ${sharingReasonAuthorizesRepresentationSql("published_representation", "published_grant")}
    and ${cumulativeRepresentationAuthorizationSql(
      "published_representation.representation",
      {
        grant: "published_consent",
        consent: "published_consent",
        ownerPolicy: "published_owner_policy",
        teamPolicy: "published_team_policy",
        workspacePolicy: "published_workspace_policy"
      }
    )}
)`;

// A representation keeps its immutable approved owner-policy binding. A later
// reviewed expansion can preserve that narrower approval, but a current policy
// must still cover its whole cap. Explicit restrictions also invalidate the
// affected consents/representations in their existing transaction.
export const retainedOwnerPolicyAuthorizationSql = (bound: string): string => `(
  ${bound}.superseded_at is null or exists (
    select 1 from source_owner_representation_policies current_owner_cap
     where current_owner_cap.policy_id=${bound}.policy_id
       and current_owner_cap.logical_memory_id=${bound}.logical_memory_id
       and current_owner_cap.source_owner_principal_id=${bound}.source_owner_principal_id
       and current_owner_cap.version>${bound}.version
       and current_owner_cap.superseded_at is null
       and ${grantAuthorizesRepresentationSql(`${bound}.maximum_fidelity`, "current_owner_cap")}
       and (not ${bound}.include_curated_memory or current_owner_cap.include_curated_memory)
  )
)`;

// For semantic queries that already selected representation r, keep its exact
// publication lookup separate from the outer join tree. OFFSET 0 prevents the
// source-binding UNION branches from multiplying during planning. Callers keep
// every existing access gate and row lock; grant-locked hydration uses its
// original relation so row-lock propagation stays unchanged.
export const representationPublicationAuthoritySql = `lateral (
  select publication.* from team_memory_publication_grant_records publication
  where publication.id=r.share_grant_id
    and publication.publication_representation_id=r.id offset 0
) g`;
