import { Queue, Worker } from "bullmq";
import { scheduleCompaction, type Visibility } from "@koed/core";
import {
  createDbPool,
  createMemorySourceRepository,
  type EmbeddableSourceRecord
} from "@koed/db";
import { loadWorkerEnv, resolveWorkerEnv } from "./env-config.js";
import { createWorkerLogger } from "./logging.js";

loadWorkerEnv();

const workerEnv = resolveWorkerEnv();
const logger = createWorkerLogger({
  nodeEnv: workerEnv.nodeEnv,
  logLevel: workerEnv.logLevel,
  logDestination: workerEnv.logDestination
});

const connection = {
  url: workerEnv.redisUrl,
  maxRetriesPerRequest: null
};

const queueNames = ["memory-embed", "lcm-compact", "lcm-embed"];

const pool = workerEnv.databaseUrl
  ? createDbPool({ connectionString: workerEnv.databaseUrl })
  : null;
const repository = pool ? createMemorySourceRepository(pool) : null;
const lcmEmbedQueue = new Queue("lcm-embed", { connection });

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

const embeddingVersion = (): string => workerEnv.embeddingVersion;

const embeddingServiceUrl = (): string => workerEnv.embeddingServiceUrl;

const embeddingDimensions = (): number => workerEnv.embeddingDimensions;

const embeddingServiceHeaders = (): Record<string, string> => {
  return {
    ...(workerEnv.embeddingServiceToken
      ? { "x-koed-embedding-token": workerEnv.embeddingServiceToken }
      : {}),
    "x-koed-embedding-priority": "background"
  };
};

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
      headers: {
        "content-type": "application/json",
        ...embeddingServiceHeaders()
      },
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

const handleJob = async (queueName: string, data: Record<string, unknown>) => {
  if (queueName === "lcm-compact") {
    const userId = stringValue(data.userId);
    const visibility = stringValue(data.visibility, "personal") as Visibility;
    const compaction = await scheduleCompaction({
      repository: requireRepository(),
      requesterContext: { userId },
      visibility
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

const workers = queueNames.map((queueName) => {
  const worker = new Worker(
    queueName,
    async (job) => {
      try {
        return await handleJob(queueName, job.data as Record<string, unknown>);
      } catch (error) {
        if (isTransientError(error)) {
          logger.warn(
            {
              event: {
                name: "worker.job.transient_failure",
                category: "job"
              },
              queue: { name: queueName },
              job: {
                id: String(job.id ?? "unknown"),
                name: job.name,
                attempts_made: job.attemptsMade
              },
              err: error
            },
            "worker job transient failure; BullMQ will retry"
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
  );

  worker.on("completed", (job) => {
    logger.info(
      {
        event: {
          name: "worker.job.completed",
          category: "job"
        },
        queue: { name: queueName },
        job: {
          id: String(job.id ?? "unknown"),
          name: job.name,
          attempts_made: job.attemptsMade
        }
      },
      "worker job completed"
    );
  });

  worker.on("failed", (job, error) => {
    logger.error(
      {
        event: {
          name: "worker.job.failed",
          category: "job"
        },
        queue: { name: queueName },
        job: job
          ? {
              id: String(job.id ?? "unknown"),
              name: job.name,
              attempts_made: job.attemptsMade
            }
          : undefined,
        err: error
      },
      "worker job failed"
    );
  });

  worker.on("stalled", (jobId) => {
    logger.warn(
      {
        event: {
          name: "worker.job.stalled",
          category: "job"
        },
        queue: { name: queueName },
        job: { id: String(jobId) }
      },
      "worker job stalled"
    );
  });

  worker.on("error", (error) => {
    logger.error(
      {
        event: {
          name: "worker.queue.error",
          category: "queue"
        },
        queue: { name: queueName },
        err: error
      },
      "worker queue error"
    );
  });

  return worker;
});

logger.info(
  {
    event: {
      name: "worker.started",
      category: "lifecycle"
    },
    queues: queueNames
  },
  "worker listening on queues"
);

const rawProjectionIntervalMs = workerEnv.rawProjectionIntervalMs;
const rawProjectionBatchLimit = workerEnv.rawProjectionBatchLimit;
const rawProjectionActorLimit = workerEnv.rawProjectionActorLimit;
let rawProjectionRunning = false;

const runRawProjectionCatchup = async () => {
  if (!repository || rawProjectionRunning) {
    return;
  }
  rawProjectionRunning = true;
  try {
    const actors = await repository.listConversationProjectionActors({
      limit: rawProjectionActorLimit
    });
    let scanned = 0;
    let projected = 0;
    for (const actor of actors) {
      const result = await repository.projectPendingConversationItems(actor, {
        limit: rawProjectionBatchLimit
      });
      await Promise.all(
        result.memoryEventIds.map((eventId) =>
          embedSource("memory_event", eventId)
        )
      );
      const scopes = new Map<string, { visibility: Visibility }>();
      for (const scope of result.memoryEventScopes) {
        scopes.set(scope.visibility, { visibility: scope.visibility });
      }
      for (const scope of scopes.values()) {
        const compaction = await scheduleCompaction({
          repository,
          requesterContext: actor,
          visibility: scope.visibility
        });
        const nodeIds = [
          ...compaction.leafNodeIds,
          ...(compaction.rollupNodeId ? [compaction.rollupNodeId] : [])
        ];
        await enqueueLcmNodeEmbeddings(nodeIds);
      }
      scanned += result.rawItemsScanned;
      projected += result.rawItemsProjected;
    }
    if (scanned > 0) {
      logger.info(
        {
          event: {
            name: "worker.raw_projection.catchup.completed",
            category: "projection"
          },
          projection: {
            actors: actors.length,
            scanned,
            projected
          }
        },
        "raw conversation projection catch-up completed"
      );
    }
  } catch (error) {
    logger.warn(
      {
        event: {
          name: "worker.raw_projection.catchup.failed",
          category: "projection"
        },
        err: error
      },
      "raw conversation projection catch-up failed"
    );
  } finally {
    rawProjectionRunning = false;
  }
};

const rawProjectionTimer = setInterval(
  () => void runRawProjectionCatchup(),
  rawProjectionIntervalMs
);
void runRawProjectionCatchup();

const shutdown = async () => {
  logger.info(
    {
      event: {
        name: "worker.shutting_down",
        category: "lifecycle"
      }
    },
    "worker shutting down"
  );
  clearInterval(rawProjectionTimer);
  await Promise.all(workers.map((worker) => worker.close()));
  await lcmEmbedQueue.close();
  await pool?.end();
  logger.info(
    {
      event: {
        name: "worker.stopped",
        category: "lifecycle"
      }
    },
    "worker stopped"
  );
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
