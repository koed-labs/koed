import { describe, expect, it } from "vitest";
import { rawConversationItemBatches } from "../src/raw-conversation-items.js";
import type { RawConversationItemRequest } from "../src/conversation-source-types.js";

const requestBytes = (items: RawConversationItemRequest[]): number =>
  Buffer.byteLength(JSON.stringify({ items }), "utf8");

const withRawIngestLimits = <T>(
  byteLimit: number,
  itemLimit: number,
  run: () => T
): T => {
  const previousByteLimit = process.env.MEMORY_RAW_INGEST_BATCH_BYTES;
  const previousItemLimit = process.env.MEMORY_RAW_INGEST_BATCH_ITEMS;
  process.env.MEMORY_RAW_INGEST_BATCH_BYTES = String(byteLimit);
  process.env.MEMORY_RAW_INGEST_BATCH_ITEMS = String(itemLimit);
  try {
    return run();
  } finally {
    if (previousByteLimit === undefined) {
      delete process.env.MEMORY_RAW_INGEST_BATCH_BYTES;
    } else {
      process.env.MEMORY_RAW_INGEST_BATCH_BYTES = previousByteLimit;
    }
    if (previousItemLimit === undefined) {
      delete process.env.MEMORY_RAW_INGEST_BATCH_ITEMS;
    } else {
      process.env.MEMORY_RAW_INGEST_BATCH_ITEMS = previousItemLimit;
    }
  }
};

const rawItem = (
  overrides: Partial<RawConversationItemRequest> = {}
): RawConversationItemRequest => ({
  sourceKind: "codex",
  sourceAdapterVersion: "codex-app-server-v1",
  sourceTransport: "app_server",
  sourceRecordType: "app_server_notification",
  sourceEventType: "item/completed",
  sourceSequence: 42,
  rawJson: { payload: "short" },
  rawText: "short",
  sourceHash: "source-observation-hash",
  idempotencyKey: "source-observation-idempotency",
  projectionStatus: "pending",
  projectionVersion: "codex-app-server-v1",
  metadata: { transcriptIndex: 42 },
  ...overrides
});

const reconstructTransportEnvelope = (
  chunks: RawConversationItemRequest[]
): {
  rawJson: unknown;
  rawText: string | null;
  metadata: Record<string, unknown>;
} =>
  JSON.parse(
    [...chunks]
      .sort(
        (left, right) =>
          Number(left.transportChunkIndex) - Number(right.transportChunkIndex)
      )
      .map((chunk) => chunk.transportChunkText ?? "")
      .join("")
  ) as {
    rawJson: unknown;
    rawText: string | null;
    metadata: Record<string, unknown>;
  };

describe("raw conversation item batching", () => {
  it("round-trips an oversized canonical item without repeating sensitive metadata", () => {
    const byteLimit = 8_000;
    const canonicalItemKey = `conversation-item:${"a".repeat(64)}`;
    const rawJson = {
      payload: '"quoted" \\\\ backslash \\n newline 😀 '.repeat(600)
    };
    const rawText = "visible text 😀 ".repeat(200);
    const metadata = {
      transcriptIndex: 42,
      transcriptType: "function_call_output",
      toolCall: {
        name: "exec_command",
        output: "sensitive-output-marker ".repeat(500)
      }
    };
    const item = rawItem({
      externalThreadId: "thread-1",
      externalTurnId: "turn-1",
      externalItemId: "item-1",
      canonicalItemKey,
      canonicalStableItemId: "item-1",
      canonicalSourcePriority: 300,
      observationKind: "lifecycle_completed",
      observationComponent: "tool_result",
      logicalSourceId: "canonical-logical-item-1",
      rawJson,
      rawText,
      sourceHash: "base-source-observation-hash",
      idempotencyKey: "base-source-observation-idempotency",
      metadata
    });

    const batches = withRawIngestLimits(byteLimit, 100, () =>
      rawConversationItemBatches([item])
    );
    const chunks = batches.flat();
    const groupIds = chunks.map(
      (chunk) => chunk.metadata.transportChunkGroupId
    );
    const groupId = groupIds[0];

    expect(chunks.length).toBeGreaterThan(1);
    expect(batches.every((batch) => requestBytes(batch) <= byteLimit)).toBe(
      true
    );
    expect(new Set(chunks.map((chunk) => chunk.idempotencyKey)).size).toBe(
      chunks.length
    );
    expect(new Set(chunks.map((chunk) => chunk.sourceHash)).size).toBe(
      chunks.length
    );
    expect(new Set(groupIds)).toEqual(new Set([groupId]));
    expect(groupId).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(chunks.map((chunk) => chunk.logicalSourceId))).toEqual(
      new Set(["canonical-logical-item-1"])
    );
    expect(new Set(chunks.map((chunk) => chunk.canonicalItemKey))).toEqual(
      new Set([canonicalItemKey])
    );
    expect(new Set(chunks.map((chunk) => chunk.canonicalStableItemId))).toEqual(
      new Set(["item-1"])
    );
    expect(new Set(chunks.map((chunk) => chunk.transportChunkCount))).toEqual(
      new Set([chunks.length])
    );
    expect(
      new Set(chunks.map((chunk) => chunk.transportChunkEncoding))
    ).toEqual(new Set(["conversation-item-json-v2"]));

    chunks.forEach((chunk, index) => {
      expect(chunk.metadata).toEqual({
        transportChunkGroupId: groupId,
        sourceItemHash: item.sourceHash,
        sourceChunkIndex: index,
        sourceChunkCount: chunks.length
      });
      expect(JSON.stringify(chunk.metadata)).not.toContain(
        "sensitive-output-marker"
      );
      expect(chunk.rawJson).toEqual({
        transportChunk: true,
        transportChunkGroupId: groupId,
        sourceItemHash: item.sourceHash,
        chunkIndex: index,
        chunkCount: chunks.length
      });
    });

    expect(reconstructTransportEnvelope(chunks)).toEqual({
      rawJson,
      rawText,
      metadata
    });
  });

  it("makes bounded progress through a huge Unicode item and bounds every batch", () => {
    const byteLimit = 32_000;
    const itemLimit = 3;
    const hugeText = '😀漢字é\\"\n'.repeat(20_000);
    const hugeItem = rawItem({
      sourceSequence: 2,
      rawJson: { payload: hugeText },
      rawText: hugeText,
      sourceHash: "huge-unicode-source",
      idempotencyKey: "huge-unicode-source",
      metadata: { transcriptIndex: 2, label: "huge-unicode" }
    });
    const items = [
      rawItem({
        sourceSequence: 1,
        sourceHash: "small-1",
        idempotencyKey: "small-1"
      }),
      hugeItem,
      rawItem({
        sourceSequence: 3,
        sourceHash: "small-3",
        idempotencyKey: "small-3"
      }),
      rawItem({
        sourceSequence: 4,
        sourceHash: "small-4",
        idempotencyKey: "small-4"
      })
    ];

    const batches = withRawIngestLimits(byteLimit, itemLimit, () =>
      rawConversationItemBatches(items)
    );
    const chunks = batches
      .flat()
      .filter(
        (item) => item.transportChunkEncoding === "conversation-item-json-v2"
      );

    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.length).toBeLessThanOrEqual(64);
    expect(
      chunks.every(
        (chunk) =>
          typeof chunk.transportChunkText === "string" &&
          chunk.transportChunkText.length > 0
      )
    ).toBe(true);
    expect(batches.every((batch) => batch.length <= itemLimit)).toBe(true);
    expect(batches.every((batch) => requestBytes(batch) <= byteLimit)).toBe(
      true
    );
    expect(reconstructTransportEnvelope(chunks)).toEqual({
      rawJson: hugeItem.rawJson,
      rawText: hugeItem.rawText,
      metadata: hugeItem.metadata
    });
  });

  it("keeps replay identities stable and separates a different chunk plan", () => {
    const item = rawItem({
      externalThreadId: "replay-thread",
      externalTurnId: "replay-turn",
      externalItemId: "replay-item",
      canonicalItemKey: `conversation-item:${"b".repeat(64)}`,
      canonicalStableItemId: "replay-item",
      observationKind: "lifecycle_completed",
      observationComponent: "message",
      rawJson: { payload: "replay 😀 payload ".repeat(600) },
      rawText: "replay visible text ".repeat(400),
      sourceHash: "replay-source-hash",
      idempotencyKey: "replay-source-idempotency",
      metadata: { transcriptType: "agent_message", privateValue: "retained" }
    });

    const first = withRawIngestLimits(1_900, 100, () =>
      rawConversationItemBatches([item]).flat()
    );
    const replay = withRawIngestLimits(1_900, 100, () =>
      rawConversationItemBatches([item]).flat()
    );
    const resized = withRawIngestLimits(2_100, 100, () =>
      rawConversationItemBatches([item]).flat()
    );

    expect(replay).toEqual(first);
    expect(replay.map((chunk) => chunk.idempotencyKey)).toEqual(
      first.map((chunk) => chunk.idempotencyKey)
    );
    expect(new Set(first.map((chunk) => chunk.logicalSourceId))).toEqual(
      new Set([item.canonicalItemKey])
    );
    expect(
      new Set(first.map((chunk) => chunk.metadata.transportChunkGroupId))
    ).toHaveLength(1);
    expect(
      new Set(resized.map((chunk) => chunk.metadata.transportChunkGroupId))
    ).toHaveLength(1);
    expect(resized[0]?.metadata.transportChunkGroupId).not.toBe(
      first[0]?.metadata.transportChunkGroupId
    );
    expect(
      resized.some((chunk) =>
        first.some(
          (firstChunk) => firstChunk.idempotencyKey === chunk.idempotencyKey
        )
      )
    ).toBe(false);
  });

  it("fails before emitting a chunk when fixed transport fields exceed the limit", () => {
    const item = rawItem({
      externalThreadId: "x".repeat(2_000),
      rawJson: { payload: "😀".repeat(2_000) }
    });

    expect(() =>
      withRawIngestLimits(500, 100, () => rawConversationItemBatches([item]))
    ).toThrow(
      "Raw conversation item transport envelope exceeds ingest batch byte limit"
    );
  });
});
