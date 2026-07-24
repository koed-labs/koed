import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adaptCodexTranscriptV1,
  codexTranscriptRecordHash,
  legacyCodexTranscriptItemKey,
  type CodexTranscriptObservation
} from "../src/codex-transcript-adapter.js";
import {
  buildCodexTranscriptConversationItems,
  parseTranscriptFileRecords,
  type CodexTranscriptCheckpointState
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
  it("exposes append-safe checkpoint reads for future transcript tailers", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-transcript-parser-")
    );
    const transcriptPath = path.join(directory, "session.jsonl");
    const first = `${JSON.stringify(record)}\n`;
    const second = `${JSON.stringify({
      ...record,
      timestamp: "2026-07-01T12:00:01.000Z",
      payload: { type: "agent_message", message: "Captured from append" }
    })}\n`;
    fs.writeFileSync(transcriptPath, first);
    const initialSize = Buffer.byteLength(first);
    fs.appendFileSync(transcriptPath, second);
    const state: CodexTranscriptCheckpointState = {
      seen: {},
      rawSeen: {},
      transcriptOffsets: {
        [`watcher:${transcriptPath}`]: {
          offset: initialSize,
          lineCount: 1,
          size: initialSize
        }
      }
    };

    try {
      const result = parseTranscriptFileRecords({
        transcriptPath,
        state,
        stateScope: "watcher"
      });

      expect(result.records).toHaveLength(1);
      expect(JSON.stringify(result.records[0])).toContain(
        "Captured from append"
      );
      expect(result.checkpoint).toMatchObject({
        offset: Buffer.byteLength(first + second),
        lineCount: 2,
        size: Buffer.byteLength(first + second)
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps canonical identity transport and path independent", () => {
    const common = {
      observations: [observation],
      sourceSessionId: "session-1",
      threadKind: "conversation" as const
    };
    const hook = adaptCodexTranscriptV1({
      ...common,
      sourceTransport: "hook",
      localSourcePath: "/Users/alice/.codex/session.jsonl"
    })[0]!;
    const imported = adaptCodexTranscriptV1({
      ...common,
      sourceTransport: "historical_import",
      localSourcePath: "/Users/bob/moved/session.jsonl",
      sourceFingerprint: "a".repeat(64)
    })[0]!;
    const watched = adaptCodexTranscriptV1({
      ...common,
      sourceTransport: "transcript",
      localSourcePath: "/Users/alice/.codex/session.jsonl"
    })[0]!;

    expect(imported.idempotencyKey).toBe(hook.idempotencyKey);
    expect(watched.idempotencyKey).toBe(hook.idempotencyKey);
    expect(imported.sourceHash).toBe(hook.sourceHash);
    expect(watched.sourceHash).toBe(hook.sourceHash);
    expect(imported.sourceHash).toHaveLength(64);
    expect(imported.metadata).toMatchObject({
      transcriptItemDiscriminator: "primary:codex_transcript_user"
    });
    expect(codexTranscriptRecordHash(record)).toHaveLength(64);
    expect(imported.sourcePath).toBeUndefined();
    expect(hook.sourcePath).toBe("/Users/alice/.codex/session.jsonl");
    expect(watched.sourcePath).toBe("/Users/alice/.codex/session.jsonl");
    expect(imported.metadata).toMatchObject({
      transcriptByteOffset: 512,
      transcriptItemDiscriminator: "primary:codex_transcript_user",
      sourceFingerprint: "a".repeat(64)
    });
  });

  it("emits the exact path-bound v1 identity as a migration alias", () => {
    const item = adaptCodexTranscriptV1({
      observations: [observation],
      sourceSessionId: "session-1",
      sourceTransport: "hook",
      localSourcePath: "/Users/alice/.codex/session.jsonl",
      threadKind: "conversation"
    })[0]!;

    expect(item.legacyIdempotencyKeys).toEqual([
      legacyCodexTranscriptItemKey({
        sourceSessionId: "session-1",
        transcriptPath: "/Users/alice/.codex/session.jsonl",
        sourcePosition: 512,
        sourceRecordType: "event_msg",
        sourceEventType: "user_message"
      })
    ]);
  });

  it("uses one parser and adapter path for Hook and historical observations", () => {
    const common = {
      records: [record],
      sourceSessionId: "session-parser-parity",
      threadKind: "conversation" as const
    };
    const hook = buildCodexTranscriptConversationItems({
      ...common,
      sourceTransport: "hook",
      localSourcePath: "/Users/alice/.codex/session.jsonl",
      hookEventName: "Stop"
    });
    const imported = buildCodexTranscriptConversationItems({
      ...common,
      sourceTransport: "historical_import",
      localSourcePath: "/Users/alice/.codex/session.jsonl",
      sourceFingerprint: "b".repeat(64)
    });

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      idempotencyKey: hook[0]?.idempotencyKey,
      sourceHash: hook[0]?.sourceHash,
      rawText: hook[0]?.rawText,
      sourcePath: undefined,
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
      sourceTransport: "hook",
      localSourcePath: "/private/first/session.jsonl"
    });
    const moved = buildCodexTranscriptConversationItems({
      ...common,
      sourceTransport: "transcript",
      localSourcePath: "/private/moved/session.jsonl"
    });
    const imported = buildCodexTranscriptConversationItems({
      ...common,
      sourceTransport: "historical_import",
      localSourcePath: "/private/import/session.jsonl"
    });

    expect(moved.map((item) => item.idempotencyKey)).toEqual(
      first.map((item) => item.idempotencyKey)
    );
    expect(imported.map((item) => item.idempotencyKey)).toEqual(
      first.map((item) => item.idempotencyKey)
    );
    expect(moved.map((item) => item.externalTurnId)).toEqual(
      first.map((item) => item.externalTurnId)
    );
    expect(imported.map((item) => item.externalTurnId)).toEqual(
      first.map((item) => item.externalTurnId)
    );
    expect(first.every((item) => item.metadata.observedViaHook === true)).toBe(
      true
    );
    expect(
      moved.every(
        (item) =>
          item.metadata.observedViaTranscript === true &&
          item.metadata.observedViaHook === undefined
      )
    ).toBe(true);
    expect(
      imported.every(
        (item) => item.metadata.observedViaHistoricalImport === true
      )
    ).toBe(true);
  });
});
