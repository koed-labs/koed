import { Queue, Worker } from "bullmq";
import {
  createLocalWorkQueueRepository,
  type DbPool,
  type LocalWorkQueueJobRecord,
  type LocalWorkQueueRepository
} from "@koed/db";
import {
  workerQueueNames,
  type KoedJobQueue,
  type KoedQueueBackend,
  type WorkerQueueName
} from "@koed/shared";
import type { EmbeddingQueueJobData } from "./job-workflows.js";

interface WorkerQueueLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface WorkerQueueRuntimeOptions {
  backend: KoedQueueBackend;
  redisUrl: string;
  pool?: DbPool | null;
  localQueueRepository?: LocalWorkQueueRepository;
  logger: WorkerQueueLogger;
  lcmEmbedQueue: KoedJobQueue<EmbeddingQueueJobData>;
  handleJob(queueName: WorkerQueueName, data: unknown): Promise<unknown>;
  isTransientError(error: unknown): boolean;
  pollIntervalMs?: number;
  leaseMs?: number;
}

export interface WorkerQueueRuntime {
  lcmEmbedQueue: KoedJobQueue<EmbeddingQueueJobData>;
  workers: Array<{ close(): Promise<void> }>;
  close(): Promise<void>;
}

const createBullmqConnection = (redisUrl: string) => ({
  url: redisUrl,
  maxRetriesPerRequest: null
});

const getLocalJobCounts = async (
  repository: LocalWorkQueueRepository,
  statuses: string[]
): Promise<Record<string, number>> => {
  const localCounts = await repository.getJobCounts([
    "pending",
    "active",
    "delayed",
    "completed",
    "failed"
  ]);
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      status === "waiting"
        ? (localCounts.pending ?? 0)
        : (localCounts[status] ?? 0)
    ])
  );
};

export const createWorkerQueueProducer = <TJobData>(
  name: string,
  options: {
    backend: KoedQueueBackend;
    redisUrl: string;
    pool?: DbPool | null;
    localQueueRepository?: LocalWorkQueueRepository;
  }
): KoedJobQueue<TJobData> => {
  if (options.backend === "local") {
    const repository =
      options.localQueueRepository ??
      (options.pool ? createLocalWorkQueueRepository(options.pool) : null);
    if (!repository) {
      throw new Error("DATABASE_URL is required for local queue backend");
    }
    return {
      add: async (jobName, data, jobOptions) =>
        repository.enqueue({
          queueName: name,
          jobName,
          data,
          jobKey: jobOptions?.jobId,
          maxAttempts: jobOptions?.attempts,
          backoffMs: jobOptions?.backoff?.delay
        }),
      getJobCounts: (...statuses) => getLocalJobCounts(repository, statuses),
      close: () => Promise.resolve()
    };
  }

  const queue = new Queue<any, any, string>(name, {
    connection: createBullmqConnection(options.redisUrl)
  });
  return {
    add: async (jobName, data, jobOptions) => {
      const job = await queue.add(jobName, data, jobOptions);
      return { id: job.id };
    },
    getJobCounts: (...statuses) =>
      queue.getJobCounts(
        ...(statuses as Parameters<typeof queue.getJobCounts>)
      ),
    close: () => queue.close()
  };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const createLocalQueueWorker = ({
  queueName,
  repository,
  logger,
  handleJob,
  isTransientError,
  pollIntervalMs,
  leaseMs
}: {
  queueName: WorkerQueueName;
  repository: LocalWorkQueueRepository;
  logger: WorkerQueueLogger;
  handleJob(queueName: WorkerQueueName, data: unknown): Promise<unknown>;
  isTransientError(error: unknown): boolean;
  pollIntervalMs: number;
  leaseMs: number;
}) => {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;

  const run = () => {
    current = tick();
    void current;
  };

  const schedule = () => {
    if (!stopped) {
      timer = setTimeout(run, pollIntervalMs);
    }
  };

  const processJob = async (job: LocalWorkQueueJobRecord) => {
    try {
      await handleJob(queueName, job.data);
      await repository.complete({ id: job.id, lockToken: job.lockToken });
      logger.info(
        {
          event: { name: "worker.job.completed", category: "job" },
          queue: { name: queueName },
          job: {
            id: String(job.id),
            name: job.jobName,
            attempts_made: job.attemptCount
          }
        },
        "worker job completed"
      );
    } catch (error) {
      const retry =
        isTransientError(error) && job.attemptCount < job.maxAttempts;
      await repository.fail({
        id: job.id,
        lockToken: job.lockToken,
        errorMessage: errorMessage(error),
        retry
      });
      logger[retry ? "warn" : "error"](
        {
          event: {
            name: retry ? "worker.job.transient_failure" : "worker.job.failed",
            category: "job"
          },
          queue: { name: queueName },
          job: {
            id: String(job.id),
            name: job.jobName,
            attempts_made: job.attemptCount
          },
          err: error
        },
        retry
          ? "worker job transient failure; local queue will retry"
          : "worker job failed"
      );
    }
  };

  const tick = async () => {
    try {
      const job = await repository.claim({ queueName, leaseMs });
      if (job) {
        await processJob(job);
      }
    } catch (error) {
      logger.error(
        {
          event: { name: "worker.queue.error", category: "queue" },
          queue: { name: queueName },
          err: error
        },
        "worker queue error"
      );
    } finally {
      schedule();
    }
  };

  run();

  return {
    close: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      await current;
    }
  };
};

export const createWorkerQueueRuntime = ({
  backend,
  redisUrl,
  pool,
  localQueueRepository,
  logger,
  lcmEmbedQueue,
  handleJob,
  isTransientError,
  pollIntervalMs = 1_000,
  leaseMs = 10 * 60 * 1000
}: WorkerQueueRuntimeOptions): WorkerQueueRuntime => {
  if (backend === "local") {
    const repository =
      localQueueRepository ??
      (pool ? createLocalWorkQueueRepository(pool) : null);
    if (!repository) {
      throw new Error("DATABASE_URL is required for local queue backend");
    }
    const workers = workerQueueNames.map((queueName) =>
      createLocalQueueWorker({
        queueName,
        repository,
        logger,
        handleJob,
        isTransientError,
        pollIntervalMs,
        leaseMs
      })
    );
    return {
      lcmEmbedQueue,
      workers,
      close: async () => {
        await Promise.all(workers.map((worker) => worker.close()));
        await lcmEmbedQueue.close();
      }
    };
  }

  const connection = createBullmqConnection(redisUrl);

  const workers = workerQueueNames.map((queueName) => {
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

  return {
    lcmEmbedQueue,
    workers,
    close: async () => {
      await Promise.all(workers.map((worker) => worker.close()));
      await lcmEmbedQueue.close();
    }
  };
};
