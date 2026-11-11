import type {
  RecallActivityListInput,
  RecallActivityOverview,
  RecallActivityOverviewInput
} from "@koed/shared";
import type { ActorContext } from "./types.js";

// Workspace deletion clears the FK, but keeps Team authority. Both exclusions
// are intentional and shared by every Recall activity query.
export const personalRecallPredicate = `q.owner_user_id = $1
  and q.visibility = 'personal' and q.origin = 'mcp_memory_answer'
  and q.status in ('answered', 'error')
  and q.team_authorization is null and q.team_workspace_id is null`;

// Hourly buckets advance over real instants so a DST day has 23 or 25 hours.
// Calendar buckets stay in the selected timezone. Both queries use the same
// boundaries, including in zones whose UTC offset contains half hours.
export const recallActivityBuckets = (
  input: RecallActivityOverviewInput,
  bucket: RecallActivityOverview["bucket"],
  bind: (value: unknown) => string
) => {
  const hourly = bucket === "hour";
  const from = bind(input.from),
    to = bind(input.to);
  const timezone = hourly ? "" : bind(input.timezone),
    unit = hourly ? "" : bind(bucket);
  const step = bind(`1 ${bucket}`);
  return {
    from,
    to,
    group: (column: "created_at" | "observed_at") =>
      hourly
        ? `date_bin(${step}::interval, ${column}, ${from}::timestamptz)`
        : `date_trunc(${unit}, ${column} at time zone ${timezone})`,
    series: hourly
      ? `generate_series(${from}::timestamptz, ${to}::timestamptz - interval '1 microsecond', ${step}::interval)`
      : `generate_series(date_trunc(${unit}, ${from}::timestamptz at time zone ${timezone}), date_trunc(${unit}, (${to}::timestamptz - interval '1 microsecond') at time zone ${timezone}), ${step}::interval)`,
    start: hourly
      ? "b.bucket at time zone 'UTC'"
      : `b.bucket at time zone ${timezone} at time zone 'UTC'`
  };
};

export const recallActivityFilter = (
  actor: ActorContext,
  input: Omit<RecallActivityListInput, "cursor" | "limit">,
  includeRecordedTime = true
) => {
  const values: unknown[] = [actor.userId];
  const predicates = [personalRecallPredicate];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (includeRecordedTime) {
    predicates.push(`q.created_at >= ${bind(input.from)}::timestamptz`);
    predicates.push(`q.created_at < ${bind(input.to)}::timestamptz`);
  }
  if (input.searchDomain)
    predicates.push(`q.search_domain = ${bind(input.searchDomain)}`);
  if (input.status) predicates.push(`q.status = ${bind(input.status)}`);
  if (input.projectId)
    predicates.push(`q.project_id = ${bind(input.projectId)}`);
  if (input.sessionId)
    predicates.push(`q.session_id = ${bind(input.sessionId)}::uuid`);
  if (input.memoryStatus) {
    const outcome =
      "case when q.status='answered' then q.recall_metadata->>'memoryStatus' end";
    predicates.push(
      input.memoryStatus === "unknown"
        ? `(${outcome}) is null`
        : `(${outcome}) = ${bind(input.memoryStatus)}`
    );
  }
  if (input.callerName !== undefined)
    predicates.push(
      input.callerName === ""
        ? "q.recall_metadata->'caller'->>'name' is null"
        : `q.recall_metadata->'caller'->>'name' = ${bind(input.callerName)}`
    );
  if (input.minDurationMs !== undefined)
    predicates.push(
      `(q.recall_metadata->'timing'->>'durationMs')::bigint >= ${bind(input.minDurationMs)}`
    );
  if (input.maxDurationMs !== undefined)
    predicates.push(
      `(q.recall_metadata->'timing'->>'durationMs')::bigint <= ${bind(input.maxDurationMs)}`
    );
  return { values, predicates, bind };
};
