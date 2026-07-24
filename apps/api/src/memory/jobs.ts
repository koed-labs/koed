import { scheduleCompaction, type Visibility } from "@koed/core";
import type { MemorySourceRepository } from "@koed/db";
import {
  embeddingQueueJobId,
  lcmCompactQueueName,
  memoryEmbedQueueName,
  workClassPriority,
  type KoedJobQueue,
  type KoedWorkClass
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
  workClass: KoedWorkClass;
}

interface CompactionQueueJobData {
  userId: string;
  visibility: Visibility;
  workClass: KoedWorkClass;
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
    visibility: Visibility,
    workClass: KoedWorkClass = "normal_embedding_lcm"
  ) =>
    scheduleCompaction({
      repository: repo,
      requesterContext,
      visibility,
      workClass
    });

  const enqueueEmbedding = async (
    sourceType: EmbeddingSourceType,
    sourceId: string,
    workClass: KoedWorkClass = "normal_embedding_lcm",
    jobId?: string
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
          { sourceType, sourceId, workClass },
          {
            priority: workClassPriority(workClass),
            attempts: 5,
            backoff: { type: "exponential", delay: 10_000 },
            removeOnComplete: 1000,
            removeOnFail: true,
            jobId:
              jobId ??
              embeddingQueueJobId(embeddingDispatchKey, sourceType, sourceId)
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
    visibility: Visibility,
    workClass: KoedWorkClass = "normal_embedding_lcm",
    jobId?: string
  ): Promise<MemoryJobStatus> => {
    if (runMemoryJobsInlineForTests) {
      const compaction = await runCompactionInline(
        repo,
        requesterContext,
        visibility,
        workClass
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
        ownerUserId: requesterContext.userId,
        workClass
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
          { userId: requesterContext.userId, visibility, workClass },
          {
            priority: workClassPriority(workClass),
            attempts: 5,
            backoff: { type: "exponential", delay: 10_000 },
            removeOnComplete: 1000,
            removeOnFail: true,
            jobId: jobId ?? dispatchScope.jobId
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
      enqueueEmbedding("memory_event", eventId, "live_capture_projection"),
      enqueueCompaction(
        repo,
        requesterContext,
        visibility,
        "live_capture_projection"
      )
    ]);

    return { embedding, compaction };
  };

  const projectedCompactionScopes = (
    scopes: Array<{
      eventId: string;
      visibility: Visibility;
      includeInLcm: boolean;
      workClass: KoedWorkClass;
    }>
  ) => {
    const groups = new Map<
      string,
      {
        eventIds: string[];
        visibility: Visibility;
        workClass: KoedWorkClass;
      }
    >();
    for (const scope of scopes.filter((scope) => scope.includeInLcm)) {
      const key = `${scope.visibility}:${scope.workClass}`;
      const group = groups.get(key) ?? {
        eventIds: [],
        visibility: scope.visibility,
        workClass: scope.workClass
      };
      group.eventIds.push(scope.eventId);
      groups.set(key, group);
    }
    return [...groups.values()];
  };

  const scheduleProjectedMemoryEventProcessing = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    scopes: Array<{
      eventId: string;
      visibility: Visibility;
      includeInEmbedding: boolean;
      includeInLcm: boolean;
      workClass: KoedWorkClass;
    }>
  ) => {
    const embeddings = await Promise.all(
      scopes
        .filter((scope) => scope.includeInEmbedding)
        .map((scope) =>
          enqueueEmbedding(
            "memory_event",
            scope.eventId,
            scope.workClass,
            `projection-embed-${scope.eventId}`
          )
        )
    );
    const compactions = await Promise.all(
      projectedCompactionScopes(scopes).map((scope) =>
        enqueueCompaction(
          repo,
          requesterContext,
          scope.visibility,
          scope.workClass
        )
      )
    );
    const admitted = [...embeddings, ...compactions].every(
      (job) => job.queued || job.inline
    );
    if (admitted && scopes.length > 0) {
      await repo.markConversationProjectionProcessingDispatched(
        scopes.map((scope) => scope.eventId)
      );
    }
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
