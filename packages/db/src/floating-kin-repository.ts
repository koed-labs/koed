import type {
  FloatingKinActivity,
  FloatingKinEvidenceRequest
} from "@koed-labs/shared";
import {
  aiClientSourceAdapterRegistry,
  floatingKinEvidenceLimit
} from "@koed-labs/shared";
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
// Leave room for sealed rows that yield no message without unbounded hydration.
const sealedCandidateScanLimit = 4 * floatingKinEvidenceLimit;
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

// Claude Code child agents write their own transcripts into the same session.
// Only the main transcript speaks for the User's request and the main turn.
const floatingKinMainTranscriptSql = `(ci.source_kind <> 'claude-code' or (
  starts_with(ci.external_item_id, 'main:')
  and coalesce(ci.metadata->>'sourceComponentId', 'main')='main'
))`;

const floatingKinRecentItemSql = `
  ci.event_time > now() - interval '30 minutes'
  and ci.observed_at > now() - interval '30 minutes'
  and ${conversationMessageSql}
  and not (coalesce(ci.metadata->'encryptedConversationItemColumns', '[]'::jsonb) ? 'metadata')
  and ci.metadata->>'encryptedSourceColumn' is distinct from 'metadata'
`;

// Guess whether a Codex or Claude Code turn is underway from its latest
// captured signal. Pi is left out: only its extension's live report counts.
// Turn-end markers come from transcripts (Codex task_complete) and hooks
// (Claude Code turn_completed). Codex doesn't always record task_complete, so
// an assistant reply that has been quiet for a while also counts as finished.
// Work with no end marker counts as active only while it is fresh; otherwise
// the turn is unknown and the chip falls back to its capture age. Claude child
// agents run inside the main turn, so their events never reopen it.
export const floatingKinTurnQuietSeconds = 30;
export const floatingKinTurnActiveMinutes = 10;
const floatingKinTurnSql = (owner: string) => `
  select case
    when sig.kind='end' then 'idle'
    when sig.kind='reply'
      and sig.event_time <= now() - interval '${floatingKinTurnQuietSeconds} seconds' then 'idle'
    when sig.event_time > now() - interval '${floatingKinTurnActiveMinutes} minutes' then 'active'
  end turn
  from (
    select ci.event_time, case
      when ci.source_event_type in ('task_complete','turn_aborted','turn_completed')
        or ci.metadata->>'semanticControl'='turn_completed' then 'end'
      when ci.source_event_type in ('agent_message','assistant_message')
        or (ci.metadata->>'canonicalConversationItemKind'='message'
          and ci.metadata->>'canonicalConversationItemActor' in ('agent','assistant')
          and coalesce(ci.raw_json->'payload'->>'role', 'assistant') <> 'user') then 'reply'
      else 'work'
    end kind
    from conversation_items ci
    where ci.session_id=recent.session_id and ci.owner_user_id=${owner}
      and ci.visibility='personal' and ci.import_observed_at is null
      and ci.personal_deleted_at is null and ci.memory_excluded_at is null
      and ci.event_time is not null and ci.event_time <= now()
      and ci.event_time > now() - interval '30 minutes'
      and not (coalesce(ci.metadata->'encryptedConversationItemColumns', '[]'::jsonb) ? 'metadata')
      and ci.metadata->>'encryptedSourceColumn' is distinct from 'metadata'
      and (ci.source_kind <> 'claude-code' or (
        coalesce(ci.metadata->>'sourceComponentId', 'main')='main'
        and ci.raw_json->>'parentAgentId' is null
        and ci.raw_json->>'parentToolUseId' is null
      ))
      and (
        ci.source_event_type in ('task_complete','turn_aborted','turn_completed','task_started',
          'user_message','agent_message','assistant_message','tool_call','tool_result','agent_reasoning',
          -- Codex native response items and tool events.
          'reasoning','function_call','function_call_output','custom_tool_call',
          'custom_tool_call_output','local_shell_call','web_search_call',
          'exec_command_begin','exec_command_end','patch_apply_begin','patch_apply_end',
          'mcp_tool_call_begin','mcp_tool_call_end')
        or ci.metadata->>'semanticControl'='turn_completed'
        or ci.metadata->>'canonicalConversationItemKind' in
          ('message','tool_call','tool_result','reasoning','reasoning_summary')
      )
    order by ci.event_time desc, ci.source_sequence desc nulls last, ci.id desc
    limit 1
  ) sig
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
    turn: "active" | "idle" | null;
  }>(
    `with latest as (
    select s.id session_id, max(ci.event_time) activity_at
    from conversation_items ci join sessions s on s.id=ci.session_id
    where ${floatingKinLiveItemSql("$1", "$2", "$3")}
      and ${floatingKinRecentItemSql}
    group by s.id
  ), recent as (
    select *, count(*) over () total from latest
    order by activity_at desc, session_id limit $4
  )
  select recent.*, project.project_id,
    case when s.source_runtime::text <> 'pi' then turn.turn end turn,
    case when s.source_runtime='codex-cli' then 'codex' else s.source_runtime::text end client
  from recent join sessions s on s.id=recent.session_id
  cross join lateral (${floatingKinProjectLookupSql}) project
  left join lateral (${floatingKinTurnSql("$1")}) turn on true
  order by recent.activity_at desc, recent.session_id`,
    [actor.userId, floatingKinOwnerSelection(actor), adapters, displayLimit]
  );
  return {
    conversations: result.rows.map(
      ({ session_id, project_id, client, activity_at, turn }) => ({
        sessionId: session_id,
        projectId: project_id,
        client,
        lastActivityAt: activity_at.toISOString(),
        ...(turn ? { turn } : {})
      })
    ),
    overflowCount: Math.max(
      0,
      Number(result.rows[0]?.total ?? 0) - displayLimit
    )
  };
};

const projectionProject = (
  alias: "ci" | "approval_item" | "target",
  normalize = false
) => {
  const explicit = `nullif(${alias}.metadata->>'projectId', ${alias}.session_id::text)`;
  return `coalesce(${normalize ? `nullif(${explicit}, case when s.cwd is not null then 'conversation-projection' end)` : explicit},
    s.project_override_id, s.automatic_project_id, s.metadata->>'projectId', s.cwd, 'unknown-project')`;
};
const projectionTurn = (alias: "ci" | "approval_item" | "target") =>
  `coalesce(${alias}.turn_id::text, ${alias}.external_turn_id, 'turnless')`;

export const readFloatingKinRawRows = <Row extends pg.QueryResultRow>(
  pool: pg.Pool,
  actor: ActorContext,
  sessionId: string,
  {
    evidenceIds,
    initiatingFor,
    preview = false
  }: {
    evidenceIds?: string[];
    initiatingFor?: string;
    preview?: boolean;
  } = {}
) =>
  pool.query<Row>(
    `select ci.*, s.metadata session_metadata,
      ${projectionProject("ci")} as evidence_project,
      ${projectionTurn("ci")} as evidence_turn,
      (($6::uuid[] is not null or $8::boolean) and exists (
        select 1 from memory_event_sources ref join memory_events me on me.id=ref.memory_event_id
        where ref.conversation_item_id=ci.id and ref.source_role='derived_from'
          and me.owner_user_id=ci.owner_user_id and me.session_id=ci.session_id
          and me.visibility=ci.visibility and me.event_type='captured' and me.seal_reason is not null
      )) as has_sealed_projection,
      exists (
      select 1 from conversation_items approval_item
      where approval_item.session_id=s.id and approval_item.owner_user_id=$1
        and approval_item.visibility='personal' and approval_item.projection_work_class=ci.projection_work_class
        and approval_item.source_kind=ci.source_kind
        and approval_item.external_thread_id is not distinct from ci.external_thread_id
        and (${projectionProject("approval_item")}=${projectionProject("ci")}
          or ${projectionProject("approval_item", true)}=${projectionProject("ci", true)})
        and approval_item.memory_excluded_at is null and approval_item.personal_deleted_at is null
        and approval_item.import_observed_at is null and approval_item.transport_chunk_count=1
        and not ${approvalConversationItemSql("approval_item")}
        and coalesce(approval_item.metadata->>'managedConversation', 'false') <> 'true'
        and not (approval_item.metadata ? 'managedConversationSourceRole' or approval_item.metadata ? 'managedConversationReconciliation')
        and (
          ${projectionTurn("approval_item")}=${projectionTurn("ci")}
          or (${projectionTurn("approval_item")}='turnless'
            and coalesce(approval_item.event_time, approval_item.observed_at) >= ci.event_time)
        )
        and (
          (approval_item.source_kind='codex' and approval_item.source_adapter_version='codex-transcript-v1'
            and approval_item.source_transport='transcript' and approval_item.source_record_type='event_msg'
            and approval_item.source_event_type in ('task_complete','turn_aborted'))
          or ((approval_item.source_kind, approval_item.source_adapter_version) in (
              ('claude-code', 'claude-code-hook-signal-v1'), ('codex', 'codex-hook-signal-v1')
            ) and approval_item.source_transport='hook_signal' and approval_item.source_record_type='hook_signal'
            and approval_item.source_event_type='turn_completed')
          or (approval_item.source_kind='codex' and approval_item.source_adapter_version='codex-app-server-conversation-v1'
            and approval_item.source_transport='app_server' and approval_item.source_event_type='turn/completed')
        )
    ) as turn_closed
  from conversation_items ci join sessions s on s.id=ci.session_id
  where ${floatingKinLiveItemSql("$1", "$2", "$3")} and s.id=$4
    and ci.source_kind in ('claude-code','codex')
    and not (coalesce(ci.metadata->'encryptedConversationItemColumns', '[]'::jsonb) ? 'metadata')
    and ci.metadata->>'encryptedSourceColumn' is distinct from 'metadata'
    and (${conversationMessageSql} or (ci.source_kind='claude-code' and ci.source_record_type='session_message'))
    and ${floatingKinMainTranscriptSql}
    and (case when $7::uuid is not null then exists (
      select 1 from conversation_items target where target.id=$7
        and target.owner_user_id=ci.owner_user_id and target.session_id=ci.session_id
        and target.visibility=ci.visibility and target.projection_work_class=ci.projection_work_class
        and target.source_kind=ci.source_kind and target.source_adapter_version=ci.source_adapter_version
        and target.external_thread_id is not distinct from ci.external_thread_id
        and ${projectionProject("target")}=${projectionProject("ci")}
        and ${projectionTurn("target")}=${projectionTurn("ci")}
        and (
          (ci.source_kind='claude-code' and starts_with(ci.external_item_id, 'main:' || target.external_turn_id || ':'))
          or (ci.source_kind='codex' and ci.source_sequence < target.source_sequence and ci.event_time <= target.event_time
            and (ci.source_event_type='user_message' or (ci.source_event_type='message'
              and (ci.metadata->>'canonicalConversationItemActor'='user' or ci.raw_json->'payload'->>'role'='user'))))
        )
    ) when $6::uuid[] is not null then ci.id=any($6::uuid[])
    else ci.event_time > now() - interval '30 minutes' end)
  order by ci.event_time desc, ci.source_sequence desc nulls last, ci.id
  limit $5`,
    [
      actor.userId,
      floatingKinOwnerSelection(actor),
      adapters,
      sessionId,
      floatingKinEvidenceLimit + 1,
      evidenceIds ?? null,
      initiatingFor ?? null,
      preview
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

export const readFloatingKinPreviewHeader = async (
  pool: pg.Pool,
  actor: ActorContext,
  sessionId: string
) => {
  const { rows } = await pool.query<{
    title: string | null;
    project_name: string | null;
  }>(
    `select case when jsonb_typeof(s.metadata->'threadName')='string'
      then s.metadata->>'threadName' end title,
      (select case when count(*)=1 then min(p.name) end
       from personal_named_projects p where ${personalSessionProjectMembershipSql("s", "p")}) project_name
    from sessions s where s.id=$4 and exists (
      select 1 from conversation_items ci where ci.session_id=s.id
        and ${floatingKinLiveItemSql("$1", "$2", "$3")}
        and ${floatingKinRecentItemSql}
    )`,
    [actor.userId, floatingKinOwnerSelection(actor), adapters, sessionId]
  );
  return rows[0];
};

export const readFloatingKinProjectedPreview = async (
  pool: pg.Pool,
  actor: ActorContext,
  sessionId: string
) => {
  const { rows } = await pool.query<{
    id: string;
    role: "user" | "assistant";
    content: string;
    event_time: Date;
  }>(
    `select latest.* from (values ('user'), ('assistant')) roles(role)
    cross join lateral (
      select m.id, m.role, m.content, ci.event_time
      from conversation_items ci join sessions s on s.id=ci.session_id
      join messages m on m.session_id=s.id and m.owner_user_id=ci.owner_user_id
        and m.visibility=ci.visibility
        and m.idempotency_key='message:' || case
          when jsonb_typeof(ci.metadata->'canonicalConversationItemKey')='string'
            and ci.metadata->>'canonicalConversationItemKey' ~ '[^[:space:]]'
          then ci.metadata->>'canonicalConversationItemKey' else ci.canonical_item_key end
        and m.source_hash='message:' || ci.source_hash and m.source_event_time=ci.event_time
      where s.id=$4 and ${floatingKinLiveItemSql("$1", "$2", "$3")}
        and ${floatingKinRecentItemSql} and ci.projection_status='projected'
        and ${floatingKinMainTranscriptSql}
        and m.role::text=roles.role and m.invalidated_at is null and m.recall_eligible
        and m.presentation_mode <> 'hidden' and m.presentation_renderer='message'
        and exists (
          select 1 from memory_event_sources source
          join memory_events me on me.id=source.memory_event_id
          where source.conversation_item_id=ci.id and source.source_role='derived_from'
            and me.session_id=s.id and me.owner_user_id=ci.owner_user_id and me.visibility=ci.visibility
            and me.event_type='captured' and me.seal_reason is not null and me.include_in_lcm
            and me.payload->'metadata'->'semanticItemManifest' @> jsonb_build_array(
              jsonb_build_object('sourceIds', jsonb_build_array(ci.id::text), 'includeInLcm', true)
            )
            and me.invalidated_at is null and me.personal_deleted_at is null and me.source_event_time <= now()
            and (${semanticMemoryEventEligibleSql("me")}) ${eligibleSealedLineageSql}
        )
      order by ci.event_time desc, ci.source_sequence desc nulls last, ci.id, m.id limit 1
    ) latest`,
    [actor.userId, floatingKinOwnerSelection(actor), adapters, sessionId]
  );
  return rows;
};

export const readFloatingKinSealedRows = <Row extends pg.QueryResultRow>(
  pool: pg.Pool,
  actor: ActorContext,
  input: FloatingKinEvidenceRequest,
  rawId?: string
) =>
  pool.query<Row>(
    `with anchor as (
  select caller.id,
    (select case when count(*)=1 then min(p.project_id::text) end
      from personal_named_projects p where ${personalSessionProjectMembershipSql("caller", "p")}) project_id
  from sessions caller where caller.id=$3
    and ${personalSourceSelectionSql("caller", "$2")} and ${regularConversationSql("caller")}
  )
  select me.*, (select count(*)::int from memory_event_sources ref
    where ref.memory_event_id=me.id and ref.source_role='derived_from'
      and ref.conversation_item_id=$8::uuid) as matching_raw_count
  from anchor cross join memory_events me join sessions s on s.id=me.session_id
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
    and (case when $8::uuid is not null then exists (
      select 1 from memory_event_sources ref where ref.memory_event_id=me.id
        and ref.source_role='derived_from' and ref.conversation_item_id=$8::uuid
    ) when $7::uuid[] is not null then me.id=any($7::uuid[])
    else true end)
  order by me.source_event_time desc, me.id limit $5`,
    [
      actor.userId,
      floatingKinOwnerSelection(actor),
      input.sessionId,
      input.action,
      rawId
        ? 2
        : input.evidenceIds
          ? floatingKinEvidenceLimit + 1
          : sealedCandidateScanLimit,
      input.action === "project" ? input.projectId : null,
      input.evidenceIds ?? null,
      rawId ?? null
    ]
  );
