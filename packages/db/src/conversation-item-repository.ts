import pg from "pg";
import { createHash } from "node:crypto";
import {
  decryptAuthorizedEncryptedFieldPayloadWithClient,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import {
  combineStorageSanitizationCounts,
  codexCanonicalConversationItemKey,
  metadataWithStorageSanitization,
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES,
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT,
  rawConversationTransportChunkGroupId,
  sanitizeForPostgresStorage,
  projectionWorkClassForSourceTransport,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import type {
  ActorContext,
  CaptureMethod,
  ConversationItemInput,
  ConversationItemRecord,
  EffectiveCapturePolicy,
  SourceRuntime,
  Visibility
} from "./types.js";

export interface ConversationItemRepository {
  createConversationItems(
    actor: ActorContext,
    input: { items: ConversationItemInput[] }
  ): Promise<ConversationItemRecord[]>;
  releaseConversationProjectionHold(
    actor: ActorContext,
    input: { sessionId: string; externalTurnId: string }
  ): Promise<{ conversationItemIds: string[] }>;
  findConversationItemByStableIdentity(
    actor: ActorContext,
    input: { sessionId: string; canonicalStableItemId: string }
  ): Promise<ConversationItemRecord | null>;
}

export interface ConversationItemRepositoryOptions {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  transactionClient?: pg.PoolClient;
  resolveCapturePolicy?: (
    actor: ActorContext,
    input: { projectId?: string; threadId?: string; sessionId?: string }
  ) => Promise<EffectiveCapturePolicy>;
}

type ConversationItemSessionRow = {
  id: string;
  external_session_id: string | null;
  external_thread_id: string | null;
  capture_method: string;
  automatic_project_id: string | null;
  project_override_id: string | null;
  cwd: string | null;
  metadata: Record<string, unknown> | null;
};

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
  canonical_stable_item_id: string | null;
  source_record_type: string;
  source_event_type: string | null;
  source_sequence: number | null;
  source_hash: string;
  idempotency_key: string;
  canonical_item_key: string;
  canonical_source_priority: number;
  observed_at: Date;
  import_observed_at: Date | null;
  source_fingerprint: string | null;
  captured_project: Record<string, unknown>;
  created_at: Date;
};

type ConversationItemObservationRow = {
  id: string;
  inserted: boolean;
};

type ExistingConversationItemObservationRow = {
  id: string;
  conversation_item_id: string | null;
  canonical_item_key: string | null;
  observation_key: string;
  payload_hash: string;
  source_hash: string;
  metadata: Record<string, unknown> | null;
};

const ENCRYPTED_CONVERSATION_ITEM_JSON = {
  contentEncrypted: true,
  encryptedSourceTable: "conversation_items"
} as const;

const ENCRYPTED_CONVERSATION_ITEM_TEXT = "[koed encrypted conversation item]";

const ENCRYPTED_CONVERSATION_ITEM_OBSERVATION_JSON = {
  contentEncrypted: true,
  encryptedSourceTable: "conversation_item_observations"
} as const;

const ENCRYPTED_CONVERSATION_ITEM_OBSERVATION_TEXT =
  "[koed encrypted conversation item observation]";

const SAFE_CONVERSATION_METADATA_KEYS = new Set([
  "transcriptType",
  "transcriptParentType",
  "transcriptIndex",
  "transcriptId",
  "transcriptByteOffset",
  "transcriptSourceLineNumber",
  "transcriptAssignedTurnId",
  "toolEventKind",
  "toolName",
  "callId",
  "toolCallId",
  "status",
  "threadKind",
  "parentThreadId",
  "parentSessionId",
  "parentExternalSessionId",
  "managedConversationReconciliation",
  "managedConversationSourceRole",
  "appServerItemType",
  "clientUserMessageId",
  "phase",
  "sourceEventTimeAccuracy",
  "canonicalIdentityBasis",
  "questionId",
  "nodeId",
  "includeInLcm",
  "storageSanitization",
  "transportChunkGroupId",
  "sourceItemHash",
  "sourceChunkIndex",
  "sourceChunkCount",
  "sourceRuntime",
  "sourceComponentId"
]);

export const safeConversationMetadataForEncryptedStorage = (
  metadata: Record<string, unknown>,
  markerKey: string,
  encryptedColumns: string[]
): Record<string, unknown> => {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_CONVERSATION_METADATA_KEYS.has(key)) {
      continue;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value.length <= 512)
    ) {
      safe[key] = value;
      continue;
    }
    if (key === "storageSanitization" && isRecord(value)) {
      safe[key] = Object.fromEntries(
        Object.entries(value).filter(
          ([, entry]) => typeof entry === "number" && Number.isFinite(entry)
        )
      );
    }
  }
  const toolCall = isRecord(metadata.toolCall)
    ? Object.fromEntries(
        Object.entries(metadata.toolCall).filter(
          ([key, value]) =>
            ["kind", "type", "name", "id", "status"].includes(key) &&
            typeof value === "string" &&
            value.length <= 256
        )
      )
    : null;
  return {
    ...safe,
    ...(toolCall && Object.keys(toolCall).length > 0 ? { toolCall } : {}),
    [markerKey]: encryptedColumns
  };
};

const ENCRYPTED_CONVERSATION_ITEM_SOURCE_COLUMNS = [
  "raw_json",
  "raw_text",
  "transport_chunk_text",
  "metadata"
] as const;

const synchronizeEncryptedConversationItemColumns = async (input: {
  client: pg.PoolClient;
  sourceId: string;
}): Promise<void> => {
  await input.client.query(
    `
      update conversation_items as source
      set metadata = jsonb_set(
        coalesce(source.metadata, '{}'::jsonb),
        $2::text[],
        coalesce(
          (
            select jsonb_agg(payload.source_column order by array_position($3::text[], payload.source_column))
            from encrypted_field_payloads as payload
            where payload.source_table = $4
              and payload.source_id = source.id
              and payload.source_column = any($3::text[])
              and payload.invalidated_at is null
          ),
          '[]'::jsonb
        ),
        true
      )
      where source.id = $1
    `,
    [
      input.sourceId,
      ["encryptedConversationItemColumns"],
      [...ENCRYPTED_CONVERSATION_ITEM_SOURCE_COLUMNS],
      "conversation_items"
    ]
  );
};

const mergeCanonicalConversationMetadata = (input: {
  existing: Record<string, unknown>;
  incoming: Record<string, unknown>;
  incomingWins: boolean;
}): Record<string, unknown> => {
  const lowerPriority = input.incomingWins ? input.existing : input.incoming;
  const higherPriority = input.incomingWins ? input.incoming : input.existing;
  const lowerToolCall = isRecord(lowerPriority.toolCall)
    ? lowerPriority.toolCall
    : {};
  const higherToolCall = isRecord(higherPriority.toolCall)
    ? higherPriority.toolCall
    : {};
  const mergeToolPayload = (key: "input" | "output"): unknown => {
    const lower = lowerToolCall[key];
    const higher = higherToolCall[key];
    if (isRecord(lower) && isRecord(higher)) {
      return { ...lower, ...higher };
    }
    return higher !== undefined ? higher : lower;
  };
  const toolInput = mergeToolPayload("input");
  const toolOutput = mergeToolPayload("output");
  const toolCall = {
    ...lowerToolCall,
    ...higherToolCall,
    ...(toolInput !== undefined ? { input: toolInput } : {}),
    ...(toolOutput !== undefined ? { output: toolOutput } : {})
  };
  return {
    ...lowerPriority,
    ...higherPriority,
    ...(Object.keys(toolCall).length > 0 ? { toolCall } : {})
  };
};

const loadCanonicalConversationMetadata = async (input: {
  client: pg.PoolClient;
  actor: ActorContext;
  provider: EnvelopeEncryptionProvider;
  sourceId: string;
  storedMetadata: Record<string, unknown> | null;
}): Promise<Record<string, unknown>> => {
  const decrypted = await decryptAuthorizedEncryptedFieldPayloadWithClient(
    input.client,
    input.actor,
    input.provider,
    {
      sourceTable: "conversation_items",
      sourceId: input.sourceId,
      sourceColumn: "metadata"
    }
  );
  if (decrypted) {
    if (!isRecord(decrypted.plaintext)) {
      throw new Error("Encrypted canonical conversation metadata is invalid");
    }
    return decrypted.plaintext;
  }
  const encryptedColumns =
    input.storedMetadata?.encryptedConversationItemColumns;
  if (
    Array.isArray(encryptedColumns) &&
    encryptedColumns.includes("metadata")
  ) {
    throw new Error("Encrypted canonical conversation metadata is missing");
  }
  return input.storedMetadata ?? {};
};

const deploymentProfile = (): string =>
  process.env.KOED_DEPLOYMENT_PROFILE?.trim().toLowerCase() ?? "";

const managedCloudPlaintextConversationItemsDisabled = (): boolean => {
  const profile = deploymentProfile();
  const releaseStage =
    process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE?.trim().toLowerCase() ?? "";
  if (
    [
      "koed_managed_cloud",
      "koed-managed-cloud",
      "cloud",
      "team_self_hosted",
      "team-self-hosted",
      "private_vps",
      "private-vps"
    ].includes(profile)
  ) {
    return true;
  }
  return (
    ["koed_managed_cloud", "koed-managed-cloud", "cloud"].includes(profile) &&
    ["paid", "production"].includes(releaseStage)
  );
};

const hasEncryptableText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

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
  const logicalSourceId = sanitizeForPostgresStorage(item.logicalSourceId);
  const transportChunkText = sanitizeForPostgresStorage(
    item.transportChunkText
  );
  const transportChunkEncoding = sanitizeForPostgresStorage(
    item.transportChunkEncoding
  );
  const sourceFingerprint = sanitizeForPostgresStorage(item.sourceFingerprint);
  const capturedProject = sanitizeForPostgresStorage(
    item.capturedProject ?? {}
  );
  const sourceHash = sanitizeForPostgresStorage(item.sourceHash);
  const idempotencyKey = sanitizeForPostgresStorage(item.idempotencyKey);
  const canonicalItemKey = sanitizeForPostgresStorage(item.canonicalItemKey);
  const canonicalStableItemId = sanitizeForPostgresStorage(
    item.canonicalStableItemId
  );
  const observationKind = sanitizeForPostgresStorage(item.observationKind);
  const observationComponent = sanitizeForPostgresStorage(
    item.observationComponent
  );
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
    logicalSourceId,
    transportChunkText,
    transportChunkEncoding,
    sourceFingerprint,
    capturedProject,
    sourceHash,
    idempotencyKey,
    canonicalItemKey,
    canonicalStableItemId,
    observationKind,
    observationComponent,
    projectionStatus,
    projectionVersion,
    projectionError
  );

  const sanitizedMetadata = metadataWithStorageSanitization(
    metadata.value as Record<string, unknown>,
    sanitizationCounts
  );
  for (const key of [
    "projectionPolicyKey",
    "projectionActor",
    "semanticControl",
    "canonicalConversationItemKey",
    "canonicalConversationItemActor",
    "canonicalConversationItemKind",
    "canonicalConversationItemContentHash",
    "canonicalStableItemId",
    "managedConversation"
  ]) {
    delete sanitizedMetadata[key];
  }
  if (
    item.sessionId ||
    item.sourceAdapterVersion !== "codex-app-server-v1" ||
    !["memory_question", "lcm_summary"].includes(
      stringField(sanitizedMetadata, "workflow") ?? ""
    )
  ) {
    delete sanitizedMetadata.workflow;
  }

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
    rawJson: rawJson.value,
    rawText: rawText.value as string | undefined,
    logicalSourceId: logicalSourceId.value as string | undefined,
    transportChunkText: transportChunkText.value as string | undefined,
    transportChunkEncoding: transportChunkEncoding.value as string | undefined,
    sourceFingerprint: sourceFingerprint.value as string | undefined,
    capturedProject: capturedProject.value as Record<string, unknown>,
    sourceHash: sourceHash.value as string,
    idempotencyKey: idempotencyKey.value as string,
    canonicalItemKey: canonicalItemKey.value as string | undefined,
    canonicalStableItemId: canonicalStableItemId.value as string | undefined,
    observationKind: observationKind.value as
      | ConversationItemInput["observationKind"]
      | undefined,
    observationComponent: observationComponent.value as string | undefined,
    projectionStatus: projectionStatus.value as
      | ConversationItemInput["projectionStatus"]
      | undefined,
    projectionVersion: projectionVersion.value as string | undefined,
    projectionError: projectionError.value as string | undefined,
    eventTime: item.eventTime ?? transcriptEventTime(rawJson.value),
    metadata: sanitizedMetadata
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

const conversationSourceRuntime = (
  sourceKind: string,
  metadata?: Record<string, unknown> | null
): SourceRuntime => {
  const explicit = stringField(metadata, "sourceRuntime");
  if (
    explicit === "codex" ||
    explicit === "codex-cli" ||
    explicit === "claude-code"
  ) {
    return explicit;
  }
  if (sourceKind === "codex-cli" || sourceKind === "claude-code") {
    return sourceKind;
  }
  return "codex";
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

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])])
  );
};

const observationPayloadHashFor = (item: ConversationItemInput): string =>
  sha256(
    canonicalJsonValue({
      sourceKind: item.sourceKind,
      sourceAdapterVersion: item.sourceAdapterVersion,
      sourceTransport: item.sourceTransport,
      sourceRecordType: item.sourceRecordType,
      sourceEventType: item.sourceEventType ?? null,
      rawJson: item.rawJson,
      rawText: item.rawText ?? null,
      transportChunkIndex: item.transportChunkIndex ?? null,
      transportChunkCount: item.transportChunkCount ?? null,
      transportChunkText: item.transportChunkText ?? null,
      transportChunkEncoding: item.transportChunkEncoding ?? null,
      sourceHash: item.sourceHash
    })
  );

const normalizedContentHash = (content: string): string =>
  sha256(content.replace(/\s+/g, " ").trim());

const itemPayload = (
  item: ConversationItemInput
): Record<string, unknown> | null => {
  const raw = isRecord(item.rawJson) ? item.rawJson : null;
  if (!raw) {
    return null;
  }
  const container = isRecord(raw.payload)
    ? raw.payload
    : isRecord(raw.params)
      ? raw.params
      : raw;
  return isRecord(container.item) ? container.item : container;
};

const canonicalConversationActor = (
  item: ConversationItemInput
): "user" | "agent" | "subagent" | "tool" | "system" | null => {
  const metadata = item.metadata ?? {};
  const nestedItem = itemPayload(item);
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

  if (/^(developer|system)$/i.test(role ?? "")) {
    return "system";
  }
  if (/^user$/i.test(role ?? "")) {
    return threadKind === "subagent" ? "agent" : "user";
  }
  if (/^assistant$/i.test(role ?? "")) {
    return threadKind === "subagent" ? "subagent" : "agent";
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

const withCanonicalConversationIdentity = (
  item: ConversationItemInput
): ConversationItemInput => {
  if (item.observationOnly) {
    if (item.canonicalItemKey) {
      throw Object.assign(
        new Error(
          "Observation-only source records cannot claim canonical identity"
        ),
        { statusCode: 400, code: "observation_only_canonical_identity" }
      );
    }
    return item;
  }
  if (item.canonicalItemKey) {
    const actor = canonicalConversationActor(item);
    const kind = actor ? canonicalConversationKind(item, actor) : null;
    const component = item.observationComponent;
    const threadIdentity = item.externalThreadId ?? item.externalSessionId;
    const turnIdentity = item.externalTurnId;
    const stableItemId = item.canonicalStableItemId;
    if (!threadIdentity || !turnIdentity || !stableItemId || !component) {
      throw Object.assign(
        new Error(
          "Canonical conversation identity requires exact thread, turn, item, and component identity"
        ),
        { statusCode: 400, code: "canonical_identity_incomplete" }
      );
    }
    if (
      kind &&
      ["message", "reasoning_summary", "tool_call", "tool_result"].includes(
        kind
      ) &&
      component !== kind
    ) {
      throw Object.assign(
        new Error(
          `Canonical conversation component '${component}' does not match '${kind}'`
        ),
        { statusCode: 400, code: "canonical_component_mismatch" }
      );
    }
    const provider =
      item.sourceKind === "codex-cli" ? "codex" : item.sourceKind;
    const expectedKey =
      provider === "codex"
        ? codexCanonicalConversationItemKey({
            externalThreadId: threadIdentity,
            externalTurnId: turnIdentity,
            stableItemId,
            component
          })
        : `conversation-item:${sha256({
            version: 3,
            provider,
            externalThreadId: threadIdentity,
            externalTurnId: turnIdentity,
            stableItemId,
            component
          })}`;
    if (item.canonicalItemKey !== expectedKey) {
      throw Object.assign(
        new Error(
          "Canonical conversation key does not match the supplied provider identity"
        ),
        { statusCode: 400, code: "canonical_identity_mismatch" }
      );
    }
    const content = item.rawText?.replace(/\s+/g, " ").trim();
    return {
      ...item,
      metadata: {
        ...(item.metadata ?? {}),
        canonicalConversationItemKey: item.canonicalItemKey,
        ...(actor ? { canonicalConversationItemActor: actor } : {}),
        ...(kind ? { canonicalConversationItemKind: kind } : {}),
        canonicalStableItemId: stableItemId,
        ...(content
          ? {
              canonicalConversationItemContentHash:
                normalizedContentHash(content)
            }
          : {}),
        ...(item.observationComponent === "control" &&
        ((item.sourceAdapterVersion === "codex-app-server-conversation-v1" &&
          item.sourceEventType === "turn/completed") ||
          (item.sourceAdapterVersion === "codex-transcript-v1" &&
            ["task_complete", "turn_aborted"].includes(
              item.sourceEventType ?? ""
            )) ||
          (item.sourceAdapterVersion === "codex-hook-signal-v1" &&
            item.sourceEventType === "turn_completed"))
          ? { semanticControl: "turn_completed" }
          : {})
      }
    };
  }
  return item;
};

const withValidatedTransportChunkIdentity = (
  item: ConversationItemInput
): ConversationItemInput => {
  const chunkFields = [
    item.transportChunkIndex,
    item.transportChunkCount,
    item.transportChunkText,
    item.transportChunkEncoding
  ];
  const supplied = chunkFields.filter((value) => value !== undefined).length;
  if (supplied === 0) {
    return item;
  }
  if (
    supplied !== chunkFields.length ||
    !item.logicalSourceId ||
    item.transportChunkIndex === undefined ||
    item.transportChunkCount === undefined ||
    item.transportChunkText === undefined ||
    !item.transportChunkEncoding
  ) {
    throw Object.assign(new Error("Transport chunk identity is incomplete"), {
      statusCode: 400,
      code: "transport_chunk_identity_incomplete"
    });
  }
  if (
    item.transportChunkCount > RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT ||
    item.transportChunkIndex < 0 ||
    item.transportChunkIndex >= item.transportChunkCount ||
    Buffer.byteLength(item.transportChunkText, "utf8") >
      RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES
  ) {
    throw Object.assign(new Error("Transport chunk exceeds server limits"), {
      statusCode: 413,
      code: "transport_chunk_limit_exceeded"
    });
  }
  const rawJson = isRecord(item.rawJson) ? item.rawJson : {};
  const sourceItemHash = stringField(rawJson, "sourceItemHash");
  if (!sourceItemHash) {
    throw Object.assign(
      new Error("Transport chunk source item identity is missing"),
      { statusCode: 400, code: "transport_chunk_source_identity_missing" }
    );
  }
  const expectedGroupId = rawConversationTransportChunkGroupId({
    sourceKind: item.sourceKind,
    sourceAdapterVersion: item.sourceAdapterVersion,
    sourceTransport: item.sourceTransport,
    logicalSourceId: item.logicalSourceId,
    sourceItemHash,
    transportChunkCount: item.transportChunkCount,
    transportChunkEncoding: item.transportChunkEncoding
  });
  const claimedGroupIds = [
    stringField(rawJson, "transportChunkGroupId"),
    stringField(item.metadata ?? {}, "transportChunkGroupId")
  ].filter((value): value is string => Boolean(value));
  if (claimedGroupIds.some((value) => value !== expectedGroupId)) {
    throw Object.assign(
      new Error("Transport chunk group identity does not match its source"),
      { statusCode: 400, code: "transport_chunk_group_mismatch" }
    );
  }
  return {
    ...item,
    rawJson: { ...rawJson, transportChunkGroupId: expectedGroupId },
    metadata: {
      ...(item.metadata ?? {}),
      transportChunkGroupId: expectedGroupId,
      sourceItemHash,
      sourceChunkIndex: item.transportChunkIndex,
      sourceChunkCount: item.transportChunkCount
    }
  };
};

const assertManagedCanonicalAdmission = (item: ConversationItemInput): void => {
  if (
    item.sourceAdapterVersion !== "codex-app-server-conversation-v1" ||
    item.observationOnly ||
    !(
      /^item\/(started|completed)$/.test(item.sourceEventType ?? "") ||
      item.sourceEventType === "turn/completed"
    )
  ) {
    return;
  }
  if (
    !item.canonicalItemKey ||
    !item.canonicalStableItemId ||
    !item.observationComponent ||
    !item.externalThreadId ||
    !item.externalTurnId
  ) {
    throw Object.assign(
      new Error("Managed semantic lifecycle records require exact identity"),
      { statusCode: 400, code: "managed_canonical_identity_required" }
    );
  }
};

const assertManagedTranscriptTerminal = (
  item: ConversationItemInput,
  session: ConversationItemSessionRow | null
): void => {
  if (
    session?.capture_method !== "api" ||
    session.metadata?.managedConversation !== true ||
    item.sourceAdapterVersion !== "codex-transcript-v1" ||
    !["task_complete", "turn_aborted"].includes(item.sourceEventType ?? "")
  ) {
    return;
  }
  const raw = isRecord(item.rawJson) ? item.rawJson : {};
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const expectedStableId = item.externalTurnId
    ? `turn:${item.externalTurnId}:completed`
    : null;
  const expectedCanonicalItemKey =
    item.externalThreadId && item.externalTurnId && expectedStableId
      ? codexCanonicalConversationItemKey({
          externalThreadId: item.externalThreadId,
          externalTurnId: item.externalTurnId,
          stableItemId: expectedStableId,
          component: "control"
        })
      : null;
  if (
    item.sourceTransport !== "transcript" ||
    raw.type !== "event_msg" ||
    payload.type !== item.sourceEventType ||
    item.sourceLineNumber === undefined ||
    !item.externalThreadId ||
    !item.externalTurnId ||
    item.canonicalStableItemId !== expectedStableId ||
    item.observationComponent !== "control" ||
    item.canonicalItemKey !== expectedCanonicalItemKey
  ) {
    throw Object.assign(
      new Error(
        "Managed terminal reconciliation requires exact persisted transcript evidence"
      ),
      { statusCode: 400, code: "managed_terminal_evidence_invalid" }
    );
  }
};

const assertCaptureHookTurnBoundary = (item: ConversationItemInput): void => {
  if (item.sourceAdapterVersion !== "codex-hook-signal-v1") return;
  const raw = isRecord(item.rawJson) ? item.rawJson : {};
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const expectedStableId = item.externalTurnId
    ? `turn:${item.externalTurnId}:completed`
    : null;
  const expectedCanonicalItemKey =
    item.externalThreadId && item.externalTurnId && expectedStableId
      ? codexCanonicalConversationItemKey({
          externalThreadId: item.externalThreadId,
          externalTurnId: item.externalTurnId,
          stableItemId: expectedStableId,
          component: "control"
        })
      : null;
  if (
    item.sourceTransport !== "hook_signal" ||
    item.sourceRecordType !== "hook_signal" ||
    item.sourceEventType !== "turn_completed" ||
    raw.type !== "hook_signal" ||
    payload.type !== "turn_completed" ||
    !Number.isSafeInteger(payload.sourceFrontierOffset) ||
    Number(payload.sourceFrontierOffset) < 0 ||
    !Number.isSafeInteger(payload.sourceFrontierLine) ||
    Number(payload.sourceFrontierLine) < 0 ||
    item.rawText !== undefined ||
    !item.eventTime ||
    !item.externalSessionId ||
    item.externalSessionId !== item.externalThreadId ||
    !item.externalTurnId ||
    item.externalItemId !== expectedStableId ||
    item.canonicalStableItemId !== expectedStableId ||
    item.observationKind !== "control" ||
    item.observationComponent !== "control" ||
    item.canonicalItemKey !== expectedCanonicalItemKey
  ) {
    throw Object.assign(
      new Error(
        "Capture Hook turn boundary requires exact content-free turn identity"
      ),
      { statusCode: 400, code: "hook_turn_boundary_invalid" }
    );
  }
};

const canonicalItemKeyFor = (item: ConversationItemInput): string =>
  item.canonicalItemKey ??
  stringField(item.metadata ?? {}, "canonicalConversationItemKey") ??
  item.idempotencyKey;

const canonicalSourcePriorityFor = (item: ConversationItemInput): number => {
  if (item.sourceAdapterVersion === "codex-transcript-v1") {
    return 200;
  }
  if (item.sourceAdapterVersion === "codex-hook-signal-v1") {
    return 200;
  }
  if (
    item.sourceAdapterVersion === "codex-app-server-conversation-v1" &&
    item.sourceTransport === "app_server"
  ) {
    return item.sourceEventType === "item/completed" ||
      item.sourceEventType === "turn/completed"
      ? 300
      : 100;
  }
  return 100;
};

const observationKindFor = (
  item: ConversationItemInput
): NonNullable<ConversationItemInput["observationKind"]> => {
  if (item.sourceAdapterVersion === "codex-transcript-v1") {
    return item.sourceTransport === "transcript"
      ? "reconciliation"
      : "snapshot";
  }
  if (item.sourceAdapterVersion === "codex-hook-signal-v1") {
    return "control";
  }
  if (item.sourceAdapterVersion === "codex-app-server-conversation-v1") {
    if (item.sourceEventType === "item/started") {
      return "lifecycle_started";
    }
    if (item.sourceEventType === "item/completed") {
      return "lifecycle_completed";
    }
    return "control";
  }
  return "snapshot";
};

const observationKeyFor = (
  item: ConversationItemInput,
  sourceIdempotencyKey: string
): string =>
  `conversation-item-observation:${sha256({
    version: 1,
    sourceKind: item.sourceKind,
    sourceAdapterVersion: item.sourceAdapterVersion,
    sourceTransport: item.sourceTransport,
    sourceIdempotencyKey,
    observationKind: item.observationKind ?? "snapshot",
    observationComponent: item.observationComponent ?? null
  })}`;

const observationIngestionStatusFor = (
  item: ConversationItemInput
): "persisted" | "identity_unresolved" =>
  item.observationOnly ? "identity_unresolved" : "persisted";

const mapConversationItem = (
  row: ConversationItemRow
): ConversationItemRecord => ({
  id: row.id,
  canonicalItemKey: row.canonical_item_key,
  sessionId: row.session_id,
  turnId: row.turn_id,
  sourceKind: row.source_kind,
  sourceAdapterVersion: row.source_adapter_version,
  sourceTransport: row.source_transport,
  externalSessionId: row.external_session_id,
  externalThreadId: row.external_thread_id,
  externalTurnId: row.external_turn_id,
  externalItemId: row.external_item_id,
  canonicalStableItemId: row.canonical_stable_item_id,
  sourceRecordType: row.source_record_type,
  sourceEventType: row.source_event_type,
  sourceSequence: row.source_sequence,
  idempotencyKey: row.idempotency_key,
  observedAt: row.observed_at.toISOString(),
  importObservedAt: row.import_observed_at?.toISOString() ?? null,
  sourceFingerprint: row.source_fingerprint,
  capturedProject: row.captured_project,
  createdAt: row.created_at.toISOString()
});

const captureMethodForConversationItem = (
  item: Pick<ConversationItemInput, "sourceTransport">
): CaptureMethod => {
  if (item.sourceTransport === "mcp") {
    return "mcp";
  }
  if (item.sourceTransport === "web") {
    return "web";
  }
  return "api";
};

const enforceConversationItemCapturePolicy = async (input: {
  actor: ActorContext;
  item: ConversationItemInput;
  resolveCapturePolicy?: ConversationItemRepositoryOptions["resolveCapturePolicy"];
}): Promise<void> => {
  if (!input.resolveCapturePolicy) {
    return;
  }
  const policy = await input.resolveCapturePolicy(input.actor, {
    ...(input.item.sessionId ? { sessionId: input.item.sessionId } : {})
  });
  if (policy.visibility !== "personal") {
    throw Object.assign(
      new Error(
        `Unsupported Capture Target '${policy.visibility}' for raw conversation ingestion`
      ),
      { statusCode: 400, code: "unsupported_capture_visibility" }
    );
  }
  if (policy.captureState !== "enabled") {
    throw Object.assign(
      new Error("Capture Policy disabled raw conversation ingestion"),
      {
        statusCode: 409,
        code: "capture_disabled",
        policy: {
          captureState: policy.captureState,
          paused: policy.paused,
          pauseUntil: policy.pauseUntil,
          source: policy.source
        }
      }
    );
  }
};

const sessionlessWorkflowTelemetry = (item: ConversationItemInput): boolean =>
  item.sourceAdapterVersion === "codex-app-server-v1" &&
  item.sourceTransport === "app_server" &&
  ["memory_question", "lcm_summary"].includes(
    stringField(item.metadata ?? {}, "workflow") ?? ""
  );

const loadAndValidateConversationItemSession = async (input: {
  client: pg.PoolClient;
  actor: ActorContext;
  item: ConversationItemInput;
  visibility: Visibility;
}): Promise<ConversationItemSessionRow | null> => {
  if (!input.item.sessionId) {
    if (
      !input.item.observationOnly &&
      sessionlessWorkflowTelemetry(input.item)
    ) {
      return null;
    }
    throw Object.assign(
      new Error("Conversation ingestion requires a Captured Session"),
      { statusCode: 400, code: "conversation_session_required" }
    );
  }

  const result = await input.client.query<ConversationItemSessionRow>(
    `
      select
        id, external_session_id, external_thread_id,
        capture_method, automatic_project_id,
        project_override_id, cwd, metadata
      from sessions
      where id = $2
        and owner_user_id = $1
        and visibility = $3::visibility_scope
        and invalidated_at is null
        and personal_deleted_at is null
      limit 1
      for update
    `,
    [input.actor.userId, input.item.sessionId, input.visibility]
  );
  const session = result.rows[0];
  if (!session) {
    throw Object.assign(new Error("Session not found or not visible"), {
      statusCode: 404,
      code: "conversation_session_not_found"
    });
  }
  if (session.metadata?.syncReplica === true) {
    throw Object.assign(new Error("Synchronized replica is read-only"), {
      statusCode: 409,
      code: "synchronized_replica_read_only"
    });
  }

  const expectedThreadIds = new Set(
    [session.external_thread_id, session.external_session_id].filter(
      (value): value is string => Boolean(value)
    )
  );
  const suppliedThreadIds = [
    input.item.externalThreadId,
    input.item.externalSessionId
  ];
  for (const supplied of suppliedThreadIds) {
    if (
      supplied &&
      expectedThreadIds.size > 0 &&
      !expectedThreadIds.has(supplied)
    ) {
      throw Object.assign(
        new Error(
          "Conversation source thread does not match its Captured Session"
        ),
        { statusCode: 409, code: "conversation_session_thread_mismatch" }
      );
    }
  }
  if (
    input.item.externalThreadId &&
    input.item.externalSessionId &&
    input.item.externalThreadId !== input.item.externalSessionId
  ) {
    throw Object.assign(new Error("Conversation source identities disagree"), {
      statusCode: 409,
      code: "conversation_source_identity_mismatch"
    });
  }
  if (
    session.metadata?.managedConversation === true &&
    expectedThreadIds.size > 0 &&
    !input.item.externalThreadId &&
    !input.item.externalSessionId
  ) {
    throw Object.assign(
      new Error(
        "Managed conversation records require provider thread identity"
      ),
      { statusCode: 400, code: "managed_thread_identity_required" }
    );
  }
  return session;
};

const withAuthoritativeSessionMetadata = (
  item: ConversationItemInput,
  session: ConversationItemSessionRow | null
): ConversationItemInput => {
  const metadata = { ...(item.metadata ?? {}) };
  delete metadata.projectId;
  const projectId =
    session?.project_override_id ??
    session?.automatic_project_id ??
    session?.cwd;
  if (projectId) {
    metadata.projectId = projectId;
  }
  return { ...item, metadata };
};

const ensureConversationItemTurn = async (
  pool: pg.Pool | pg.PoolClient,
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

  await pool.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `conversation-turn:${input.ownerUserId}:${item.sessionId}`
  ]);

  const result = await pool.query<{ id: string }>(
    `
          insert into turns (
            session_id,
            owner_user_id,
            visibility,
            external_turn_id,
            source_runtime,
            capture_method,
            idempotency_key,
            source_hash,
            turn_index,
            source_kind,
            source_adapter_version,
            external_thread_id,
            source_metadata
          )
          values (
            $1, $2, $3, $4, $5, $6,
            $7, $8,
            coalesce(
              (select max(turn_index) + 1 from turns where session_id = $1),
              0
            ),
            $9, $10, $11, $12
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
      conversationSourceRuntime(item.sourceKind, item.metadata),
      captureMethodForConversationItem(item),
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

  return result?.rows[0]?.id ?? null;
};

const persistConversationItemObservation = async (input: {
  client: pg.PoolClient;
  actor: ActorContext;
  item: ConversationItemInput;
  conversationItemId: string | null;
  canonicalItemKey: string | null;
  sourceIdempotencyKey: string;
  suppressPlaintextRaw: boolean;
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  payloadHash: string;
}): Promise<void> => {
  const observationKey = observationKeyFor(
    input.item,
    input.sourceIdempotencyKey
  );
  const rawJsonForStorage = input.suppressPlaintextRaw
    ? ENCRYPTED_CONVERSATION_ITEM_OBSERVATION_JSON
    : input.item.rawJson;
  const rawTextForStorage =
    input.suppressPlaintextRaw && hasEncryptableText(input.item.rawText)
      ? ENCRYPTED_CONVERSATION_ITEM_OBSERVATION_TEXT
      : (input.item.rawText ?? null);
  const transportChunkTextForStorage =
    input.suppressPlaintextRaw &&
    hasEncryptableText(input.item.transportChunkText)
      ? ENCRYPTED_CONVERSATION_ITEM_OBSERVATION_TEXT
      : (input.item.transportChunkText ?? null);
  const metadata = input.suppressPlaintextRaw
    ? safeConversationMetadataForEncryptedStorage(
        input.item.metadata ?? {},
        "encryptedConversationItemObservationColumns",
        [
          "raw_json",
          ...(hasEncryptableText(input.item.rawText) ? ["raw_text"] : []),
          ...(hasEncryptableText(input.item.transportChunkText)
            ? ["transport_chunk_text"]
            : []),
          "metadata"
        ]
      )
    : (input.item.metadata ?? {});
  const result = await input.client.query<ConversationItemObservationRow>(
    `
      insert into conversation_item_observations (
        conversation_item_id,
        session_id,
        owner_user_id,
        visibility,
        canonical_item_key,
        canonical_stable_item_id,
        observation_key,
        observation_kind,
        ingestion_status,
        observation_component,
        source_kind,
        source_adapter_version,
        source_transport,
        external_session_id,
        external_thread_id,
        external_turn_id,
        external_item_id,
        source_record_type,
        source_event_type,
        source_line_number,
        source_sequence,
        event_time,
        observed_at,
        raw_json,
        raw_text,
        transport_chunk_index,
        transport_chunk_count,
        transport_chunk_text,
        transport_chunk_encoding,
        source_hash,
        payload_hash,
        source_idempotency_key,
        metadata
      )
      values (
        $1, $2, $3, 'personal', $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
        $30, $31, $32
      )
      on conflict (owner_user_id, observation_key)
        where visibility = 'personal'
      do nothing
      returning id, true as inserted
    `,
    [
      input.conversationItemId,
      input.item.sessionId ?? null,
      input.actor.userId,
      input.canonicalItemKey,
      input.item.canonicalStableItemId ?? null,
      observationKey,
      input.item.observationKind ?? "snapshot",
      observationIngestionStatusFor(input.item),
      input.item.observationComponent ?? null,
      input.item.sourceKind,
      input.item.sourceAdapterVersion,
      input.item.sourceTransport,
      input.item.externalSessionId ?? null,
      input.item.externalThreadId ?? input.item.externalSessionId ?? null,
      input.item.externalTurnId ?? null,
      input.item.externalItemId ?? null,
      input.item.sourceRecordType,
      input.item.sourceEventType ?? null,
      input.item.sourceLineNumber ?? null,
      input.item.sourceSequence ?? null,
      input.item.eventTime ?? null,
      input.item.observedAt ?? new Date().toISOString(),
      JSON.stringify(rawJsonForStorage),
      rawTextForStorage,
      input.item.transportChunkIndex ?? null,
      input.item.transportChunkCount ?? null,
      transportChunkTextForStorage,
      input.item.transportChunkEncoding ?? null,
      input.item.sourceHash,
      input.payloadHash,
      input.sourceIdempotencyKey,
      metadata
    ]
  );
  let observation = result.rows[0];
  if (!observation) {
    const existing =
      await input.client.query<ExistingConversationItemObservationRow>(
        `
        select
          id,
          conversation_item_id,
          canonical_item_key,
          observation_key,
          payload_hash,
          source_hash,
          metadata
        from conversation_item_observations
        where owner_user_id = $1
          and observation_key = $2
          and visibility = 'personal'
        limit 1
      `,
        [input.actor.userId, observationKey]
      );
    const replay = existing.rows[0];
    if (
      replay &&
      replay.conversation_item_id === input.conversationItemId &&
      replay.canonical_item_key === input.canonicalItemKey &&
      replay.payload_hash === input.payloadHash
    ) {
      observation = { id: replay.id, inserted: false };
    }
  }
  if (!observation) {
    throw Object.assign(
      new Error(
        "Source observation identity conflicts with a different canonical conversation item"
      ),
      { statusCode: 409 }
    );
  }
  if (
    input.suppressPlaintextRaw &&
    input.envelopeEncryptionProvider &&
    observation.inserted
  ) {
    const encryptionInput = {
      rowFamily: "conversation_item_observation",
      scope: {
        tenantId: input.actor.userId,
        projectId: input.item.sessionId ?? null,
        objectClass: "conversation_item_observation"
      },
      aad: {
        conversationItemId: input.conversationItemId,
        sourceTransport: input.item.sourceTransport,
        sourceRecordType: input.item.sourceRecordType,
        sourceEventType: input.item.sourceEventType ?? null
      }
    } as const;
    await upsertEncryptedFieldPayloadWithClient(
      input.client,
      input.actor,
      input.envelopeEncryptionProvider,
      {
        sourceTable: "conversation_item_observations",
        sourceId: observation.id,
        sourceColumn: "raw_json",
        plaintext: input.item.rawJson,
        ...encryptionInput
      }
    );
    if (hasEncryptableText(input.item.rawText)) {
      await upsertEncryptedFieldPayloadWithClient(
        input.client,
        input.actor,
        input.envelopeEncryptionProvider,
        {
          sourceTable: "conversation_item_observations",
          sourceId: observation.id,
          sourceColumn: "raw_text",
          plaintext: input.item.rawText,
          ...encryptionInput
        }
      );
    }
    if (hasEncryptableText(input.item.transportChunkText)) {
      await upsertEncryptedFieldPayloadWithClient(
        input.client,
        input.actor,
        input.envelopeEncryptionProvider,
        {
          sourceTable: "conversation_item_observations",
          sourceId: observation.id,
          sourceColumn: "transport_chunk_text",
          plaintext: input.item.transportChunkText,
          ...encryptionInput
        }
      );
    }
    await upsertEncryptedFieldPayloadWithClient(
      input.client,
      input.actor,
      input.envelopeEncryptionProvider,
      {
        sourceTable: "conversation_item_observations",
        sourceId: observation.id,
        sourceColumn: "metadata",
        plaintext: input.item.metadata ?? {},
        ...encryptionInput
      }
    );
  }
};

export const createConversationItemRepository = (
  pool: pg.Pool,
  options: ConversationItemRepositoryOptions = {}
): ConversationItemRepository => ({
  async findConversationItemByStableIdentity(actor, input) {
    const result = await pool.query<ConversationItemRow>(
      `
        select
          id, owner_user_id, session_id, turn_id, source_kind,
          source_adapter_version, source_transport, external_session_id,
          external_thread_id, external_turn_id, external_item_id,
          canonical_stable_item_id, source_record_type, source_event_type,
          source_sequence, source_hash, idempotency_key, canonical_item_key,
          canonical_source_priority, observed_at, import_observed_at,
          source_fingerprint, captured_project, created_at
        from conversation_items
        where owner_user_id = $1
          and visibility = 'personal'
          and session_id = $2
          and canonical_stable_item_id = $3
          and personal_deleted_at is null
        limit 1
      `,
      [actor.userId, input.sessionId, input.canonicalStableItemId]
    );
    return result.rows[0] ? mapConversationItem(result.rows[0]) : null;
  },

  async createConversationItems(actor, input) {
    const records: ConversationItemRecord[] = [];
    for (const inputItem of input.items) {
      const sanitizedItem = withValidatedTransportChunkIdentity(
        sanitizeConversationItemForStorage(inputItem)
      );
      assertManagedCanonicalAdmission(sanitizedItem);
      assertCaptureHookTurnBoundary(sanitizedItem);
      const sourceIdempotencyKey = sanitizedItem.idempotencyKey;
      let item = withCanonicalConversationIdentity({
        ...sanitizedItem,
        observationKind:
          sanitizedItem.observationKind ?? observationKindFor(sanitizedItem)
      });
      const canonicalItemKey = canonicalItemKeyFor(item);
      const payloadHash = observationPayloadHashFor(item);
      const observationKey = observationKeyFor(item, sourceIdempotencyKey);
      const canonicalSourcePriority = canonicalSourcePriorityFor(item);
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
        suppressPlaintextRaw && hasEncryptableText(item.rawText)
          ? ENCRYPTED_CONVERSATION_ITEM_TEXT
          : (item.rawText ?? null);
      const transportChunkTextForStorage =
        suppressPlaintextRaw && hasEncryptableText(item.transportChunkText)
          ? ENCRYPTED_CONVERSATION_ITEM_TEXT
          : (item.transportChunkText ?? null);
      const ownsTransaction = !options.transactionClient;
      const client = options.transactionClient ?? (await pool.connect());
      const commit = () =>
        ownsTransaction ? client.query("commit") : Promise.resolve();
      try {
        if (ownsTransaction) {
          await client.query("begin");
        }
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`capture-policy:${ownerUserId}`]
        );
        const verifiedSession = await loadAndValidateConversationItemSession({
          client,
          actor,
          item,
          visibility
        });
        assertManagedTranscriptTerminal(item, verifiedSession);
        item = withAuthoritativeSessionMetadata(item, verifiedSession);
        const metadataForStorage = suppressPlaintextRaw
          ? safeConversationMetadataForEncryptedStorage(
              item.metadata ?? {},
              "encryptedConversationItemColumns",
              [
                "raw_json",
                ...(hasEncryptableText(item.rawText) ? ["raw_text"] : []),
                ...(hasEncryptableText(item.transportChunkText)
                  ? ["transport_chunk_text"]
                  : []),
                "metadata"
              ]
            )
          : (item.metadata ?? {});
        await enforceConversationItemCapturePolicy({
          actor,
          item,
          resolveCapturePolicy: options.resolveCapturePolicy
        });
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            `conversation-item:${ownerUserId ?? "anonymous"}:${visibility}:${canonicalItemKey}`
          ]
        );

        const replayRows =
          await client.query<ExistingConversationItemObservationRow>(
            `
            select
              id,
              conversation_item_id,
              canonical_item_key,
              observation_key,
              payload_hash,
              source_hash,
              metadata
            from conversation_item_observations
            where owner_user_id = $1
              and visibility = 'personal'
              and observation_key = $2
            limit 1
          `,
            [ownerUserId, observationKey]
          );
        const replay = replayRows.rows[0];
        if (replay) {
          const replayPayloadMatches = replay.payload_hash === payloadHash;
          if (item.observationOnly) {
            if (
              replay.conversation_item_id !== null ||
              replay.canonical_item_key !== null ||
              !replayPayloadMatches
            ) {
              throw Object.assign(
                new Error(
                  "Source observation identity conflicts with different observation bytes"
                ),
                { statusCode: 409, code: "observation_integrity_conflict" }
              );
            }
            await commit();
            continue;
          }
          if (
            replay.canonical_item_key !== canonicalItemKey ||
            !replayPayloadMatches
          ) {
            throw Object.assign(
              new Error(
                "Source observation identity conflicts with different observation bytes"
              ),
              { statusCode: 409, code: "observation_integrity_conflict" }
            );
          }
          const replayedItem = await client.query<ConversationItemRow>(
            `
              select
                id, owner_user_id, session_id, turn_id, source_kind,
                source_adapter_version, source_transport, external_session_id,
                external_thread_id, external_turn_id, external_item_id,
                canonical_stable_item_id, source_record_type,
                source_event_type, source_sequence, idempotency_key,
                canonical_item_key, canonical_source_priority, observed_at,
                import_observed_at, source_fingerprint, captured_project,
                created_at
              from conversation_items
              where id = $1
                and owner_user_id = $2
                and visibility = 'personal'
              limit 1
            `,
            [replay.conversation_item_id, ownerUserId]
          );
          const replayedRow = replayedItem.rows[0];
          if (!replayedRow) {
            throw Object.assign(
              new Error(
                "Source observation points to a missing canonical conversation item"
              ),
              { statusCode: 409, code: "observation_parent_missing" }
            );
          }
          await commit();
          records.push(mapConversationItem(replayedRow));
          continue;
        }

        let managedProjectionHold =
          verifiedSession?.capture_method === "api" &&
          verifiedSession.metadata?.managedConversation === true &&
          Boolean(item.externalTurnId);
        if (managedProjectionHold) {
          const terminal = await client.query<{ reconciled: boolean }>(
            `
              select exists (
                select 1
                from conversation_item_observations
                where owner_user_id = $1
                  and visibility = 'personal'
                  and session_id = $2
                  and external_turn_id = $3
                  and source_adapter_version = 'codex-transcript-v1'
                  and source_transport = 'transcript'
                  and observation_kind = 'reconciliation'
                  and ingestion_status = 'persisted'
                  and source_event_type in ('task_complete', 'turn_aborted')
                  and source_line_number is not null
                  and observation_component = 'control'
                  and canonical_stable_item_id = 'turn:' || $3 || ':completed'
              ) as reconciled
            `,
            [ownerUserId, item.sessionId, item.externalTurnId]
          );
          managedProjectionHold = terminal.rows[0]?.reconciled !== true;
        }

        if (item.observationOnly) {
          await persistConversationItemObservation({
            client,
            actor: { userId: ownerUserId },
            item,
            conversationItemId: null,
            canonicalItemKey: null,
            sourceIdempotencyKey,
            suppressPlaintextRaw,
            envelopeEncryptionProvider: options.envelopeEncryptionProvider,
            payloadHash
          });
          await commit();
          continue;
        }

        const turnId = await ensureConversationItemTurn(client, {
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
          canonical_stable_item_id,
          parent_external_item_id,
          source_record_type,
          source_event_type,
          source_line_number,
          source_sequence,
          event_time,
          observed_at,
          import_observed_at,
          source_fingerprint,
          captured_project,
          raw_json,
          raw_text,
          logical_source_id,
          transport_chunk_index,
          transport_chunk_count,
          transport_chunk_text,
          transport_chunk_encoding,
          source_hash,
          idempotency_key,
          canonical_item_key,
          canonical_source_priority,
          projection_status,
          projection_work_class,
          projection_version,
          projection_error,
          metadata
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
          $29, $30, $31, $32, $33, $34, $35, $36, $37, $38
        )
        on conflict (owner_user_id, canonical_item_key)
          where visibility = 'personal'
        do update set
          session_id = coalesce(conversation_items.session_id, excluded.session_id),
          turn_id = coalesce(conversation_items.turn_id, excluded.turn_id),
          source_kind = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
            then excluded.source_kind
            else conversation_items.source_kind
          end,
          source_adapter_version = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
            then excluded.source_adapter_version
            else conversation_items.source_adapter_version
          end,
          source_transport = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
            then excluded.source_transport
            else conversation_items.source_transport
          end,
          external_session_id = coalesce(
            conversation_items.external_session_id,
            excluded.external_session_id
          ),
          external_thread_id = coalesce(
            conversation_items.external_thread_id,
            excluded.external_thread_id
          ),
          external_turn_id = coalesce(
            conversation_items.external_turn_id,
            excluded.external_turn_id
          ),
          external_item_id = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
            then coalesce(excluded.external_item_id, conversation_items.external_item_id)
            else conversation_items.external_item_id
          end,
          canonical_stable_item_id = coalesce(
            conversation_items.canonical_stable_item_id,
            excluded.canonical_stable_item_id
          ),
          parent_external_item_id = coalesce(
            conversation_items.parent_external_item_id,
            excluded.parent_external_item_id
          ),
          source_record_type = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
            then excluded.source_record_type
            else conversation_items.source_record_type
          end,
          source_event_type = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
            then excluded.source_event_type
            else conversation_items.source_event_type
          end,
          source_line_number = coalesce(
            conversation_items.source_line_number,
            excluded.source_line_number
          ),
          source_sequence = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
              or (
                excluded.canonical_source_priority = conversation_items.canonical_source_priority
                and excluded.transport_chunk_count > 1
                and excluded.transport_chunk_index < conversation_items.transport_chunk_index
              )
            then coalesce(excluded.source_sequence, conversation_items.source_sequence)
            else conversation_items.source_sequence
          end,
          event_time = case
            when excluded.event_time is null
            then conversation_items.event_time
            when conversation_items.event_time is null
              or excluded.canonical_source_priority > conversation_items.canonical_source_priority
            then excluded.event_time
            else conversation_items.event_time
          end,
          observed_at = least(
            conversation_items.observed_at,
            excluded.observed_at
          ),
          import_observed_at = coalesce(
            conversation_items.import_observed_at,
            excluded.import_observed_at
          ),
          source_fingerprint = coalesce(
            conversation_items.source_fingerprint,
            excluded.source_fingerprint
          ),
          captured_project = case
            when conversation_items.captured_project = '{}'::jsonb
            then excluded.captured_project
            else conversation_items.captured_project
          end,
          raw_json = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
              or (
                excluded.canonical_source_priority = conversation_items.canonical_source_priority
                and excluded.transport_chunk_count > 1
                and excluded.transport_chunk_index < conversation_items.transport_chunk_index
              )
            then excluded.raw_json
            else conversation_items.raw_json
          end,
          raw_text = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
              or (
                excluded.canonical_source_priority = conversation_items.canonical_source_priority
                and excluded.transport_chunk_count > 1
                and excluded.transport_chunk_index < conversation_items.transport_chunk_index
              )
            then coalesce(excluded.raw_text, conversation_items.raw_text)
            else conversation_items.raw_text
          end,
          logical_source_id = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
              or (
                excluded.canonical_source_priority = conversation_items.canonical_source_priority
                and excluded.transport_chunk_count > 1
                and excluded.transport_chunk_index < conversation_items.transport_chunk_index
              )
            then excluded.logical_source_id
            else conversation_items.logical_source_id
          end,
          transport_chunk_index = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
              or (
                excluded.canonical_source_priority = conversation_items.canonical_source_priority
                and excluded.transport_chunk_count > 1
                and excluded.transport_chunk_index < conversation_items.transport_chunk_index
              )
            then excluded.transport_chunk_index
            else conversation_items.transport_chunk_index
          end,
          transport_chunk_count = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
              or (
                excluded.canonical_source_priority = conversation_items.canonical_source_priority
                and excluded.transport_chunk_count > 1
                and excluded.transport_chunk_index < conversation_items.transport_chunk_index
              )
            then excluded.transport_chunk_count
            else conversation_items.transport_chunk_count
          end,
          transport_chunk_text = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
              or (
                excluded.canonical_source_priority = conversation_items.canonical_source_priority
                and excluded.transport_chunk_count > 1
                and excluded.transport_chunk_index < conversation_items.transport_chunk_index
              )
            then excluded.transport_chunk_text
            else conversation_items.transport_chunk_text
          end,
          transport_chunk_encoding = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
              or (
                excluded.canonical_source_priority = conversation_items.canonical_source_priority
                and excluded.transport_chunk_count > 1
                and excluded.transport_chunk_index < conversation_items.transport_chunk_index
              )
            then excluded.transport_chunk_encoding
            else conversation_items.transport_chunk_encoding
          end,
          source_hash = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
              or (
                excluded.canonical_source_priority = conversation_items.canonical_source_priority
                and excluded.transport_chunk_count > 1
                and excluded.transport_chunk_index < conversation_items.transport_chunk_index
              )
            then excluded.source_hash
            else conversation_items.source_hash
          end,
          canonical_source_priority = greatest(
            conversation_items.canonical_source_priority,
            excluded.canonical_source_priority
          ),
          projection_status = case
            when excluded.projection_status = 'pending'
              and (
                excluded.canonical_source_priority > conversation_items.canonical_source_priority
                or conversation_items.projection_status = 'raw_only'
                or (
                  excluded.event_time is not null
                  and (
                    conversation_items.event_time is null
                    or excluded.canonical_source_priority > conversation_items.canonical_source_priority
                  )
                  and excluded.event_time is distinct from conversation_items.event_time
                )
              )
            then excluded.projection_status
            else conversation_items.projection_status
          end,
          projection_work_class = case
            when conversation_items.projection_work_class = 'live_capture_projection'
              or excluded.projection_work_class = 'live_capture_projection'
            then 'live_capture_projection'
            else 'historical_import_backfill'
          end,
          projection_version = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
            then excluded.projection_version
            else conversation_items.projection_version
          end,
          projection_policy_revision = case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
            then null
            else conversation_items.projection_policy_revision
          end,
          projection_error = null,
          projected_at = case
            when conversation_items.projection_status = 'projected'
              and (
                excluded.canonical_source_priority > conversation_items.canonical_source_priority
                or (
                  excluded.event_time is not null
                  and (
                    conversation_items.event_time is null
                    or excluded.canonical_source_priority > conversation_items.canonical_source_priority
                  )
                  and excluded.event_time is distinct from conversation_items.event_time
                )
              )
            then null
            else conversation_items.projected_at
          end,
          metadata = (case
            when excluded.canonical_source_priority > conversation_items.canonical_source_priority
              or (
                excluded.canonical_source_priority = conversation_items.canonical_source_priority
                and excluded.transport_chunk_count > 1
                and excluded.transport_chunk_index < conversation_items.transport_chunk_index
              )
            then conversation_items.metadata || excluded.metadata
            else excluded.metadata || conversation_items.metadata
          end) || case
            when conversation_items.metadata ? 'toolCall'
              or excluded.metadata ? 'toolCall'
            then jsonb_build_object(
              'toolCall',
              case
                when excluded.canonical_source_priority > conversation_items.canonical_source_priority
                then coalesce(conversation_items.metadata -> 'toolCall', '{}'::jsonb)
                  || coalesce(excluded.metadata -> 'toolCall', '{}'::jsonb)
                else coalesce(excluded.metadata -> 'toolCall', '{}'::jsonb)
                  || coalesce(conversation_items.metadata -> 'toolCall', '{}'::jsonb)
              end
            )
            else '{}'::jsonb
          end
        returning
          id, owner_user_id, session_id, turn_id, source_kind,
          source_adapter_version, source_transport, external_session_id,
          external_thread_id, external_turn_id, external_item_id,
          canonical_stable_item_id,
          source_record_type, source_event_type, source_sequence,
          idempotency_key, canonical_item_key, canonical_source_priority,
          observed_at, import_observed_at, source_fingerprint,
          captured_project, created_at
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
          item.canonicalStableItemId ?? null,
          item.parentExternalItemId ?? null,
          item.sourceRecordType,
          item.sourceEventType ?? null,
          item.sourceLineNumber ?? null,
          item.sourceSequence ?? null,
          item.eventTime ?? null,
          item.observedAt ?? new Date().toISOString(),
          item.importObservedAt ?? null,
          item.sourceFingerprint ?? null,
          item.capturedProject ?? {},
          JSON.stringify(rawJsonForStorage),
          rawTextForStorage,
          item.logicalSourceId ?? null,
          item.transportChunkIndex ?? 0,
          item.transportChunkCount ?? 1,
          transportChunkTextForStorage,
          item.transportChunkEncoding ?? null,
          item.sourceHash,
          canonicalItemKey,
          canonicalItemKey,
          canonicalSourcePriority,
          managedProjectionHold
            ? "held"
            : item.sourceTransport === "historical_import" &&
                item.projectionStatus === "raw_only"
              ? "raw_only"
              : "pending",
          projectionWorkClassForSourceTransport(item.sourceTransport),
          item.projectionVersion ?? null,
          item.projectionError ?? null,
          metadataForStorage
        ];
        const existing = await client.query<{
          id: string;
          canonical_source_priority: number;
          source_hash: string;
          metadata: Record<string, unknown> | null;
          session_id: string | null;
          turn_id: string | null;
          external_thread_id: string | null;
          external_turn_id: string | null;
          transport_chunk_index: number;
        }>(
          `
            select
              id, canonical_source_priority, source_hash, metadata, session_id, turn_id,
              external_thread_id, external_turn_id, transport_chunk_index
            from conversation_items
            where owner_user_id = $1
              and canonical_item_key = $2
              and visibility = $3::visibility_scope
            for update
          `,
          [ownerUserId, canonicalItemKey, visibility]
        );
        const previous = existing.rows[0];
        if (
          previous &&
          (previous.session_id !== (item.sessionId ?? null) ||
            previous.external_thread_id !==
              (item.externalThreadId ?? item.externalSessionId ?? null) ||
            previous.external_turn_id !== (item.externalTurnId ?? null))
        ) {
          throw Object.assign(
            new Error(
              "Canonical conversation identity is already bound to a different session or provider turn"
            ),
            { statusCode: 409, code: "canonical_conversation_binding_conflict" }
          );
        }
        const shouldWriteCanonicalPayload =
          !previous ||
          canonicalSourcePriority > previous.canonical_source_priority ||
          (canonicalSourcePriority === previous.canonical_source_priority &&
            (item.transportChunkIndex ?? 0) < previous.transport_chunk_index);
        const metadataForEncryption =
          suppressPlaintextRaw && options.envelopeEncryptionProvider && previous
            ? mergeCanonicalConversationMetadata({
                existing: await loadCanonicalConversationMetadata({
                  client,
                  actor: { userId: ownerUserId },
                  provider: options.envelopeEncryptionProvider,
                  sourceId: previous.id,
                  storedMetadata: previous.metadata
                }),
                incoming: item.metadata ?? {},
                incomingWins: shouldWriteCanonicalPayload
              })
            : (item.metadata ?? {});
        const upsertedRow = (
          await client.query<ConversationItemRow>(upsertSql, upsertParams)
        ).rows[0];
        const row =
          upsertedRow ??
          (
            await client.query<ConversationItemRow>(
              `
              select
                id, owner_user_id, session_id, turn_id, source_kind,
                source_adapter_version, source_transport, external_session_id,
                external_thread_id, external_turn_id, external_item_id,
                canonical_stable_item_id,
                source_record_type, source_event_type, source_sequence,
                idempotency_key, canonical_item_key,
                canonical_source_priority, observed_at, import_observed_at,
                source_fingerprint, captured_project, created_at
              from conversation_items
              where canonical_item_key = $1
                and visibility = $2::visibility_scope
                and owner_user_id = $3
              limit 1
            `,
              [canonicalItemKey, visibility, ownerUserId]
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

        if (suppressPlaintextRaw && options.envelopeEncryptionProvider) {
          const encryptionInput = {
            rowFamily: "conversation_item",
            scope: {
              tenantId: ownerUserId,
              projectId: item.sessionId ?? null,
              objectClass: "conversation_item"
            },
            aad: {
              sourceRecordType: item.sourceRecordType,
              sourceEventType: item.sourceEventType ?? null
            }
          } as const;
          if (shouldWriteCanonicalPayload) {
            await upsertEncryptedFieldPayloadWithClient(
              client,
              { userId: ownerUserId },
              options.envelopeEncryptionProvider,
              {
                sourceTable: "conversation_items",
                sourceId: row.id,
                sourceColumn: "raw_json",
                plaintext: item.rawJson,
                ...encryptionInput
              }
            );
            if (hasEncryptableText(item.rawText)) {
              await upsertEncryptedFieldPayloadWithClient(
                client,
                { userId: ownerUserId },
                options.envelopeEncryptionProvider,
                {
                  sourceTable: "conversation_items",
                  sourceId: row.id,
                  sourceColumn: "raw_text",
                  plaintext: item.rawText,
                  ...encryptionInput
                }
              );
            }
            if (hasEncryptableText(item.transportChunkText)) {
              await upsertEncryptedFieldPayloadWithClient(
                client,
                { userId: ownerUserId },
                options.envelopeEncryptionProvider,
                {
                  sourceTable: "conversation_items",
                  sourceId: row.id,
                  sourceColumn: "transport_chunk_text",
                  plaintext: item.transportChunkText,
                  ...encryptionInput
                }
              );
            }
          }
          await upsertEncryptedFieldPayloadWithClient(
            client,
            { userId: ownerUserId },
            options.envelopeEncryptionProvider,
            {
              sourceTable: "conversation_items",
              sourceId: row.id,
              sourceColumn: "metadata",
              plaintext: metadataForEncryption,
              ...encryptionInput
            }
          );
          await synchronizeEncryptedConversationItemColumns({
            client,
            sourceId: row.id
          });
        }

        await persistConversationItemObservation({
          client,
          actor: { userId: ownerUserId },
          item,
          conversationItemId: row.id,
          canonicalItemKey,
          sourceIdempotencyKey,
          suppressPlaintextRaw,
          envelopeEncryptionProvider: options.envelopeEncryptionProvider,
          payloadHash
        });
        await commit();
        records.push(mapConversationItem(row));
      } catch (error) {
        if (ownsTransaction) {
          await client.query("rollback");
        }
        throw error;
      } finally {
        if (ownsTransaction) {
          client.release();
        }
      }
    }
    return records;
  },

  async releaseConversationProjectionHold(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          `managed-projection-release:${actor.userId}:${input.sessionId}:${input.externalTurnId}`
        ]
      );
      const session = await client.query<{
        id: string;
        capture_method: string;
        metadata: Record<string, unknown> | null;
      }>(
        `
          select s.id, s.capture_method, s.metadata
          from sessions s
          where s.id = $2
            and s.owner_user_id = $1
            and s.visibility = 'personal'
            and s.invalidated_at is null
            and s.personal_deleted_at is null
            and (
              s.capture_method = 'api'
              or exists (
                select 1
                from managed_conversation_runtime_bindings mcrb
                where mcrb.owner_user_id = s.owner_user_id
                  and mcrb.local_session_id = s.id
              )
            )
          limit 1
        `,
        [actor.userId, input.sessionId]
      );
      const managedSession = session.rows[0];
      if (
        !managedSession ||
        managedSession.metadata?.managedConversation !== true
      ) {
        throw Object.assign(
          new Error(
            "Managed conversation session is not bound to the local runtime"
          ),
          { statusCode: 404, code: "managed_session_not_found" }
        );
      }

      const terminal = await client.query<{ id: string }>(
        `
          select ci.id
          from conversation_items ci
          where ci.owner_user_id = $1
            and ci.visibility = 'personal'
            and ci.session_id = $2
            and ci.external_turn_id = $3
            and ci.personal_deleted_at is null
            and exists (
              select 1
              from conversation_item_observations cio
              where cio.conversation_item_id = ci.id
                and cio.owner_user_id = ci.owner_user_id
                and cio.visibility = ci.visibility
                and cio.session_id = ci.session_id
                and cio.source_adapter_version = 'codex-transcript-v1'
                and cio.source_transport = 'transcript'
                and cio.observation_kind = 'reconciliation'
                and cio.ingestion_status = 'persisted'
                and cio.source_event_type in ('task_complete', 'turn_aborted')
                and cio.source_line_number is not null
                and cio.observation_component = 'control'
                and cio.canonical_stable_item_id = 'turn:' || $3 || ':completed'
                and ci.canonical_stable_item_id = cio.canonical_stable_item_id
                and ci.canonical_item_key = cio.canonical_item_key
            )
          limit 1
        `,
        [actor.userId, input.sessionId, input.externalTurnId]
      );
      if (terminal.rowCount === 0) {
        throw Object.assign(
          new Error(
            "Managed turn cannot be projected before terminal reconciliation"
          ),
          { statusCode: 409, code: "managed_turn_not_terminal" }
        );
      }

      const released = await client.query<{ id: string }>(
        `
          update conversation_items
          set projection_status = 'pending',
              projection_error = null,
              projected_at = null
          where owner_user_id = $1
            and visibility = 'personal'
            and session_id = $2
            and external_turn_id = $3
            and projection_status in ('pending', 'held')
            and personal_deleted_at is null
          returning id
        `,
        [actor.userId, input.sessionId, input.externalTurnId]
      );
      await client.query("commit");
      return { conversationItemIds: released.rows.map((row) => row.id) };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
});
