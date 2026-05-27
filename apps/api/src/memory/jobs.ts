import { scheduleCompaction, type Visibility } from "@koed/core";
import type { MemorySourceRepository } from "@koed/db";
import type { Queue } from "bullmq";
import { withTimeout } from "../server/utils.js";

export type EmbeddingSourceType = "memory_node" | "memory_event" | "message";

export interface MemoryJobStatus {
  queued: boolean;
  inline: boolean;
  jobId?: string;
  reason?: string;
  compaction?: {
    leafNodeIds: string[];
    rollupNodeId: string | null;
  };
}

interface MemoryJobSchedulerOptions {
  embeddingQueue: Queue | null;
  compactionQueue: Queue | null;
  runMemoryJobsInlineForTests?: boolean;
  log: {
    warn(bindings: Record<string, unknown>, message: string): void;
  };
}

export const createMemoryJobScheduler = ({
  embeddingQueue,
  compactionQueue,
  runMemoryJobsInlineForTests,
  log
}: MemoryJobSchedulerOptions) => {
  const runCompactionInline = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    visibility: Visibility,
    teamId?: string
  ) =>
    scheduleCompaction({
      repository: repo,
      requesterContext,
      visibility,
      teamId
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
          queue: { name: "memory-embed" },
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
            removeOnFail: 5000
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
          queue: { name: "memory-embed" },
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
    teamId?: string
  ): Promise<MemoryJobStatus> => {
    if (runMemoryJobsInlineForTests) {
      const compaction = await runCompactionInline(
        repo,
        requesterContext,
        visibility,
        teamId
      );
      return { queued: false, inline: true, compaction };
    }

    if (!compactionQueue) {
      log.warn(
        {
          event: { name: "job.enqueue.unavailable", category: "queue" },
          component: "memory_jobs",
          queue: { name: "lcm-compact" },
          job: { name: "compact-scope" },
          actor: { user_id: requesterContext.userId },
          resource: { type: "compaction_scope", visibility, team_id: teamId }
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
      const job = await withTimeout(
        compactionQueue.add(
          "compact-scope",
          { userId: requesterContext.userId, visibility, teamId },
          {
            attempts: 5,
            backoff: { type: "exponential", delay: 10_000 },
            removeOnComplete: 1000,
            removeOnFail: 5000
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
          queue: { name: "lcm-compact" },
          job: { name: "compact-scope" },
          actor: { user_id: requesterContext.userId },
          resource: { type: "compaction_scope", visibility, team_id: teamId },
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
    visibility: Visibility,
    teamId?: string
  ) => {
    const [embedding, compaction] = await Promise.all([
      enqueueEmbedding("memory_event", eventId),
      enqueueCompaction(repo, requesterContext, visibility, teamId)
    ]);

    return { embedding, compaction };
  };

  const scheduleProjectedMemoryEventProcessing = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    scopes: Array<{
      eventId: string;
      visibility: Visibility;
      teamId: string | null;
    }>
  ) => {
    const embeddings = await Promise.all(
      scopes.map((scope) => enqueueEmbedding("memory_event", scope.eventId))
    );
    const scopeMap = new Map<
      string,
      { visibility: Visibility; teamId?: string }
    >();
    for (const scope of scopes) {
      scopeMap.set(`${scope.visibility}:${scope.teamId ?? ""}`, {
        visibility: scope.visibility,
        ...(scope.teamId ? { teamId: scope.teamId } : {})
      });
    }
    const compactions = await Promise.all(
      [...scopeMap.values()].map((scope) =>
        enqueueCompaction(
          repo,
          requesterContext,
          scope.visibility,
          scope.teamId
        )
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
