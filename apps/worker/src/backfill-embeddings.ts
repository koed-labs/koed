import { Queue } from "bullmq";
import { createDbPool, createMemorySourceRepository } from "@koed/db";

const batchSize = Number.parseInt(process.env.EMBEDDING_BACKFILL_BATCH ?? "500", 10);
const queue = new Queue("memory-embed", {
  connection: {
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
    maxRetriesPerRequest: null
  }
});
const pool = createDbPool();
const repo = createMemorySourceRepository(pool);

const embeddingVersion = (
  process.env.EMBEDDING_VERSION ?? "local-qwen3-embedding-0.6b-gguf-v1"
).replace(/[^a-zA-Z0-9_-]/g, "-");

try {
  const sources = await repo.listSourcesNeedingEmbeddings(batchSize);
  for (const source of sources) {
    await queue.add(
      "embed-source",
      { sourceType: source.sourceType, sourceId: source.sourceId },
      {
        jobId: `embed-${embeddingVersion}-${source.sourceType}-${source.sourceId}`,
        attempts: 5,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000
      }
    );
  }
  console.log(`Queued ${sources.length} embedding backfill jobs.`);
} finally {
  await queue.close();
  await pool.end();
}
