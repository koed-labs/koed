import pg from "pg";
import { createHash } from "node:crypto";
import { upsertEncryptedFieldPayloadWithClient } from "./encrypted-payload-repository.js";
import {
  combineStorageSanitizationCounts,
  metadataWithStorageSanitization,
  sanitizeForPostgresStorage,
  type EnvelopeEncryptionProvider
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

export interface ConversationItemRepositoryOptions {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
}

type ConversationItemRow = {
  id: string;
  owner_user_id: string | null;
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

const ENCRYPTED_CONVERSATION_ITEM_JSON = {
  contentEncrypted: true,
  encryptedSourceTable: "conversation_items"
} as const;

const ENCRYPTED_CONVERSATION_ITEM_TEXT = "[koed encrypted conversation item]";

const deploymentProfile = (): string =>
  process.env.KOED_DEPLOYMENT_PROFILE?.trim().toLowerCase() ?? "";

const managedCloudPlaintextConversationItemsDisabled = (): boolean => {
  const releaseStage =
    process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE?.trim().toLowerCase() ?? "";
  return (
    ["koed_managed_cloud", "koed-managed-cloud", "cloud"].includes(
      deploymentProfile()
    ) && ["paid", "production"].includes(releaseStage)
  );
};

const isPresent = (value: unknown): boolean =>
  value !== null && value !== undefined;

const rawJsonConflictPriority = (sourceRecordType: string): number =>
  sourceRecordType === "hook_payload" ? 0 : 1;

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
    eventTime: item.eventTime ?? transcriptEventTime(rawJson.value),
    metadata: metadataWithStorageSanitization(
      metadata.value as Record<string, unknown>,
      sanitizationCounts
    )
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (
  value: Record<string, unknown> | null | undefined,
  key: string
): string | null => {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field : null;
};

const transcriptEventTime = (rawJson: unknown): string | undefined => {
  const raw = isRecord(rawJson) ? rawJson : null;
  const timestamp = stringField(raw, "timestamp");
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
    return undefined;
  }
  return timestamp;
};

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const normalizedContentHash = (content: string): string =>
  sha256(content.replace(/\s+/g, " ").trim());

const itemPayload = (
  item: ConversationItemInput
): Record<string, unknown> | null => {
  const raw = isRecord(item.rawJson) ? item.rawJson : null;
  if (!raw) {
    return null;
  }
  return isRecord(raw.payload) ? raw.payload : raw;
};

const canonicalConversationActor = (
  item: ConversationItemInput
): "user" | "agent" | "subagent" | "tool" | "system" | null => {
  const metadata = item.metadata ?? {};
  const payload = itemPayload(item);
  const nestedItem = payload && isRecord(payload.item) ? payload.item : payload;
  const role =
    stringField(nestedItem, "role") ??
    (nestedItem && isRecord(nestedItem.message)
      ? stringField(nestedItem.message, "role")
      : null);
  const transcriptType =
    stringField(metadata, "transcriptType") ??
    item.sourceEventType ??
    item.sourceRecordType;
  const threadKind = stringField(metadata, "threadKind");

  if (/developer|system/i.test(role ?? "")) {
    return "system";
  }
  if (/user/i.test(transcriptType)) {
    return threadKind === "subagent" ? "agent" : "user";
  }
  if (/subagent/i.test(transcriptType)) {
    return "subagent";
  }
  if (/agent|assistant|reasoning|thought/i.test(transcriptType)) {
    return "agent";
  }
  if (/tool|function_call|custom_tool/i.test(transcriptType)) {
    return "tool";
  }
  if (/system|developer|instruction|context/i.test(transcriptType)) {
    return "system";
  }
  return null;
};

const canonicalConversationKind = (
  item: ConversationItemInput,
  actor: NonNullable<ReturnType<typeof canonicalConversationActor>>
): string => {
  const metadata = item.metadata ?? {};
  const transcriptType =
    stringField(metadata, "transcriptType") ??
    item.sourceEventType ??
    item.sourceRecordType;
  const sourceRole = stringField(metadata, "sourceRole");
  const contextKind = stringField(metadata, "contextKind");
  const toolEventKind =
    stringField(metadata, "toolEventKind") ?? transcriptType;

  if (sourceRole === "supporting_context" || contextKind) {
    return `context:${contextKind ?? sourceRole ?? "supporting"}`;
  }
  if (actor === "tool") {
    return /output|result/i.test(toolEventKind ?? "")
      ? "tool_result"
      : "tool_call";
  }
  if (/reasoning|thought/i.test(transcriptType ?? "")) {
    return /summary/i.test(transcriptType ?? "")
      ? "reasoning_summary"
      : "reasoning";
  }
  if (actor === "system") {
    return `system:${transcriptType}`;
  }
  return "message";
};

const canonicalConversationItemIdentity = (
  item: ConversationItemInput
): {
  key: string;
  actor: string;
  kind: string;
  contentHash: string;
} | null => {
  if (
    item.sourceRecordType === "hook_payload" ||
    item.sourceAdapterVersion !== "codex-transcript-v1"
  ) {
    return null;
  }
  if (
    item.logicalSourceId ||
    (item.transportChunkCount ?? 1) > 1 ||
    item.transportChunkText
  ) {
    return null;
  }
  const content = item.rawText?.replace(/\s+/g, " ").trim();
  if (!content) {
    return null;
  }
  const actor = canonicalConversationActor(item);
  if (!actor) {
    return null;
  }
  const turnIdentity =
    item.externalTurnId ??
    stringField(item.metadata ?? {}, "externalTurnId") ??
    (isRecord(item.rawJson) ? stringField(item.rawJson, "turn_id") : null);
  if (!turnIdentity) {
    return null;
  }
  const threadIdentity =
    item.externalThreadId ??
    item.externalSessionId ??
    stringField(item.metadata ?? {}, "externalSessionId") ??
    item.sessionId;
  if (!threadIdentity) {
    return null;
  }
  const kind = canonicalConversationKind(item, actor);
  if (
    kind !== "message" &&
    kind !== "reasoning_summary" &&
    kind !== "tool_call" &&
    kind !== "tool_result"
  ) {
    return null;
  }
  const contentHash = normalizedContentHash(content);
  if (item.sourcePath && typeof item.sourceSequence === "number") {
    const key = `conversation-item:${sha256({
      version: 2,
      sourceKind: item.sourceKind,
      sourcePath: item.sourcePath,
      sourceSequence: item.sourceSequence,
      actor,
      kind,
      contentHash
    })}`;
    return {
      key,
      actor,
      kind,
      contentHash
    };
  }
  const key = `conversation-item:${sha256({
    version: 1,
    sourceKind: item.sourceKind,
    threadIdentity,
    turnIdentity,
    actor,
    kind,
    contentHash
  })}`;
  return {
    key,
    actor,
    kind,
    contentHash
  };
};

const withCanonicalConversationIdentity = (
  item: ConversationItemInput
): ConversationItemInput => {
  const identity = canonicalConversationItemIdentity(item);
  if (!identity) {
    return item;
  }
  return {
    ...item,
    idempotencyKey: identity.key,
    metadata: {
      ...(item.metadata ?? {}),
      canonicalConversationItemKey: identity.key,
      canonicalConversationItemActor: identity.actor,
      canonicalConversationItemKind: identity.kind,
      canonicalConversationItemContentHash: identity.contentHash
    }
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
  pool: pg.Pool,
  options: ConversationItemRepositoryOptions = {}
): ConversationItemRepository => ({
  async createConversationItems(actor, input) {
    const records: ConversationItemRecord[] = [];
    for (const inputItem of input.items) {
      const item = withCanonicalConversationIdentity(
        sanitizeConversationItemForStorage(inputItem)
      );
      const visibility = item.visibility ?? "personal";
      const ownerUserId = actor.userId;
      const suppressPlaintextRaw =
        managedCloudPlaintextConversationItemsDisabled();
      if (suppressPlaintextRaw && !options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required when plaintext conversation item storage is disabled"
        );
      }
      const rawJsonForStorage = suppressPlaintextRaw
        ? ENCRYPTED_CONVERSATION_ITEM_JSON
        : item.rawJson;
      const rawTextForStorage =
        suppressPlaintextRaw && isPresent(item.rawText)
          ? ENCRYPTED_CONVERSATION_ITEM_TEXT
          : (item.rawText ?? null);
      const transportChunkTextForStorage =
        suppressPlaintextRaw && isPresent(item.transportChunkText)
          ? ENCRYPTED_CONVERSATION_ITEM_TEXT
          : (item.transportChunkText ?? null);
      const metadataForStorage = suppressPlaintextRaw
        ? {
            ...(item.metadata ?? {}),
            encryptedConversationItemColumns: [
              "raw_json",
              ...(isPresent(item.rawText) ? ["raw_text"] : []),
              ...(isPresent(item.transportChunkText)
                ? ["transport_chunk_text"]
                : [])
            ]
          }
        : (item.metadata ?? {});
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
      const upsertSql = `
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
        on conflict (owner_user_id, idempotency_key)
          where visibility = 'personal'
        do update set
          session_id = coalesce(excluded.session_id, conversation_items.session_id),
          turn_id = coalesce(excluded.turn_id, conversation_items.turn_id),
          source_kind = case
            when excluded.metadata ? 'canonicalConversationItemKey' and (
              case when excluded.source_record_type = 'hook_payload' then 0 else 1 end
            ) >= (
              case when conversation_items.source_record_type = 'hook_payload' then 0 else 1 end
            ) then excluded.source_kind
            else conversation_items.source_kind
          end,
          source_adapter_version = case
            when excluded.metadata ? 'canonicalConversationItemKey' and (
              case when excluded.source_record_type = 'hook_payload' then 0 else 1 end
            ) >= (
              case when conversation_items.source_record_type = 'hook_payload' then 0 else 1 end
            ) then excluded.source_adapter_version
            else conversation_items.source_adapter_version
          end,
          source_transport = case
            when excluded.metadata ? 'canonicalConversationItemKey' and (
              case when excluded.source_record_type = 'hook_payload' then 0 else 1 end
            ) >= (
              case when conversation_items.source_record_type = 'hook_payload' then 0 else 1 end
            ) then excluded.source_transport
            else conversation_items.source_transport
          end,
          external_session_id = coalesce(
            excluded.external_session_id,
            conversation_items.external_session_id
          ),
          external_thread_id = coalesce(
            excluded.external_thread_id,
            conversation_items.external_thread_id
          ),
          external_turn_id = coalesce(
            excluded.external_turn_id,
            conversation_items.external_turn_id
          ),
          external_item_id = coalesce(
            excluded.external_item_id,
            conversation_items.external_item_id
          ),
          parent_external_item_id = coalesce(
            excluded.parent_external_item_id,
            conversation_items.parent_external_item_id
          ),
          source_record_type = case
            when excluded.metadata ? 'canonicalConversationItemKey' and (
              case when excluded.source_record_type = 'hook_payload' then 0 else 1 end
            ) >= (
              case when conversation_items.source_record_type = 'hook_payload' then 0 else 1 end
            ) then excluded.source_record_type
            else conversation_items.source_record_type
          end,
          source_event_type = case
            when excluded.metadata ? 'canonicalConversationItemKey' and (
              case when excluded.source_record_type = 'hook_payload' then 0 else 1 end
            ) >= (
              case when conversation_items.source_record_type = 'hook_payload' then 0 else 1 end
            ) then excluded.source_event_type
            else conversation_items.source_event_type
          end,
          source_path = coalesce(
            excluded.source_path,
            conversation_items.source_path
          ),
          source_line_number = coalesce(
            excluded.source_line_number,
            conversation_items.source_line_number
          ),
          source_sequence = coalesce(
            excluded.source_sequence,
            conversation_items.source_sequence
          ),
          event_time = coalesce(
            excluded.event_time,
            conversation_items.event_time
          ),
          raw_json = case
            when excluded.metadata ? 'canonicalConversationItemKey' and (
              case when excluded.source_record_type = 'hook_payload' then 0 else 1 end
            ) >= (
              case when conversation_items.source_record_type = 'hook_payload' then 0 else 1 end
            ) then excluded.raw_json
            else conversation_items.raw_json
          end,
          raw_text = coalesce(excluded.raw_text, conversation_items.raw_text),
          logical_source_id = coalesce(
            excluded.logical_source_id,
            conversation_items.logical_source_id
          ),
          transport_chunk_index = case
            when excluded.transport_chunk_count > conversation_items.transport_chunk_count
            then excluded.transport_chunk_index
            else conversation_items.transport_chunk_index
          end,
          transport_chunk_count = greatest(
            conversation_items.transport_chunk_count,
            excluded.transport_chunk_count
          ),
          transport_chunk_text = coalesce(
            excluded.transport_chunk_text,
            conversation_items.transport_chunk_text
          ),
          transport_chunk_encoding = coalesce(
            excluded.transport_chunk_encoding,
            conversation_items.transport_chunk_encoding
          ),
          projection_status = case
            when conversation_items.projection_status = 'projected'
              and excluded.metadata ? 'canonicalConversationItemKey'
              and (
                case when excluded.source_record_type = 'hook_payload' then 0 else 1 end
              ) >= (
                case when conversation_items.source_record_type = 'hook_payload' then 0 else 1 end
              )
            then 'pending'
            else conversation_items.projection_status
          end,
          projection_version = case
            when excluded.metadata ? 'canonicalConversationItemKey' and (
              case when excluded.source_record_type = 'hook_payload' then 0 else 1 end
            ) >= (
              case when conversation_items.source_record_type = 'hook_payload' then 0 else 1 end
            ) then excluded.projection_version
            else conversation_items.projection_version
          end,
          projection_error = null,
          projected_at = case
            when conversation_items.projection_status = 'projected'
              and excluded.metadata ? 'canonicalConversationItemKey'
              and (
                case when excluded.source_record_type = 'hook_payload' then 0 else 1 end
              ) >= (
                case when conversation_items.source_record_type = 'hook_payload' then 0 else 1 end
              )
            then null
            else conversation_items.projected_at
          end,
          metadata = conversation_items.metadata || excluded.metadata
        returning
          id, owner_user_id, session_id, turn_id, source_kind,
          source_adapter_version, source_transport, external_session_id,
          external_thread_id, external_turn_id, external_item_id,
          source_record_type, source_event_type, source_sequence,
          idempotency_key, created_at
      `;
      const upsertParams = [
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
        JSON.stringify(rawJsonForStorage),
        rawTextForStorage,
        item.logicalSourceId ?? null,
        item.transportChunkIndex ?? 0,
        item.transportChunkCount ?? 1,
        transportChunkTextForStorage,
        item.transportChunkEncoding ?? null,
        item.sourceHash,
        item.idempotencyKey,
        item.projectionStatus ?? "pending",
        item.projectionVersion ?? null,
        item.projectionError ?? null,
        metadataForStorage
      ];
      const upsertedRow = suppressPlaintextRaw
        ? await (async (): Promise<ConversationItemRow | undefined> => {
            const client = await pool.connect();
            try {
              await client.query("begin");
              await client.query(
                "select pg_advisory_xact_lock(hashtextextended($1, 0))",
                [
                  `conversation_items:${ownerUserId ?? "anonymous"}:${visibility}:${item.idempotencyKey}`
                ]
              );
              const existing = await client.query<{
                source_record_type: string;
              }>(
                `
	                  select source_record_type
	                  from conversation_items
	                  where owner_user_id = $1
	                    and idempotency_key = $2
	                    and visibility = $3::visibility_scope
	                  for update
	                `,
                [ownerUserId, item.idempotencyKey, visibility]
              );
              const existingSourceRecordType =
                existing.rows[0]?.source_record_type;
              const incomingHasCanonicalIdentity =
                Object.prototype.hasOwnProperty.call(
                  metadataForStorage,
                  "canonicalConversationItemKey"
                );
              const shouldWriteRawJson =
                !existingSourceRecordType ||
                (incomingHasCanonicalIdentity &&
                  rawJsonConflictPriority(item.sourceRecordType) >=
                    rawJsonConflictPriority(existingSourceRecordType));
              const result = await client.query<ConversationItemRow>(
                upsertSql,
                upsertParams
              );
              const row = result.rows[0];
              if (row && shouldWriteRawJson) {
                await upsertEncryptedFieldPayloadWithClient(
                  client,
                  { userId: ownerUserId },
                  options.envelopeEncryptionProvider!,
                  {
                    sourceTable: "conversation_items",
                    sourceId: row.id,
                    sourceColumn: "raw_json",
                    plaintext: item.rawJson,
                    rowFamily: "conversation_item",
                    scope: {
                      tenantId: ownerUserId,
                      workspaceId: item.sessionId ?? null,
                      objectClass: "conversation_item"
                    },
                    aad: {
                      sourceRecordType: item.sourceRecordType,
                      sourceEventType: item.sourceEventType ?? null
                    }
                  }
                );
              }
              if (row && isPresent(item.rawText)) {
                await upsertEncryptedFieldPayloadWithClient(
                  client,
                  { userId: ownerUserId },
                  options.envelopeEncryptionProvider!,
                  {
                    sourceTable: "conversation_items",
                    sourceId: row.id,
                    sourceColumn: "raw_text",
                    plaintext: item.rawText,
                    rowFamily: "conversation_item",
                    scope: {
                      tenantId: ownerUserId,
                      workspaceId: item.sessionId ?? null,
                      objectClass: "conversation_item"
                    },
                    aad: {
                      sourceRecordType: item.sourceRecordType,
                      sourceEventType: item.sourceEventType ?? null
                    }
                  }
                );
              }
              if (row && isPresent(item.transportChunkText)) {
                await upsertEncryptedFieldPayloadWithClient(
                  client,
                  { userId: ownerUserId },
                  options.envelopeEncryptionProvider!,
                  {
                    sourceTable: "conversation_items",
                    sourceId: row.id,
                    sourceColumn: "transport_chunk_text",
                    plaintext: item.transportChunkText,
                    rowFamily: "conversation_item",
                    scope: {
                      tenantId: ownerUserId,
                      workspaceId: item.sessionId ?? null,
                      objectClass: "conversation_item"
                    },
                    aad: {
                      sourceRecordType: item.sourceRecordType,
                      sourceEventType: item.sourceEventType ?? null
                    }
                  }
                );
              }
              await client.query("commit");
              return row;
            } catch (error) {
              await client.query("rollback");
              throw error;
            } finally {
              client.release();
            }
          })()
        : (await pool.query<ConversationItemRow>(upsertSql, upsertParams))
            .rows[0];
      const row =
        upsertedRow ??
        (
          await pool.query<ConversationItemRow>(
            `
              select
                id, owner_user_id, session_id, turn_id, source_kind,
                source_adapter_version, source_transport, external_session_id,
                external_thread_id, external_turn_id, external_item_id,
                source_record_type, source_event_type, source_sequence,
                idempotency_key, created_at
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
