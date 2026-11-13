import {
  personalRecallPredicate,
  recallActivityFilter,
  recallActivityBuckets,
  recallMetadataColumns,
  recallMetadataFromRow,
  recallMetadataSql,
  type RecallMetadataColumns
} from "./recall-activity-query.js";
import {
  recallActivityOverviewInputSchema,
  type RecallActivityOverviewInput,
  type RecallActivityOverview
} from "@koed-labs/shared";
import type pg from "pg";
import {
  recallActivityListInputSchema,
  RECALL_QUERY_MAX_LENGTH,
  type EnvelopeEncryptionProvider,
  type RecallActivityListInput,
  type RecallActivityPage,
  type RecallActivityQuestion
} from "@koed-labs/shared";
import type { RecallActivityDetail } from "@koed-labs/shared";
import type { ActorContext } from "./types.js";
import {
  decryptAuthorizedEncryptedFieldPayloadsWithClient,
  encryptedFieldReferenceKey,
  type EncryptedFieldReference
} from "./encrypted-payload-repository.js";
import { createMemoryQuestionRepository } from "./memory-question-repository.js";
import {
  loadRecallDetailUsage,
  loadLinkedRecallUsage,
  loadRecallTokenOverview,
  unknownRecallUsage,
  recallQuestionUsageIncomplete
} from "./recall-activity-usage.js";

export interface RecallActivityRepository {
  getRecallActivityOverview(
    actor: ActorContext,
    input: RecallActivityOverviewInput
  ): Promise<RecallActivityOverview>;
  listRecallActivity(
    actor: ActorContext,
    input: RecallActivityListInput
  ): Promise<RecallActivityPage>;
  getRecallActivity(
    actor: ActorContext,
    questionId: string
  ): Promise<RecallActivityDetail | null>;
}

export const createRecallActivityRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider } = {}
): RecallActivityRepository => ({
  async getRecallActivityOverview(actor, rawInput) {
    const input = recallActivityOverviewInputSchema.parse(rawInput);
    const { values, predicates, bind } = recallActivityFilter(actor, input);
    const days = (Date.parse(input.to) - Date.parse(input.from)) / 86_400_000;
    const bucket =
      input.bucket ?? (days <= 90 ? "day" : days <= 730 ? "week" : "month");
    const buckets = recallActivityBuckets(input, bucket, bind);
    const result = await pool.query<{
      recordedQuestions: number;
      recordedErrors: number;
      questions: RecallActivityOverview["questions"];
      memoryResults: RecallActivityOverview["memoryResults"];
      knownDurations: number;
      medianDurationMs: number | null;
      usageIncomplete: boolean;
    }>(
      `with eligible as (
         select q.created_at, q.status,
           ${recallMetadataSql.outcome} as outcome,
           ${recallMetadataSql.durationMs} as duration,
           (${recallQuestionUsageIncomplete}) as usage_incomplete
         from memory_questions q where ${predicates.join(" and ")}
       ), totals as (
         select ${buckets.group("created_at")} as bucket,
           count(*)::int as count, count(*) filter (where status = 'error')::int as errors,
           count(*) filter (where outcome='found')::int as found,
           count(*) filter (where outcome='not_found')::int as not_found,
           count(*) filter (where outcome='insufficient')::int as insufficient,
           count(*) filter (where outcome='pending_summary')::int as pending_summary,
           count(*) filter (where outcome is null)::int as unknown
         from eligible group by 1
       ), buckets as (
         select ${buckets.series} as bucket
       ) select coalesce((select bool_or(usage_incomplete) from eligible), false) as "usageIncomplete",
          (select count(*)::int from eligible) as "recordedQuestions",
          (select count(*)::int from eligible where status = 'error') as "recordedErrors",
          (select count(duration)::int from eligible) as "knownDurations",
          (select percentile_cont(0.5) within group (order by duration) from eligible where duration is not null) as "medianDurationMs",
          (select jsonb_build_object(
            'found',count(*) filter(where outcome='found'),
            'not_found',count(*) filter(where outcome='not_found'),
            'insufficient',count(*) filter(where outcome='insufficient'),
            'pending_summary',count(*) filter(where outcome='pending_summary'),
            'unknown',count(*) filter(where outcome is null),
            'foundPercentage',100.0 * count(*) filter(where outcome='found') / nullif(count(*) filter(where outcome in ('found','not_found')),0)
          ) from eligible) as "memoryResults",
          jsonb_agg(jsonb_build_object(
            'start', to_char(${buckets.start}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'count', coalesce(t.count, 0), 'errors', coalesce(t.errors, 0),
            'found',coalesce(t.found,0),'notFound',coalesce(t.not_found,0),
            'insufficient',coalesce(t.insufficient,0),'pendingSummary',coalesce(t.pending_summary,0),'unknown',coalesce(t.unknown,0)) order by b.bucket) as questions
         from buckets b left join totals t using (bucket)`,
      values
    );
    const tokenOverview = await loadRecallTokenOverview(
      pool,
      actor,
      input,
      bucket
    );
    const { usageIncomplete, ...summary } = result.rows[0]!;
    if (usageIncomplete && tokenOverview.tokens.coverage === "recorded")
      tokenOverview.tokens.coverage = "partial";
    // Choices come from the whole date range, independent of pagination and
    // the active caller/project filters. No question content is decrypted.
    const choices = recallActivityFilter(actor, {
      from: input.from,
      to: input.to
    });
    const filterOptions = await pool.query<
      NonNullable<RecallActivityOverview["filterOptions"]>
    >(
      `with eligible as (
         select q.project_id, q.project_name, (${recallMetadataSql.callerName}) as caller
         from memory_questions q where ${choices.predicates.join(" and ")}
       ) select
         coalesce((select jsonb_agg(jsonb_build_object('projectId', project_id,
           'projectName', project_name) order by project_id) from (
             select project_id, max(project_name) as project_name from eligible
             where project_id is not null group by project_id
           ) p), '[]'::jsonb) as projects,
         coalesce((select jsonb_agg(caller order by caller) from (
           select distinct caller from eligible where caller is not null
         ) c), '[]'::jsonb) as "callerNames"`,
      choices.values
    );
    return {
      ...summary,
      ...tokenOverview,
      filterOptions: filterOptions.rows[0]!,
      asOf: new Date().toISOString(),
      timezone: input.timezone,
      bucket
    };
  },
  async getRecallActivity(actor, questionId) {
    const eligible = await pool.query<{ id: string } & RecallMetadataColumns>(
      `select q.id, ${recallMetadataColumns} from memory_questions q where ${personalRecallPredicate} and q.id = $2`,
      [actor.userId, questionId]
    );
    if (!eligible.rows[0]) return null;
    const detail = await createMemoryQuestionRepository(
      pool,
      options
    ).getMemoryQuestion({ ...actor, allowTeam: false }, questionId);
    if (!detail) return null;
    const worker = detail.localMemoryWorker ?? {};
    const number = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
    let contentTruncated = false;
    const text = (value: unknown, max: number): string | null => {
      if (typeof value !== "string") return null;
      if (value.length > max) contentTruncated = true;
      return value.slice(0, max);
    };
    const evidence = (values: unknown[] | null) => {
      if ((values?.length ?? 0) > 100) contentTruncated = true;
      return (values ?? []).slice(0, 100).map((value, index) => {
        const row =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)
            : {};
        return {
          title:
            text(row.title ?? row.label ?? row.sourceType, 512) ??
            `Evidence ${index + 1}`,
          text:
            text(
              typeof value === "string"
                ? value
                : (row.text ??
                    row.summaryText ??
                    row.summary_text ??
                    row.excerpt ??
                    row.quote ??
                    row.content),
              16_000
            ) ?? "",
          sourceId: text(
            row.sourceId ?? row.source_id ?? row.nodeId ?? row.id,
            512
          )
        };
      });
    };
    const jobId =
      typeof worker.jobId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        worker.jobId
      )
        ? worker.jobId
        : null;
    const memoryStatus = worker.memoryStatus;
    const safeFailure: Record<string, string> = {
      provider_authentication_failure:
        "The synthesis worker could not authenticate with its provider.",
      provider_execution_failure:
        "The synthesis provider could not complete the answer.",
      missing_retrieval_client: "The retrieval connection was unavailable."
    };
    const result: RecallActivityDetail = {
      question: {
        metadata: recallMetadataFromRow(eligible.rows[0]),
        id: detail.id,
        recordedAt: detail.createdAt,
        updatedAt: detail.updatedAt,
        query: text(detail.query, RECALL_QUERY_MAX_LENGTH),
        queryTruncated: detail.query.length > RECALL_QUERY_MAX_LENGTH,
        searchDomain: detail.searchDomain,
        status: detail.status === "answered" ? "answered" : "error",
        projectId: detail.projectId,
        projectName: detail.projectName,
        sessionId: detail.sessionId,
        usage:
          (await loadLinkedRecallUsage(pool, actor, [questionId])).get(
            questionId
          ) ?? unknownRecallUsage()
      },
      answer: text(detail.answerMarkdown, 256_000),
      memoryStatus:
        detail.status === "answered" &&
        (memoryStatus === "found" ||
          memoryStatus === "not_found" ||
          memoryStatus === "insufficient" ||
          memoryStatus === "pending_summary")
          ? memoryStatus
          : null,
      worker: text(worker.provider, 100),
      model: text(worker.model, 512),
      searchCount: number(worker.searchCount),
      expandCount: number(worker.expandCount),
      candidateCount: number(worker.candidateCount),
      failure:
        detail.status === "error"
          ? (safeFailure[String(worker.skippedReason)] ??
            "Answer Synthesis did not complete successfully.")
          : null,
      evidence: evidence(detail.evidence),
      citations: evidence(detail.citations),
      contentTruncated,
      usage: await loadRecallDetailUsage(pool, actor, questionId, jobId)
    };
    return result;
  },
  async listRecallActivity(actor, rawInput) {
    const input = recallActivityListInputSchema.parse(rawInput);
    const { values, predicates, bind } = recallActivityFilter(actor, input);
    if (input.cursor)
      predicates.push(`(q.created_at, q.id) <
      (${bind(input.cursor.recordedAt)}::timestamptz, ${bind(input.cursor.id)}::uuid)`);
    const result = await pool.query<
      Omit<RecallActivityQuestion, "metadata" | "usage"> & RecallMetadataColumns
    >(
      `select q.id, q.query, ${recallMetadataColumns}, q.search_domain as "searchDomain", q.status,
         q.project_id as "projectId", q.project_name as "projectName", q.session_id as "sessionId",
         to_char(q.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt",
         to_char(q.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
       from memory_questions q where ${predicates.join(" and ")}
       order by q.created_at desc, q.id desc limit ${bind(input.limit + 1)}`,
      values
    );
    const rows = result.rows.slice(0, input.limit);
    const usage = await loadLinkedRecallUsage(
      pool,
      actor,
      rows.map((row) => row.id)
    );
    const questions = rows.map((row): RecallActivityQuestion => ({
      id: row.id,
      recordedAt: row.recordedAt,
      updatedAt: row.updatedAt,
      query:
        input.hydrate === false ||
        (input.contentIds && !input.contentIds.includes(row.id))
          ? null
          : row.query,
      usage: usage.get(row.id) ?? unknownRecallUsage(),
      metadata: recallMetadataFromRow(row),
      searchDomain: row.searchDomain,
      status: row.status,
      projectId: row.projectId,
      projectName: row.projectName,
      sessionId: row.sessionId
    }));
    // Decrypt only selected question text, in one payload read for the page.
    // No answer, Evidence Bundle, or worker payload is hydrated for a history row.
    const encrypted = questions.filter(
      (question) => question.query === "[koed encrypted memory question]"
    );
    if (encrypted.length) {
      if (!options.envelopeEncryptionProvider)
        throw new Error("Question encryption is unavailable");
      const reference = (
        question: RecallActivityQuestion
      ): EncryptedFieldReference => ({
        sourceTable: "memory_questions",
        sourceId: question.id,
        sourceColumn: "query"
      });
      const payloads = await decryptAuthorizedEncryptedFieldPayloadsWithClient(
        pool,
        actor,
        options.envelopeEncryptionProvider,
        encrypted.map(reference)
      );
      for (const question of encrypted) {
        const plaintext = payloads.get(
          encryptedFieldReferenceKey(reference(question))
        )?.plaintext;
        if (typeof plaintext !== "string")
          throw new Error("Question content is unavailable");
        question.query = plaintext;
      }
    }
    for (const question of questions) {
      if (question.query === null) continue;
      question.queryTruncated = question.query.length > RECALL_QUERY_MAX_LENGTH;
      question.query = question.query.slice(0, RECALL_QUERY_MAX_LENGTH);
    }
    const last = questions.at(-1);
    return {
      questions,
      nextCursor:
        result.rows.length > input.limit && last
          ? { recordedAt: last.recordedAt, id: last.id }
          : null,
      asOf: new Date().toISOString()
    };
  }
});
