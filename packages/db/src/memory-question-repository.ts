import pg from "pg";
import {
  createEncryptedPayloadRepository,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import { truncateDisplayText } from "./value-helpers.js";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import type {
  ActorContext,
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
}

export interface MemoryQuestionRepository {
  createMemoryQuestion(
    actor: ActorContext,
    input: {
      query: string;
      origin?: MemoryQuestionOrigin;
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
  createFinalMemoryQuestion(
    actor: ActorContext,
    input: {
      query: string;
      origin?: MemoryQuestionOrigin;
      retrievalScope?: MemoryQuestionRetrievalScope;
      searchDomain: MemoryQuestionSearchDomain;
      workspaceId?: string;
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
      origin?: MemoryQuestionOrigin;
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
  origin: MemoryQuestionOrigin;
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
  evidence?: unknown[] | null;
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

const managedCloudPlaintextMemoryPayloadsDisabled = (): boolean => {
  const profile =
    process.env.KOED_DEPLOYMENT_PROFILE?.trim().toLowerCase() ?? "";
  const releaseStage =
    process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE?.trim().toLowerCase() ?? "";
  return (
    ["koed_managed_cloud", "koed-managed-cloud", "cloud"].includes(profile) &&
    ["paid", "production"].includes(releaseStage)
  );
};

type MemoryQuestionEncryptedColumn =
  | "query"
  | "answer_markdown"
  | "error_message"
  | "last_error_message"
  | "evidence"
  | "citations"
  | "retrieval"
  | "local_memory_worker"
  | "local_memory_worker_config"
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
  pool: pg.Pool,
  options: MemoryQuestionRepositoryOptions = {}
): MemoryQuestionRepository => {
  const encryptedPayloadRepository = createEncryptedPayloadRepository(pool);

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
    if (row.last_error_message === ENCRYPTED_MEMORY_QUESTION_TEXT) {
      const plaintext = await decryptQuestionField(
        actor,
        row,
        "last_error_message"
      );
      if (typeof plaintext !== "string") {
        throw new Error(
          "Encrypted Memory Question last_error_message is invalid"
        );
      }
      hydrated.last_error_message = plaintext;
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
        "local_memory_worker_config",
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
    async createMemoryQuestion(actor, input) {
      const suppressPlaintextPayload =
        managedCloudPlaintextMemoryPayloadsDisabled();
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
        values ($1, 'personal', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        returning
          id, owner_user_id, visibility, origin, retrieval_scope, search_domain,
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
            input.origin ?? "explorer",
            input.retrievalScope ?? "personal",
            input.searchDomain,
            input.workspaceId ?? null,
            input.projectName ?? null,
            input.projectPath ?? null,
            input.sessionId ?? null,
            input.threadId ?? null,
            input.threadName ?? null,
            suppressPlaintextPayload
              ? ENCRYPTED_MEMORY_QUESTION_TEXT
              : input.query,
            input.localMemoryWorkerConfig
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionJsonMarker()
                    : input.localMemoryWorkerConfig
                )
              : null
          ]
        );
        const row = result.rows[0]!;
        if (suppressPlaintextPayload) {
          await persistEncryptedQuestionFields(
            client,
            actor,
            row.id,
            row.visibility,
            {
              query: input.query,
              local_memory_worker_config: input.localMemoryWorkerConfig
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

    async createFinalMemoryQuestion(actor, input) {
      const suppressPlaintextPayload =
        managedCloudPlaintextMemoryPayloadsDisabled();
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
          search_domain,
          workspace_id,
          project_name,
          project_path,
          session_id,
          thread_id,
          thread_name,
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
          attempt_count,
          last_error_message
        )
        values (
          $1, 'personal', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12::memory_question_status, $13, $14, $15::jsonb, $16::jsonb,
          $17::jsonb, $18::jsonb, $19::jsonb, now(), $20, $21
        )
        returning
          id, owner_user_id, visibility, origin, retrieval_scope, search_domain,
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
            input.origin ?? "explorer",
            input.retrievalScope ?? "personal",
            input.searchDomain,
            input.workspaceId ?? null,
            input.projectName ?? null,
            input.projectPath ?? null,
            input.sessionId ?? null,
            input.threadId ?? null,
            input.threadName ?? null,
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
            input.attemptCount ?? 1,
            input.status === "error"
              ? suppressPlaintextPayload
                ? ENCRYPTED_MEMORY_QUESTION_TEXT
                : input.errorMessage
              : null
          ]
        );
        const row = result.rows[0]!;
        if (suppressPlaintextPayload) {
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
              local_memory_worker: input.localMemoryWorker,
              last_error_message:
                input.status === "error" ? input.errorMessage : undefined
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
        managedCloudPlaintextMemoryPayloadsDisabled();
      const searchText = input.query?.trim() || null;
      const rawLimit = suppressPlaintextPayload && searchText ? 500 : limit;
      const rawOffset = suppressPlaintextPayload && searchText ? 0 : offset;
      const result = await pool.query<MemoryQuestionShellRow>(
        `
        select
          id, owner_user_id, visibility, origin, retrieval_scope, search_domain,
          workspace_id, project_name, project_path, session_id, thread_id,
          thread_name, query, answer_markdown, left(answer_markdown, 280) as answer_preview,
          error_message, status, created_at, updated_at, answered_at,
          processing_started_at, processing_lease_until, attempt_count,
          last_error_message, evidence,
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
          suppressPlaintextPayload ? null : searchText,
          rawLimit,
          rawOffset,
          input.status ?? null
        ]
      );

      const hydratedRows = await Promise.all(
        result.rows.map((row) => hydrateQuestionRow(actor, row))
      );
      const filteredRows =
        suppressPlaintextPayload && searchText
          ? hydratedRows.filter((row) => {
              const needle = searchText.toLowerCase();
              return [
                row.query,
                row.answer_markdown ?? "",
                row.error_message ?? "",
                row.project_name ?? "",
                row.thread_name ?? ""
              ].some((value) => value.toLowerCase().includes(needle));
            })
          : hydratedRows;
      return filteredRows
        .slice(
          suppressPlaintextPayload && searchText ? offset : 0,
          suppressPlaintextPayload && searchText ? offset + limit : undefined
        )
        .map(mapMemoryQuestionShell);
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
            and ($5::text is null or origin = $5)
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
          question.visibility, question.origin, question.retrieval_scope, question.search_domain,
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
        [
          actor.userId,
          input.questionId ?? null,
          limit,
          leaseSeconds,
          input.origin ?? null
        ]
      );

      const hydratedRows = await Promise.all(
        result.rows.map((row) => hydrateQuestionRow(actor, row))
      );
      return hydratedRows.map(mapMemoryQuestionDetail);
    },

    async getMemoryQuestion(actor, questionId) {
      const result = await pool.query<MemoryQuestionDetailRow>(
        `
        select
          id, owner_user_id, visibility, origin, retrieval_scope, search_domain,
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

      return result.rows[0]
        ? mapMemoryQuestionDetail(
            await hydrateQuestionRow(actor, result.rows[0])
          )
        : null;
    },

    async updateMemoryQuestion(actor, questionId, input) {
      const suppressPlaintextPayload =
        managedCloudPlaintextMemoryPayloadsDisabled();
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
          id, owner_user_id, visibility, origin, retrieval_scope, search_domain,
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
            "evidence" in input && input.evidence
              ? JSON.stringify(
                  suppressPlaintextPayload
                    ? encryptedMemoryQuestionArrayMarker()
                    : input.evidence
                )
              : null,
            "citations" in input && input.citations
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
            input.attemptCount ?? null,
            input.status === "pending" && input.lastErrorMessage != null
              ? suppressPlaintextPayload
                ? ENCRYPTED_MEMORY_QUESTION_TEXT
                : input.lastErrorMessage
              : null
          ]
        );
        const row = result.rows[0];
        if (row && suppressPlaintextPayload) {
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
              evidence: "evidence" in input ? input.evidence : undefined,
              citations: "citations" in input ? input.citations : undefined,
              retrieval: input.retrieval,
              local_memory_worker: input.localMemoryWorker,
              last_error_message:
                input.status === "pending"
                  ? input.lastErrorMessage
                  : input.status === "error"
                    ? input.errorMessage
                    : undefined
            }
          );
        }
        await client.query("commit");

        return row
          ? mapMemoryQuestionDetail(await hydrateQuestionRow(actor, row))
          : null;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  };
};
