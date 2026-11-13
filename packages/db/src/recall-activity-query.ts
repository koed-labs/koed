import {
  RECALL_CALLER_LABEL_CHARACTERS,
  RECALL_CALLER_NAME_MAX_LENGTH,
  RECALL_CALLER_VERSION_MAX_LENGTH,
  type RecallActivityListInput,
  type RecallActivityOverview,
  type RecallActivityOverviewInput,
  type RecallQuestionMetadata
} from "@koed-labs/shared";
import type { ActorContext } from "./types.js";

// Recall metadata is validated in one place: the SQL below. Filters, totals and
// timelines use these expressions, and a displayed row is built from the same
// expressions' output (recallMetadataColumns and recallMetadataFromRow), with
// no second check in TypeScript. A row therefore cannot display one value and
// count as another.
//
// The rule: only version 1 metadata is read. Each field is then read on its
// own, and a missing or wrongly shaped value is unknown. Every value these
// expressions accept also passes recallQuestionMetadataSchema.
//
// CASE fixes evaluation order, so each cast below runs only after the checks
// that make it safe. Stored text can make a value unknown but not fail a query.
const metadata = "q.recall_metadata";
const readable = `coalesce(${metadata}->'version' = '1'::jsonb, false)`;

const statusText = `${metadata}->>'memoryStatus'`;
const memoryStatus = `case when ${readable}
  and jsonb_typeof(${metadata}->'memoryStatus') = 'string'
  and ${statusText} in ('found', 'not_found', 'insufficient', 'pending_summary')
  then ${statusText} end`;
// Writers record a result only for answered questions. Reading it the same way
// keeps a displayed result equal to the result that is filtered and counted.
const outcome = `case when q.status = 'answered' then ${memoryStatus} end`;

// The same test as recallCallerSchema: listed ASCII characters, no outer space.
const callerLabel = (key: "name" | "version", maxLength: number) => {
  const text = `${metadata}->'caller'->>'${key}'`;
  return `case when ${readable}
    and jsonb_typeof(${metadata}->'caller'->'${key}') = 'string'
    and char_length(${text}) between 1 and ${maxLength}
    and translate(${text}, '${RECALL_CALLER_LABEL_CHARACTERS}', '') = ''
    and ${text} = btrim(${text}, ' ')
    then ${text} end`;
};
const callerName = callerLabel("name", RECALL_CALLER_NAME_MAX_LENGTH);
const callerVersion = callerLabel("version", RECALL_CALLER_VERSION_MAX_LENGTH);

// Timing is the form the task repository stamps: UTC instants with millisecond
// precision and a whole duration equal to their difference. The pattern bounds
// every field except the day of the month, which realDate then checks, so the
// timestamp casts cannot fail.
const durationText = `${metadata}->'timing'->>'durationMs'`;
const acceptedAt = `${metadata}->'timing'->>'acceptedAt'`;
const completedAt = `${metadata}->'timing'->>'completedAt'`;
const instantPattern =
  "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$";
const realDate = (text: string) => {
  const year = `substring(${text} from 1 for 4)::int`;
  return `(${year} >= 1 and substring(${text} from 9 for 2)::int <=
    case substring(${text} from 6 for 2)
      when '02' then case when ${year} % 4 = 0
        and (${year} % 100 <> 0 or ${year} % 400 = 0) then 29 else 28 end
      when '04' then 30 when '06' then 30 when '09' then 30 when '11' then 30
      else 31 end)`;
};
const durationMs = `case when ${readable}
  and jsonb_typeof(${metadata}->'timing'->'durationMs') = 'number'
  and ${durationText} ~ '^[0-9]{1,9}$'
  and jsonb_typeof(${metadata}->'timing'->'acceptedAt') = 'string'
  and ${acceptedAt} ~ '${instantPattern}'
  and jsonb_typeof(${metadata}->'timing'->'completedAt') = 'string'
  and ${completedAt} ~ '${instantPattern}'
  then case when (${durationText})::int <= 604800000
    and ${realDate(acceptedAt)} and ${realDate(completedAt)}
    then case when round(extract(epoch from
        (${completedAt})::timestamptz - (${acceptedAt})::timestamptz) * 1000)
      = (${durationText})::int
      then (${durationText})::int end end end`;

export const recallMetadataSql = {
  /** The recorded Memory-found result of an answered question, else null. */
  outcome,
  callerName,
  durationMs
};

/** Select-list columns that carry one question's validated metadata. */
export const recallMetadataColumns = `${readable} as "metadataReadable",
  (${outcome}) as "metadataStatus",
  (${callerName}) as "metadataCallerName",
  (${callerVersion}) as "metadataCallerVersion",
  (${durationMs}) as "metadataDurationMs",
  ${acceptedAt} as "metadataAcceptedAt",
  ${completedAt} as "metadataCompletedAt"`;
export interface RecallMetadataColumns {
  metadataReadable: boolean;
  metadataStatus: RecallQuestionMetadata["memoryStatus"];
  metadataCallerName: string | null;
  metadataCallerVersion: string | null;
  metadataDurationMs: number | null;
  metadataAcceptedAt: string | null;
  metadataCompletedAt: string | null;
}
/** Assemble displayed metadata from recallMetadataColumns. It validates nothing. */
export const recallMetadataFromRow = (
  row: RecallMetadataColumns
): RecallQuestionMetadata | null =>
  row.metadataReadable
    ? {
        version: 1,
        memoryStatus: row.metadataStatus,
        caller:
          row.metadataCallerName === null
            ? null
            : {
                name: row.metadataCallerName,
                version: row.metadataCallerVersion
              },
        ...(row.metadataDurationMs === null
          ? {}
          : {
              timing: {
                acceptedAt: row.metadataAcceptedAt!,
                completedAt: row.metadataCompletedAt!,
                durationMs: row.metadataDurationMs
              }
            })
      }
    : null;

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
  if (input.memoryStatus)
    predicates.push(
      input.memoryStatus === "unknown"
        ? `(${recallMetadataSql.outcome}) is null`
        : `(${recallMetadataSql.outcome}) = ${bind(input.memoryStatus)}`
    );
  if (input.callerName !== undefined)
    predicates.push(
      input.callerName === ""
        ? `(${recallMetadataSql.callerName}) is null`
        : `(${recallMetadataSql.callerName}) = ${bind(input.callerName)}`
    );
  if (input.minDurationMs !== undefined)
    predicates.push(
      `(${recallMetadataSql.durationMs}) >= ${bind(input.minDurationMs)}`
    );
  if (input.maxDurationMs !== undefined)
    predicates.push(
      `(${recallMetadataSql.durationMs}) <= ${bind(input.maxDurationMs)}`
    );
  return { values, predicates, bind };
};
