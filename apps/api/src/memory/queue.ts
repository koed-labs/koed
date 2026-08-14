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

const getBullmqJobCounts = async (
  queue: Queue,
  statuses: string[]
): Promise<Record<string, number>> => {
  const requested = statuses.includes("waiting")
    ? [...new Set([...statuses, "prioritized"])]
    : statuses;
  const counts = await queue.getJobCounts(
    ...(requested as Parameters<typeof queue.getJobCounts>)
  );
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      status === "waiting"
        ? (counts.waiting ?? 0) + (counts.prioritized ?? 0)
        : (counts[status] ?? 0)
    ])
  );
};

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
      getOldestPendingAgeMs: () => repository.getOldestPendingAgeMs(name),
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
    getJobCounts: (...statuses) => getBullmqJobCounts(queue, statuses),
    getOldestPendingAgeMs: async () => {
      const jobs = await queue.getJobs(
        ["wait", "paused", "prioritized", "delayed"],
        0,
        0,
        true
      );
      return jobs[0]?.timestamp
        ? Math.max(0, Date.now() - jobs[0].timestamp)
        : null;
    },
    close: () => queue.close()
  };
};
