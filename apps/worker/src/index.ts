import {
  createDbPool,
  createMemorySourceRepository,
  createRetentionLifecycleRepository,
  databaseErrorCode,
  waitForCurrentDbMigrations,
  type MemorySourceRepository
} from "@koed/db";
import { createEmbeddingWorkflow } from "./embedding-workflow.js";
import { loadWorkerEnv, resolveWorkerEnv } from "./env-config.js";
import {
  createEnvelopeEncryptionProviderFromEnvironment,
  createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment,
  embeddingDispatchKey,
  inspectDeviceIdentityAtKoedHome,
  lcmCompactQueueName,
  lcmEmbedQueueName,
  memoryEmbedQueueName,
  workerQueueNames
} from "@koed/shared";
import { MemoryApiClient } from "@koed/mcp-server";
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
import { createRetentionPurgeService } from "./retention-purge-service.js";
import { createCollaborationReplayPruneService } from "./collaboration-replay-prune-service.js";
import { startWorkerBackgroundServices } from "./background-service-gate.js";
import {
  createPdsLocalSyncService,
  getInstalledPdsWorkerSecureRuntime
} from "./personal-device-sync-service.js";
import { createReloadablePdsWorkerRuntimeFromEnvironment } from "./personal-device-sync-runtime.js";
import { createConversationSourceReplicationService } from "./conversation-source-replication-service.js";
import { createManagedConversationRuntimeCoordinator } from "./managed-conversation-runtime-coordinator.js";

loadWorkerEnv();

const workerEnv = resolveWorkerEnv();
const logger = createWorkerLogger({
  nodeEnv: workerEnv.nodeEnv,
  logLevel: workerEnv.logLevel,
  logDestination: workerEnv.logDestination
});

const pool = workerEnv.databaseUrl
  ? createDbPool({
      connectionString: workerEnv.databaseUrl,
      onPoolError: (error) => {
        logger.warn(
          {
            event: {
              name: "database.pool_connection_interrupted",
              category: "database"
            },
            component: "database",
            database: { error_code: databaseErrorCode(error) }
          },
          "database pool connection interrupted"
        );
      }
    })
  : null;
if (pool) {
  await waitForCurrentDbMigrations(pool);
}
const envelopeEncryptionProvider =
  createEnvelopeEncryptionProviderFromEnvironment();
const ownerPrivateReplicaEnvelopeEncryptionProvider =
  createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment();
const repository = pool
  ? createMemorySourceRepository(pool, {
      envelopeEncryptionProvider,
      ownerPrivateReplicaEnvelopeEncryptionProvider
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
        logger,
        repository,
        wakePool: pool ?? undefined
      })
    : null;

const crossIdentitySyncService =
  workerEnv.teamCollaborationEnabled && repository && envelopeEncryptionProvider
    ? createCrossIdentitySyncService({
        repository,
        // Recipient private keys are deployment control-plane data, not owner-private Memory.
        recipientKeyEncryptionProvider: envelopeEncryptionProvider,
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

const retentionPurgeService = pool
  ? createRetentionPurgeService({
      repository: createRetentionLifecycleRepository(pool, {
        authorizeHoldActor: () => Promise.resolve(false)
      }),
      intervalMs: workerEnv.retentionPurgeIntervalMs,
      logger
    })
  : null;

const collaborationReplayPruneService =
  workerEnv.teamCollaborationEnabled && repository
    ? createCollaborationReplayPruneService({
        repository,
        intervalMs: workerEnv.collaborationReplayPruneIntervalMs,
        batchLimit: workerEnv.collaborationReplayPruneBatchLimit,
        logger
      })
    : null;
const conversationSourceReplicationService =
  repository && pool
    ? createConversationSourceReplicationService({
        repository,
        koedHome: workerEnv.koedHome,
        envelopeEncryptionProvider,
        wakePool: pool,
        logger
      })
    : null;
const workerDeviceIdentity = inspectDeviceIdentityAtKoedHome({
  koedHome: workerEnv.koedHome,
  environment: process.env
});
const managedConversationLocalOwnerUserId =
  workerEnv.managedConversationApiUrl && workerEnv.managedConversationApiToken
    ? await new MemoryApiClient({
        apiUrl: workerEnv.managedConversationApiUrl,
        apiToken: workerEnv.managedConversationApiToken,
        requestTimeoutMs: 30_000
      })
        .accessCheck()
        .then((access) => access.user.id)
        .catch(() => null)
    : null;
const managedConversationService =
  repository &&
  pool &&
  envelopeEncryptionProvider &&
  managedConversationLocalOwnerUserId &&
  workerEnv.managedConversationApiUrl &&
  workerEnv.managedConversationApiToken &&
  workerDeviceIdentity.health === "healthy" &&
  workerDeviceIdentity.deviceInstanceId &&
  workerDeviceIdentity.deploymentId
    ? createManagedConversationRuntimeCoordinator({
        localRepository: repository,
        localOwnerUserId: managedConversationLocalOwnerUserId,
        apiUrl: workerEnv.managedConversationApiUrl,
        apiToken: workerEnv.managedConversationApiToken,
        appServerBinary: workerEnv.managedConversationAppServerBinary,
        model: workerEnv.managedConversationModel,
        reasoningEffort: workerEnv.managedConversationReasoningEffort,
        koedHome: workerEnv.koedHome,
        envelopeEncryptionProvider,
        commandWakePool: pool,
        deviceId: workerDeviceIdentity.deviceInstanceId,
        deploymentId: workerDeviceIdentity.deploymentId,
        logger
      })
    : null;
const activeBackgroundServices = startWorkerBackgroundServices({
  teamCollaborationEnabled: workerEnv.teamCollaborationEnabled,
  personal: [
    rawProjectionService,
    conversationSourceReplicationService,
    managedConversationService
  ],
  maintenance: [retentionPurgeService],
  team: [crossIdentitySyncService, collaborationReplayPruneService]
});

const pdsSecureRuntime =
  getInstalledPdsWorkerSecureRuntime() ??
  (repository && envelopeEncryptionProvider
    ? createReloadablePdsWorkerRuntimeFromEnvironment({
        repository,
        envelopeEncryptionProvider
      })
    : null);
const pdsLocalSyncService =
  repository && envelopeEncryptionProvider && pdsSecureRuntime
    ? createPdsLocalSyncService({
        repository,
        secureRuntime: pdsSecureRuntime,
        wakePool: pool!,
        logger
      })
    : null;
pdsLocalSyncService?.start();

let shutdownPromise: Promise<void> | null = null;

const shutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logger.info(
      {
        event: {
          name: "worker.shutting_down",
          category: "lifecycle"
        }
      },
      "worker shutting down"
    );
    await activeBackgroundServices.stop();
    await pdsLocalSyncService?.stop();
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
  })();
  return shutdownPromise;
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
