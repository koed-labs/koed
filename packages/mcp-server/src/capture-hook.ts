#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MemoryApiError,
  MemoryApiClient,
  type McpServerConfig,
  defaultConfig
} from "./index.js";

export interface HookPayload {
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  turn_id?: string;
  tool_use_id?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  prompt?: string;
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

export interface CaptureItem {
  actor: "user" | "assistant" | "agent" | "subagent" | "tool" | "system";
  eventType: string;
  content: string;
  metadata: Record<string, unknown>;
}

interface RawConversationItemResponse {
  id: string;
  sourceSequence: number | null;
  idempotencyKey: string;
}

type RawConversationItemRequest = {
  sourceKind: string;
  sourceAdapterVersion: string;
  sourceTransport: string;
  sessionId?: string;
  externalSessionId?: string;
  externalThreadId?: string;
  externalTurnId?: string;
  externalItemId?: string;
  parentExternalItemId?: string;
  sourceRecordType: string;
  sourceEventType?: string;
  sourcePath?: string;
  sourceLineNumber?: number;
  sourceSequence?: number;
  eventTime?: string;
  rawJson: unknown;
  rawText?: string;
  logicalSourceId?: string;
  transportChunkIndex?: number;
  transportChunkCount?: number;
  transportChunkText?: string;
  transportChunkEncoding?: string;
  sourceHash: string;
  idempotencyKey: string;
  projectionStatus: string;
  projectionVersion: string;
  metadata: Record<string, unknown>;
};

interface CaptureState {
  seen: Record<string, true>;
  rawSeen: Record<string, true>;
  immediatePrompts?: Record<
    string,
    {
      sourceHash: string;
      externalSessionId?: string;
      externalTurnId?: string;
      actor: "user" | "agent";
      prompt: string;
      capturedAt: number;
    }
  >;
  transcriptOffsets?: Record<
    string,
    {
      offset: number;
      lineCount: number;
      size: number;
    }
  >;
}

export interface HookBreakerEntry {
  consecutiveFailures: number;
  openedAt?: number;
  retryAfter?: number;
  lastFailureAt?: number;
  lastError?: string;
  lastDetachedCatchupAt?: number;
}

export interface HookBreakerState {
  version: 1;
  foregroundFailures: Record<string, HookBreakerEntry>;
}

type CaptureHookConfig = McpServerConfig & {
  baseUrl?: string;
  captureEnabled?: boolean;
  capturePausedUntil?: string | null;
};

const parseArgs = (
  args: string[]
): { configPath?: string; catchUp?: boolean; payloadBase64?: string } => {
  const parsed: {
    configPath?: string;
    catchUp?: boolean;
    payloadBase64?: string;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--config") {
      parsed.configPath = args[index + 1];
      index += 1;
    } else if (value === "--catch-up") {
      parsed.catchUp = true;
    } else if (value === "--payload-base64") {
      parsed.payloadBase64 = args[index + 1];
      index += 1;
    }
  }

  return parsed;
};

const expandHome = (filePath: string): string =>
  filePath.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asUnknownArray = (value: unknown): unknown[] | null =>
  Array.isArray(value) ? (value as unknown[]) : null;

export const hookApiRequestTimeoutMs = (): number =>
  positiveIntEnv("MEMORY_HOOK_API_REQUEST_TIMEOUT_MS", 1_500);

export const loadConfig = (configPath?: string): CaptureHookConfig => {
  const envConfig = defaultConfig();

  if (!configPath) {
    return { ...envConfig, requestTimeoutMs: hookApiRequestTimeoutMs() };
  }

  const fileConfig = JSON.parse(
    fs.readFileSync(expandHome(configPath), "utf8")
  ) as Partial<CaptureHookConfig>;

  return {
    apiUrl: fileConfig.apiUrl ?? fileConfig.baseUrl ?? envConfig.apiUrl,
    apiToken: fileConfig.apiToken ?? envConfig.apiToken,
    requestTimeoutMs: fileConfig.requestTimeoutMs ?? hookApiRequestTimeoutMs(),
    captureEnabled: fileConfig.captureEnabled,
    capturePausedUntil: fileConfig.capturePausedUntil
  };
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer<ArrayBufferLike>[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const transcriptRecordPositionSymbol = Symbol("koedTranscriptRecordPosition");

const attachTranscriptRecordPosition = (
  record: unknown,
  byteOffset: number
): unknown => {
  if (record && typeof record === "object") {
    Object.defineProperty(record, transcriptRecordPositionSymbol, {
      value: byteOffset,
      enumerable: false,
      configurable: false
    });
  }
  return record;
};

const transcriptRecordPosition = (record: unknown): number | undefined => {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as { [transcriptRecordPositionSymbol]?: unknown })[
    transcriptRecordPositionSymbol
  ];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
};

const safeSourceSequence = (value: number): number =>
  Math.max(0, Math.min(value, 2_000_000_000));

const positiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const hookTranscriptTailBytes = (): number =>
  positiveIntEnv("MEMORY_HOOK_TRANSCRIPT_TAIL_BYTES", 1_000_000);

const foregroundTranscriptTailBytes = (): number =>
  positiveIntEnv("MEMORY_HOOK_FOREGROUND_TRANSCRIPT_TAIL_BYTES", 128_000);

const hookDeadlineMs = (): number =>
  positiveIntEnv("MEMORY_HOOK_DEADLINE_MS", 8_500);

const hookBreakerFailureThreshold = (): number =>
  positiveIntEnv("MEMORY_HOOK_BREAKER_FAILURE_THRESHOLD", 3);

const hookBreakerCooldownMs = (): number =>
  positiveIntEnv("MEMORY_HOOK_BREAKER_COOLDOWN_MS", 60_000);

const transcriptCatchupPassDeadlineMs = (): number =>
  positiveIntEnv("MEMORY_TRANSCRIPT_CATCHUP_PASS_DEADLINE_MS", 60_000);

const transcriptCatchupMaxRuntimeMs = (): number =>
  positiveIntEnv("MEMORY_TRANSCRIPT_CATCHUP_MAX_RUNTIME_MS", 5 * 60_000);

const transcriptCatchupLockTtlMs = (): number =>
  positiveIntEnv("MEMORY_TRANSCRIPT_CATCHUP_LOCK_TTL_MS", 10 * 60_000);

const transcriptCatchupRetryInitialDelayMs = (): number =>
  positiveIntEnv("MEMORY_TRANSCRIPT_CATCHUP_RETRY_INITIAL_DELAY_MS", 1_000);

const transcriptCatchupRetryMaxDelayMs = (): number =>
  positiveIntEnv("MEMORY_TRANSCRIPT_CATCHUP_RETRY_MAX_DELAY_MS", 30_000);

const rawIngestBatchBytes = (): number =>
  positiveIntEnv("MEMORY_RAW_INGEST_BATCH_BYTES", 180_000);

const rawItemBodyBytes = (item: RawConversationItemRequest): number =>
  Buffer.byteLength(JSON.stringify({ items: [item] }), "utf8");

const chunkStringByUtf8Bytes = (value: string, maxBytes: number): string[] => {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return [value];
  }

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current.length > 0 && currentBytes + charBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
};

export const rawItemRequestChunks = (
  item: RawConversationItemRequest
): RawConversationItemRequest[] => {
  const maxBytes = rawIngestBatchBytes();
  if (rawItemBodyBytes(item) <= maxBytes) {
    return [item];
  }

  const serializedRawItem = JSON.stringify({
    rawJson: item.rawJson,
    rawText: typeof item.rawText === "string" ? item.rawText : null
  });
  const envelopeBytes = rawItemBodyBytes({
    ...item,
    rawJson: {
      transportChunk: true,
      sourceItemHash: item.sourceHash,
      chunkIndex: 0,
      chunkCount: 1
    },
    rawText: undefined,
    logicalSourceId: item.sourceHash,
    transportChunkIndex: 0,
    transportChunkCount: 1,
    transportChunkText: "",
    transportChunkEncoding: "conversation-item-json-v1"
  });
  let chunkBudget = Math.max(
    100,
    Math.floor((maxBytes - envelopeBytes - 1_024) / 2)
  );
  while (chunkBudget > 0) {
    const chunks = chunkStringByUtf8Bytes(serializedRawItem, chunkBudget);
    const requests = chunks.map((chunk, index) => {
      const chunkHash = hash({
        sourceHash: item.sourceHash,
        transportChunkIndex: index,
        transportChunkCount: chunks.length
      });
      return {
        ...item,
        rawJson: {
          transportChunk: true,
          sourceItemHash: item.sourceHash,
          chunkIndex: index,
          chunkCount: chunks.length
        },
        rawText: undefined,
        logicalSourceId: item.sourceHash,
        transportChunkIndex: index,
        transportChunkCount: chunks.length,
        transportChunkText: chunk,
        transportChunkEncoding: "conversation-item-json-v1",
        sourceHash: chunkHash,
        idempotencyKey: chunkHash,
        metadata: {
          ...item.metadata,
          sourceItemHash: item.sourceHash,
          sourceChunkIndex: index,
          sourceChunkCount: chunks.length
        }
      };
    });
    if (requests.every((request) => rawItemBodyBytes(request) <= maxBytes)) {
      return requests;
    }
    chunkBudget = Math.floor(chunkBudget / 2);
  }

  throw new Error("Raw conversation item envelope exceeds ingest batch budget");
};

export const rawItemBatches = (
  items: RawConversationItemRequest[]
): RawConversationItemRequest[][] => {
  const maxBytes = rawIngestBatchBytes();
  const emptyBodyBytes = Buffer.byteLength('{"items":[]}', "utf8");
  const batches: RawConversationItemRequest[][] = [];
  let current: RawConversationItemRequest[] = [];
  let currentBytes = emptyBodyBytes;

  for (const item of items.flatMap(rawItemRequestChunks)) {
    const itemBytes = rawItemBodyBytes(item);
    if (current.length > 0 && currentBytes + itemBytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = emptyBodyBytes;
    }
    current.push(item);
    currentBytes += itemBytes;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
};

export const rawItemsForCapture = (
  items: RawConversationItemRequest[],
  rawSeen: Record<string, true>,
  requiredSourceSequences: Set<number>,
  requiredSourceHashes = new Set<string>()
): RawConversationItemRequest[] =>
  items.filter(
    (item) =>
      !rawSeen[item.sourceHash] ||
      requiredSourceHashes.has(item.sourceHash) ||
      (typeof item.sourceSequence === "number" &&
        requiredSourceSequences.has(item.sourceSequence))
  );

const createConversationItemsBatched = async (
  client: MemoryApiClient,
  items: RawConversationItemRequest[],
  deadlineAtMs = Number.POSITIVE_INFINITY
): Promise<{ completed: boolean; items: RawConversationItemResponse[] }> => {
  const responses: RawConversationItemResponse[] = [];
  for (const batch of rawItemBatches(items)) {
    if (Date.now() > deadlineAtMs - 1_000) {
      return { completed: false, items: responses };
    }
    const response = (await client.createConversationItems({
      items: batch
    })) as { items?: RawConversationItemResponse[] };
    responses.push(...(response.items ?? []));
  }
  return { completed: true, items: responses };
};

const projectConversationItemsBatched = async (
  client: MemoryApiClient,
  items: RawConversationItemResponse[],
  deadlineAtMs = Number.POSITIVE_INFINITY
): Promise<boolean> => {
  const ids = items.map((item) => item.id).filter(Boolean);
  for (let index = 0; index < ids.length; index += 1000) {
    if (Date.now() > deadlineAtMs - 1_000) {
      return false;
    }
    const conversationItemIds = ids.slice(index, index + 1000);
    await client.projectConversationItems({
      conversationItemIds,
      limit: conversationItemIds.length
    });
  }
  return true;
};

const hookTriggersLcmSummary = (): boolean =>
  (process.env.MEMORY_HOOK_TRIGGER_LCM_SUMMARY ?? "true")
    .trim()
    .toLowerCase() !== "false";

const hookTriggersTranscriptCatchup = (): boolean =>
  (process.env.MEMORY_HOOK_TRIGGER_TRANSCRIPT_CATCHUP ?? "true")
    .trim()
    .toLowerCase() !== "false";

const hookLcmSummaryDelayMs = (): number =>
  positiveIntEnv("MEMORY_HOOK_LCM_SUMMARY_DELAY_MS", 10_000);

const hookLcmSummaryLimit = (): number =>
  positiveIntEnv("MEMORY_HOOK_LCM_SUMMARY_LIMIT", 2);

const pausedUntilActive = (value?: string | null): boolean => {
  if (!value) {
    return false;
  }
  if (value === "until-resumed") {
    return true;
  }
  const numericSeconds = Number.parseInt(value, 10);
  const timestamp = Number.isFinite(numericSeconds)
    ? numericSeconds * 1000
    : new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
};

const stringifyContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (isRecord(item) && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  return "";
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const roleToActor = (role: unknown): CaptureItem["actor"] | null =>
  role === "user" ||
  role === "assistant" ||
  role === "agent" ||
  role === "subagent" ||
  role === "tool" ||
  role === "system"
    ? role
    : null;

export interface TranscriptContext {
  threadKind: "conversation" | "subagent";
  parentThreadId?: string;
  parentSessionId?: string;
  parentExternalSessionId?: string;
  transcriptSessionId?: string;
  transcriptMetadata: Record<string, unknown>;
}

export interface EffectiveCaptureContext {
  externalSessionId?: string;
  parentThreadId?: string;
  transcriptPath?: string;
  parentTranscriptPath?: string;
  agentId?: string;
  agentType?: string;
  isSubagent: boolean;
}

const containersForRecord = (record: Record<string, unknown>) => {
  const payload = isRecord(record.payload) ? record.payload : undefined;
  const message =
    payload && isRecord(payload.message) ? payload.message : undefined;
  return [
    record,
    isRecord(record.metadata) ? record.metadata : undefined,
    payload,
    payload && isRecord(payload.metadata) ? payload.metadata : undefined,
    payload && isRecord(payload.session) ? payload.session : undefined,
    message,
    message && isRecord(message.metadata) ? message.metadata : undefined
  ].filter((container): container is Record<string, unknown> =>
    Boolean(container)
  );
};

const firstMetadataString = (
  records: Record<string, unknown>[],
  keys: string[]
): string | undefined => {
  for (const record of records) {
    for (const container of containersForRecord(record)) {
      for (const key of keys) {
        const value = asString(container[key]);
        if (value) {
          return value;
        }
      }
    }
  }
  return undefined;
};

const stringAtPath = (
  value: Record<string, unknown> | undefined,
  pathKeys: string[]
): string | undefined => {
  let current: unknown = value;
  for (const key of pathKeys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return asString(current);
};

const firstMetadataPathString = (
  records: Record<string, unknown>[],
  paths: string[][]
): string | undefined => {
  for (const record of records) {
    for (const container of containersForRecord(record)) {
      for (const pathKeys of paths) {
        const value = stringAtPath(container, pathKeys);
        if (value) {
          return value;
        }
      }
    }
  }
  return undefined;
};

export const extractTranscriptSessionMetadata = (
  records: unknown[]
): TranscriptContext => {
  const recordObjects = records.filter(isRecord);
  const sessionMeta = recordObjects
    .map((record) => {
      if (record.type === "session_meta" && isRecord(record.payload)) {
        return record.payload;
      }
      if (record.type === "session_meta") {
        return record;
      }
      return isRecord(record.payload) && record.payload.type === "session_meta"
        ? record.payload
        : undefined;
    })
    .filter((record): record is Record<string, unknown> => Boolean(record))
    .find(
      (item) =>
        item.type === "session_meta" ||
        asString(item.id) ||
        asString(item.thread_source) ||
        isRecord(item.source)
    );
  const parentSessionId =
    firstMetadataString(recordObjects, [
      "parentSessionId",
      "parent_session_id",
      "parentId",
      "parent_id"
    ]) ??
    firstMetadataPathString(recordObjects, [
      ["source", "subagent", "thread_spawn", "parent_session_id"],
      ["source", "subagent", "thread_spawn", "parentSessionId"]
    ]);
  const parentExternalSessionId = firstMetadataString(recordObjects, [
    "parentExternalSessionId",
    "parent_external_session_id",
    "parentExternalId",
    "parent_external_id"
  ]);
  const parentThreadId =
    firstMetadataString(recordObjects, [
      "parentThreadId",
      "parent_thread_id",
      "parentConversationId",
      "parent_conversation_id"
    ]) ??
    firstMetadataPathString(recordObjects, [
      ["source", "subagent", "thread_spawn", "parent_thread_id"],
      ["source", "subagent", "thread_spawn", "parentThreadId"],
      ["source", "subagent", "parent_thread_id"],
      ["source", "subagent", "parentThreadId"]
    ]) ??
    parentExternalSessionId ??
    parentSessionId;
  const transcriptSessionId =
    asString(sessionMeta?.id) ??
    firstMetadataString(recordObjects, [
      "sessionId",
      "session_id",
      "conversationId",
      "conversation_id"
    ]);
  const explicitThreadKind = firstMetadataString(recordObjects, [
    "threadKind",
    "thread_kind",
    "sessionKind",
    "session_kind",
    "threadSource",
    "thread_source"
  ]);
  const threadKind =
    explicitThreadKind === "subagent" || parentThreadId
      ? "subagent"
      : "conversation";
  const transcriptMetadata: Record<string, unknown> = {};

  if (sessionMeta) {
    for (const key of [
      "id",
      "session_id",
      "conversation_id",
      "timestamp",
      "cwd",
      "model",
      "source",
      "originator",
      "cli_version",
      "thread_source",
      "agent_nickname",
      "agent_role",
      "parentSessionId",
      "parent_session_id",
      "parentThreadId",
      "parent_thread_id",
      "parentExternalSessionId",
      "parent_external_session_id"
    ]) {
      if (sessionMeta[key] !== undefined) {
        transcriptMetadata[key] = sessionMeta[key];
      }
    }
  }

  return {
    threadKind,
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(parentExternalSessionId ? { parentExternalSessionId } : {}),
    ...(transcriptSessionId ? { transcriptSessionId } : {}),
    transcriptMetadata
  };
};

const compactDisplay = (value: unknown, maxLength = 240): string => {
  const content = stringifyContent(value).replace(/\s+/g, " ").trim();
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength - 1)}...`;
};

const toolMetadata = (
  item: Record<string, unknown>,
  raw: Record<string, unknown>,
  index: number,
  context: TranscriptContext,
  kind: "call" | "output"
): Record<string, unknown> => {
  const toolName = asString(item.name) ?? asString(item.title);
  const toolTitle = asString(item.title) ?? toolName;
  const callId =
    asString(item.call_id) ?? asString(item.callId) ?? asString(item.id);
  const input = item.arguments ?? item.input;
  const output = item.output ?? item.content ?? item.result;
  const status = asString(item.status);
  const error = item.error ?? item.failure;
  const summary =
    kind === "call"
      ? `Tool call: ${toolTitle ?? callId ?? "tool"}`
      : `Tool output: ${toolTitle ?? callId ?? "tool"}`;

  return {
    ...contextMetadata(context),
    transcriptIndex: index,
    transcriptType: item.type,
    transcriptParentType: raw.type,
    transcriptId: item.id,
    toolEventKind: item.type,
    toolSummary: summary,
    ...(toolName ? { toolName } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(callId ? { callId, toolCallId: callId } : {}),
    ...(status ? { status } : {}),
    ...(error !== undefined ? { error } : {}),
    toolCall: {
      kind,
      type: item.type,
      ...(toolName ? { name: toolName } : {}),
      ...(toolTitle ? { title: toolTitle } : {}),
      ...(callId ? { id: callId } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(status ? { status } : {}),
      ...(error !== undefined ? { error } : {})
    },
    rawTranscriptPayload: item
  };
};

const toolCallContent = (metadata: Record<string, unknown>): string => {
  const toolCall = isRecord(metadata.toolCall) ? metadata.toolCall : {};
  const input = toolCall.input;
  const status = asString(toolCall.status);
  return [
    metadata.toolSummary,
    status ? `Status: ${status}` : "",
    input !== undefined ? `Input:\n${compactDisplay(input, 800)}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
};

const toolOutputContent = (metadata: Record<string, unknown>): string => {
  const toolCall = isRecord(metadata.toolCall) ? metadata.toolCall : {};
  const output = toolCall.output;
  const status = asString(toolCall.status);
  const error = toolCall.error;
  return [
    metadata.toolSummary,
    status ? `Status: ${status}` : "",
    output !== undefined ? compactDisplay(output, 1200) : "",
    error !== undefined ? `Error:\n${compactDisplay(error, 800)}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
};

const contextMetadata = (
  context: TranscriptContext
): Record<string, unknown> => ({
  threadKind: context.threadKind,
  ...(context.parentThreadId ? { parentThreadId: context.parentThreadId } : {}),
  ...(context.parentSessionId
    ? { parentSessionId: context.parentSessionId }
    : {}),
  ...(context.parentExternalSessionId
    ? { parentExternalSessionId: context.parentExternalSessionId }
    : {}),
  ...(context.transcriptSessionId
    ? { transcriptSessionId: context.transcriptSessionId }
    : {}),
  ...(Object.keys(context.transcriptMetadata).length > 0
    ? { transcriptMetadata: context.transcriptMetadata }
    : {})
});

export const captureTranscriptPathForPayload = (
  payload: HookPayload
): string | undefined => {
  if (
    payload.hook_event_name === "SubagentStop" &&
    payload.agent_transcript_path
  ) {
    return payload.agent_transcript_path;
  }
  return payload.transcript_path;
};

const isSubagentPayload = (payload: HookPayload): boolean =>
  payload.hook_event_name === "SubagentStart" ||
  payload.hook_event_name === "SubagentStop" ||
  Boolean(payload.agent_id);

export const effectiveCaptureContext = (
  payload: HookPayload,
  transcriptContext: TranscriptContext = {
    threadKind: "conversation",
    transcriptMetadata: {}
  }
): EffectiveCaptureContext => {
  const isSubagent =
    transcriptContext.threadKind === "subagent" || isSubagentPayload(payload);
  const externalSessionId =
    transcriptContext.transcriptSessionId ??
    (isSubagent ? payload.agent_id : undefined) ??
    payload.session_id;
  const inferredParentThreadId = isSubagent
    ? (transcriptContext.parentThreadId ?? payload.session_id)
    : transcriptContext.parentThreadId;
  const parentThreadId =
    inferredParentThreadId && inferredParentThreadId !== externalSessionId
      ? inferredParentThreadId
      : isSubagent &&
          payload.session_id &&
          payload.session_id !== externalSessionId
        ? payload.session_id
        : undefined;
  const transcriptPath = captureTranscriptPathForPayload(payload);
  const parentTranscriptPath =
    payload.hook_event_name === "SubagentStop" &&
    payload.transcript_path &&
    payload.transcript_path !== transcriptPath
      ? payload.transcript_path
      : undefined;

  return {
    ...(externalSessionId ? { externalSessionId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(parentTranscriptPath ? { parentTranscriptPath } : {}),
    ...(payload.agent_id ? { agentId: payload.agent_id } : {}),
    ...(payload.agent_type ? { agentType: payload.agent_type } : {}),
    isSubagent
  };
};

const hookPayloadMetadata = (
  payload: HookPayload,
  effectiveContext: EffectiveCaptureContext
): Record<string, unknown> => ({
  hookEventName: payload.hook_event_name,
  threadKind: effectiveContext.isSubagent ? "subagent" : "conversation",
  externalSessionId: effectiveContext.externalSessionId,
  parentThreadId: effectiveContext.parentThreadId,
  parentExternalSessionId: effectiveContext.parentThreadId,
  externalTurnId: payload.turn_id,
  toolUseId: payload.tool_use_id,
  model: payload.model,
  cwd: payload.cwd,
  agentId: payload.agent_id,
  agentType: payload.agent_type,
  codexTranscriptPath: effectiveContext.transcriptPath,
  codexParentTranscriptPath: effectiveContext.parentTranscriptPath
});

const codexMessageActor = (
  item: Record<string, unknown>,
  role: unknown,
  context: TranscriptContext
): CaptureItem["actor"] | null => {
  if (item.type === "user_message") {
    return context.threadKind === "subagent" ? "agent" : "user";
  }
  if (item.type === "assistant_message" || item.type === "agent_message") {
    return context.threadKind === "subagent" ? "subagent" : "agent";
  }
  if (role === "assistant") {
    return context.threadKind === "subagent" ? "subagent" : "agent";
  }
  if (role === "user") {
    return context.threadKind === "subagent" ? "agent" : "user";
  }
  return roleToActor(role);
};

const extractTranscriptItem = (
  record: unknown,
  index: number,
  options: { preferEventMessages: boolean; context: TranscriptContext }
): CaptureItem | null => {
  if (!record || typeof record !== "object") {
    return null;
  }

  const raw = isRecord(record) ? record : null;
  if (!raw) {
    return null;
  }
  const payload = isRecord(raw.payload) ? raw.payload : undefined;
  const item = payload ?? raw;
  if (
    options.preferEventMessages &&
    raw.type === "response_item" &&
    item.type === "message"
  ) {
    return null;
  }
  const message = isRecord(item.message) ? item.message : undefined;
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const metadata = toolMetadata(item, raw, index, options.context, "call");
    return {
      actor: "tool",
      eventType: "codex_transcript_tool_call",
      content: toolCallContent(metadata),
      metadata
    };
  }
  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    const metadata = toolMetadata(item, raw, index, options.context, "output");
    return {
      actor: "tool",
      eventType: "codex_transcript_tool_output",
      content: toolOutputContent(metadata),
      metadata
    };
  }
  const actor =
    codexMessageActor(item, item.role, options.context) ??
    codexMessageActor(item, message?.role, options.context) ??
    roleToActor(item.actor) ??
    (item.type === "user_message"
      ? options.context.threadKind === "subagent"
        ? "agent"
        : "user"
      : item.type === "assistant_message" || item.type === "agent_message"
        ? options.context.threadKind === "subagent"
          ? "subagent"
          : "agent"
        : null);
  if (!actor) {
    return null;
  }

  const content = stringifyContent(
    item.content ??
      item.text ??
      (typeof item.message === "string" ? item.message : undefined) ??
      message?.content ??
      message?.text
  );
  if (!content.trim()) {
    return null;
  }

  return {
    actor,
    eventType: `codex_transcript_${actor}`,
    content,
    metadata: {
      ...contextMetadata(options.context),
      transcriptIndex: index,
      transcriptType: item.type,
      transcriptParentType: raw.type,
      transcriptId: item.id
    }
  };
};

const parseTranscriptRecordsText = (text: string): unknown[] => {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const records: unknown[] = [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const parsedArray = asUnknownArray(parsed);
    if (parsedArray) {
      records.push(...parsedArray);
    } else if (isRecord(parsed) && asUnknownArray(parsed.items)) {
      records.push(...asUnknownArray(parsed.items)!);
    } else {
      records.push(parsed);
    }
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        continue;
      }
    }
  }
  return records;
};

const parseTranscriptLineRecords = (
  lines: string[],
  absoluteStartOffset: number
): unknown[] => {
  const records: unknown[] = [];
  let relativeOffset = 0;
  for (const line of lines) {
    const lineOffset = absoluteStartOffset + relativeOffset;
    relativeOffset += Buffer.byteLength(`${line}\n`, "utf8");
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const parsedArray = asUnknownArray(parsed);
      if (parsedArray) {
        for (const item of parsedArray) {
          records.push(attachTranscriptRecordPosition(item, lineOffset));
        }
      } else if (isRecord(parsed) && asUnknownArray(parsed.items)) {
        for (const item of asUnknownArray(parsed.items)!) {
          records.push(attachTranscriptRecordPosition(item, lineOffset));
        }
      } else {
        records.push(attachTranscriptRecordPosition(parsed, lineOffset));
      }
    } catch {
      continue;
    }
  }
  return records;
};

export const parseTranscriptRecords = (
  records: unknown[],
  indexOffset = 0
): CaptureItem[] => {
  if (records.length === 0) {
    return [];
  }

  const preferEventMessages = transcriptPrefersEventMessages(records);
  const context = extractTranscriptSessionMetadata(records);

  return records
    .map((record, index) =>
      extractTranscriptItem(record, index + indexOffset, {
        preferEventMessages,
        context
      })
    )
    .filter((item): item is CaptureItem => Boolean(item));
};

const transcriptPrefersEventMessages = (records: unknown[]): boolean =>
  records.some((record) => {
    if (!record || typeof record !== "object") {
      return false;
    }
    const raw = isRecord(record) ? record : null;
    const payload = raw
      ? isRecord(raw.payload)
        ? raw.payload
        : undefined
      : undefined;
    return (
      raw?.type === "event_msg" &&
      (payload?.type === "user_message" ||
        payload?.type === "agent_message" ||
        payload?.type === "assistant_message")
    );
  });

export const parseTranscriptText = (text: string): CaptureItem[] =>
  parseTranscriptRecords(parseTranscriptRecordsText(text));

export const shouldReadTranscriptForHook = (payload: HookPayload): boolean =>
  payload.hook_event_name === "SessionStart" ||
  payload.hook_event_name === "UserPromptSubmit" ||
  payload.hook_event_name === "PostToolUse" ||
  payload.hook_event_name === "Stop" ||
  payload.hook_event_name === "SubagentStart" ||
  payload.hook_event_name === "SubagentStop";

const splitCompleteTranscriptLines = (
  text: string,
  reachedEnd: boolean
): { lines: string[]; consumedBytes: number } => {
  const hasTrailingNewline = /\r?\n$/.test(text);
  const parts = text.split(/\r?\n/);
  let consumedText = text;
  if (hasTrailingNewline) {
    parts.pop();
  } else if (!reachedEnd) {
    const incomplete = parts.pop() ?? "";
    consumedText = text.slice(0, Math.max(0, text.length - incomplete.length));
  }
  const lines = parts.filter((line) => line.trim());
  return {
    lines,
    consumedBytes: Buffer.byteLength(consumedText, "utf8")
  };
};

const transcriptStateKey = (scope: string, transcriptPath: string): string =>
  scopedStateKey(scope, transcriptPath);

type TranscriptFileRead = {
  records: unknown[];
  indexOffset: number;
  checkpoint?: { key: string; offset: number; lineCount: number; size: number };
  backgroundCatchupNeeded: boolean;
  backlogBytes: number;
};

export const parseTranscriptFileRecords = (input: {
  transcriptPath?: string;
  state: CaptureState;
  stateScope: string;
  maxBytes?: number;
}): {
  records: unknown[];
  indexOffset: number;
  checkpoint?: { key: string; offset: number; lineCount: number; size: number };
} => {
  const { transcriptPath } = input;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { records: [], indexOffset: 0 };
  }

  const stat = fs.statSync(transcriptPath);
  const key = transcriptStateKey(input.stateScope, transcriptPath);
  const prior = input.state.transcriptOffsets?.[key];
  const maxBytes = input.maxBytes ?? hookTranscriptTailBytes();
  const hasUsableCheckpoint = Boolean(prior && prior.size <= stat.size);
  if (!hasUsableCheckpoint && stat.size > 0) {
    return {
      records: [],
      indexOffset: 0,
      checkpoint: {
        key,
        offset: stat.size,
        lineCount: 0,
        size: stat.size
      }
    };
  }
  const start = prior && hasUsableCheckpoint ? Math.max(0, prior.offset) : 0;
  const indexOffset =
    prior && hasUsableCheckpoint && start > 0 ? prior.lineCount : 0;
  const end = Math.min(stat.size, start + maxBytes);
  if (end <= start) {
    return {
      records: [],
      indexOffset,
      checkpoint: {
        key,
        offset: start,
        lineCount: indexOffset,
        size: stat.size
      }
    };
  }

  const buffer = Buffer.allocUnsafe(end - start);
  const fd = fs.openSync(transcriptPath, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }

  const { lines, consumedBytes } = splitCompleteTranscriptLines(
    buffer.toString("utf8"),
    end >= stat.size
  );
  return {
    records: parseTranscriptLineRecords(lines, start),
    indexOffset,
    checkpoint: {
      key,
      offset: start + consumedBytes,
      lineCount: indexOffset + lines.length,
      size: stat.size
    }
  };
};

export const parseForegroundTranscriptFileRecords = (input: {
  transcriptPath?: string;
  state: CaptureState;
  stateScope: string;
  foregroundMaxBytes?: number;
}): {
  records: unknown[];
  indexOffset: number;
  checkpoint?: { key: string; offset: number; lineCount: number; size: number };
  backgroundCatchupNeeded: boolean;
  backlogBytes: number;
} => {
  const { transcriptPath } = input;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return {
      records: [],
      indexOffset: 0,
      backgroundCatchupNeeded: false,
      backlogBytes: 0
    };
  }

  const stat = fs.statSync(transcriptPath);
  const key = transcriptStateKey(input.stateScope, transcriptPath);
  const prior = input.state.transcriptOffsets?.[key];
  const hasUsableCheckpoint = Boolean(prior && prior.size <= stat.size);
  const maxBytes = input.foregroundMaxBytes ?? foregroundTranscriptTailBytes();
  if (!hasUsableCheckpoint) {
    const sequential = parseTranscriptFileRecords({
      transcriptPath,
      state: input.state,
      stateScope: input.stateScope,
      maxBytes
    });
    return {
      ...sequential,
      backgroundCatchupNeeded: false,
      backlogBytes: 0
    };
  }

  const checkpointOffset = Math.max(0, prior!.offset);
  const backlogBytes = Math.max(0, stat.size - checkpointOffset);
  if (backlogBytes <= maxBytes) {
    const sequential = parseTranscriptFileRecords({
      transcriptPath,
      state: input.state,
      stateScope: input.stateScope,
      maxBytes
    });
    return {
      ...sequential,
      backgroundCatchupNeeded: false,
      backlogBytes
    };
  }

  const start = Math.max(checkpointOffset, stat.size - maxBytes);
  const buffer = Buffer.allocUnsafe(stat.size - start);
  const fd = fs.openSync(transcriptPath, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }

  const { lines } = splitCompleteTranscriptLines(buffer.toString("utf8"), true);
  return {
    records: parseTranscriptLineRecords(lines, start),
    // While backlog exists, this is a bounded temporary line-based ordering
    // value. Raw idempotency uses the private transcript byte position, so
    // background catch-up will no-op these same lines once it reaches the tail.
    indexOffset: prior!.lineCount,
    backgroundCatchupNeeded: true,
    backlogBytes
  };
};

const rawRecordPayload = (record: unknown): Record<string, unknown> | null =>
  isRecord(record)
    ? isRecord(record.payload)
      ? record.payload
      : record
    : null;

const rawRecordType = (record: unknown): string => {
  if (!isRecord(record)) {
    return "unknown";
  }
  return asString(record.type) ?? "unknown";
};

const rawEventType = (record: unknown): string | undefined => {
  if (!isRecord(record)) {
    return undefined;
  }
  const payload = isRecord(record.payload) ? record.payload : undefined;
  return (
    asString(payload?.type) ??
    asString(record.type) ??
    asString(payload?.method) ??
    asString(record.method)
  );
};

const parseRawEventTime = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const parsed = new Date(millis);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return undefined;
};

const rawEventTime = (record: unknown): string | undefined => {
  if (!isRecord(record)) {
    return undefined;
  }
  const payload = isRecord(record.payload) ? record.payload : undefined;
  const item = isRecord(payload?.item) ? payload.item : undefined;
  const message = isRecord(item?.message)
    ? item.message
    : isRecord(payload?.message)
      ? payload.message
      : isRecord(record.message)
        ? record.message
        : undefined;
  for (const source of [item, payload, message, record]) {
    if (!source) {
      continue;
    }
    const eventTime =
      parseRawEventTime(source.timestamp) ??
      parseRawEventTime(source.time) ??
      parseRawEventTime(source.created_at) ??
      parseRawEventTime(source.createdAt);
    if (eventTime) {
      return eventTime;
    }
  }
  return undefined;
};

const rawExternalItemId = (record: unknown): string | undefined => {
  const payload = rawRecordPayload(record);
  return (
    asString(payload?.id) ??
    asString(payload?.item_id) ??
    asString(payload?.itemId) ??
    asString(payload?.call_id) ??
    asString(payload?.callId)
  );
};

const rawText = (record: unknown): string | undefined => {
  const payload = rawRecordPayload(record);
  if (!payload) {
    return undefined;
  }
  return stringifyContent(
    payload.content ?? payload.text ?? payload.message ?? payload.output
  );
};

const sourceHashForRawRecord = (input: {
  externalSessionId?: string;
  transcriptPath?: string;
  index: number;
  record: unknown;
}): string =>
  hash({
    externalSessionId: input.externalSessionId,
    transcriptPath: input.transcriptPath,
    recordIdentity: rawExternalItemId(input.record) ??
      transcriptRecordPosition(input.record) ?? {
        eventType: rawEventType(input.record),
        eventTime: rawEventTime(input.record),
        rawText: rawText(input.record),
        record: input.record
      }
  });

const immediatePromptActor = (
  effectiveContext: EffectiveCaptureContext
): "user" | "agent" => (effectiveContext.isSubagent ? "agent" : "user");

const sourceHashForImmediatePrompt = (input: {
  externalSessionId?: string;
  turnId?: string;
  actor: "user" | "agent";
  prompt: string;
}): string =>
  hash({
    externalSessionId: input.externalSessionId,
    turnId: input.turnId,
    actor: input.actor,
    hookPrompt: input.prompt
  });

const isImmediateUserPromptSubmit = (
  payload: HookPayload
): payload is HookPayload & { prompt: string } =>
  payload.hook_event_name === "UserPromptSubmit" &&
  typeof payload.prompt === "string" &&
  payload.prompt.trim().length > 0;

const promptAlreadyRepresented = (
  items: RawConversationItemRequest[],
  hookPromptItem: RawConversationItemRequest
): boolean => {
  if (
    items.some(
      (item) =>
        item.sourceHash === hookPromptItem.sourceHash ||
        item.idempotencyKey === hookPromptItem.idempotencyKey
    )
  ) {
    return true;
  }

  const hookPrompt = immediatePromptInfo(hookPromptItem);
  if (!hookPrompt) {
    return false;
  }

  const matchingTranscriptIndexes = items.flatMap((item, index) => {
    const prompt = transcriptPromptInfo(item);
    return prompt &&
      prompt.externalSessionId === hookPrompt.externalSessionId &&
      prompt.externalTurnId === hookPrompt.externalTurnId &&
      prompt.actor === hookPrompt.actor &&
      prompt.prompt === hookPrompt.prompt
      ? [index]
      : [];
  });
  return matchingTranscriptIndexes.at(-1) === items.length - 1;
};

const immediatePromptInfo = (
  item: RawConversationItemRequest
): {
  externalSessionId?: string;
  externalTurnId?: string;
  actor: "user" | "agent";
  prompt: string;
} | null => {
  if (
    item.metadata?.immediateHookPrompt !== true ||
    typeof item.rawText !== "string" ||
    !item.rawText.trim()
  ) {
    return null;
  }
  return {
    externalSessionId: item.externalSessionId,
    externalTurnId: item.externalTurnId,
    actor: item.metadata.threadKind === "subagent" ? "agent" : "user",
    prompt: item.rawText
  };
};

const transcriptPromptInfo = (
  item: RawConversationItemRequest
): {
  externalSessionId?: string;
  externalTurnId?: string;
  actor: "user" | "agent";
  prompt: string;
} | null => {
  if (
    item.sourceRecordType === "hook_payload" ||
    typeof item.rawText !== "string" ||
    !item.rawText.trim()
  ) {
    return null;
  }
  const transcriptType =
    typeof item.metadata?.transcriptType === "string"
      ? item.metadata.transcriptType
      : item.sourceEventType;
  if (!/user/i.test(transcriptType ?? "")) {
    return null;
  }
  return {
    externalSessionId: item.externalSessionId,
    externalTurnId: item.externalTurnId,
    actor: item.metadata?.threadKind === "subagent" ? "agent" : "user",
    prompt: item.rawText
  };
};

const immediatePromptStateKey = (
  stateScope: string,
  input: {
    externalSessionId?: string;
    externalTurnId?: string;
    actor: "user" | "agent";
    prompt: string;
  }
): string =>
  scopedStateKey(
    stateScope,
    hash({
      externalSessionId: input.externalSessionId,
      externalTurnId: input.externalTurnId,
      actor: input.actor,
      prompt: input.prompt
    })
  );

const rememberImmediatePrompt = (
  state: CaptureState,
  stateScope: string,
  item: RawConversationItemRequest
): void => {
  const prompt = immediatePromptInfo(item);
  if (!prompt) {
    return;
  }
  const key = immediatePromptStateKey(stateScope, prompt);
  state.immediatePrompts = {
    ...(state.immediatePrompts ?? {}),
    [key]: {
      sourceHash: item.sourceHash,
      ...prompt,
      capturedAt: Date.now()
    }
  };
};

const immediatePromptMatchesTranscript = (
  immediate: NonNullable<CaptureState["immediatePrompts"]>[string],
  transcript: NonNullable<ReturnType<typeof transcriptPromptInfo>>
): boolean => {
  if (
    immediate.externalSessionId !== transcript.externalSessionId ||
    immediate.actor !== transcript.actor ||
    immediate.prompt !== transcript.prompt
  ) {
    return false;
  }
  if (immediate.externalTurnId && transcript.externalTurnId) {
    return immediate.externalTurnId === transcript.externalTurnId;
  }
  return true;
};

export const filterTranscriptItemsAlreadyCapturedFromImmediatePrompts = (
  state: CaptureState,
  stateScope: string,
  items: RawConversationItemRequest[]
): RawConversationItemRequest[] => {
  const immediatePrompts = Object.entries(state.immediatePrompts ?? {}).filter(
    ([key]) => key.startsWith(`${stateScope}:`)
  );
  if (immediatePrompts.length === 0) {
    return items;
  }

  const suppressedIndexes = new Set<number>();
  for (const [, immediate] of immediatePrompts) {
    const matchingIndexes = items.flatMap((item, index) => {
      const transcript = transcriptPromptInfo(item);
      return transcript &&
        immediatePromptMatchesTranscript(immediate, transcript)
        ? [index]
        : [];
    });
    let index: number | undefined;
    for (
      let candidateIndex = matchingIndexes.length - 1;
      candidateIndex >= 0;
      candidateIndex -= 1
    ) {
      const candidate = matchingIndexes[candidateIndex];
      if (candidate === undefined) {
        continue;
      }
      if (!suppressedIndexes.has(candidate)) {
        index = candidate;
        break;
      }
    }
    if (index !== undefined) {
      suppressedIndexes.add(index);
    }
  }

  return items.filter((_, index) => !suppressedIndexes.has(index));
};

const hookPromptMetadata = (
  payload: HookPayload,
  effectiveContext: EffectiveCaptureContext
): Record<string, unknown> => ({
  ...hookPayloadMetadata(payload, effectiveContext),
  immediateHookPrompt: true
});

const buildRawHookConversationItem = (input: {
  sessionId?: string;
  effectiveContext: EffectiveCaptureContext;
  payload: HookPayload;
}): RawConversationItemRequest => {
  const sourceHash = isImmediateUserPromptSubmit(input.payload)
    ? sourceHashForImmediatePrompt({
        externalSessionId: input.effectiveContext.externalSessionId,
        turnId: input.payload.turn_id,
        actor: immediatePromptActor(input.effectiveContext),
        prompt: input.payload.prompt
      })
    : hash({
        externalSessionId: input.effectiveContext.externalSessionId,
        hookEventName: input.payload.hook_event_name,
        turnId: input.payload.turn_id,
        payload: input.payload
      });
  return {
    sessionId: input.sessionId,
    sourceKind: "codex",
    sourceAdapterVersion: "codex-hook-v1",
    sourceTransport: "hook",
    externalSessionId: input.effectiveContext.externalSessionId,
    externalThreadId: input.effectiveContext.externalSessionId,
    externalTurnId: input.payload.turn_id,
    sourceRecordType: "hook_payload",
    sourceEventType: input.payload.hook_event_name ?? "hook_payload",
    rawJson: input.payload,
    rawText:
      input.payload.prompt ?? input.payload.last_assistant_message ?? undefined,
    sourceHash,
    idempotencyKey: sourceHash,
    projectionStatus: "pending",
    projectionVersion: "codex-hook-v1",
    metadata: isImmediateUserPromptSubmit(input.payload)
      ? hookPromptMetadata(input.payload, input.effectiveContext)
      : hookPayloadMetadata(input.payload, input.effectiveContext)
  };
};

export const selectRawConversationItemsForHook = (input: {
  transcriptRecords: unknown[];
  indexOffset?: number;
  sessionId?: string;
  effectiveContext: EffectiveCaptureContext;
  transcriptPath?: string;
  payload: HookPayload;
  mode: "foreground" | "catchup";
}): RawConversationItemRequest[] => {
  const transcriptItems =
    input.transcriptRecords.length > 0
      ? buildRawTranscriptConversationItems({
          records: input.transcriptRecords,
          indexOffset: input.indexOffset,
          sessionId: input.sessionId,
          effectiveContext: input.effectiveContext,
          transcriptPath: input.transcriptPath,
          payload: input.payload
        })
      : [];

  if (input.mode !== "foreground") {
    return transcriptItems;
  }

  const hookItem = buildRawHookConversationItem({
    sessionId: input.sessionId,
    effectiveContext: input.effectiveContext,
    payload: input.payload
  });

  if (input.transcriptRecords.length === 0) {
    return [hookItem];
  }

  if (!isImmediateUserPromptSubmit(input.payload)) {
    return transcriptItems;
  }

  return promptAlreadyRepresented(transcriptItems, hookItem)
    ? transcriptItems
    : [...transcriptItems, hookItem];
};

export const buildRawTranscriptConversationItems = (input: {
  records: unknown[];
  indexOffset?: number;
  sessionId?: string;
  effectiveContext: EffectiveCaptureContext;
  transcriptPath?: string;
  payload: HookPayload;
}): RawConversationItemRequest[] => {
  const preferEventMessages = transcriptPrefersEventMessages(input.records);
  const transcriptContext = extractTranscriptSessionMetadata(input.records);
  const context: TranscriptContext = {
    ...transcriptContext,
    threadKind: input.effectiveContext.isSubagent
      ? "subagent"
      : transcriptContext.threadKind,
    ...(input.effectiveContext.externalSessionId
      ? { transcriptSessionId: input.effectiveContext.externalSessionId }
      : {})
  };

  return input.records.map((record, index) => {
    const sourceSequence = safeSourceSequence(index + (input.indexOffset ?? 0));
    const parsedItem = extractTranscriptItem(record, sourceSequence, {
      preferEventMessages,
      context
    });
    const sourceHash = sourceHashForRawRecord({
      externalSessionId: input.effectiveContext.externalSessionId,
      transcriptPath: input.transcriptPath,
      index: sourceSequence,
      record
    });
    return {
      sessionId: input.sessionId,
      sourceKind: "codex",
      sourceAdapterVersion: "codex-transcript-v1",
      sourceTransport: "hook",
      externalSessionId: input.effectiveContext.externalSessionId,
      externalThreadId: input.effectiveContext.externalSessionId,
      externalTurnId: input.payload.turn_id,
      externalItemId: rawExternalItemId(record),
      sourceRecordType: rawRecordType(record),
      sourceEventType: rawEventType(record),
      sourcePath: input.transcriptPath,
      sourceLineNumber: sourceSequence,
      sourceSequence,
      eventTime: rawEventTime(record),
      rawJson: record,
      rawText: parsedItem?.content ?? rawText(record),
      sourceHash,
      idempotencyKey: sourceHash,
      projectionStatus: "pending",
      projectionVersion: "codex-transcript-v1",
      metadata: {
        ...(parsedItem?.metadata ?? {}),
        hookEventName: input.payload.hook_event_name,
        threadKind: input.effectiveContext.isSubagent
          ? "subagent"
          : "conversation",
        parentThreadId: input.effectiveContext.parentThreadId
      }
    };
  });
};

export const fallbackItems = (
  payload: HookPayload,
  effectiveContext = effectiveCaptureContext(payload)
): CaptureItem[] => {
  const metadata = hookPayloadMetadata(payload, effectiveContext);

  if (payload.prompt) {
    return [
      {
        actor: effectiveContext.isSubagent ? "agent" : "user",
        eventType: "codex_user_prompt",
        content: payload.prompt,
        metadata
      }
    ];
  }

  if (payload.last_assistant_message) {
    return [
      {
        actor: effectiveContext.isSubagent ? "subagent" : "agent",
        eventType: "codex_agent_message",
        content: payload.last_assistant_message,
        metadata
      }
    ];
  }

  if (payload.tool_name) {
    const toolCall = {
      kind: "hook",
      name: payload.tool_name,
      ...(payload.tool_input !== undefined
        ? { input: payload.tool_input }
        : {}),
      ...(payload.tool_response !== undefined
        ? { output: payload.tool_response }
        : {})
    };
    const summary = `Tool result: ${payload.tool_name}`;
    return [
      {
        actor: "tool",
        eventType: "codex_tool_result",
        content: [
          summary,
          payload.tool_input !== undefined
            ? `Input:\n${compactDisplay(payload.tool_input, 800)}`
            : "",
          payload.tool_response !== undefined
            ? `Output:\n${compactDisplay(payload.tool_response, 1200)}`
            : ""
        ]
          .filter(Boolean)
          .join("\n\n"),
        metadata: {
          ...metadata,
          toolName: payload.tool_name,
          ...(payload.tool_use_id ? { toolUseId: payload.tool_use_id } : {}),
          toolSummary: summary,
          toolCall: {
            ...toolCall,
            ...(payload.tool_use_id ? { id: payload.tool_use_id } : {})
          }
        }
      }
    ];
  }

  return [];
};

export const selectCaptureItems = (
  transcriptItems: CaptureItem[],
  payload: HookPayload,
  effectiveContext = effectiveCaptureContext(payload)
): CaptureItem[] => {
  const fallback = fallbackItems(payload, effectiveContext);
  if (transcriptItems.length === 0) {
    return fallback;
  }
  return [
    ...transcriptItems,
    ...fallback.filter((item) => item.actor === "tool")
  ];
};

const statePath = (): string =>
  path.join(os.homedir(), ".koed", "capture-state.json");

const hookBreakerStatePath = (): string =>
  process.env.MEMORY_HOOK_STATE_PATH ??
  path.join(os.homedir(), ".koed", "hook-state.json");

export const emptyHookBreakerState = (): HookBreakerState => ({
  version: 1,
  foregroundFailures: {}
});

const loadHookBreakerState = (): HookBreakerState => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(hookBreakerStatePath(), "utf8")
    ) as Partial<HookBreakerState>;
    return {
      version: 1,
      foregroundFailures: parsed.foregroundFailures ?? {}
    };
  } catch {
    return emptyHookBreakerState();
  }
};

const saveHookBreakerState = (state: HookBreakerState): void => {
  try {
    const file = hookBreakerStatePath();
    const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      tempFile,
      JSON.stringify(
        {
          version: 1,
          foregroundFailures: Object.fromEntries(
            Object.entries(state.foregroundFailures).slice(-500)
          )
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    fs.renameSync(tempFile, file);
  } catch {
    // breaker state is latency protection only; capture must not depend on it
  }
};

export const hookBreakerKey = (
  config: Pick<McpServerConfig, "apiToken" | "apiUrl">
): string =>
  hash({
    apiUrl: config.apiUrl.replace(/\/+$/, ""),
    apiTokenHash: hash(config.apiToken ?? "")
  });

export const hookBreakerEntryIsOpen = (
  entry: HookBreakerEntry | undefined,
  now = Date.now()
): boolean => Boolean(entry?.openedAt && (entry.retryAfter ?? 0) > now);

export const hookBreakerEntryCanRetryHealth = (
  entry: HookBreakerEntry | undefined,
  now = Date.now()
): boolean => Boolean(entry?.openedAt && (entry.retryAfter ?? 0) <= now);

export const recordHookBreakerFailure = (
  state: HookBreakerState,
  key: string,
  error: unknown,
  now = Date.now()
): HookBreakerEntry => {
  const prior = state.foregroundFailures[key];
  const consecutiveFailures = (prior?.consecutiveFailures ?? 0) + 1;
  const opened =
    prior?.openedAt ??
    (consecutiveFailures >= hookBreakerFailureThreshold() ? now : undefined);
  const entry: HookBreakerEntry = {
    consecutiveFailures,
    ...(opened
      ? { openedAt: opened, retryAfter: now + hookBreakerCooldownMs() }
      : {}),
    lastFailureAt: now,
    lastError: error instanceof Error ? error.message : String(error),
    ...(prior?.lastDetachedCatchupAt
      ? { lastDetachedCatchupAt: prior.lastDetachedCatchupAt }
      : {})
  };
  state.foregroundFailures[key] = entry;
  return entry;
};

export const resetHookBreaker = (
  state: HookBreakerState,
  key: string
): void => {
  delete state.foregroundFailures[key];
};

const shouldTriggerBreakerCatchup = (
  entry: HookBreakerEntry | undefined,
  now = Date.now()
): boolean =>
  !entry?.lastDetachedCatchupAt ||
  now - entry.lastDetachedCatchupAt >= hookBreakerCooldownMs();

const markBreakerCatchupTriggered = (
  state: HookBreakerState,
  key: string,
  now = Date.now()
): void => {
  const entry = state.foregroundFailures[key];
  if (entry) {
    entry.lastDetachedCatchupAt = now;
  }
};

const loadState = (): CaptureState => {
  try {
    const state = JSON.parse(
      fs.readFileSync(statePath(), "utf8")
    ) as Partial<CaptureState>;
    return {
      seen: state.seen ?? {},
      rawSeen: state.rawSeen ?? {},
      immediatePrompts: state.immediatePrompts ?? {},
      transcriptOffsets: state.transcriptOffsets ?? {}
    };
  } catch {
    return {
      seen: {},
      rawSeen: {},
      immediatePrompts: {},
      transcriptOffsets: {}
    };
  }
};

const saveState = (state: CaptureState): void => {
  const file = statePath();
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    tempFile,
    JSON.stringify(
      {
        seen: Object.fromEntries(Object.entries(state.seen).slice(-5000)),
        rawSeen: Object.fromEntries(
          Object.entries(state.rawSeen).slice(-20_000)
        ),
        immediatePrompts: Object.fromEntries(
          Object.entries(state.immediatePrompts ?? {}).slice(-5_000)
        ),
        transcriptOffsets: Object.fromEntries(
          Object.entries(state.transcriptOffsets ?? {}).slice(-2_000)
        )
      },
      null,
      2
    ),
    {
      mode: 0o600
    }
  );
  fs.renameSync(tempFile, file);
};

export const stateScopeKey = (
  config: Pick<McpServerConfig, "apiToken" | "apiUrl">,
  workspaceId: string,
  ownerUserId: string
): string =>
  hash({
    apiUrl: config.apiUrl.replace(/\/+$/, ""),
    checkpointSchema: "codex-transcript-v1",
    ownerUserId,
    workspaceId
  });

const scopedStateKey = (scope: string, key: string): string =>
  `${scope}:${key}`;

const scopedRawSeen = (
  rawSeen: Record<string, true>,
  scope: string,
  items: RawConversationItemRequest[]
): Record<string, true> =>
  Object.fromEntries(
    items
      .filter((item) => rawSeen[scopedStateKey(scope, item.sourceHash)])
      .map((item) => [item.sourceHash, true])
  );

const triggerDetachedLocalMemoryProcessing = (configPath?: string): void => {
  if (!hookTriggersLcmSummary()) {
    return;
  }

  const cliPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "cli.js"
  );
  const args = [
    cliPath,
    "process-local-memory",
    ...(configPath ? ["--config", configPath] : []),
    "--limit",
    String(hookLcmSummaryLimit()),
    "--delay-ms",
    String(hookLcmSummaryDelayMs())
  ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
};

const triggerDetachedTranscriptCatchup = (
  configPath: string | undefined,
  payload: HookPayload
): void => {
  if (!hookTriggersTranscriptCatchup()) {
    return;
  }

  const catchupPayload: HookPayload = {
    hook_event_name: payload.hook_event_name,
    session_id: payload.session_id,
    agent_id: payload.agent_id,
    agent_type: payload.agent_type,
    transcript_path: payload.transcript_path,
    agent_transcript_path: payload.agent_transcript_path,
    cwd: payload.cwd,
    model: payload.model
  };
  const scriptPath = fileURLToPath(import.meta.url);
  const args = [
    scriptPath,
    "--catch-up",
    ...(configPath ? ["--config", configPath] : []),
    "--payload-base64",
    Buffer.from(JSON.stringify(catchupPayload), "utf8").toString("base64url")
  ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const catchupLockPath = (input: {
  stateScope: string;
  transcriptPath: string;
}): string =>
  path.join(
    os.homedir(),
    ".koed",
    "capture-catchup-locks",
    `${hash(input)}.lock`
  );

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const acquireCatchupLock = (input: {
  stateScope: string;
  transcriptPath: string;
}): { release: () => void; heartbeat: () => void } | null => {
  const lockPath = catchupLockPath(input);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const tryCreate = (): {
    release: () => void;
    heartbeat: () => void;
  } | null => {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          transcriptPath: input.transcriptPath
        })
      );
      fs.closeSync(fd);
      return {
        release() {
          try {
            fs.rmSync(lockPath, { force: true });
          } catch {
            // best effort cleanup only
          }
        },
        heartbeat() {
          try {
            const now = new Date();
            fs.utimesSync(lockPath, now, now);
          } catch {
            // best effort heartbeat only
          }
        }
      };
    } catch {
      return null;
    }
  };

  const release = tryCreate();
  if (release) {
    return release;
  }

  try {
    const stat = fs.statSync(lockPath);
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: number;
    };
    const staleByAge = Date.now() - stat.mtimeMs > transcriptCatchupLockTtlMs();
    const staleByPid =
      typeof lock.pid === "number" && !processIsAlive(lock.pid);
    if (staleByAge || staleByPid) {
      fs.rmSync(lockPath, { force: true });
      return tryCreate();
    }
  } catch {
    return tryCreate();
  }

  return null;
};

const payloadFromBase64 = (value?: string): HookPayload | null => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as unknown;
    return isRecord(parsed) ? (parsed as HookPayload) : null;
  } catch {
    return null;
  }
};

const capturePassDeadlineAtMs = (mode: "foreground" | "catchup"): number =>
  Date.now() +
  (mode === "catchup" ? transcriptCatchupPassDeadlineMs() : hookDeadlineMs());

export const isRetryableTranscriptCatchupError = (error: unknown): boolean => {
  if (error instanceof MemoryApiError) {
    return (
      error.status === undefined ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  return error instanceof TypeError;
};

export const transcriptCatchupRetryDelayMs = (attempt: number): number => {
  const baseDelay = transcriptCatchupRetryInitialDelayMs();
  const maxDelay = transcriptCatchupRetryMaxDelayMs();
  const exponent = Math.max(0, Math.min(attempt, 8));
  return Math.min(maxDelay, baseDelay * 2 ** exponent);
};

const sleepUntilCatchupStop = async (
  delayMs: number,
  stopAt: number
): Promise<boolean> => {
  const remaining = stopAt - Date.now();
  if (remaining <= 0) {
    return false;
  }
  await sleep(Math.min(delayMs, remaining));
  return Date.now() < stopAt;
};

const runCapturePass = async (input: {
  configPath?: string;
  payload: HookPayload;
  mode: "foreground" | "catchup";
}): Promise<{
  rawItemsStored: number;
  transcriptBacklogRemaining: boolean;
  transcriptCheckpointAdvanced: boolean;
}> => {
  const { configPath, payload, mode } = input;
  const config = loadConfig(configPath);
  if (config.captureEnabled === false) {
    console.error("koed capture hook skipped because capture is paused");
    return {
      rawItemsStored: 0,
      transcriptBacklogRemaining: false,
      transcriptCheckpointAdvanced: false
    };
  }
  if (pausedUntilActive(config.capturePausedUntil)) {
    console.error("koed capture hook skipped because local pause is active");
    return {
      rawItemsStored: 0,
      transcriptBacklogRemaining: false,
      transcriptCheckpointAdvanced: false
    };
  }

  const client = new MemoryApiClient(config);
  const deadlineAtMs = capturePassDeadlineAtMs(mode);
  const workspaceId = payload.cwd ?? "default";
  const access = await client.accessCheck();
  const stateScope = stateScopeKey(config, workspaceId, access.user.id);
  const captureTranscriptPath = captureTranscriptPathForPayload(payload);
  const state = loadState();
  const transcriptFile: TranscriptFileRead = shouldReadTranscriptForHook(
    payload
  )
    ? mode === "foreground"
      ? parseForegroundTranscriptFileRecords({
          transcriptPath: captureTranscriptPath,
          state,
          stateScope
        })
      : {
          ...parseTranscriptFileRecords({
            transcriptPath: captureTranscriptPath,
            state,
            stateScope,
            maxBytes: hookTranscriptTailBytes()
          }),
          backgroundCatchupNeeded: false,
          backlogBytes: 0
        }
    : {
        records: [],
        indexOffset: 0,
        backgroundCatchupNeeded: false,
        backlogBytes: 0
      };
  const transcriptRecords = transcriptFile.records;
  const transcriptSessionMetadata =
    extractTranscriptSessionMetadata(transcriptRecords);
  const effectiveContext = effectiveCaptureContext(
    payload,
    transcriptSessionMetadata
  );
  const policyResponse = (await client.effectiveCapturePolicy({
    projectId: workspaceId,
    threadId: effectiveContext.externalSessionId
  })) as {
    policy?: {
      captureState?: string;
      visibility?: string;
      pauseUntil?: string | null;
      source?: string;
    };
  };
  const policy = policyResponse.policy;
  if (policy?.captureState !== "enabled") {
    console.error(
      `koed capture hook skipped by ${policy?.source ?? "default"} policy`
    );
    return {
      rawItemsStored: 0,
      transcriptBacklogRemaining: false,
      transcriptCheckpointAdvanced: false
    };
  }
  const session =
    effectiveContext.externalSessionId || captureTranscriptPath
      ? await client.createSession({
          externalSessionId: effectiveContext.externalSessionId,
          sourceRuntime: "codex-cli",
          captureMethod: "hook",
          model: payload.model,
          cwd: payload.cwd,
          codexTranscriptPath: captureTranscriptPath,
          metadata: {
            ...contextMetadata(transcriptSessionMetadata),
            ...hookPayloadMetadata(payload, effectiveContext),
            hookEventName: payload.hook_event_name,
            externalSessionId: effectiveContext.externalSessionId,
            model: payload.model,
            cwd: payload.cwd
          },
          idempotencyKey: hash({
            externalSessionId: effectiveContext.externalSessionId,
            transcriptPath: captureTranscriptPath,
            cwd: payload.cwd
          })
        })
      : null;
  if (session?.skipped || (session && !session.session)) {
    console.error(
      "koed capture hook skipped because session policy disabled capture"
    );
    return {
      rawItemsStored: 0,
      transcriptBacklogRemaining: false,
      transcriptCheckpointAdvanced: false
    };
  }

  const rawItemsRequest =
    filterTranscriptItemsAlreadyCapturedFromImmediatePrompts(
      state,
      stateScope,
      selectRawConversationItemsForHook({
        transcriptRecords,
        indexOffset: transcriptFile.indexOffset,
        sessionId: session?.session?.id,
        effectiveContext,
        transcriptPath: captureTranscriptPath,
        payload,
        mode
      })
    );
  const rawItemsToSend = rawItemsForCapture(
    rawItemsRequest,
    scopedRawSeen(state.rawSeen, stateScope, rawItemsRequest),
    new Set()
  );
  const rawItemsResult = await createConversationItemsBatched(
    client,
    rawItemsToSend,
    deadlineAtMs
  );
  const rawItemsResponse = rawItemsResult.items;
  const projectionCompleted =
    rawItemsResponse.length === 0
      ? true
      : await projectConversationItemsBatched(
          client,
          rawItemsResponse,
          deadlineAtMs
        );
  for (const item of rawItemsResponse) {
    state.rawSeen[scopedStateKey(stateScope, item.idempotencyKey)] = true;
  }
  for (const item of rawItemsToSend) {
    rememberImmediatePrompt(state, stateScope, item);
  }
  if (!rawItemsResult.completed) {
    console.error(
      "koed capture hook left transcript checkpoint unchanged because raw capture did not finish before the deadline"
    );
  }
  if (!projectionCompleted) {
    console.error(
      "koed capture hook deferred semantic projection; raw rows will be picked up by catch-up"
    );
  }

  let transcriptCheckpointAdvanced = false;
  if (
    transcriptFile.checkpoint &&
    rawItemsResult.completed &&
    projectionCompleted
  ) {
    state.transcriptOffsets = {
      ...(state.transcriptOffsets ?? {}),
      [transcriptFile.checkpoint.key]: {
        offset: transcriptFile.checkpoint.offset,
        lineCount: transcriptFile.checkpoint.lineCount,
        size: transcriptFile.checkpoint.size
      }
    };
    transcriptCheckpointAdvanced = true;
  } else if (transcriptFile.checkpoint) {
    console.error(
      "koed capture hook left transcript checkpoint unchanged so unread events can retry"
    );
  }
  saveState(state);
  if (rawItemsResponse.length > 0 && mode === "foreground") {
    triggerDetachedLocalMemoryProcessing(configPath);
  }
  if (
    mode === "foreground" &&
    "backgroundCatchupNeeded" in transcriptFile &&
    transcriptFile.backgroundCatchupNeeded
  ) {
    triggerDetachedTranscriptCatchup(configPath, payload);
  }
  console.error(
    `koed capture hook stored ${rawItemsResponse.length} raw conversation item(s)${
      projectionCompleted ? " and projected them" : ""
    }`
  );
  return {
    rawItemsStored: rawItemsResponse.length,
    transcriptBacklogRemaining: Boolean(
      ("backgroundCatchupNeeded" in transcriptFile &&
        transcriptFile.backgroundCatchupNeeded) ||
      (transcriptFile.checkpoint &&
        transcriptFile.checkpoint.offset < transcriptFile.checkpoint.size)
    ),
    transcriptCheckpointAdvanced
  };
};

const captureUnavailableMessage =
  "Koed API unavailable; capture will retry from transcript later. MCP recall may still work once the API is back.";

const maybeTriggerBreakerCatchup = (
  input: {
    configPath?: string;
    payload: HookPayload;
    state: HookBreakerState;
    breakerKey: string;
  },
  now = Date.now()
): void => {
  if (!captureTranscriptPathForPayload(input.payload)) {
    return;
  }
  const entry = input.state.foregroundFailures[input.breakerKey];
  if (!shouldTriggerBreakerCatchup(entry, now)) {
    return;
  }
  triggerDetachedTranscriptCatchup(input.configPath, input.payload);
  markBreakerCatchupTriggered(input.state, input.breakerKey, now);
};

export const runForegroundCapturePass = async (input: {
  configPath?: string;
  payload: HookPayload;
  runPass?: typeof runCapturePass;
  healthCheck?: () => Promise<unknown>;
}): Promise<Awaited<ReturnType<typeof runCapturePass>>> => {
  const { configPath, payload } = input;
  const runPass = input.runPass ?? runCapturePass;
  const config = loadConfig(configPath);
  const breakerKey = hookBreakerKey(config);
  let breakerState = loadHookBreakerState();
  const entry = breakerState.foregroundFailures[breakerKey];

  if (hookBreakerEntryIsOpen(entry)) {
    maybeTriggerBreakerCatchup({
      configPath,
      payload,
      state: breakerState,
      breakerKey
    });
    saveHookBreakerState(breakerState);
    console.error(captureUnavailableMessage);
    return {
      rawItemsStored: 0,
      transcriptBacklogRemaining: Boolean(
        captureTranscriptPathForPayload(payload)
      ),
      transcriptCheckpointAdvanced: false
    };
  }

  if (hookBreakerEntryCanRetryHealth(entry)) {
    const client = new MemoryApiClient(config);
    try {
      await (input.healthCheck ?? (() => client.accessCheck()))();
      resetHookBreaker(breakerState, breakerKey);
      saveHookBreakerState(breakerState);
    } catch (error) {
      if (!isRetryableTranscriptCatchupError(error)) {
        resetHookBreaker(breakerState, breakerKey);
        saveHookBreakerState(breakerState);
        throw error;
      }
      recordHookBreakerFailure(breakerState, breakerKey, error);
      maybeTriggerBreakerCatchup({
        configPath,
        payload,
        state: breakerState,
        breakerKey
      });
      saveHookBreakerState(breakerState);
      console.error(captureUnavailableMessage);
      return {
        rawItemsStored: 0,
        transcriptBacklogRemaining: Boolean(
          captureTranscriptPathForPayload(payload)
        ),
        transcriptCheckpointAdvanced: false
      };
    }
  }

  try {
    const result = await runPass({ configPath, payload, mode: "foreground" });
    breakerState = loadHookBreakerState();
    resetHookBreaker(breakerState, breakerKey);
    saveHookBreakerState(breakerState);
    return result;
  } catch (error) {
    if (isRetryableTranscriptCatchupError(error)) {
      breakerState = loadHookBreakerState();
      const failure = recordHookBreakerFailure(breakerState, breakerKey, error);
      if (failure.openedAt) {
        maybeTriggerBreakerCatchup({
          configPath,
          payload,
          state: breakerState,
          breakerKey
        });
      }
      saveHookBreakerState(breakerState);
    }
    throw error;
  }
};

const runTranscriptCatchup = async (
  configPath: string | undefined,
  payload: HookPayload
): Promise<void> => {
  const config = loadConfig(configPath);
  const client = new MemoryApiClient(config);
  const breakerKey = hookBreakerKey(config);
  const workspaceId = payload.cwd ?? "default";
  const transcriptPath = captureTranscriptPathForPayload(payload);
  if (!transcriptPath) {
    return;
  }
  const stopAt = Date.now() + transcriptCatchupMaxRuntimeMs();
  let access: Awaited<ReturnType<MemoryApiClient["accessCheck"]>> | undefined;
  let accessRetryAttempt = 0;
  while (Date.now() < stopAt) {
    try {
      access = await client.accessCheck();
      const breakerState = loadHookBreakerState();
      resetHookBreaker(breakerState, breakerKey);
      saveHookBreakerState(breakerState);
      break;
    } catch (error) {
      if (!isRetryableTranscriptCatchupError(error)) {
        throw error;
      }
      const delayMs = transcriptCatchupRetryDelayMs(accessRetryAttempt);
      accessRetryAttempt += 1;
      console.error(
        `koed transcript catch-up waiting ${delayMs}ms for memory API to recover: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (!(await sleepUntilCatchupStop(delayMs, stopAt))) {
        return;
      }
    }
  }
  if (!access) {
    return;
  }
  const stateScope = stateScopeKey(config, workspaceId, access.user.id);
  const lock = acquireCatchupLock({ stateScope, transcriptPath });
  if (!lock) {
    return;
  }

  let passRetryAttempt = 0;
  try {
    while (Date.now() < stopAt) {
      lock.heartbeat();
      let result: Awaited<ReturnType<typeof runCapturePass>>;
      try {
        result = await runCapturePass({
          configPath,
          payload,
          mode: "catchup"
        });
        const breakerState = loadHookBreakerState();
        resetHookBreaker(breakerState, breakerKey);
        saveHookBreakerState(breakerState);
        passRetryAttempt = 0;
      } catch (error) {
        if (!isRetryableTranscriptCatchupError(error)) {
          throw error;
        }
        const delayMs = transcriptCatchupRetryDelayMs(passRetryAttempt);
        passRetryAttempt += 1;
        console.error(
          `koed transcript catch-up retrying after transient memory API failure in ${delayMs}ms: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        lock.heartbeat();
        if (!(await sleepUntilCatchupStop(delayMs, stopAt))) {
          break;
        }
        continue;
      }
      if (!result.transcriptBacklogRemaining) {
        break;
      }
      if (!result.transcriptCheckpointAdvanced && result.rawItemsStored === 0) {
        break;
      }
      lock.heartbeat();
      if (!(await sleepUntilCatchupStop(100, stopAt))) {
        break;
      }
    }
  } finally {
    lock.release();
  }
};

const main = async () => {
  const { configPath, catchUp, payloadBase64 } = parseArgs(
    process.argv.slice(2)
  );
  const payload = catchUp
    ? payloadFromBase64(payloadBase64)
    : (JSON.parse((await readStdin()) || "{}") as HookPayload);
  if (!payload) {
    throw new Error("Invalid catch-up payload");
  }

  if (catchUp) {
    await runTranscriptCatchup(configPath, payload);
    return;
  }

  await runForegroundCapturePass({ configPath, payload });
};

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(
      `koed capture hook failed: ${
        error instanceof Error ? error.message : String(error)
      }. Automatic capture may be unavailable; this does not mean the MCP recall server is broken.`
    );
    process.exit(process.env.MEMORY_HOOK_STRICT === "true" ? 1 : 0);
  });
}
