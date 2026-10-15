import type pg from "pg";
import type {
  EnvelopeEncryptionProvider,
  EncryptedPayloadEnvelope,
  HomeItem,
  HomeSource
} from "@koed/shared";
import {
  decryptEnvelopeToUtf8,
  personalAgentExecutionContextSchema
} from "@koed/shared";
import { createPersonalAgentRepository } from "./personal-agent-repository.js";

export interface HomeReminderState {
  ownerUserId: string;
  sourceEventId: string;
  source: HomeSource;
  sourceId: string;
  sourceRevision: string;
  cleared: boolean;
  updatedAt: string;
}

export interface HomeRepository {
  listReminderStates(
    ownerUserId: string,
    sourceEventIds?: string[]
  ): Promise<HomeReminderState[]>;
  listSourcePage(input: {
    ownerUserId: string;
    source: HomeSource;
    cursor?: string | null;
    limit: number;
  }): Promise<{
    items: HomeItem[];
    complete: boolean;
    nextCursor: string | null;
  }>;
  countNeedsYou(ownerUserId: string): Promise<number>;
  setReminderState(input: {
    ownerUserId: string;
    sourceEventId: string;
    source: HomeSource;
    sourceId: string;
    sourceRevision: string;
    cleared: boolean;
  }): Promise<HomeReminderState>;
}

interface HomeReminderStateRow {
  owner_user_id: string;
  source_event_id: string;
  source_kind: HomeSource;
  source_id: string;
  source_revision: string;
  cleared: boolean;
  updated_at: Date;
}

const mapState = (row: HomeReminderStateRow): HomeReminderState => ({
  ownerUserId: row.owner_user_id,
  sourceEventId: row.source_event_id,
  source: row.source_kind,
  sourceId: row.source_id,
  sourceRevision: row.source_revision,
  cleared: row.cleared,
  updatedAt: row.updated_at.toISOString()
});

/**
 * Native Personal Agent and owner-assigned Team activity. Revision inputs are
 * semantic producer state only: delivery/command status and error identity,
 * current execution generation, and explicit Team outcome binding. In
 * particular, lease heartbeats, progress text, and Home wording do not revise
 * a reminder.
 */
const nativeHomeEventsSql = `
  select d.id as native_id,
         'delivery:'||d.id::text as event_id,
         'delivery'::text as variant,
         d.status as native_status,
         case when d.status in ('failed','uncertain') then 'blocked'
              when d.status in ('queued','starting','running') then 'ongoing'
              else 'recent' end as item_state,
         case when d.status in ('failed','uncertain') then 0
              when d.status in ('queued','starting','running') then 1 else 2 end as priority,
         'n'||md5(json_build_array(
           'delivery',d.id,d.status,d.error_code,d.execution_id,d.command_id,
           e.execution_generation,
           c.execution_generation,c.command_kind,c.state,c.last_error_code
         )::text) as source_revision,
         d.conversation_id as destination_id,
         d.execution_id,
         d.command_id,
         c.execution_generation as command_generation,
         c.state as command_state,
         d.agent_name,
         d.recipient_kind,
         e.provider,
         root.title as root_title,
         case
           when d.status in ('starting','running') then coalesce(d.started_at,d.created_at)
           when d.status in ('completed','canceled') then coalesce(d.completed_at,d.updated_at,d.created_at)
           when d.status in ('failed','uncertain') then coalesce(c.completed_at,d.started_at,d.created_at)
           else d.created_at
         end as updated_at,
         exists (
           select 1
             from managed_conversation_executions old_e
             join managed_conversation_commands old_c
               on old_c.id=d.command_id and old_c.execution_id=old_e.id
              and old_c.owner_user_id=old_e.owner_user_id
             join home_reminder_states old_h
               on old_h.owner_user_id=old_e.owner_user_id
              and old_h.source_event_id='execution:'||old_e.id::text
              and old_h.source_kind='managed_execution'
              and old_h.source_id=old_e.id::text
              and old_h.source_revision='v'||old_e.state_version::text
              and old_h.cleared
            where old_e.owner_user_id=d.owner_user_id
              and old_e.id=d.execution_id
              and old_e.state in ('failed','fenced')
              and old_e.execution_generation=old_c.execution_generation
              and old_e.execution_generation=coalesce(e.execution_generation,-1)
              and old_c.state in ('failed','indeterminate')
              and d.status='failed'
              and not exists (
                select 1 from home_reminder_states canonical
                 where canonical.owner_user_id=d.owner_user_id
                   and canonical.source_event_id='delivery:'||d.id::text
              )
         ) as legacy_alias_cleared
    from personal_agent_chat_deliveries d
    join personal_agent_chat_roots root
      on root.conversation_id=d.conversation_id and root.owner_user_id=d.owner_user_id
    join personal_agent_conversations conversation
      on conversation.conversation_id=d.conversation_id and conversation.owner_user_id=d.owner_user_id
    left join managed_conversation_executions e
      on e.id=d.execution_id and e.owner_user_id=d.owner_user_id
    left join managed_conversation_commands c
      on c.id=d.command_id and c.execution_id=d.execution_id and c.owner_user_id=d.owner_user_id
   where d.owner_user_id=$1
     and d.status in ('queued','starting','running','failed','uncertain','completed','canceled')
     and not exists (
       select 1 from personal_agent_execution_jobs legacy_job
        where legacy_job.id=d.job_id and legacy_job.owner_user_id=d.owner_user_id
     )

  union all

  select r.id as native_id,
         'team-request:'||r.id::text as event_id,
         'team_request'::text as variant,
         native.status as native_status,
         case when native.status in ('failed','unknown') then 'blocked'
              when native.status in ('queued','running') then 'ongoing'
              when r.outcome_message_id is null then 'review'
              else 'recent' end as item_state,
         case when native.status in ('failed','unknown') then 0
              when native.status in ('queued','running') then 1
              else 2 end as priority,
         'n'||md5(json_build_array(
           'team-request',r.id,r.status,r.managed_execution_id,r.managed_command_id,
           native.status,r.outcome_message_id,c.execution_generation,c.state
         )::text) as source_revision,
         r.managed_execution_id as destination_id,
         r.managed_execution_id as execution_id,
         r.managed_command_id as command_id,
         c.execution_generation as command_generation,
         c.state as command_state,
         r.agent_name,
         'agent'::text as recipient_kind,
         e.provider,
         null::text as root_title,
         case
           when native.status in ('queued','running') then coalesce(e.started_at,r.created_at)
           when native.status in ('succeeded','canceled','interrupted') then coalesce(e.stopped_at,c.completed_at,r.updated_at,r.created_at)
           else coalesce(e.started_at,r.created_at)
         end as updated_at,
         false as legacy_alias_cleared
    from team_agent_requests r
    join managed_conversation_executions e
      on e.id=r.managed_execution_id and e.owner_user_id=r.owner_user_id
    join managed_conversation_commands c
      on c.id=r.managed_command_id and c.execution_id=e.id and c.owner_user_id=r.owner_user_id
    join team_memberships membership
      on membership.team_id=r.team_id and membership.user_id=r.owner_user_id
     and membership.status='enabled' and membership.disabled_at is null
    join teams team on team.id=r.team_id and team.archived_at is null
    join team_agent_offers offer
      on offer.team_id=r.team_id and offer.owner_user_id=r.owner_user_id
     and offer.agent_id=r.agent_id and offer.enabled
    join collaboration_team_shared_projects project
      on project.id=r.team_project_id and project.team_id=r.team_id
     and project.unshared_at is null
    join collaboration_threads thread
      on thread.id=r.channel_id and thread.team_id=r.team_id
     and thread.scope='team' and thread.lifecycle='active'
     and (
       thread.kind='team_channel'
       or (thread.kind='team_project_channel' and thread.team_project_id=r.team_project_id)
       or (thread.kind in ('dm','group_dm')
           and team.lifecycle='active'
           and team.entitlement_status in ('active','grace')
           and exists (
             select 1 from collaboration_participants owner_participant
               join team_memberships owner_membership
                 on owner_membership.team_id=owner_participant.team_id
                and owner_membership.user_id=owner_participant.user_id
               join users owner_user on owner_user.id=owner_participant.user_id
              where owner_participant.thread_id=thread.id
                and owner_participant.user_id=r.owner_user_id
                and owner_membership.status='enabled'
                and owner_membership.disabled_at is null
                and owner_user.disabled_at is null and owner_user.deleted_at is null
           ) and exists (
             select 1 from collaboration_participants requester_participant
               join team_memberships requester_membership
                 on requester_membership.team_id=requester_participant.team_id
                and requester_membership.user_id=requester_participant.user_id
               join users requester_user on requester_user.id=requester_participant.user_id
              where requester_participant.thread_id=thread.id
                and requester_participant.user_id=r.requester_user_id
                and requester_membership.status='enabled'
                and requester_membership.disabled_at is null
                and requester_user.disabled_at is null
                and requester_user.deleted_at is null
           ))
     )
    cross join lateral (
      select coalesce(
        r.native_status_frozen,
        team_agent_request_native_execution_status(
          r.managed_execution_id,r.managed_command_id,r.owner_user_id
        )
      ) as status
    ) native
   where r.owner_user_id=$1 and r.status='accepted'
     and r.managed_execution_id is not null and r.managed_command_id is not null
     and native.status <> 'waiting'
     and not exists (
       select 1 from managed_conversation_runtime_items runtime_item
        where runtime_item.execution_id=e.id and runtime_item.owner_user_id=e.owner_user_id
          and runtime_item.execution_generation=e.execution_generation
          and runtime_item.state='pending'
          and runtime_item.item_kind in ('command_approval','file_approval','permissions_approval','user_input')
     )

  union all

  select command.id as native_id,
         'command:'||command.id::text as event_id,
         'command'::text as variant,
         command.state as native_status,
         'blocked'::text as item_state,
         0 as priority,
         'n'||md5(json_build_array(
           'command',command.id,command.command_kind,command.state,
           command.last_error_code,e.id,e.execution_generation
         )::text) as source_revision,
         e.id as destination_id,
         e.id as execution_id,
         command.id as command_id,
         command.execution_generation as command_generation,
         command.state as command_state,
         null::text as agent_name,
         'generic'::text as recipient_kind,
         e.provider,
         null::text as root_title,
         coalesce(command.completed_at,command.created_at) as updated_at,
         false as legacy_alias_cleared
    from managed_conversation_executions e
    join lateral (
      select candidate.id,candidate.command_kind,candidate.state,
             candidate.last_error_code,candidate.execution_generation,
             candidate.completed_at,candidate.updated_at,candidate.created_at
        from managed_conversation_commands candidate
       where candidate.owner_user_id=e.owner_user_id
         and candidate.execution_id=e.id
         and candidate.execution_generation=e.execution_generation
       order by candidate.sequence desc
       limit 1
    ) command on true
   where e.owner_user_id=$1
     and e.state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping')
     and command.command_kind in ('start','prompt')
     and command.state in ('failed','indeterminate')
     and not exists (
       select 1
         from personal_agent_chat_deliveries delivery
         join personal_agent_chat_roots root
           on root.conversation_id=delivery.conversation_id
          and root.owner_user_id=delivery.owner_user_id
         join personal_agent_conversations conversation
           on conversation.conversation_id=delivery.conversation_id
          and conversation.owner_user_id=delivery.owner_user_id
        where delivery.owner_user_id=e.owner_user_id
          and delivery.execution_id=e.id
          and delivery.command_id=command.id
          and delivery.status in ('queued','starting','running','failed','uncertain','completed','canceled')
          and not exists (
            select 1 from personal_agent_execution_jobs legacy_job
             where legacy_job.id=delivery.job_id
               and legacy_job.owner_user_id=delivery.owner_user_id
          )
     )
     and not exists (
       select 1
         from team_agent_requests request
         join team_memberships membership
           on membership.team_id=request.team_id and membership.user_id=request.owner_user_id
          and membership.status='enabled' and membership.disabled_at is null
         join teams team on team.id=request.team_id and team.archived_at is null
         join team_agent_offers offer
           on offer.team_id=request.team_id and offer.owner_user_id=request.owner_user_id
          and offer.agent_id=request.agent_id and offer.enabled
         join collaboration_team_shared_projects project
           on project.id=request.team_project_id and project.team_id=request.team_id
          and project.unshared_at is null
         join collaboration_threads thread
           on thread.id=request.channel_id and thread.team_id=request.team_id
          and thread.kind='team_project_channel' and thread.lifecycle='active'
          and thread.team_project_id=request.team_project_id
         join managed_conversation_executions request_execution
           on request_execution.id=request.managed_execution_id
          and request_execution.owner_user_id=request.owner_user_id
         join managed_conversation_commands request_command
           on request_command.id=request.managed_command_id
          and request_command.execution_id=request_execution.id
          and request_command.owner_user_id=request.owner_user_id
        cross join lateral (
          select coalesce(
            request.native_status_frozen,
            team_agent_request_native_execution_status(
              request.managed_execution_id,request.managed_command_id,request.owner_user_id
            )
          ) as status
        ) request_native
        where request.owner_user_id=e.owner_user_id
          and request.status='accepted'
          and request.managed_execution_id=e.id
          and request.managed_command_id=command.id
          and request_native.status <> 'waiting'
          and not exists (
            select 1 from managed_conversation_runtime_items runtime_item
             where runtime_item.execution_id=request_execution.id
               and runtime_item.owner_user_id=request_execution.owner_user_id
               and runtime_item.execution_generation=request_execution.execution_generation
               and runtime_item.state='pending'
               and runtime_item.item_kind in ('command_approval','file_approval','permissions_approval','user_input')
          )
     )
     and not exists (
       select 1 from personal_agent_chat_deliveries skipped
        where skipped.owner_user_id=e.owner_user_id
          and skipped.execution_id=e.id
          and skipped.command_id=command.id
          and skipped.status='skipped'
     )
     and not exists (
       select 1
         from pull_request_review_drafts draft
         join pull_request_reviews review
           on review.id=draft.review_id and review.owner_user_id=draft.owner_user_id
        where draft.owner_user_id=e.owner_user_id
          and draft.source_execution_id=e.id
          and draft.source_command_id=command.id
          and draft.execution_generation=e.execution_generation
          and review.status in ('draft','frozen','uncertain','failed')
     )
`;

const nativeExecutionFailureExclusionSql = `
  and not exists (
    select 1
      from (
        select command.id,command.state,command.last_error_code
          from managed_conversation_commands command
         where command.owner_user_id=e.owner_user_id
           and command.execution_id=e.id
           and command.execution_generation=e.execution_generation
         order by command.sequence desc
         limit 1
      ) latest_failure
     where latest_failure.state in ('failed','indeterminate')
       and e.last_error_code is not distinct from latest_failure.last_error_code
       and (
         exists (
           select 1 from (${nativeHomeEventsSql}) native_failure
            where native_failure.execution_id=e.id
              and native_failure.command_id=latest_failure.id
              and native_failure.command_generation=e.execution_generation
              and (
                (native_failure.variant='delivery'
                  and native_failure.native_status in ('failed','uncertain'))
                or
                (native_failure.variant='team_request'
                  and native_failure.native_status in ('failed','unknown'))
              )
         )
         or exists (
           select 1
             from personal_agent_chat_deliveries skipped
            where skipped.owner_user_id=e.owner_user_id
              and skipped.execution_id=e.id
              and skipped.command_id=latest_failure.id
              and skipped.status='skipped'
         )
       )
  )`;

export const createHomeRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider } = {}
): HomeRepository => {
  const countNeedsYou = async (ownerUserId: string): Promise<number> => {
    const result = await pool.query<{ badge_count: string }>(
      `select
        (select count(*) from managed_conversation_runtime_items r join managed_conversation_executions e on e.id=r.execution_id and e.owner_user_id=r.owner_user_id
          where r.owner_user_id=$1 and r.execution_generation=e.execution_generation and r.state='pending' and r.item_kind in ('command_approval','file_approval','permissions_approval','user_input')
            and e.state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping')
            and not exists (select 1 from home_reminder_states h where h.owner_user_id=$1 and h.source_event_id='runtime:'||r.id::text and h.source_kind='managed_runtime_item' and h.source_id=r.id::text and h.source_revision='r'||r.revision::text and h.cleared))
        + (select count(*) from managed_conversation_executions e where e.owner_user_id=$1 and e.state in ('failed','fenced')
            and not exists (select 1 from personal_agent_execution_jobs j join personal_agent_execution_attempts a on a.id=j.last_attempt_id and a.job_id=j.id and a.owner_user_id=j.owner_user_id where j.owner_user_id=e.owner_user_id and j.conversation_id=e.id and j.attribution_kind='agent' and j.agent_id is not null and j.state='failed' and a.attribution_kind='agent' and a.agent_id=j.agent_id and a.status='failed' and a.managed_execution_id=e.id and a.managed_execution_generation=e.execution_generation)
            ${nativeExecutionFailureExclusionSql}
            and not exists (select 1 from home_reminder_states h where h.owner_user_id=$1 and h.source_event_id='execution:'||e.id::text and h.source_kind='managed_execution' and h.source_id=e.id::text and h.source_revision='v'||e.state_version::text and h.cleared))
        + (select count(*) from personal_agent_execution_jobs j where j.owner_user_id=$1 and j.attribution_kind='agent' and j.agent_id is not null and j.state in ('succeeded','failed')
            and not exists (select 1 from home_reminder_states h where h.owner_user_id=$1 and h.source_event_id='job:'||j.id::text and h.source_kind='personal_agent_job' and h.source_id=j.id::text and h.source_revision='v'||j.version::text and h.cleared))
        + (select count(*) from pull_request_reviews p where p.owner_user_id=$1 and p.status in ('stale','draft','frozen','uncertain','failed')
            and not exists (select 1 from home_reminder_states h where h.owner_user_id=$1 and h.source_event_id='pr:'||p.id::text and h.source_kind='pull_request_review' and h.source_id=p.id::text and h.source_revision='v'||p.revision::text and h.cleared))
        + (select count(*) from pull_request_operations o join pull_request_reviews p on p.id=o.review_id and p.owner_user_id=o.owner_user_id
            where o.owner_user_id=$1 and o.kind='push' and o.state in ('uncertain','failed')
              and not exists (select 1 from home_reminder_states h where h.owner_user_id=$1 and h.source_event_id='pr-op:'||o.id::text and h.source_kind='pull_request_review' and h.source_id=o.id::text and h.source_revision='v'||p.revision::text||'.o'||o.revision::text and h.cleared))
        + (select count(*) from (${nativeHomeEventsSql}) native_event
            where native_event.item_state in ('blocked','review')
              and not native_event.legacy_alias_cleared
              and not exists (
                select 1 from home_reminder_states h
                 where h.owner_user_id=$1
                   and h.source_event_id=native_event.event_id
                   and h.source_kind='native_agent_activity'
                   and h.source_id=native_event.native_id::text
                   and h.source_revision=native_event.source_revision
                   and h.cleared
              )) as badge_count`,
      [ownerUserId]
    );
    return Number(result.rows[0]?.badge_count ?? 0);
  };

  const mapJobTitles = async (
    ownerUserId: string,
    rows: Array<{ id: string; agent_id: string; agent_version: number }>
  ) => {
    const labels = new Map<
      string,
      { title: string; agentName: string | null }
    >();
    if (!options.envelopeEncryptionProvider || rows.length === 0) return labels;
    const personalAgents = createPersonalAgentRepository(pool, {
      envelopeEncryptionProvider: options.envelopeEncryptionProvider
    });
    // Hydrate only selected IDs; scanning up to 100 rows per agent can decrypt
    // 10,000 unrelated jobs on one Home page.
    const [jobs, names] = await Promise.all([
      Promise.all(
        rows.map(
          async (row) =>
            [
              row.id,
              await personalAgents.getPersonalAgentExecutionJob(
                { userId: ownerUserId },
                row.id
              )
            ] as const
        )
      ),
      pool.query<{ agent_id: string; agent_version: number; name: string }>(
        `select v.agent_id,v.version as agent_version,v.name
           from personal_agent_identity_versions v
          where v.owner_user_id=$1 and (v.agent_id,v.version) in (
            select x.agent_id,x.agent_version from unnest($2::uuid[],$3::int[]) as x(agent_id,agent_version)
          )`,
        [
          ownerUserId,
          rows.map((row) => row.agent_id),
          rows.map((row) => row.agent_version)
        ]
      )
    ]);
    const agentNames = new Map(
      names.rows.map((row) => [
        `${row.agent_id}:${row.agent_version}`,
        row.name
      ])
    );
    for (const [id, job] of jobs)
      if (job) {
        const selected = rows.find((row) => row.id === id)!;
        labels.set(id, {
          title: job.title,
          agentName:
            agentNames.get(`${selected.agent_id}:${selected.agent_version}`) ??
            null
        });
      }
    return labels;
  };

  const mapHomeJob = (
    row: {
      id: string;
      conversation_id: string;
      agent_id: string;
      state: string;
      version: number;
      updated_at: Date;
    },
    labels: Map<string, { title: string; agentName: string | null }>
  ): HomeItem => {
    const label = labels.get(row.id);
    return {
      sourceEventId: `job:${row.id}`,
      source: "personal_agent_job",
      sourceId: row.id,
      sourceRevision: `v${row.version}`,
      kind: row.state === "succeeded" ? "job_review" : "intervention",
      state: row.state === "succeeded" ? "review" : "blocked",
      title:
        label?.title ??
        (row.state === "succeeded"
          ? "Completed Agent Job needs review"
          : "Agent Job failed"),
      summary: label?.agentName ?? null,
      updatedAt: row.updated_at.toISOString(),
      destination: { kind: "execution", executionId: row.conversation_id }
    };
  };

  const labelsForExecutions = async (
    ownerUserId: string,
    executionIds: string[]
  ) => {
    const empty = new Map<
      string,
      { title: string; agentName: string | null }
    >();
    if (!options.envelopeEncryptionProvider || executionIds.length === 0)
      return empty;
    const latest = await pool.query<{
      conversation_id: string;
      id: string;
      agent_id: string;
      agent_version: number;
    }>(
      `select distinct on (j.conversation_id) j.conversation_id,j.id,j.agent_id,j.agent_version
         from personal_agent_execution_jobs j
        where j.owner_user_id=$1 and j.conversation_id=any($2::uuid[])
          and j.attribution_kind='agent' and j.agent_id is not null
        order by j.conversation_id,j.updated_at desc,j.id desc`,
      [ownerUserId, executionIds]
    );
    const titles = await mapJobTitles(ownerUserId, latest.rows);
    const labels = new Map<string, { title: string; agentName: string | null }>(
      latest.rows.flatMap((row) => {
        const label = titles.get(row.id);
        return label ? [[row.conversation_id, label] as const] : [];
      })
    );
    if (executionIds.length === 0) return labels;

    // Private Agent prompts have no legacy Job row. Read at most the latest
    // current-generation start and prompt payload per selected execution, then
    // retain only the structured Agent identity. Never read or expose prompt
    // text, Agent instructions, or personal-Agent context text.
    const commands = await pool.query<{
      execution_id: string;
      sequence: number;
      encrypted_payload: unknown;
    }>(
      `select e.id as execution_id,c.sequence,c.encrypted_payload
         from managed_conversation_executions e
         join lateral (
           select command.id,command.sequence,command.command_kind,command.encrypted_payload
             from (
               select distinct on (candidate.command_kind)
                      candidate.id,candidate.sequence,candidate.command_kind,candidate.encrypted_payload
                 from managed_conversation_commands candidate
                where candidate.owner_user_id=e.owner_user_id
                  and candidate.execution_id=e.id
                  and candidate.execution_generation=e.execution_generation
                  and candidate.command_kind in ('start','prompt')
                  and candidate.encrypted_payload is not null
                order by candidate.command_kind,candidate.sequence desc
             ) command
            order by command.sequence desc
            limit 2
         ) c on true
        where e.owner_user_id=$1 and e.id=any($2::uuid[])
        order by e.id,c.sequence desc`,
      [ownerUserId, executionIds]
    );
    const candidates: Array<{
      executionId: string;
      identityVersionId: string;
      agentId: string;
      agentVersion: number;
      name: string;
    }> = [];
    for (const command of commands.rows) {
      try {
        const plaintext = await decryptEnvelopeToUtf8(
          options.envelopeEncryptionProvider,
          command.encrypted_payload as EncryptedPayloadEnvelope
        );
        const payload = JSON.parse(plaintext) as Record<string, unknown>;
        const agent = payload.personalAgent;
        const context = personalAgentExecutionContextSchema.safeParse(
          payload.personalAgentContext
        );
        if (
          !agent ||
          typeof agent !== "object" ||
          Array.isArray(agent) ||
          !context.success
        )
          continue;
        const storedAgent = agent as Record<string, unknown>;
        const identity = context.data.identity;
        if (
          storedAgent.jobId !== null ||
          storedAgent.agentId !== identity.agentId ||
          storedAgent.agentVersion !== identity.version ||
          storedAgent.identityVersionId !== identity.identityVersionId
        )
          continue;
        candidates.push({
          executionId: command.execution_id,
          identityVersionId: identity.identityVersionId,
          agentId: identity.agentId,
          agentVersion: identity.version,
          name: identity.name
        });
      } catch {
        // Home labels are optional. Corrupt or retired encrypted metadata must
        // not make the activity feed unavailable.
      }
    }
    if (candidates.length === 0) return labels;
    const identities = await pool.query<{
      identity_version_id: string;
      agent_id: string;
      agent_version: number;
      name: string;
    }>(
      `select v.id as identity_version_id,v.agent_id,v.version as agent_version,v.name
         from personal_agent_identity_versions v
        where v.owner_user_id=$1
          and (v.id,v.agent_id,v.version) in (
            select x.identity_version_id,x.agent_id,x.agent_version
              from unnest($2::uuid[],$3::uuid[],$4::int[]) as x(identity_version_id,agent_id,agent_version)
          )`,
      [
        ownerUserId,
        candidates.map((candidate) => candidate.identityVersionId),
        candidates.map((candidate) => candidate.agentId),
        candidates.map((candidate) => candidate.agentVersion)
      ]
    );
    const identityNames = new Map(
      identities.rows.map((identity) => [
        `${identity.identity_version_id}:${identity.agent_id}:${identity.agent_version}`,
        identity.name
      ])
    );
    const nativeLabels = new Map<
      string,
      { title: string; agentName: string | null }
    >();
    for (const candidate of candidates) {
      if (nativeLabels.has(candidate.executionId)) continue;
      const name = identityNames.get(
        `${candidate.identityVersionId}:${candidate.agentId}:${candidate.agentVersion}`
      );
      if (!name) continue;
      nativeLabels.set(candidate.executionId, {
        title: `${name} Agent conversation`,
        agentName: name
      });
    }
    // The current native prompt is the most specific attribution. Keep the
    // legacy Job label only as fallback when no verified current identity exists.
    for (const [executionId, label] of nativeLabels)
      labels.set(executionId, label);
    return labels;
  };

  const cursorEncode = (input: {
    source: HomeSource;
    updatedAt: Date | string;
    id: string;
    priority?: number;
    variant?: string;
    revision?: string;
  }) =>
    Buffer.from(
      JSON.stringify({
        ...input,
        updatedAt:
          input.updatedAt instanceof Date
            ? input.updatedAt.toISOString()
            : input.updatedAt
      })
    ).toString("base64url");

  const cursorDecode = (
    value: string | null | undefined,
    source: HomeSource
  ) => {
    if (!value) return null;
    try {
      const parsed = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8")
      ) as {
        source?: HomeSource;
        updatedAt?: string;
        id?: string;
        priority?: number;
        variant?: string;
        revision?: string;
      };
      if (
        parsed.source !== source ||
        !parsed.id ||
        !parsed.updatedAt ||
        !Number.isFinite(Date.parse(parsed.updatedAt)) ||
        (source === "native_agent_activity" && !parsed.revision)
      )
        throw new Error();
      return parsed as {
        source: HomeSource;
        updatedAt: string;
        id: string;
        priority?: number;
        variant?: string;
        revision?: string;
      };
    } catch {
      throw Object.assign(new Error("Home cursor is invalid"), {
        statusCode: 400
      });
    }
  };

  return {
    async listReminderStates(ownerUserId, sourceEventIds) {
      const result = await pool.query<HomeReminderStateRow>(
        `select owner_user_id, source_event_id, source_kind, source_id, source_revision, cleared, updated_at
           from home_reminder_states where owner_user_id=$1
            and ($2::text[] is null or source_event_id=any($2::text[]))
         union all
         select $1,native_event.event_id,'native_agent_activity',native_event.native_id::text,
                native_event.source_revision,true,native_event.updated_at
           from (${nativeHomeEventsSql}) native_event
          where native_event.legacy_alias_cleared
            and ($2::text[] is null or native_event.event_id=any($2::text[]))
         order by updated_at desc`,
        [ownerUserId, sourceEventIds ?? null]
      );
      return result.rows.map(mapState);
    },
    countNeedsYou,
    async listSourcePage({ ownerUserId, source, cursor: cursorValue, limit }) {
      const pageLimit = Math.min(Math.max(limit, 1), 100);
      const cursor = cursorDecode(cursorValue, source);
      if (cursor) {
        let anchor: { cursor_timestamp: string; priority?: number } | undefined;
        if (source === "managed_runtime_item") {
          const found = await pool.query<{ cursor_timestamp: string }>(
            `select to_char(r.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp
             from managed_conversation_runtime_items r join managed_conversation_executions e on e.id=r.execution_id and e.owner_user_id=r.owner_user_id
            where r.owner_user_id=$1 and r.id=$2 and r.execution_generation=e.execution_generation and r.state='pending'
              and r.item_kind in ('command_approval','file_approval','permissions_approval','user_input')
              and e.state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping')`,
            [ownerUserId, cursor.id]
          );
          anchor = found.rows[0];
        } else if (source === "managed_execution") {
          const found = await pool.query<{
            cursor_timestamp: string;
            priority: number;
          }>(
            `select to_char(e.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp,
                    case when e.state in ('failed','fenced') then 0 when e.state='stopped' then 2 else 1 end as priority
             from managed_conversation_executions e
            where e.owner_user_id=$1 and e.id=$2 and e.state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping','stopped','failed','fenced')
              and not (e.state in ('failed','fenced') and exists (select 1 from personal_agent_execution_jobs j join personal_agent_execution_attempts a on a.id=j.last_attempt_id and a.job_id=j.id and a.owner_user_id=j.owner_user_id where j.owner_user_id=e.owner_user_id and j.conversation_id=e.id and j.attribution_kind='agent' and j.agent_id is not null and j.state='failed' and a.attribution_kind='agent' and a.agent_id=j.agent_id and a.status='failed' and a.managed_execution_id=e.id and a.managed_execution_generation=e.execution_generation))
              ${nativeExecutionFailureExclusionSql}`,
            [ownerUserId, cursor.id]
          );
          anchor = found.rows[0];
        } else if (source === "native_agent_activity") {
          const found = await pool.query<{
            cursor_timestamp: string;
            priority: number;
            source_revision: string;
          }>(
            `select to_char(native_event.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp,
                    native_event.priority,native_event.source_revision
               from (${nativeHomeEventsSql}) native_event
              where native_event.event_id=$2`,
            [ownerUserId, cursor.id]
          );
          anchor = found.rows[0];
        } else if (source === "personal_agent_job") {
          const found = await pool.query<{
            cursor_timestamp: string;
            priority: number;
          }>(
            `select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp, case when state='failed' then 0 else 1 end as priority
             from personal_agent_execution_jobs where owner_user_id=$1 and id=$2 and attribution_kind='agent' and agent_id is not null and state in ('succeeded','failed')`,
            [ownerUserId, cursor.id]
          );
          anchor = found.rows[0];
        } else if (cursor.variant === "push") {
          const found = await pool.query<{
            cursor_timestamp: string;
            priority: number;
          }>(
            `select to_char(o.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp, 0 as priority
             from pull_request_operations o join pull_request_reviews p on p.id=o.review_id and p.owner_user_id=o.owner_user_id
            where o.owner_user_id=$1 and o.id=$2 and o.kind='push' and o.state in ('uncertain','failed')`,
            [ownerUserId, cursor.id]
          );
          anchor = found.rows[0];
        } else if (cursor.variant === "review") {
          const found = await pool.query<{
            cursor_timestamp: string;
            priority: number;
          }>(
            `select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp,
                  case when status in ('uncertain','failed') then 0 else 1 end as priority
             from pull_request_reviews where owner_user_id=$1 and id=$2 and status in ('stale','draft','frozen','uncertain','failed')`,
            [ownerUserId, cursor.id]
          );
          anchor = found.rows[0];
        } else {
          throw Object.assign(new Error("Home cursor is unavailable"), {
            statusCode: 400
          });
        }
        if (
          !anchor ||
          anchor.cursor_timestamp !== cursor.updatedAt ||
          (source === "native_agent_activity" &&
            ((anchor as { source_revision?: string }).source_revision !==
              cursor.revision ||
              anchor.priority !== cursor.priority)) ||
          ((source === "personal_agent_job" ||
            source === "pull_request_review" ||
            source === "managed_execution") &&
            anchor.priority !== cursor.priority)
        )
          throw Object.assign(new Error("Home cursor is unavailable"), {
            statusCode: 409
          });
      }
      let rows: Array<Record<string, unknown>>;
      if (source === "native_agent_activity") {
        const result = await pool.query<{
          native_id: string;
          event_id: string;
          variant: string;
          native_status: string;
          item_state: string;
          priority: number;
          source_revision: string;
          destination_id: string;
          execution_id: string | null;
          command_id: string | null;
          agent_name: string | null;
          recipient_kind: string;
          provider: string | null;
          root_title: string | null;
          updated_at: Date;
          cursor_timestamp: string;
        }>(
          `select native_event.*,
                  to_char(native_event.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp
             from (${nativeHomeEventsSql}) native_event
            where ($2::int is null or native_event.priority>$2::int
              or (native_event.priority=$2::int and
                (native_event.updated_at,native_event.event_id)<($3::timestamptz,$4::text)))
            order by native_event.priority,native_event.updated_at desc,native_event.event_id desc
            limit $5`,
          [
            ownerUserId,
            cursor?.priority ?? null,
            cursor?.updatedAt ?? null,
            cursor?.id ?? null,
            pageLimit + 1
          ]
        );
        rows = result.rows;
      } else if (source === "managed_runtime_item") {
        const result = await pool.query<{
          id: string;
          execution_id: string;
          item_kind: string;
          revision: number;
          updated_at: Date;
          cursor_timestamp: string;
        }>(
          `select r.id,r.execution_id,r.item_kind,r.revision,r.updated_at,to_char(r.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp
           from managed_conversation_runtime_items r join managed_conversation_executions e on e.id=r.execution_id and e.owner_user_id=r.owner_user_id
            where r.owner_user_id=$1 and r.execution_generation=e.execution_generation and r.state='pending'
            and r.item_kind in ('command_approval','file_approval','permissions_approval','user_input')
            and e.state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping')
            and ($2::timestamptz is null or (r.updated_at,r.id)<($2::timestamptz,$3::uuid))
          order by r.updated_at desc,r.id desc limit $4`,
          [
            ownerUserId,
            cursor?.updatedAt ?? null,
            cursor?.id ?? null,
            pageLimit + 1
          ]
        );
        rows = result.rows;
      } else if (source === "personal_agent_job") {
        const result = await pool.query<{
          id: string;
          conversation_id: string;
          agent_id: string;
          agent_version: number;
          state: string;
          version: number;
          updated_at: Date;
          cursor_timestamp: string;
        }>(
          `select j.id,j.conversation_id,j.agent_id,j.agent_version,j.state,j.version,j.updated_at,to_char(j.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp
           from personal_agent_execution_jobs j
          where j.owner_user_id=$1 and j.attribution_kind='agent' and j.agent_id is not null
            and j.state in ('succeeded','failed')
            and ($2::int is null or (case when j.state='failed' then 0 else 1 end)>$2::int or ((case when j.state='failed' then 0 else 1 end)=$2::int and (j.updated_at,j.id)<($3::timestamptz,$4::uuid)))
          order by case when j.state='failed' then 0 else 1 end,j.updated_at desc,j.id desc limit $5`,
          [
            ownerUserId,
            cursor?.priority ?? null,
            cursor?.updatedAt ?? null,
            cursor?.id ?? null,
            pageLimit + 1
          ]
        );
        rows = result.rows;
      } else if (source === "pull_request_review") {
        const result = await pool.query<{
          id: string;
          review_id: string;
          repository_id: string;
          pull_request_number: number;
          status: string;
          revision: number;
          operation_revision: number | null;
          variant: string;
          priority: number;
          updated_at: Date;
          cursor_timestamp: string;
        }>(
          `with events as (
           select p.id as id,p.id as review_id,p.repository_id,p.pull_request_number,p.status,p.revision,
                  null::int as operation_revision,'review'::text as variant,
                  case when p.status in ('uncertain','failed') then 0 else 1 end as priority,
                  p.updated_at,to_char(p.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp
             from pull_request_reviews p
            where p.owner_user_id=$1 and p.status in ('stale','draft','frozen','uncertain','failed')
           union all
           select o.id as id,p.id as review_id,p.repository_id,p.pull_request_number,'push_uncertain'::text as status,p.revision,
                  o.revision as operation_revision,'push'::text as variant,0 as priority,
                  o.updated_at,to_char(o.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp
             from pull_request_operations o join pull_request_reviews p on p.id=o.review_id and p.owner_user_id=o.owner_user_id
            where o.owner_user_id=$1 and o.kind='push' and o.state in ('uncertain','failed')
         )
         select * from events
          where ($2::int is null or priority>$2::int or (priority=$2::int and (updated_at,id)<($3::timestamptz,$4::uuid)))
          order by priority,updated_at desc,id desc limit $5`,
          [
            ownerUserId,
            cursor?.priority ?? null,
            cursor?.updatedAt ?? null,
            cursor?.id ?? null,
            pageLimit + 1
          ]
        );
        rows = result.rows;
      } else {
        const result = await pool.query<{
          id: string;
          state: string;
          state_version: number;
          priority: number;
          updated_at: Date;
          cursor_timestamp: string;
        }>(
          `select e.id,e.state,e.state_version,
                  case when e.state in ('failed','fenced') then 0 when e.state='stopped' then 2 else 1 end as priority,
                  e.updated_at,to_char(e.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp
             from managed_conversation_executions e
            where e.owner_user_id=$1 and e.state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping','stopped','failed','fenced')
              and not (e.state in ('failed','fenced') and exists (select 1 from personal_agent_execution_jobs j join personal_agent_execution_attempts a on a.id=j.last_attempt_id and a.job_id=j.id and a.owner_user_id=j.owner_user_id where j.owner_user_id=e.owner_user_id and j.conversation_id=e.id and j.attribution_kind='agent' and j.agent_id is not null and j.state='failed' and a.attribution_kind='agent' and a.agent_id=j.agent_id and a.status='failed' and a.managed_execution_id=e.id and a.managed_execution_generation=e.execution_generation))
              ${nativeExecutionFailureExclusionSql}
              and ($2::int is null
                or (case when e.state in ('failed','fenced') then 0 when e.state='stopped' then 2 else 1 end)>$2::int
                or ((case when e.state in ('failed','fenced') then 0 when e.state='stopped' then 2 else 1 end)=$2::int and (e.updated_at,e.id)<($3::timestamptz,$4::uuid)))
            order by priority,e.updated_at desc,e.id desc limit $5`,
          [
            ownerUserId,
            cursor?.priority ?? null,
            cursor?.updatedAt ?? null,
            cursor?.id ?? null,
            pageLimit + 1
          ]
        );
        rows = result.rows;
      }
      const hasMore = rows.length > pageLimit;
      const pageRows = rows.slice(0, pageLimit);
      const labels =
        source === "personal_agent_job"
          ? await mapJobTitles(
              ownerUserId,
              pageRows as Array<{
                id: string;
                agent_id: string;
                agent_version: number;
              }>
            )
          : new Map<string, { title: string; agentName: string | null }>();
      const executionLabels =
        source === "managed_runtime_item" ||
        source === "managed_execution" ||
        source === "native_agent_activity"
          ? await labelsForExecutions(ownerUserId, [
              ...new Set(
                pageRows
                  .filter(
                    (row) =>
                      source !== "native_agent_activity" ||
                      row.variant === "command"
                  )
                  .map((row) => String(row.execution_id ?? row.id))
              )
            ])
          : new Map<string, { title: string; agentName: string | null }>();
      const items: HomeItem[] = pageRows.map((raw) => {
        const row = raw as unknown as Record<string, string | number | Date>;
        const id = String(
          source === "native_agent_activity" ? row.native_id : row.id
        );
        if (source === "native_agent_activity") {
          const nativeStatus = String(row.native_status);
          const state = String(row.item_state) as HomeItem["state"];
          const executionLabel = executionLabels.get(
            String(row.execution_id ?? "")
          );
          const agentName =
            typeof row.agent_name === "string" && row.agent_name.trim()
              ? row.agent_name.trim()
              : row.variant === "command"
                ? (executionLabel?.agentName ?? null)
                : null;
          const provider =
            typeof row.provider === "string" ? row.provider : null;
          const clientName =
            agentName ??
            (provider === "codex"
              ? "Codex"
              : provider === "claude"
                ? "Claude"
                : provider === "gemini"
                  ? "Gemini"
                  : "AI Client");
          const teamRequest = row.variant === "team_request";
          const title =
            state === "blocked"
              ? `${clientName} ${nativeStatus === "uncertain" || nativeStatus === "unknown" || nativeStatus === "indeterminate" ? "needs status confirmation" : "needs attention"}`
              : state === "ongoing"
                ? `${clientName} is working`
                : state === "review"
                  ? nativeStatus === "canceled" ||
                    nativeStatus === "interrupted"
                    ? `${clientName} work stopped; outcome ready to publish`
                    : `${clientName} finished work; outcome ready to publish`
                  : teamRequest && nativeStatus === "succeeded"
                    ? `${clientName} outcome published`
                    : nativeStatus === "canceled" ||
                        nativeStatus === "interrupted"
                      ? `${clientName} work stopped`
                      : `${clientName} responded`;
          const summary =
            state === "blocked"
              ? nativeStatus === "uncertain" ||
                nativeStatus === "unknown" ||
                nativeStatus === "indeterminate"
                ? "Confirm the current Agent status in its conversation."
                : "An Agent action needs attention."
              : state === "ongoing"
                ? "Native Agent work is in progress."
                : state === "review"
                  ? "The accepted Team assignment has no published outcome yet."
                  : teamRequest && nativeStatus === "succeeded"
                    ? "The Team assignment has a published outcome."
                    : nativeStatus === "canceled" ||
                        nativeStatus === "interrupted"
                      ? "The native Agent work stopped."
                      : "The native Agent response is complete.";
          return {
            sourceEventId: String(row.event_id),
            source,
            sourceId: id,
            sourceRevision: String(row.source_revision),
            kind:
              state === "blocked"
                ? "intervention"
                : state === "review"
                  ? "publication"
                  : "agent_work",
            state,
            title,
            summary,
            updatedAt: (row.updated_at as Date).toISOString(),
            destination: {
              kind: "execution",
              executionId: String(row.destination_id)
            }
          };
        }
        if (source === "managed_runtime_item")
          return {
            sourceEventId: `runtime:${id}`,
            source,
            sourceId: id,
            sourceRevision: `r${row.revision}`,
            kind: row.item_kind === "user_input" ? "question" : "approval",
            state: "blocked",
            title:
              executionLabels.get(String(row.execution_id))?.title ??
              (row.item_kind === "user_input"
                ? "Agent question needs an answer"
                : "Agent approval needed"),
            summary:
              executionLabels.get(String(row.execution_id))?.agentName ?? null,
            updatedAt: (row.updated_at as Date).toISOString(),
            destination: {
              kind: "execution",
              executionId: String(row.execution_id)
            }
          };
        if (source === "personal_agent_job")
          return mapHomeJob(
            raw as unknown as {
              id: string;
              conversation_id: string;
              agent_id: string;
              state: string;
              version: number;
              updated_at: Date;
            },
            labels
          );
        if (source === "pull_request_review") {
          const operation = row.variant === "push";
          const reviewId = String(row.review_id);
          return {
            sourceEventId: operation ? `pr-op:${id}` : `pr:${id}`,
            source,
            sourceId: id,
            sourceRevision: operation
              ? `v${row.revision}.o${row.operation_revision}`
              : `v${row.revision}`,
            kind: operation
              ? "intervention"
              : row.status === "uncertain" || row.status === "failed"
                ? "intervention"
                : row.status === "frozen"
                  ? "publication"
                  : "pull_request_review",
            state:
              operation || row.status === "uncertain" || row.status === "failed"
                ? "blocked"
                : "review",
            title: `${String(row.repository_id)} #${Number(row.pull_request_number)}${operation ? " push needs attention" : row.status === "frozen" ? " ready to publish" : row.status === "uncertain" || row.status === "failed" ? " needs attention" : " review needs attention"}`,
            summary: null,
            updatedAt: (row.updated_at as Date).toISOString(),
            destination: {
              kind: "pull_request_review",
              reviewId,
              repositoryId: String(row.repository_id),
              number: Number(row.pull_request_number)
            }
          };
        }
        const state = String(row.state);
        const ended = ["stopped", "failed", "fenced"].includes(state);
        return {
          sourceEventId: `execution:${id}`,
          source,
          sourceId: id,
          sourceRevision: `v${row.state_version}`,
          kind:
            state === "failed" || state === "fenced"
              ? "intervention"
              : "question",
          state:
            state === "failed" || state === "fenced"
              ? "blocked"
              : ended
                ? "recent"
                : "ongoing",
          title:
            executionLabels.get(id)?.title ??
            (state === "failed" || state === "fenced"
              ? "Managed conversation needs attention"
              : ended
                ? "Managed conversation ended recently"
                : "Managed conversation in progress"),
          summary: executionLabels.get(id)?.agentName ?? null,
          updatedAt: (row.updated_at as Date).toISOString(),
          destination: { kind: "execution", executionId: id }
        };
      });
      const last = pageRows.at(-1) as Record<string, unknown> | undefined;
      const nextCursor =
        hasMore && last
          ? cursorEncode({
              source,
              updatedAt: String(last.cursor_timestamp),
              id: String(
                source === "native_agent_activity" ? last.event_id : last.id
              ),
              ...(source === "native_agent_activity"
                ? { priority: Number(last.priority) }
                : {}),
              ...(source === "personal_agent_job"
                ? { priority: last.state === "failed" ? 0 : 1 }
                : {}),
              ...(source === "managed_execution"
                ? { priority: Number(last.priority) }
                : {}),
              ...(source === "pull_request_review"
                ? {
                    priority: Number(last.priority),
                    variant: String(last.variant)
                  }
                : {}),
              ...(source === "native_agent_activity"
                ? { revision: String(last.source_revision) }
                : {})
            })
          : null;
      return { items, complete: !hasMore, nextCursor };
    },
    async setReminderState(input) {
      const result = await pool.query<HomeReminderStateRow>(
        `insert into home_reminder_states (owner_user_id, source_event_id, source_kind, source_id, source_revision, cleared)
       select $1,$2,$3,$4::text,$5,$6
        where (
          ($3='managed_runtime_item' and exists (
            select 1 from managed_conversation_runtime_items r
            join managed_conversation_executions e on e.id=r.execution_id and e.owner_user_id=r.owner_user_id
            where r.owner_user_id=$1 and r.id=$4::uuid and $2='runtime:'||r.id::text and ('r'||r.revision::text)=$5
              and r.execution_generation=e.execution_generation and r.state='pending' and r.item_kind in ('command_approval','file_approval','permissions_approval','user_input')
              and e.state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping')
          )) or
          ($3='managed_execution' and exists (
            select 1 from managed_conversation_executions e
            where e.owner_user_id=$1 and e.id=$4::uuid and $2='execution:'||e.id::text and ('v'||e.state_version::text)=$5
              and e.state in ('failed','fenced')
              and not exists (select 1 from personal_agent_execution_jobs j join personal_agent_execution_attempts a on a.id=j.last_attempt_id and a.job_id=j.id and a.owner_user_id=j.owner_user_id where j.owner_user_id=e.owner_user_id and j.conversation_id=e.id and j.attribution_kind='agent' and j.agent_id is not null and j.state='failed' and a.attribution_kind='agent' and a.agent_id=j.agent_id and a.status='failed' and a.managed_execution_id=e.id and a.managed_execution_generation=e.execution_generation)
              ${nativeExecutionFailureExclusionSql}
          )) or
          ($3='personal_agent_job' and exists (
            select 1 from personal_agent_execution_jobs j
            where j.owner_user_id=$1 and j.id=$4::uuid and $2='job:'||j.id::text and ('v'||j.version::text)=$5
              and j.attribution_kind='agent' and j.agent_id is not null and j.state in ('succeeded','failed')
          )) or
          ($3='pull_request_review' and exists (
            select 1 from pull_request_reviews p
            where p.owner_user_id=$1 and p.id=$4::uuid and $2='pr:'||p.id::text and ('v'||p.revision::text)=$5
              and p.status in ('stale','draft','frozen','uncertain','failed')
          )) or
          ($3='pull_request_review' and exists (
            select 1 from pull_request_operations o join pull_request_reviews p on p.id=o.review_id and p.owner_user_id=o.owner_user_id
            where o.owner_user_id=$1 and o.id=$4::uuid and $2='pr-op:'||o.id::text and ('v'||p.revision::text||'.o'||o.revision::text)=$5
              and o.kind='push' and o.state in ('uncertain','failed')
          ))
          or
          ($3='native_agent_activity' and exists (
            select 1 from (${nativeHomeEventsSql}) native_event
             where native_event.native_id=$4::uuid
               and native_event.event_id=$2
               and native_event.source_revision=$5
               and native_event.item_state in ('blocked','review')
          ))
        )
       on conflict (owner_user_id, source_event_id) do update
         set source_kind=excluded.source_kind, source_id=excluded.source_id,
             source_revision=excluded.source_revision, cleared=excluded.cleared, updated_at=now()
       returning owner_user_id, source_event_id, source_kind, source_id, source_revision, cleared, updated_at`,
        [
          input.ownerUserId,
          input.sourceEventId,
          input.source,
          input.sourceId,
          input.sourceRevision,
          input.cleared
        ]
      );
      const row = result.rows[0];
      if (!row)
        throw Object.assign(
          new Error("Home reminder changed or is unavailable"),
          {
            code: "HOME_SOURCE_STALE",
            statusCode: 409
          }
        );
      return mapState(row);
    }
  };
};
