import { curatedMemoryActiveEvidenceRowsSql } from "./curated-memory-policy.js";
import { semanticMemoryEventEligibleSql } from "./approval-activity-sql.js";

// Only metadata is read here. All fields are owner-bound; source text remains behind
// the existing candidate authorization and decrypt path. Branch observations cannot
// be copied from a reassignment target or inferred across conflicting captures.
export const globalRepositoryContextJoinSql = (
  sourceAfter = "$12",
  sourceBefore = "$13"
): string => `
 left join lateral (
  with recursive repo_nodes(id,seen) as (
   select n.id,array[n.id] from memory_nodes n
    where n.id=me.memory_node_id and n.owner_user_id=$1 and n.visibility='personal' and n.invalidated_at is null and n.personal_deleted_at is null
   union all
   select child.id,parent.seen||child.id from repo_nodes parent
    join memory_node_children link on link.parent_memory_node_id=parent.id
    join memory_nodes child on child.id=link.child_memory_node_id and child.owner_user_id=$1 and child.visibility='personal' and child.invalidated_at is null and child.personal_deleted_at is null
    where not child.id=any(parent.seen) and cardinality(parent.seen)<32
  ), repo_refs(session_id,source_time) as (
   select ev.session_id,ev.captured_at where me.memory_event_id is not null and ev.owner_user_id=$1 and ev.visibility='personal' and ev.invalidated_at is null and ev.personal_deleted_at is null and (${semanticMemoryEventEligibleSql("ev")})
   union all
   select msg.session_id,msg.captured_at where me.message_id is not null and msg.owner_user_id=$1 and msg.visibility='personal' and msg.invalidated_at is null and msg.recall_eligible=true
   union all
   select coalesce(source_ev.session_id,m.session_id),coalesce(source_ev.captured_at,m.captured_at) from repo_nodes node
    join memory_node_sources source on source.memory_node_id=node.id
    left join memory_events source_ev on source_ev.id=source.memory_event_id and source_ev.owner_user_id=$1 and source_ev.visibility='personal' and source_ev.invalidated_at is null and source_ev.personal_deleted_at is null and (${semanticMemoryEventEligibleSql("source_ev")})
    left join messages m on m.id=source.message_id and m.owner_user_id=$1 and m.visibility='personal' and m.invalidated_at is null and m.recall_eligible=true
   union all
   select n.session_id,n.created_at from repo_nodes node join memory_nodes n on n.id=node.id where n.session_id is not null and not exists(select 1 from memory_node_sources source where source.memory_node_id=n.id)
   union all
   select active.source_session_id,active.source_event_time from (${curatedMemoryActiveEvidenceRowsSql("cma", "repo_active")}) active
  )
  select coalesce(jsonb_agg(distinct jsonb_build_object(
   'sessionId',s.id,
   'assignmentSource',case when s.repository_override_identity is not null then 'manual_override' else 'automatic' end,
   'capturedProjectLabel',s.repository_automatic_identity->>'anchorDisplay',
   'identity',coalesce(s.repository_override_identity,s.repository_automatic_identity),
   'label',case when coalesce(s.repository_override_identity,s.repository_automatic_identity)->>'kind' <> 'unresolved'
      then coalesce(coalesce(s.repository_override_identity,s.repository_automatic_identity)->>'anchorDisplay',s.project_override_name,s.automatic_project_name) else null end,
   'branch',case when repository_scope_matches(s.repository_automatic_identity,repository_scope_id(coalesce(s.repository_override_identity,s.repository_automatic_identity)))
      and not exists(select 1 from session_repository_observations o where o.session_id=s.id and o.owner_user_id=$1 and (
        not repository_scope_matches(o.identity,repository_scope_id(s.repository_automatic_identity))
        or o.identity->>'branch' is distinct from s.repository_automatic_identity->>'branch'))
      then case when s.metadata ? 'pds'
        then s.metadata->'pds'->'repositoryAssignment'->>'branchObservation'
        else s.repository_automatic_identity->>'branch' end else null end
  )), '[]'::jsonb) as contexts
  from repo_refs reference
   left join sessions s on s.id=reference.session_id and s.owner_user_id=$1 and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
  where (${sourceAfter}::timestamptz is null or reference.source_time >= ${sourceAfter}) and (${sourceBefore}::timestamptz is null or reference.source_time < ${sourceBefore})
 ) repo_context on true
`;
