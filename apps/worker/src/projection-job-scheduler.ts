import type { Visibility } from "@koed/core";
import type { MemorySourceRepository } from "@koed/db";
import {
  workClassPriority,
  type KoedJobQueue,
  type KoedWorkClass
} from "@koed/shared";
import type { EmbeddingQueueJobData } from "./job-workflows.js";

export interface ProjectionCompactionJobData {
  userId: string;
  visibility: Visibility;
  workClass: KoedWorkClass;
}

interface ProjectionJobSchedulerConfig {
  compactionQueue: KoedJobQueue<ProjectionCompactionJobData>;
  embeddingQueue: KoedJobQueue<EmbeddingQueueJobData>;
  repository: MemorySourceRepository;
  logger: {
    warn(bindings: Record<string, unknown>, message: string): void;
  };
}

interface ProjectionScope {
  eventId: string;
  visibility: Visibility;
  workClass: KoedWorkClass;
  includeInEmbedding: boolean;
  includeInLcm: boolean;
  sourceEventTime?: string | null;
}

interface ProjectionDispatchGroup {
  actor: { userId: string };
  scopes: ProjectionScope[];
}

export interface ProjectionJobScheduler {
  enqueue(actor: { userId: string }, scopes: ProjectionScope[]): Promise<void>;
  recover(limit?: number): Promise<number>;
}

const queueOptions = (workClass: KoedWorkClass, jobId: string) => ({
  jobId,
  priority: workClassPriority(workClass),
  attempts: 5,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: 1000,
  // PostgreSQL reconciliation remains the durable retry source after attempts.
  removeOnFail: true
});

const mapWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> => {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      if (item !== undefined) await task(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
};

const compactionGroups = (scopes: ProjectionScope[]) => {
  const groups = new Map<
    string,
    { eventIds: string[]; visibility: Visibility; workClass: KoedWorkClass }
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

const enqueueEmbedding = async (
  config: ProjectionJobSchedulerConfig,
  scope: ProjectionScope
): Promise<void> => {
  await config.embeddingQueue.add(
    "embed-source",
    {
      sourceType: "memory_event",
      sourceId: scope.eventId,
      workClass: scope.workClass
    },
    queueOptions(scope.workClass, `projection-embed-${scope.eventId}`)
  );
};

const enqueueCompactions = async (
  config: ProjectionJobSchedulerConfig,
  actor: { userId: string },
  scopes: ProjectionScope[]
): Promise<void> => {
  await Promise.all(
    compactionGroups(scopes).map(async (group) => {
      const [dispatchScope] =
        await config.repository.listPendingLcmDispatchScopes({
          limit: 1,
          ownerUserId: actor.userId,
          workClass: group.workClass
        });
      if (!dispatchScope || dispatchScope.visibility !== group.visibility) {
        return;
      }
      await config.compactionQueue.add(
        "compact-scope",
        {
          userId: actor.userId,
          visibility: group.visibility,
          workClass: group.workClass
        },
        queueOptions(group.workClass, dispatchScope.jobId)
      );
    })
  );
};

const scheduleScopes = async (
  config: ProjectionJobSchedulerConfig,
  actor: { userId: string },
  scopes: ProjectionScope[]
): Promise<void> => {
  if (scopes.length === 0) return;
  const embeddingScopes = scopes
    .filter((scope) => scope.includeInEmbedding)
    .sort((left, right) => {
      if (
        left.workClass !== "historical_import_backfill" ||
        right.workClass !== "historical_import_backfill"
      ) {
        return 0;
      }
      const rightTime = Date.parse(right.sourceEventTime ?? "");
      const leftTime = Date.parse(left.sourceEventTime ?? "");
      return (
        (Number.isNaN(rightTime) ? 0 : rightTime) -
        (Number.isNaN(leftTime) ? 0 : leftTime)
      );
    });
  await mapWithConcurrency(embeddingScopes, 10, (scope) =>
    enqueueEmbedding(config, scope)
  );
  await enqueueCompactions(config, actor, scopes);
  await config.repository.markConversationProjectionProcessingDispatched(
    scopes.map((scope) => scope.eventId)
  );
};

const pendingDispatchGroups = (
  pending: Awaited<
    ReturnType<
      MemorySourceRepository["listPendingConversationProjectionProcessing"]
    >
  >
): ProjectionDispatchGroup[] => {
  const groups = new Map<string, ProjectionDispatchGroup>();
  for (const record of pending) {
    const key = `${record.userId}:${record.visibility}:${record.workClass}`;
    const group = groups.get(key) ?? {
      actor: { userId: record.userId },
      scopes: []
    };
    group.scopes.push(record);
    groups.set(key, group);
  }
  return [...groups.values()];
};

const recoverGroup = async (
  config: ProjectionJobSchedulerConfig,
  group: ProjectionDispatchGroup
): Promise<number> => {
  try {
    await scheduleScopes(config, group.actor, group.scopes);
    return group.scopes.length;
  } catch (error) {
    config.logger.warn(
      {
        event: {
          name: "worker.projection_processing.recovery_failed",
          category: "job"
        },
        resource: {
          type: "memory_event",
          id: group.scopes[0]?.eventId ?? "unknown"
        },
        err: error
      },
      "projection processing recovery failed"
    );
    return 0;
  }
};

export const createProjectionJobScheduler = (
  config: ProjectionJobSchedulerConfig
): ProjectionJobScheduler => ({
  enqueue(actor, scopes) {
    return scheduleScopes(config, actor, scopes);
  },

  async recover(limit = 25) {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const pending =
      await config.repository.listPendingConversationProjectionProcessing(
        boundedLimit
      );
    let dispatched = 0;
    for (const group of pendingDispatchGroups(pending)) {
      dispatched += await recoverGroup(config, group);
    }
    return dispatched;
  }
});
