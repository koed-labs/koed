import { recallQuestionMetadataSchema } from "@koed/shared";
import {
  personalRecallPredicate,
  recallActivityFilter
} from "./recall-activity-query.js";
import {
  recallActivityOverviewInputSchema,
  type RecallActivityOverviewInput,
  type RecallActivityOverview
} from "@koed/shared";
import type pg from "pg";
import {
  recallActivityListInputSchema,
  type EnvelopeEncryptionProvider,
  type RecallActivityListInput,
  type RecallActivityPage,
  type RecallActivityQuestion
} from "@koed/shared";
import type { RecallActivityDetail } from "@koed/shared";
import type { ActorContext } from "./types.js";
import { decryptAuthorizedEncryptedFieldPayloadWithClient } from "./encrypted-payload-repository.js";
import { createMemoryQuestionRepository } from "./memory-question-repository.js";
import {
  loadRecallDetailUsage,
  loadLinkedRecallUsage,
  loadRecallTokenOverview,
  unknownRecallUsage
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
    const bucket = days <= 90 ? "day" : days <= 730 ? "week" : "month";
    const unit = bind(bucket);
    const timezone = bind(input.timezone);
    const from = bind(input.from);
    const to = bind(input.to);
    const step = bind(`1 ${bucket}`);
    const result = await pool.query<{
      recordedQuestions: number;
      recordedErrors: number;
      questions: RecallActivityOverview["questions"];
      memoryResults: RecallActivityOverview["memoryResults"];
      knownDurations: number;
      medianDurationMs: number | null;
    }>(
      `with eligible as (
         select q.created_at, q.status,
           case when q.status='answered' then q.recall_metadata->>'memoryStatus' end as outcome,
           (q.recall_metadata->'timing'->>'durationMs')::bigint as duration
         from memory_questions q where ${predicates.join(" and ")}
       ), totals as (
         select date_trunc(${unit}, created_at at time zone ${timezone}) as bucket,
           count(*)::int as count, count(*) filter (where status = 'error')::int as errors,
           count(*) filter (where outcome='found')::int as found,
           count(*) filter (where outcome='not_found')::int as not_found,
           count(*) filter (where outcome='insufficient')::int as insufficient,
           count(*) filter (where outcome='pending_summary')::int as pending_summary,
           count(*) filter (where outcome is null)::int as unknown
         from eligible group by 1
       ), buckets as (
         select generate_series(
           date_trunc(${unit}, ${from}::timestamptz at time zone ${timezone}),
           date_trunc(${unit}, (${to}::timestamptz - interval '1 microsecond') at time zone ${timezone}),
           ${step}::interval) as bucket
       ) select (select count(*)::int from eligible) as "recordedQuestions",
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
            'start', to_char(b.bucket at time zone ${timezone} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
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
    return {
      ...result.rows[0]!,
      ...tokenOverview,
      asOf: new Date().toISOString(),
      timezone: input.timezone,
      bucket
    };
  },
  async getRecallActivity(actor, questionId) {
    const eligible = await pool.query<{ id: string; recall_metadata: unknown }>(
      `select q.id, q.recall_metadata from memory_questions q where ${personalRecallPredicate} and q.id = $2`,
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
        metadata: eligible.rows[0].recall_metadata
          ? recallQuestionMetadataSchema.parse(eligible.rows[0].recall_metadata)
          : null,
        id: detail.id,
        recordedAt: detail.createdAt,
        updatedAt: detail.updatedAt,
        query: detail.query,
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
    const result = await pool.query<RecallActivityQuestion>(
      `select q.id, q.query, q.recall_metadata as metadata, q.search_domain as "searchDomain", q.status,
         q.project_id as "projectId", q.project_name as "projectName", q.session_id as "sessionId",
         to_char(q.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt",
         to_char(q.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
       from memory_questions q where ${predicates.join(" and ")}
       order by q.created_at desc, q.id desc limit ${bind(input.limit + 1)}`,
      values
    );
    const questions = result.rows.slice(0, input.limit);
    const usage = await loadLinkedRecallUsage(
      pool,
      actor,
      questions.map((question) => question.id)
    );
    for (const question of questions)
      question.usage = usage.get(question.id) ?? unknownRecallUsage();
    // Decrypt only selected question text, with bounded concurrency. No answer,
    // Evidence Bundle, or worker payload is hydrated for a history row.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, questions.length) }, async () => {
        while (next < questions.length) {
          const question = questions[next++]!;
          if (
            input.hydrate === false ||
            (input.contentIds && !input.contentIds.includes(question.id))
          ) {
            question.query = null;
            continue;
          }
          if (question.query !== "[koed encrypted memory question]") continue;
          if (!options.envelopeEncryptionProvider)
            throw new Error("Question encryption is unavailable");
          const decrypted =
            await decryptAuthorizedEncryptedFieldPayloadWithClient(
              pool,
              actor,
              options.envelopeEncryptionProvider,
              {
                sourceTable: "memory_questions",
                sourceId: question.id,
                sourceColumn: "query"
              }
            );
          if (typeof decrypted?.plaintext !== "string")
            throw new Error("Question content is unavailable");
          question.query = decrypted.plaintext;
        }
      })
    );
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
