import { createHash } from "node:crypto";

import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { canonicalConversationItemKey } from "@koed/shared";

import type { RawConversationItemRequest } from "./conversation-source-types.js";
import type { ClaudeTranscriptWatcherSignal } from "./claude-transcript-watcher-signal.js";

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const blockText = (block: Record<string, unknown>): string => {
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof record(entry).text === "string"
            ? String(record(entry).text)
            : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

type AdaptedBlock = {
  actor: "user" | "assistant" | "subagent" | "tool" | "system";
  transcriptType: string;
  component: string;
  text: string;
  raw: unknown;
};

const messageActor = (
  message: SessionMessage
): "user" | "assistant" | "subagent" | "system" =>
  message.type === "assistant" &&
  (message.parent_agent_id || message.parent_tool_use_id)
    ? "subagent"
    : message.type;

const messageTranscriptType = (message: SessionMessage): string => {
  const actor = messageActor(message);
  return actor === "assistant"
    ? "agent_message"
    : actor === "subagent"
      ? "subagent_message"
      : actor === "user"
        ? "user_message"
        : "system_message";
};

const adaptedBlocks = (message: SessionMessage): AdaptedBlock[] => {
  const envelope = record(message.message);
  const content = envelope.content;
  const blocks = Array.isArray(content) ? content : [content ?? envelope];
  return blocks.flatMap((rawBlock): AdaptedBlock[] => {
    if (typeof rawBlock === "string") {
      return [
        {
          actor: messageActor(message),
          transcriptType: messageTranscriptType(message),
          component: "message",
          text: rawBlock,
          raw: rawBlock
        }
      ];
    }
    const block = record(rawBlock);
    const type = typeof block.type === "string" ? block.type : "text";
    if (type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool";
      return [
        {
          actor: "tool",
          transcriptType: "tool_call",
          component: "tool_call",
          text: `Tool call: ${name}\n\nInput: ${JSON.stringify(block.input ?? {})}`,
          raw: block
        }
      ];
    }
    if (type === "tool_result") {
      return [
        {
          actor: "tool",
          transcriptType: "tool_result",
          component: "tool_result",
          text: blockText(block) || "Tool completed without text output.",
          raw: block
        }
      ];
    }
    if (type === "thinking" || type === "redacted_thinking") {
      return [
        {
          actor: messageActor(message),
          transcriptType: "agent_reasoning",
          component: "reasoning",
          text: blockText(block),
          raw: block
        }
      ];
    }
    const text = blockText(block);
    if (!text.trim()) return [];
    return [
      {
        actor: messageActor(message),
        transcriptType: messageTranscriptType(message),
        component: "message",
        text,
        raw: block
      }
    ];
  });
};

export const isHumanUserMessage = (message: SessionMessage): boolean =>
  message.type === "user" &&
  adaptedBlocks(message).some((block) => block.actor === "user");

const canonicalKey = (input: {
  sessionId: string;
  turnId: string;
  stableItemId: string;
  component: string;
}) =>
  canonicalConversationItemKey({
    provider: "claude-code",
    externalThreadId: input.sessionId,
    externalTurnId: input.turnId,
    stableItemId: input.stableItemId,
    component: input.component
  });

export const turnBoundaryControl = (input: {
  signal: ClaudeTranscriptWatcherSignal;
  capturedSessionId: string;
  externalTurnId: string;
  frontierOffset: number;
  frontierLine: number;
  sourceSequence: number;
}): RawConversationItemRequest => {
  const stableItemId = `turn:${input.externalTurnId}:completed`;
  const eventTime = input.signal.observedAt ?? new Date().toISOString();
  const rawJson = {
    type: "hook_signal",
    payload: {
      type: "turn_completed",
      sourceFrontierOffset: input.frontierOffset,
      sourceFrontierLine: input.frontierLine
    }
  };
  return {
    sourceKind: "claude-code",
    sourceAdapterVersion: "claude-code-hook-signal-v1",
    sourceTransport: "hook_signal",
    sessionId: input.capturedSessionId,
    externalSessionId: input.signal.sourceSessionId,
    externalThreadId: input.signal.sourceSessionId,
    externalTurnId: input.externalTurnId,
    externalItemId: stableItemId,
    canonicalStableItemId: stableItemId,
    sourceRecordType: "hook_signal",
    sourceEventType: "turn_completed",
    sourceSequence: input.sourceSequence,
    eventTime,
    observedAt: eventTime,
    rawJson,
    sourceHash: hash({
      provider: "claude-code",
      sessionId: input.signal.sourceSessionId,
      externalTurnId: input.externalTurnId,
      frontierOffset: input.frontierOffset,
      frontierLine: input.frontierLine
    }),
    idempotencyKey: `claude-code-hook-turn-boundary:${input.signal.sourceSessionId}:${input.externalTurnId}`,
    canonicalItemKey: canonicalKey({
      sessionId: input.signal.sourceSessionId,
      turnId: input.externalTurnId,
      stableItemId,
      component: "control"
    }),
    observationKind: "control",
    observationComponent: "control",
    projectionStatus: "pending",
    projectionVersion: "claude-code-hook-signal-v1",
    metadata: {
      sourceEventTimeAccuracy: "source",
      semanticControl: "turn_completed",
      sourceRuntime: "claude-code"
    }
  };
};

export const adaptMessages = (input: {
  messages: SessionMessage[];
  sessionId: string;
  capturedSessionId: string;
  cwd: string;
  timestamps: Map<string, string>;
  observedAt: string;
  minimumMessageIndex: number;
  activationTime?: number;
  componentId: string;
}): RawConversationItemRequest[] => {
  let currentTurnId = `session:${input.sessionId}:preamble`;
  const items: RawConversationItemRequest[] = [];
  input.messages.forEach((message, messageIndex) => {
    if (isHumanUserMessage(message)) currentTurnId = message.uuid;
    const sourceTimestamp = input.timestamps.get(message.uuid);
    if (messageIndex < input.minimumMessageIndex) return;
    if (!sourceTimestamp) {
      throw new Error(`claude_source_timestamp_missing:${message.uuid}`);
    }
    if (
      input.activationTime !== undefined &&
      Date.parse(sourceTimestamp) < input.activationTime
    ) {
      return;
    }
    const eventTime = sourceTimestamp;
    adaptedBlocks(message).forEach((block, blockIndex) => {
      const stableItemId = `${input.componentId}:${message.uuid}:${blockIndex}`;
      const key = canonicalKey({
        sessionId: input.sessionId,
        turnId: currentTurnId,
        stableItemId,
        component: block.component
      });
      const rawJson = {
        type: "claude_session_message",
        messageType: message.type,
        messageUuid: message.uuid,
        parentToolUseId: message.parent_tool_use_id,
        parentAgentId: message.parent_agent_id,
        contentBlock: block.raw,
        timestamp: eventTime
      };
      items.push({
        sourceKind: "claude-code",
        sourceAdapterVersion: "claude-code-transcript-v1",
        sourceTransport: "transcript",
        sessionId: input.capturedSessionId,
        externalSessionId: input.sessionId,
        externalThreadId: input.sessionId,
        externalTurnId: currentTurnId,
        externalItemId: stableItemId,
        canonicalStableItemId: stableItemId,
        sourceRecordType: "session_message",
        sourceEventType: block.transcriptType,
        sourceSequence: messageIndex * 1_000 + blockIndex,
        eventTime,
        observedAt: input.observedAt,
        rawJson,
        rawText: block.text,
        sourceHash: hash(rawJson),
        idempotencyKey: `claude-code-transcript:${input.sessionId}:${input.componentId}:${stableItemId}`,
        canonicalItemKey: key,
        observationKind: "reconciliation",
        observationComponent: block.component,
        projectionStatus: "pending",
        projectionVersion: "claude-code-transcript-v1",
        metadata: {
          actor: block.actor,
          transcriptType: block.transcriptType,
          sourceRuntime: "claude-code",
          sourceComponentId: input.componentId,
          cwd: input.cwd
        }
      });
    });
  });
  return items;
};
