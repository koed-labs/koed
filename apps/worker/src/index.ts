import {
  createDbPool,
  createMemorySourceRepository,
  waitForCurrentDbMigrations,
  type MemorySourceRepository
} from "@koed/db";
import { createEmbeddingWorkflow } from "./embedding-workflow.js";
import { loadWorkerEnv, resolveWorkerEnv } from "./env-config.js";
import { lcmEmbedQueueName, workerQueueNames } from "@koed/shared";
import {
  createWorkerJobWorkflow,
  enqueueLcmNodeEmbeddings,
  type EmbeddingQueueJobData
} from "./job-workflows.js";
import {
  createWorkerQueueProducer,
  createWorkerQueueRuntime
} from "./queue.js";
import { createWorkerLogger } from "./logging.js";
import { createRawProjectionService } from "./raw-projection-service.js";

loadWorkerEnv();

const workerEnv = resolveWorkerEnv();
const logger = createWorkerLogger({
  nodeEnv: workerEnv.nodeEnv,
  logLevel: workerEnv.logLevel,
  logDestination: workerEnv.logDestination
});

const pool = workerEnv.databaseUrl
  ? createDbPool({ connectionString: workerEnv.databaseUrl })
  : null;
if (pool) {
  await waitForCurrentDbMigrations(pool);
}
const repository = pool ? createMemorySourceRepository(pool) : null;
const requireRepository = (): MemorySourceRepository => {
  if (!repository) {
    throw new Error("DATABASE_URL is required for worker business logic");
  }
  return repository;
};

const isTransientError = (error: unknown): boolean =>
  error instanceof TypeError ||
  (typeof error === "object" &&
    error !== null &&
    "transient" in error &&
    error.transient === true);

const embeddingWorkflow = createEmbeddingWorkflow({
  env: workerEnv,
  repository: requireRepository
});

const lcmEmbedQueue = createWorkerQueueProducer<EmbeddingQueueJobData>(
  lcmEmbedQueueName,
  {
    backend: workerEnv.queueBackend,
    redisUrl: workerEnv.redisUrl,
    pool
  }
);

const handleJob = createWorkerJobWorkflow({
  embeddingWorkflow,
  lcmEmbedQueue,
  repository: requireRepository
});

const queueRuntime = createWorkerQueueRuntime({
  backend: workerEnv.queueBackend,
  redisUrl: workerEnv.redisUrl,
  pool,
  logger,
  lcmEmbedQueue,
  handleJob,
  isTransientError
});

logger.info(
  {
    event: {
      name: "worker.started",
      category: "lifecycle"
    },
    queueBackend: workerEnv.queueBackend,
    queues: workerQueueNames
  },
  "worker listening on queues"
);

const rawProjectionService = repository
  ? createRawProjectionService({
      actorLimit: workerEnv.rawProjectionActorLimit,
      batchLimit: workerEnv.rawProjectionBatchLimit,
      embeddingWorkflow,
      enqueueLcmNodeEmbeddings: (nodeIds) =>
        enqueueLcmNodeEmbeddings(lcmEmbedQueue, nodeIds),
      intervalMs: workerEnv.rawProjectionIntervalMs,
      logger,
      repository
    })
  : null;
rawProjectionService?.start();

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
  rawProjectionService?.stop();
  await queueRuntime.close();
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
