import {
  createDbPool,
  createMemorySourceRepository,
  waitForCurrentDbMigrations,
  type MemorySourceRepository
} from "@koed/db";
import { createEmbeddingWorkflow } from "./embedding-workflow.js";
import { loadWorkerEnv, resolveWorkerEnv } from "./env-config.js";
import {
  createEnvelopeEncryptionProviderFromEnvironment,
  embeddingDispatchKey,
  inspectDeviceIdentityAtKoedHome,
  lcmCompactQueueName,
  lcmEmbedQueueName,
  memoryEmbedQueueName,
  workerQueueNames
} from "@koed/shared";
import {
  createWorkerJobWorkflow,
  enqueueLcmCompaction,
  enqueueSourceEmbedding,
  type CompactionQueueJobData,
  type EmbeddingQueueJobData
} from "./job-workflows.js";
import {
  createWorkerQueueProducer,
  createWorkerQueueRuntime
} from "./queue.js";
import { createWorkerLogger } from "./logging.js";
import { createRawProjectionService } from "./raw-projection-service.js";
import { createCrossIdentitySyncService } from "./cross-identity-sync-service.js";
import { createHistoricalAdmissionHealth } from "./historical-admission-health.js";
import { createProjectionJobScheduler } from "./projection-job-scheduler.js";

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
const envelopeEncryptionProvider =
  createEnvelopeEncryptionProviderFromEnvironment();
const repository = pool
  ? createMemorySourceRepository(pool, {
      envelopeEncryptionProvider
    })
  : null;
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

const queueProducerOptions = {
  backend: workerEnv.queueBackend,
  redisUrl: workerEnv.redisUrl,
  pool
};

const memoryEmbedQueue = createWorkerQueueProducer<EmbeddingQueueJobData>(
  memoryEmbedQueueName,
  queueProducerOptions
);
const lcmCompactQueue = createWorkerQueueProducer<CompactionQueueJobData>(
  lcmCompactQueueName,
  queueProducerOptions
);
const lcmEmbedQueue = createWorkerQueueProducer<EmbeddingQueueJobData>(
  lcmEmbedQueueName,
  queueProducerOptions
);

const workerEmbeddingDispatchKey = embeddingDispatchKey(
  workerEnv.embeddingVersion,
  workerEnv.embeddingDimensions
);

const handleJob = createWorkerJobWorkflow({
  embeddingDispatchKey: workerEmbeddingDispatchKey,
  embeddingWorkflow,
  lcmEmbedQueue,
  repository: requireRepository
});

const queueRuntime = await createWorkerQueueRuntime({
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

const projectionJobScheduler = repository
  ? createProjectionJobScheduler({
      embeddingQueue: memoryEmbedQueue,
      compactionQueue: lcmCompactQueue,
      repository,
      logger
    })
  : null;
const rawProjectionService =
  repository && projectionJobScheduler
    ? createRawProjectionService({
        actorLimit: workerEnv.rawProjectionActorLimit,
        batchLimit: workerEnv.rawProjectionBatchLimit,
        embeddingDispatchKey: workerEmbeddingDispatchKey,
        enqueueLcmCompaction: (
          requesterContext,
          visibility,
          dispatchKey,
          workClass,
          jobId,
          sessionId,
          finalize
        ) =>
          enqueueLcmCompaction(
            lcmCompactQueue,
            requesterContext,
            visibility,
            dispatchKey,
            workClass,
            jobId,
            sessionId,
            finalize
          ),
        enqueueProjectedMemoryEventProcessing: projectionJobScheduler.enqueue,
        enqueueSourceEmbedding: (
          sourceType,
          sourceId,
          dispatchKey,
          workClass,
          jobId
        ) =>
          enqueueSourceEmbedding(
            sourceType === "memory_node" ? lcmEmbedQueue : memoryEmbedQueue,
            sourceType,
            sourceId,
            dispatchKey,
            workClass,
            jobId
          ),
        getHistoricalAdmissionHealth: createHistoricalAdmissionHealth({
          apiReadyUrl: workerEnv.historicalImportApiReadyUrl,
          apiReadyTimeoutMs: workerEnv.historicalImportApiReadyTimeoutMs,
          embeddingQueue: memoryEmbedQueue,
          repository
        }),
        recoverProjectedMemoryEventProcessing: projectionJobScheduler.recover,
        historicalImport: workerEnv.historicalImport,
        intervalMs: workerEnv.rawProjectionIntervalMs,
        logger,
        repository
      })
    : null;
rawProjectionService?.start();

const crossIdentitySyncService =
  repository && envelopeEncryptionProvider
    ? createCrossIdentitySyncService({
        repository,
        rootEncryptionProvider: envelopeEncryptionProvider,
        embeddingWorkflow,
        koedHome: workerEnv.koedHome,
        isSourceIdentityHealthy: () =>
          inspectDeviceIdentityAtKoedHome({
            koedHome: workerEnv.koedHome,
            environment: process.env
          }).remoteOperationsAllowed,
        intervalMs: workerEnv.crossIdentitySyncIntervalMs,
        staleAfterSeconds: workerEnv.crossIdentitySyncStaleAfterSeconds,
        logger
      })
    : null;
crossIdentitySyncService?.start();

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
  await rawProjectionService?.stop();
  crossIdentitySyncService?.stop();
  await Promise.all([
    queueRuntime.close(),
    memoryEmbedQueue.close(),
    lcmCompactQueue.close()
  ]);
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
