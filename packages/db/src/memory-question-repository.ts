import {
  personalFolderReferenceSchema,
  personalFolderScopeId,
  personalGitContextSchema,
  repositoryScopeId
} from "@koed/shared";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import {
  assertMemoryAnswerTeamAuthorityWithClient,
  type MemoryAnswerTeamAuthority
} from "./memory-answer-team-authority.js";
import {
  decryptAuthorizedEncryptedFieldPayloadWithClient,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import { truncateDisplayText } from "./value-helpers.js";
import { SharedMemoryAuthorizationError } from "./shared-memory-repository.js";
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

export interface MemoryQuestionActorContext extends ActorContext {
  allowTeam?: boolean;
}

export interface MemoryQuestionRepository {
  createFinalMemoryQuestionWithClient(
    client: pg.PoolClient,
    actor: MemoryQuestionActorContext,
    input: CreateFinalMemoryQuestionInput,
    options?: {
      teamAuthority?: MemoryAnswerTeamAuthority;
      strictIdempotencyBoundary?: boolean;
    }
  ): Promise<{ id: string }>;
  createPendingDesktopAsk(
    actor: MemoryQuestionActorContext,
    input: {
      namedProjectId?: string;
      folderSelection?: import("@koed/shared").PersonalFolderReference;
      repositorySelection?: import("@koed/shared").PersonalGitContext;
      askThreadId?: string;
      idempotencyKey: string;
      query: string;
    }
  ): Promise<MemoryQuestionDetailRecord>;
  completePendingDesktopAsk(
    actor: MemoryQuestionActorContext,
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
    actor: MemoryQuestionActorContext,
    input: { errorMessage: string }
  ): Promise<{ recovered: number }>;
  listDesktopAskThreads(
    actor: MemoryQuestionActorContext,
    input?: { cursor?: DesktopAskThreadCursor; limit?: number }
  ): Promise<DesktopAskThreadPage>;
  getDesktopAskThread(
    actor: MemoryQuestionActorContext,
    askThreadId: string
  ): Promise<MemoryQuestionDetailRecord[]>;
  createFinalMemoryQuestion(
    actor: MemoryQuestionActorContext,
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
    actor: MemoryQuestionActorContext,
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
    actor: MemoryQuestionActorContext,
    questionId: string
  ): Promise<MemoryQuestionDetailRecord | null>;
}

export type CreateFinalMemoryQuestionInput = Parameters<
  MemoryQuestionRepository["createFinalMemoryQuestion"]
>[1];

type MemoryQuestionShellRow = {
  id: string;
  owner_user_id: string;
  visibility: Visibility;
  origin: MemoryQuestionOrigin;
  retrieval_scope: MemoryQuestionRetrievalScope;
  team_workspace_id: string | null;
  team_authorization?: MemoryAnswerTeamAuthority | null;
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
  const encryptedSearchBatchSize = Math.min(
    Math.max(options.encryptedMemoryQuestionSearchBatchSize ?? 500, 1),
    500
  );

  const persistEncryptedQuestionField = async (
    client: pg.Pool | pg.PoolClient,
    actor: MemoryQuestionActorContext,
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
    actor: MemoryQuestionActorContext,
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

  const decryptQuestionFieldWithClient = async (
    actor: MemoryQuestionActorContext,
    row: MemoryQuestionShellRow,
    sourceColumn: MemoryQuestionEncryptedColumn,
    client: pg.Pool | pg.PoolClient
  ): Promise<unknown> => {
    if (!options.envelopeEncryptionProvider) {
      throw new Error(
        "Envelope encryption provider is required to expand encrypted Memory Questions"
      );
    }
    const decrypted = await decryptAuthorizedEncryptedFieldPayloadWithClient(
      client,
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

  const expandQuestionRow = async <T extends MemoryQuestionShellRow>(
    actor: MemoryQuestionActorContext,
    row: T,
    client: pg.Pool | pg.PoolClient = pool
  ): Promise<T> => {
    const decryptQuestionField = (
      actor: MemoryQuestionActorContext,
      row: MemoryQuestionShellRow,
      column: MemoryQuestionEncryptedColumn
    ) => decryptQuestionFieldWithClient(actor, row, column, client);
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

  const hydrateQuestionRow = async <T extends MemoryQuestionShellRow>(
    actor: MemoryQuestionActorContext,
    row: T
  ): Promise<T> => {
    if (actor.teamBoundaryId !== undefined && row.team_workspace_id) {
      if (!actor.allowTeam || actor.teamBoundaryId === null)
        throw new SharedMemoryAuthorizationError();
      const scoped = await pool.query(
        "select 1 from team_workspaces where id=$1 and team_id=$2",
        [row.team_workspace_id, actor.teamBoundaryId]
      );
      if (!scoped.rows[0]) throw new SharedMemoryAuthorizationError();
    }
    // Legacy Team history is retained; task-bound history rechecks its frozen authority.
    if (!row.team_authorization) {
      return expandQuestionRow(actor, row);
    }
    if (!actor.allowTeam) {
      throw new SharedMemoryAuthorizationError();
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await assertMemoryAnswerTeamAuthorityWithClient(
        client,
        actor,
        row.team_authorization
      );
      const hydrated = await expandQuestionRow(actor, row, client);
      await client.query("commit");
      return hydrated;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };

  const hydrateVisibleQuestionRows = async <T extends MemoryQuestionShellRow>(
    actor: MemoryQuestionActorContext,
    rows: T[]
  ): Promise<T[]> => {
    const hydrated = new Array<T | undefined>(rows.length);
    let nextIndex = 0;
    // Bound concurrent transactions/decryption without serializing the history page.
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(8, rows.length) }, async () => {
        while (nextIndex < rows.length) {
          const index = nextIndex++;
          try {
            hydrated[index] = await hydrateQuestionRow(actor, rows[index]!);
          } catch (error) {
            if (!(error instanceof SharedMemoryAuthorizationError)) {
              throw error;
            }
          }
        }
      })
    );
    for (const worker of workers) {
      if (worker.status === "rejected") throw worker.reason;
    }
    return hydrated.filter((row): row is T => row !== undefined);
  };

  const repository: MemoryQuestionRepository = {
    async createPendingDesktopAsk(actor, input) {
      if (
        [
          input.namedProjectId,
          input.folderSelection,
          input.repositorySelection
        ].filter(Boolean).length > 1
      )
        throw Object.assign(new Error("Ask requires one explicit target"), {
          statusCode: 400
        });
      const repositorySelection = input.repositorySelection
        ? personalGitContextSchema.parse(input.repositorySelection)
        : undefined;
      const folder = input.folderSelection
        ? personalFolderReferenceSchema.parse(input.folderSelection)
        : undefined;
      if (
        folder &&
        (folder.ownerUserId !== actor.userId || input.namedProjectId)
      )
        throw Object.assign(new Error("Invalid Personal Folder selection"), {
          statusCode: 403
        });
      const selectedId = repositorySelection
        ? repositoryScopeId(repositorySelection)
        : folder
          ? personalFolderScopeId(folder)
          : (input.namedProjectId ?? null);
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
              team_workspace_id, team_authorization, search_domain, project_id, project_name,
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
          if (existing.rows[0].project_id !== selectedId)
            throw Object.assign(
              new Error("Ask request belongs to another selection"),
              { statusCode: 409 }
            );
          if (existing.rows[0].origin !== "desktop_ask") {
            throw new Error("Memory Question idempotency key is unavailable");
          }
          await client.query("commit");
          return mapMemoryQuestionDetail(
            await hydrateQuestionRow(actor, existing.rows[0])
          );
        }

        if (input.namedProjectId) {
          const selected = await client.query(
            "select project_id from personal_named_projects where project_id::text=$2 and owner_user_id=$1 and deleted_at is null for share",
            [actor.userId, input.namedProjectId]
          );
          if (!selected.rows.length)
            throw Object.assign(new Error("Personal Project not found"), {
              statusCode: 404
            });
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
            other_scope_count: string | number;
          }>(
            `
              select
                count(*) as count,
                count(*) filter(where project_id is distinct from $3::text) as other_scope_count,
                coalesce(max(ask_turn_index), -1) + 1 as next_turn_index
              from memory_questions
              where owner_user_id = $1
                and visibility = 'personal'
                and origin = 'desktop_ask'
                and ask_thread_id = $2
            `,
            [actor.userId, askThreadId, selectedId]
          );
          if (Number(thread.rows[0]?.count ?? 0) === 0) {
            throw new Error("Ask thread not found or not visible");
          }
          if (Number(thread.rows[0]?.other_scope_count ?? 0) > 0)
            throw Object.assign(
              new Error("Start a new Ask to change its selection"),
              { statusCode: 409 }
            );
          askTurnIndex = Number(thread.rows[0]!.next_turn_index);
        }

        const result = await client.query<MemoryQuestionDetailRow>(
          `
            insert into memory_questions (
              owner_user_id, visibility, origin, retrieval_scope,
              search_domain, project_id, ask_thread_id, ask_turn_index, idempotency_key,
              query, status, attempt_count
            )
            values (
              $1, 'personal', 'desktop_ask', 'personal', case when $6::text is null then 'global'::memory_search_domain else 'project'::memory_search_domain end,$6,$2,$3,$4,
              $5, 'pending'::memory_question_status, 0
            )
            returning
              id, owner_user_id, visibility, origin, retrieval_scope,
              team_workspace_id, team_authorization, search_domain, project_id, project_name,
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
              : input.query,
            selectedId
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
              team_workspace_id, team_authorization, search_domain, project_id, project_name,
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
                  team_workspace_id, team_authorization, search_domain, project_id, project_name,
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
            first_question.retrieval_scope, first_question.team_workspace_id, first_question.team_authorization,
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
            team_workspace_id, team_authorization, search_domain, project_id, project_name,
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
      const client = await pool.connect();
      let questionId: string;
      try {
        await client.query("begin");
        const result = await repository.createFinalMemoryQuestionWithClient(
          client,
          actor,
          input,
          { strictIdempotencyBoundary: false }
        );
        questionId = result.id;
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      const question = await repository.getMemoryQuestion(actor, questionId);
      if (!question) {
        throw new Error("Final Memory Question is missing");
      }
      return question;
    },

    async createFinalMemoryQuestionWithClient(
      client,
      actor,
      input,
      finalOptions = {}
    ) {
      const suppressPlaintextPayload =
        memoryQuestionSensitiveFieldsRequireEncryption();
      if (suppressPlaintextPayload && !options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required when plaintext Memory Question storage is disabled"
        );
      }
      const teamAuthority = finalOptions.teamAuthority;
      if (actor.teamBoundaryId !== undefined && input.teamWorkspaceId) {
        if (actor.teamBoundaryId === null)
          throw new SharedMemoryAuthorizationError();
        const scoped = await client.query(
          "select 1 from team_workspaces where id=$1 and team_id=$2",
          [input.teamWorkspaceId, actor.teamBoundaryId]
        );
        if (!scoped.rows[0]) throw new SharedMemoryAuthorizationError();
      }
      if (teamAuthority) {
        if (
          input.teamWorkspaceId !== teamAuthority.recallBoundary.teamWorkspaceId
        ) {
          throw new Error("Final Memory Question Team boundary does not match");
        }
        await assertMemoryAnswerTeamAuthorityWithClient(
          client,
          actor,
          teamAuthority
        );
      }
      const result = await client.query<MemoryQuestionDetailRow>(
        `
        insert into memory_questions (
          owner_user_id,
          visibility,
          origin,
          retrieval_scope,
          team_workspace_id,
          team_authorization,
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
          $1, 'personal', $2, $3, $4, $23::jsonb, $5, $6, $7, $8, $9, $10, $11, null, null, $12, $13,
          $14::memory_question_status, $15, $16, $17::jsonb, $18::jsonb,
          $19::jsonb, $20::jsonb, $21::jsonb, now(), $22
        )
        on conflict (owner_user_id, idempotency_key) do nothing
        returning
          id, owner_user_id, visibility, origin, retrieval_scope, team_workspace_id, team_authorization, search_domain,
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
          input.attemptCount ?? 1,
          teamAuthority ? JSON.stringify(teamAuthority) : null
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
                  team_workspace_id, team_authorization, search_domain, project_id, project_name, project_path,
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
      const strictIdempotencyBoundary =
        finalOptions.strictIdempotencyBoundary !== false ||
        Boolean(teamAuthority || row.team_authorization);
      if (
        strictIdempotencyBoundary &&
        (row.retrieval_scope !== (input.retrievalScope ?? "personal") ||
          row.team_workspace_id !== (input.teamWorkspaceId ?? null) ||
          (teamAuthority &&
            !isDeepStrictEqual(row.team_authorization, teamAuthority)) ||
          (!teamAuthority && row.team_authorization))
      ) {
        throw new Error(
          "Final Memory Question idempotency boundary does not match"
        );
      }
      if (row.team_authorization) {
        await assertMemoryAnswerTeamAuthorityWithClient(
          client,
          actor,
          row.team_authorization
        );
      }
      if (!inserted && strictIdempotencyBoundary) {
        const existing = await expandQuestionRow(actor, row, client);
        const storedFinal = {
          origin: existing.origin,
          searchDomain: existing.search_domain,
          projectId: existing.project_id,
          projectName: existing.project_name,
          projectPath: existing.project_path,
          sessionId: existing.session_id,
          threadId: existing.thread_id,
          threadName: existing.thread_name,
          query: existing.query,
          status: existing.status,
          answerMarkdown: existing.answer_markdown,
          errorMessage: existing.error_message,
          attemptCount: Number(existing.attempt_count),
          response: existing.response,
          evidence: existing.evidence,
          citations: existing.citations,
          retrieval: existing.retrieval,
          localMemoryWorker: existing.local_memory_worker
        };
        const expectedFinal = {
          origin: input.origin ?? "mcp_memory_answer",
          searchDomain: input.searchDomain,
          projectId: input.projectId ?? null,
          projectName: input.projectName ?? null,
          projectPath: input.projectPath ?? null,
          sessionId: input.sessionId ?? null,
          threadId: input.threadId ?? null,
          threadName: input.threadName ?? null,
          query: input.query,
          status: input.status,
          answerMarkdown:
            input.status === "answered" ? input.answerMarkdown : null,
          errorMessage: input.status === "error" ? input.errorMessage : null,
          attemptCount: input.attemptCount ?? 1,
          response: input.response ?? null,
          evidence:
            input.status === "answered" ? (input.evidence ?? null) : null,
          citations:
            input.status === "answered" ? (input.citations ?? null) : null,
          retrieval: input.retrieval ?? null,
          localMemoryWorker: input.localMemoryWorker ?? null
        };
        if (!isDeepStrictEqual(storedFinal, expectedFinal)) {
          throw new Error(
            "Final Memory Question idempotency content does not match"
          );
        }
      }
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
            evidence: input.status === "answered" ? input.evidence : undefined,
            citations:
              input.status === "answered" ? input.citations : undefined,
            retrieval: input.retrieval,
            local_memory_worker: input.localMemoryWorker
          }
        );
      }
      return { id: row.id };
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
            id, owner_user_id, visibility, origin, retrieval_scope, team_workspace_id, team_authorization, search_domain,
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

      if (suppressPlaintextPayload) {
        const needle = searchText?.toLowerCase();
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
          const hydratedRows = await hydrateVisibleQuestionRows(
            actor,
            result.rows
          );
          matchedRows.push(
            ...hydratedRows.filter(
              (row) =>
                !needle ||
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
          id, owner_user_id, visibility, origin, retrieval_scope, team_workspace_id, team_authorization, search_domain,
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

      const hydratedRows = await hydrateVisibleQuestionRows(actor, result.rows);
      return hydratedRows.map(mapMemoryQuestionShell);
    },

    async getMemoryQuestion(actor, questionId) {
      const result = await pool.query<MemoryQuestionDetailRow>(
        `
        select
          id, owner_user_id, visibility, origin, retrieval_scope, team_workspace_id, team_authorization, search_domain,
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
  return repository;
};
