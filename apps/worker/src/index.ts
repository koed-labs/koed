import { Queue, Worker } from "bullmq";
import {
  answerMemory,
  scheduleCompaction,
  type MemoryScope,
  type Visibility
} from "@koed/core";
import {
  createDbPool,
  createMemorySourceRepository,
  type EmbeddableSourceRecord,
  type RuntimeProviderConfigRecord
} from "@koed/db";
import { createProvider, type ProviderConfig } from "@koed/providers";
import { resolveMemoryMode } from "@koed/shared";

const connection = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  maxRetriesPerRequest: null
};

const queueNames = [
  "memory-embed",
  "lcm-compact",
  "lcm-embed",
  "memory-answer",
  "provider-health"
];

const pool = process.env.DATABASE_URL ? createDbPool() : null;
const repository = pool ? createMemorySourceRepository(pool) : null;
const configuredMemoryMode = resolveMemoryMode();
const lcmEmbedQueue = new Queue("lcm-embed", { connection });

const toProviderConfig = (
  record: RuntimeProviderConfigRecord
): ProviderConfig => ({
  provider: record.provider,
  apiKey: record.apiKey ?? undefined,
  baseUrl:
    typeof record.config.baseUrl === "string"
      ? record.config.baseUrl
      : undefined,
  embeddingDimensions:
    typeof record.config.embedding_dimensions === "number"
      ? record.config.embedding_dimensions
      : 1536,
  enabled:
    typeof record.config.enabled === "boolean" ? record.config.enabled : true,
  models: {
    embeddingModel:
      typeof record.config.embedding_model === "string"
        ? record.config.embedding_model
        : "text-embedding-3-small",
    summaryModel:
      typeof record.config.summary_model === "string"
        ? record.config.summary_model
        : "gpt-5.5",
    answerModel:
      typeof record.config.answer_model === "string"
        ? record.config.answer_model
        : "gpt-5.5"
  }
});

const requireRepository = () => {
  if (!repository) {
    throw new Error("DATABASE_URL is required for worker business logic");
  }
  return repository;
};

const stringValue = (value: unknown, fallback = ""): string =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? String(value)
    : fallback;

const isTransientError = (error: unknown): boolean =>
  error instanceof TypeError ||
  (typeof error === "object" &&
    error !== null &&
    "transient" in error &&
    error.transient === true);

const embeddingVersion = (): string =>
  process.env.EMBEDDING_VERSION ?? "local-qwen3-embedding-0.6b-gguf-v1";

const embeddingServiceUrl = (): string =>
  process.env.EMBEDDING_SERVICE_URL ?? "http://embedding-service:8000";

const embeddingDimensions = (): number =>
  Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);

interface EmbeddedChunk {
  inputIndex: number;
  chunkIndex: number;
  chunkCount: number;
  text: string;
  vector: number[];
}

const embedTexts = async (
  texts: string[]
): Promise<{
  model: string;
  dimensions: number;
  vectors: number[][];
  chunks: EmbeddedChunk[];
}> => {
  const preparedTexts = texts.map((text) => text.trim()).filter(Boolean);
  if (preparedTexts.length === 0) {
    throw new Error("Embedding text is empty after normalization");
  }

  const response = await fetch(
    `${embeddingServiceUrl().replace(/\/+$/, "")}/embed`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: preparedTexts })
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    model?: string;
    dimensions?: number;
    vectors?: number[][];
    chunks?: EmbeddedChunk[];
    detail?: string;
  };
  if (!response.ok) {
    const transient = response.status === 429 || response.status >= 500;
    throw Object.assign(
      new Error(
        payload.detail ?? `embedding service failed with ${response.status}`
      ),
      { transient }
    );
  }
  const expectedDimensions = embeddingDimensions();
  if (
    !payload.model ||
    payload.dimensions !== expectedDimensions ||
    !payload.vectors?.[0]
  ) {
    throw new Error(
      `embedding service returned an invalid ${expectedDimensions}-dim response`
    );
  }
  return {
    model: payload.model,
    dimensions: payload.dimensions,
    vectors: payload.vectors,
    chunks:
      payload.chunks ??
      payload.vectors.map((vector, index) => ({
        inputIndex: index,
        chunkIndex: 0,
        chunkCount: 1,
        text: preparedTexts[index] ?? "",
        vector
      }))
  };
};

const storeEmbedding = async (source: EmbeddableSourceRecord) => {
  const embedded = await embedTexts([source.text]);
  const chunks = embedded.chunks.filter((chunk) => chunk.inputIndex === 0);
  if (chunks.length === 0) {
    throw new Error("embedding service returned no chunks for source");
  }
  const stored = await Promise.all(
    chunks.map((chunk) =>
      requireRepository().upsertSourceEmbedding({
        source,
        model: embedded.model,
        dimensions: embedded.dimensions,
        version: embeddingVersion(),
        vector: chunk.vector,
        chunkIndex: chunk.chunkIndex,
        chunkCount: chunk.chunkCount,
        sourceText: chunk.text
      })
    )
  );
  return {
    inserted: stored.some((result) => result.inserted),
    chunks: stored.length
  };
};

const embedSource = async (
  sourceType: "memory_node" | "memory_event" | "message",
  sourceId: string
) => {
  const source = await requireRepository().getEmbeddableSource(
    sourceType,
    sourceId
  );
  if (!source) {
    return { skipped: true, reason: "source missing or empty" };
  }
  const stored = await storeEmbedding(source);
  return {
    dimensions: embeddingDimensions(),
    inserted: stored.inserted,
    chunks: stored.chunks
  };
};

const enqueueLcmNodeEmbeddings = async (nodeIds: string[]) =>
  Promise.all(
    nodeIds.map((nodeId) =>
      lcmEmbedQueue.add(
        "embed-lcm-node",
        { sourceType: "memory_node", sourceId: nodeId },
        {
          attempts: 5,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: 1000,
          removeOnFail: 5000
        }
      )
    )
  );

const loadProvider = async (
  userId: string,
  visibility?: Visibility,
  teamId?: string
) => {
  const repo = requireRepository();
  const config = await repo.getRuntimeProviderConfig(
    { userId },
    { visibility, teamId }
  );
  if (!config) {
    throw Object.assign(new Error("Provider not configured or disabled"), {
      transient: false
    });
  }
  return createProvider(toProviderConfig(config));
};

const handleJob = async (queueName: string, data: Record<string, unknown>) => {
  if (queueName === "provider-health") {
    const userId = stringValue(data.userId);
    const provider = await loadProvider(userId);
    await provider.embed(["provider health check"]);
    return { ok: true };
  }

  if (queueName === "memory-answer") {
    const userId = stringValue(data.userId);
    const query = stringValue(data.query);
    const scope = stringValue(data.scope, "personal") as MemoryScope;
    const provider =
      configuredMemoryMode === "server_synthesis"
        ? await loadProvider(
            userId,
            scope === "personal_and_team" ? undefined : scope
          )
        : undefined;
    return answerMemory({
      repository: requireRepository(),
      mode:
        configuredMemoryMode === "server_synthesis"
          ? "server_synthesis"
          : "codex_subscription",
      provider,
      requesterContext: { userId },
      query,
      scope,
      limit: typeof data.limit === "number" ? data.limit : undefined
    });
  }

  if (queueName === "lcm-compact") {
    const userId = stringValue(data.userId);
    const visibility = stringValue(data.visibility, "personal") as Visibility;
    const compaction = await scheduleCompaction({
      repository: requireRepository(),
      requesterContext: { userId },
      visibility,
      teamId: typeof data.teamId === "string" ? data.teamId : undefined
    });
    const nodeIds = [
      ...compaction.leafNodeIds,
      ...(compaction.rollupNodeId ? [compaction.rollupNodeId] : [])
    ];
    const embeddingJobs = await enqueueLcmNodeEmbeddings(nodeIds);
    return {
      compaction,
      localSummaryPendingNodeIds: nodeIds,
      embeddingJobIds: embeddingJobs.map((job) => job.id)
    };
  }

  if (queueName === "memory-embed" || queueName === "lcm-embed") {
    const sourceType = stringValue(data.sourceType) as
      | "memory_node"
      | "memory_event"
      | "message";
    const sourceId = stringValue(data.sourceId);
    if (!["memory_node", "memory_event", "message"].includes(sourceType)) {
      throw new Error("Embedding job sourceType is invalid");
    }
    return embedSource(sourceType, sourceId);
  }

  return { ok: true };
};

const workers = queueNames.map(
  (queueName) =>
    new Worker(
      queueName,
      async (job) => {
        try {
          return await handleJob(
            queueName,
            job.data as Record<string, unknown>
          );
        } catch (error) {
          if (isTransientError(error)) {
            console.warn(
              `Transient provider failure in ${queueName} job ${job.id ?? "unknown"}; BullMQ will retry.`
            );
          }
          throw error;
        }
      },
      {
        connection,
        lockDuration: 10 * 60 * 1000,
        settings: {
          backoffStrategy: (_attemptsMade, _type, error) =>
            isTransientError(error) ? 5_000 : 0
        }
      }
    )
);

console.log(`Worker listening on queues: ${queueNames.join(", ")}`);

const shutdown = async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await lcmEmbedQueue.close();
  await pool?.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
