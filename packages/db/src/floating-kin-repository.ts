import type {
  FloatingKinActivity,
  FloatingKinSummaryRequest
} from "@koed-labs/shared";
import { aiClientSourceAdapterRegistry } from "@koed-labs/shared";
import type pg from "pg";
import {
  approvalConversationItemSql,
  semanticMemoryEventEligibleSql
} from "./approval-activity-sql.js";
import {
  personalSessionProjectMembershipSql,
  personalSourceSelectionSql
} from "./personal-selection-sql.js";
import type { ActorContext } from "./types.js";

const displayLimit = 5;
export const floatingKinEvidenceLimit = 32;
const adapters = JSON.stringify(aiClientSourceAdapterRegistry);
const conversationMessageSql = `(
  ci.source_event_type in ('user_message','agent_message','assistant_message')
  or (ci.source_kind='codex' and ci.source_record_type='response_item'
    and ci.source_event_type='message' and (
      ci.metadata->>'canonicalConversationItemActor' in ('user','agent','assistant')
      or ci.raw_json->'payload'->>'role' in ('user','assistant')
    ))
)`;
const regularConversationSql = (s: "s" | "caller") => `
  (${s}.capture_method='transcript'
    or (${s}.capture_method='api' and ${s}.source_runtime in ('claude-code','codex-cli','pi')))
  and coalesce(${s}.metadata->>'managedConversation', 'false') <> 'true'
  and coalesce(${s}.metadata->>'approvalReview', 'false') <> 'true'
  and coalesce(${s}.metadata->>'approvalHelperConversation', 'false') <> 'true'
`;
const floatingKinLiveItemSql = (
  owner: string,
  selection: string,
  registry: string
) => `
  ci.owner_user_id=${owner} and ci.visibility='personal'
  and ${personalSourceSelectionSql("s", selection)}
  and ${regularConversationSql("s")} and s.import_observed_at is null
  and ci.projection_work_class='live_capture_projection'
  and ci.import_observed_at is null and ci.source_transport='transcript'
  and ci.event_time is not null and ci.event_time <= now()
  and ci.transport_chunk_count=1
  and ci.personal_deleted_at is null and ci.memory_excluded_at is null
  and ci.projection_status in ('pending','projected')
  and not ${approvalConversationItemSql("ci")}
  and coalesce(ci.metadata->>'managedConversation', 'false') <> 'true'
  and not (ci.metadata ? 'managedConversationSourceRole' or ci.metadata ? 'managedConversationReconciliation')
  and exists (select 1 from jsonb_array_elements(${registry}::jsonb) a
    where a->>'sourceKind'=ci.source_kind and a->>'sourceAdapterVersion'=ci.source_adapter_version
      and a->>'sourceRuntime'=s.source_runtime::text)
`;

export const floatingKinOwnerSelection = (actor: ActorContext) =>
  JSON.stringify({ ownerUserId: actor.userId, searchDomain: "global" });

export const floatingKinProjectLookupSql = `
  select case when count(*)=1 then min(p.project_id::text) end project_id
  from personal_named_projects p where ${personalSessionProjectMembershipSql("s", "p")}
`;

export const getFloatingKinActivity = async (
  pool: pg.Pool,
  actor: ActorContext
): Promise<FloatingKinActivity> => {
  const result = await pool.query<{
    session_id: string;
    project_id: string | null;
    client: FloatingKinActivity["conversations"][number]["client"];
    activity_at: Date;
    total: string;
  }>(
    `with latest as (
    select s.id session_id, max(ci.event_time) activity_at
    from conversation_items ci join sessions s on s.id=ci.session_id
    where ${floatingKinLiveItemSql("$1", "$2", "$3")}
      and ci.event_time > now() - interval '30 minutes'
      and ci.observed_at > now() - interval '30 minutes'
      and ${conversationMessageSql}
      and not (coalesce(ci.metadata->'encryptedConversationItemColumns', '[]'::jsonb) ? 'metadata')
      and ci.metadata->>'encryptedSourceColumn' is distinct from 'metadata'
    group by s.id
  ), recent as (
    select *, count(*) over () total from latest
    order by activity_at desc, session_id limit $4
  )
  select recent.*, project.project_id,
    case when s.source_runtime='codex-cli' then 'codex' else s.source_runtime::text end client
  from recent join sessions s on s.id=recent.session_id
  cross join lateral (${floatingKinProjectLookupSql}) project
  order by recent.activity_at desc, recent.session_id`,
    [actor.userId, floatingKinOwnerSelection(actor), adapters, displayLimit]
  );
  return {
    conversations: result.rows.map(
      ({ session_id, project_id, client, activity_at }) => ({
        sessionId: session_id,
        projectId: project_id,
        client,
        lastActivityAt: activity_at.toISOString()
      })
    ),
    overflowCount: Math.max(
      0,
      Number(result.rows[0]?.total ?? 0) - displayLimit
    )
  };
};

export const readFloatingKinRawRows = <Row extends pg.QueryResultRow>(
  pool: pg.Pool,
  actor: ActorContext,
  sessionId: string
) =>
  pool.query<Row>(
    `select ci.*, s.metadata session_metadata, exists (
      select 1 from conversation_items control
      where control.session_id=s.id and control.owner_user_id=$1
        and control.visibility='personal' and control.projection_work_class='live_capture_projection'
        and control.source_kind=ci.source_kind and control.source_adapter_version=ci.source_adapter_version
        and (control.external_turn_id is null or control.external_turn_id=ci.external_turn_id)
        and (control.event_time is null or control.event_time >= ci.event_time)
        and (control.source_event_type in ('turn_completed','turn/completed','task_complete','turn_aborted','pds_turn_completed','pds_session_closed')
          or control.metadata->>'semanticControl'='turn_completed')
    ) as turn_closed
  from conversation_items ci join sessions s on s.id=ci.session_id
  where ${floatingKinLiveItemSql("$1", "$2", "$3")} and s.id=$4
    and ${conversationMessageSql}
    and ci.event_time > now() - interval '30 minutes'
  order by ci.event_time desc, ci.source_sequence desc nulls last, ci.id
  limit $5`,
    [
      actor.userId,
      floatingKinOwnerSelection(actor),
      adapters,
      sessionId,
      floatingKinEvidenceLimit + 1
    ]
  );

const eligibleSealedLineageSql = `
  and exists (select 1 from memory_event_sources ref where ref.memory_event_id=me.id)
  and not exists (
    select 1 from memory_event_sources ref
    left join conversation_items ci on ci.id=ref.conversation_item_id
    where ref.memory_event_id=me.id and not coalesce((
      ci.owner_user_id=me.owner_user_id and ci.session_id=me.session_id
      and ci.visibility='personal' and ci.personal_deleted_at is null and ci.memory_excluded_at is null
      and coalesce(ci.metadata->>'managedConversation', 'false') <> 'true'
      and not (ci.metadata ? 'managedConversationSourceRole' or ci.metadata ? 'managedConversationReconciliation')
      and not (coalesce(ci.metadata->'encryptedConversationItemColumns', '[]'::jsonb) ? 'metadata')
      and ci.metadata->>'encryptedSourceColumn' is distinct from 'metadata'
    ), false)
  )`;

export const readFloatingKinSealedRows = <Row extends pg.QueryResultRow>(
  pool: pg.Pool,
  actor: ActorContext,
  input: FloatingKinSummaryRequest
) =>
  pool.query<Row>(
    `with anchor as (
  select caller.id,
    (select case when count(*)=1 then min(p.project_id::text) end
      from personal_named_projects p where ${personalSessionProjectMembershipSql("caller", "p")}) project_id
  from sessions caller where caller.id=$3
    and ${personalSourceSelectionSql("caller", "$2")} and ${regularConversationSql("caller")}
  )
  select me.* from anchor cross join memory_events me join sessions s on s.id=me.session_id
  where me.owner_user_id=$1 and me.visibility='personal' and me.event_type='captured'
    and me.invalidated_at is null and me.personal_deleted_at is null
    and me.include_in_lcm and me.seal_reason is not null and me.source_event_time <= now()
    and ${personalSourceSelectionSql("s", "$2")} and ${regularConversationSql("s")}
    and (${semanticMemoryEventEligibleSql("me")}) ${eligibleSealedLineageSql}
    and (case when $4='conversation' then s.id=anchor.id else exists (
      select 1 from personal_named_projects p where p.project_id::text=anchor.project_id
      and anchor.project_id=$6::text
      and ${personalSessionProjectMembershipSql("s", "p")}
    ) end)
  order by me.source_event_time desc, me.id limit $5`,
    [
      actor.userId,
      floatingKinOwnerSelection(actor),
      input.sessionId,
      input.action,
      floatingKinEvidenceLimit + 1,
      input.action === "project" ? input.projectId : null
    ]
  );
