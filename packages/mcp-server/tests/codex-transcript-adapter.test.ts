import { describe, expect, it } from "vitest";
import {
  adaptCodexTranscriptV1,
  codexTranscriptRecordHash,
  type CodexTranscriptObservation
} from "../src/codex-transcript-adapter.js";
import {
  buildCodexTranscriptConversationItems,
  parseTranscriptJournalBytes
} from "../src/codex-transcript-parser.js";

const record = {
  timestamp: "2026-07-01T12:00:00.000Z",
  type: "event_msg",
  payload: { type: "user_message", message: "Remember transport parity" }
};

const observation: CodexTranscriptObservation = {
  record,
  sourceLineNumber: 7,
  transcriptByteOffset: 512,
  startsTurn: false,
  completesTurn: false,
  sourceRecordType: "event_msg",
  sourceEventType: "user_message",
  eventTime: "2026-07-01T12:00:00.000Z",
  eventTimeAccuracy: "source",
  fallbackRawText: "Remember transport parity",
  parsedItems: [
    {
      itemDiscriminator: "primary:codex_transcript_user",
      sourceOffset: 0,
      item: {
        actor: "user",
        eventType: "codex_transcript_user",
        content: "Remember transport parity",
        metadata: { transcriptType: "user_message" }
      }
    }
  ]
};

describe("codex-transcript-v1 adapter", () => {
  it("parses an appended journal segment from its durable source cursor", () => {
    const first = `${JSON.stringify(record)}\n`;
    const second = `${JSON.stringify({
      ...record,
      timestamp: "2026-07-01T12:00:01.000Z",
      payload: { type: "agent_message", message: "Captured from append" }
    })}\n`;
    const initialSize = Buffer.byteLength(first);
    const result = parseTranscriptJournalBytes({
      bytes: Buffer.from(second),
      absoluteStartOffset: initialSize,
      lineIndexOffset: 1,
      prior: { lastEventTime: record.timestamp }
    });

    expect(result.records).toHaveLength(1);
    expect(JSON.stringify(result.records[0])).toContain("Captured from append");
    expect(result.checkpoint).toMatchObject({
      offset: Buffer.byteLength(first + second),
      lineCount: 2
    });
  });

  it("keeps canonical identity transport and path independent", () => {
    const common = {
      observations: [observation],
      sourceSessionId: "session-1",
      threadKind: "conversation" as const
    };
    const watched = adaptCodexTranscriptV1({
      ...common,
      sourceTransport: "transcript"
    })[0]!;
    const imported = adaptCodexTranscriptV1({
      ...common,
      sourceTransport: "historical_import",
      sourceFingerprint: "a".repeat(64)
    })[0]!;
    expect(imported.idempotencyKey).toBe(watched.idempotencyKey);
    expect(imported.sourceHash).toBe(watched.sourceHash);
    expect(imported.sourceHash).toHaveLength(64);
    expect(imported.metadata).toMatchObject({
      transcriptItemDiscriminator: "primary:codex_transcript_user"
    });
    expect(codexTranscriptRecordHash(record)).toHaveLength(64);
    expect(imported.metadata).toMatchObject({
      transcriptByteOffset: 512,
      transcriptItemDiscriminator: "primary:codex_transcript_user",
      sourceFingerprint: "a".repeat(64)
    });
  });

  it("uses one parser and adapter path for live and historical journals", () => {
    const common = {
      records: [record],
      sourceSessionId: "session-parser-parity",
      threadKind: "conversation" as const
    };
    const watched = buildCodexTranscriptConversationItems({
      ...common,
      sourceTransport: "transcript"
    });
    const imported = buildCodexTranscriptConversationItems({
      ...common,
      sourceTransport: "historical_import",
      sourceFingerprint: "b".repeat(64)
    });

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      idempotencyKey: watched[0]?.idempotencyKey,
      sourceHash: watched[0]?.sourceHash,
      rawText: watched[0]?.rawText,
      metadata: {
        transcriptItemDiscriminator: "primary:codex_transcript_user",
        sourceFingerprint: "b".repeat(64)
      }
    });
  });

  it("uses item discriminator to keep multiple logical rows at one transcript position distinct", () => {
    const items = adaptCodexTranscriptV1({
      observations: [
        {
          ...observation,
          parsedItems: [
            observation.parsedItems[0]!,
            {
              itemDiscriminator: "supporting_context",
              sourceOffset: 1,
              item: {
                actor: "system",
                eventType: "codex_transcript_ide_context",
                content: "IDE context",
                metadata: { transcriptType: "ide_context" }
              }
            }
          ]
        }
      ],
      sourceSessionId: "session-1",
      sourceTransport: "historical_import",
      threadKind: "conversation"
    });

    expect(items).toHaveLength(2);
    expect(items[0]?.idempotencyKey).not.toBe(items[1]?.idempotencyKey);
    expect(items.map((item) => item.sourceSequence)).toEqual([1024, 1025]);
  });

  it("keeps response_item user, assistant, synthetic-turn, and observation identities path independent", () => {
    const records = [
      {
        timestamp: "2026-07-01T12:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Moved transcript" }]
        }
      },
      {
        timestamp: "2026-07-01T12:00:01.000Z",
        type: "response_item",
        payload: {
          id: "assistant-item-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Same canonical answer" }]
        }
      }
    ];
    const common = {
      records,
      sourceSessionId: "response-session-1",
      threadKind: "conversation" as const
    };
    const first = buildCodexTranscriptConversationItems({
      ...common,
      sourceTransport: "transcript"
    });
    const imported = buildCodexTranscriptConversationItems({
      ...common,
      sourceTransport: "historical_import"
    });

    expect(imported.map((item) => item.idempotencyKey)).toEqual(
      first.map((item) => item.idempotencyKey)
    );
    expect(imported.map((item) => item.externalTurnId)).toEqual(
      first.map((item) => item.externalTurnId)
    );
    expect(
      first.every((item) => item.metadata.observedViaTranscript === true)
    ).toBe(true);
    expect(
      imported.every(
        (item) => item.metadata.observedViaHistoricalImport === true
      )
    ).toBe(true);
  });

  it("uses the parsed semantic kind for new provider tool response types", () => {
    const turnId = "turn-provider-tool-search";
    const records = [
      {
        timestamp: "2026-07-01T12:00:00.000Z",
        type: "response_item",
        payload: {
          type: "tool_search_call",
          id: "tool-search-1",
          call_id: "call-tool-search-1",
          status: "completed",
          execution: "client",
          arguments: { query: "find a browser tool" },
          internal_chat_message_metadata_passthrough: { turn_id: turnId }
        }
      },
      {
        timestamp: "2026-07-01T12:00:01.000Z",
        type: "response_item",
        payload: {
          type: "tool_search_output",
          call_id: "call-tool-search-1",
          status: "completed",
          execution: "client",
          tools: [
            {
              type: "namespace",
              name: "mcp__chrome_devtools",
              tools: [{ type: "function", name: "list_pages" }]
            }
          ],
          internal_chat_message_metadata_passthrough: { turn_id: turnId }
        }
      }
    ];

    const items = buildCodexTranscriptConversationItems({
      records,
      sourceSessionId: "response-session-tool-search",
      sessionId: "3c4054a6-51b8-4eb9-9eef-63cc630cfd8a",
      sourceTransport: "transcript",
      threadKind: "conversation",
      preferStableResponseItems: true
    });

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.observationComponent)).toEqual([
      "tool_call",
      "tool_result"
    ]);
    expect(items.every((item) => item.canonicalItemKey)).toBe(true);
  });
});
