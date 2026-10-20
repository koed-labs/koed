import type pg from "pg";
import { contributingCuratedMemorySourceSql } from "./curated-memory-source-roles.js";
import {
  approvalConversationItemSql,
  semanticMemoryEventEligibleSql
} from "./approval-activity-sql.js";
import {
  personalSourceSelectionSql,
  type PersonalSourceReadOptions,
  type PersonalSourceSelection
} from "./personal-selection-sql.js";

const ownerSql = (selection: string) =>
  `(${selection}::jsonb->>'ownerUserId')::uuid`;
const windowSql = (time: string, after: string, before: string) => `(
  (${after}::timestamptz is null or ${time} >= ${after}::timestamptz)
  and (${before}::timestamptz is null or ${time} < ${before}::timestamptz)
)`;

/** Traverse current, eligible owner-bound nodes only. Depth is bounded even for malformed cycles. */
export const personalNodeLineageSql = (
  root: string,
  selection: string,
  options: PersonalSourceReadOptions = {}
): string => `
  with recursive selection_nodes(id,depth) as (
    select selection_root.id,0 from memory_nodes selection_root where selection_root.id=${root}
      and selection_root.owner_user_id=${ownerSql(selection)} and selection_root.visibility='personal'
      and ${options.includeInvalidated ? "true" : "selection_root.invalidated_at is null and selection_root.personal_deleted_at is null"}
    union
    select child.id,parent.depth+1 from selection_nodes parent
      join memory_node_children edge on edge.parent_memory_node_id=parent.id
      join memory_nodes child on child.id=edge.child_memory_node_id
        and child.owner_user_id=${ownerSql(selection)} and child.visibility='personal'
        and ${options.includeInvalidated ? "true" : "child.invalidated_at is null and child.personal_deleted_at is null"}
      where parent.depth<32
  )
`;

const eventEligibleSql = (
  selection: string,
  after: string,
  before: string,
  curated = false,
  options: PersonalSourceReadOptions = {}
) => `(
  source_ev.id is not null and source_ev.owner_user_id=${ownerSql(selection)}
  and source_ev.visibility='personal'
  and ${options.includeInvalidated ? "true" : "source_ev.invalidated_at is null and source_ev.personal_deleted_at is null"} and ${curated ? "(source_ev.include_in_embedding=true or source_ev.include_in_lcm=true)" : "source_ev.include_in_lcm=true"}
  and (${semanticMemoryEventEligibleSql("source_ev")})
  and ${personalSourceSelectionSql("source_session", selection, options)}
  and ${windowSql(curated ? "coalesce(source_ev.source_event_time,source_ev.captured_at)" : "source_ev.captured_at", after, before)}
)`;

const messageEligibleSql = (
  selection: string,
  after: string,
  before: string,
  options: PersonalSourceReadOptions = {}
) => `(
  source_msg.id is not null and source_msg.owner_user_id=${ownerSql(selection)}
  and source_msg.visibility='personal' and ${options.includeInvalidated ? "true" : "source_msg.invalidated_at is null"} and source_msg.recall_eligible=true
  and not exists (select 1 from conversation_items approval_item
    where approval_item.owner_user_id=source_msg.owner_user_id
      and source_msg.idempotency_key='message:' || coalesce(approval_item.metadata->>'canonicalConversationItemKey',approval_item.canonical_item_key,approval_item.logical_source_id,approval_item.id::text)
      and ${approvalConversationItemSql("approval_item")})
  and ${personalSourceSelectionSql("source_session", selection, options)}
  and ${windowSql("source_msg.captured_at", after, before)}
)`;

/** A placeholder can be represented by a fresh outline, without disclosing its retained body. */
export const personalMemoryNodeHasSelectedSourcesSql = (
  root: string,
  selection: string,
  after: string,
  before: string,
  options: PersonalSourceReadOptions = {}
): string => `exists (
  ${personalNodeLineageSql(root, selection, options)}
  select 1 from selection_nodes lineage join memory_node_sources ref on ref.memory_node_id=lineage.id
  left join memory_events source_ev on source_ev.id=ref.memory_event_id
  left join messages source_msg on source_msg.id=ref.message_id
  left join sessions source_session on source_session.id=coalesce(source_ev.session_id,source_msg.session_id)
  where (ref.memory_event_id is not null and ref.message_id is null and ref.tool_event_id is null and ${eventEligibleSql(selection, after, before, false, options)})
    or (ref.message_id is not null and ref.memory_event_id is null and ref.tool_event_id is null and ${messageEligibleSql(selection, after, before, options)})
)`;

/** A summary body is safe only if all current contributing sources qualify.
 * A source-less, user-authored leaf remains available. Generated summaries cannot
 * become source-less merely because their backing source was removed.
 */
export const personalMemoryNodeSelectionSql = (
  root: string,
  selection: string,
  after: string,
  before: string,
  options: PersonalSourceReadOptions = {}
): string => `exists (
  ${personalNodeLineageSql(root, selection, options)}
  select 1 where exists(select 1 from selection_nodes)
    and not exists (
      select 1 from selection_nodes lineage join memory_nodes selected_node on selected_node.id=lineage.id
      where (lineage.depth=32 and exists(select 1 from memory_node_children edge where edge.parent_memory_node_id=lineage.id))
        or (selected_node.kind='leaf' and selected_node.source_event_count > (select count(*) from memory_node_sources ref where ref.memory_node_id=lineage.id))
        or (selected_node.kind='rollup' and selected_node.source_event_count > greatest(
          (select count(*) from memory_node_sources ref where ref.memory_node_id=lineage.id),
          coalesce((select sum(child.source_event_count) from memory_node_children edge join memory_nodes child on child.id=edge.child_memory_node_id where edge.parent_memory_node_id=lineage.id),0)))
        or exists(select 1 from memory_node_children edge where edge.parent_memory_node_id=lineage.id
          and not exists(select 1 from selection_nodes child where child.id=edge.child_memory_node_id))
        or exists (
          select 1 from memory_node_sources ref
          left join memory_events source_ev on source_ev.id=ref.memory_event_id
          left join messages source_msg on source_msg.id=ref.message_id
          left join sessions source_session on source_session.id=coalesce(source_ev.session_id,source_msg.session_id)
          where ref.memory_node_id=lineage.id and not coalesce((
            (ref.memory_event_id is not null and ref.message_id is null and ref.tool_event_id is null and ${eventEligibleSql(selection, after, before, false, options)})
            or (ref.message_id is not null and ref.memory_event_id is null and ref.tool_event_id is null and ${messageEligibleSql(selection, after, before, options)})
          ),false)
        )
        or (
          not exists(select 1 from memory_node_sources ref where ref.memory_node_id=lineage.id)
          and not exists(select 1 from memory_node_children edge where edge.parent_memory_node_id=lineage.id)
          and not coalesce((selected_node.kind='leaf' and ${options.inspection ? "true" : "selected_node.summary_model is null"}
            and selected_node.lcm_algorithm_version is null and selected_node.source_event_count=0
            and (selected_node.source_items_json='[]'::jsonb or selected_node.source_items_json is null)
            and exists(select 1 from (select 1) marker left join sessions s on s.id=selected_node.session_id
              where ${personalSourceSelectionSql("s", selection, options)})
            and ${windowSql("selected_node.captured_at", after, before)}),false)
        )
    )
)`;

/** Requires ci, source_ev, linked_node and source_session aliases from current source records. */
export const personalCuratedSourceSelectionSql = (
  reference: string,
  selection: string,
  after: string,
  before: string
): string => `(
  (${reference}.source_type='conversation_item' and ci.id is not null and ci.owner_user_id=${ownerSql(selection)}
    and ci.visibility='personal' and ci.personal_deleted_at is null and ci.memory_excluded_at is null
    and not ${approvalConversationItemSql("ci")}
    and ${personalSourceSelectionSql("source_session", selection)}
    and ${windowSql("coalesce(ci.event_time,ci.observed_at,ci.created_at)", after, before)})
  or (${reference}.source_type='memory_event' and ${eventEligibleSql(selection, after, before, true)})
  or (${reference}.source_type='lcm_summary' and linked_node.id is not null
    and ${personalMemoryNodeSelectionSql("linked_node.id", selection, after, before)})
)`;

/** Every contributing link must remain valid. Filtering active links first would hide revocations. */
export const personalCuratedMemorySelectionSql = (
  assertion: string,
  selection: string,
  after: string,
  before: string
): string => `(
  exists(select 1 from curated_memory_sources ref where ref.assertion_id=${assertion}.id and ${contributingCuratedMemorySourceSql("ref")})
  and not exists (
    select 1 from curated_memory_sources ref
    left join conversation_items ci on ci.id=ref.conversation_item_id
    left join memory_events source_ev on source_ev.id=ref.memory_event_id
    left join memory_nodes linked_node on linked_node.id=ref.lcm_node_id
    left join sessions source_session on source_session.id=coalesce(ci.session_id,source_ev.session_id)
    where ref.assertion_id=${assertion}.id
      and ${contributingCuratedMemorySourceSql("ref")}
      and not coalesce(${personalCuratedSourceSelectionSql("ref", selection, after, before)},false)
  )
)`;

/** Auxiliary links do not select sources or authorize retained metadata by themselves. */
export const authorizedPersonalCuratedSourceIds = async (
  pool: Pick<pg.Pool, "query">,
  selection: PersonalSourceSelection,
  assertionIds: string[],
  after: Date | null,
  before: Date | null
): Promise<string[]> => {
  if (!assertionIds.length) return [];
  const rows = await pool.query<{ id: string }>(
    `
    select ref.id from curated_memory_sources ref
    join curated_memory_assertions cma on cma.id=ref.assertion_id and cma.owner_user_id=${ownerSql("$1")} and cma.visibility='personal'
    left join conversation_items ci on ci.id=ref.conversation_item_id
    left join memory_events source_ev on source_ev.id=ref.memory_event_id
    left join memory_nodes linked_node on linked_node.id=ref.lcm_node_id
    left join sessions source_session on source_session.id=coalesce(ci.session_id,source_ev.session_id)
    where ref.assertion_id=any($2::uuid[]) and ${personalCuratedSourceSelectionSql("ref", "$1", "$3", "$4")}
  `,
    [JSON.stringify(selection), assertionIds, after, before]
  );
  return rows.rows.map((row) => row.id);
};

/** Repeat derived-source authorization immediately before decrypting a retained candidate. */
export const authorizedPersonalDerivedEvidence = async (
  pool: Pick<pg.Pool, "query">,
  selection: PersonalSourceSelection,
  rows: Array<{ source_type: string; source_id: string }>,
  after: Date | null,
  before: Date | null,
  includeHistoricalAssertions = false,
  includePlaceholderOutlines = false,
  readOptions: PersonalSourceReadOptions = {}
): Promise<Map<string, boolean>> => {
  const nodes = rows
    .filter((row) => row.source_type === "memory_node")
    .map((row) => row.source_id);
  const assertions = rows
    .filter((row) => row.source_type === "curated_memory")
    .map((row) => row.source_id);
  if (!nodes.length && !assertions.length) return new Map();
  const result = await pool.query<{
    source_type: string;
    source_id: string;
    can_read_body: boolean;
  }>(
    `
    select 'memory_node' as source_type, n.id::text as source_id, ${personalMemoryNodeSelectionSql("n.id", "$1", "$4", "$5", readOptions)} as can_read_body from memory_nodes n
      where n.id=any($2::uuid[]) and (
        ${personalMemoryNodeSelectionSql("n.id", "$1", "$4", "$5", readOptions)}
        or ($7::boolean and n.summary_model is null and ${personalMemoryNodeHasSelectedSourcesSql("n.id", "$1", "$4", "$5", readOptions)}))
    union all
    select 'curated_memory', cma.id::text, true from curated_memory_assertions cma
      where cma.id=any($3::uuid[]) and cma.owner_user_id=${ownerSql("$1")} and cma.visibility='personal'
        and ($6::boolean or cma.status='current') and cma.suppressed_at is null and (cma.expires_at is null or cma.expires_at>now())
        and ${personalCuratedMemorySelectionSql("cma", "$1", "$4", "$5")}
  `,
    [
      JSON.stringify(selection),
      nodes,
      assertions,
      after,
      before,
      includeHistoricalAssertions,
      includePlaceholderOutlines
    ]
  );
  return new Map(
    result.rows.map((row) => [
      `${row.source_type}:${row.source_id}`,
      row.can_read_body
    ])
  );
};
