import { createHash } from "node:crypto";

import { MemoryApiClient } from "./index.js";

type RawConversationItemRequest = Record<string, unknown>;

const positiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const maxBatchBytes = (): number =>
  positiveIntEnv("MEMORY_RAW_INGEST_BATCH_BYTES", 180_000);

const maxBatchItems = (): number =>
  positiveIntEnv("MEMORY_RAW_INGEST_BATCH_ITEMS", 100);

const envelopeBytes = (items: RawConversationItemRequest[]): number =>
  Buffer.byteLength(JSON.stringify({ items }), "utf8");

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const chunkString = (value: string, size: number): string[] => {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks.length > 0 ? chunks : [""];
};

const splitOversizedItem = (
  item: RawConversationItemRequest
): RawConversationItemRequest[] => {
  const byteLimit = maxBatchBytes();
  if (envelopeBytes([item]) <= byteLimit) {
    return [item];
  }
  const rawJsonText = JSON.stringify({
    rawJson: item.rawJson ?? item,
    rawText: typeof item.rawText === "string" ? item.rawText : null
  });
  const sourceItemHash =
    typeof item.sourceHash === "string"
      ? item.sourceHash
      : typeof item.idempotencyKey === "string"
        ? item.idempotencyKey
        : hash(item);
  let chunkBudget = Math.max(1024, Math.floor(byteLimit * 0.6));
  while (chunkBudget >= 1024) {
    const chunks = chunkString(rawJsonText, chunkBudget);
    const chunked = chunks.map((chunk, index) => ({
      ...item,
      rawJson: {
        transportChunk: true,
        sourceItemHash,
        chunkIndex: index,
        chunkCount: chunks.length
      },
      rawText: undefined,
      logicalSourceId: sourceItemHash,
      transportChunkIndex: index,
      transportChunkCount: chunks.length,
      transportChunkText: chunk,
      transportChunkEncoding: "conversation-item-json-v1",
      sourceHash: hash({ sourceItemHash, chunkIndex: index }),
      idempotencyKey: hash({
        idempotencyKey: item.idempotencyKey ?? sourceItemHash,
        chunkIndex: index
      }),
      metadata: {
        ...((item.metadata && typeof item.metadata === "object"
          ? item.metadata
          : {}) as Record<string, unknown>),
        sourceItemHash,
        sourceChunkIndex: index,
        sourceChunkCount: chunks.length
      }
    }));
    if (chunked.every((chunk) => envelopeBytes([chunk]) <= byteLimit)) {
      return chunked;
    }
    chunkBudget = Math.floor(chunkBudget / 2);
  }
  throw new Error("Raw conversation item is too large to chunk safely");
};

export const rawConversationItemBatches = (
  items: RawConversationItemRequest[]
): RawConversationItemRequest[][] => {
  const byteLimit = maxBatchBytes();
  const itemLimit = maxBatchItems();
  const batches: RawConversationItemRequest[][] = [];
  let current: RawConversationItemRequest[] = [];

  for (const item of items.flatMap(splitOversizedItem)) {
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
  items: RawConversationItemRequest[],
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
