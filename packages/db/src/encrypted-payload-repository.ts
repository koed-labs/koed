import pg from "pg";
import {
  decryptEnvelopeToUtf8,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type EnvelopeEncryptionProviderMode
} from "@koed/shared";
import type { ActorContext, Visibility } from "./types.js";

export type EncryptedFieldSourceTable =
  | "conversation_items"
  | "conversation_item_observations"
  | "memory_embeddings"
  | "memory_events"
  | "memory_nodes"
  | "memory_questions"
  | "messages"
  | "tool_events";

export type EncryptedFieldBackfillStatus =
  | "pending"
  | "processing"
  | "completed"
  | "error";

export type EncryptedFieldVisibility = Visibility | "team";

export interface EncryptedFieldReference {
  sourceTable: EncryptedFieldSourceTable;
  sourceId: string;
  sourceColumn: string;
}

export interface StoredEncryptedFieldRecord extends EncryptedFieldReference {
  id: string;
  ownerUserId: string;
  teamId: string | null;
  teamWorkspaceId: string | null;
  visibility: Visibility;
  encryptionScope: EncryptedFieldVisibility;
  plaintextContentType: string;
  plaintextEncoding: string;
  envelope: EncryptedPayloadEnvelope;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedFieldBackfillRunRecord {
  id: string;
  ownerUserId: string | null;
  visibility: Visibility;
  sourceTable: EncryptedFieldSourceTable;
  sourceColumn: string;
  providerMode: EnvelopeEncryptionProviderMode;
  status: EncryptedFieldBackfillStatus;
  cursorSourceId: string | null;
  totalRows: number;
  processedRows: number;
  encryptedRows: number;
  failedRows: number;
  lastErrorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedPayloadRepository {
  upsertEncryptedField(
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider,
    input: EncryptedFieldReference & {
      plaintext: unknown;
      visibility?: EncryptedFieldVisibility;
      teamId?: string | null;
      teamWorkspaceId?: string | null;
      plaintextContentType?: string;
      plaintextEncoding?: string;
      scope?: EncryptedPayloadEnvelope["scope"];
      rowFamily?: string;
      aad?: Record<string, string | number | boolean | null | undefined>;
    }
  ): Promise<StoredEncryptedFieldRecord>;
  getAuthorizedEncryptedField(
    actor: ActorContext,
    reference: EncryptedFieldReference
  ): Promise<StoredEncryptedFieldRecord | null>;
  decryptAuthorizedEncryptedField(
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider,
    reference: EncryptedFieldReference
  ): Promise<{ record: StoredEncryptedFieldRecord; plaintext: unknown } | null>;
  invalidateEncryptedField(
    actor: ActorContext,
    reference: EncryptedFieldReference & { reason: string }
  ): Promise<boolean>;
  createEncryptedFieldBackfillRun(
    actor: ActorContext,
    input: {
      sourceTable: EncryptedFieldSourceTable;
      sourceColumn: string;
      providerMode: EnvelopeEncryptionProviderMode;
      totalRows?: number;
    }
  ): Promise<EncryptedFieldBackfillRunRecord>;
  updateEncryptedFieldBackfillRun(
    actor: ActorContext,
    runId: string,
    input: {
      status?: EncryptedFieldBackfillStatus;
      cursorSourceId?: string | null;
      processedRows?: number;
      encryptedRows?: number;
      failedRows?: number;
      lastErrorMessage?: string | null;
    }
  ): Promise<EncryptedFieldBackfillRunRecord | null>;
  backfillEncryptedFieldBatch(
    actor: ActorContext,
    provider: EnvelopeEncryptionProvider,
    input: {
      runId: string;
      sourceTable: EncryptedFieldSourceTable;
      sourceColumn: string;
      batchSize?: number;
    }
  ): Promise<{
    run: EncryptedFieldBackfillRunRecord;
    processedRows: number;
    encryptedRows: number;
    failedRows: number;
    done: boolean;
  }>;
  rewrapEncryptedFieldBatch(
    provider: EnvelopeEncryptionProvider,
    input?: {
      ownerUserId?: string;
      sourceTable?: EncryptedFieldSourceTable;
      sourceColumn?: string;
      batchSize?: number;
      force?: boolean;
      afterId?: string;
    }
  ): Promise<{
    processedRows: number;
    rewrappedRows: number;
    failedRows: number;
    done: boolean;
    nextCursorId: string | null;
  }>;
}

type EncryptedFieldRow = {
  id: string;
  owner_user_id: string;
  team_id: string | null;
  team_workspace_id: string | null;
  visibility: Visibility;
  encryption_scope: EncryptedFieldVisibility;
  source_table: EncryptedFieldSourceTable;
  source_id: string;
  source_column: string;
  plaintext_content_type: string;
  plaintext_encoding: string;
  envelope_version: number;
  provider_mode: EnvelopeEncryptionProviderMode;
  key_id: string;
  key_version: number;
  scope: EncryptedPayloadEnvelope["scope"];
  provenance: EncryptedPayloadEnvelope["provenance"];
  algorithm: EncryptedPayloadEnvelope["algorithm"];
  ciphertext: string;
  nonce: string;
  tag: string;
  wrapped_dek: EncryptedPayloadEnvelope["wrappedDek"];
  ciphertext_location: string;
  aad: EncryptedPayloadEnvelope["aad"];
  envelope_created_at: Date;
  envelope_reencrypted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type BackfillRunRow = {
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  source_table: EncryptedFieldSourceTable;
  source_column: string;
  provider_mode: EnvelopeEncryptionProviderMode;
  status: EncryptedFieldBackfillStatus;
  cursor_source_id: string | null;
  total_rows: number;
  processed_rows: number;
  encrypted_rows: number;
  failed_rows: number;
  last_error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type BackfillSourceRow = {
  id: string;
  owner_user_id: string;
  plaintext: unknown;
};

type BackfillSourceConfig = {
  columns: ReadonlySet<string>;
  valueSql: (sourceColumn: string) => string;
  activePredicate: string;
};

const jsonbValue = (sourceColumn: string): string => sourceColumn;

const textValue = (sourceColumn: string): string => sourceColumn;

const backfillSources: Record<EncryptedFieldSourceTable, BackfillSourceConfig> =
  {
    conversation_items: {
      columns: new Set([
        "raw_json",
        "raw_text",
        "transport_chunk_text",
        "source_path",
        "metadata"
      ]),
      valueSql: jsonbValue,
      activePredicate: "personal_deleted_at is null"
    },
    conversation_item_observations: {
      columns: new Set([
        "raw_json",
        "raw_text",
        "transport_chunk_text",
        "source_path",
        "metadata"
      ]),
      valueSql: jsonbValue,
      activePredicate:
        "(exists (select 1 from conversation_items ci where ci.id = conversation_item_id and ci.personal_deleted_at is null) or exists (select 1 from sessions s where s.id = session_id and s.personal_deleted_at is null))"
    },
    memory_embeddings: {
      columns: new Set(["source_text"]),
      valueSql: textValue,
      activePredicate: "invalidated_at is null and personal_deleted_at is null"
    },
    memory_events: {
      columns: new Set(["payload"]),
      valueSql: jsonbValue,
      activePredicate: "invalidated_at is null and personal_deleted_at is null"
    },
    memory_nodes: {
      columns: new Set([
        "title",
        "summary_text",
        "body_text",
        "source_items_json",
        "summary_structured_json"
      ]),
      valueSql: jsonbValue,
      activePredicate: "invalidated_at is null and personal_deleted_at is null"
    },
    memory_questions: {
      columns: new Set([
        "query",
        "answer_markdown",
        "error_message",
        "last_error_message",
        "evidence",
        "citations",
        "retrieval",
        "local_memory_worker",
        "local_memory_worker_config",
        "response"
      ]),
      valueSql: jsonbValue,
      activePredicate: "true"
    },
    messages: {
      columns: new Set(["content", "content_json"]),
      valueSql: jsonbValue,
      activePredicate: "invalidated_at is null"
    },
    tool_events: {
      columns: new Set(["tool_input", "tool_response"]),
      valueSql: jsonbValue,
      activePredicate: "invalidated_at is null"
    }
  };

const sourceConfigForBackfill = (
  sourceTable: EncryptedFieldSourceTable,
  sourceColumn: string
): BackfillSourceConfig => {
  const config = backfillSources[sourceTable];
  if (!config.columns.has(sourceColumn)) {
    throw new Error(
      `Unsupported encrypted field backfill source: ${sourceTable}.${sourceColumn}`
    );
  }
  return config;
};

const ENCRYPTED_CONVERSATION_ITEM_TEXT = "[koed encrypted conversation item]";
const ENCRYPTED_EMBEDDING_SOURCE_TEXT = "[koed encrypted embedding source]";
const ENCRYPTED_MEMORY_EVENT_PAYLOAD = "[koed encrypted memory event]";
const ENCRYPTED_MEMORY_NODE_TEXT = "[koed encrypted memory node]";
const ENCRYPTED_MEMORY_QUESTION_TEXT = "[koed encrypted memory question]";
const ENCRYPTED_MESSAGE_TEXT = "[koed encrypted message]";

const encryptedJsonMarker = (
  sourceTable: EncryptedFieldSourceTable,
  sourceColumn: string
): Record<string, unknown> => ({
  contentEncrypted: true,
  encryptedSourceTable: sourceTable,
  encryptedSourceColumn: sourceColumn
});

const encryptedArrayMarker = (
  sourceTable: EncryptedFieldSourceTable,
  sourceColumn: string
): Record<string, unknown>[] => [
  encryptedJsonMarker(sourceTable, sourceColumn)
];

type BackfillRedaction = { cast: "jsonb" | "text"; value: unknown };

const redactionForBackfillSource = (
  sourceTable: EncryptedFieldSourceTable,
  sourceColumn: string
): BackfillRedaction => {
  if (
    sourceTable === "conversation_items" ||
    sourceTable === "conversation_item_observations"
  ) {
    return sourceColumn === "raw_json" || sourceColumn === "metadata"
      ? { cast: "jsonb", value: encryptedJsonMarker(sourceTable, sourceColumn) }
      : { cast: "text", value: ENCRYPTED_CONVERSATION_ITEM_TEXT };
  }
  if (sourceTable === "memory_embeddings") {
    return { cast: "text", value: ENCRYPTED_EMBEDDING_SOURCE_TEXT };
  }
  if (sourceTable === "memory_events") {
    return sourceColumn === "payload"
      ? {
          cast: "jsonb",
          value: {
            ...encryptedJsonMarker(sourceTable, sourceColumn),
            content: ENCRYPTED_MEMORY_EVENT_PAYLOAD
          }
        }
      : { cast: "text", value: ENCRYPTED_MEMORY_EVENT_PAYLOAD };
  }
  if (sourceTable === "memory_nodes") {
    if (
      ["source_items_json", "summary_structured_json"].includes(sourceColumn)
    ) {
      return {
        cast: "jsonb",
        value: encryptedJsonMarker(sourceTable, sourceColumn)
      };
    }
    return { cast: "text", value: ENCRYPTED_MEMORY_NODE_TEXT };
  }
  if (sourceTable === "memory_questions") {
    if (["evidence", "citations"].includes(sourceColumn)) {
      return {
        cast: "jsonb",
        value: encryptedArrayMarker(sourceTable, sourceColumn)
      };
    }
    if (
      [
        "retrieval",
        "local_memory_worker",
        "local_memory_worker_config",
        "response"
      ].includes(sourceColumn)
    ) {
      return {
        cast: "jsonb",
        value: encryptedJsonMarker(sourceTable, sourceColumn)
      };
    }
    return { cast: "text", value: ENCRYPTED_MEMORY_QUESTION_TEXT };
  }
  if (sourceTable === "messages") {
    return sourceColumn === "content_json"
      ? { cast: "jsonb", value: encryptedJsonMarker(sourceTable, sourceColumn) }
      : { cast: "text", value: ENCRYPTED_MESSAGE_TEXT };
  }
  if (sourceTable === "tool_events") {
    return {
      cast: "jsonb",
      value: encryptedJsonMarker(sourceTable, sourceColumn)
    };
  }
  const exhaustive: never = sourceTable;
  throw new Error(`Unsupported encrypted field backfill source: ${exhaustive}`);
};

const redactBackfilledSourceColumn = async (
  client: pg.PoolClient,
  actor: ActorContext,
  reference: EncryptedFieldReference
): Promise<void> => {
  sourceConfigForBackfill(reference.sourceTable, reference.sourceColumn);
  const redaction = redactionForBackfillSource(
    reference.sourceTable,
    reference.sourceColumn
  );
  if (reference.sourceTable === "conversation_item_observations") {
    await client.query(
      `
        select
          set_config('koed.observation_redaction_source_id', $1, true),
          set_config('koed.observation_redaction_source_column', $2, true)
      `,
      [reference.sourceId, reference.sourceColumn]
    );
  }
  const result = await client.query(
    `
      update ${reference.sourceTable}
      set ${reference.sourceColumn} = $3::${redaction.cast}
      where id = $1
        and owner_user_id = $2
        and visibility = 'personal'
    `,
    [
      reference.sourceId,
      actor.userId,
      redaction.cast === "jsonb"
        ? JSON.stringify(redaction.value)
        : redaction.value
    ]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error(
      "Encrypted field backfill source row changed before redaction"
    );
  }
};

const serializePlaintext = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const parsePlaintext = (
  value: string,
  plaintextContentType: string
): unknown => {
  if (plaintextContentType === "application/json") {
    return JSON.parse(value);
  }
  return value;
};

const mapEncryptedFieldRow = (
  row: EncryptedFieldRow
): StoredEncryptedFieldRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  teamId: row.team_id,
  teamWorkspaceId: row.team_workspace_id,
  visibility: row.visibility as Visibility,
  encryptionScope: row.encryption_scope,
  sourceTable: row.source_table,
  sourceId: row.source_id,
  sourceColumn: row.source_column,
  plaintextContentType: row.plaintext_content_type,
  plaintextEncoding: row.plaintext_encoding,
  envelope: {
    version: row.envelope_version as EncryptedPayloadEnvelope["version"],
    providerMode: row.provider_mode,
    keyId: row.key_id,
    keyVersion: row.key_version,
    scope: row.scope,
    provenance: row.provenance,
    algorithm: row.algorithm,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    tag: row.tag,
    wrappedDek: row.wrapped_dek,
    ciphertextLocation: row.ciphertext_location,
    aad: row.aad,
    createdAt: row.envelope_created_at.toISOString(),
    reencryptedAt: row.envelope_reencrypted_at?.toISOString() ?? null
  },
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

const mapBackfillRunRow = (
  row: BackfillRunRow
): EncryptedFieldBackfillRunRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  visibility: row.visibility,
  sourceTable: row.source_table,
  sourceColumn: row.source_column,
  providerMode: row.provider_mode,
  status: row.status,
  cursorSourceId: row.cursor_source_id,
  totalRows: Number(row.total_rows),
  processedRows: Number(row.processed_rows),
  encryptedRows: Number(row.encrypted_rows),
  failedRows: Number(row.failed_rows),
  lastErrorMessage: row.last_error_message,
  startedAt: row.started_at?.toISOString() ?? null,
  completedAt: row.completed_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

const selectEncryptedFieldSql = `
  select
    id,
    owner_user_id,
    team_id,
    team_workspace_id,
    visibility,
    encryption_scope,
    source_table,
    source_id,
    source_column,
    plaintext_content_type,
    plaintext_encoding,
    envelope_version,
    provider_mode,
    key_id,
    key_version,
    scope,
    provenance,
    algorithm,
    ciphertext,
    nonce,
    tag,
    wrapped_dek,
    ciphertext_location,
    aad,
    envelope_created_at,
    envelope_reencrypted_at,
    created_at,
    updated_at
  from encrypted_field_payloads
`;

const selectBackfillRunSql = `
  select
    id,
    owner_user_id,
    visibility,
    source_table,
    source_column,
    provider_mode,
    status,
    cursor_source_id,
    total_rows,
    processed_rows,
    encrypted_rows,
    failed_rows,
    last_error_message,
    started_at,
    completed_at,
    created_at,
    updated_at
  from encrypted_field_backfill_runs
`;

export const upsertEncryptedFieldPayloadWithClient = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  input: EncryptedFieldReference & {
    plaintext: unknown;
    visibility?: EncryptedFieldVisibility;
    teamId?: string | null;
    teamWorkspaceId?: string | null;
    plaintextContentType?: string;
    plaintextEncoding?: string;
    scope?: EncryptedPayloadEnvelope["scope"];
    rowFamily?: string;
    aad?: Record<string, string | number | boolean | null | undefined>;
  }
): Promise<StoredEncryptedFieldRecord> => {
  const visibility = input.visibility ?? "personal";
  const rowVisibility: Visibility = "personal";
  const teamId = input.teamId ?? null;
  const teamWorkspaceId = input.teamWorkspaceId ?? null;
  if (visibility === "personal" && (teamId || teamWorkspaceId)) {
    throw new Error("Personal encrypted fields cannot include Team scope");
  }
  if (visibility === "team" && !teamId) {
    throw new Error("Team encrypted fields require teamId");
  }
  const plaintextContentType =
    input.plaintextContentType ??
    (typeof input.plaintext === "string" ? "text/plain" : "application/json");
  const plaintextEncoding = input.plaintextEncoding ?? "utf8";
  const envelope = await provider.encrypt({
    plaintext: serializePlaintext(input.plaintext),
    scope: input.scope ?? {},
    provenance: {
      rowFamily: input.rowFamily ?? input.sourceTable,
      sourceTable: input.sourceTable,
      sourceColumn: input.sourceColumn,
      sourceId: input.sourceId
    },
    ciphertextLocation: "encrypted_field_payloads",
    aad: {
      ownerUserId: actor.userId,
      visibility: rowVisibility,
      encryptionScope: visibility,
      teamId,
      teamWorkspaceId,
      sourceTable: input.sourceTable,
      sourceId: input.sourceId,
      sourceColumn: input.sourceColumn,
      ...input.aad
    }
  });
  const result = await client.query<EncryptedFieldRow>(
    `
      insert into encrypted_field_payloads (
        owner_user_id,
        team_id,
        team_workspace_id,
        visibility,
        encryption_scope,
        source_table,
        source_id,
        source_column,
        plaintext_content_type,
        plaintext_encoding,
        envelope_version,
        provider_mode,
        key_id,
        key_version,
        scope,
        provenance,
        algorithm,
        ciphertext,
        nonce,
        tag,
        wrapped_dek,
        ciphertext_location,
        aad,
        envelope_created_at,
        envelope_reencrypted_at
      )
      values (
        $1,
        $2,
        $3,
        $4::visibility_scope,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15::jsonb,
        $16::jsonb,
        $17,
        $18,
        $19,
        $20,
        $21::jsonb,
        $22,
        $23::jsonb,
        $24,
        $25
      )
      on conflict (source_table, source_id, source_column)
      where invalidated_at is null
      do update set
        owner_user_id = excluded.owner_user_id,
        team_id = excluded.team_id,
        team_workspace_id = excluded.team_workspace_id,
        visibility = excluded.visibility,
        encryption_scope = excluded.encryption_scope,
        plaintext_content_type = excluded.plaintext_content_type,
        plaintext_encoding = excluded.plaintext_encoding,
        envelope_version = excluded.envelope_version,
        provider_mode = excluded.provider_mode,
        key_id = excluded.key_id,
        key_version = excluded.key_version,
        scope = excluded.scope,
        provenance = excluded.provenance,
        algorithm = excluded.algorithm,
        ciphertext = excluded.ciphertext,
        nonce = excluded.nonce,
        tag = excluded.tag,
        wrapped_dek = excluded.wrapped_dek,
        ciphertext_location = excluded.ciphertext_location,
        aad = excluded.aad,
        envelope_created_at = excluded.envelope_created_at,
        envelope_reencrypted_at = excluded.envelope_reencrypted_at,
        updated_at = now()
      returning
        id,
        owner_user_id,
        team_id,
        team_workspace_id,
        visibility,
        encryption_scope,
        source_table,
        source_id,
        source_column,
        plaintext_content_type,
        plaintext_encoding,
        envelope_version,
        provider_mode,
        key_id,
        key_version,
        scope,
        provenance,
        algorithm,
        ciphertext,
        nonce,
        tag,
        wrapped_dek,
        ciphertext_location,
        aad,
        envelope_created_at,
        envelope_reencrypted_at,
        created_at,
        updated_at
    `,
    [
      actor.userId,
      teamId,
      teamWorkspaceId,
      rowVisibility,
      visibility,
      input.sourceTable,
      input.sourceId,
      input.sourceColumn,
      plaintextContentType,
      plaintextEncoding,
      envelope.version,
      envelope.providerMode,
      envelope.keyId,
      envelope.keyVersion,
      JSON.stringify(envelope.scope),
      JSON.stringify(envelope.provenance),
      envelope.algorithm,
      envelope.ciphertext,
      envelope.nonce,
      envelope.tag,
      JSON.stringify(envelope.wrappedDek),
      envelope.ciphertextLocation,
      JSON.stringify(envelope.aad),
      envelope.createdAt,
      envelope.reencryptedAt
    ]
  );
  return mapEncryptedFieldRow(result.rows[0]!);
};

export const decryptAuthorizedEncryptedFieldPayloadWithClient = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider,
  reference: EncryptedFieldReference
): Promise<{
  record: StoredEncryptedFieldRecord;
  plaintext: unknown;
} | null> => {
  const result = await client.query<EncryptedFieldRow>(
    `
      ${selectEncryptedFieldSql}
      where owner_user_id = $1
        and visibility = 'personal'
        and encryption_scope = 'personal'
        and source_table = $2
        and source_id = $3
        and source_column = $4
        and invalidated_at is null
      limit 1
    `,
    [
      actor.userId,
      reference.sourceTable,
      reference.sourceId,
      reference.sourceColumn
    ]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const record = mapEncryptedFieldRow(row);
  const plaintextUtf8 = await decryptEnvelopeToUtf8(provider, record.envelope);
  return {
    record,
    plaintext: parsePlaintext(plaintextUtf8, record.plaintextContentType)
  };
};

export const createEncryptedPayloadRepository = (
  pool: pg.Pool
): EncryptedPayloadRepository => ({
  async upsertEncryptedField(actor, provider, input) {
    return upsertEncryptedFieldPayloadWithClient(pool, actor, provider, input);
  },

  async getAuthorizedEncryptedField(actor, reference) {
    const result = await pool.query<EncryptedFieldRow>(
      `
        ${selectEncryptedFieldSql}
        where owner_user_id = $1
          and visibility = 'personal'
          and encryption_scope = 'personal'
          and source_table = $2
          and source_id = $3
          and source_column = $4
          and invalidated_at is null
        limit 1
      `,
      [
        actor.userId,
        reference.sourceTable,
        reference.sourceId,
        reference.sourceColumn
      ]
    );
    return result.rows[0] ? mapEncryptedFieldRow(result.rows[0]) : null;
  },

  async decryptAuthorizedEncryptedField(actor, provider, reference) {
    return decryptAuthorizedEncryptedFieldPayloadWithClient(
      pool,
      actor,
      provider,
      reference
    );
  },

  async invalidateEncryptedField(actor, reference) {
    const result = await pool.query(
      `
        update encrypted_field_payloads
        set
          invalidated_at = now(),
          invalidation_reason = $5,
          updated_at = now()
        where owner_user_id = $1
          and visibility = 'personal'
          and encryption_scope = 'personal'
          and source_table = $2
          and source_id = $3
          and source_column = $4
          and invalidated_at is null
      `,
      [
        actor.userId,
        reference.sourceTable,
        reference.sourceId,
        reference.sourceColumn,
        reference.reason
      ]
    );
    return (result.rowCount ?? 0) > 0;
  },

  async createEncryptedFieldBackfillRun(actor, input) {
    const result = await pool.query<BackfillRunRow>(
      `
        insert into encrypted_field_backfill_runs (
          owner_user_id,
          visibility,
          source_table,
          source_column,
          provider_mode,
          total_rows
        )
        values ($1, 'personal', $2, $3, $4, $5)
        returning
          id,
          owner_user_id,
          visibility,
          source_table,
          source_column,
          provider_mode,
          status,
          cursor_source_id,
          total_rows,
          processed_rows,
          encrypted_rows,
          failed_rows,
          last_error_message,
          started_at,
          completed_at,
          created_at,
          updated_at
      `,
      [
        actor.userId,
        input.sourceTable,
        input.sourceColumn,
        input.providerMode,
        input.totalRows ?? 0
      ]
    );
    return mapBackfillRunRow(result.rows[0]!);
  },

  async updateEncryptedFieldBackfillRun(actor, runId, input) {
    const result = await pool.query<BackfillRunRow>(
      `
        update encrypted_field_backfill_runs
        set
          status = coalesce($3::text, status),
          cursor_source_id = case
            when $4::uuid is null then cursor_source_id
            else $4::uuid
          end,
          processed_rows = coalesce($5, processed_rows),
          encrypted_rows = coalesce($6, encrypted_rows),
          failed_rows = coalesce($7, failed_rows),
          last_error_message = case
            when $8::text is null then last_error_message
            else $8
          end,
          started_at = case
            when $3 = 'processing' and started_at is null then now()
            else started_at
          end,
          completed_at = case
            when $3 in ('completed', 'error') then now()
            else completed_at
          end,
          updated_at = now()
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
        returning
          id,
          owner_user_id,
          visibility,
          source_table,
          source_column,
          provider_mode,
          status,
          cursor_source_id,
          total_rows,
          processed_rows,
          encrypted_rows,
          failed_rows,
          last_error_message,
          started_at,
          completed_at,
          created_at,
          updated_at
      `,
      [
        actor.userId,
        runId,
        input.status ?? null,
        input.cursorSourceId ?? null,
        input.processedRows ?? null,
        input.encryptedRows ?? null,
        input.failedRows ?? null,
        input.lastErrorMessage ?? null
      ]
    );
    return result.rows[0] ? mapBackfillRunRow(result.rows[0]) : null;
  },

  async backfillEncryptedFieldBatch(actor, provider, input) {
    const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
    const config = sourceConfigForBackfill(
      input.sourceTable,
      input.sourceColumn
    );
    const runResult = await pool.query<BackfillRunRow>(
      `
        ${selectBackfillRunSql}
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
          and source_table = $3
          and source_column = $4
        limit 1
      `,
      [actor.userId, input.runId, input.sourceTable, input.sourceColumn]
    );
    const run = runResult.rows[0];
    if (!run) {
      throw new Error("Encrypted field backfill run not found");
    }
    if (run.status === "completed") {
      return {
        run: mapBackfillRunRow(run),
        processedRows: 0,
        encryptedRows: 0,
        failedRows: 0,
        done: true
      };
    }
    if (run.provider_mode !== provider.mode) {
      const updatedRun = await this.updateEncryptedFieldBackfillRun(
        actor,
        input.runId,
        {
          status: "error",
          lastErrorMessage: `Backfill provider mismatch: expected ${run.provider_mode}, received ${provider.mode}`
        }
      );
      throw new Error(
        updatedRun?.lastErrorMessage ?? "Backfill provider error"
      );
    }

    await this.updateEncryptedFieldBackfillRun(actor, input.runId, {
      status: "processing"
    });

    const sourceRows = await pool.query<BackfillSourceRow>(
      `
        select
          source.id,
          source.owner_user_id,
          source.${config.valueSql(input.sourceColumn)} as plaintext
        from ${input.sourceTable} source
        where source.owner_user_id = $1
          and source.visibility = 'personal'
          and source.${input.sourceColumn} is not null
          and (${config.activePredicate})
          and ($2::uuid is null or source.id::text > $2::text)
          and not exists (
            select 1
            from encrypted_field_payloads encrypted
            where encrypted.owner_user_id = $1
              and encrypted.visibility = 'personal'
              and encrypted.source_table = $3
              and encrypted.source_id = source.id
              and encrypted.source_column = $4
              and encrypted.invalidated_at is null
          )
        order by source.id::text asc
        limit $5
      `,
      [
        actor.userId,
        run.cursor_source_id,
        input.sourceTable,
        input.sourceColumn,
        batchSize
      ]
    );

    let processedRows = 0;
    let encryptedRows = 0;
    let failedRows = 0;
    let cursorSourceId = run.cursor_source_id;
    try {
      for (const row of sourceRows.rows) {
        processedRows += 1;
        const client = await pool.connect();
        try {
          await client.query("begin");
          await upsertEncryptedFieldPayloadWithClient(client, actor, provider, {
            sourceTable: input.sourceTable,
            sourceId: row.id,
            sourceColumn: input.sourceColumn,
            plaintext: row.plaintext,
            rowFamily: input.sourceTable,
            scope: {
              tenantId: actor.userId,
              objectClass: input.sourceTable
            }
          });
          await redactBackfilledSourceColumn(client, actor, {
            sourceTable: input.sourceTable,
            sourceId: row.id,
            sourceColumn: input.sourceColumn
          });
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        cursorSourceId = row.id;
        encryptedRows += 1;
      }
    } catch (error) {
      failedRows += 1;
      const message = error instanceof Error ? error.message : String(error);
      await this.updateEncryptedFieldBackfillRun(actor, input.runId, {
        status: "error",
        cursorSourceId,
        processedRows: Number(run.processed_rows) + processedRows,
        encryptedRows: Number(run.encrypted_rows) + encryptedRows,
        failedRows: Number(run.failed_rows) + failedRows,
        lastErrorMessage: message
      });
      throw error;
    }

    const done = sourceRows.rows.length < batchSize;
    const updatedRun = await this.updateEncryptedFieldBackfillRun(
      actor,
      input.runId,
      {
        status: done ? "completed" : "processing",
        cursorSourceId,
        processedRows: Number(run.processed_rows) + processedRows,
        encryptedRows: Number(run.encrypted_rows) + encryptedRows,
        failedRows: Number(run.failed_rows) + failedRows
      }
    );
    if (!updatedRun) {
      throw new Error("Encrypted field backfill run disappeared");
    }
    return {
      run: updatedRun,
      processedRows,
      encryptedRows,
      failedRows,
      done
    };
  },

  async rewrapEncryptedFieldBatch(provider, input = {}) {
    if (!provider.rewrap) {
      throw new Error(
        `Envelope provider ${provider.mode} does not support encrypted field rewrap`
      );
    }
    const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
    const result = await pool.query<EncryptedFieldRow>(
      `
        ${selectEncryptedFieldSql}
        where provider_mode = $1
          and key_id = $2
          and invalidated_at is null
          and ($3::uuid is null or owner_user_id = $3)
          and ($4::text is null or source_table = $4)
          and ($5::text is null or source_column = $5)
          and ($6::boolean or key_version <> $7)
          and ($8::text is null or id::text > $8)
        order by id::text asc
        limit $9
      `,
      [
        provider.mode,
        provider.keyId,
        input.ownerUserId ?? null,
        input.sourceTable ?? null,
        input.sourceColumn ?? null,
        input.force ?? false,
        provider.keyVersion,
        input.afterId ?? null,
        batchSize
      ]
    );

    let rewrappedRows = 0;
    for (const row of result.rows) {
      const record = mapEncryptedFieldRow(row);
      try {
        const rewrapped = await provider.rewrap(record.envelope);
        const updated = await pool.query(
          `
            update encrypted_field_payloads
            set
              key_version = $2,
              wrapped_dek = $3::jsonb,
              envelope_reencrypted_at = $4,
              updated_at = now()
            where id = $1
              and provider_mode = $5
              and key_id = $6
              and key_version = $7
              and invalidated_at is null
          `,
          [
            row.id,
            rewrapped.keyVersion,
            JSON.stringify(rewrapped.wrappedDek),
            rewrapped.reencryptedAt,
            provider.mode,
            provider.keyId,
            row.key_version
          ]
        );
        if ((updated.rowCount ?? 0) > 0) {
          rewrappedRows += 1;
        }
      } catch {
        throw new Error(
          `Encrypted field rewrap failed after ${rewrappedRows} successful row(s)`
        );
      }
    }

    return {
      processedRows: result.rows.length,
      rewrappedRows,
      failedRows: 0,
      done: result.rows.length < batchSize,
      nextCursorId: result.rows.at(-1)?.id ?? null
    };
  }
});
