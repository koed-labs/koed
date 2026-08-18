import { describe, expect, it } from "vitest";
import {
  createHistoricalImportSourceSchema,
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
});
