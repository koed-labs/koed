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
