import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseClaudeTranscriptJournalBytes } from "../src/claude-transcript-parser.js";

describe("Claude transcript parser", () => {
  it("preserves known blocks and unknown records with deterministic identity", () => {
    const sessionId = randomUUID();
    const userId = randomUUID();
    const assistantId = randomUUID();
    const bytes = Buffer.from(
      [
        {
          type: "user",
          uuid: userId,
          timestamp: "2026-08-11T12:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "Hi" }] }
        },
        {
          type: "assistant",
          uuid: assistantId,
          parentUuid: userId,
          timestamp: "2026-08-11T12:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello" },
              { type: "tool_use", id: "tool-1", name: "Read", input: {} }
            ]
          }
        },
        { type: "future-provider-record", opaque: { retained: true } }
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n"
    );

    const first = parseClaudeTranscriptJournalBytes({
      bytes,
      absoluteStartOffset: 0,
      lineIndexOffset: 0,
      sessionId,
      externalSessionId: sessionId,
      sourceFingerprint: "a".repeat(64)
    });
    const replay = parseClaudeTranscriptJournalBytes({
      bytes,
      absoluteStartOffset: 0,
      lineIndexOffset: 0,
      sessionId,
      externalSessionId: sessionId,
      sourceFingerprint: "a".repeat(64)
    });

    expect(first.items.map((item) => item.sourceEventType)).toEqual([
      "user_message",
      "agent_message",
      "tool_call",
      "unknown"
    ]);
    expect(first.items.map((item) => item.idempotencyKey)).toEqual(
      replay.items.map((item) => item.idempotencyKey)
    );
    expect(first.items.map((item) => item.observationComponent)).toEqual([
      "message",
      "message",
      "tool_call",
      "unknown"
    ]);
    expect(first.items[0]?.canonicalStableItemId).toBe(`main:${userId}:0`);
    expect(first.items.at(-1)?.rawJson).toMatchObject({
      sourceRecord: {
        type: "future-provider-record",
        opaque: { retained: true }
      }
    });
    expect(first.checkpoint).toEqual({ offset: bytes.length, lineCount: 3 });
  });

  it("retains task notifications as raw-only provider records without exposing transport metadata", () => {
    const sessionId = randomUUID();
    const taskNotification = [
      "<task-notification>",
      "<task-id>task-1</task-id>",
      "<tool-use-id>tool-1</tool-use-id>",
      "<output-file>/private/tmp/claude/tasks/task-1.output</output-file>",
      "<status>completed</status>",
      "<summary>Checked the repository</summary>",
      "</task-notification>"
    ].join(" ");
    const bytes = Buffer.from(
      `${JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        timestamp: "2026-08-11T12:00:00.000Z",
        userType: "external",
        promptSource: "sdk",
        origin: { kind: "task-notification" },
        message: { role: "user", content: taskNotification }
      })}\n`
    );

    const result = parseClaudeTranscriptJournalBytes({
      bytes,
      absoluteStartOffset: 0,
      lineIndexOffset: 0,
      sessionId,
      externalSessionId: sessionId,
      sourceFingerprint: "a".repeat(64)
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceEventType: "unknown",
      observationComponent: "unknown",
      metadata: {
        actor: "system",
        transcriptType: "unknown"
      }
    });
    expect(result.items[0]?.rawText).toBeUndefined();
    expect(result.items[0]?.rawJson).toMatchObject({
      sourceRecord: {
        origin: { kind: "task-notification" },
        message: { content: taskNotification }
      }
    });
    expect(result.parserState.currentTurnId).toBe(
      `session:${sessionId}:preamble`
    );
  });

  it("holds incomplete trailing source records", () => {
    expect(() =>
      parseClaudeTranscriptJournalBytes({
        bytes: Buffer.from('{"type":"user"}'),
        absoluteStartOffset: 0,
        lineIndexOffset: 0,
        sessionId: randomUUID(),
        externalSessionId: randomUUID(),
        sourceFingerprint: "a".repeat(64)
      })
    ).toThrow("claude_transcript_segment_incomplete");
  });

  it("marks explicit history separately from live transcript capture", () => {
    const sessionId = randomUUID();
    const bytes = Buffer.from(
      `${JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        timestamp: "2026-08-11T12:00:00.000Z",
        message: { role: "user", content: "Historical prompt" }
      })}\n`
    );
    const result = parseClaudeTranscriptJournalBytes({
      bytes,
      absoluteStartOffset: 0,
      lineIndexOffset: 0,
      sessionId,
      externalSessionId: sessionId,
      sourceFingerprint: "a".repeat(64),
      sourceTransport: "historical_import"
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceKind: "claude-code",
      sourceAdapterVersion: "claude-code-transcript-v1",
      sourceTransport: "historical_import",
      projectionVersion: "claude-code-transcript-v1"
    });
  });
});
