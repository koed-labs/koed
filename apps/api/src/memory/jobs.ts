import { scheduleCompaction, type Visibility } from "@koed/core";
import type { MemorySourceRepository } from "@koed/db";
import {
  embeddingQueueJobId,
  lcmCompactionQueueJobId,
  lcmCompactQueueName,
  memoryEmbedQueueName,
  type KoedJobQueue
} from "@koed/shared";
import { withTimeout } from "../server/utils.js";

export type EmbeddingSourceType = "memory_node" | "memory_event" | "message";

export interface MemoryJobStatus {
  queued: boolean;
  inline: boolean;
  jobId?: string | number;
  reason?: string;
  compaction?: {
    leafNodeIds: string[];
    rollupNodeId: string | null;
  };
}

interface EmbeddingQueueJobData {
  sourceType: EmbeddingSourceType;
  sourceId: string;
}

interface CompactionQueueJobData {
  userId: string;
  visibility: Visibility;
}

interface MemoryJobSchedulerOptions {
  embeddingQueue: KoedJobQueue<EmbeddingQueueJobData> | null;
  compactionQueue: KoedJobQueue<CompactionQueueJobData> | null;
  embeddingDispatchKey: string;
  runMemoryJobsInlineForTests?: boolean;
  log: {
    warn(bindings: Record<string, unknown>, message: string): void;
  };
}

export const createMemoryJobScheduler = ({
  embeddingQueue,
  compactionQueue,
  embeddingDispatchKey,
  runMemoryJobsInlineForTests,
  log
}: MemoryJobSchedulerOptions) => {
  const runCompactionInline = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    visibility: Visibility
  ) =>
    scheduleCompaction({
      repository: repo,
      requesterContext,
      visibility
    });

  const enqueueEmbedding = async (
    sourceType: EmbeddingSourceType,
    sourceId: string
  ): Promise<MemoryJobStatus> => {
    if (!embeddingQueue) {
      log.warn(
        {
          event: { name: "job.enqueue.unavailable", category: "queue" },
          component: "memory_jobs",
          queue: { name: memoryEmbedQueueName },
          job: { name: "embed-source" },
          resource: { type: sourceType, id: sourceId }
        },
        "embedding queue is unavailable"
      );
      return {
        queued: false,
        inline: false,
        reason: "embedding queue is unavailable"
      };
    }

    try {
      const job = await withTimeout(
        embeddingQueue.add(
          "embed-source",
          { sourceType, sourceId },
          {
            attempts: 5,
            backoff: { type: "exponential", delay: 10_000 },
            removeOnComplete: 1000,
            removeOnFail: true,
            jobId: embeddingQueueJobId(
              embeddingDispatchKey,
              sourceType,
              sourceId
            )
          }
        ),
        750,
        "embedding enqueue timed out"
      );
      return { queued: true, inline: false, jobId: job.id };
    } catch (error) {
      log.warn(
        {
          event: { name: "job.enqueue.failed", category: "queue" },
          component: "memory_jobs",
          queue: { name: memoryEmbedQueueName },
          job: { name: "embed-source" },
          resource: { type: sourceType, id: sourceId },
          err: error
        },
        "could not enqueue embedding job"
      );
      return { queued: false, inline: false, reason: String(error) };
    }
  };

  const enqueueCompaction = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    visibility: Visibility
  ): Promise<MemoryJobStatus> => {
    if (runMemoryJobsInlineForTests) {
      const compaction = await runCompactionInline(
        repo,
        requesterContext,
        visibility
      );
      return { queued: false, inline: true, compaction };
    }

    if (!compactionQueue) {
      log.warn(
        {
          event: { name: "job.enqueue.unavailable", category: "queue" },
          component: "memory_jobs",
          queue: { name: lcmCompactQueueName },
          job: { name: "compact-scope" },
          actor: { user_id: requesterContext.userId },
          resource: { type: "compaction_scope", visibility }
        },
        "compaction queue is unavailable"
      );
      return {
        queued: false,
        inline: false,
        reason: "compaction queue is unavailable"
      };
    }

    try {
      const [dispatchScope] = await repo.listPendingLcmDispatchScopes({
        limit: 1,
        ownerUserId: requesterContext.userId
      });
      if (!dispatchScope || dispatchScope.visibility !== visibility) {
        return {
          queued: false,
          inline: false,
          reason: "no eligible LCM sources are pending"
        };
      }
      const job = await withTimeout(
        compactionQueue.add(
          "compact-scope",
          { userId: requesterContext.userId, visibility },
          {
            attempts: 5,
            backoff: { type: "exponential", delay: 10_000 },
            removeOnComplete: 1000,
            removeOnFail: true,
            jobId: lcmCompactionQueueJobId(
              requesterContext.userId,
              visibility,
              dispatchScope.dispatchKey
            )
          }
        ),
        750,
        "compaction enqueue timed out"
      );
      return { queued: true, inline: false, jobId: job.id };
    } catch (error) {
      log.warn(
        {
          event: { name: "job.enqueue.failed", category: "queue" },
          component: "memory_jobs",
          queue: { name: lcmCompactQueueName },
          job: { name: "compact-scope" },
          actor: { user_id: requesterContext.userId },
          resource: { type: "compaction_scope", visibility },
          err: error
        },
        "could not enqueue compaction job"
      );
      return { queued: false, inline: false, reason: String(error) };
    }
  };

  const scheduleMemoryEventProcessing = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    eventId: string,
    visibility: Visibility
  ) => {
    const [embedding, compaction] = await Promise.all([
      enqueueEmbedding("memory_event", eventId),
      enqueueCompaction(repo, requesterContext, visibility)
    ]);

    return { embedding, compaction };
  };

  const scheduleProjectedMemoryEventProcessing = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    scopes: Array<{
      eventId: string;
      visibility: Visibility;
      includeInEmbedding: boolean;
      includeInLcm: boolean;
    }>
  ) => {
    const embeddings = await Promise.all(
      scopes
        .filter((scope) => scope.includeInEmbedding)
        .map((scope) => enqueueEmbedding("memory_event", scope.eventId))
    );
    const scopeMap = new Map<string, { visibility: Visibility }>();
    for (const scope of scopes) {
      if (scope.includeInLcm) {
        scopeMap.set(scope.visibility, { visibility: scope.visibility });
      }
    }
    const compactions = await Promise.all(
      [...scopeMap.values()].map((scope) =>
        enqueueCompaction(repo, requesterContext, scope.visibility)
      )
    );

    return { embeddings, compactions };
  };

  return {
    runCompactionInline,
    enqueueEmbedding,
    enqueueCompaction,
    scheduleMemoryEventProcessing,
    scheduleProjectedMemoryEventProcessing
  };
};
