import type pg from "pg";
import type { LcmSourceItem, MemoryActor } from "@koed/core";
import type { Visibility } from "./types.js";
import { semanticMemoryEventEligibleSql } from "./approval-activity-sql.js";

export interface LcmContextEvent {
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  session_id: string | null;
  turn_id: string | null;
  payload: Record<string, unknown> & {
    actor?: MemoryActor;
    content?: string;
    contentEncrypted?: boolean;
    metadata?: Record<string, unknown>;
  };
  captured_at: Date;
  source_event_time: Date | null;
}

export const loadLcmContextItems = async (
  client: pg.Pool | pg.PoolClient,
  nodeId: string,
  hydrate: (event: LcmContextEvent) => Promise<LcmSourceItem>
): Promise<LcmSourceItem[]> => {
  const result = await client.query<LcmContextEvent>(
    `select me.id,me.owner_user_id,me.visibility,me.session_id,me.turn_id,
            me.payload,me.captured_at,me.source_event_time
       from memory_node_context_events dependency
       join memory_nodes node on node.id=dependency.memory_node_id
       join memory_events me on me.id=dependency.memory_event_id
      where node.id=$1 and node.kind='leaf'
        and node.invalidated_at is null and node.personal_deleted_at is null
        and node.session_id is not null and me.session_id=node.session_id
        and me.owner_user_id=node.owner_user_id and me.visibility=node.visibility
        and me.invalidated_at is null and me.personal_deleted_at is null
        and me.include_in_lcm=true and pds_session_recall_ready(me.session_id)
        and ${semanticMemoryEventEligibleSql("me")}`,
    [nodeId]
  );
  const items = await Promise.all(result.rows.map(hydrate));
  return items.filter(
    (item) => typeof item.text === "string" && item.text.trim().length > 0
  );
};
