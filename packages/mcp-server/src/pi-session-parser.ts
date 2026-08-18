import { createHash } from "node:crypto";
import { canonicalConversationItemKey } from "@koed/shared";
import type { RawConversationItemRequest } from "./conversation-source-types.js";

type JsonRecord = Record<string, unknown>;
export interface PiSessionParserState extends Record<string, unknown> {
  version?: number;
  sessionId?: string;
  cwd?: string;
  model?: string;
}
export interface PiSessionParseResult {
  items: RawConversationItemRequest[];
  checkpoint: { offset: number; lineCount: number };
  parserState: PiSessionParserState;
}
const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const timestamp = (
  entry: JsonRecord,
  message?: JsonRecord
): string | undefined => {
  const candidate = message?.timestamp ?? entry.timestamp;
  const millis =
    typeof candidate === "number"
      ? candidate
      : typeof candidate === "string"
        ? Date.parse(candidate)
        : NaN;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
};
const contentText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    const item = record(value);
    return typeof item.text === "string"
      ? item.text
      : typeof item.thinking === "string"
        ? item.thinking
        : "";
  }
  return value.map(contentText).filter(Boolean).join("\n");
};

export const parsePiSessionJournalBytes = (input: {
  bytes: Uint8Array;
  absoluteStartOffset: number;
  lineIndexOffset: number;
  sessionId: string;
  externalSessionId: string;
  sourceFingerprint: string;
  prior?: PiSessionParserState;
  sourceTransport?: "transcript" | "historical_import";
}): PiSessionParseResult => {
  const bytes = Buffer.from(input.bytes);
  if (bytes.length > 0 && bytes.at(-1) !== 0x0a)
    throw new Error("pi_session_segment_incomplete");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = source.length === 0 ? [] : source.split("\n").slice(0, -1);
  const state: PiSessionParserState = { ...(input.prior ?? {}) };
  const items: RawConversationItemRequest[] = [];
  lines.forEach((line, localIndex) => {
    if (!line.trim()) throw new Error("pi_session_empty_record");
    let entry: JsonRecord;
    try {
      entry = record(JSON.parse(line));
    } catch {
      throw new Error("pi_session_malformed_record");
    }
    const lineIndex = input.lineIndexOffset + localIndex;
    const type = typeof entry.type === "string" ? entry.type : "unknown";
    if (type === "session") {
      if (entry.version !== 3)
        throw new Error(
          `pi_session_version_unsupported:${String(entry.version)}`
        );
      if (typeof entry.id !== "string" || entry.id !== input.externalSessionId)
        throw new Error("pi_session_identity_mismatch");
      state.version = 3;
      state.sessionId = entry.id;
      if (typeof entry.cwd === "string") state.cwd = entry.cwd;
    }
    if (
      type === "model_change" &&
      typeof entry.provider === "string" &&
      typeof entry.modelId === "string"
    )
      state.model = `${entry.provider}/${entry.modelId}`;
    const message = record(entry.message);
    const role = typeof message.role === "string" ? message.role : "system";
    const blocks: unknown[] =
      type === "message" && Array.isArray(message.content)
        ? (message.content as unknown[])
        : type === "message"
          ? [message.content]
          : [entry];
    blocks.forEach((rawBlock, blockIndex) => {
      const block = record(rawBlock);
      const entryId =
        typeof entry.id === "string" && entry.id
          ? entry.id
          : `line:${lineIndex}`;
      const stableItemId = `${entryId}:${blockIndex}`;
      let actor: "user" | "assistant" | "tool" | "system" = "system";
      let transcriptType = "unknown";
      let rawText = "";
      let component = "unknown";
      let projectionStatus: "pending" | "raw_only" = "raw_only";
      if (type === "message" && role === "user") {
        actor = "user";
        transcriptType = "user_message";
        rawText = contentText(rawBlock);
        component = "message";
        projectionStatus = "pending";
      } else if (
        type === "message" &&
        role === "assistant" &&
        block.type === "text"
      ) {
        actor = "assistant";
        transcriptType = "agent_message";
        rawText = typeof block.text === "string" ? block.text : "";
        component = "message";
        projectionStatus = "pending";
      } else if (
        type === "message" &&
        role === "assistant" &&
        block.type === "toolCall"
      ) {
        actor = "tool";
        transcriptType = "tool_call";
        const toolName = typeof block.name === "string" ? block.name : "tool";
        rawText = `Tool call: ${toolName}\n\nInput: ${JSON.stringify(block.arguments ?? {})}`;
        component = "tool_call";
        projectionStatus = "pending";
      } else if (type === "message" && role === "toolResult") {
        actor = "tool";
        transcriptType = "tool_result";
        rawText =
          contentText(message.content) || "Tool completed without text output.";
        component = "tool_result";
        projectionStatus = "pending";
      } else if (type === "message" && role === "bashExecution") {
        actor = "tool";
        transcriptType = "bash_execution";
        const command =
          typeof message.command === "string" ? message.command : "";
        const output = typeof message.output === "string" ? message.output : "";
        rawText = `Command: ${command}\n\n${output}`;
        component = "tool_result";
        projectionStatus = "pending";
      } else if (
        type === "compaction" ||
        type === "branch_summary" ||
        role === "compactionSummary" ||
        role === "branchSummary"
      ) {
        transcriptType = type;
        component = "summary";
      } else if (
        type === "message" &&
        role === "assistant" &&
        block.type === "thinking"
      ) {
        actor = "assistant";
        transcriptType = "agent_reasoning";
        rawText = typeof block.thinking === "string" ? block.thinking : "";
        component = "reasoning";
      }
      const rawJson = {
        type: "pi_session_record",
        ...(blockIndex === 0
          ? { sourceRecord: entry }
          : { sourceRecordReference: entryId }),
        contentBlock: rawBlock
      };
      const parentId =
        typeof entry.parentId === "string" ? entry.parentId : undefined;
      const provider =
        typeof message.provider === "string" ? message.provider : undefined;
      const model =
        typeof message.model === "string" ? message.model : undefined;
      items.push({
        sourceKind: "pi",
        sourceAdapterVersion: "pi-session-v1",
        sourceTransport: input.sourceTransport ?? "transcript",
        sessionId: input.sessionId,
        externalSessionId: input.externalSessionId,
        externalThreadId: input.externalSessionId,
        externalTurnId: parentId ?? entryId,
        externalItemId: stableItemId,
        parentExternalItemId: parentId,
        canonicalStableItemId: stableItemId,
        sourceRecordType: type,
        sourceEventType: transcriptType,
        sourceLineNumber: lineIndex,
        sourceSequence: lineIndex * 1_000 + blockIndex,
        eventTime: timestamp(entry, message),
        observedAt: timestamp(entry, message),
        rawJson,
        ...(rawText ? { rawText } : {}),
        sourceHash: hash(rawJson),
        idempotencyKey: `pi-session:${input.externalSessionId}:${stableItemId}`,
        ...(projectionStatus === "pending"
          ? {
              canonicalItemKey: canonicalConversationItemKey({
                provider: "pi",
                externalThreadId: input.externalSessionId,
                externalTurnId: parentId ?? entryId,
                stableItemId,
                component
              })
            }
          : {}),
        observationKind: "reconciliation",
        observationComponent: component,
        projectionStatus,
        projectionVersion: "pi-session-v1",
        metadata: {
          actor,
          transcriptType,
          transcriptItemDiscriminator: stableItemId,
          sourceRuntime: "pi",
          sourceFingerprint: input.sourceFingerprint,
          piEntryId: entryId,
          piParentEntryId: parentId ?? null,
          appendPosition: lineIndex,
          modelIdentity:
            provider && model ? `${provider}/${model}` : state.model,
          projectId: state.cwd
        }
      });
    });
  });
  return {
    items,
    checkpoint: {
      offset: input.absoluteStartOffset + bytes.length,
      lineCount: input.lineIndexOffset + lines.length
    },
    parserState: state
  };
};
