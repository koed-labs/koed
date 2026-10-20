/** These expressions consume only server-owned SQL aliases. */
export const personalProjectCatalogReadySql = (
  project: string
): string => `not exists(
  select 1 from personal_membership_entities membership_catalog
  where membership_catalog.owner_user_id=${project}.owner_user_id and membership_catalog.local_project_id=${project}.project_id
    and membership_catalog.entity_kind='project' and (membership_catalog.state<>'available'
      or membership_catalog.current_revision->'operation'->>'kind' is distinct from 'set_project')
)`;

/** A received direct inclusion needs its actual verified Session pointer, never a predicted UUID. */
export const personalDirectMembershipReadySql = (
  inclusion: string,
  session?: string
): string => {
  const invalid = `(membership_direct.state<>'available'
    or membership_direct.current_revision->'operation'->>'kind' is distinct from 'include'
    or membership_direct.current_revision->'operation'->'selector'->>'kind' is distinct from 'session'
    or not exists(select 1 from personal_source_bindings membership_source
      join sessions membership_session on membership_session.id=membership_source.local_session_id
        and membership_session.owner_user_id=membership_source.owner_user_id
        and membership_session.logical_session_id=membership_source.local_logical_session_id
      where membership_source.binding_id=membership_direct.source_binding_id
        and membership_source.owner_user_id=${inclusion}.owner_user_id and membership_source.availability='available'
        and membership_session.logical_session_id=${inclusion}.logical_session_id
        and membership_session.visibility='personal' and membership_session.invalidated_at is null and membership_session.personal_deleted_at is null
        ${session ? `and membership_session.id=${session}.id and membership_session.owner_user_id=${session}.owner_user_id` : ""}))`;
  return `not exists(
    select 1 from personal_membership_entities membership_direct
    where membership_direct.owner_user_id=${inclusion}.owner_user_id and membership_direct.local_project_id=${inclusion}.project_id
      and membership_direct.local_entity_id=${inclusion}.inclusion_id and membership_direct.entity_kind='direct' and ${invalid}
    union all
    select 1 from sessions membership_match_session
      join personal_source_bindings membership_match on membership_match.owner_user_id=membership_match_session.owner_user_id and membership_match.local_session_id=membership_match_session.id
      join personal_membership_entities membership_direct on membership_direct.owner_user_id=membership_match.owner_user_id and membership_direct.source_binding_id=membership_match.binding_id
    where membership_match_session.owner_user_id=${inclusion}.owner_user_id and membership_match_session.logical_session_id=${inclusion}.logical_session_id
      ${session ? `and membership_match_session.id=${session}.id` : ""}
      and membership_direct.local_project_id=${inclusion}.project_id and membership_direct.entity_kind='direct'
      and membership_direct.local_entity_id is null and ${invalid}
  )`;
};
export const personalRuleMembershipReadySql = (
  rule: string
): string => `not exists(
  select 1 from personal_membership_entities membership_rule
  where membership_rule.owner_user_id=${rule}.owner_user_id and membership_rule.local_project_id=${rule}.project_id
    and membership_rule.local_entity_id=${rule}.inclusion_id and membership_rule.entity_kind='rule'
    and (membership_rule.state<>'available'
      or membership_rule.current_revision->'operation'->>'kind' is distinct from 'include'
      or not coalesce(((membership_rule.current_revision->'operation'->'selector'->>'kind'='repository'
          and repository_scope_id(membership_rule.current_revision->'operation'->'selector'->'repository')=${rule}.target_scope)
        or (membership_rule.current_revision->'operation'->'selector'->>'kind'='folder'
          and membership_rule.current_revision->'operation'->'selector'->'folder'=${rule}.target->'folder')),false))
)`;

/** Resolve a portable Project identity or its owned native view without widening
 * an ambiguous alias to another Project. All aliases/expressions are server-owned SQL.
 */
export const personalProjectIdentityMatchesSql = (
  project: string,
  identity: string
): string => `(
  (${project}.project_id::text=${identity} or exists (
    select 1 from personal_membership_entities membership_identity
    where membership_identity.owner_user_id=${project}.owner_user_id and membership_identity.entity_kind='project'
      and membership_identity.project_identity=${identity} and membership_identity.local_project_id=${project}.project_id
  ))
  and not exists (
    select 1 from personal_membership_entities conflicting_identity
    where conflicting_identity.owner_user_id=${project}.owner_user_id and conflicting_identity.entity_kind='project'
      and conflicting_identity.project_identity=${identity} and conflicting_identity.local_project_id<>${project}.project_id
  )
  and not exists (
    select 1 from personal_named_projects conflicting_native
    where conflicting_native.owner_user_id=${project}.owner_user_id and conflicting_native.project_id::text=${identity}
      and conflicting_native.project_id<>${project}.project_id
  )
)`;

/** A retained exclusion blocks its exact verified source even before a native
 * exclusion row has been rebuilt after body arrival. Unresolved heads deny.
 */
export const personalGraphExclusionBlocksSql = (
  session: string,
  owner: string,
  project: string
): string => `exists(
  select 1 from personal_membership_entities membership_exclusion
  join personal_source_bindings exclusion_source on exclusion_source.binding_id=membership_exclusion.source_binding_id
    and exclusion_source.owner_user_id=membership_exclusion.owner_user_id
  where membership_exclusion.owner_user_id=${owner} and membership_exclusion.local_project_id=${project}
    and membership_exclusion.entity_kind='exclusion' and exclusion_source.local_session_id=${session}.id
    and exclusion_source.local_logical_session_id=${session}.logical_session_id
    and ${session}.owner_user_id=membership_exclusion.owner_user_id
    and (membership_exclusion.state<>'available'
      or membership_exclusion.current_revision->'operation'->>'kind' is distinct from 'clear_exclusion')
)`;
