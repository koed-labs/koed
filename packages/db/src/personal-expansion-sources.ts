import type pg from "pg";
import { codexIdePromptUserText, type LcmSourceItem } from "@koed/core";
import { approvalConversationItemSql } from "./approval-activity-sql.js";
import {
  personalMemoryNodeSelectionSql,
  personalNodeLineageSql
} from "./personal-derived-selection-sql.js";
import {
  personalSourceSelectionSql,
  type PersonalSourceSelection
} from "./personal-selection-sql.js";

export const loadPersonalExpansionMessages = async (
  pool: Pick<pg.Pool, "query">,
  input: {
    nodeId: string;
    selection: PersonalSourceSelection;
    after: Date | null;
    before: Date | null;
    decryptMessage(id: string): Promise<unknown>;
  }
): Promise<LcmSourceItem[]> => {
  const rows = await pool.query<{
    id: string;
    content: string;
    role: string;
    session_id: string | null;
    turn_id: string | null;
    captured_at: Date;
    source_event_time: Date | null;
  }>(
    `
    ${personalNodeLineageSql("$1::uuid", "$2")}
    select distinct m.id,m.content,m.role,m.session_id,m.turn_id,m.captured_at,m.source_event_time
    from selection_nodes lineage join memory_node_sources ref on ref.memory_node_id=lineage.id
    join messages m on m.id=ref.message_id
    left join sessions s on s.id=m.session_id
    where m.owner_user_id=($2::jsonb->>'ownerUserId')::uuid and m.visibility='personal'
      and m.invalidated_at is null and m.recall_eligible=true and ${personalSourceSelectionSql("s", "$2")}
      and ($3::timestamptz is null or coalesce(m.source_event_time, m.captured_at) >= $3) and ($4::timestamptz is null or coalesce(m.source_event_time, m.captured_at) < $4)
      and not exists(select 1 from conversation_items approval_item
        where approval_item.owner_user_id=m.owner_user_id
          and m.idempotency_key='message:' || coalesce(approval_item.metadata->>'canonicalConversationItemKey',approval_item.canonical_item_key,approval_item.logical_source_id,approval_item.id::text)
          and ${approvalConversationItemSql("approval_item")})
    order by m.captured_at,m.id
  `,
    [input.nodeId, JSON.stringify(input.selection), input.after, input.before]
  );
  return Promise.all(
    rows.rows.map(async (row, position) => {
      const content =
        row.content === "[koed encrypted message]"
          ? await input.decryptMessage(row.id)
          : row.content;
      if (typeof content !== "string")
        throw new Error("Encrypted expansion message source is missing");
      return {
        kind: "message" as const,
        sourceTable: "messages" as const,
        sourceId: row.id,
        createdAt: row.captured_at.toISOString(),
        occurredAt: (row.source_event_time ?? row.captured_at).toISOString(),
        capturedAt: row.captured_at.toISOString(),
        visibility: "personal" as const,
        text: codexIdePromptUserText(content),
        turnId: row.turn_id,
        payload: { sessionId: row.session_id, role: row.role },
        position
      };
    })
  );
};

/** Source-item snapshots never authorize a child summary. Load its current body only after this check. */
export const loadPersonalExpansionChildren = (
  pool: Pick<pg.Pool, "query">,
  nodeId: string,
  selection: PersonalSourceSelection,
  after: Date | null,
  before: Date | null
) =>
  pool.query<{
    id: string;
    owner_user_id: string;
    visibility: "personal";
    summary_text: string;
    source_items_json: unknown;
    summary_embedding_revision: string;
    child_order: number;
  }>(
    `
    select child.id,child.owner_user_id,child.visibility,child.summary_text,child.source_items_json,child.summary_embedding_revision,edge.child_order
    from memory_node_children edge join memory_nodes child on child.id=edge.child_memory_node_id
    where edge.parent_memory_node_id=$1 and ${personalMemoryNodeSelectionSql("child.id", "$2", "$3", "$4")}
    order by edge.child_order,child.id
  `,
    [nodeId, JSON.stringify(selection), after, before]
  );
