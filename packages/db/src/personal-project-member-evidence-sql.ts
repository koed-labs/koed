import { personalEffectiveFolderFactSql } from "./personal-selection-sql.js";
import {
  personalDirectMembershipReadySql,
  personalRuleMembershipReadySql
} from "./personal-membership-selection-sql.js";

/** Unknown context can match; a verified different selector cannot. */
const selectorCouldMatchSql = (
  session: string,
  kind: string,
  scope: string,
  folder: string
): string => {
  const repository = `coalesce(${session}.repository_override_identity,${session}.repository_automatic_identity)`;
  const fact = personalEffectiveFolderFactSql(session);
  return `(case ${kind}
    when 'repository' then (${repository} is null or ${repository}->>'kind'='unresolved'
      or coalesce(repository_scope_matches(${repository},${scope}),false))
    when 'folder' then (${fact}->>'state' is distinct from 'known'
      or ${fact}->'value'->'reference'=${folder})
    else true end)`;
};

/** A missing body for another portable source does not make this source ambiguous.
 * Without a verified local binding, the portable identity is still unknown. */
const graphCouldAffectSourceSql = (session: string): string => `(
  graph.entity_kind='project'
  or (graph.entity_kind in ('direct','exclusion') and (
    not exists (select 1 from personal_source_bindings known_source
      where known_source.owner_user_id=${session}.owner_user_id
        and known_source.local_session_id=${session}.id
        and known_source.local_logical_session_id=${session}.logical_session_id
        and known_source.availability='available')
    or exists (select 1 from personal_source_bindings known_source
      where known_source.owner_user_id=${session}.owner_user_id
        and known_source.local_session_id=${session}.id
        and known_source.local_logical_session_id=${session}.logical_session_id
        and known_source.availability='available'
        and graph.selector_key::jsonb->'source'=jsonb_build_object(
          'originatingDeploymentId',known_source.originating_deployment_id,
          'originatingDeviceId',known_source.originating_device_id,
          'logicalSessionId',known_source.source_logical_session_id))
  ))
  or (graph.entity_kind='rule' and ${selectorCouldMatchSql(
    session,
    "graph.selector_key::jsonb->>'kind'",
    "graph.selector_key::jsonb->>'scope'",
    `(graph.selector_key::jsonb->'reference') || jsonb_build_object('ownerUserId',${session}.owner_user_id)`
  )})
)`;

/** Trusted aliases and placeholders only. An omitted Project member may have
 * an unresolved inclusion, rather than a conclusive membership change. */
export const personalProjectMemberEvidenceKnownSql = (
  session: string,
  project: string,
  matches: string,
  deleted: string
): string => `(${deleted} or ${matches} or (
  not exists (
    select 1 from personal_membership_entities graph
    where graph.owner_user_id=${session}.owner_user_id and graph.local_project_id=${project}
      and ${graphCouldAffectSourceSql(session)}
      and (graph.state<>'available' or (
        graph.entity_kind<>'project' and graph.current_revision->'operation'->>'kind' in ('include','exclude')
        and graph.local_entity_id is null
      ))
  )
  and not exists (
    select 1 from personal_project_inclusions inclusion
    where inclusion.owner_user_id=${session}.owner_user_id and inclusion.project_id=${project}
      and inclusion.logical_session_id=${session}.logical_session_id and inclusion.removed_at is null
      and not ${personalDirectMembershipReadySql("inclusion", session)}
  )
  and not exists (
    select 1 from personal_project_rules rule
    where rule.owner_user_id=${session}.owner_user_id and rule.project_id=${project}
      and rule.removed_at is null and not ${personalRuleMembershipReadySql("rule")}
      and ${selectorCouldMatchSql(session, "rule.target->>'kind'", "rule.target_scope", "rule.target->'folder'")}
  )
  and (
    exists (
      select 1 from personal_project_exclusions exclusion
      where exclusion.owner_user_id=${session}.owner_user_id and exclusion.project_id=${project}
        and exclusion.logical_session_id=${session}.logical_session_id and exclusion.cleared_at is null
    )
    or not exists (
      select 1 from personal_project_rules rule
      where rule.owner_user_id=${session}.owner_user_id and rule.project_id=${project} and rule.removed_at is null
        and ((rule.target->>'kind'='repository' and (
          coalesce(${session}.repository_override_identity,${session}.repository_automatic_identity) is null
          or coalesce(${session}.repository_override_identity,${session}.repository_automatic_identity)->>'kind'='unresolved'
        )) or (rule.target->>'kind'='folder' and
          ${personalEffectiveFolderFactSql(session)}->>'state' is distinct from 'known'))
    )
  )
))`;
