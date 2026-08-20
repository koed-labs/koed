import { scheduleCompaction, type Visibility } from "@koed/core";
import type { EmbeddableSourceType, MemorySourceRepository } from "@koed/db";
import {
  embeddingQueueJobId,
  lcmCompactionQueueJobId,
  resolveKoedWorkClass,
  workClassPriority,
  type KoedJobQueue,
  type KoedWorkClass,
  type WorkerQueueName
} from "@koed/shared";
import type { EmbeddingWorkflow } from "./embedding-workflow.js";

export interface EmbeddingQueueJobData {
  sourceType: EmbeddableSourceType;
  sourceId: string;
  workClass?: KoedWorkClass;
}

export interface CompactionQueueJobData {
  userId: string;
  visibility: Visibility;
  workClass?: KoedWorkClass;
  sessionId?: string;
  finalize?: boolean;
}

export interface WorkerJobWorkflowConfig {
  embeddingDispatchKey: string;
  embeddingWorkflow: EmbeddingWorkflow;
  lcmEmbedQueue: KoedJobQueue<EmbeddingQueueJobData>;
  repository: () => MemorySourceRepository;
}

const isEmbeddableSourceType = (value: string): value is EmbeddableSourceType =>
  value === "memory_node" ||
  value === "memory_event" ||
  value === "message" ||
  value === "curated_memory";

const stringValue = (value: unknown, fallback = ""): string =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? String(value)
    : fallback;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const workerJobData = (data: unknown): Record<string, unknown> => {
  if (!isRecord(data)) {
    throw new Error("Worker job data must be an object");
  }
  return data;
};

export const embeddingJobData = (data: unknown): EmbeddingQueueJobData => {
  const record = workerJobData(data);
  const sourceType = stringValue(record.sourceType);
  const sourceId = stringValue(record.sourceId);
  const workClass = resolveKoedWorkClass(record.workClass);
  if (!isEmbeddableSourceType(sourceType)) {
    throw new Error("Embedding job sourceType is invalid");
  }
  if (!sourceId) {
    throw new Error("Embedding job sourceId is required");
  }
  return { sourceType, sourceId, workClass };
};

const visibilityFromJobData = (data: Record<string, unknown>): Visibility => {
  const visibility = stringValue(data.visibility, "personal");
  return visibility === "personal" ? visibility : "personal";
};

const workClassFromJobData = (data: Record<string, unknown>): KoedWorkClass =>
  resolveKoedWorkClass(data.workClass);

const durableJobOptions = (workClass: KoedWorkClass) => ({
  priority: workClassPriority(workClass),
  attempts: 5,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000
});

const reconciliationJobOptions = (workClass: KoedWorkClass) => ({
  ...durableJobOptions(workClass),
  // PostgreSQL remains retry source after queue-level attempts are spent.
  removeOnFail: true
});

export const enqueueSourceEmbedding = (
  queue: KoedJobQueue<EmbeddingQueueJobData>,
  sourceType: EmbeddableSourceType,
  sourceId: string,
  dispatchKey = "current",
  workClass: KoedWorkClass = "normal_embedding_lcm",
  jobId?: string
) =>
  queue.add(
    "embed-source",
    { sourceType, sourceId, workClass },
    {
      ...reconciliationJobOptions(workClass),
      jobId: jobId ?? embeddingQueueJobId(dispatchKey, sourceType, sourceId)
    }
  );

export const enqueueLcmCompaction = (
  lcmCompactQueue: KoedJobQueue<CompactionQueueJobData>,
  requesterContext: { userId: string },
  visibility: Visibility,
  dispatchKey = "projected",
  workClass: KoedWorkClass = "normal_embedding_lcm",
  jobId?: string,
  sessionId?: string,
  finalize = false
) =>
  lcmCompactQueue.add(
    "compact-scope",
    {
      userId: requesterContext.userId,
      visibility,
      workClass,
      ...(sessionId ? { sessionId } : {}),
      ...(finalize ? { finalize: true } : {})
    },
    {
      ...reconciliationJobOptions(workClass),
      jobId:
        jobId ??
        lcmCompactionQueueJobId(
          requesterContext.userId,
          visibility,
          dispatchKey
        )
    }
  );

export const enqueueLcmNodeEmbeddings = async (
  lcmEmbedQueue: KoedJobQueue<EmbeddingQueueJobData>,
  nodeIds: string[],
  dispatchKey: string,
  workClass: KoedWorkClass = "normal_embedding_lcm"
) =>
  Promise.all(
    nodeIds.map((nodeId) =>
      lcmEmbedQueue.add(
        "embed-lcm-node",
        { sourceType: "memory_node", sourceId: nodeId, workClass },
        {
          ...reconciliationJobOptions(workClass),
          jobId: embeddingQueueJobId(dispatchKey, "memory_node", nodeId)
        }
      )
    )
  );

export const createWorkerJobWorkflow = (config: WorkerJobWorkflowConfig) => {
  const runCompactionJob = async (data: unknown) => {
    const record = workerJobData(data);
    const userId = stringValue(record.userId);
    const visibility = visibilityFromJobData(record);
    const workClass = workClassFromJobData(record);
    const sessionId = stringValue(record.sessionId) || undefined;
    const finalize = record.finalize === true;
    const compaction = await scheduleCompaction({
      repository: config.repository(),
      requesterContext: { userId },
      visibility,
      workClass,
      ...(sessionId ? { sessionId } : {}),
      ...(finalize ? { finalize: true } : {})
    });
    const nodeIds = [
      ...compaction.leafNodeIds,
      ...(compaction.rollupNodeId ? [compaction.rollupNodeId] : [])
    ];
    const embeddingJobs = await enqueueLcmNodeEmbeddings(
      config.lcmEmbedQueue,
      nodeIds,
      config.embeddingDispatchKey,
      workClass
    );
    return {
      compaction,
      localSummaryPendingNodeIds: nodeIds,
      embeddingJobIds: embeddingJobs.map((job) => job.id)
    };
  };

  const runEmbeddingJob = async (data: unknown) => {
    const { sourceType, sourceId, workClass } = embeddingJobData(data);
    return config.embeddingWorkflow.embedSource(
      sourceType,
      sourceId,
      workClass
    );
  };

  return async (queueName: WorkerQueueName, data: unknown) => {
    if (queueName === "lcm-compact") {
      return runCompactionJob(data);
    }
    if (queueName === "memory-embed" || queueName === "lcm-embed") {
      return runEmbeddingJob(data);
    }
    return { ok: true };
  };
};
