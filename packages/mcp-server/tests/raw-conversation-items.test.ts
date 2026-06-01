import { describe, expect, it } from "vitest";
import { rawConversationItemBatches } from "../src/raw-conversation-items.js";

const requestBytes = (items: Record<string, unknown>[]): number =>
  Buffer.byteLength(JSON.stringify({ items }), "utf8");

describe("raw conversation item batching", () => {
  it("splits escaped oversized raw items into byte-safe reconstructable chunks", () => {
    const previousLimit = process.env.MEMORY_RAW_INGEST_BATCH_BYTES;
    process.env.MEMORY_RAW_INGEST_BATCH_BYTES = "1400";
    try {
      const rawJson = {
        payload: '"quoted" \\\\ backslash \\n newline 😀 '.repeat(600)
      };
      const rawText = "visible text 😀 ".repeat(200);
      const item = {
        sourceKind: "codex",
        sourceAdapterVersion: "codex-app-server-v1",
        sourceTransport: "app_server",
        sourceRecordType: "app_server_notification",
        sourceEventType: "item/completed",
        sourceSequence: 42,
        rawJson,
        rawText,
        sourceHash: "oversized-source",
        idempotencyKey: "oversized-source",
        projectionStatus: "pending",
        projectionVersion: "codex-app-server-v1",
        metadata: { transcriptIndex: 42 }
      };

      const batches = rawConversationItemBatches([item]);
      const chunks = batches.flat();

      expect(chunks.length).toBeGreaterThan(1);
      expect(batches.every((batch) => requestBytes(batch) <= 1400)).toBe(true);
      expect(new Set(chunks.map((chunk) => chunk.idempotencyKey)).size).toBe(
        chunks.length
      );
      expect(new Set(chunks.map((chunk) => chunk.sourceHash)).size).toBe(
        chunks.length
      );
      expect(new Set(chunks.map((chunk) => chunk.logicalSourceId))).toEqual(
        new Set(["oversized-source"])
      );
      expect(new Set(chunks.map((chunk) => chunk.transportChunkCount))).toEqual(
        new Set([chunks.length])
      );

      const reconstructed = chunks
        .sort(
          (left, right) =>
            Number(left.transportChunkIndex) - Number(right.transportChunkIndex)
        )
        .map((chunk) => chunk.transportChunkText)
        .join("");

      expect(JSON.parse(reconstructed)).toEqual({ rawJson, rawText });
    } finally {
      if (previousLimit === undefined) {
        delete process.env.MEMORY_RAW_INGEST_BATCH_BYTES;
      } else {
        process.env.MEMORY_RAW_INGEST_BATCH_BYTES = previousLimit;
      }
    }
  });
});
