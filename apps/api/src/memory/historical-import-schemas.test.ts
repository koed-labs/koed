import { describe, expect, it } from "vitest";
import {
  createHistoricalImportSourceSchema,
  historicalImportBatchRequestSchema,
  historicalImportBatchSchema,
  historicalImportSourceLookupSchema
} from "./historical-import-schemas.js";

describe("historical import AI Client schemas", () => {
  it("accepts an exact journal artifact identity", () => {
    expect(
      historicalImportSourceLookupSchema.parse({
        artifactId: "00000000-0000-4000-8000-000000000001"
      })
    ).toEqual({ artifactId: "00000000-0000-4000-8000-000000000001" });
    expect(
      createHistoricalImportSourceSchema.parse({
        runId: "00000000-0000-4000-8000-000000000001",
        artifactId: "00000000-0000-4000-8000-000000000002",
        aiClient: "claude"
      })
    ).toMatchObject({ aiClient: "claude" });
  });

  it("rejects legacy provider/session lookup identities", () => {
    expect(() =>
      historicalImportSourceLookupSchema.parse({
        aiClient: "claude",
        sourceKind: "codex",
        sourceSessionId: "session-1"
      })
    ).toThrow();
  });

  it("accepts Claude projection identity in a bounded batch", () => {
    expect(
      historicalImportBatchSchema.parse({
        expectedSourceOffset: 0,
        sourceOffset: 10,
        sourceLine: 1,
        segmentIndex: 0,
        lastVerifiedDigest: "a".repeat(64),
        items: [
          {
            sourceRecordType: "session_message",
            sourceEventType: "user_message",
            sourceSequence: 0,
            rawJson: { type: "user" },
            sourceHash: "source-hash",
            idempotencyKey: "idempotency-key",
            projectionVersion: "claude-code-transcript-v1",
            metadata: { transcriptItemDiscriminator: "main:item:0" }
          }
        ]
      }).items[0]?.projectionVersion
    ).toBe("claude-code-transcript-v1");
  });
  const journalRange = {
    kind: "journal_range",
    expectedSourceOffset: 10,
    sourceOffset: 30,
    segmentIndex: 2,
    lastVerifiedDigest: "a".repeat(64)
  };

  it("accepts a journal range batch that names only the range", () => {
    expect(historicalImportBatchRequestSchema.parse(journalRange)).toEqual(
      journalRange
    );
  });

  it("rejects a journal range batch that carries client-built state", () => {
    for (const extra of [
      { items: [] },
      { sourceLine: 1 },
      { parserState: { currentTurnId: "turn-1" } },
      { sourceOffset: journalRange.expectedSourceOffset }
    ]) {
      expect(() =>
        historicalImportBatchRequestSchema.parse({ ...journalRange, ...extra })
      ).toThrow();
    }
  });

  it("keeps accepting item batches through the request union", () => {
    const parsed = historicalImportBatchRequestSchema.parse({
      expectedSourceOffset: 0,
      sourceOffset: 10,
      sourceLine: 1,
      segmentIndex: 0,
      lastVerifiedDigest: "a".repeat(64),
      items: []
    });
    expect("items" in parsed && parsed.items).toEqual([]);
    expect(() =>
      historicalImportBatchRequestSchema.parse({
        kind: "unknown_kind",
        expectedSourceOffset: 0,
        sourceOffset: 10,
        sourceLine: 1,
        segmentIndex: 0,
        lastVerifiedDigest: "a".repeat(64),
        items: []
      })
    ).toThrow();
  });
});
