#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chunkTextForModel } from "@koed/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
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
  transcriptOffsets?: Record<
    string,
    {
      offset: number;
      lineCount: number;
      size: number;
    }
  >;
}

type CaptureHookConfig = McpServerConfig & {
  baseUrl?: string;
  captureEnabled?: boolean;
  capturePausedUntil?: string | null;
};

const parseArgs = (args: string[]): { configPath?: string } => {
  const parsed: { configPath?: string } = {};

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--config") {
      parsed.configPath = args[index + 1];
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

const loadConfig = (configPath?: string): CaptureHookConfig => {
  const envConfig = defaultConfig();

  if (!configPath) {
    return envConfig;
  }

  const fileConfig = JSON.parse(
    fs.readFileSync(expandHome(configPath), "utf8")
  ) as Partial<CaptureHookConfig>;

  return {
    apiUrl: fileConfig.apiUrl ?? fileConfig.baseUrl ?? envConfig.apiUrl,
    apiToken: fileConfig.apiToken ?? envConfig.apiToken,
    requestTimeoutMs: fileConfig.requestTimeoutMs ?? envConfig.requestTimeoutMs,
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

const positiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const QWEN_OPERATIONAL_MAX_TOKENS = 32_000;

const positiveIntEnvCapped = (
  name: string,
  fallback: number,
  max: number
): number => Math.min(positiveIntEnv(name, fallback), max);

const hookTranscriptTailBytes = (): number =>
  positiveIntEnv("MEMORY_HOOK_TRANSCRIPT_TAIL_BYTES", 1_000_000);

const hookDeadlineMs = (): number =>
  positiveIntEnv("MEMORY_HOOK_DEADLINE_MS", 8_500);

const rawIngestBatchBytes = (): number =>
  positiveIntEnv("MEMORY_RAW_INGEST_BATCH_BYTES", 180_000);

const semanticEventMaxTokens = (): number =>
  positiveIntEnvCapped(
    "MEMORY_EVENT_MAX_TOKENS",
    positiveIntEnvCapped(
      "EMBEDDING_MAX_TOKENS",
      QWEN_OPERATIONAL_MAX_TOKENS,
      QWEN_OPERATIONAL_MAX_TOKENS
    ),
    QWEN_OPERATIONAL_MAX_TOKENS
  );

export const semanticEventChunks = (
  item: CaptureItem,
  model: string | undefined
): Array<{ content: string; chunkIndex: number; chunkCount: number }> => {
  const chunks = chunkTextForModel(item.content, {
    model: model ?? "gpt-5.4-mini",
    maxTokens: semanticEventMaxTokens()
  });
  const effectiveChunks = chunks.length > 0 ? chunks : [item.content];
  return effectiveChunks.map((content, index) => ({
    content,
    chunkIndex: index,
    chunkCount: effectiveChunks.length
  }));
};

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

const hookTriggersLcmSummary = (): boolean =>
  (process.env.MEMORY_HOOK_TRIGGER_LCM_SUMMARY ?? "true")
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

export const parseTranscriptRecords = (
  records: unknown[],
  indexOffset = 0
): CaptureItem[] => {
  if (records.length === 0) {
    return [];
  }

  const preferEventMessages = records.some((record) => {
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

export const parseTranscriptText = (text: string): CaptureItem[] =>
  parseTranscriptRecords(parseTranscriptRecordsText(text));

export const shouldReadTranscriptForHook = (payload: HookPayload): boolean =>
  payload.hook_event_name === "PostToolUse" ||
  payload.hook_event_name === "Stop" ||
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

export const parseTranscriptFileRecords = (input: {
  transcriptPath?: string;
  state: CaptureState;
  stateScope: string;
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
  const maxBytes = hookTranscriptTailBytes();
  const hasUsableCheckpoint = Boolean(prior && prior.size <= stat.size);
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
    records: parseTranscriptRecordsText(lines.join("\n")),
    indexOffset,
    checkpoint: {
      key,
      offset: start + consumedBytes,
      lineCount: indexOffset + lines.length,
      size: stat.size
    }
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
}): string => hash(input);

const buildRawTranscriptConversationItems = (input: {
  records: unknown[];
  indexOffset?: number;
  sessionId?: string;
  effectiveContext: EffectiveCaptureContext;
  transcriptPath?: string;
  payload: HookPayload;
}): RawConversationItemRequest[] =>
  input.records.map((record, index) => {
    const sourceSequence = index + (input.indexOffset ?? 0);
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
      rawJson: record,
      rawText: rawText(record),
      sourceHash,
      idempotencyKey: sourceHash,
      projectionStatus: "pending",
      projectionVersion: "codex-transcript-v1",
      metadata: {
        hookEventName: input.payload.hook_event_name,
        threadKind: input.effectiveContext.isSubagent
          ? "subagent"
          : "conversation",
        parentThreadId: input.effectiveContext.parentThreadId
      }
    };
  });

const buildRawHookConversationItem = (input: {
  sessionId?: string;
  effectiveContext: EffectiveCaptureContext;
  payload: HookPayload;
}): RawConversationItemRequest => {
  const sourceHash = hash({
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
    metadata: hookPayloadMetadata(input.payload, input.effectiveContext)
  };
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

const loadState = (): CaptureState => {
  try {
    const state = JSON.parse(
      fs.readFileSync(statePath(), "utf8")
    ) as Partial<CaptureState>;
    return {
      seen: state.seen ?? {},
      rawSeen: state.rawSeen ?? {},
      transcriptOffsets: state.transcriptOffsets ?? {}
    };
  } catch {
    return { seen: {}, rawSeen: {}, transcriptOffsets: {} };
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

const stateScopeKey = (
  config: Pick<McpServerConfig, "apiToken" | "apiUrl">,
  workspaceId: string
): string =>
  hash({
    apiUrl: config.apiUrl,
    apiToken: config.apiToken,
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

const triggerDetachedLcmSummary = (configPath?: string): void => {
  if (!hookTriggersLcmSummary()) {
    return;
  }

  const cliPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "cli.js"
  );
  const args = [
    cliPath,
    "lcm-summarize",
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

const main = async () => {
  const { configPath } = parseArgs(process.argv.slice(2));
  const stdin = await readStdin();
  const payload = JSON.parse(stdin || "{}") as HookPayload;
  const config = loadConfig(configPath);
  if (config.captureEnabled === false) {
    console.error("koed capture hook skipped because capture is paused");
    return;
  }
  if (pausedUntilActive(config.capturePausedUntil)) {
    console.error("koed capture hook skipped because local pause is active");
    return;
  }

  const client = new MemoryApiClient(config);
  const deadlineAtMs = Date.now() + hookDeadlineMs();
  const workspaceId = payload.cwd ?? "default";
  const stateScope = stateScopeKey(config, workspaceId);
  const captureTranscriptPath = captureTranscriptPathForPayload(payload);
  const state = loadState();
  const transcriptFile = shouldReadTranscriptForHook(payload)
    ? parseTranscriptFileRecords({
        transcriptPath: captureTranscriptPath,
        state,
        stateScope
      })
    : { records: [], indexOffset: 0 };
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
    return;
  }
  const transcriptItems = parseTranscriptRecords(
    transcriptRecords,
    transcriptFile.indexOffset
  );
  const captureItems = selectCaptureItems(
    transcriptItems,
    payload,
    effectiveContext
  );
  const requiredRawSourceSequences = new Set(
    captureItems
      .filter((item) => {
        const itemHash = hash({
          session: effectiveContext.externalSessionId,
          transcriptPath: captureTranscriptPath,
          item
        });
        return !state.seen[scopedStateKey(stateScope, itemHash)];
      })
      .map((item) => item.metadata.transcriptIndex)
      .filter((value): value is number => typeof value === "number")
  );
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
    return;
  }

  const rawItemsRequest =
    transcriptRecords.length > 0
      ? buildRawTranscriptConversationItems({
          records: transcriptRecords,
          indexOffset: transcriptFile.indexOffset,
          sessionId: session?.session?.id,
          effectiveContext,
          transcriptPath: captureTranscriptPath,
          payload
        })
      : [
          buildRawHookConversationItem({
            sessionId: session?.session?.id,
            effectiveContext,
            payload
          })
        ];
  const rawItemsToSend = rawItemsForCapture(
    rawItemsRequest,
    scopedRawSeen(state.rawSeen, stateScope, rawItemsRequest),
    requiredRawSourceSequences,
    transcriptRecords.length === 0 && captureItems.length > 0
      ? new Set(rawItemsRequest.map((item) => item.sourceHash))
      : undefined
  );
  const rawItemsResult = await createConversationItemsBatched(
    client,
    rawItemsToSend,
    deadlineAtMs
  );
  const rawItemsResponse = rawItemsResult.items;
  for (const item of rawItemsResponse) {
    state.rawSeen[scopedStateKey(stateScope, item.idempotencyKey)] = true;
  }
  const rawItemIdsBySequence = new Map<number, string[]>();
  for (const item of rawItemsResponse) {
    if (item.sourceSequence !== null) {
      rawItemIdsBySequence.set(item.sourceSequence, [
        ...(rawItemIdsBySequence.get(item.sourceSequence) ?? []),
        item.id
      ]);
    }
  }
  const fallbackRawItemId = rawItemsResponse[0]?.id;

  let captured = 0;
  let completedCaptureItems = rawItemsResult.completed;
  if (!rawItemsResult.completed) {
    console.error(
      "koed capture hook left transcript checkpoint unchanged because raw capture did not finish before the deadline"
    );
  }
  for (const item of captureItems) {
    const rawSourceMetadata = (() => {
      const rawItemIds =
        typeof item.metadata.transcriptIndex === "number"
          ? rawItemIdsBySequence.get(item.metadata.transcriptIndex)
          : undefined;
      if (rawItemIds && rawItemIds.length > 0) {
        return {
          rawConversationItemId: rawItemIds[0],
          rawConversationItemIds: rawItemIds
        };
      }
      return fallbackRawItemId
        ? { rawConversationItemId: fallbackRawItemId }
        : null;
    })();
    if (!rawSourceMetadata) {
      console.error(
        `koed capture hook skipped semantic projection without raw source for ${item.eventType}`
      );
      completedCaptureItems = false;
      break;
    }

    const itemHash = hash({
      session: effectiveContext.externalSessionId,
      transcriptPath: captureTranscriptPath,
      item
    });
    const scopedItemHash = scopedStateKey(stateScope, itemHash);
    if (state.seen[scopedItemHash]) {
      continue;
    }

    try {
      const chunks = semanticEventChunks(item, payload.model);
      for (const chunk of chunks) {
        if (Date.now() > deadlineAtMs - 1_000) {
          throw new Error("Capture hook deadline reached");
        }
        const chunkHash =
          chunks.length === 1
            ? itemHash
            : hash({
                itemHash,
                chunkIndex: chunk.chunkIndex,
                chunkCount: chunk.chunkCount
              });
        await client.capturePersonalEvent({
          workspaceId,
          sessionId: session?.session?.id,
          actor: item.actor,
          eventType: item.eventType,
          content: chunk.content,
          metadata: {
            ...item.metadata,
            ...rawSourceMetadata,
            ...hookPayloadMetadata(payload, effectiveContext),
            hookEventName: payload.hook_event_name,
            externalSessionId: effectiveContext.externalSessionId,
            externalTurnId: payload.turn_id,
            sourceHash: chunkHash,
            sourceItemHash: itemHash,
            sourceChunkIndex: chunk.chunkIndex,
            sourceChunkCount: chunk.chunkCount,
            automaticCaptureScope: "personal"
          },
          sourceRuntime: "codex-cli",
          captureMethod: "hook",
          codexTranscriptPath: captureTranscriptPath,
          idempotencyKey: chunkHash,
          sourceHash: chunkHash
        });
      }
      state.seen[scopedItemHash] = true;
      captured += 1;
    } catch (error) {
      completedCaptureItems = false;
      console.error(
        `koed capture hook stopped after ${captured} event(s): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      break;
    }
  }

  if (transcriptFile.checkpoint && completedCaptureItems) {
    state.transcriptOffsets = {
      ...(state.transcriptOffsets ?? {}),
      [transcriptFile.checkpoint.key]: {
        offset: transcriptFile.checkpoint.offset,
        lineCount: transcriptFile.checkpoint.lineCount,
        size: transcriptFile.checkpoint.size
      }
    };
  } else if (transcriptFile.checkpoint) {
    console.error(
      "koed capture hook left transcript checkpoint unchanged so unread events can retry"
    );
  }
  saveState(state);
  if (captured > 0) {
    triggerDetachedLcmSummary(configPath);
  }
  console.error(`koed capture hook stored ${captured} personal event(s)`);
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
