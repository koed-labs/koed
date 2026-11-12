import type pg from "pg";
import type { LcmSourceItem, MemoryActor, Visibility } from "@koed-labs/core";
import { semanticMemoryEventEligibleSql } from "./approval-activity-sql.js";
import {
  personalSourceSelectionSql,
  resolvePersonalSourceSelection,
  type PersonalSourceSelection
} from "./personal-selection-sql.js";

export interface RetrievalContextEvent {
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  session_id: string | null;
  turn_id: string | null;
  payload: {
    actor?: MemoryActor;
    content?: string;
    contentEncrypted?: boolean;
  };
  captured_at: Date;
  source_event_time: Date | null;
  result_id: string;
  matched_source_id: string;
  context_role: "matched" | "preceding" | "following";
}

export const retrievalContextKey = (hit: {
  sourceType?: string;
  sourceId?: string;
}): string => `${hit.sourceType}:${hit.sourceId}`;

/** Resolve neighbors before authorization: an unavailable adjacent event is a gap. */
export async function retrieveCanonicalEventContext(
  pool: pg.Pool,
  input: {
    userId: string;
    hits: Array<{
      nodeId: string;
      sourceType?: string;
      sourceId?: string;
      embeddingId?: string | null;
    }>;
    searchDomain: string;
    sessionId?: string;
    projectId?: string;
    selection?: PersonalSourceSelection;
    sourceAfter: Date | null;
    sourceBefore: Date | null;
  },
  hydrate: (event: RetrievalContextEvent) => Promise<RetrievalContextEvent>
): Promise<Map<string, LcmSourceItem[]>> {
  const hits = input.hits.filter((hit) => hit.sourceType === "memory_event");
  if (hits.length === 0) return new Map();
  const searchDomain = input.searchDomain;
  if (
    searchDomain !== "global" &&
    searchDomain !== "project" &&
    searchDomain !== "session"
  ) {
    throw new Error("Invalid canonical event context search domain");
  }
  const selection =
    input.selection ??
    resolvePersonalSourceSelection(input.userId, {
      searchDomain,
      sessionId: input.sessionId,
      projectId: input.projectId
    });
  const authorized = `me.visibility = 'personal'
    and me.owner_user_id = $2
    and me.invalidated_at is null and me.personal_deleted_at is null
    and (me.include_in_embedding = true or me.include_in_lcm = true)
    and pds_session_recall_ready(me.session_id)
    and ${semanticMemoryEventEligibleSql("me")}
    and ($3::timestamptz is null or coalesce(me.source_event_time,me.captured_at) >= $3)
    and ($4::timestamptz is null or coalesce(me.source_event_time,me.captured_at) < $4)
    and ${personalSourceSelectionSql("s", "$5")}`;
  const result = await pool.query<RetrievalContextEvent>(
    `with hits as (
      select * from jsonb_to_recordset($1::jsonb)
        as h("nodeId" text, "sourceType" text, "sourceId" text, "embeddingId" uuid)
    ), current_hits as (
      select h.* from hits h
      where h."embeddingId" is null or exists (
        select 1 from memory_embeddings embedding
        where embedding.id = h."embeddingId" and embedding.invalidated_at is null
          and embedding.personal_deleted_at is null
          and embedding.owner_user_id = $2 and embedding.visibility = 'personal'
          and embedding.memory_event_id = h."sourceId"::uuid
      )
    ), candidate_ids as (
      select h."sourceType" || ':' || h."sourceId" as result_id,
        h."sourceId"::uuid as id
      from current_hits h where h."sourceType" = 'memory_event'
    ), seeds as (
      select distinct candidate_ids.result_id, me.id, me.session_id, me.captured_at
      from candidate_ids
      join memory_events me on me.id = candidate_ids.id
      left join sessions s on s.id = me.session_id
      where ${authorized}
    ), context_ids as (
      select seeds.result_id, seeds.id as matched_source_id, neighbors.*
      from seeds
      left join lateral (
        select adjacent.id from memory_events adjacent
        where adjacent.session_id=seeds.session_id
          and (adjacent.captured_at,adjacent.id)<(seeds.captured_at,seeds.id)
        order by adjacent.captured_at desc,adjacent.id desc limit 1
      ) preceding on true
      left join lateral (
        select adjacent.id from memory_events adjacent
        where adjacent.session_id=seeds.session_id
          and (adjacent.captured_at,adjacent.id)>(seeds.captured_at,seeds.id)
        order by adjacent.captured_at,adjacent.id limit 1
      ) following on true
      cross join lateral (values
        (seeds.id, 'matched'), (preceding.id, 'preceding'),
        (following.id, 'following')
      ) neighbors(id, context_role)
    )
    select me.id, me.owner_user_id, me.visibility, me.session_id, me.turn_id,
      me.payload, me.captured_at, me.source_event_time,
      context_ids.result_id, context_ids.matched_source_id, context_ids.context_role
    from context_ids
    join memory_events me on me.id = context_ids.id
    left join sessions s on s.id = me.session_id
    where ${authorized}
    order by me.session_id, me.captured_at, me.id, context_ids.result_id`,
    [
      JSON.stringify(hits),
      input.userId,
      input.sourceAfter,
      input.sourceBefore,
      JSON.stringify(selection)
    ]
  );
  const hydrated = new Map<string, RetrievalContextEvent>();
  const groups = new Map<string, Map<string, LcmSourceItem>>();
  for (const row of result.rows) {
    let event = hydrated.get(row.id);
    if (!event) {
      event = await hydrate(row);
      hydrated.set(row.id, event);
    }
    // Never fall back to an embedding fragment or encrypted placeholder.
    if (!event.payload.content?.trim() || event.payload.contentEncrypted) {
      continue;
    }
    const group = groups.get(row.result_id) ?? new Map<string, LcmSourceItem>();
    const existing = group.get(row.id);
    const matchedSourceIds = new Set<string>(
      (existing?.provenance?.matchedSourceIds as string[] | undefined) ?? []
    );
    matchedSourceIds.add(row.matched_source_id);
    group.set(row.id, {
      kind: "memory_event",
      sourceTable: "memory_events",
      sourceId: row.id,
      visibility: event.visibility,
      actor: event.payload.actor,
      turnId: event.turn_id,
      text: event.payload.content,
      createdAt: event.captured_at.toISOString(),
      capturedAt: event.captured_at.toISOString(),
      occurredAt: (event.source_event_time ?? event.captured_at).toISOString(),
      payload: { sessionId: event.session_id },
      provenance: {
        contextRole:
          row.context_role === "matched" ||
          existing?.provenance?.contextRole === "matched"
            ? "matched"
            : row.context_role,
        matchedSourceIds: [...matchedSourceIds]
      },
      position: existing?.position ?? group.size
    });
    groups.set(row.result_id, group);
  }
  return new Map([...groups].map(([id, group]) => [id, [...group.values()]]));
}
