import type pg from "pg";
import type {
  RecallUsage,
  RecallUsageAttempt,
  RecallUsageTotals,
  RecallActivityOverview,
  RecallActivityOverviewInput
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import {
  personalRecallPredicate,
  recallActivityFilter
} from "./recall-activity-query.js";

export const recallUsageEligibility = `u.visibility = 'personal'
  and u.workflow_type = 'mcp_memory_answer'
  and (u.metadata->>'questionOrigin' is null or u.metadata->>'questionOrigin' = 'mcp_memory_answer')
  and u.usage_kind in ('turn_delta', 'estimate')
  and u.usage_accuracy in ('provider_reported', 'provider_partial', 'local_estimate')`;

type UsageRow = {
  id: string;
  observed_at: Date;
  connector_client: string | null;
  model: string | null;
  usage_accuracy: RecallUsageAttempt["accuracy"];
  execution_status: string | null;
  input_tokens: string | number | null;
  cached_input_tokens: string | number | null;
  output_tokens: string | number | null;
  reasoning_output_tokens: string | number | null;
  total_tokens: string | number | null;
  conflict: boolean;
};

const count = (value: string | number | null): number | null =>
  value === null ? null : Number(value);
export const summarizeRecallAttempts = (
  attempts: RecallUsageAttempt[],
  provenance: RecallUsage["provenance"],
  truncated = false,
  ambiguous = false
): RecallUsage => {
  const sum = (
    key:
      | "inputTokens"
      | "cachedInputTokens"
      | "outputTokens"
      | "reasoningOutputTokens"
      | "totalTokens"
  ) => {
    const known = attempts.flatMap((attempt) =>
      attempt[key] === null ? [] : [attempt[key]!]
    );
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  return {
    provenance,
    coverage: !attempts.length
      ? "unavailable"
      : provenance === "historical_job" ||
          truncated ||
          ambiguous ||
          attempts.some(
            (attempt) =>
              attempt.accuracy !== "provider_reported" ||
              attempt.totalTokens === null
          )
        ? "partial"
        : "recorded",
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningOutputTokens: sum("reasoningOutputTokens"),
    totalTokens: sum("totalTokens"),
    recordedAttempts: attempts.length,
    truncated,
    ambiguous,
    attempts,
    includesEstimates: attempts.some(
      (attempt) => attempt.accuracy === "local_estimate"
    )
  };
};

export const unknownRecallUsage = (): RecallUsageTotals => ({
  coverage: "unavailable",
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  totalTokens: null,
  recordedAttempts: 0,
  includesEstimates: false
});

const compatibleQuestionUsage = `not exists (
  select 1 from workflow_token_usage_source_references other
  where other.workflow_token_usage_id = u.id and
    ((other.source_type = 'question' and other.source_id <> q.id::text)
     or (other.source_type = 'answer_job' and other.source_id <> u.workflow_id)))`;

const usageAggregates = `sum(u.input_tokens)::float8 as "inputTokens",
  sum(u.cached_input_tokens)::float8 as "cachedInputTokens",
  sum(u.output_tokens)::float8 as "outputTokens",
  sum(u.reasoning_output_tokens)::float8 as "reasoningOutputTokens",
  sum(u.total_tokens)::float8 as "totalTokens", count(*)::int as "recordedAttempts",
  coalesce(bool_or(u.usage_accuracy = 'local_estimate'), false) as "includesEstimates",
  case when count(*) = 0 then 'unavailable'
       when bool_or(u.total_tokens is null or u.usage_accuracy <> 'provider_reported') then 'partial'
       else 'recorded' end as coverage`;

export const loadLinkedRecallUsage = async (
  pool: pg.Pool,
  actor: ActorContext,
  questionIds: string[]
): Promise<Map<string, RecallUsageTotals>> => {
  if (!questionIds.length) return new Map();
  const result = await pool.query<RecallUsageTotals & { questionId: string }>(
    `select q.id as "questionId", ${usageAggregates}
     from memory_questions q
     join workflow_token_usage_source_references ref on ref.source_type = 'question' and ref.source_id = q.id::text
     join workflow_token_usage u on u.id = ref.workflow_token_usage_id and u.owner_user_id = q.owner_user_id
     where ${personalRecallPredicate} and q.id = any($2::uuid[])
       and ${recallUsageEligibility} and ${compatibleQuestionUsage}
     group by q.id`,
    [actor.userId, questionIds]
  );
  return new Map(
    result.rows.map(({ questionId, ...usage }) => [questionId, usage])
  );
};

export const loadRecallTokenOverview = async (
  pool: pg.Pool,
  actor: ActorContext,
  input: RecallActivityOverviewInput,
  bucket: RecallActivityOverview["bucket"]
): Promise<
  Pick<RecallActivityOverview, "tokens" | "linkedQuestions" | "tokenTimeline">
> => {
  // Token time is observation time. A question may finish outside this range.
  // Keep q.id as UUID so broad history joins can use its primary key. Casting
  // that indexed column to text caused a full question scan for each usage row.
  // Guard the legacy text reference before casting; malformed references omit
  // the join rather than making the entire overview fail.
  const { values, predicates, bind } = recallActivityFilter(
    actor,
    input,
    false
  );
  const from = bind(input.from),
    to = bind(input.to),
    timezone = bind(input.timezone),
    unit = bind(bucket),
    step = bind(`1 ${bucket}`);
  const result = await pool.query<
    Pick<RecallActivityOverview, "tokens" | "linkedQuestions" | "tokenTimeline">
  >(
    `with eligible as (
       select u.*, q.id as question_id from memory_questions q
       join workflow_token_usage_source_references ref on ref.source_type = 'question'
         and q.id = case when ref.source_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           then ref.source_id::uuid end
       join workflow_token_usage u on u.id = ref.workflow_token_usage_id and u.owner_user_id = q.owner_user_id
       where ${predicates.join(" and ")} and ${recallUsageEligibility} and ${compatibleQuestionUsage}
         and u.observed_at >= ${from}::timestamptz and u.observed_at < ${to}::timestamptz
     ), summary as (select ${usageAggregates} from eligible u),
     totals as (
       select date_trunc(${unit}, observed_at at time zone ${timezone}) as bucket,
         sum(total_tokens)::float8 as tokens, count(*)::int as attempts,
         bool_or(total_tokens is null or usage_accuracy <> 'provider_reported') as partial
       from eligible group by 1
     ), buckets as (
       select generate_series(date_trunc(${unit}, ${from}::timestamptz at time zone ${timezone}),
         date_trunc(${unit}, (${to}::timestamptz - interval '1 microsecond') at time zone ${timezone}), ${step}::interval) as bucket
     ) select (select row_to_json(summary) from summary) as tokens,
         (select count(distinct question_id)::int from eligible) as "linkedQuestions",
         jsonb_agg(jsonb_build_object(
           'start', to_char(b.bucket at time zone ${timezone} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'totalTokens', t.tokens, 'recordedAttempts', coalesce(t.attempts, 0), 'partial', coalesce(t.partial, true))
           order by b.bucket) as "tokenTimeline"
       from buckets b left join totals t using (bucket)`,
    values
  );
  return result.rows[0]!;
};

// The caller must authorize the question before passing its decrypted worker job.
// No fallback is used for list rows or aggregate charts, and nothing is persisted.
export const loadRecallDetailUsage = async (
  pool: pg.Pool,
  actor: ActorContext,
  questionId: string,
  legacyJobId: string | null
): Promise<RecallUsage> => {
  const read = async (legacy: boolean) =>
    pool.query<UsageRow>(
      `select u.id, u.observed_at, u.connector_client, u.model, u.usage_accuracy,
       u.input_tokens, u.cached_input_tokens, u.output_tokens, u.reasoning_output_tokens, u.total_tokens,
       u.metadata->>'executionStatus' as execution_status,
       exists (select 1 from workflow_token_usage_source_references other
         where other.workflow_token_usage_id = u.id and
          ((other.source_type = 'question' and other.source_id <> $2)
           or (other.source_type = 'answer_job' and other.source_id <> u.workflow_id))) as conflict
     from workflow_token_usage u
     where u.owner_user_id = $1 and ${recallUsageEligibility}
       and ${
         legacy
           ? "u.workflow_id = $3"
           : `exists (select 1 from workflow_token_usage_source_references ref
         where ref.workflow_token_usage_id = u.id and ref.source_type = 'question' and ref.source_id = $2)`
       }
     order by u.observed_at, u.id limit 201`,
      legacy
        ? [actor.userId, questionId, legacyJobId]
        : [actor.userId, questionId]
    );
  let rows = (await read(false)).rows;
  let provenance: RecallUsage["provenance"] = "linked";
  if (!rows.length && legacyJobId) {
    rows = (await read(true)).rows;
    provenance = "historical_job";
  }
  const ambiguous = rows.some((row) => row.conflict);
  const attempts = rows
    .slice(0, 200)
    .filter((row) => !row.conflict)
    .map((row): RecallUsageAttempt => ({
      id: row.id,
      observedAt: row.observed_at.toISOString(),
      worker: row.connector_client?.slice(0, 100) ?? null,
      model: row.model?.slice(0, 512) ?? null,
      accuracy: row.usage_accuracy,
      status:
        row.execution_status === "succeeded" ||
        row.execution_status === "failed"
          ? row.execution_status
          : "unknown",
      inputTokens: count(row.input_tokens),
      cachedInputTokens: count(row.cached_input_tokens),
      outputTokens: count(row.output_tokens),
      reasoningOutputTokens: count(row.reasoning_output_tokens),
      totalTokens: count(row.total_tokens)
    }));
  return summarizeRecallAttempts(
    attempts,
    rows.length ? provenance : "unavailable",
    rows.length > 200,
    ambiguous
  );
};
