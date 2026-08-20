type MemoryEventAlias = "me" | "ev" | "source_ev" | "approval_event";

const approvalActivityMetadataSql = (metadata: string): string => `(
  coalesce(${metadata} ->> 'approvalReview', 'false') = 'true'
  or coalesce(${metadata} ->> 'approvalHelperConversation', 'false') = 'true'
  or ${metadata} ? 'approvalActivity'
  or ${metadata} ? 'approvalKind'
  or ${metadata} ? 'providerApprovalKind'
  or lower(btrim(coalesce(${metadata} ->> 'transcriptType', ''))) like 'approval\\_%' escape '\\'
  or lower(btrim(coalesce(${metadata} ->> 'toolEventKind', ''))) in (
    'approval_request',
    'request_approval',
    'exec_command_approval_request',
    'apply_patch_approval_request',
    'approval_decision',
    'approval_response',
    'approval_result',
    'automatic_approval_decision',
    'auto_approval_decision',
    'approval_tool_result',
    'approval_specific_tool_result'
  )
)`;

/**
 * SQL counterpart to classifyApprovalActivity for semantic Memory Event reads.
 * The alias union is closed so callers cannot interpolate user-controlled SQL.
 */
export const semanticMemoryEventEligibleSql = (
  alias: MemoryEventAlias
): string => `
  not ${approvalActivityMetadataSql(
    `coalesce(${alias}.payload -> 'metadata', '{}'::jsonb)`
  )}
  and not exists (
    select 1
    from memory_event_sources approval_source
    join conversation_items approval_item
      on approval_item.id = approval_source.conversation_item_id
    where approval_source.memory_event_id = ${alias}.id
      and ${approvalActivityMetadataSql(
        "coalesce(approval_item.metadata, '{}'::jsonb)"
      )}
  )
`;

export const approvalConversationItemSql = (
  alias: "ci" | "approval_item"
): string =>
  approvalActivityMetadataSql(`coalesce(${alias}.metadata, '{}'::jsonb)`);

/**
 * Require every direct Curated Memory evidence source to resolve to one
 * eligible Personal Memory object in the selected Captured Session.
 * Parameters are SQL placeholders supplied by trusted repository code.
 */
export const sessionExactCuratedAssertionSql = (
  ownerParameter: string,
  sessionParameter: string
): string => `(
  exists (
    select 1 from curated_memory_sources required_source
     where required_source.assertion_id=cma.id
       and required_source.source_role in
         ('primary_evidence','supporting_evidence','superseding_evidence','conflicting_evidence')
  )
  and not exists (
    select 1
      from curated_memory_sources cms
     where cms.assertion_id=cma.id
       and cms.source_role in
         ('primary_evidence','supporting_evidence','superseding_evidence','conflicting_evidence')
       and (
         num_nonnulls(cms.conversation_item_id,cms.memory_event_id,cms.lcm_node_id)<>1
         or (cms.conversation_item_id is not null and not exists (
           select 1 from conversation_items ci
            where ci.id=cms.conversation_item_id
              and ci.owner_user_id=${ownerParameter} and ci.session_id=${sessionParameter}
              and ci.visibility='personal'
              and ci.personal_deleted_at is null
              and ci.memory_excluded_at is null
              and not (${approvalConversationItemSql("ci")})
         ))
         or (cms.memory_event_id is not null and not exists (
           select 1 from memory_events me
            where me.id=cms.memory_event_id
              and me.owner_user_id=${ownerParameter} and me.session_id=${sessionParameter}
              and me.visibility='personal'
              and me.invalidated_at is null
              and me.personal_deleted_at is null
              and ${semanticMemoryEventEligibleSql("me")}
         ))
         or (cms.lcm_node_id is not null and not exists (
           with recursive descendants(id) as (
             select cms.lcm_node_id
             union
             select child.child_memory_node_id
               from memory_node_children child
               join descendants parent on parent.id=child.parent_memory_node_id
           )
           select 1
             from memory_nodes root
            where root.id=cms.lcm_node_id
              and root.owner_user_id=${ownerParameter} and root.session_id=${sessionParameter}
              and root.visibility='personal'
              and root.invalidated_at is null
              and root.personal_deleted_at is null
              and not exists (
                select 1 from descendants d
                left join memory_nodes node on node.id=d.id
                 and node.owner_user_id=${ownerParameter} and node.session_id=${sessionParameter}
                 and node.visibility='personal'
                 and node.invalidated_at is null
                 and node.personal_deleted_at is null
                where node.id is null
              )
              and not exists (
                select 1
                  from descendants d
                  join memory_node_sources node_source
                    on node_source.memory_node_id=d.id
                  left join memory_events me
                    on me.id=node_source.memory_event_id
                   and me.owner_user_id=${ownerParameter} and me.session_id=${sessionParameter}
                   and me.visibility='personal'
                   and me.invalidated_at is null
                   and me.personal_deleted_at is null
                 where me.id is null
                    or not (${semanticMemoryEventEligibleSql("me")})
              )
         ))
       )
  )
)`;
