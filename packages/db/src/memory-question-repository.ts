import pg from "pg";
import { truncateDisplayText } from "./value-helpers.js";
import type {
  ActorContext,
  MemoryQuestionDetailRecord,
  MemoryQuestionRetrievalScope,
  MemoryQuestionSearchDomain,
  MemoryQuestionShellRecord,
  MemoryQuestionStatus,
  Visibility
} from "./types.js";

export interface MemoryQuestionRepository {
  createMemoryQuestion(
    actor: ActorContext,
    input: {
      query: string;
      retrievalScope?: MemoryQuestionRetrievalScope;
      searchDomain: MemoryQuestionSearchDomain;
      workspaceId?: string;
      projectName?: string;
      projectPath?: string;
      sessionId?: string;
      threadId?: string;
      threadName?: string;
      localMemoryWorkerConfig?: Record<string, unknown>;
    }
  ): Promise<MemoryQuestionDetailRecord>;
  listMemoryQuestions(
    actor: ActorContext,
    input?: {
      query?: string;
      searchDomain?: MemoryQuestionSearchDomain;
      status?: MemoryQuestionStatus;
      workspaceId?: string;
      sessionId?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<MemoryQuestionShellRecord[]>;
  claimPendingMemoryQuestions(
    actor: ActorContext,
    input?: {
      questionId?: string;
      limit?: number;
      leaseSeconds?: number;
    }
  ): Promise<MemoryQuestionDetailRecord[]>;
  getMemoryQuestion(
    actor: ActorContext,
    questionId: string
  ): Promise<MemoryQuestionDetailRecord | null>;
  updateMemoryQuestion(
    actor: ActorContext,
    questionId: string,
    input:
      | {
          status: "answered";
          answerMarkdown: string;
          attemptCount?: number;
          response?: Record<string, unknown>;
          evidence?: unknown[];
          citations?: unknown[];
          retrieval?: Record<string, unknown>;
          localMemoryWorker?: Record<string, unknown>;
        }
      | {
          status: "error";
          errorMessage: string;
          attemptCount?: number;
          response?: Record<string, unknown>;
          retrieval?: Record<string, unknown>;
          localMemoryWorker?: Record<string, unknown>;
        }
      | {
          status: "pending";
          lastErrorMessage: string;
          attemptCount?: number;
          response?: Record<string, unknown>;
          evidence?: unknown[];
          citations?: unknown[];
          retrieval?: Record<string, unknown>;
          localMemoryWorker?: Record<string, unknown>;
        }
  ): Promise<MemoryQuestionDetailRecord | null>;
}

type MemoryQuestionShellRow = {
  id: string;
  owner_user_id: string;
  visibility: Visibility;
  retrieval_scope: MemoryQuestionRetrievalScope;
  search_domain: MemoryQuestionSearchDomain;
  workspace_id: string | null;
  project_name: string | null;
  project_path: string | null;
  session_id: string | null;
  thread_id: string | null;
  thread_name: string | null;
  query: string;
  answer_markdown?: string | null;
  answer_preview?: string | null;
  error_message: string | null;
  status: MemoryQuestionStatus;
  created_at: Date;
  updated_at: Date;
  answered_at: Date | null;
  processing_started_at: Date | null;
  processing_lease_until: Date | null;
  attempt_count: string | number | null;
  last_error_message: string | null;
  evidence_count?: string | number | null;
};

type MemoryQuestionDetailRow = MemoryQuestionShellRow & {
  answer_markdown: string | null;
  evidence: unknown[] | null;
  citations: unknown[] | null;
  retrieval: Record<string, unknown> | null;
  local_memory_worker: Record<string, unknown> | null;
  local_memory_worker_config: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
};

const previewMarkdown = (value: string | null): string | null =>
  value ? truncateDisplayText(value, 280) : null;

const mapMemoryQuestionShell = (
  row: MemoryQuestionShellRow
): MemoryQuestionShellRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  visibility: row.visibility,
  retrievalScope: row.retrieval_scope,
  searchDomain: row.search_domain,
  workspaceId: row.workspace_id,
  projectName: row.project_name,
  projectPath: row.project_path,
  sessionId: row.session_id,
  threadId: row.thread_id,
  threadName: row.thread_name,
  query: row.query,
  answerPreview:
    row.answer_preview ?? previewMarkdown(row.answer_markdown ?? null),
  errorMessage: row.error_message,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  answeredAt: row.answered_at?.toISOString() ?? null,
  processingStartedAt: row.processing_started_at?.toISOString() ?? null,
  processingLeaseUntil: row.processing_lease_until?.toISOString() ?? null,
  attemptCount: Number(row.attempt_count ?? 0),
  lastErrorMessage: row.last_error_message,
  evidenceCount: Number(row.evidence_count ?? 0)
});

const mapMemoryQuestionDetail = (
  row: MemoryQuestionDetailRow
): MemoryQuestionDetailRecord => ({
  ...mapMemoryQuestionShell(row),
  answerMarkdown: row.answer_markdown,
  evidence: row.evidence,
  citations: row.citations,
  retrieval: row.retrieval,
  localMemoryWorker: row.local_memory_worker,
  localMemoryWorkerConfig: row.local_memory_worker_config,
  response: row.response
});

export const createMemoryQuestionRepository = (
  pool: pg.Pool
): MemoryQuestionRepository => ({
  async createMemoryQuestion(actor, input) {
    const result = await pool.query<MemoryQuestionDetailRow>(
      `
        insert into memory_questions (
          owner_user_id,
          visibility,
          retrieval_scope,
          search_domain,
          workspace_id,
          project_name,
          project_path,
          session_id,
          thread_id,
          thread_name,
          query,
          local_memory_worker_config
        )
        values ($1, 'personal', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        returning
          id, owner_user_id, visibility, retrieval_scope, search_domain,
          workspace_id, project_name, project_path, session_id, thread_id,
          thread_name, query, answer_markdown, error_message, evidence,
          citations, retrieval, local_memory_worker, local_memory_worker_config,
          response, status, created_at, updated_at, answered_at,
          processing_started_at, processing_lease_until, attempt_count,
          last_error_message,
          jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
      `,
      [
        actor.userId,
        input.retrievalScope ?? "personal",
        input.searchDomain,
        input.workspaceId ?? null,
        input.projectName ?? null,
        input.projectPath ?? null,
        input.sessionId ?? null,
        input.threadId ?? null,
        input.threadName ?? null,
        input.query,
        input.localMemoryWorkerConfig
          ? JSON.stringify(input.localMemoryWorkerConfig)
          : null
      ]
    );

    return mapMemoryQuestionDetail(result.rows[0]!);
  },

  async listMemoryQuestions(actor, input = {}) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const result = await pool.query<MemoryQuestionShellRow>(
      `
        select
          id, owner_user_id, visibility, retrieval_scope, search_domain,
          workspace_id, project_name, project_path, session_id, thread_id,
          thread_name, query, left(answer_markdown, 280) as answer_preview,
          error_message, status, created_at, updated_at, answered_at,
          processing_started_at, processing_lease_until, attempt_count,
          last_error_message,
          jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
        from memory_questions
        where owner_user_id = $1
          and visibility = 'personal'
          and ($2::memory_search_domain is null or search_domain = $2)
          and ($3::text is null or workspace_id = $3)
          and ($4::uuid is null or session_id = $4)
          and ($8::memory_question_status is null or status = $8)
          and (
            $5::text is null
            or query ilike '%' || $5 || '%'
            or coalesce(answer_markdown, '') ilike '%' || $5 || '%'
            or coalesce(error_message, '') ilike '%' || $5 || '%'
            or coalesce(project_name, '') ilike '%' || $5 || '%'
            or coalesce(thread_name, '') ilike '%' || $5 || '%'
          )
        order by created_at desc, id desc
        limit $6 offset $7
      `,
      [
        actor.userId,
        input.searchDomain ?? null,
        input.workspaceId ?? null,
        input.sessionId ?? null,
        input.query?.trim() || null,
        limit,
        offset,
        input.status ?? null
      ]
    );

    return result.rows.map(mapMemoryQuestionShell);
  },

  async claimPendingMemoryQuestions(actor, input = {}) {
    const limit = Math.min(Math.max(input.limit ?? 1, 1), 10);
    const leaseSeconds = Math.min(
      Math.max(input.leaseSeconds ?? 180, 30),
      3600
    );
    const result = await pool.query<MemoryQuestionDetailRow>(
      `
        with candidates as (
          select id
          from memory_questions
          where owner_user_id = $1
            and visibility = 'personal'
            and status = 'pending'
            and ($2::uuid is null or id = $2)
            and (
              processing_lease_until is null
              or processing_lease_until < now()
            )
          order by created_at asc, id asc
          limit $3
          for update skip locked
        )
        update memory_questions question
        set
          processing_started_at = now(),
          processing_lease_until = now() + ($4::int * interval '1 second'),
          attempt_count = attempt_count + 1,
          last_error_message = null,
          updated_at = now()
        from candidates
        where question.id = candidates.id
        returning
          question.id, question.owner_user_id,
          question.visibility, question.retrieval_scope, question.search_domain,
          question.workspace_id, question.project_name, question.project_path,
          question.session_id, question.thread_id, question.thread_name,
          question.query, question.answer_markdown, question.error_message,
          question.evidence, question.citations, question.retrieval,
          question.local_memory_worker, question.local_memory_worker_config,
          question.response, question.status, question.created_at,
          question.updated_at, question.answered_at,
          question.processing_started_at, question.processing_lease_until,
          question.attempt_count, question.last_error_message,
          jsonb_array_length(coalesce(question.evidence, '[]'::jsonb)) as evidence_count
      `,
      [actor.userId, input.questionId ?? null, limit, leaseSeconds]
    );

    return result.rows.map(mapMemoryQuestionDetail);
  },

  async getMemoryQuestion(actor, questionId) {
    const result = await pool.query<MemoryQuestionDetailRow>(
      `
        select
          id, owner_user_id, visibility, retrieval_scope, search_domain,
          workspace_id, project_name, project_path, session_id, thread_id,
          thread_name, query, answer_markdown, error_message, evidence,
          citations, retrieval, local_memory_worker, local_memory_worker_config,
          response, status,
          created_at, updated_at, answered_at, processing_started_at,
          processing_lease_until, attempt_count, last_error_message,
          jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
        from memory_questions
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
        limit 1
      `,
      [actor.userId, questionId]
    );

    return result.rows[0] ? mapMemoryQuestionDetail(result.rows[0]) : null;
  },

  async updateMemoryQuestion(actor, questionId, input) {
    const result = await pool.query<MemoryQuestionDetailRow>(
      `
        update memory_questions
        set
          status = $3::memory_question_status,
          answer_markdown = case when $3::text = 'answered' then $4 else null end,
          error_message = case when $3::text = 'error' then $5 else null end,
          response = coalesce($6::jsonb, response),
          evidence = coalesce($7::jsonb, evidence),
          citations = coalesce($8::jsonb, citations),
          retrieval = coalesce($9::jsonb, retrieval),
          local_memory_worker = coalesce($10::jsonb, local_memory_worker),
          processing_lease_until = null,
          processing_started_at = case
            when $3::text = 'pending' then null
            else processing_started_at
          end,
          last_error_message = case
            when $3::text = 'error' then $5
            when $3::text = 'pending' then $12
            else null
          end,
          answered_at = case
            when $3::text in ('answered', 'error') then now()
            else null
          end,
          updated_at = now()
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
          and status = 'pending'
          and (
            ($11::int is not null and attempt_count = $11)
            or ($11::int is null and processing_lease_until is null)
          )
        returning
          id, owner_user_id, visibility, retrieval_scope, search_domain,
          workspace_id, project_name, project_path, session_id, thread_id,
          thread_name, query, answer_markdown, error_message, evidence,
          citations, retrieval, local_memory_worker, local_memory_worker_config,
          response, status,
          created_at, updated_at, answered_at, processing_started_at,
          processing_lease_until, attempt_count, last_error_message,
          jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
      `,
      [
        actor.userId,
        questionId,
        input.status,
        input.status === "answered" ? input.answerMarkdown : null,
        input.status === "error" ? input.errorMessage : null,
        input.response ? JSON.stringify(input.response) : null,
        "evidence" in input && input.evidence
          ? JSON.stringify(input.evidence)
          : null,
        "citations" in input && input.citations
          ? JSON.stringify(input.citations)
          : null,
        input.retrieval ? JSON.stringify(input.retrieval) : null,
        input.localMemoryWorker
          ? JSON.stringify(input.localMemoryWorker)
          : null,
        input.attemptCount ?? null,
        input.status === "pending" ? input.lastErrorMessage : null
      ]
    );

    return result.rows[0] ? mapMemoryQuestionDetail(result.rows[0]) : null;
  }
});
