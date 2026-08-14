import { createHash } from "node:crypto";
import { splitCodexIdePrompt } from "@koed/core";
import { approvalActivityMetadata } from "@koed/shared";
import { approvalReviewTranscriptDisplayFromText } from "@koed/shared/personal-desktop";
import {
  adaptCodexTranscriptV1,
  type CodexTranscriptObservation
} from "./codex-transcript-adapter.js";
import type { RawConversationItemRequest } from "./conversation-source-types.js";
import { codexCanonicalConversationItemKey } from "./codex-conversation-source-adapter.js";

export interface CaptureItem {
  actor: "user" | "assistant" | "agent" | "subagent" | "tool" | "system";
  eventType: string;
  content: string;
  metadata: Record<string, unknown>;
}

type SourceEventTimeAccuracy =
  | "source"
  | "interpolated_between_sources"
  | "observed_fallback";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asUnknownArray = (value: unknown): unknown[] | null =>
  Array.isArray(value) ? (value as unknown[]) : null;

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const transcriptRecordPositionSymbol = Symbol("koedTranscriptRecordPosition");
const transcriptRecordLineIndexSymbol = Symbol("koedTranscriptRecordLineIndex");
const transcriptInferredEventTimeSymbol = Symbol(
  "koedTranscriptInferredEventTime"
);
const transcriptEventTimeAccuracySymbol = Symbol(
  "koedTranscriptEventTimeAccuracy"
);
const transcriptAssignedTurnIdSymbol = Symbol("koedTranscriptAssignedTurnId");
const transcriptAssistantMessagePreferenceSymbol = Symbol(
  "koedTranscriptAssistantMessagePreference"
);

const attachTranscriptRecordPosition = (
  record: unknown,
  byteOffset: number,
  lineIndex?: number
): unknown => {
  if (record && typeof record === "object") {
    Object.defineProperty(record, transcriptRecordPositionSymbol, {
      value: byteOffset,
      enumerable: false,
      configurable: false
    });
    if (typeof lineIndex === "number") {
      Object.defineProperty(record, transcriptRecordLineIndexSymbol, {
        value: lineIndex,
        enumerable: false,
        configurable: false
      });
    }
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

const transcriptRecordLineIndex = (record: unknown): number | undefined => {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as { [transcriptRecordLineIndexSymbol]?: unknown })[
    transcriptRecordLineIndexSymbol
  ];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
};

const attachTranscriptAssignedTurnId = (
  record: unknown,
  turnId: string | undefined
): void => {
  if (record && typeof record === "object" && turnId) {
    Object.defineProperty(record, transcriptAssignedTurnIdSymbol, {
      value: turnId,
      enumerable: false,
      configurable: false
    });
  }
};

const transcriptAssignedTurnId = (record: unknown): string | undefined => {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as { [transcriptAssignedTurnIdSymbol]?: unknown })[
    transcriptAssignedTurnIdSymbol
  ];
  return typeof value === "string" && value.trim() ? value : undefined;
};

const attachTranscriptAssistantMessagePreference = (
  record: unknown,
  preference: "response_item" | undefined
): void => {
  if (record && typeof record === "object" && preference) {
    Object.defineProperty(record, transcriptAssistantMessagePreferenceSymbol, {
      value: preference,
      enumerable: false,
      configurable: false
    });
  }
};

const transcriptAssistantMessagePreference = (
  record: unknown
): "response_item" | undefined => {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (
    record as { [transcriptAssistantMessagePreferenceSymbol]?: unknown }
  )[transcriptAssistantMessagePreferenceSymbol];
  return value === "response_item" ? value : undefined;
};

const attachTranscriptInferredEventTime = (
  record: unknown,
  eventTime: string,
  accuracy: Exclude<SourceEventTimeAccuracy, "source">
): unknown => {
  if (record && typeof record === "object") {
    Object.defineProperty(record, transcriptInferredEventTimeSymbol, {
      value: eventTime,
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(record, transcriptEventTimeAccuracySymbol, {
      value: accuracy,
      enumerable: false,
      configurable: true
    });
  }
  return record;
};

const safeSourceSequence = (value: number): number =>
  Math.max(0, Math.min(value, 2_000_000_000));

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

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

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
  if (transcriptMetadata.timestamp === undefined) {
    const envelopeTimestamp = recordObjects
      .filter((record) => record.type === "session_meta")
      .map((record) => asString(record.timestamp))
      .find((value): value is string => Boolean(value));
    if (envelopeTimestamp) transcriptMetadata.timestamp = envelopeTimestamp;
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

const parseStructuredToolValue = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return value;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
};

const parseCodexCommandOutput = (value: unknown): unknown => {
  const structured = parseStructuredToolValue(value);
  if (typeof structured !== "string") {
    return structured;
  }
  const match = structured.match(
    /^Chunk ID:\s*(.*?)\r?\nWall time:\s*([0-9.]+)\s*seconds\r?\nProcess exited with code\s*(-?\d+)\r?\nOriginal token count:\s*(\d+)\r?\nOutput:\r?\n([\s\S]*)$/
  );
  if (!match) {
    return structured;
  }
  return {
    output: match[5]!.replace(/\r?\n$/, ""),
    exitCode: Number.parseInt(match[3]!, 10),
    chunkId: match[1]!,
    wallTimeSeconds: Number.parseFloat(match[2]!),
    originalTokenCount: Number.parseInt(match[4]!, 10)
  };
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
  const input = parseStructuredToolValue(item.arguments ?? item.input);
  const output = parseCodexCommandOutput(
    item.output ?? item.content ?? item.result
  );
  const outputRecord = isRecord(output) ? output : null;
  const exitCode = asFiniteNumber(outputRecord?.exitCode);
  const status =
    asString(item.status) ??
    (exitCode === undefined
      ? undefined
      : exitCode === 0
        ? "completed"
        : "failed");
  const error = item.error ?? item.failure;
  const durationMs =
    asFiniteNumber(item.durationMs) ??
    asFiniteNumber(item.duration_ms) ??
    (asFiniteNumber(outputRecord?.wallTimeSeconds) !== undefined
      ? asFiniteNumber(outputRecord?.wallTimeSeconds)! * 1_000
      : undefined);
  const startedAtMs =
    asFiniteNumber(item.startedAtMs) ?? asFiniteNumber(item.started_at_ms);
  const completedAtMs =
    asFiniteNumber(item.completedAtMs) ?? asFiniteNumber(item.completed_at_ms);
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
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
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
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(completedAtMs !== undefined ? { completedAtMs } : {}),
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

const additionalContextContainer = (
  raw: Record<string, unknown>,
  payload: Record<string, unknown> | undefined
): Record<string, unknown> | null => {
  const params =
    payload && isRecord(payload.params) ? payload.params : undefined;
  const item =
    params && isRecord(params.item)
      ? params.item
      : payload && isRecord(payload.item)
        ? payload.item
        : undefined;
  for (const candidate of [
    params?.additionalContext,
    payload?.additionalContext,
    raw.additionalContext,
    item?.additionalContext
  ]) {
    if (isRecord(candidate)) {
      return candidate;
    }
  }
  return null;
};

const additionalContextEntryText = (
  key: string,
  value: unknown
): string | null => {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const text =
    typeof value.value === "string"
      ? value.value
      : typeof value.text === "string"
        ? value.text
        : typeof value.content === "string"
          ? value.content
          : "";
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }
  const kind = asString(value.kind);
  const label = [key, kind].filter(Boolean).join(" ");
  return label ? `${label}\n${normalized}` : normalized;
};

const additionalContextCaptureItem = (
  raw: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
  index: number,
  context: TranscriptContext
): CaptureItem | null => {
  const additionalContext = additionalContextContainer(raw, payload);
  if (!additionalContext) {
    return null;
  }
  const entries = Object.entries(additionalContext)
    .map(([key, value]) => additionalContextEntryText(key, value))
    .filter((value): value is string => Boolean(value));
  const content = entries.join("\n\n").trim();
  if (!content) {
    return null;
  }
  return {
    actor: "system",
    eventType: "codex_transcript_ide_context",
    content,
    metadata: {
      ...contextMetadata(context),
      transcriptIndex: index,
      transcriptType: "ide_context",
      transcriptParentType: raw.type,
      contextKind: "ide_client_context",
      contextSource: "vscode_codex",
      sourceRole: "supporting_context",
      additionalContextSources: Object.keys(additionalContext)
    }
  };
};

const ideClientContextCaptureItemFromText = (
  content: string,
  raw: Record<string, unknown>,
  index: number,
  context: TranscriptContext
): CaptureItem => ({
  actor: "system",
  eventType: "codex_transcript_ide_context",
  content,
  metadata: {
    ...contextMetadata(context),
    transcriptIndex: index,
    transcriptType: "ide_context",
    transcriptParentType: raw.type,
    contextKind: "ide_client_context",
    contextSource: "vscode_codex",
    sourceRole: "supporting_context",
    contextEncoding: "codex_rendered_prompt_wrapper"
  }
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

type ParsedTranscriptItem = {
  item: CaptureItem;
  itemDiscriminator: string;
  sourceOffset: number;
};

const extractPrimaryTranscriptItem = (
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
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .join("\n")
      : "";
    if (!summary) {
      return null;
    }
    return {
      actor: options.context.threadKind === "subagent" ? "subagent" : "agent",
      eventType: "codex_transcript_reasoning_summary",
      content: summary,
      metadata: {
        ...contextMetadata(options.context),
        transcriptIndex: index,
        transcriptType: "reasoning_summary",
        transcriptParentType: raw.type,
        transcriptId: item.id,
        rawReasoningRetainedAsProvenance: Array.isArray(item.content)
      }
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
  const approvalReviewTranscriptDisplay =
    item.type === "user_message"
      ? approvalReviewTranscriptDisplayFromText(content)
      : undefined;

  return {
    actor,
    eventType: `codex_transcript_${actor}`,
    content,
    metadata: {
      ...contextMetadata(options.context),
      transcriptIndex: index,
      transcriptType: item.type,
      transcriptParentType: raw.type,
      transcriptId: item.id,
      ...(approvalReviewTranscriptDisplay
        ? { approvalReviewTranscriptDisplay }
        : {}),
      ...(asString(item.phase) ? { phase: asString(item.phase) } : {})
    }
  };
};

const extractTranscriptItems = (
  record: unknown,
  index: number,
  options: {
    preferEventMessages: boolean;
    preferStableResponseItems?: boolean;
    context: TranscriptContext;
  }
): ParsedTranscriptItem[] => {
  if (!record || typeof record !== "object") {
    return [];
  }

  const raw = isRecord(record) ? record : null;
  if (!raw) {
    return [];
  }
  const payload = isRecord(raw.payload) ? raw.payload : undefined;
  const item = payload ?? raw;
  if (
    options.preferStableResponseItems &&
    raw.type === "event_msg" &&
    ["agent_message", "assistant_message"].includes(asString(item.type) ?? "")
  ) {
    return [];
  }
  if (
    options.preferEventMessages &&
    raw.type === "response_item" &&
    item.type === "message"
  ) {
    return [];
  }

  const items: ParsedTranscriptItem[] = [];
  let contextItem = additionalContextCaptureItem(
    raw,
    payload,
    index,
    options.context
  );
  const primaryItem = extractPrimaryTranscriptItem(record, index, options);
  const renderedPromptSplit =
    primaryItem &&
    (primaryItem.actor === "user" || primaryItem.actor === "agent")
      ? splitCodexIdePrompt(primaryItem.content)
      : null;
  if (!contextItem && renderedPromptSplit) {
    contextItem = ideClientContextCaptureItemFromText(
      renderedPromptSplit.ideContext,
      raw,
      index,
      options.context
    );
  }
  if (contextItem) {
    items.push({
      item: contextItem,
      itemDiscriminator: "supporting_context",
      sourceOffset: 0
    });
  }

  if (primaryItem) {
    items.push({
      item: renderedPromptSplit
        ? { ...primaryItem, content: renderedPromptSplit.userPrompt }
        : primaryItem,
      itemDiscriminator: `primary:${primaryItem.eventType}`,
      sourceOffset: contextItem ? 1 : 0
    });
  }
  return items;
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
  absoluteStartOffset: number,
  lineIndexOffset = 0,
  strictJsonLines = false
): unknown[] => {
  const records: unknown[] = [];
  let relativeOffset = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const lineOffset = absoluteStartOffset + relativeOffset;
    relativeOffset += Buffer.byteLength(`${line}\n`, "utf8");
    if (!line.trim()) {
      continue;
    }
    const absoluteLineIndex = lineIndexOffset + lineIndex;
    try {
      const parsed = JSON.parse(line) as unknown;
      const parsedArray = asUnknownArray(parsed);
      if (parsedArray) {
        for (const item of parsedArray) {
          records.push(
            attachTranscriptRecordPosition(item, lineOffset, absoluteLineIndex)
          );
        }
      } else if (isRecord(parsed) && asUnknownArray(parsed.items)) {
        for (const item of asUnknownArray(parsed.items)!) {
          records.push(
            attachTranscriptRecordPosition(item, lineOffset, absoluteLineIndex)
          );
        }
      } else {
        records.push(
          attachTranscriptRecordPosition(parsed, lineOffset, absoluteLineIndex)
        );
      }
    } catch {
      if (strictJsonLines) {
        throw new Error(
          `Codex transcript contains malformed complete JSONL record at line ${absoluteLineIndex + 1}`
        );
      }
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
    .flatMap((record, index) =>
      extractTranscriptItems(record, index + indexOffset, {
        preferEventMessages,
        context
      }).map((parsed) => parsed.item)
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

const transcriptHasProviderResponseMessage = (records: unknown[]): boolean =>
  records.some((record) => {
    const payload = rawRecordPayload(record);
    return (
      rawRecordType(record) === "response_item" &&
      payload?.type === "message" &&
      payload.role === "assistant" &&
      Boolean(asString(payload.id))
    );
  });

const transcriptIsAssistantEventMessage = (record: unknown): boolean => {
  const payload = rawRecordPayload(record);
  return (
    rawRecordType(record) === "event_msg" &&
    /^(agent_message|assistant_message)$/i.test(asString(payload?.type) ?? "")
  );
};

export const parseTranscriptText = (text: string): CaptureItem[] =>
  parseTranscriptRecords(parseTranscriptRecordsText(text));

const isCompleteTranscriptJsonLine = (line: string): boolean => {
  if (!line.trim()) {
    return false;
  }
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
};

const splitCompleteTranscriptLines = (
  text: string,
  reachedEnd: boolean
): { lines: string[]; consumedBytes: number } => {
  const hasTrailingNewline = /\r?\n$/.test(text);
  const parts = text.split(/\r?\n/);
  let consumedText = text;
  if (hasTrailingNewline) {
    parts.pop();
  } else {
    const trailing = parts.at(-1) ?? "";
    if (!reachedEnd || !isCompleteTranscriptJsonLine(trailing)) {
      parts.pop();
      consumedText = text.slice(0, Math.max(0, text.length - trailing.length));
    }
  }
  const lines = parts.filter((line) => line.trim());
  return {
    lines,
    consumedBytes: Buffer.byteLength(consumedText, "utf8")
  };
};

const transcriptIsUserMessage = (record: unknown): boolean => {
  const payload = rawRecordPayload(record);
  return (
    (rawRecordType(record) === "event_msg" &&
      payload?.type === "user_message") ||
    (rawRecordType(record) === "response_item" &&
      payload?.type === "message" &&
      payload.role === "user")
  );
};

const unresolvedAssistantEventIndex = (
  records: unknown[]
): number | undefined => {
  if (transcriptHasProviderResponseMessage(records)) {
    return undefined;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!transcriptIsAssistantEventMessage(records[index])) {
      continue;
    }
    const suffix = records.slice(index + 1);
    if (
      suffix.some(
        (record) =>
          transcriptRecordCompletesTurn(record) ||
          transcriptIsUserMessage(record)
      )
    ) {
      return undefined;
    }
    return index;
  }
  return undefined;
};

export type TranscriptJournalParserState = {
  lastEventTime?: string;
  activeTurnId?: string;
  assistantMessagePreference?: "response_item";
};

export const parseTranscriptJournalBytes = (input: {
  bytes: Uint8Array;
  absoluteStartOffset: number;
  lineIndexOffset: number;
  prior?: TranscriptJournalParserState;
  deferPageEndingAssistantEvent?: boolean;
}): {
  records: unknown[];
  indexOffset: number;
  checkpoint: {
    offset: number;
    lineCount: number;
    lastEventTime?: string;
    activeTurnId?: string;
    assistantMessagePreference?: "response_item";
  };
} => {
  const text = Buffer.from(input.bytes).toString("utf8");
  const split = splitCompleteTranscriptLines(text, true);
  if (split.consumedBytes !== input.bytes.byteLength) {
    throw new Error("journal_segment_incomplete");
  }
  const parsedRecords = parseTranscriptLineRecords(
    split.lines,
    input.absoluteStartOffset,
    input.lineIndexOffset,
    true
  );
  const priorAssistantMessagePreference =
    input.prior?.assistantMessagePreference;
  const pageHasProviderResponseMessage =
    transcriptHasProviderResponseMessage(parsedRecords);
  const pageEndingAssistantEventIndex =
    input.deferPageEndingAssistantEvent === true &&
    !priorAssistantMessagePreference &&
    !pageHasProviderResponseMessage
      ? unresolvedAssistantEventIndex(parsedRecords)
      : undefined;
  const recordsForResolution =
    pageEndingAssistantEventIndex === undefined
      ? parsedRecords
      : parsedRecords.slice(0, pageEndingAssistantEventIndex);
  const resolvedRecords = resolveTranscriptRecordEventTimes({
    records: recordsForResolution,
    previousEventTime: input.prior?.lastEventTime
  });
  const records = resolvedRecords.records;
  const assistantMessagePreference =
    priorAssistantMessagePreference ??
    (pageHasProviderResponseMessage ? "response_item" : undefined);
  let activeTurnId = input.prior?.activeTurnId;
  for (const record of records) {
    const explicitTurnId = transcriptTurnId(record);
    if (explicitTurnId && transcriptRecordStartsTurn(record)) {
      activeTurnId = explicitTurnId;
    }
    attachTranscriptAssignedTurnId(record, explicitTurnId ?? activeTurnId);
    attachTranscriptAssistantMessagePreference(
      record,
      assistantMessagePreference
    );
    if (
      explicitTurnId &&
      transcriptRecordCompletesTurn(record) &&
      activeTurnId === explicitTurnId
    ) {
      activeTurnId = undefined;
    }
  }
  const heldRecord =
    pageEndingAssistantEventIndex !== undefined
      ? parsedRecords[pageEndingAssistantEventIndex]
      : resolvedRecords.holdFromIndex === undefined
        ? undefined
        : recordsForResolution[resolvedRecords.holdFromIndex];
  const offset =
    heldRecord === undefined
      ? input.absoluteStartOffset + split.consumedBytes
      : (transcriptRecordPosition(heldRecord) ?? input.absoluteStartOffset);
  const lineCount =
    heldRecord === undefined
      ? input.lineIndexOffset + split.lines.length
      : (transcriptRecordLineIndex(heldRecord) ?? input.lineIndexOffset);
  return {
    records,
    indexOffset: input.lineIndexOffset,
    checkpoint: {
      offset,
      lineCount,
      ...(resolvedRecords.lastEventTime
        ? { lastEventTime: resolvedRecords.lastEventTime }
        : input.prior?.lastEventTime
          ? { lastEventTime: input.prior.lastEventTime }
          : {}),
      ...(activeTurnId ? { activeTurnId } : {}),
      ...(assistantMessagePreference ? { assistantMessagePreference } : {})
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

const transcriptTurnId = (record: unknown): string | undefined => {
  if (!isRecord(record)) {
    return undefined;
  }
  const payload = isRecord(record.payload) ? record.payload : undefined;
  const internalMetadata = isRecord(
    payload?.internal_chat_message_metadata_passthrough
  )
    ? payload.internal_chat_message_metadata_passthrough
    : undefined;
  return (
    asString(payload?.turn_id) ??
    asString(payload?.turnId) ??
    asString(internalMetadata?.turn_id) ??
    asString(internalMetadata?.turnId) ??
    asString(record.turn_id) ??
    asString(record.turnId)
  );
};

const transcriptRecordStartsTurn = (record: unknown): boolean => {
  const eventType = rawEventType(record);
  return eventType === "task_started" || eventType === "turn_context";
};

const transcriptRecordCompletesTurn = (record: unknown): boolean => {
  const eventType = rawEventType(record);
  return (
    eventType === "task_complete" ||
    eventType === "turn/completed" ||
    eventType === "turn_aborted"
  );
};

const semanticTurnIdForUserPrompt = (input: {
  externalSessionId?: string;
  sourceSequence: number;
}): string =>
  `transcript-user-turn:${hash({
    externalSessionId: input.externalSessionId,
    sourceSequence: input.sourceSequence
  })}`;

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

const inferredRawEventTime = (record: unknown): string | undefined => {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const value = (record as { [transcriptInferredEventTimeSymbol]?: unknown })[
    transcriptInferredEventTimeSymbol
  ];
  return typeof value === "string" && value.trim() ? value : undefined;
};

const effectiveRawEventTime = (record: unknown): string | undefined =>
  rawEventTime(record) ?? inferredRawEventTime(record);

const rawEventTimeAccuracy = (record: unknown): SourceEventTimeAccuracy => {
  if (rawEventTime(record)) {
    return "source";
  }
  if (!record || typeof record !== "object") {
    return "observed_fallback";
  }
  const value = (record as { [transcriptEventTimeAccuracySymbol]?: unknown })[
    transcriptEventTimeAccuracySymbol
  ];
  return value === "interpolated_between_sources" ||
    value === "observed_fallback"
    ? value
    : "observed_fallback";
};

const interpolateTimestamp = (
  previousMs: number,
  nextMs: number,
  index: number,
  count: number
): string => {
  const span = nextMs - previousMs;
  if (span > count) {
    return new Date(
      previousMs + Math.max(1, Math.floor((span * (index + 1)) / (count + 1)))
    ).toISOString();
  }
  return new Date(previousMs + index + 1).toISOString();
};

const sourceTimestampMs = (record: unknown): number | null => {
  const eventTime = rawEventTime(record);
  if (!eventTime) {
    return null;
  }
  const parsed = Date.parse(eventTime);
  return Number.isNaN(parsed) ? null : parsed;
};

const resolveTranscriptRecordEventTimes = (input: {
  records: unknown[];
  previousEventTime?: string;
}): {
  records: unknown[];
  holdFromIndex?: number;
  lastEventTime?: string;
} => {
  let previousMs =
    input.previousEventTime &&
    !Number.isNaN(Date.parse(input.previousEventTime))
      ? Date.parse(input.previousEventTime)
      : null;
  let lastEventTime = input.previousEventTime;
  let index = 0;

  while (index < input.records.length) {
    const sourceMs = sourceTimestampMs(input.records[index]);
    if (sourceMs !== null) {
      previousMs = sourceMs;
      lastEventTime = new Date(sourceMs).toISOString();
      index += 1;
      continue;
    }

    const missingStart = index;
    while (
      index < input.records.length &&
      sourceTimestampMs(input.records[index]) === null
    ) {
      index += 1;
    }
    const missingEnd = index;
    const nextMs =
      index < input.records.length
        ? sourceTimestampMs(input.records[index])
        : null;

    if (previousMs === null) {
      if (nextMs === null) {
        return {
          records: input.records.slice(0, missingStart),
          holdFromIndex: missingStart,
          lastEventTime
        };
      }
      const count = missingEnd - missingStart;
      for (let offset = 0; offset < count; offset += 1) {
        attachTranscriptInferredEventTime(
          input.records[missingStart + offset],
          new Date(nextMs - count + offset).toISOString(),
          "interpolated_between_sources"
        );
      }
      lastEventTime = new Date(nextMs - 1).toISOString();
      continue;
    }

    if (nextMs === null) {
      return {
        records: input.records.slice(0, missingStart),
        holdFromIndex: missingStart,
        lastEventTime
      };
    }

    const count = missingEnd - missingStart;
    for (let offset = 0; offset < count; offset += 1) {
      const interpolated = interpolateTimestamp(
        previousMs,
        nextMs,
        offset,
        count
      );
      attachTranscriptInferredEventTime(
        input.records[missingStart + offset],
        interpolated,
        "interpolated_between_sources"
      );
      lastEventTime = interpolated;
    }
  }

  return { records: input.records, lastEventTime };
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

const rawClientUserMessageId = (record: unknown): string | undefined => {
  const payload = rawRecordPayload(record);
  return asString(payload?.client_id) ?? asString(payload?.clientId);
};

const responseItemStableId = (record: unknown): string | undefined => {
  if (rawRecordType(record) !== "response_item") {
    return undefined;
  }
  const payload = rawRecordPayload(record);
  const type = asString(payload?.type);
  if (type === "message" && payload?.role === "user") {
    return rawClientUserMessageId(record);
  }
  if (
    type === "function_call" ||
    type === "custom_tool_call" ||
    type === "tool_search_call" ||
    type === "function_call_output" ||
    type === "custom_tool_call_output" ||
    type === "tool_search_output"
  ) {
    return asString(payload?.call_id) ?? asString(payload?.callId);
  }
  return (
    asString(payload?.id) ??
    asString(payload?.item_id) ??
    asString(payload?.itemId)
  );
};

const responseItemCanonicalComponent = (
  record: unknown
): string | undefined => {
  if (rawRecordType(record) !== "response_item") {
    return undefined;
  }
  switch (rawEventType(record)) {
    case "function_call":
    case "custom_tool_call":
    case "tool_search_call":
      return "tool_call";
    case "function_call_output":
    case "custom_tool_call_output":
    case "tool_search_output":
      return "tool_result";
    case "reasoning":
      return "reasoning_summary";
    case "message":
      return "message";
    default:
      return "raw";
  }
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

export interface CodexTranscriptRecordsInput {
  records: unknown[];
  indexOffset?: number;
  sessionId?: string;
  sourceSessionId?: string;
  sourceTransport: "transcript" | "historical_import";
  sourceFingerprint?: string;
  threadKind: "conversation" | "subagent";
  parentThreadId?: string;
  preferStableResponseItems?: boolean;
}

export const buildCodexTranscriptConversationItems = (
  input: CodexTranscriptRecordsInput
): RawConversationItemRequest[] => {
  const preferProviderResponseItems =
    input.preferStableResponseItems ||
    input.records.some(
      (record) =>
        transcriptAssistantMessagePreference(record) === "response_item"
    ) ||
    transcriptHasProviderResponseMessage(input.records);
  const preferEventMessages =
    !preferProviderResponseItems &&
    transcriptPrefersEventMessages(input.records);
  const transcriptContext = extractTranscriptSessionMetadata(input.records);
  const context: TranscriptContext = {
    ...transcriptContext,
    threadKind: input.threadKind,
    ...(input.sourceSessionId
      ? { transcriptSessionId: input.sourceSessionId }
      : {})
  };

  const observations: CodexTranscriptObservation[] = input.records.map(
    (record, index) => {
      const sourceLineNumber =
        transcriptRecordLineIndex(record) ?? index + (input.indexOffset ?? 0);
      return {
        record,
        sourceLineNumber,
        transcriptByteOffset: transcriptRecordPosition(record),
        explicitTurnId:
          transcriptAssignedTurnId(record) ?? transcriptTurnId(record),
        startsTurn: transcriptRecordStartsTurn(record),
        completesTurn: transcriptRecordCompletesTurn(record),
        externalItemId: rawExternalItemId(record),
        sourceRecordType: rawRecordType(record),
        sourceEventType: rawEventType(record),
        eventTime: effectiveRawEventTime(record),
        eventTimeAccuracy: rawEventTimeAccuracy(record),
        fallbackRawText: rawText(record),
        parsedItems: extractTranscriptItems(record, sourceLineNumber, {
          preferEventMessages,
          preferStableResponseItems: preferProviderResponseItems,
          context
        })
      };
    }
  );
  const approvalReview =
    input.threadKind === "subagent" &&
    observations.some((observation) =>
      observation.parsedItems.some(
        (parsedItem) =>
          parsedItem.item?.metadata.approvalReviewTranscriptDisplay !==
          undefined
      )
    );
  const adaptedItems = adaptCodexTranscriptV1({
    observations,
    sessionId: input.sessionId,
    sourceSessionId: input.sourceSessionId,
    sourceTransport: input.sourceTransport,
    sourceFingerprint: input.sourceFingerprint,
    threadKind: input.threadKind,
    parentThreadId: input.parentThreadId,
    approvalReview
  });
  if (!preferProviderResponseItems) return adaptedItems;

  const items: RawConversationItemRequest[] = [];
  let activeTranscriptTurnId: string | undefined;
  let activeSemanticTurnId: string | undefined;

  for (const [index, record] of input.records.entries()) {
    const sourceLineNumber =
      transcriptRecordLineIndex(record) ?? index + (input.indexOffset ?? 0);
    const transcriptByteOffset = transcriptRecordPosition(record);
    const sourceSequenceBase = safeSourceSequence(
      (transcriptByteOffset ?? sourceLineNumber) * 2
    );
    const explicitTurnId = transcriptTurnId(record);
    if (explicitTurnId && transcriptRecordStartsTurn(record)) {
      activeTranscriptTurnId = explicitTurnId;
      activeSemanticTurnId = explicitTurnId;
    }
    const parsedItems = extractTranscriptItems(record, sourceLineNumber, {
      preferEventMessages,
      preferStableResponseItems: preferProviderResponseItems,
      context
    });
    const hasLogicalUserPrompt = parsedItems.some(
      (parsedItem) => parsedItem.item.actor === "user"
    );
    const rawItems =
      parsedItems.length > 0
        ? parsedItems
        : [
            {
              item: null,
              itemDiscriminator: "raw",
              sourceOffset: 0
            }
          ];
    if (hasLogicalUserPrompt && !explicitTurnId && !activeTranscriptTurnId) {
      activeSemanticTurnId = semanticTurnIdForUserPrompt({
        externalSessionId: input.sourceSessionId,
        sourceSequence: sourceSequenceBase
      });
    }
    const providerTurnId =
      transcriptAssignedTurnId(record) ??
      explicitTurnId ??
      activeTranscriptTurnId;
    const assignedTurnId = providerTurnId ?? activeSemanticTurnId;

    for (const parsedItem of rawItems) {
      const sourceSequence = safeSourceSequence(
        sourceSequenceBase + parsedItem.sourceOffset
      );
      const adaptedItem = adaptedItems.find(
        (candidate) => candidate.sourceSequence === sourceSequence
      );
      if (!adaptedItem) {
        throw new Error("Shared transcript adapter omitted a response item");
      }
      const sourceHash = adaptedItem.sourceHash;
      const sourceIdempotencyKey = adaptedItem.idempotencyKey;
      const transcriptType = asString(parsedItem.item?.metadata.transcriptType);
      const managedTurnComplete =
        input.preferStableResponseItems &&
        transcriptRecordCompletesTurn(record) &&
        assignedTurnId !== undefined;
      const toolCall = isRecord(parsedItem.item?.metadata.toolCall)
        ? parsedItem.item.metadata.toolCall
        : undefined;
      const toolKind = asString(toolCall?.kind);
      const stableItemId = (() => {
        if (managedTurnComplete) {
          return `turn:${assignedTurnId}:completed`;
        }
        const responseStableId = responseItemStableId(record);
        if (responseStableId) {
          return responseStableId;
        }
        if (!input.preferStableResponseItems || !parsedItem.item) {
          return undefined;
        }
        if (parsedItem.item.actor === "user") {
          return rawClientUserMessageId(record);
        }
        if (parsedItem.item.actor === "tool") {
          return (
            asString(parsedItem.item.metadata.toolCallId) ??
            asString(parsedItem.item.metadata.callId) ??
            rawExternalItemId(record)
          );
        }
        return rawExternalItemId(record);
      })();
      const canonicalComponent =
        (managedTurnComplete ? "control" : undefined) ??
        responseItemCanonicalComponent(record) ??
        (parsedItem.item?.actor === "tool"
          ? toolKind === "output"
            ? "tool_result"
            : "tool_call"
          : /reasoning/i.test(transcriptType ?? "")
            ? "reasoning_summary"
            : "message");
      const canonicalThreadId =
        input.sourceSessionId ?? context.transcriptSessionId;
      const canonicalItemKey =
        (rawRecordType(record) === "response_item" ||
          (input.preferStableResponseItems && parsedItem.item) ||
          managedTurnComplete) &&
        canonicalThreadId &&
        providerTurnId &&
        stableItemId
          ? codexCanonicalConversationItemKey({
              externalThreadId: canonicalThreadId,
              externalTurnId: providerTurnId,
              stableItemId,
              component: canonicalComponent
            })
          : undefined;
      const requiresExactManagedIdentity =
        parsedItem.item &&
        ["user", "agent", "assistant", "subagent", "tool"].includes(
          parsedItem.item.actor
        );
      const ambiguousResponseUserObservation =
        rawRecordPayload(record)?.role === "user" &&
        !canonicalItemKey &&
        rawRecordType(record) === "response_item";
      const duplicateEventMessageObservation =
        preferProviderResponseItems &&
        !canonicalItemKey &&
        rawRecordType(record) === "event_msg" &&
        /^(agent_message|assistant_message)$/i.test(rawEventType(record) ?? "");
      if (
        input.preferStableResponseItems &&
        requiresExactManagedIdentity &&
        !canonicalItemKey &&
        !ambiguousResponseUserObservation
      ) {
        throw new Error(
          `Managed transcript reconciliation could not establish exact identity for ${transcriptType ?? parsedItem.item.eventType}`
        );
      }
      const unlinkedObservation = duplicateEventMessageObservation;
      items.push({
        sessionId: input.sessionId,
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        sourceTransport: input.sourceTransport,
        externalSessionId: input.sourceSessionId,
        externalThreadId: canonicalThreadId,
        externalTurnId: assignedTurnId,
        externalItemId: rawExternalItemId(record),
        sourceRecordType: rawRecordType(record),
        sourceEventType: rawEventType(record),
        sourceLineNumber,
        sourceSequence,
        eventTime: effectiveRawEventTime(record),
        rawJson: record,
        rawText: parsedItem.item?.content ?? rawText(record),
        sourceHash,
        idempotencyKey: sourceIdempotencyKey,
        ...(unlinkedObservation ? { observationOnly: true } : {}),
        ...(canonicalItemKey ? { canonicalItemKey } : {}),
        ...(canonicalItemKey && stableItemId
          ? { canonicalStableItemId: stableItemId }
          : {}),
        ...(canonicalItemKey ? { observationKind: "reconciliation" } : {}),
        ...(canonicalItemKey
          ? { observationComponent: canonicalComponent }
          : {}),
        projectionStatus:
          unlinkedObservation || ambiguousResponseUserObservation
            ? "raw_only"
            : "pending",
        projectionVersion: "codex-transcript-v1",
        metadata: approvalActivityMetadata({
          actor: parsedItem.item?.actor,
          content: parsedItem.item?.content,
          metadata: {
            ...(parsedItem.item?.metadata ?? {}),
            ...(transcriptByteOffset === undefined
              ? {}
              : { transcriptByteOffset }),
            transcriptSourceLineNumber: sourceLineNumber,
            ...(canonicalItemKey
              ? {
                  canonicalIdentityBasis: "provider_ids",
                  ...(input.preferStableResponseItems
                    ? { managedConversationReconciliation: true }
                    : {})
                }
              : {}),
            ...(managedTurnComplete
              ? { semanticControl: "turn_completed" }
              : {}),
            ...(ambiguousResponseUserObservation
              ? {
                  managedConversationSourceRole:
                    "ambiguous_user_context_provenance",
                  projectionPolicyKey: "managed_context_user",
                  projectionActor: "system"
                }
              : {}),
            ...(duplicateEventMessageObservation &&
            input.preferStableResponseItems
              ? { managedConversationSourceRole: "duplicate_representation" }
              : {}),
            sourceEventTimeAccuracy: rawEventTimeAccuracy(record),
            ...(assignedTurnId
              ? { transcriptAssignedTurnId: assignedTurnId }
              : {}),
            threadKind: input.threadKind,
            parentThreadId: input.parentThreadId,
            ...(approvalReview ? { approvalReview: true } : {}),
            ...(input.sourceTransport === "historical_import"
              ? { observedViaHistoricalImport: true }
              : { observedViaTranscript: true }),
            ...(input.sourceFingerprint
              ? { sourceFingerprint: input.sourceFingerprint }
              : {})
          }
        })
      });
    }

    if (
      explicitTurnId &&
      transcriptRecordCompletesTurn(record) &&
      activeTranscriptTurnId === explicitTurnId
    ) {
      activeTranscriptTurnId = undefined;
      activeSemanticTurnId = undefined;
    }
  }

  return items;
};
