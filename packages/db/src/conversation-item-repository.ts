import pg from "pg";
import {
  combineStorageSanitizationCounts,
  metadataWithStorageSanitization,
  sanitizeForPostgresStorage
} from "@koed/shared";
import type {
  ActorContext,
  CaptureMethod,
  ConversationItemInput,
  ConversationItemRecord,
  Visibility
} from "./types.js";

export interface ConversationItemRepository {
  createConversationItems(
    actor: ActorContext,
    input: { items: ConversationItemInput[] }
  ): Promise<ConversationItemRecord[]>;
}

type ConversationItemRow = {
  id: string;
  session_id: string | null;
  turn_id: string | null;
  source_kind: string;
  source_adapter_version: string;
  source_transport: string;
  external_session_id: string | null;
  external_thread_id: string | null;
  external_turn_id: string | null;
  external_item_id: string | null;
  source_record_type: string;
  source_event_type: string | null;
  source_sequence: number | null;
  idempotency_key: string;
  created_at: Date;
};

const sanitizeConversationItemForStorage = (
  item: ConversationItemInput
): ConversationItemInput => {
  const rawJson = sanitizeForPostgresStorage(item.rawJson);
  const rawText = sanitizeForPostgresStorage(item.rawText);
  const metadata = sanitizeForPostgresStorage(item.metadata ?? {});
  const sourceKind = sanitizeForPostgresStorage(item.sourceKind);
  const sourceAdapterVersion = sanitizeForPostgresStorage(
    item.sourceAdapterVersion
  );
  const sourceTransport = sanitizeForPostgresStorage(item.sourceTransport);
  const externalSessionId = sanitizeForPostgresStorage(item.externalSessionId);
  const externalThreadId = sanitizeForPostgresStorage(item.externalThreadId);
  const externalTurnId = sanitizeForPostgresStorage(item.externalTurnId);
  const externalItemId = sanitizeForPostgresStorage(item.externalItemId);
  const parentExternalItemId = sanitizeForPostgresStorage(
    item.parentExternalItemId
  );
  const sourceRecordType = sanitizeForPostgresStorage(item.sourceRecordType);
  const sourceEventType = sanitizeForPostgresStorage(item.sourceEventType);
  const sourcePath = sanitizeForPostgresStorage(item.sourcePath);
  const logicalSourceId = sanitizeForPostgresStorage(item.logicalSourceId);
  const transportChunkText = sanitizeForPostgresStorage(
    item.transportChunkText
  );
  const transportChunkEncoding = sanitizeForPostgresStorage(
    item.transportChunkEncoding
  );
  const sourceHash = sanitizeForPostgresStorage(item.sourceHash);
  const idempotencyKey = sanitizeForPostgresStorage(item.idempotencyKey);
  const projectionStatus = sanitizeForPostgresStorage(item.projectionStatus);
  const projectionVersion = sanitizeForPostgresStorage(item.projectionVersion);
  const projectionError = sanitizeForPostgresStorage(item.projectionError);
  const sanitizationCounts = combineStorageSanitizationCounts(
    rawJson,
    rawText,
    metadata,
    sourceKind,
    sourceAdapterVersion,
    sourceTransport,
    externalSessionId,
    externalThreadId,
    externalTurnId,
    externalItemId,
    parentExternalItemId,
    sourceRecordType,
    sourceEventType,
    sourcePath,
    logicalSourceId,
    transportChunkText,
    transportChunkEncoding,
    sourceHash,
    idempotencyKey,
    projectionStatus,
    projectionVersion,
    projectionError
  );

  return {
    ...item,
    sourceKind: sourceKind.value as string,
    sourceAdapterVersion: sourceAdapterVersion.value as string,
    sourceTransport: sourceTransport.value as string,
    externalSessionId: externalSessionId.value as string | undefined,
    externalThreadId: externalThreadId.value as string | undefined,
    externalTurnId: externalTurnId.value as string | undefined,
    externalItemId: externalItemId.value as string | undefined,
    parentExternalItemId: parentExternalItemId.value as string | undefined,
    sourceRecordType: sourceRecordType.value as string,
    sourceEventType: sourceEventType.value as string | undefined,
    sourcePath: sourcePath.value as string | undefined,
    rawJson: rawJson.value,
    rawText: rawText.value as string | undefined,
    logicalSourceId: logicalSourceId.value as string | undefined,
    transportChunkText: transportChunkText.value as string | undefined,
    transportChunkEncoding: transportChunkEncoding.value as string | undefined,
    sourceHash: sourceHash.value as string,
    idempotencyKey: idempotencyKey.value as string,
    projectionStatus: projectionStatus.value as
      | ConversationItemInput["projectionStatus"]
      | undefined,
    projectionVersion: projectionVersion.value as string | undefined,
    projectionError: projectionError.value as string | undefined,
    metadata: metadataWithStorageSanitization(
      metadata.value as Record<string, unknown>,
      sanitizationCounts
    )
  };
};

const mapConversationItem = (
  row: ConversationItemRow
): ConversationItemRecord => ({
  id: row.id,
  sessionId: row.session_id,
  turnId: row.turn_id,
  sourceKind: row.source_kind,
  sourceAdapterVersion: row.source_adapter_version,
  sourceTransport: row.source_transport,
  externalSessionId: row.external_session_id,
  externalThreadId: row.external_thread_id,
  externalTurnId: row.external_turn_id,
  externalItemId: row.external_item_id,
  sourceRecordType: row.source_record_type,
  sourceEventType: row.source_event_type,
  sourceSequence: row.source_sequence,
  idempotencyKey: row.idempotency_key,
  createdAt: row.created_at.toISOString()
});

const captureMethodForConversationItem = (
  item: Pick<ConversationItemInput, "sourceTransport">
): CaptureMethod => {
  if (item.sourceTransport === "hook") {
    return "hook";
  }
  if (item.sourceTransport === "mcp") {
    return "mcp";
  }
  if (item.sourceTransport === "web") {
    return "web";
  }
  return "api";
};

const ensureConversationItemTurn = async (
  pool: pg.Pool,
  input: {
    ownerUserId: string | null;
    visibility: Visibility;
    item: ConversationItemInput;
  }
): Promise<string | null> => {
  const { item } = input;
  if (item.turnId) {
    const turn = await pool.query<{ id: string }>(
      `
        select id
        from turns
        where id = $1
          and visibility = $2::visibility_scope
          and owner_user_id = $3
          and ($4::uuid is null or session_id = $4)
        limit 1
      `,
      [item.turnId, input.visibility, input.ownerUserId, item.sessionId ?? null]
    );
    if (turn.rowCount === 0) {
      throw new Error("Turn not found or not visible");
    }
    return item.turnId;
  }
  if (!item.sessionId || !item.externalTurnId) {
    return null;
  }

  let result: pg.QueryResult<{ id: string }> | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      result = await pool.query<{ id: string }>(
        `
          insert into turns (
            session_id,
            owner_user_id,
            visibility,
            external_turn_id,
            source_runtime,
            capture_method,
            codex_transcript_path,
            idempotency_key,
            source_hash,
            turn_index,
            source_kind,
            source_adapter_version,
            external_thread_id,
            source_metadata
          )
          values (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9,
            coalesce(
              (select max(turn_index) + 1 from turns where session_id = $1),
              0
            ),
            $10, $11, $12, $13
          )
          on conflict (session_id, external_turn_id)
            where external_turn_id is not null
          do update set
            source_kind = coalesce(turns.source_kind, excluded.source_kind),
            source_adapter_version = coalesce(
              turns.source_adapter_version,
              excluded.source_adapter_version
            ),
            external_thread_id = coalesce(
              turns.external_thread_id,
              excluded.external_thread_id
            ),
            source_metadata = turns.source_metadata || excluded.source_metadata
          returning id
        `,
        [
          item.sessionId,
          input.ownerUserId,
          input.visibility,
          item.externalTurnId,
          item.sourceKind === "codex-cli" ? "codex-cli" : "codex",
          captureMethodForConversationItem(item),
          item.sourcePath ?? null,
          `turn:${item.sessionId}:${item.externalTurnId}`,
          `turn:${item.sessionId}:${item.externalTurnId}`,
          item.sourceKind,
          item.sourceAdapterVersion,
          item.externalThreadId ?? item.externalSessionId ?? null,
          {
            externalSessionId: item.externalSessionId,
            externalThreadId: item.externalThreadId ?? item.externalSessionId,
            sourceTransport: item.sourceTransport
          }
        ]
      );
      break;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
      const constraint =
        typeof error === "object" && error !== null && "constraint" in error
          ? String(error.constraint)
          : "";
      if (
        code === "23505" &&
        constraint === "turns_session_turn_index_unique" &&
        attempt < 4
      ) {
        continue;
      }
      throw error;
    }
  }

  return result?.rows[0]?.id ?? null;
};

export const createConversationItemRepository = (
  pool: pg.Pool
): ConversationItemRepository => ({
  async createConversationItems(actor, input) {
    const records: ConversationItemRecord[] = [];
    for (const inputItem of input.items) {
      const item = sanitizeConversationItemForStorage(inputItem);
      const visibility = item.visibility ?? "personal";
      const ownerUserId = actor.userId;
      if (item.sessionId) {
        const visibleSession = await pool.query<{ id: string }>(
          `
            select s.id
            from sessions s
            where s.id = $2
              and s.invalidated_at is null
              and s.visibility = $3::visibility_scope
              and s.owner_user_id = $1
            limit 1
          `,
          [actor.userId, item.sessionId, visibility]
        );
        if (visibleSession.rowCount === 0) {
          throw new Error("Session not found or not visible");
        }
      }

      const turnId = await ensureConversationItemTurn(pool, {
        ownerUserId,
        visibility,
        item
      });
      const result = await pool.query<ConversationItemRow>(
        `
          insert into conversation_items (
            owner_user_id,
            visibility,
            session_id,
            turn_id,
            source_kind,
            source_adapter_version,
            source_transport,
            external_session_id,
            external_thread_id,
            external_turn_id,
            external_item_id,
            parent_external_item_id,
            source_record_type,
            source_event_type,
            source_path,
            source_line_number,
            source_sequence,
            event_time,
            raw_json,
            raw_text,
            logical_source_id,
            transport_chunk_index,
            transport_chunk_count,
            transport_chunk_text,
            transport_chunk_encoding,
            source_hash,
            idempotency_key,
            projection_status,
            projection_version,
            projection_error,
            metadata
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
            $29, $30, $31
          )
          on conflict do nothing
          returning
            id, session_id, turn_id, source_kind, source_adapter_version,
            source_transport, external_session_id, external_thread_id,
            external_turn_id, external_item_id, source_record_type,
            source_event_type, source_sequence, idempotency_key, created_at
        `,
        [
          ownerUserId,
          visibility,
          item.sessionId ?? null,
          turnId,
          item.sourceKind,
          item.sourceAdapterVersion,
          item.sourceTransport,
          item.externalSessionId ?? null,
          item.externalThreadId ?? item.externalSessionId ?? null,
          item.externalTurnId ?? null,
          item.externalItemId ?? null,
          item.parentExternalItemId ?? null,
          item.sourceRecordType,
          item.sourceEventType ?? null,
          item.sourcePath ?? null,
          item.sourceLineNumber ?? null,
          item.sourceSequence ?? null,
          item.eventTime ?? null,
          JSON.stringify(item.rawJson),
          item.rawText ?? null,
          item.logicalSourceId ?? null,
          item.transportChunkIndex ?? 0,
          item.transportChunkCount ?? 1,
          item.transportChunkText ?? null,
          item.transportChunkEncoding ?? null,
          item.sourceHash,
          item.idempotencyKey,
          item.projectionStatus ?? "pending",
          item.projectionVersion ?? null,
          item.projectionError ?? null,
          item.metadata ?? {}
        ]
      );
      const row =
        result.rows[0] ??
        (
          await pool.query<ConversationItemRow>(
            `
              select
                id, session_id, turn_id, source_kind, source_adapter_version,
                source_transport, external_session_id, external_thread_id,
                external_turn_id, external_item_id, source_record_type,
                source_event_type, source_sequence, idempotency_key, created_at
              from conversation_items
              where idempotency_key = $1
                and visibility = $2::visibility_scope
                and owner_user_id = $3
              limit 1
            `,
            [item.idempotencyKey, visibility, ownerUserId]
          )
        ).rows[0];
      if (!row) {
        throw Object.assign(
          new Error(
            "Duplicate raw conversation item conflicts with data outside caller visibility"
          ),
          { statusCode: 409 }
        );
      }
      records.push(mapConversationItem(row));
    }
    return records;
  }
});
