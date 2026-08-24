import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  createEncryptedPayloadRepository,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import { truncateDisplayText } from "./value-helpers.js";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import type {
  ActorContext,
  DesktopAskThreadCursor,
  DesktopAskThreadPage,
  MemoryQuestionDetailRecord,
  MemoryQuestionOrigin,
  MemoryQuestionRetrievalScope,
  MemoryQuestionSearchDomain,
  MemoryQuestionShellRecord,
  MemoryQuestionStatus,
  Visibility
} from "./types.js";

export interface MemoryQuestionRepositoryOptions {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  encryptedMemoryQuestionSearchBatchSize?: number;
}

export interface MemoryQuestionRepository {
  createPendingDesktopAsk(
    actor: ActorContext,
    input: {
      askThreadId?: string;
      idempotencyKey: string;
      query: string;
    }
  ): Promise<MemoryQuestionDetailRecord>;
  completePendingDesktopAsk(
    actor: ActorContext,
    input: {
      attemptCount?: number;
      localMemoryWorker?: Record<string, unknown>;
      questionId: string;
      response?: Record<string, unknown>;
      retrieval?: Record<string, unknown>;
    } & (
      | {
          answerMarkdown: string;
          citations?: unknown[];
          evidence?: unknown[];
          status: "answered";
        }
      | { errorMessage: string; status: "error" }
    )
  ): Promise<MemoryQuestionDetailRecord>;
  recoverPendingDesktopAsks(
    actor: ActorContext,
    input: { errorMessage: string }
  ): Promise<{ recovered: number }>;
  listDesktopAskThreads(
    actor: ActorContext,
    input?: { cursor?: DesktopAskThreadCursor; limit?: number }
  ): Promise<DesktopAskThreadPage>;
  getDesktopAskThread(
    actor: ActorContext,
    askThreadId: string
  ): Promise<MemoryQuestionDetailRecord[]>;
  createFinalMemoryQuestion(
    actor: ActorContext,
    input: {
      idempotencyKey: string;
      query: string;
      origin?: MemoryQuestionOrigin;
      retrievalScope?: MemoryQuestionRetrievalScope;
      teamWorkspaceId?: string;
      searchDomain: MemoryQuestionSearchDomain;
      projectId?: string;
      projectName?: string;
      projectPath?: string;
      sessionId?: string;
      threadId?: string;
      threadName?: string;
      attemptCount?: number;
      response?: Record<string, unknown>;
      retrieval?: Record<string, unknown>;
      localMemoryWorker?: Record<string, unknown>;
    } & (
      | {
          status: "answered";
          answerMarkdown: string;
          evidence?: unknown[];
          citations?: unknown[];
        }
      | {
          status: "error";
          errorMessage: string;
        }
    )
  ): Promise<MemoryQuestionDetailRecord>;
  listMemoryQuestions(
    actor: ActorContext,
    input?: {
      query?: string;
      searchDomain?: MemoryQuestionSearchDomain;
      status?: MemoryQuestionStatus;
      projectId?: string;
      sessionId?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<MemoryQuestionShellRecord[]>;
  getMemoryQuestion(
    actor: ActorContext,
    questionId: string
  ): Promise<MemoryQuestionDetailRecord | null>;
}

type MemoryQuestionShellRow = {
  id: string;
  owner_user_id: string;
  visibility: Visibility;
  origin: MemoryQuestionOrigin;
  retrieval_scope: MemoryQuestionRetrievalScope;
  team_workspace_id: string | null;
  search_domain: MemoryQuestionSearchDomain;
  project_id: string | null;
  project_name: string | null;
  project_path: string | null;
  session_id: string | null;
  thread_id: string | null;
  thread_name: string | null;
  ask_thread_id: string | null;
  ask_turn_index: string | number | null;
  query: string;
  answer_markdown?: string | null;
  answer_preview?: string | null;
  error_message: string | null;
  status: MemoryQuestionStatus;
  created_at: Date;
  updated_at: Date;
  answered_at: Date | null;
  attempt_count: string | number | null;
  evidence?: unknown[] | null;
  evidence_count?: string | number | null;
};

type MemoryQuestionDetailRow = MemoryQuestionShellRow & {
  answer_markdown: string | null;
  evidence: unknown[] | null;
  citations: unknown[] | null;
  retrieval: Record<string, unknown> | null;
  local_memory_worker: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
};

type DesktopAskThreadRow = MemoryQuestionShellRow & {
  latest_question_id: string;
  latest_status: MemoryQuestionStatus;
  latest_updated_at: string;
  turn_count: string | number;
};

const ENCRYPTED_MEMORY_QUESTION_TEXT = "[koed encrypted memory question]";

const encryptedMemoryQuestionJsonMarker = (): Record<string, unknown> => ({
  contentEncrypted: true,
  encryptedSourceTable: "memory_questions"
});

const encryptedMemoryQuestionArrayMarker = (): Record<string, unknown>[] => [
  encryptedMemoryQuestionJsonMarker()
];

const isEncryptedMemoryQuestionJsonMarker = (value: unknown): boolean =>
  Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).contentEncrypted === true &&
    (value as Record<string, unknown>).encryptedSourceTable ===
      "memory_questions"
  );

const isEncryptedMemoryQuestionArrayMarker = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 1 &&
  isEncryptedMemoryQuestionJsonMarker(value[0]);

const memoryQuestionSensitiveFieldsRequireEncryption = (): boolean => true;

type MemoryQuestionEncryptedColumn =
  | "query"
  | "answer_markdown"
  | "error_message"
  | "evidence"
  | "citations"
  | "retrieval"
  | "local_memory_worker"
  | "response";

const previewMarkdown = (value: string | null): string | null =>
  value ? truncateDisplayText(value, 280) : null;

const mapMemoryQuestionShell = (
  row: MemoryQuestionShellRow
): MemoryQuestionShellRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  visibility: row.visibility,
  origin: row.origin,
  retrievalScope: row.retrieval_scope,
  teamWorkspaceId: row.team_workspace_id,
  searchDomain: row.search_domain,
  projectId: row.project_id,
  projectName: row.project_name,
  projectPath: row.project_path,
  sessionId: row.session_id,
  threadId: row.thread_id,
  threadName: row.thread_name,
  askThreadId: row.ask_thread_id,
  askTurnIndex: row.ask_turn_index === null ? null : Number(row.ask_turn_index),
  query: row.query,
  answerPreview:
    row.answer_preview ?? previewMarkdown(row.answer_markdown ?? null),
  errorMessage: row.error_message,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  answeredAt: row.answered_at?.toISOString() ?? null,
  attemptCount: Number(row.attempt_count ?? 0),
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
  response: row.response
});

export const createMemoryQuestionRepository = (
  pool: pg.Pool,
  options: MemoryQuestionRepositoryOptions = {}
): MemoryQuestionRepository => {
  const encryptedPayloadRepository = createEncryptedPayloadRepository(pool);
  const encryptedSearchBatchSize = Math.min(
    Math.max(options.encryptedMemoryQuestionSearchBatchSize ?? 500, 1),
    500
  );

  const persistEncryptedQuestionField = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    input: {
      questionId: string;
      visibility: Visibility;
      sourceColumn: MemoryQuestionEncryptedColumn;
      plaintext: unknown;
    }
  ): Promise<void> => {
    if (input.plaintext === undefined || input.plaintext === null) {
      return;
    }
    if (!options.envelopeEncryptionProvider) {
      throw new Error(
        "Envelope encryption provider is required when plaintext Memory Question storage is disabled"
      );
    }
    await upsertEncryptedFieldPayloadWithClient(
      client,
      actor,
      options.envelopeEncryptionProvider,
      {
        sourceTable: "memory_questions",
        sourceId: input.questionId,
        sourceColumn: input.sourceColumn,
        plaintext: input.plaintext,
        visibility: input.visibility,
        rowFamily: "memory_question",
        scope: {
          tenantId: actor.userId,
          objectClass: "memory_question"
        },
        aad: {
          questionId: input.questionId
        }
      }
    );
  };

  const persistEncryptedQuestionFields = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    questionId: string,
    visibility: Visibility,
    fields: Partial<Record<MemoryQuestionEncryptedColumn, unknown>>
  ): Promise<void> => {
    for (const [sourceColumn, plaintext] of Object.entries(fields)) {
      await persistEncryptedQuestionField(client, actor, {
        questionId,
        visibility,
        sourceColumn: sourceColumn as MemoryQuestionEncryptedColumn,
        plaintext
      });
    }
  };

  const decryptQuestionField = async (
    actor: ActorContext,
    row: MemoryQuestionShellRow,
    sourceColumn: MemoryQuestionEncryptedColumn
  ): Promise<unknown> => {
    if (!options.envelopeEncryptionProvider) {
      throw new Error(
        "Envelope encryption provider is required to expand encrypted Memory Questions"
      );
    }
    const decrypted =
      await encryptedPayloadRepository.decryptAuthorizedEncryptedField(
        actor,
        options.envelopeEncryptionProvider,
        {
          sourceTable: "memory_questions",
          sourceId: row.id,
          sourceColumn
        }
      );
    if (!decrypted) {
      throw new Error(`Encrypted Memory Question ${sourceColumn} is missing`);
    }
    return decrypted.plaintext;
  };

  const hydrateQuestionRow = async <T extends MemoryQuestionShellRow>(
    actor: ActorContext,
    row: T
  ): Promise<T> => {
    const hydrated: MemoryQuestionShellRow = { ...row };
    if (row.query === ENCRYPTED_MEMORY_QUESTION_TEXT) {
      const plaintext = await decryptQuestionField(actor, row, "query");
      if (typeof plaintext !== "string") {
        throw new Error("Encrypted Memory Question query is invalid");
      }
      hydrated.query = plaintext;
    }
    if (row.answer_markdown === ENCRYPTED_MEMORY_QUESTION_TEXT) {
      const plaintext = await decryptQuestionField(
        actor,
        row,
        "answer_markdown"
      );
      if (typeof plaintext !== "string") {
        throw new Error("Encrypted Memory Question answer_markdown is invalid");
      }
      hydrated.answer_markdown = plaintext;
      hydrated.answer_preview = previewMarkdown(plaintext);
    }
    if (row.error_message === ENCRYPTED_MEMORY_QUESTION_TEXT) {
      const plaintext = await decryptQuestionField(actor, row, "error_message");
      if (typeof plaintext !== "string") {
        throw new Error("Encrypted Memory Question error_message is invalid");
      }
      hydrated.error_message = plaintext;
    }
    if ("evidence" in hydrated) {
      const detail = hydrated as MemoryQuestionDetailRow;
      if (isEncryptedMemoryQuestionArrayMarker(detail.evidence)) {
        const plaintext = await decryptQuestionField(actor, row, "evidence");
        if (!Array.isArray(plaintext)) {
          throw new Error("Encrypted Memory Question evidence is invalid");
        }
        detail.evidence = plaintext;
        hydrated.evidence_count = plaintext.length;
      }
      if (isEncryptedMemoryQuestionArrayMarker(detail.citations)) {
        const plaintext = await decryptQuestionField(actor, row, "citations");
        if (!Array.isArray(plaintext)) {
          throw new Error("Encrypted Memory Question citations is invalid");
        }
        detail.citations = plaintext;
      }
      for (const sourceColumn of [
        "retrieval",
        "local_memory_worker",
        "response"
      ] as const) {
        if (isEncryptedMemoryQuestionJsonMarker(detail[sourceColumn])) {
          const plaintext = await decryptQuestionField(
            actor,
            row,
            sourceColumn
          );
          if (
            !plaintext ||
            typeof plaintext !== "object" ||
            Array.isArray(plaintext)
          ) {
            throw new Error(
              `Encrypted Memory Question ${sourceColumn} is invalid`
            );
          }
          detail[sourceColumn] = plaintext as Record<string, unknown>;
        }
      }
    }

    return hydrated as T;
  };

  return {
    async createPendingDesktopAsk(actor, input) {
      const suppressPlaintextPayload =
        memoryQuestionSensitiveFieldsRequireEncryption();
      if (suppressPlaintextPayload && !options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required when plaintext Memory Question storage is disabled"
        );
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const existing = await client.query<MemoryQuestionDetailRow>(
          `
            select
              id, owner_user_id, visibility, origin, retrieval_scope,
              team_workspace_id, search_domain, project_id, project_name,
              project_path, session_id, thread_id, thread_name, ask_thread_id,
              ask_turn_index, query, answer_markdown, error_message, evidence,
              citations, retrieval, local_memory_worker, response, status,
              created_at, updated_at, answered_at, attempt_count,
              jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
            from memory_questions
            where owner_user_id = $1 and idempotency_key = $2
            limit 1
          `,
          [actor.userId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].origin !== "desktop_ask") {
            throw new Error("Memory Question idempotency key is unavailable");
          }
          await client.query("commit");
          return mapMemoryQuestionDetail(
            await hydrateQuestionRow(actor, existing.rows[0])
          );
        }

        const askThreadId = input.askThreadId ?? randomUUID();
        let askTurnIndex = 0;
        if (input.askThreadId) {
          await client.query(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            [askThreadId]
          );
          const thread = await client.query<{
            count: string | number;
            next_turn_index: string | number;
          }>(
            `
              select
                count(*) as count,
                coalesce(max(ask_turn_index), -1) + 1 as next_turn_index
              from memory_questions
              where owner_user_id = $1
                and visibility = 'personal'
                and origin = 'desktop_ask'
                and ask_thread_id = $2
            `,
            [actor.userId, askThreadId]
          );
          if (Number(thread.rows[0]?.count ?? 0) === 0) {
            throw new Error("Ask thread not found or not visible");
          }
          askTurnIndex = Number(thread.rows[0]!.next_turn_index);
        }

        const result = await client.query<MemoryQuestionDetailRow>(
          `
            insert into memory_questions (
              owner_user_id, visibility, origin, retrieval_scope,
              search_domain, ask_thread_id, ask_turn_index, idempotency_key,
              query, status, attempt_count
            )
            values (
              $1, 'personal', 'desktop_ask', 'personal', 'global', $2, $3, $4,
              $5, 'pending'::memory_question_status, 0
            )
            returning
              id, owner_user_id, visibility, origin, retrieval_scope,
              team_workspace_id, search_domain, project_id, project_name,
              project_path, session_id, thread_id, thread_name, ask_thread_id,
              ask_turn_index, query, answer_markdown, error_message, evidence,
              citations, retrieval, local_memory_worker, response, status,
              created_at, updated_at, answered_at, attempt_count,
              jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
          `,
          [
            actor.userId,
            askThreadId,
            askTurnIndex,
            input.idempotencyKey,
            suppressPlaintextPayload
              ? ENCRYPTED_MEMORY_QUESTION_TEXT
              : input.query
          ]
        );
        const row = result.rows[0]!;
        if (suppressPlaintextPayload) {
          await persistEncryptedQuestionFields(
            client,
            actor,
            row.id,
            row.visibility,
            { query: input.query }
          );
        }
        await client.query("commit");
        return mapMemoryQuestionDetail(await hydrateQuestionRow(actor, row));
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async completePendingDesktopAsk(actor, input) {
      const suppressPlaintextPayload =
        memoryQuestionSensitiveFieldsRequireEncryption();
      if (suppressPlaintextPayload && !options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required when plaintext Memory Question storage is disabled"
        );
      }
      const answerMarkdown =
        input.status === "answered" ? input.answerMarkdown : null;
      const errorMessage = input.status === "error" ? input.errorMessage : null;
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<MemoryQuestionDetailRow>(
          `
            update memory_questions
            set
              status = $3::memory_question_status,
              answer_markdown = $4,
              error_message = $5,
              response = $6::jsonb,
              evidence = $7::jsonb,
              citations = $8::jsonb,
              retrieval = $9::jsonb,
              local_memory_worker = $10::jsonb,
              answered_at = now(),
              updated_at = now(),
              attempt_count = greatest(attempt_count, $11)
            where id = $2
              and owner_user_id = $1
              and visibility = 'personal'
              and origin = 'desktop_ask'
              and status = 'pending'
            returning
              id, owner_user_id, visibility, origin, retrieval_scope,
              team_workspace_id, search_domain, project_id, project_name,
              project_path, session_id, thread_id, thread_name, ask_thread_id,
              ask_turn_index, query, answer_markdown, error_message, evidence,
              citations, retrieval, local_memory_worker, response, status,
              created_at, updated_at, answered_at, attempt_count,
              jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
          `,
          [
            actor.userId,
            input.questionId,
            input.status,
            answerMarkdown
              ? suppressPlaintextPayload
                ? ENCRYPTED_MEMORY_QUESTION_TEXT
                : answerMarkdown
              : null,
            errorMessage
              ? suppressPlaintextPayload
                ? ENCRYPTED_MEMORY_QUESTION_TEXT
                : errorMessage
              : null,
            input.response
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionJsonMarker()
                    : input.response
                )
              : null,
            input.status === "answered" && input.evidence
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionArrayMarker()
                    : input.evidence
                )
              : null,
            input.status === "answered" && input.citations
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionArrayMarker()
                    : input.citations
                )
              : null,
            input.retrieval
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionJsonMarker()
                    : input.retrieval
                )
              : null,
            input.localMemoryWorker
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionJsonMarker()
                    : input.localMemoryWorker
                )
              : null,
            input.attemptCount ?? 1
          ]
        );
        let row = result.rows[0];
        if (!row) {
          row = (
            await client.query<MemoryQuestionDetailRow>(
              `
                select
                  id, owner_user_id, visibility, origin, retrieval_scope,
                  team_workspace_id, search_domain, project_id, project_name,
                  project_path, session_id, thread_id, thread_name,
                  ask_thread_id, ask_turn_index, query, answer_markdown,
                  error_message, evidence, citations, retrieval,
                  local_memory_worker, response, status, created_at,
                  updated_at, answered_at, attempt_count,
                  jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
                from memory_questions
                where id = $2
                  and owner_user_id = $1
                  and visibility = 'personal'
                  and origin = 'desktop_ask'
                limit 1
              `,
              [actor.userId, input.questionId]
            )
          ).rows[0];
          if (!row) throw new Error("Ask turn not found or not visible");
          if (row.status === "pending") {
            throw new Error("Ask turn completion did not change state");
          }
          await client.query("commit");
          return mapMemoryQuestionDetail(await hydrateQuestionRow(actor, row));
        }
        if (suppressPlaintextPayload) {
          await persistEncryptedQuestionFields(
            client,
            actor,
            row.id,
            row.visibility,
            {
              answer_markdown:
                input.status === "answered" ? input.answerMarkdown : undefined,
              error_message:
                input.status === "error" ? input.errorMessage : undefined,
              response: input.response,
              evidence:
                input.status === "answered" ? input.evidence : undefined,
              citations:
                input.status === "answered" ? input.citations : undefined,
              retrieval: input.retrieval,
              local_memory_worker: input.localMemoryWorker
            }
          );
        }
        await client.query("commit");
        return mapMemoryQuestionDetail(await hydrateQuestionRow(actor, row));
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async recoverPendingDesktopAsks(actor, input) {
      const suppressPlaintextPayload =
        memoryQuestionSensitiveFieldsRequireEncryption();
      if (suppressPlaintextPayload && !options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required when plaintext Memory Question storage is disabled"
        );
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<{
          id: string;
          visibility: Visibility;
        }>(
          `
            update memory_questions
            set
              status = 'error'::memory_question_status,
              error_message = $2,
              answered_at = now(),
              updated_at = now(),
              attempt_count = greatest(attempt_count, 1)
            where owner_user_id = $1
              and visibility = 'personal'
              and origin = 'desktop_ask'
              and status = 'pending'
            returning id, visibility
          `,
          [
            actor.userId,
            suppressPlaintextPayload
              ? ENCRYPTED_MEMORY_QUESTION_TEXT
              : input.errorMessage
          ]
        );
        if (suppressPlaintextPayload) {
          for (const row of result.rows) {
            await persistEncryptedQuestionFields(
              client,
              actor,
              row.id,
              row.visibility,
              { error_message: input.errorMessage }
            );
          }
        }
        await client.query("commit");
        return { recovered: result.rowCount ?? result.rows.length };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async listDesktopAskThreads(actor, input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 50);
      const cursor = input.cursor;
      const result = await pool.query<DesktopAskThreadRow>(
        `
          with ranked as (
            select
              mq.*,
              row_number() over (
                partition by mq.ask_thread_id
                order by mq.updated_at desc, mq.id desc
              ) as latest_rank,
              count(*) over (partition by mq.ask_thread_id) as turn_count
            from memory_questions mq
            where mq.owner_user_id = $1
              and mq.visibility = 'personal'
              and mq.origin = 'desktop_ask'
          )
          select
            first_question.id, first_question.owner_user_id,
            first_question.visibility, first_question.origin,
            first_question.retrieval_scope, first_question.team_workspace_id,
            first_question.search_domain, first_question.project_id,
            first_question.project_name, first_question.project_path,
            first_question.session_id, first_question.thread_id,
            first_question.thread_name, first_question.ask_thread_id,
            first_question.ask_turn_index, first_question.query,
            first_question.answer_markdown, first_question.error_message,
            first_question.status, first_question.created_at,
            first_question.updated_at, first_question.answered_at,
            first_question.attempt_count,
            jsonb_array_length(coalesce(first_question.evidence, '[]'::jsonb)) as evidence_count,
            latest.id as latest_question_id,
            latest.status as latest_status,
            to_char(
              latest.updated_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) as latest_updated_at,
            latest.turn_count
          from ranked latest
          join memory_questions first_question
            on first_question.owner_user_id = latest.owner_user_id
            and first_question.ask_thread_id = latest.ask_thread_id
            and first_question.origin = 'desktop_ask'
            and first_question.ask_turn_index = 0
          where latest.latest_rank = 1
            and (
              $2::timestamptz is null
              or (latest.updated_at, latest.id) < ($2::timestamptz, $3::uuid)
            )
          order by latest.updated_at desc, latest.id desc
          limit $4
        `,
        [
          actor.userId,
          cursor?.updatedAt ?? null,
          cursor?.latestQuestionId ?? null,
          limit + 1
        ]
      );
      const hasMore = result.rows.length > limit;
      const selected = result.rows.slice(0, limit);
      const hydrated = await Promise.all(
        selected.map((row) => hydrateQuestionRow(actor, row))
      );
      const last = selected.at(-1);
      return {
        threads: hydrated.map((row) => ({
          askThreadId: row.ask_thread_id!,
          firstQuestion: row.query,
          latestStatus: row.latest_status,
          turnCount: Number(row.turn_count),
          updatedAt: row.latest_updated_at
        })),
        nextCursor:
          hasMore && last
            ? {
                latestQuestionId: last.latest_question_id,
                updatedAt: last.latest_updated_at
              }
            : null
      };
    },

    async getDesktopAskThread(actor, askThreadId) {
      const result = await pool.query<MemoryQuestionDetailRow>(
        `
          select
            id, owner_user_id, visibility, origin, retrieval_scope,
            team_workspace_id, search_domain, project_id, project_name,
            project_path, session_id, thread_id, thread_name, ask_thread_id,
            ask_turn_index, query, answer_markdown, error_message, evidence,
            citations, retrieval, local_memory_worker, response, status,
            created_at, updated_at, answered_at, attempt_count,
            jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
          from memory_questions
          where owner_user_id = $1
            and visibility = 'personal'
            and origin = 'desktop_ask'
            and ask_thread_id = $2
          order by ask_turn_index asc, id asc
        `,
        [actor.userId, askThreadId]
      );
      return await Promise.all(
        result.rows.map(async (row) =>
          mapMemoryQuestionDetail(await hydrateQuestionRow(actor, row))
        )
      );
    },

    async createFinalMemoryQuestion(actor, input) {
      const suppressPlaintextPayload =
        memoryQuestionSensitiveFieldsRequireEncryption();
      if (suppressPlaintextPayload && !options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required when plaintext Memory Question storage is disabled"
        );
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<MemoryQuestionDetailRow>(
          `
        insert into memory_questions (
          owner_user_id,
          visibility,
          origin,
          retrieval_scope,
          team_workspace_id,
          search_domain,
          project_id,
          project_name,
          project_path,
          session_id,
          thread_id,
          thread_name,
          ask_thread_id,
          ask_turn_index,
          idempotency_key,
          query,
          status,
          answer_markdown,
          error_message,
          response,
          evidence,
          citations,
          retrieval,
          local_memory_worker,
          answered_at,
          attempt_count
        )
        values (
          $1, 'personal', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, null, null, $12, $13,
          $14::memory_question_status, $15, $16, $17::jsonb, $18::jsonb,
          $19::jsonb, $20::jsonb, $21::jsonb, now(), $22
        )
        on conflict (owner_user_id, idempotency_key) do nothing
        returning
          id, owner_user_id, visibility, origin, retrieval_scope, team_workspace_id, search_domain,
          project_id, project_name, project_path, session_id, thread_id,
          thread_name, ask_thread_id, ask_turn_index, query, answer_markdown, error_message, evidence,
          citations, retrieval, local_memory_worker, response, status,
          created_at, updated_at, answered_at, attempt_count,
          jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
      `,
          [
            actor.userId,
            input.origin ?? "mcp_memory_answer",
            input.retrievalScope ?? "personal",
            input.teamWorkspaceId ?? null,
            input.searchDomain,
            input.projectId ?? null,
            input.projectName ?? null,
            input.projectPath ?? null,
            input.sessionId ?? null,
            input.threadId ?? null,
            input.threadName ?? null,
            input.idempotencyKey,
            suppressPlaintextPayload
              ? ENCRYPTED_MEMORY_QUESTION_TEXT
              : input.query,
            input.status,
            input.status === "answered"
              ? suppressPlaintextPayload
                ? ENCRYPTED_MEMORY_QUESTION_TEXT
                : input.answerMarkdown
              : null,
            input.status === "error"
              ? suppressPlaintextPayload
                ? ENCRYPTED_MEMORY_QUESTION_TEXT
                : input.errorMessage
              : null,
            input.response
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionJsonMarker()
                    : input.response
                )
              : null,
            input.status === "answered" && input.evidence
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionArrayMarker()
                    : input.evidence
                )
              : null,
            input.status === "answered" && input.citations
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionArrayMarker()
                    : input.citations
                )
              : null,
            input.retrieval
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionJsonMarker()
                    : input.retrieval
                )
              : null,
            input.localMemoryWorker
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionJsonMarker()
                    : input.localMemoryWorker
                )
              : null,
            input.attemptCount ?? 1
          ]
        );
        const inserted = result.rows[0];
        const row =
          inserted ??
          (
            await client.query<MemoryQuestionDetailRow>(
              `
                select
                  id, owner_user_id, visibility, origin, retrieval_scope,
                  team_workspace_id, search_domain, project_id, project_name, project_path,
                  session_id, thread_id, thread_name, ask_thread_id, ask_turn_index, query, answer_markdown,
                  error_message, evidence, citations, retrieval,
                  local_memory_worker, response, status, created_at,
                  updated_at, answered_at, attempt_count,
                  jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
                from memory_questions
                where owner_user_id = $1 and idempotency_key = $2
                limit 1
              `,
              [actor.userId, input.idempotencyKey]
            )
          ).rows[0]!;
        if (inserted && suppressPlaintextPayload) {
          await persistEncryptedQuestionFields(
            client,
            actor,
            row.id,
            row.visibility,
            {
              query: input.query,
              answer_markdown:
                input.status === "answered" ? input.answerMarkdown : undefined,
              error_message:
                input.status === "error" ? input.errorMessage : undefined,
              response: input.response,
              evidence:
                input.status === "answered" ? input.evidence : undefined,
              citations:
                input.status === "answered" ? input.citations : undefined,
              retrieval: input.retrieval,
              local_memory_worker: input.localMemoryWorker
            }
          );
        }
        await client.query("commit");

        return mapMemoryQuestionDetail(await hydrateQuestionRow(actor, row));
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async listMemoryQuestions(actor, input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
      const offset = Math.max(input.offset ?? 0, 0);
      const suppressPlaintextPayload =
        memoryQuestionSensitiveFieldsRequireEncryption();
      const searchText = input.query?.trim() || null;
      const targetMatchCount = offset + limit;
      const selectQuestions = async (
        queryText: string | null,
        rawLimit: number,
        rawOffset: number
      ) =>
        await pool.query<MemoryQuestionShellRow>(
          `
          select
            id, owner_user_id, visibility, origin, retrieval_scope, team_workspace_id, search_domain,
            project_id, project_name, project_path, session_id, thread_id,
            thread_name, ask_thread_id, ask_turn_index, query, answer_markdown, left(answer_markdown, 280) as answer_preview,
            error_message, status, created_at, updated_at, answered_at,
            attempt_count, evidence,
            jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
          from memory_questions
          where owner_user_id = $1
            and visibility = 'personal'
            and ($2::memory_search_domain is null or search_domain = $2)
            and ($3::text is null or project_id = $3)
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
            input.projectId ?? null,
            input.sessionId ?? null,
            queryText,
            rawLimit,
            rawOffset,
            input.status ?? null
          ]
        );

      if (suppressPlaintextPayload && searchText) {
        const needle = searchText.toLowerCase();
        const matchedRows: MemoryQuestionShellRow[] = [];
        let rawOffset = 0;

        while (matchedRows.length < targetMatchCount) {
          const result = await selectQuestions(
            null,
            encryptedSearchBatchSize,
            rawOffset
          );
          if (result.rows.length === 0) {
            break;
          }
          const hydratedRows = await Promise.all(
            result.rows.map((row) => hydrateQuestionRow(actor, row))
          );
          matchedRows.push(
            ...hydratedRows.filter((row) =>
              [
                row.query,
                row.answer_markdown ?? "",
                row.error_message ?? "",
                row.project_name ?? "",
                row.thread_name ?? ""
              ].some((value) => value.toLowerCase().includes(needle))
            )
          );
          rawOffset += result.rows.length;
        }

        return matchedRows
          .slice(offset, targetMatchCount)
          .map(mapMemoryQuestionShell);
      }

      const result = await pool.query<MemoryQuestionShellRow>(
        `
        select
          id, owner_user_id, visibility, origin, retrieval_scope, team_workspace_id, search_domain,
          project_id, project_name, project_path, session_id, thread_id,
          thread_name, ask_thread_id, ask_turn_index, query, answer_markdown, left(answer_markdown, 280) as answer_preview,
          error_message, status, created_at, updated_at, answered_at,
          attempt_count, evidence,
          jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
        from memory_questions
        where owner_user_id = $1
          and visibility = 'personal'
          and ($2::memory_search_domain is null or search_domain = $2)
          and ($3::text is null or project_id = $3)
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
          input.projectId ?? null,
          input.sessionId ?? null,
          searchText,
          limit,
          offset,
          input.status ?? null
        ]
      );

      const hydratedRows = await Promise.all(
        result.rows.map((row) => hydrateQuestionRow(actor, row))
      );
      return hydratedRows.map(mapMemoryQuestionShell);
    },

    async getMemoryQuestion(actor, questionId) {
      const result = await pool.query<MemoryQuestionDetailRow>(
        `
        select
          id, owner_user_id, visibility, origin, retrieval_scope, team_workspace_id, search_domain,
          project_id, project_name, project_path, session_id, thread_id,
          thread_name, ask_thread_id, ask_turn_index, query, answer_markdown, error_message, evidence,
          citations, retrieval, local_memory_worker, response, status,
          created_at, updated_at, answered_at, attempt_count,
          jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
        from memory_questions
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
        limit 1
      `,
        [actor.userId, questionId]
      );

      return result.rows[0]
        ? mapMemoryQuestionDetail(
            await hydrateQuestionRow(actor, result.rows[0])
          )
        : null;
    }
  };
};
