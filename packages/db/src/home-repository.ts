import type pg from "pg";
import type {
  EnvelopeEncryptionProvider,
  HomeItem,
  HomeSource
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
            and not exists (select 1 from home_reminder_states h where h.owner_user_id=$1 and h.source_event_id='execution:'||e.id::text and h.source_kind='managed_execution' and h.source_id=e.id::text and h.source_revision='v'||e.state_version::text and h.cleared))
        + (select count(*) from personal_agent_execution_jobs j where j.owner_user_id=$1 and j.attribution_kind='agent' and j.agent_id is not null and j.state in ('succeeded','failed')
            and not exists (select 1 from home_reminder_states h where h.owner_user_id=$1 and h.source_event_id='job:'||j.id::text and h.source_kind='personal_agent_job' and h.source_id=j.id::text and h.source_revision='v'||j.version::text and h.cleared))
        + (select count(*) from pull_request_reviews p where p.owner_user_id=$1 and p.status in ('stale','draft','frozen','uncertain','failed')
            and not exists (select 1 from home_reminder_states h where h.owner_user_id=$1 and h.source_event_id='pr:'||p.id::text and h.source_kind='pull_request_review' and h.source_id=p.id::text and h.source_revision='v'||p.revision::text and h.cleared))
        + (select count(*) from pull_request_operations o join pull_request_reviews p on p.id=o.review_id and p.owner_user_id=o.owner_user_id
            where o.owner_user_id=$1 and o.kind='push' and o.state in ('uncertain','failed')
              and not exists (select 1 from home_reminder_states h where h.owner_user_id=$1 and h.source_event_id='pr-op:'||o.id::text and h.source_kind='pull_request_review' and h.source_id=o.id::text and h.source_revision='v'||p.revision::text||'.o'||o.revision::text and h.cleared)) as badge_count`,
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
    return new Map(
      latest.rows.flatMap((row) => {
        const label = titles.get(row.id);
        return label ? [[row.conversation_id, label] as const] : [];
      })
    );
  };

  const cursorEncode = (input: {
    source: HomeSource;
    updatedAt: Date | string;
    id: string;
    priority?: number;
    variant?: string;
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
      };
      if (
        parsed.source !== source ||
        !parsed.id ||
        !parsed.updatedAt ||
        !Number.isFinite(Date.parse(parsed.updatedAt))
      )
        throw new Error();
      return parsed as {
        source: HomeSource;
        updatedAt: string;
        id: string;
        priority?: number;
        variant?: string;
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
          and ($2::text[] is null or source_event_id=any($2::text[])) order by updated_at desc`,
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
            `select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp,
                    case when state in ('failed','fenced') then 0 when state='stopped' then 2 else 1 end as priority
             from managed_conversation_executions
            where owner_user_id=$1 and id=$2 and state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping','stopped','failed','fenced')
              and not (state in ('failed','fenced') and exists (select 1 from personal_agent_execution_jobs j join personal_agent_execution_attempts a on a.id=j.last_attempt_id and a.job_id=j.id and a.owner_user_id=j.owner_user_id where j.owner_user_id=managed_conversation_executions.owner_user_id and j.conversation_id=managed_conversation_executions.id and j.attribution_kind='agent' and j.agent_id is not null and j.state='failed' and a.attribution_kind='agent' and a.agent_id=j.agent_id and a.status='failed' and a.managed_execution_id=managed_conversation_executions.id and a.managed_execution_generation=managed_conversation_executions.execution_generation))`,
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
      if (source === "managed_runtime_item") {
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
          `select id,state,state_version,case when state in ('failed','fenced') then 0 when state='stopped' then 2 else 1 end as priority,updated_at,to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp from managed_conversation_executions
          where owner_user_id=$1 and state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping','stopped','failed','fenced')
            and not (state in ('failed','fenced') and exists (select 1 from personal_agent_execution_jobs j join personal_agent_execution_attempts a on a.id=j.last_attempt_id and a.job_id=j.id and a.owner_user_id=j.owner_user_id where j.owner_user_id=managed_conversation_executions.owner_user_id and j.conversation_id=managed_conversation_executions.id and j.attribution_kind='agent' and j.agent_id is not null and j.state='failed' and a.attribution_kind='agent' and a.agent_id=j.agent_id and a.status='failed' and a.managed_execution_id=managed_conversation_executions.id and a.managed_execution_generation=managed_conversation_executions.execution_generation))
            and ($2::int is null
              or (case when state in ('failed','fenced') then 0 when state='stopped' then 2 else 1 end)>$2::int
              or ((case when state in ('failed','fenced') then 0 when state='stopped' then 2 else 1 end)=$2::int and (updated_at,id)<($3::timestamptz,$4::uuid)))
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
        source === "managed_runtime_item" || source === "managed_execution"
          ? await labelsForExecutions(ownerUserId, [
              ...new Set(
                pageRows.map((row) => String(row.execution_id ?? row.id))
              )
            ])
          : new Map<string, { title: string; agentName: string | null }>();
      const items: HomeItem[] = pageRows.map((raw) => {
        const row = raw as unknown as Record<string, string | number | Date>;
        const id = String(row.id);
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
              id: String(last.id),
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
