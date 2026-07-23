import { Queue } from "bullmq";
import {
  createLocalWorkQueueRepository,
  type DbPool,
  type LocalWorkQueueRepository
} from "@koed/db";
import {
  defaultKoedQueuePriority,
  type KoedJobQueue,
  type KoedQueueBackend
} from "@koed/shared";

export interface MemoryJobQueueFactoryOptions {
  backend: KoedQueueBackend;
  redisUrl?: string;
  pool?: DbPool | null;
  localQueueRepository?: LocalWorkQueueRepository;
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

export const createMemoryJobQueue = <TJobData>(
  name: string,
  options: MemoryJobQueueFactoryOptions
): KoedJobQueue<TJobData> | null => {
  if (options.backend === "local") {
    const repository =
      options.localQueueRepository ??
      (options.pool ? createLocalWorkQueueRepository(options.pool) : null);
    if (!repository) {
      return null;
    }
    return {
      add: async (jobName, data, jobOptions) =>
        repository.enqueue({
          queueName: name,
          jobName,
          data,
          jobKey: jobOptions?.jobId,
          priority: jobOptions?.priority ?? defaultKoedQueuePriority,
          maxAttempts: jobOptions?.attempts,
          backoffMs: jobOptions?.backoff?.delay
        }),
      getJobCounts: (...statuses) => getLocalJobCounts(repository, statuses),
      close: () => Promise.resolve()
    };
  }

  if (!options.redisUrl) {
    return null;
  }

  const queue = new Queue<any, any, string>(name, {
    connection: createBullmqConnection(options.redisUrl)
  });
  return {
    add: async (jobName, data, jobOptions) => {
      const job = await queue.add(jobName, data, {
        ...jobOptions,
        priority: jobOptions?.priority ?? defaultKoedQueuePriority
      });
      return { id: job.id };
    },
    getJobCounts: (...statuses) =>
      queue.getJobCounts(
        ...(statuses as Parameters<typeof queue.getJobCounts>)
      ),
    close: () => queue.close()
  };
};
