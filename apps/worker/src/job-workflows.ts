import { scheduleCompaction, type Visibility } from "@koed/core";
import type { EmbeddableSourceType, MemorySourceRepository } from "@koed/db";
import { type KoedJobQueue, type WorkerQueueName } from "@koed/shared";
import type { EmbeddingWorkflow } from "./embedding-workflow.js";

export interface EmbeddingQueueJobData {
  sourceType: EmbeddableSourceType;
  sourceId: string;
}

export interface WorkerJobWorkflowConfig {
  embeddingWorkflow: EmbeddingWorkflow;
  lcmEmbedQueue: KoedJobQueue<EmbeddingQueueJobData>;
  repository: () => MemorySourceRepository;
}

const isEmbeddableSourceType = (value: string): value is EmbeddableSourceType =>
  value === "memory_node" || value === "memory_event" || value === "message";

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
  if (!isEmbeddableSourceType(sourceType)) {
    throw new Error("Embedding job sourceType is invalid");
  }
  if (!sourceId) {
    throw new Error("Embedding job sourceId is required");
  }
  return {
    sourceType,
    sourceId
  };
};

const visibilityFromJobData = (data: Record<string, unknown>): Visibility => {
  const visibility = stringValue(data.visibility, "personal");
  return visibility === "personal" ? visibility : "personal";
};

export const enqueueLcmNodeEmbeddings = async (
  lcmEmbedQueue: KoedJobQueue<EmbeddingQueueJobData>,
  nodeIds: string[]
) =>
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

export const createWorkerJobWorkflow = (config: WorkerJobWorkflowConfig) => {
  const runCompactionJob = async (data: unknown) => {
    const record = workerJobData(data);
    const userId = stringValue(record.userId);
    const visibility = visibilityFromJobData(record);
    const compaction = await scheduleCompaction({
      repository: config.repository(),
      requesterContext: { userId },
      visibility
    });
    const nodeIds = [
      ...compaction.leafNodeIds,
      ...(compaction.rollupNodeId ? [compaction.rollupNodeId] : [])
    ];
    const embeddingJobs = await enqueueLcmNodeEmbeddings(
      config.lcmEmbedQueue,
      nodeIds
    );
    return {
      compaction,
      localSummaryPendingNodeIds: nodeIds,
      embeddingJobIds: embeddingJobs.map((job) => job.id)
    };
  };

  const runEmbeddingJob = async (data: unknown) => {
    const { sourceType, sourceId } = embeddingJobData(data);
    return config.embeddingWorkflow.embedSource(sourceType, sourceId);
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
