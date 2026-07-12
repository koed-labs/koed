import type { Visibility } from "@koed/core";
import type { EmbeddableSourceType, MemorySourceRepository } from "@koed/db";
import { lcmCompactQueueName, memoryEmbedQueueName } from "@koed/shared";
import type { Logger } from "pino";

export interface RawProjectionServiceConfig {
  actorLimit: number;
  batchLimit: number;
  enqueueLcmCompaction(
    requesterContext: { userId: string },
    visibility: Visibility,
    dispatchKey: string
  ): Promise<unknown>;
  embeddingDispatchKey: string;
  enqueueSourceEmbedding(
    sourceType: EmbeddableSourceType,
    sourceId: string,
    dispatchKey: string
  ): Promise<unknown>;
  intervalMs: number;
  logger: Logger;
  repository: MemorySourceRepository;
}

export interface RawProjectionService {
  run(): Promise<void>;
  start(): void;
  stop(): void;
}

export const createRawProjectionService = (
  config: RawProjectionServiceConfig
): RawProjectionService => {
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const reconcileLcmCompactionJobs = async () => {
    const scopes = await config.repository.listPendingLcmDispatchScopes({
      limit: config.actorLimit
    });
    const results = await Promise.allSettled(
      scopes.map((scope) =>
        config.enqueueLcmCompaction(
          { userId: scope.ownerUserId },
          scope.visibility,
          scope.dispatchKey
        )
      )
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        continue;
      }
      const scope = scopes[index];
      config.logger.warn(
        {
          event: {
            name: "worker.lcm_reconciliation.job_enqueue.failed",
            category: "queue"
          },
          queue: { name: lcmCompactQueueName },
          job: { name: "compact-scope" },
          actor: { user_id: scope?.ownerUserId },
          resource: {
            type: "compaction_scope",
            visibility: scope?.visibility,
            pendingMemoryEventIds: scope?.pendingMemoryEventIds
          },
          err: result.reason
        },
        "could not enqueue pending LCM compaction scope"
      );
    }
  };

  const reconcileEmbeddingJobs = async () => {
    const sources = await config.repository.listSourcesNeedingEmbeddings(
      config.batchLimit
    );
    const results = await Promise.allSettled(
      sources.map((source) =>
        config.enqueueSourceEmbedding(
          source.sourceType,
          source.sourceId,
          config.embeddingDispatchKey
        )
      )
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        continue;
      }
      const source = sources[index];
      config.logger.warn(
        {
          event: {
            name: "worker.embedding_reconciliation.job_enqueue.failed",
            category: "queue"
          },
          queue: { name: memoryEmbedQueueName },
          job: { name: "embed-source" },
          resource: {
            type: source?.sourceType,
            id: source?.sourceId
          },
          err: result.reason
        },
        "could not enqueue pending embedding source"
      );
    }
  };

  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const actors = await config.repository.listConversationProjectionActors({
        limit: config.actorLimit
      });
      let scanned = 0;
      let projected = 0;
      let waitingForAgentSeal = 0;
      let noProgressActors = 0;
      for (const actor of actors) {
        const result = await config.repository.projectPendingConversationItems(
          actor,
          {
            limit: config.batchLimit
          }
        );
        scanned += result.rawItemsScanned;
        projected += result.rawItemsProjected;
        waitingForAgentSeal += result.rawItemsWaitingForAgentSeal;
        if (result.rawItemsScanned > 0 && result.rawItemsProjected === 0) {
          noProgressActors += 1;
        }
      }
      const rebuildActors =
        await config.repository.listSemanticMemoryRebuildActors({
          limit: config.actorLimit
        });
      let rebuildJobs = 0;
      let rebuiltEvents = 0;
      for (const actor of rebuildActors) {
        const result = await config.repository.processDueSemanticMemoryRebuilds(
          actor,
          {
            limit: config.batchLimit
          }
        );
        rebuildJobs += result.jobsCompleted;
        rebuiltEvents += result.memoryEventsCreated;
      }
      await reconcileEmbeddingJobs();
      await reconcileLcmCompactionJobs();
      if (scanned > 0) {
        config.logger.info(
          {
            event: {
              name: "worker.raw_projection.catchup.completed",
              category: "projection"
            },
            projection: {
              actors: actors.length,
              scanned,
              projected,
              waitingForAgentSeal,
              noProgressActors
            }
          },
          "raw conversation projection catch-up completed"
        );
      }
      if (rebuildJobs > 0) {
        config.logger.info(
          {
            event: {
              name: "worker.raw_projection.semantic_rebuild.completed",
              category: "projection"
            },
            projection: {
              actors: rebuildActors.length,
              rebuildJobs,
              rebuiltEvents
            }
          },
          "semantic memory rebuild completed"
        );
      }
    } catch (error) {
      config.logger.warn(
        {
          event: {
            name: "worker.raw_projection.catchup.failed",
            category: "projection"
          },
          err: error
        },
        "raw conversation projection catch-up failed"
      );
    } finally {
      running = false;
    }
  };

  return {
    run,
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(() => void run(), config.intervalMs);
      void run();
    },
    stop() {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = null;
    }
  };
};
