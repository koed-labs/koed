import { createHash } from "node:crypto";

import {
  RAW_CONVERSATION_LOGICAL_ITEM_MAX_BYTES,
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES,
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT,
  rawConversationTransportChunkGroupId
} from "@koed/shared";

import type { MemoryApiClient } from "./index.js";
import type { RawConversationItemRequest } from "./conversation-source-types.js";

const positiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const maxBatchBytes = (): number =>
  positiveIntEnv("MEMORY_RAW_INGEST_BATCH_BYTES", 180_000);

const maxBatchItems = (): number =>
  Math.min(positiveIntEnv("MEMORY_RAW_INGEST_BATCH_ITEMS", 100), 1_000);

const TRANSPORT_CHUNK_ENCODING = "conversation-item-json-v2";
const TRANSPORT_CHUNK_VERSION = 2;
const SHA256_HEX_LENGTH = 64;

const envelopeBytes = (items: RawConversationItemRequest[]): number =>
  Buffer.byteLength(JSON.stringify({ items }), "utf8");

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const jsonStringContentBytes = (value: string): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8") - 2;

const chunkStringByJsonBytes = (value: string, maxBytes: number): string[] => {
  const chunks: string[] = [];
  let chunkStart = 0;
  let cursor = 0;
  let currentBytes = 0;

  for (const char of value) {
    const charBytes = jsonStringContentBytes(char);
    if (charBytes > maxBytes) {
      throw new Error(
        "Raw conversation item transport envelope cannot fit one encoded Unicode code point"
      );
    }
    if (currentBytes > 0 && currentBytes + charBytes > maxBytes) {
      chunks.push(value.slice(chunkStart, cursor));
      chunkStart = cursor;
      currentBytes = 0;
    }
    cursor += char.length;
    currentBytes += charBytes;
  }

  if (cursor > chunkStart) {
    chunks.push(value.slice(chunkStart, cursor));
  }
  return chunks.length > 0 ? chunks : [""];
};

const transportChunkItem = (input: {
  item: RawConversationItemRequest;
  logicalSourceId: string;
  sourceItemHash: string;
  transportChunkGroupId: string;
  chunkIndex: number;
  chunkCount: number;
  chunkText: string;
  sourceHash: string;
  idempotencyKey: string;
}): RawConversationItemRequest => ({
  ...input.item,
  rawJson: {
    transportChunk: true,
    transportChunkGroupId: input.transportChunkGroupId,
    sourceItemHash: input.sourceItemHash,
    chunkIndex: input.chunkIndex,
    chunkCount: input.chunkCount
  },
  rawText: undefined,
  logicalSourceId: input.logicalSourceId,
  transportChunkIndex: input.chunkIndex,
  transportChunkCount: input.chunkCount,
  transportChunkText: input.chunkText,
  transportChunkEncoding: TRANSPORT_CHUNK_ENCODING,
  sourceHash: input.sourceHash,
  idempotencyKey: input.idempotencyKey,
  metadata: {
    transportChunkGroupId: input.transportChunkGroupId,
    sourceItemHash: input.sourceItemHash,
    sourceChunkIndex: input.chunkIndex,
    sourceChunkCount: input.chunkCount
  }
});

const splitOversizedItem = (
  item: RawConversationItemRequest
): RawConversationItemRequest[] => {
  const byteLimit = maxBatchBytes();
  if (envelopeBytes([item]) <= byteLimit) {
    return [item];
  }
  // Keep sensitive metadata in the reconstructable stream instead of copying it
  // into every transport observation.
  const serializedItem = JSON.stringify({
    rawJson: item.rawJson,
    rawText: typeof item.rawText === "string" ? item.rawText : null,
    metadata: item.metadata ?? {}
  });
  if (
    Buffer.byteLength(serializedItem, "utf8") >
    RAW_CONVERSATION_LOGICAL_ITEM_MAX_BYTES
  ) {
    throw new Error("Raw conversation item exceeds the logical item limit");
  }
  const sourceItemHash = item.sourceHash;
  const logicalSourceId =
    item.logicalSourceId ?? item.canonicalItemKey ?? sourceItemHash;
  const identityPlaceholder = "0".repeat(SHA256_HEX_LENGTH);
  // Reserve the widest possible chunk index/count. Final requests can only be
  // the same size or smaller once the real chunk count is known.
  const maximumChunkCount = Math.max(1, serializedItem.length);
  const prototype = transportChunkItem({
    item,
    logicalSourceId,
    sourceItemHash,
    transportChunkGroupId: identityPlaceholder,
    chunkIndex: maximumChunkCount - 1,
    chunkCount: maximumChunkCount,
    chunkText: "",
    sourceHash: identityPlaceholder,
    idempotencyKey: identityPlaceholder
  });
  const chunkPayloadBytes = Math.min(
    byteLimit - envelopeBytes([prototype]),
    RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES
  );
  if (chunkPayloadBytes <= 0) {
    throw new Error(
      "Raw conversation item transport envelope exceeds ingest batch byte limit"
    );
  }

  const chunks = chunkStringByJsonBytes(serializedItem, chunkPayloadBytes);
  if (chunks.length > RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT) {
    throw new Error("Raw conversation item requires too many transport chunks");
  }
  const transportChunkGroupId = rawConversationTransportChunkGroupId({
    sourceKind: item.sourceKind,
    sourceAdapterVersion: item.sourceAdapterVersion,
    sourceTransport: item.sourceTransport,
    logicalSourceId,
    sourceItemHash,
    transportChunkCount: chunks.length,
    transportChunkEncoding: TRANSPORT_CHUNK_ENCODING
  });
  const chunked = chunks.map((chunk, index) =>
    transportChunkItem({
      item,
      logicalSourceId,
      sourceItemHash,
      transportChunkGroupId,
      chunkIndex: index,
      chunkCount: chunks.length,
      chunkText: chunk,
      sourceHash: hash({
        version: TRANSPORT_CHUNK_VERSION,
        transportChunkGroupId,
        chunkIndex: index,
        chunkCount: chunks.length,
        chunk
      }),
      idempotencyKey: hash({
        version: TRANSPORT_CHUNK_VERSION,
        transportChunkGroupId,
        sourceItemIdempotencyKey: item.idempotencyKey,
        chunkIndex: index
      })
    })
  );
  if (chunked.some((chunk) => envelopeBytes([chunk]) > byteLimit)) {
    throw new Error(
      "Raw conversation item transport chunk exceeds ingest batch byte limit"
    );
  }
  return chunked;
};

export const rawConversationItemBatches = (
  items: RawConversationItemRequest[]
): RawConversationItemRequest[][] => {
  const byteLimit = maxBatchBytes();
  const itemLimit = maxBatchItems();
  const batches: RawConversationItemRequest[][] = [];
  let current: RawConversationItemRequest[] = [];

  for (const sourceItem of items) {
    for (const item of splitOversizedItem(sourceItem)) {
      if (envelopeBytes([item]) > byteLimit) {
        throw new Error(
          "Raw conversation item exceeds ingest batch byte limit"
        );
      }
      const next = [...current, item];
      if (
        current.length > 0 &&
        (next.length > itemLimit || envelopeBytes(next) > byteLimit)
      ) {
        batches.push(current);
        current = [];
      }
      current.push(item);
    }
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
};

export const persistRawConversationItems = async (
  client: MemoryApiClient,
  items: RawConversationItemRequest[],
  context: string
): Promise<RawConversationItemRequest[]> => {
  const persisted: RawConversationItemRequest[] = [];
  for (const batch of rawConversationItemBatches(items)) {
    try {
      const response = (await client.createConversationItems({
        items: batch
      })) as {
        items?: RawConversationItemRequest[];
      };
      persisted.push(...(response.items ?? []));
    } catch (error) {
      console.error(
        `koed raw conversation item capture skipped for ${context}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }
  return persisted;
};

export const projectRawConversationItems = async (
  client: MemoryApiClient,
  items: Array<{ id?: string }>,
  context: string
): Promise<void> => {
  const ids = items
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  for (let index = 0; index < ids.length; index += 1000) {
    const conversationItemIds = ids.slice(index, index + 1000);
    try {
      await client.projectConversationItems({
        conversationItemIds,
        limit: conversationItemIds.length
      });
    } catch (error) {
      console.error(
        `koed raw conversation item projection failed for ${context}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }
};

export const queueRawConversationItemsBestEffort = (
  client: MemoryApiClient,
  items: RawConversationItemRequest[],
  context: string
): void => {
  void persistRawConversationItems(client, items, context).catch((error) => {
    console.error(
      `koed raw conversation item capture skipped for ${context}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
};
