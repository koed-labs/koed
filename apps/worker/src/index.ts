import { Queue, Worker } from "bullmq";
import {
  createDbPool,
  createMemorySourceRepository,
  waitForCurrentDbMigrations,
  type MemorySourceRepository
} from "@koed/db";
import { createEmbeddingWorkflow } from "./embedding-workflow.js";
import { loadWorkerEnv, resolveWorkerEnv } from "./env-config.js";
import {
  createWorkerJobWorkflow,
  enqueueLcmNodeEmbeddings,
  workerQueueNames,
  type EmbeddingQueueJobData,
  type WorkerQueueName
} from "./job-workflows.js";
import { createWorkerLogger } from "./logging.js";
import { createRawProjectionService } from "./raw-projection-service.js";

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

const pool = workerEnv.databaseUrl
  ? createDbPool({ connectionString: workerEnv.databaseUrl })
  : null;
if (pool) {
  await waitForCurrentDbMigrations(pool);
}
const repository = pool ? createMemorySourceRepository(pool) : null;
const lcmEmbedQueue = new Queue<EmbeddingQueueJobData>("lcm-embed", {
  connection
});

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

const handleJob = createWorkerJobWorkflow({
  embeddingWorkflow,
  lcmEmbedQueue,
  repository: requireRepository
});

const workers = workerQueueNames.map((queueName: WorkerQueueName) => {
  const worker = new Worker<unknown>(
    queueName,
    async (job) => {
      try {
        return await handleJob(queueName, job.data);
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
