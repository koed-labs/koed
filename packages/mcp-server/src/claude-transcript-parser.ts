import { createHash } from "node:crypto";
import { canonicalConversationItemKey } from "@koed/shared";
import type { RawConversationItemRequest } from "./conversation-source-types.js";

type JsonRecord = Record<string, unknown>;

export interface ClaudeTranscriptParserState extends Record<string, unknown> {
  currentTurnId?: string;
}

export interface ClaudeTranscriptParseResult {
  items: RawConversationItemRequest[];
  checkpoint: { offset: number; lineCount: number };
  parserState: ClaudeTranscriptParserState;
}

const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const text = (block: JsonRecord): string => {
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const nestedText = record(entry).text;
      return typeof nestedText === "string" ? nestedText : "";
    })
    .filter(Boolean)
    .join("\n");
};

const eventTime = (entry: JsonRecord): string | undefined =>
  typeof entry.timestamp === "string" &&
  Number.isFinite(Date.parse(entry.timestamp))
    ? new Date(entry.timestamp).toISOString()
    : undefined;

export const parseClaudeTranscriptJournalBytes = (input: {
  bytes: Uint8Array;
  absoluteStartOffset: number;
  lineIndexOffset: number;
  sessionId: string;
  externalSessionId: string;
  sourceFingerprint: string;
  sourceComponentId?: string;
  prior?: ClaudeTranscriptParserState;
  sourceTransport?: "transcript" | "historical_import";
}): ClaudeTranscriptParseResult => {
  const bytes = Buffer.from(input.bytes);
  if (bytes.length > 0 && bytes.at(-1) !== 0x0a) {
    throw new Error("claude_transcript_segment_incomplete");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = source.length === 0 ? [] : source.split("\n").slice(0, -1);
  let currentTurnId =
    input.prior?.currentTurnId ?? `session:${input.externalSessionId}:preamble`;
  const items: RawConversationItemRequest[] = [];
  const sourceComponentId = input.sourceComponentId ?? "main";
  lines.forEach((line, localLineIndex) => {
    if (!line.trim()) throw new Error("claude_transcript_empty_record");
    let entry: JsonRecord;
    try {
      entry = record(JSON.parse(line));
    } catch {
      throw new Error("claude_transcript_malformed_record");
    }
    const lineIndex = input.lineIndexOffset + localLineIndex;
    const uuid =
      typeof entry.uuid === "string" && entry.uuid.length > 0
        ? entry.uuid
        : `line:${lineIndex}`;
    const type = typeof entry.type === "string" ? entry.type : "unknown";
    const message = record(entry.message);
    const role = typeof message.role === "string" ? message.role : type;
    const content: unknown[] = Array.isArray(message.content)
      ? (message.content as unknown[])
      : message.content === undefined
        ? []
        : [message.content];
    const isProviderInternal =
      type === "queue-operation" ||
      record(entry.origin).kind === "task-notification";
    const isHumanUser =
      !isProviderInternal &&
      type === "user" &&
      content.some((block) => record(block).type !== "tool_result");
    if (isHumanUser) currentTurnId = uuid;
    const isSubagent =
      entry.isSidechain === true ||
      typeof entry.agentId === "string" ||
      typeof entry.parentAgentId === "string";
    const blocks = content.length > 0 ? content : [entry];
    blocks.forEach((rawBlock, blockIndex) => {
      const block = record(rawBlock);
      const blockType =
        typeof block.type === "string"
          ? block.type
          : type === "system"
            ? "system"
            : "unknown";
      let actor: "user" | "assistant" | "subagent" | "tool" | "system" =
        role === "user"
          ? "user"
          : role === "assistant"
            ? isSubagent
              ? "subagent"
              : "assistant"
            : "system";
      let transcriptType =
        actor === "user"
          ? "user_message"
          : actor === "assistant"
            ? "agent_message"
            : actor === "subagent"
              ? "subagent_message"
              : "unknown";
      let rawText = text(block);
      if (isProviderInternal) {
        actor = "system";
        transcriptType = "unknown";
        rawText = "";
      } else if (blockType === "tool_use") {
        actor = "tool";
        transcriptType = "tool_call";
        const toolName =
          typeof block.name === "string" && block.name.trim()
            ? block.name
            : "tool";
        rawText = `Tool call: ${toolName}\n\nInput: ${JSON.stringify(block.input ?? {})}`;
      } else if (blockType === "tool_result") {
        actor = "tool";
        transcriptType = "tool_result";
        rawText ||= "Tool completed without text output.";
      } else if (
        blockType === "thinking" ||
        blockType === "redacted_thinking"
      ) {
        actor = isSubagent ? "subagent" : "assistant";
        transcriptType = "agent_reasoning";
      } else if (type === "system") {
        actor = "system";
        transcriptType = "system_message";
        rawText = typeof entry.content === "string" ? entry.content : "";
      }
      const component =
        transcriptType === "tool_call" || transcriptType === "tool_result"
          ? transcriptType
          : transcriptType === "agent_reasoning"
            ? "reasoning"
            : transcriptType === "unknown"
              ? "unknown"
              : "message";
      const stableItemId = `${sourceComponentId}:${uuid}:${blockIndex}`;
      const rawJson = {
        type: "claude_session_message",
        ...(blockIndex === 0
          ? { sourceRecord: entry }
          : { sourceRecordReference: uuid }),
        contentBlock: rawBlock
      };
      items.push({
        sourceKind: "claude-code",
        sourceAdapterVersion: "claude-code-transcript-v1",
        sourceTransport: input.sourceTransport ?? "transcript",
        sessionId: input.sessionId,
        externalSessionId: input.externalSessionId,
        externalThreadId: input.externalSessionId,
        externalTurnId: currentTurnId,
        externalItemId: stableItemId,
        canonicalStableItemId: stableItemId,
        sourceRecordType: "session_message",
        sourceEventType: transcriptType,
        sourceLineNumber: lineIndex,
        sourceSequence: lineIndex * 1_000 + blockIndex,
        eventTime: eventTime(entry),
        observedAt: eventTime(entry),
        rawJson,
        ...(rawText ? { rawText } : {}),
        sourceHash: sha256(rawJson),
        idempotencyKey: `claude-code-transcript:${input.externalSessionId}:${sourceComponentId}:${stableItemId}`,
        canonicalItemKey: canonicalConversationItemKey({
          provider: "claude-code",
          externalThreadId: input.externalSessionId,
          externalTurnId: currentTurnId,
          stableItemId,
          component
        }),
        observationKind: "reconciliation",
        observationComponent: component,
        projectionStatus: "pending",
        projectionVersion: "claude-code-transcript-v1",
        metadata: {
          actor,
          transcriptType,
          transcriptItemDiscriminator: stableItemId,
          sourceRuntime: "claude-code",
          sourceFingerprint: input.sourceFingerprint,
          sourceComponentId
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
    parserState: { currentTurnId }
  };
};
